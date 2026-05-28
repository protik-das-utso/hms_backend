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
  const status = req.query.status as string | undefined;
  const userId = req.query.userId as string | undefined;

  const where: Prisma.StaffLoanWhereInput = {
    tenantId,
    ...(status ? { status: status as Prisma.StaffLoanWhereInput["status"] } : {}),
    ...(userId ? { userId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.staffLoan.findMany({
      where,
      orderBy: [{ status: "asc" }, { takenOn: "desc" }],
      skip, take,
      include: { user: { select: { id: true, name: true, role: true, designation: true } } },
    }),
    prisma.staffLoan.count({ where }),
  ]);
  ok(res, rows.map((r) => ({
    ...r,
    outstanding: Math.max(0, num(r.principal) - num(r.totalDeducted)),
  })), "OK", paginate(page, pageSize, total));
};

export const create = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as {
    userId: string;
    principal: number;
    monthlyDeduction: number;
    takenOn?: string;
    reason?: string;
    writeExpense?: boolean;
  };
  if (b.principal <= 0 || b.monthlyDeduction <= 0) throw ApiError.badRequest("Principal and monthlyDeduction must be > 0");

  const user = await prisma.user.findFirst({ where: { id: b.userId, tenantId, deletedAt: null } });
  if (!user) throw ApiError.notFound("Staff not found");

  const row = await prisma.$transaction(async (tx) => {
    let expenseId: string | null = null;
    if (b.writeExpense) {
      const branch = user.branchId ? { id: user.branchId } : await tx.branch.findFirst({ where: { tenantId, isActive: true } });
      if (branch) {
        const e = await tx.expense.create({
          data: {
            tenantId,
            branchId: branch.id,
            spentOn: b.takenOn ? dayjs(b.takenOn).startOf("day").toDate() : dayjs().startOf("day").toDate(),
            category: "OTHER",
            description: `Loan disbursed to ${user.name}`,
            amount: D(b.principal),
            paidVia: "CASH",
            vendorName: user.name,
            referenceNo: `LOAN-${dayjs().format("YYMMDDHHmm")}`,
            recordedById: req.auth!.sub,
          },
        });
        expenseId = e.id;
      }
    }
    return tx.staffLoan.create({
      data: {
        tenantId,
        userId: b.userId,
        principal: D(b.principal),
        monthlyDeduction: D(b.monthlyDeduction),
        takenOn: b.takenOn ? dayjs(b.takenOn).startOf("day").toDate() : new Date(),
        reason: b.reason ?? null,
        expenseId,
      },
    });
  });

  created(res, row, "Loan recorded");
};

export const settle = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const row = await prisma.staffLoan.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Loan not found");
  if (row.status !== "ACTIVE") throw ApiError.badRequest(`Loan is ${row.status.toLowerCase()}`);
  const updated = await prisma.staffLoan.update({
    where: { id: row.id },
    data: { status: "SETTLED", settledOn: new Date(), totalDeducted: row.principal },
  });
  ok(res, updated, "Loan settled");
};

export const cancel = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const row = await prisma.staffLoan.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Loan not found");
  if (row.status !== "ACTIVE") throw ApiError.badRequest("Only active loans can be cancelled");
  const updated = await prisma.staffLoan.update({
    where: { id: row.id },
    data: { status: "CANCELLED" },
  });
  ok(res, updated, "Cancelled");
};

