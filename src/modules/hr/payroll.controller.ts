import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string) => new Prisma.Decimal(n);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

export const listRuns = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const branchId = req.query.branchId as string | undefined;
  const year = req.query.year ? Number(req.query.year) : undefined;

  const where: Prisma.PayrollRunWhereInput = {
    tenantId,
    ...(branchId ? { branchId } : {}),
    ...(year ? { periodYear: year } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.payrollRun.findMany({
      where,
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      skip, take,
      include: {
        branch: { select: { id: true, name: true } },
        _count: { select: { slips: true } },
      },
    }),
    prisma.payrollRun.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getRun = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const run = await prisma.payrollRun.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: {
      branch: { select: { id: true, name: true } },
      slips: {
        orderBy: { user: { name: "asc" } },
        include: { user: { select: { id: true, name: true, role: true } } },
      },
    },
  });
  if (!run) throw ApiError.notFound("Payroll run not found");
  ok(res, run);
};

/**
 * Generate a new draft payroll run. Creates one Payslip per staff with
 * employment terms in the (tenant, branch) scope. Existing draft for this
 * (branchId, periodYear, periodMonth) gets rejected — admin must cancel
 * the existing one first.
 */
export const createRun = async (req: Request, res: Response) => {
  const { tenantId, sub: createdById } = req.auth!;
  const b = req.body as { branchId?: string; periodYear: number; periodMonth: number; notes?: string };
  if (!b.periodYear || !b.periodMonth || b.periodMonth < 1 || b.periodMonth > 12) {
    throw ApiError.badRequest("Valid periodYear + periodMonth required");
  }

  const periodStart = dayjs(`${b.periodYear}-${String(b.periodMonth).padStart(2, "0")}-01`).startOf("day");
  const periodEnd = periodStart.endOf("month");
  const daysInMonth = periodStart.daysInMonth();

  const existing = await prisma.payrollRun.findFirst({
    where: {
      tenantId,
      branchId: b.branchId ?? null,
      periodYear: b.periodYear,
      periodMonth: b.periodMonth,
    },
  });
  if (existing) throw ApiError.conflict("A payroll run for that period already exists");

  // Fetch staff scoped to branch when given.
  const staff = await prisma.user.findMany({
    where: {
      tenantId,
      deletedAt: null,
      isActive: true,
      role: { notIn: ["PATIENT", "DELIVERY_STAFF"] },
      ...(b.branchId ? { branchId: b.branchId } : {}),
      employmentTerms: { isNot: null },
    },
    include: { employmentTerms: true },
  });
  if (staff.length === 0) throw ApiError.badRequest("No staff with employment terms in this scope. Set terms first.");

  // Pre-fetch active loans for these staff
  const loans = await prisma.staffLoan.findMany({
    where: { tenantId, userId: { in: staff.map((s) => s.id) }, status: "ACTIVE" },
  });
  // Attendance + leaves for the period
  const attendance = await prisma.attendance.findMany({
    where: { tenantId, userId: { in: staff.map((s) => s.id) }, date: { gte: periodStart.toDate(), lte: periodEnd.toDate() } },
    select: { userId: true, status: true },
  });
  const approvedLeaves = await prisma.leaveRequest.findMany({
    where: {
      tenantId,
      userId: { in: staff.map((s) => s.id) },
      status: "APPROVED",
      fromDate: { lte: periodEnd.toDate() },
      toDate: { gte: periodStart.toDate() },
    },
    include: { leaveType: { select: { paid: true } } },
  });

  const result = await prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.create({
      data: {
        tenantId,
        branchId: b.branchId ?? null,
        periodYear: b.periodYear,
        periodMonth: b.periodMonth,
        status: "DRAFT",
        notes: b.notes ?? null,
        createdById,
      },
    });

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    for (const s of staff) {
      const t = s.employmentTerms!;
      const basic = num(t.basicSalary);
      const allowances =
        num(t.houseAllowance) + num(t.medicalAllowance) + num(t.transportAllowance) + num(t.otherAllowances);
      const gross = basic + allowances;

      // Attendance breakdown
      const attRows = attendance.filter((a) => a.userId === s.id);
      const present = attRows.filter((a) => a.status === "PRESENT" || a.status === "HALF_DAY").length;
      const half = attRows.filter((a) => a.status === "HALF_DAY").length;
      const absent = attRows.filter((a) => a.status === "ABSENT").length;
      const recordedDays = attRows.length;

      // Leaves overlapping this period
      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;
      for (const lr of approvedLeaves.filter((l) => l.userId === s.id)) {
        const lvFrom = dayjs(lr.fromDate);
        const lvTo = dayjs(lr.toDate);
        const overlapFrom = lvFrom.isBefore(periodStart) ? periodStart : lvFrom;
        const overlapTo = lvTo.isAfter(periodEnd) ? periodEnd : lvTo;
        const days = overlapTo.diff(overlapFrom, "day") + 1;
        if (lr.leaveType.paid) paidLeaveDays += days;
        else unpaidLeaveDays += days;
      }

      // Days the staff effectively worked (counting half-days as 0.5)
      const workedEquivalent = present - half * 0.5;
      // If no attendance recorded at all, assume the staff worked normally — most clinics
      // don't run attendance tracking yet, and we'd zero out everyone's pay otherwise.
      const effectiveWorked = recordedDays === 0 ? daysInMonth : workedEquivalent + paidLeaveDays;
      const lopDays = Math.max(0, daysInMonth - effectiveWorked - unpaidLeaveDays);
      const totalLopDays = lopDays + unpaidLeaveDays;
      const lopAmount = (gross / daysInMonth) * totalLopDays;

      // Loan deduction — sum monthly installments of active loans
      const userLoans = loans.filter((l) => l.userId === s.id);
      const loanDeduction = userLoans.reduce((sum, l) => sum + Math.min(num(l.monthlyDeduction), num(l.principal) - num(l.totalDeducted)), 0);

      // Tax + PF
      const taxDeduction = (gross * num(t.taxDeductionPercent)) / 100;
      const pfDeduction = (basic * num(t.pfEmployeePercent)) / 100;

      const totalDed = lopAmount + taxDeduction + pfDeduction + loanDeduction;
      const net = Math.max(0, gross - totalDed);

      await tx.payslip.create({
        data: {
          payrollRunId: run.id,
          userId: s.id,
          designation: t.designation ?? null,
          basicSalary: D(basic),
          houseAllowance: D(num(t.houseAllowance)),
          medicalAllowance: D(num(t.medicalAllowance)),
          transportAllowance: D(num(t.transportAllowance)),
          otherAllowances: D(num(t.otherAllowances)),
          daysInMonth,
          daysPresent: Math.max(0, Math.round(workedEquivalent)),
          daysAbsent: absent,
          daysLeavePaid: paidLeaveDays,
          daysLeaveUnpaid: unpaidLeaveDays,
          lopAmount: D(lopAmount),
          taxDeduction: D(taxDeduction),
          pfDeduction: D(pfDeduction),
          loanDeduction: D(loanDeduction),
          otherDeduction: D(0),
          grossSalary: D(gross),
          totalDeductions: D(totalDed),
          netSalary: D(net),
          status: "PENDING",
        },
      });

      totalGross += gross;
      totalDeductions += totalDed;
      totalNet += net;
    }

    return tx.payrollRun.update({
      where: { id: run.id },
      data: { totalGross: D(totalGross), totalNet: D(totalNet), totalDeductions: D(totalDeductions) },
    });
  });

  created(res, result, `Draft payroll for ${result.periodMonth}/${result.periodYear} created with ${staff.length} payslips`);
};

