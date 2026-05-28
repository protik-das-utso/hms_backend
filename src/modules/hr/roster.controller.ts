import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

// ── Shifts ─────────────────────────────────────────────────

export const listShifts = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.dutyShift.findMany({
    where: { tenantId },
    orderBy: { startTime: "asc" },
  });
  ok(res, rows);
};

export const createShift = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as { branchId?: string; code: string; name: string; startTime: string; endTime: string; colorHex?: string };
  try {
    const row = await prisma.dutyShift.create({
      data: {
        tenantId,
        branchId: b.branchId ?? null,
        code: b.code,
        name: b.name,
        startTime: b.startTime,
        endTime: b.endTime,
        colorHex: b.colorHex ?? null,
      },
    });
    created(res, row, "Shift added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("A shift with that code already exists");
    }
    throw err;
  }
};

export const updateShift = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const row = await prisma.dutyShift.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Shift not found");
  const b = req.body as Record<string, unknown>;
  const data: Prisma.DutyShiftUpdateInput = {};
  if (b.code !== undefined) data.code = b.code as string;
  if (b.name !== undefined) data.name = b.name as string;
  if (b.startTime !== undefined) data.startTime = b.startTime as string;
  if (b.endTime !== undefined) data.endTime = b.endTime as string;
  if (b.colorHex !== undefined) data.colorHex = (b.colorHex as string) || null;
  const updated = await prisma.dutyShift.update({ where: { id: row.id }, data });
  ok(res, updated, "Shift updated");
};

export const deleteShift = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const row = await prisma.dutyShift.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Shift not found");
  // Reject deletion if shift is used in any roster
  const inUse = await prisma.dutyRoster.findFirst({ where: { shiftId: row.id } });
  if (inUse) throw ApiError.conflict("Shift is used in a roster — remove those first");
  await prisma.dutyShift.delete({ where: { id: row.id } });
  ok(res, { ok: true }, "Deleted");
};

// ── Roster ─────────────────────────────────────────────────

export const listRoster = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const from = req.query.from ? dayjs(req.query.from as string).startOf("day").toDate() : dayjs().startOf("week").toDate();
  const to = req.query.to ? dayjs(req.query.to as string).endOf("day").toDate() : dayjs().endOf("week").toDate();
  const branchId = req.query.branchId as string | undefined;

  const rows = await prisma.dutyRoster.findMany({
    where: {
      tenantId,
      date: { gte: from, lte: to },
      ...(branchId ? { branchId } : {}),
    },
    orderBy: [{ date: "asc" }, { user: { name: "asc" } }],
    include: {
      shift: { select: { id: true, code: true, name: true, colorHex: true } },
      user: { select: { id: true, name: true, role: true } },
    },
  });
  ok(res, rows);
};

export const assignShift = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as { userId: string; shiftId: string; date: string; branchId?: string; notes?: string };
  const date = dayjs(b.date).startOf("day").toDate();
  const [user, shift] = await Promise.all([
    prisma.user.findFirst({ where: { id: b.userId, tenantId, deletedAt: null } }),
    prisma.dutyShift.findFirst({ where: { id: b.shiftId, tenantId } }),
  ]);
  if (!user) throw ApiError.notFound("Staff not found");
  if (!shift) throw ApiError.notFound("Shift not found");

  const row = await prisma.dutyRoster.upsert({
    where: { userId_date: { userId: b.userId, date } },
    create: {
      tenantId,
      branchId: b.branchId ?? user.branchId ?? null,
      userId: b.userId,
      shiftId: b.shiftId,
      date,
      notes: b.notes ?? null,
    },
    update: { shiftId: b.shiftId, notes: b.notes ?? null },
  });
  created(res, row, "Shift assigned");
};

export const unassignShift = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const row = await prisma.dutyRoster.findFirst({ where: { id: String(req.params.id), tenantId } });
  if (!row) throw ApiError.notFound("Roster row not found");
  await prisma.dutyRoster.delete({ where: { id: row.id } });
  ok(res, { ok: true }, "Removed");
};

