import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string) => new Prisma.Decimal(n);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

// ── Leave types ────────────────────────────────────────────

export const listTypes = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.leaveType.findMany({
    where: { tenantId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  ok(res, rows);
};

export const createType = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as { code: string; name: string; daysPerYear?: number; paid?: boolean; carryForward?: boolean; isActive?: boolean };
  try {
    const row = await prisma.leaveType.create({
      data: {
        tenantId,
        code: b.code,
        name: b.name,
        daysPerYear: b.daysPerYear ?? 0,
        paid: b.paid ?? true,
        carryForward: b.carryForward ?? false,
        isActive: b.isActive ?? true,
      },
    });
    created(res, row, "Leave type added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("Leave type code already exists");
    }
    throw err;
  }
};

export const updateType = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const row = await prisma.leaveType.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Leave type not found");
  const b = req.body as Record<string, unknown>;
  const data: Prisma.LeaveTypeUpdateInput = {};
  if (b.name !== undefined) data.name = b.name as string;
  if (b.daysPerYear !== undefined) data.daysPerYear = b.daysPerYear as number;
  if (b.paid !== undefined) data.paid = b.paid as boolean;
  if (b.carryForward !== undefined) data.carryForward = b.carryForward as boolean;
  if (b.isActive !== undefined) data.isActive = b.isActive as boolean;
  const updated = await prisma.leaveType.update({ where: { id: row.id }, data });
  ok(res, updated, "Updated");
};

// ── Balances ──────────────────────────────────────────────

export const getMyBalance = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const types = await prisma.leaveType.findMany({ where: { tenantId, isActive: true } });
  const balances = await prisma.leaveBalance.findMany({
    where: { userId, year, leaveTypeId: { in: types.map((t) => t.id) } },
  });
  ok(res, types.map((t) => {
    const bal = balances.find((b) => b.leaveTypeId === t.id);
    const allocated = bal ? num(bal.allocated) : t.daysPerYear;
    const used = bal ? num(bal.used) : 0;
    return {
      leaveType: t,
      allocated,
      used,
      available: Math.max(0, allocated - used),
    };
  }));
};

/**
 * Initialize / top up balances for all staff for a given year. Idempotent —
 * existing balances aren't overwritten; only missing rows are created with
 * the leave-type's annual allocation.
 */
export const seedYearBalances = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as { year?: number };
  const year = b.year ?? new Date().getFullYear();
  const [types, staff] = await Promise.all([
    prisma.leaveType.findMany({ where: { tenantId, isActive: true } }),
    prisma.user.findMany({
      where: { tenantId, deletedAt: null, role: { notIn: ["PATIENT", "DELIVERY_STAFF"] } },
      select: { id: true },
    }),
  ]);

  let inserted = 0;
  for (const s of staff) {
    for (const t of types) {
      const exists = await prisma.leaveBalance.findUnique({
        where: { userId_leaveTypeId_year: { userId: s.id, leaveTypeId: t.id, year } },
      });
      if (exists) continue;
      await prisma.leaveBalance.create({
        data: { userId: s.id, leaveTypeId: t.id, year, allocated: D(t.daysPerYear) },
      });
      inserted++;
    }
  }
  ok(res, { year, inserted, staff: staff.length, types: types.length }, "Leave balances seeded");
};

// ── Requests ──────────────────────────────────────────────

export const listRequests = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const onlyMine = req.query.mine === "true";

  const where: Prisma.LeaveRequestWhereInput = {
    tenantId,
    ...(status ? { status: status as Prisma.LeaveRequestWhereInput["status"] } : {}),
    ...(onlyMine || (role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && role !== "HR_MANAGER")
      ? { userId }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      orderBy: [{ status: "asc" }, { fromDate: "desc" }],
      skip, take,
      include: {
        leaveType: { select: { id: true, code: true, name: true, paid: true } },
        user: { select: { id: true, name: true, role: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.leaveRequest.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const createRequest = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const b = req.body as { leaveTypeId: string; fromDate: string; toDate: string; reason?: string };
  const from = dayjs(b.fromDate).startOf("day");
  const to = dayjs(b.toDate).startOf("day");
  if (!from.isValid() || !to.isValid()) throw ApiError.badRequest("Valid dates required");
  if (to.isBefore(from)) throw ApiError.badRequest("toDate must be on or after fromDate");
  const type = await prisma.leaveType.findFirst({ where: { id: b.leaveTypeId, tenantId, isActive: true } });
  if (!type) throw ApiError.notFound("Leave type not found or inactive");
  const days = to.diff(from, "day") + 1;
  const row = await prisma.leaveRequest.create({
    data: {
      tenantId,
      userId,
      leaveTypeId: b.leaveTypeId,
      fromDate: from.toDate(),
      toDate: to.toDate(),
      days: D(days),
      reason: b.reason ?? null,
    },
    include: { leaveType: true },
  });
  created(res, row, "Leave request submitted");
};

export const reviewRequest = async (req: Request, res: Response) => {
  const { tenantId, sub: reviewerId } = req.auth!;
  const b = req.body as { decision: "APPROVE" | "REJECT"; reviewNote?: string };
  const row = await prisma.leaveRequest.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Request not found");
  if (row.status !== "PENDING") throw ApiError.badRequest(`Already ${row.status.toLowerCase()}`);

  await prisma.$transaction(async (tx) => {
    const newStatus = b.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    await tx.leaveRequest.update({
      where: { id: row.id },
      data: {
        status: newStatus,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reviewNote: b.reviewNote ?? null,
      },
    });
    // On approval, deduct from balance (create row if missing)
    if (b.decision === "APPROVE") {
      const year = dayjs(row.fromDate).year();
      const balance = await tx.leaveBalance.findUnique({
        where: { userId_leaveTypeId_year: { userId: row.userId, leaveTypeId: row.leaveTypeId, year } },
      });
      if (balance) {
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { used: D(num(balance.used) + num(row.days)) },
        });
      } else {
        const type = await tx.leaveType.findUnique({ where: { id: row.leaveTypeId } });
        await tx.leaveBalance.create({
          data: {
            userId: row.userId,
            leaveTypeId: row.leaveTypeId,
            year,
            allocated: D(type?.daysPerYear ?? 0),
            used: row.days,
          },
        });
      }
    }
  });

  ok(res, { ok: true }, b.decision === "APPROVE" ? "Approved" : "Rejected");
};

export const cancelRequest = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role } = req.auth!;
  const row = await prisma.leaveRequest.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Request not found");
  if (row.userId !== userId && role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && role !== "HR_MANAGER") {
    throw ApiError.forbidden();
  }
  await prisma.$transaction(async (tx) => {
    // If we're cancelling an approved request, restore the balance.
    if (row.status === "APPROVED") {
      const year = dayjs(row.fromDate).year();
      const balance = await tx.leaveBalance.findUnique({
        where: { userId_leaveTypeId_year: { userId: row.userId, leaveTypeId: row.leaveTypeId, year } },
      });
      if (balance) {
        const restored = Math.max(0, num(balance.used) - num(row.days));
        await tx.leaveBalance.update({ where: { id: balance.id }, data: { used: D(restored) } });
      }
    }
    await tx.leaveRequest.update({
      where: { id: row.id },
      data: { status: "CANCELLED" },
    });
  });
  ok(res, { ok: true }, "Cancelled");
};