/**
 * Finalize a draft run — applies loan deductions to outstanding balances,
 * writes a single SALARY Expense for net total, and locks the run.
 */
export const finalizeRun = async (req: Request, res: Response) => {
  const { tenantId, sub: finalizedById } = req.auth!;
  const run = await prisma.payrollRun.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: { slips: true },
  });
  if (!run) throw ApiError.notFound("Payroll run not found");
  if (run.status !== "DRAFT") throw ApiError.badRequest(`Run is ${run.status.toLowerCase()}`);

  await prisma.$transaction(async (tx) => {
    // Apply loan deductions per slip
    for (const slip of run.slips) {
      if (num(slip.loanDeduction) <= 0) continue;
      const loans = await tx.staffLoan.findMany({
        where: { tenantId, userId: slip.userId, status: "ACTIVE" },
        orderBy: { takenOn: "asc" },
      });
      let remaining = num(slip.loanDeduction);
      for (const l of loans) {
        if (remaining <= 0) break;
        const owing = num(l.principal) - num(l.totalDeducted);
        const apply = Math.min(remaining, num(l.monthlyDeduction), owing);
        if (apply <= 0) continue;
        const newDeducted = num(l.totalDeducted) + apply;
        await tx.staffLoan.update({
          where: { id: l.id },
          data: {
            totalDeducted: D(newDeducted),
            status: newDeducted >= num(l.principal) - 0.001 ? "SETTLED" : "ACTIVE",
            settledOn: newDeducted >= num(l.principal) - 0.001 ? new Date() : null,
          },
        });
        remaining -= apply;
      }
    }

    // Create the SALARY Expense row (so payroll shows up in the expense ledger)
    let expenseId: string | null = null;
    const total = num(run.totalNet);
    if (total > 0) {
      const expense = await tx.expense.create({
        data: {
          tenantId,
          branchId: run.branchId ?? null,
          spentOn: dayjs(`${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}-01`).endOf("month").toDate(),
          category: "SALARY",
          description: `Payroll ${run.periodMonth}/${run.periodYear}`,
          amount: D(total),
          paidVia: "CASH",
          vendorName: "Staff payroll",
          referenceNo: `PAYROLL-${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}`,
          recordedById: finalizedById,
        },
      });
      expenseId = expense.id;
    }

    await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "FINALIZED",
        finalizedAt: new Date(),
        finalizedById,
        expenseId,
      },
    });
  });

  ok(res, { ok: true }, "Payroll finalized");
};

