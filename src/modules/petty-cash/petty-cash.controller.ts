import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string) => new Prisma.Decimal(n);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const branchId = (req.query.branchId as string | undefined) ?? "";
  if (!branchId) throw ApiError.badRequest("branchId is required");

  const from = req.query.from ? dayjs(req.query.from as string).startOf("day").toDate() : dayjs().subtract(30, "day").toDate();
  const to = req.query.to ? dayjs(req.query.to as string).endOf("day").toDate() : new Date();

  const where: Prisma.PettyCashEntryWhereInput = {
    tenantId,
    branchId,
    occurredOn: { gte: from, lte: to },
  };
  const [rows, total] = await Promise.all([
    prisma.pettyCashEntry.findMany({
      where,
      orderBy: { occurredOn: "desc" },
      skip, take,
    }),
    prisma.pettyCashEntry.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

/**
 * Running balance for a branch (all-time). Cheap aggregate.
 */
export const balance = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const branchId = req.query.branchId as string | undefined;
  if (!branchId) throw ApiError.badRequest("branchId is required");
  const grouped = await prisma.pettyCashEntry.groupBy({
    by: ["type"],
    where: { tenantId, branchId },
    _sum: { amount: true },
  });
  let inTotal = 0, out = 0;
  for (const g of grouped) {
    const v = num(g._sum.amount);
    if (g.type === "TOP_UP") inTotal += v;
    else if (g.type === "PAYOUT") out += v;
    else inTotal += v;
  }
  ok(res, { in: inTotal, out, balance: inTotal - out });
};

export const create = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const recordedById = req.auth!.sub;
  const b = req.body as {
    branchId: string;
    type: "TOP_UP" | "PAYOUT" | "ADJUSTMENT";
    amount: number;
    description: string;
    voucherNo?: string;
    occurredOn?: string;
    // When PAYOUT, optionally also write a synthetic Expense row for the ledger.
    alsoExpense?: { category: "SALARY" | "RENT" | "UTILITIES" | "SUPPLIES" | "EQUIPMENT" | "MARKETING" | "MAINTENANCE" | "TAX" | "TRAVEL" | "GOVT_FEE" | "COMMISSION_PAYOUT" | "OTHER"; vendorName?: string };
  };

  const branch = await prisma.branch.findFirst({ where: { id: b.branchId, tenantId } });
  if (!branch) throw ApiError.notFound("Branch not found");
  if (b.amount < 0) throw ApiError.badRequest("Amount must be non-negative; use type for direction");

  const result = await prisma.$transaction(async (tx) => {
    let expenseId: string | null = null;
    if (b.type === "PAYOUT" && b.alsoExpense) {
      const e = await tx.expense.create({
        data: {
          tenantId,
          branchId: b.branchId,
          spentOn: b.occurredOn ? dayjs(b.occurredOn).startOf("day").toDate() : dayjs().startOf("day").toDate(),
          category: b.alsoExpense.category,
          description: b.description,
          amount: D(b.amount),
          paidVia: "CASH",
          vendorName: b.alsoExpense.vendorName ?? null,
          referenceNo: b.voucherNo ?? null,
          recordedById,
        },
      });
      expenseId = e.id;
    }
    const entry = await tx.pettyCashEntry.create({
      data: {
        tenantId,
        branchId: b.branchId,
        type: b.type,
        amount: D(b.amount),
        description: b.description,
        voucherNo: b.voucherNo ?? null,
        refExpenseId: expenseId,
        recordedById,
        occurredOn: b.occurredOn ? new Date(b.occurredOn) : new Date(),
      },
    });
    return entry;
  });
  created(res, result, "Entry recorded");
};

export const remove = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const row = await prisma.pettyCashEntry.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Entry not found");
  await prisma.pettyCashEntry.delete({ where: { id: row.id } });
  // Soft-delete the linked expense too (don't try to be cute and join — keep
  // each row independently deletable for safety).
  if (row.refExpenseId) {
    await prisma.expense.update({
      where: { id: row.refExpenseId },
      data: { deletedAt: new Date() },
    }).catch(() => undefined);
  }
  ok(res, { ok: true }, "Removed");
};

