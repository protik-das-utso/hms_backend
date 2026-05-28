import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string) => new Prisma.Decimal(n);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

/**
 * Per-referrer summary of earned vs. paid commissions in a date range.
 * "Earned" = sum of commissionAmount on TestOrders within the period.
 * "Paid"   = sum of CommissionPayout.amount for the same referrer.
 *
 * The shape merges external referrers (Referrer model) and internal
 * referrer users (User model) into a single feed so the UI can render
 * them together. `key` disambiguates type.
 */
export const pendingByReferrer = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const from = req.query.from ? dayjs(req.query.from as string).startOf("day").toDate() : dayjs().subtract(90, "day").toDate();
  const to = req.query.to ? dayjs(req.query.to as string).endOf("day").toDate() : new Date();

  // Earned per external referrer + internal user, grouped within the window.
  const [extEarned, intEarned, extPaid, intPaid, externalRefs, internalRefs] = await Promise.all([
    prisma.testOrder.groupBy({
      by: ["referrerId"],
      where: { tenantId, referrerId: { not: null }, commissionAmount: { gt: 0 }, createdAt: { gte: from, lte: to } },
      _sum: { commissionAmount: true },
      _count: { _all: true },
    }),
    prisma.testOrder.groupBy({
      by: ["referrerUserId"],
      where: { tenantId, referrerUserId: { not: null }, commissionAmount: { gt: 0 }, createdAt: { gte: from, lte: to } },
      _sum: { commissionAmount: true },
      _count: { _all: true },
    }),
    prisma.commissionPayout.groupBy({
      by: ["referrerId"],
      where: { tenantId, referrerId: { not: null }, paidAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.commissionPayout.groupBy({
      by: ["referrerUserId"],
      where: { tenantId, referrerUserId: { not: null }, paidAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.referrer.findMany({
      where: { tenantId, id: { in: extEarnedIds() } },
      select: { id: true, name: true, phone: true, designation: true, hospital: true },
    }).catch(() => []),
    prisma.user.findMany({
      where: { tenantId, id: { in: intEarnedIds() } },
      select: { id: true, name: true, role: true },
    }).catch(() => []),
  ]);

  // Re-fetch ID lists (the lazy approach above just placeholders to fit signature).
  const extIds = extEarned.map((r) => r.referrerId!).filter(Boolean);
  const intIds = intEarned.map((r) => r.referrerUserId!).filter(Boolean);
  const [exts, ints] = await Promise.all([
    extIds.length ? prisma.referrer.findMany({
      where: { tenantId, id: { in: extIds } },
      select: { id: true, name: true, phone: true, designation: true, hospital: true },
    }) : [],
    intIds.length ? prisma.user.findMany({
      where: { tenantId, id: { in: intIds } },
      select: { id: true, name: true, role: true, specialization: true },
    }) : [],
  ]);

  type Row = {
    kind: "EXTERNAL" | "INTERNAL";
    id: string;
    name: string;
    sub?: string;
    orderCount: number;
    earned: number;
    paid: number;
    outstanding: number;
  };
  const rows: Row[] = [];
  for (const e of extEarned) {
    const ref = exts.find((x) => x.id === e.referrerId);
    if (!ref) continue;
    const earned = num(e._sum.commissionAmount);
    const paid = num(extPaid.find((p) => p.referrerId === ref.id)?._sum.amount);
    rows.push({
      kind: "EXTERNAL",
      id: ref.id,
      name: ref.name,
      sub: [ref.designation, ref.hospital, ref.phone].filter(Boolean).join(" · "),
      orderCount: e._count._all,
      earned,
      paid,
      outstanding: Math.max(0, earned - paid),
    });
  }
  for (const e of intEarned) {
    const u = ints.find((x) => x.id === e.referrerUserId);
    if (!u) continue;
    const earned = num(e._sum.commissionAmount);
    const paid = num(intPaid.find((p) => p.referrerUserId === u.id)?._sum.amount);
    rows.push({
      kind: "INTERNAL",
      id: u.id,
      name: u.name,
      sub: u.specialization ?? u.role,
      orderCount: e._count._all,
      earned,
      paid,
      outstanding: Math.max(0, earned - paid),
    });
  }
  rows.sort((a, b) => b.outstanding - a.outstanding);
  ok(res, {
    from: dayjs(from).format("YYYY-MM-DD"),
    to: dayjs(to).format("YYYY-MM-DD"),
    rows,
  });
};

// Placeholders so the function-as-arg signature above compiles when Prisma
// expansion is strict — we re-fetch with real arrays right below.
function extEarnedIds(): string[] { return []; }
function intEarnedIds(): string[] { return []; }

/**
 * Detailed list of orders contributing to a referrer's commission in a
 * window. Used to verify the payout amount before recording.
 */
export const referrerDetail = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const kind = req.query.kind as "EXTERNAL" | "INTERNAL";
  const id = req.query.id as string;
  const from = req.query.from ? dayjs(req.query.from as string).startOf("day").toDate() : dayjs().subtract(90, "day").toDate();
  const to = req.query.to ? dayjs(req.query.to as string).endOf("day").toDate() : new Date();
  if (!kind || !id) throw ApiError.badRequest("kind and id required");

  const where: Prisma.TestOrderWhereInput = {
    tenantId,
    createdAt: { gte: from, lte: to },
    commissionAmount: { gt: 0 },
    ...(kind === "EXTERNAL" ? { referrerId: id } : { referrerUserId: id }),
  };
  const orders = await prisma.testOrder.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      orderNumber: true,
      createdAt: true,
      commissionPercent: true,
      commissionAmount: true,
      patient: { select: { id: true, name: true, patientCode: true } },
      invoice: { select: { totalAmount: true, paidAmount: true } },
    },
  });
  const payouts = await prisma.commissionPayout.findMany({
    where: {
      tenantId,
      paidAt: { gte: from, lte: to },
      ...(kind === "EXTERNAL" ? { referrerId: id } : { referrerUserId: id }),
    },
    orderBy: { paidAt: "desc" },
  });
  ok(res, { orders, payouts });
};

export const listPayouts = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const { page, pageSize, skip, take } = getPagination(req);
  const since = req.query.from ? dayjs(req.query.from as string).toDate() : dayjs().subtract(180, "day").toDate();

  const [rows, total] = await Promise.all([
    prisma.commissionPayout.findMany({
      where: { tenantId, paidAt: { gte: since } },
      orderBy: { paidAt: "desc" },
      skip, take,
    }),
    prisma.commissionPayout.count({ where: { tenantId, paidAt: { gte: since } } }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const recordPayout = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const paidById = req.auth!.sub;
  const b = req.body as {
    kind: "EXTERNAL" | "INTERNAL";
    referrerId?: string;
    referrerUserId?: string;
    periodFrom: string;
    periodTo: string;
    amount: number;
    method?: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
    referenceNo?: string;
    orderIds?: string[];
    notes?: string;
    writeExpense?: boolean;
  };

  if (b.kind === "EXTERNAL" && !b.referrerId) throw ApiError.badRequest("referrerId required for external");
  if (b.kind === "INTERNAL" && !b.referrerUserId) throw ApiError.badRequest("referrerUserId required for internal");

  // Resolve payee name + branch (use first branch of tenant for the expense row)
  let payeeName = "";
  if (b.kind === "EXTERNAL") {
    const r = await prisma.referrer.findFirst({ where: { id: b.referrerId, tenantId } });
    if (!r) throw ApiError.notFound("Referrer not found");
    payeeName = r.name;
  } else {
    const u = await prisma.user.findFirst({ where: { id: b.referrerUserId, tenantId } });
    if (!u) throw ApiError.notFound("Referrer user not found");
    payeeName = u.name;
  }

  const result = await prisma.$transaction(async (tx) => {
    let expenseId: string | null = null;
    if (b.writeExpense) {
      const branch = await tx.branch.findFirst({ where: { tenantId, isActive: true } });
      const e = await tx.expense.create({
        data: {
          tenantId,
          branchId: branch?.id ?? null,
          spentOn: dayjs().startOf("day").toDate(),
          category: "COMMISSION_PAYOUT",
          description: `Commission to ${payeeName}`,
          amount: D(b.amount),
          paidVia: b.method ?? "CASH",
          vendorName: payeeName,
          referenceNo: b.referenceNo ?? null,
          recordedById: paidById,
        },
      });
      expenseId = e.id;
    }
    const row = await tx.commissionPayout.create({
      data: {
        tenantId,
        referrerId: b.kind === "EXTERNAL" ? b.referrerId ?? null : null,
        referrerUserId: b.kind === "INTERNAL" ? b.referrerUserId ?? null : null,
        payeeName,
        periodFrom: dayjs(b.periodFrom).startOf("day").toDate(),
        periodTo: dayjs(b.periodTo).endOf("day").toDate(),
        amount: D(b.amount),
        method: b.method ?? "CASH",
        referenceNo: b.referenceNo ?? null,
        notes: b.notes ?? null,
        orderIds: b.orderIds ?? [],
        paidById,
        expenseId,
      },
    });
    return row;
  });
  created(res, result, "Payout recorded");
};
