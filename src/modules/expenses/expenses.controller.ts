import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const CATS = ["SALARY", "RENT", "UTILITIES", "SUPPLIES", "EQUIPMENT", "MARKETING", "MAINTENANCE", "TAX", "TRAVEL", "GOVT_FEE", "COMMISSION_PAYOUT", "OTHER"] as const;
type Cat = typeof CATS[number];

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  const category = req.query.category as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.ExpenseWhereInput = {
    tenantId,
    deletedAt: null,
    ...(branchId ? { branchId } : {}),
    ...(category ? { category: category as Cat } : {}),
    ...(from || to
      ? {
          spentOn: {
            ...(from ? { gte: dayjs(from).startOf("day").toDate() } : {}),
            ...(to ? { lte: dayjs(to).endOf("day").toDate() } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: "insensitive" } },
            { vendorName: { contains: q, mode: "insensitive" } },
            { referenceNo: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: [{ spentOn: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      include: { branch: { select: { id: true, name: true } } },
    }),
    prisma.expense.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const summary = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const branchId = req.query.branchId as string | undefined;

  const start = from ? dayjs(from).startOf("day").toDate() : dayjs().startOf("month").toDate();
  const end = to ? dayjs(to).endOf("day").toDate() : dayjs().endOf("month").toDate();

  const where: Prisma.ExpenseWhereInput = {
    tenantId,
    deletedAt: null,
    spentOn: { gte: start, lte: end },
    ...(branchId ? { branchId } : {}),
  };

  const grouped = await prisma.expense.groupBy({
    by: ["category"],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  const total = grouped.reduce((s, g) => s + Number(g._sum.amount ?? 0), 0);
  const count = grouped.reduce((s, g) => s + g._count._all, 0);
  ok(res, {
    from: dayjs(start).format("YYYY-MM-DD"),
    to: dayjs(end).format("YYYY-MM-DD"),
    total,
    count,
    byCategory: grouped.map((g) => ({
      category: g.category,
      total: Number(g._sum.amount ?? 0),
      count: g._count._all,
    })),
  });
};

export const create = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const body = req.body as {
    branchId?: string;
    spentOn: string;
    category: Cat;
    description: string;
    amount: number;
    paidVia?: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
    vendorName?: string;
    referenceNo?: string;
    notes?: string;
  };
  if (body.branchId) {
    const b = await prisma.branch.findFirst({ where: { id: body.branchId, tenantId } });
    if (!b) throw ApiError.notFound("Branch not found");
  }
  const row = await prisma.expense.create({
    data: {
      tenantId,
      branchId: body.branchId ?? null,
      spentOn: dayjs(body.spentOn).startOf("day").toDate(),
      category: body.category,
      description: body.description,
      amount: new Prisma.Decimal(body.amount),
      paidVia: body.paidVia ?? "CASH",
      vendorName: body.vendorName ?? null,
      referenceNo: body.referenceNo ?? null,
      notes: body.notes ?? null,
      recordedById: userId,
    },
  });
  created(res, row, "Expense recorded");
};

export const update = async (req: Request, res: Response) => {
  const e = await prisma.expense.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!e) throw ApiError.notFound("Expense not found");
  const body = req.body as Record<string, unknown>;
  const data: Prisma.ExpenseUpdateInput = {};
  if (body.branchId !== undefined) data.branch = body.branchId ? { connect: { id: body.branchId as string } } : { disconnect: true };
  if (body.spentOn !== undefined) data.spentOn = dayjs(body.spentOn as string).startOf("day").toDate();
  if (body.category !== undefined) data.category = body.category as Cat;
  if (body.description !== undefined) data.description = body.description as string;
  if (body.amount !== undefined) data.amount = new Prisma.Decimal(body.amount as number);
  if (body.paidVia !== undefined) data.paidVia = body.paidVia as "CASH";
  if (body.vendorName !== undefined) data.vendorName = (body.vendorName as string) || null;
  if (body.referenceNo !== undefined) data.referenceNo = (body.referenceNo as string) || null;
  if (body.notes !== undefined) data.notes = (body.notes as string) || null;
  const updated = await prisma.expense.update({ where: { id: e.id }, data });
  ok(res, updated, "Expense updated");
};

export const remove = async (req: Request, res: Response) => {
  const e = await prisma.expense.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!e) throw ApiError.notFound("Expense not found");
  await prisma.expense.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
  ok(res, { ok: true }, "Expense removed");
};

