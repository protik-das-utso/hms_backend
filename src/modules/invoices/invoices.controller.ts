import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { streamInvoicePdf } from "../../utils/pdf";

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.InvoiceWhereInput = {
    tenantId,
    ...(status ? { status: status as Prisma.InvoiceWhereInput["status"] } : {}),
    ...(q
      ? {
          OR: [
            { invoiceNumber: { contains: q, mode: "insensitive" } },
            { patient: { name: { contains: q, mode: "insensitive" } } },
            { patient: { phone: { contains: q } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        patient: { select: { id: true, name: true, patientCode: true, phone: true } },
        branch: { select: { name: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const inv = await prisma.invoice.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: true,
      branch: true,
      lines: { orderBy: { createdAt: "asc" } },
      orders: {
        include: {
          items: {
            include: {
              test: { select: { nameEn: true, code: true } },
              report: {
                select: { id: true, status: true, isAbnormal: true, submittedAt: true, approvedAt: true },
              },
            },
          },
        },
      },
      payments: {
        orderBy: { paidAt: "desc" },
        include: { collectedBy: { select: { name: true } } },
      },
    },
  });
  if (!inv) throw ApiError.notFound("Invoice not found");

  // Patient self-access
  if (req.auth!.role === "PATIENT" && inv.patientId !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  ok(res, inv);
};

export const recordPayment = async (req: Request, res: Response) => {
  const body = req.body as { amount: number; method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER"; referenceNo?: string; notes?: string };
  const amount = new Prisma.Decimal(body.amount);

  // Concurrency-safe: re-read the invoice INSIDE the transaction with the
  // serializable isolation level so two concurrent payments cannot both see
  // the same dueAmount, both pass the cap check, and overpay. The retry
  // loop handles the rare serialization failure that Postgres throws when
  // two transactions actually conflict.
  let attempts = 0;
  while (true) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const inv = await tx.invoice.findFirst({
            where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
          });
          if (!inv) throw ApiError.notFound("Invoice not found");
          if (inv.status === "PAID" || inv.status === "REFUNDED" || inv.status === "CANCELLED") {
            throw ApiError.badRequest("Invoice cannot accept further payments");
          }
          if (amount.gt(inv.dueAmount)) {
            throw ApiError.badRequest("Payment exceeds amount due");
          }

          const payment = await tx.payment.create({
            data: {
              tenantId: inv.tenantId,
              invoiceId: inv.id,
              amount,
              method: body.method,
              referenceNo: body.referenceNo ?? null,
              notes: body.notes ?? null,
              collectedById: req.auth!.sub,
            },
          });
          const newPaid = inv.paidAmount.plus(amount);
          const newDue = inv.totalAmount.minus(newPaid);
          const updated = await tx.invoice.update({
            where: { id: inv.id },
            data: {
              paidAmount: newPaid,
              dueAmount: newDue,
              status: newDue.lte(0) ? "PAID" : "PARTIALLY_PAID",
            },
          });
          return { payment, invoice: updated };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      created(res, result, "Payment recorded");
      return;
    } catch (err) {
      // Postgres serialization failure (40001) — retry up to 5 times with backoff.
      const code = (err as { code?: string }).code;
      if (code === "P2034" || code === "40001") {
        if (++attempts >= 5) throw err;
        await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 30)));
        continue;
      }
      throw err;
    }
  }
};

export const refund = async (req: Request, res: Response) => {
  const body = req.body as { amount: number; reason?: string };
  const amount = new Prisma.Decimal(body.amount);

  let attempts = 0;
  while (true) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const inv = await tx.invoice.findFirst({
            where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
            include: { payments: { orderBy: { paidAt: "desc" }, take: 1 } },
          });
          if (!inv) throw ApiError.notFound("Invoice not found");
          if (inv.status === "CANCELLED") {
            throw ApiError.badRequest("Cancelled invoices cannot be refunded");
          }
          if (amount.gt(inv.paidAmount)) {
            throw ApiError.badRequest("Refund exceeds paid amount");
          }

          const lastMethod = inv.payments[0]?.method ?? "CASH";

          const payment = await tx.payment.create({
            data: {
              tenantId: inv.tenantId,
              invoiceId: inv.id,
              amount: amount.negated(),
              method: lastMethod,
              referenceNo: null,
              notes: `Refund: ${body.reason ?? ""}`.trim(),
              collectedById: req.auth!.sub,
            },
          });
          const newPaid = inv.paidAmount.minus(amount);
          const newDue = inv.totalAmount.minus(newPaid);
          // Status logic — REFUNDED only when fully refunded (newPaid <= 0
          // AND something was actually paid before). Otherwise reflect new
          // balance: PARTIALLY_PAID if some still paid, ISSUED if zero.
          const nextStatus =
            newPaid.lte(0)
              ? inv.totalAmount.gt(0) ? "REFUNDED" : "ISSUED"
              : "PARTIALLY_PAID";
          const updated = await tx.invoice.update({
            where: { id: inv.id },
            data: {
              paidAmount: newPaid,
              dueAmount: newDue,
              status: nextStatus,
            },
          });
          return { payment, invoice: updated };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      ok(res, result, "Refund recorded");
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "P2034" || code === "40001") {
        if (++attempts >= 5) throw err;
        await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 30)));
        continue;
      }
      throw err;
    }
  }
};

