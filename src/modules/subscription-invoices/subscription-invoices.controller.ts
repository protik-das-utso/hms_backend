import { Request, Response } from "express";
import { Prisma, PaymentMethod, SubscriptionInvoiceStatus, BillingCycle } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { isPlatformAdmin } from "../../utils/platformAccess";

const D = (n: number | string) => new Prisma.Decimal(n);

const nextInvoiceNumber = async (tenantId: string): Promise<string> => {
  const prefix = `SUB-${dayjs().format("YYMM")}-`;
  const last = await prisma.subscriptionInvoice.findFirst({
    where: { tenantId, invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true },
  });
  const seq = last ? Number(last.invoiceNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

/**
 * Lists subscription invoices.
 * - Tenant user (non-platform-admin): only their own tenant.
 * - Platform admin: can pass ?tenantId= to filter, or omit to see all.
 */
export const list = async (req: Request, res: Response) => {
  const platformAdmin = await isPlatformAdmin(req);
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const tenantId = platformAdmin
    ? (req.query.tenantId as string | undefined)
    : req.auth!.tenantId;

  const where: Prisma.SubscriptionInvoiceWhereInput = {
    ...(tenantId ? { tenantId } : {}),
    ...(status ? { status: status as SubscriptionInvoiceStatus } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.subscriptionInvoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: platformAdmin
        ? { tenant: { select: { id: true, name: true, slug: true } } }
        : undefined,
    }),
    prisma.subscriptionInvoice.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const platformAdmin = await isPlatformAdmin(req);
  const inv = await prisma.subscriptionInvoice.findUnique({
    where: { id: String(req.params.id) },
    include: {
      tenant: { select: { id: true, name: true, slug: true } },
      lines: true,
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
  if (!inv) throw ApiError.notFound("Invoice not found");
  if (!platformAdmin && inv.tenantId !== req.auth!.tenantId) {
    throw ApiError.forbidden("Not your invoice");
  }
  ok(res, inv);
};

/**
 * Generate a subscription invoice for a tenant for a given period.
 * Platform-admin only. Used both manually (UI button) and by the monthly cron.
 */
export const generate = async (req: Request, res: Response) => {
  const body = req.body as Record<string, any>;
  const tenantId = String(body.tenantId);
  if (!tenantId) throw ApiError.badRequest("tenantId is required");

  const periodFrom = dayjs(body.periodFrom).startOf("day");
  const periodTo = dayjs(body.periodTo ?? periodFrom.endOf("month")).endOf("day");
  if (!periodFrom.isValid() || !periodTo.isValid()) throw ApiError.badRequest("Invalid period");
  if (periodFrom.isAfter(periodTo)) throw ApiError.badRequest("periodFrom must be on or before periodTo");

  const [tenant, sub] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, isPlatform: true, name: true } }),
    prisma.subscription.findUnique({ where: { tenantId }, include: { planConfig: true } }),
  ]);
  if (!tenant) throw ApiError.notFound("Tenant not found");
  if (tenant.isPlatform) throw ApiError.badRequest("Cannot invoice the platform tenant");
  if (!sub) throw ApiError.badRequest("Tenant has no subscription configured");

  const plan = sub.planConfig;
  if (!plan) throw ApiError.badRequest("Tenant subscription is not linked to a plan");

  // Idempotency: skip if an invoice already exists covering the same period.
  const dupe = await prisma.subscriptionInvoice.findFirst({
    where: { tenantId, periodFrom: periodFrom.toDate(), periodTo: periodTo.toDate() },
  });
  if (dupe) {
    return ok(res, dupe, "Already invoiced for this period");
  }

  const unitPrice =
    sub.billingCycle === "YEARLY"
      ? Number(plan.yearlyPrice)
      : sub.billingCycle === "QUARTERLY"
        ? Number(plan.monthlyPrice) * 3
        : Number(plan.monthlyPrice);

  const subtotal = D(unitPrice);
  const discountAmount = D(body.discountAmount ?? 0);
  const totalAmount = subtotal.sub(discountAmount);
  const dueDate = dayjs().add(14, "day").startOf("day").toDate();
  const invoiceNumber = await nextInvoiceNumber(tenantId);

  const inv = await prisma.subscriptionInvoice.create({
    data: {
      tenantId,
      invoiceNumber,
      periodFrom: periodFrom.toDate(),
      periodTo: periodTo.toDate(),
      dueDate,
      status: "ISSUED",
      planCode: plan.code,
      planName: plan.name,
      billingCycle: sub.billingCycle,
      subtotal,
      discountAmount,
      totalAmount,
      paidAmount: D(0),
      dueAmount: totalAmount,
      notes: body.notes || null,
      lines: {
        create: [
          {
            description: `${plan.name} subscription · ${periodFrom.format("DD MMM YYYY")} – ${periodTo.format("DD MMM YYYY")}`,
            qty: 1,
            unitPrice: D(unitPrice),
            amount: D(unitPrice),
          },
        ],
      },
    },
    include: { lines: true },
  });

  created(res, inv, "Invoice generated");
};