export const cancelRun = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const run = await prisma.payrollRun.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!run) throw ApiError.notFound("Payroll run not found");
  if (run.status === "FINALIZED") throw ApiError.badRequest("Finalized runs cannot be cancelled");
  await prisma.payrollRun.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
  ok(res, { ok: true }, "Cancelled");
};

export const markSlipPaid = async (req: Request, res: Response) => {
  const { tenantId, sub: paidById } = req.auth!;
  const b = req.body as {
    paidVia?: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
    paidReferenceNo?: string;
  };
  const slip = await prisma.payslip.findFirst({
    where: { id: String(req.params.id), payrollRun: { tenantId } },
    include: { payrollRun: true },
  });
  if (!slip) throw ApiError.notFound("Payslip not found");
  if (slip.payrollRun.status !== "FINALIZED") {
    throw ApiError.badRequest("Run must be finalized before marking slips paid");
  }
  if (slip.status === "PAID") throw ApiError.badRequest("Already paid");
  const updated = await prisma.payslip.update({
    where: { id: slip.id },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paidVia: b.paidVia ?? "CASH",
      paidReferenceNo: b.paidReferenceNo ?? null,
      paidById,
    },
  });
  ok(res, updated, "Marked paid");
};

export const myPayslips = async (req: Request, res: Response) => {
  const { sub: userId } = req.auth!;
  const slips = await prisma.payslip.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      payrollRun: { select: { periodYear: true, periodMonth: true, status: true } },
    },
  });
  ok(res, slips);
};

