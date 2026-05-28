import { Prisma, PrismaClient } from "@prisma/client";
import { invoiceNumber } from "./codes";
import { prisma as defaultPrisma } from "../config/db";
import { withSequenceRetry } from "./sequenceRetry";

export interface InvoiceLineInput {
  lineType: "TEST" | "MEDICINE" | "BED" | "CONSULTATION" | "PROCEDURE" | "CONSUMABLE" | "OTHER";
  description: string;
  qty?: number;
  // Accept number, decimal-string, or Decimal so callers don't have to round-trip
  // through Number() (which silently drops precision past 15 significant digits).
  unitPrice: number | string | Prisma.Decimal;
  discount?: number | string | Prisma.Decimal;
  taxRate?: number;
  refTable?: string;
  refId?: string;
}

export interface InvoicePaymentInput {
  amount: number | string | Prisma.Decimal;
  method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
  referenceNo?: string;
  notes?: string;
}

export interface CreateInvoiceInput {
  tenantId: string;
  branchId: string;
  patientId: string;
  kind: "DIAGNOSTIC" | "PHARMACY" | "IPD" | "CONSULTATION" | "MIXED";
  lines: InvoiceLineInput[];
  discountAmount?: number | string | Prisma.Decimal;
  discountReason?: string;
  vatPercent?: number;
  notes?: string;
  initialPayment?: InvoicePaymentInput;
  collectedById?: string;
}

type Tx = Prisma.TransactionClient | PrismaClient;

const D = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

const computeLineAmount = (l: InvoiceLineInput) => {
  const qty = D(l.qty ?? 1);
  const gross = qty.times(D(l.unitPrice));
  const afterDiscount = gross.minus(D(l.discount ?? 0));
  const tax = afterDiscount.times(D(l.taxRate ?? 0)).dividedBy(100);
  return afterDiscount.plus(tax);
};

/**
 * Single chokepoint for invoice creation across all modules
 * (diagnostic orders, pharmacy sales, IPD discharge, OPD consultation).
 *
 * Computes subtotal/tax/total atomically from line inputs, writes Invoice +
 * InvoiceLine[] in one transaction, and optionally records an initial payment.
 *
 * Pass an existing Prisma transaction client via `tx` to nest inside a caller's
 * transaction (used by orders/pharmacy/ipd so a single failure rolls everything back).
 */
export const createInvoice = async (input: CreateInvoiceInput, tx?: Tx) => {
  const client: Tx = tx ?? defaultPrisma;

  if (!input.lines.length) {
    throw new Error("createInvoice: lines must contain at least one entry");
  }

  const lineRows = input.lines.map((l) => ({
    ...l,
    qty: D(l.qty ?? 1),
    unitPrice: D(l.unitPrice),
    discount: D(l.discount ?? 0),
    taxRate: D(l.taxRate ?? 0),
    amount: computeLineAmount(l),
  }));

  const subtotal = lineRows.reduce((s, l) => s.plus(l.amount), D(0));
  const discountAmount = D(input.discountAmount ?? 0);
  const vatPercent = D(input.vatPercent ?? 0);
  const taxableBase = subtotal.minus(discountAmount);
  const vatAmount = taxableBase.times(vatPercent).dividedBy(100);
  const totalAmount = taxableBase.plus(vatAmount);

  // Today-relative invoice number sequence — same convention as the
  // existing orders.controller used pre-refactor.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const initialPaid = D(input.initialPayment?.amount ?? 0);
  if (initialPaid.gt(totalAmount)) {
    throw new Error("createInvoice: initial payment exceeds total");
  }

  // Race-safe creation: count → assign → create. On unique-violation
  // (concurrent invoice with the same per-tenant-per-day sequence), retry
  // with a fresh count. The (tenantId, invoiceNumber) unique index in the
  // schema is the durable guarantee.
  const invoice = await withSequenceRetry(async () => {
    const seq = await client.invoice.count({
      where: { tenantId: input.tenantId, createdAt: { gte: todayStart } },
    });

    return client.invoice.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        patientId: input.patientId,
        invoiceNumber: invoiceNumber(seq + 1),
        kind: input.kind,
        subtotal,
        discountAmount,
        discountReason: input.discountReason ?? null,
        vatPercent,
        vatAmount,
        totalAmount,
        paidAmount: initialPaid,
        dueAmount: totalAmount.minus(initialPaid),
        status: initialPaid.gte(totalAmount)
          ? "PAID"
          : initialPaid.gt(0)
            ? "PARTIALLY_PAID"
            : "ISSUED",
        notes: input.notes ?? null,
        lines: {
          create: lineRows.map((l) => ({
            lineType: l.lineType,
            refTable: l.refTable ?? null,
            refId: l.refId ?? null,
            description: l.description,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discount: l.discount,
            taxRate: l.taxRate,
            amount: l.amount,
          })),
        },
      },
      include: { lines: true },
    });
  }, "invoiceNumber");

  if (input.initialPayment && initialPaid.gt(0)) {
    if (!input.collectedById) {
      throw new Error("createInvoice: collectedById is required when initialPayment is set");
    }
    await client.payment.create({
      data: {
        tenantId: input.tenantId,
        invoiceId: invoice.id,
        amount: initialPaid,
        method: input.initialPayment.method,
        referenceNo: input.initialPayment.referenceNo ?? null,
        notes: input.initialPayment.notes ?? null,
        collectedById: input.collectedById,
      },
    });
  }

  return invoice;
};
