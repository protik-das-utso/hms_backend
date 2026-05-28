import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string | Prisma.Decimal | null | undefined) => new Prisma.Decimal(n ?? 0);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

/**
 * List shifts. Defaults to last 30 days; admins can widen the range.
 */
export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const branchId = req.query.branchId as string | undefined;
  const status = req.query.status as string | undefined;
  const since = req.query.from ? dayjs(req.query.from as string).toDate() : dayjs().subtract(30, "day").toDate();

  const where: Prisma.CashCloseWhereInput = {
    tenantId,
    openedAt: { gte: since },
    ...(branchId ? { branchId } : {}),
    ...(status ? { status: status as Prisma.CashCloseWhereInput["status"] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.cashClose.findMany({
      where,
      orderBy: { openedAt: "desc" },
      skip, take,
      include: { branch: { select: { id: true, name: true } } },
    }),
    prisma.cashClose.count({ where }),
  ]);

  // Resolve cashier names (one query) since CashClose doesn't have a relation
  const cashierIds = Array.from(new Set(rows.map((r) => r.cashierId)));
  const cashiers = cashierIds.length
    ? await prisma.user.findMany({ where: { id: { in: cashierIds }, tenantId }, select: { id: true, name: true } })
    : [];
  ok(res, rows.map((r) => ({ ...r, cashier: cashiers.find((c) => c.id === r.cashierId) ?? null })),
    "OK", paginate(page, pageSize, total));
};

export const currentShift = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const cashierId = req.auth!.sub;
  const branchId = (req.query.branchId as string) || req.auth!.branchId;
  if (!branchId) throw ApiError.badRequest("branchId is required (user has no default branch)");
  const shift = await prisma.cashClose.findFirst({
    where: { tenantId, branchId, cashierId, status: "OPEN" },
  });
  ok(res, shift);
};

/**
 * Open a shift. Refuses if this cashier already has an OPEN shift at this
 * branch — the partial unique on the table would also block it, but we
 * surface a friendly error here.
 */
export const openShift = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const cashierId = req.auth!.sub;
  const b = req.body as { branchId?: string; openingFloat?: number; notes?: string };
  const branchId = b.branchId ?? req.auth!.branchId;
  if (!branchId) throw ApiError.badRequest("branchId is required");
  const exists = await prisma.cashClose.findFirst({
    where: { tenantId, branchId, cashierId, status: "OPEN" },
  });
  if (exists) throw ApiError.conflict("You already have an open shift at this branch");
  const shift = await prisma.cashClose.create({
    data: {
      tenantId,
      branchId,
      cashierId,
      openingFloat: D(b.openingFloat ?? 0),
      notes: b.notes ?? null,
    },
  });
  created(res, shift, "Shift opened");
};

/**
 * Summary of the active shift — what the cashier should have in the drawer
 * if everything was recorded. Sums payments collected by this cashier since
 * shift start, by method, plus petty-cash net.
 */
export const shiftSummary = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const shift = await prisma.cashClose.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!shift) throw ApiError.notFound("Shift not found");
  const summary = await computeSummary(shift);
  ok(res, summary);
};

async function computeSummary(shift: { id: string; tenantId: string; branchId: string; cashierId: string; openingFloat: Prisma.Decimal; openedAt: Date; closedAt: Date | null }) {
  const start = shift.openedAt;
  const end = shift.closedAt ?? new Date();
  // Payments collected by this cashier on invoices for this branch within the window.
  const byMethod = await prisma.payment.groupBy({
    by: ["method"],
    where: {
      tenantId: shift.tenantId,
      collectedById: shift.cashierId,
      paidAt: { gte: start, lte: end },
      invoice: { branchId: shift.branchId },
    },
    _sum: { amount: true },
  });

  // Petty cash net for this branch within the window.
  const petty = await prisma.pettyCashEntry.findMany({
    where: {
      tenantId: shift.tenantId,
      branchId: shift.branchId,
      occurredOn: { gte: start, lte: end },
    },
    select: { type: true, amount: true },
  });
  let pettyIn = 0, pettyOut = 0;
  for (const p of petty) {
    if (p.type === "TOP_UP") pettyIn += num(p.amount);
    else if (p.type === "PAYOUT") pettyOut += num(p.amount);
    else pettyIn += num(p.amount); // ADJUSTMENT — signed; we treat positive as add
  }

  const totals: Record<string, number> = {
    CASH: 0, BKASH: 0, NAGAD: 0, ROCKET: 0, CARD: 0, BANK_TRANSFER: 0,
  };
  for (const m of byMethod) totals[m.method] = num(m._sum.amount);

  const expectedCash = num(shift.openingFloat) + totals.CASH + pettyIn - pettyOut;
  return {
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    openingFloat: num(shift.openingFloat),
    totals,
    pettyIn,
    pettyOut,
    expectedCash,
  };
}

export const closeShift = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const b = req.body as { declaredCash: number; notes?: string };
  const shift = await prisma.cashClose.findFirst({
    where: { id: String(req.params.id), tenantId, status: "OPEN" },
  });
  if (!shift) throw ApiError.notFound("Open shift not found");
  // Only the cashier or an admin can close it
  if (shift.cashierId !== req.auth!.sub && req.auth!.role !== "SUPER_ADMIN" && req.auth!.role !== "BRANCH_ADMIN") {
    throw ApiError.forbidden("Only the shift cashier or an admin can close this shift");
  }
  const summary = await computeSummary({ ...shift, closedAt: new Date() });
  const declared = b.declaredCash;
  const variance = declared - summary.expectedCash;

  const updated = await prisma.cashClose.update({
    where: { id: shift.id },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      expectedCash: D(summary.expectedCash),
      declaredCash: D(declared),
      variance: D(variance),
      cashTotal: D(summary.totals.CASH),
      bkashTotal: D(summary.totals.BKASH),
      nagadTotal: D(summary.totals.NAGAD),
      rocketTotal: D(summary.totals.ROCKET),
      cardTotal: D(summary.totals.CARD),
      bankTotal: D(summary.totals.BANK_TRANSFER),
      notes: b.notes ?? shift.notes,
    },
  });
  ok(res, { shift: updated, summary }, "Shift closed");
};