/**
 * Record an out-of-band payment (bKash/Nagad/bank transfer) by the platform
 * admin. Moves the invoice to PARTIALLY_PAID / PAID and reactivates the
 * subscription if it had been suspended.
 */
export const recordPayment = async (req: Request, res: Response) => {
  const platformAdmin = await isPlatformAdmin(req);
  if (!platformAdmin) throw ApiError.forbidden("Platform admin only");

  const body = req.body as Record<string, any>;
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest("amount must be > 0");
  const invId = String(req.params.id);

  // Pre-fetch only to validate existence + capture tenantId for the audit
  // event below. The actual cap-check + write is re-read inside the
  // serializable transaction so two concurrent payments cannot overpay.
  const preCheck = await prisma.subscriptionInvoice.findUnique({
    where: { id: invId },
    select: { id: true, tenantId: true, invoiceNumber: true },
  });
  if (!preCheck) throw ApiError.notFound("Invoice not found");

  let attempts = 0;
  let result: { payment: unknown; invoice: unknown } | null = null;
  while (true) {
    try {
      result = await prisma.$transaction(
        async (tx) => {
          const inv = await tx.subscriptionInvoice.findUnique({ where: { id: invId } });
          if (!inv) throw ApiError.notFound("Invoice not found");
          if (inv.status === "VOID") throw ApiError.badRequest("Invoice is void");
          if (inv.status === "PAID") throw ApiError.badRequest("Already paid");
          if (D(amount).gt(inv.dueAmount)) {
            throw ApiError.badRequest(`Amount exceeds due (${inv.dueAmount.toString()})`);
          }

          const pay = await tx.subscriptionInvoicePayment.create({
            data: {
              invoiceId: inv.id,
              amount: D(amount),
              method: (body.method as PaymentMethod) || PaymentMethod.BANK_TRANSFER,
              referenceNo: body.referenceNo || null,
              notes: body.notes || null,
              recordedById: req.auth!.sub,
            },
          });

          const newPaid = inv.paidAmount.add(amount);
          const newDue = inv.totalAmount.sub(newPaid);
          const newStatus: SubscriptionInvoiceStatus = newDue.lte(0) ? "PAID" : "PARTIALLY_PAID";

          const updatedInv = await tx.subscriptionInvoice.update({
            where: { id: inv.id },
            data: {
              paidAmount: newPaid,
              dueAmount: newDue.lt(0) ? D(0) : newDue,
              status: newStatus,
              paidAt: newStatus === "PAID" ? new Date() : inv.paidAt,
            },
          });

          if (newStatus === "PAID") {
            const otherDue = await tx.subscriptionInvoice.count({
              where: {
                tenantId: inv.tenantId,
                status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] },
                id: { not: inv.id },
              },
            });
            if (otherDue === 0) {
              await tx.subscription.update({
                where: { tenantId: inv.tenantId },
                data: { status: "ACTIVE", suspendedAt: null },
              });
            }
          }

          return { payment: pay, invoice: updatedInv };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      break;
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

  await prisma.subscriptionEvent.create({
    data: {
      tenantId: preCheck.tenantId,
      eventType: "PAYMENT_RECORDED",
      amount: D(amount),
      method: (body.method as PaymentMethod) || PaymentMethod.BANK_TRANSFER,
      reference: body.referenceNo || null,
      notes: `Invoice ${preCheck.invoiceNumber}: ${body.notes || ""}`.trim(),
      createdBy: req.auth!.sub,
    },
  });

  created(res, result, "Payment recorded");
};

export const voidInvoice = async (req: Request, res: Response) => {
  const platformAdmin = await isPlatformAdmin(req);
  if (!platformAdmin) throw ApiError.forbidden("Platform admin only");

  const inv = await prisma.subscriptionInvoice.findUnique({ where: { id: String(req.params.id) } });
  if (!inv) throw ApiError.notFound("Invoice not found");
  if (inv.status === "PAID") throw ApiError.badRequest("Cannot void a fully-paid invoice");

  const reason = ((req.body as { reason?: string }).reason ?? "").trim();
  const updated = await prisma.subscriptionInvoice.update({
    where: { id: inv.id },
    data: { status: "VOID", voidedAt: new Date(), voidReason: reason || null },
  });
  ok(res, updated, "Invoice voided");
};