export const downloadPdf = async (req: Request, res: Response) => {
  const inv = await prisma.invoice.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: true,
      branch: true,
      tenant: true,
      lines: { orderBy: { createdAt: "asc" } },
      orders: {
        include: {
          orderedBy: { select: { name: true } },
          items: { include: { test: { select: { nameEn: true, code: true } } } },
        },
      },
      payments: {
        orderBy: { paidAt: "desc" },
        include: { collectedBy: { select: { name: true } } },
      },
    },
  });
  if (!inv) throw ApiError.notFound("Invoice not found");

  if (req.auth!.role === "PATIENT" && inv.patientId !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  const lines = inv.lines.length
    ? inv.lines.map((l) => ({
        particulars: l.description,
        rate: Number(l.unitPrice),
        qty: Number(l.qty),
        discount: Number(l.discount),
        net: Number(l.amount),
      }))
    : inv.orders.flatMap((o) =>
        o.items.map((it) => ({
          particulars: it.test.nameEn,
          rate: Number(it.price),
          qty: 1,
          discount: 0,
          net: Number(it.price),
        }))
      );

  const age = inv.patient.dob
    ? `${dayjs().diff(inv.patient.dob, "year")} y`
    : undefined;

  const referredBy = inv.orders[0]?.orderedBy?.name;
  const preparedBy = inv.payments[0]?.collectedBy?.name;
  const methodSummary = inv.payments
    .filter((p) => Number(p.amount) > 0)
    .map((p) => `${p.method} ${Number(p.amount).toFixed(2)}`)
    .join(", ");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="invoice-${inv.invoiceNumber}.pdf"`
  );

  await streamInvoicePdf(
    {
      tenantName: inv.tenant.name,
      tenantAddress: inv.tenant.address,
      tenantPhone: inv.tenant.contactPhone,
      tenantEmail: inv.tenant.contactEmail,
      branchName: inv.branch?.name,
      invoiceNumber: inv.invoiceNumber,
      issuedAt: inv.createdAt,
      copyLabel: (req.query.copy as string)?.toUpperCase() === "OFFICE"
        ? "OFFICE COPY"
        : "CUSTOMER COPY",
      patientName: inv.patient.name,
      patientCode: inv.patient.patientCode,
      patientAge: age,
      patientGender: inv.patient.gender,
      patientPhone: inv.patient.phone,
      patientAddress: inv.patient.address,
      referredBy,
      payerName: "Cash",
      lines,
      subtotal: Number(inv.subtotal),
      discountTotal: Number(inv.discountAmount ?? 0),
      vatAmount: Number(inv.vatAmount ?? 0),
      totalAmount: Number(inv.totalAmount),
      paidAmount: Number(inv.paidAmount),
      dueAmount: Number(inv.dueAmount),
      narration: Number(inv.dueAmount) > 0 ? `Due Amount: ${Number(inv.dueAmount).toFixed(2)}/=` : null,
      preparedBy,
      paymentMethodSummary: methodSummary || null,
    },
    res
  );
};

