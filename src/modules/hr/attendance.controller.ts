import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const STATUSES = ["PRESENT", "ABSENT", "LEAVE", "HOLIDAY", "HALF_DAY", "WEEKEND"] as const;
type Status = typeof STATUSES[number];

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const date = req.query.date as string | undefined;
  const userId = req.query.userId as string | undefined;
  const branchId = req.query.branchId as string | undefined;

  const where: Prisma.AttendanceWhereInput = {
    tenantId,
    ...(userId ? { userId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(date
      ? { date: dayjs(date).startOf("day").toDate() }
      : { date: { gte: dayjs().subtract(7, "day").startOf("day").toDate() } }),
  };
  const [rows, total] = await Promise.all([
    prisma.attendance.findMany({
      where,
      orderBy: [{ date: "desc" }, { user: { name: "asc" } }],
      skip, take,
      include: { user: { select: { id: true, name: true, role: true } } },
    }),
    prisma.attendance.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const upsert = async (req: Request, res: Response) => {
  const { tenantId, sub: recordedById } = req.auth!;
  const b = req.body as {
    userId: string;
    date: string;
    status: Status;
    branchId?: string;
    checkIn?: string;
    checkOut?: string;
    notes?: string;
  };
  const user = await prisma.user.findFirst({ where: { id: b.userId, tenantId, deletedAt: null } });
  if (!user) throw ApiError.notFound("Staff not found");
  const date = dayjs(b.date).startOf("day").toDate();
  const row = await prisma.attendance.upsert({
    where: { userId_date: { userId: b.userId, date } },
    create: {
      tenantId,
      branchId: b.branchId ?? user.branchId ?? null,
      userId: b.userId,
      date,
      status: b.status,
      checkIn: b.checkIn ? new Date(b.checkIn) : null,
      checkOut: b.checkOut ? new Date(b.checkOut) : null,
      notes: b.notes ?? null,
      recordedById,
    },
    update: {
      status: b.status,
      checkIn: b.checkIn ? new Date(b.checkIn) : undefined,
      checkOut: b.checkOut ? new Date(b.checkOut) : undefined,
      notes: b.notes !== undefined ? b.notes : undefined,
    },
  });
  created(res, row, "Attendance saved");
};

/**
 * Punch the current user in or out for today. Used by self-service kiosk.
 */
export const punch = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, branchId } = req.auth!;
  const action = (req.body as { action: "IN" | "OUT" }).action;
  if (!action) throw ApiError.badRequest("action required");

  const today = dayjs().startOf("day").toDate();
  const existing = await prisma.attendance.findUnique({
    where: { userId_date: { userId, date: today } },
  });
  const now = new Date();
  const row = await prisma.attendance.upsert({
    where: { userId_date: { userId, date: today } },
    create: {
      tenantId,
      branchId: branchId ?? null,
      userId,
      date: today,
      status: "PRESENT",
      checkIn: action === "IN" ? now : null,
      checkOut: action === "OUT" ? now : null,
      recordedById: userId,
    },
    update: {
      status: existing?.status === "ABSENT" ? "PRESENT" : (existing?.status ?? "PRESENT"),
      checkIn: action === "IN" && !existing?.checkIn ? now : undefined,
      checkOut: action === "OUT" ? now : undefined,
    },
  });
  ok(res, row, action === "IN" ? "Punched in" : "Punched out");
};

/**
 * Bulk-import attendance — accepts an array of rows. Useful for daily
 * uploads from biometric devices via CSV. Failures per row are returned so
 * the admin can review.
 */
export const bulkUpsert = async (req: Request, res: Response) => {
  const { tenantId, sub: recordedById } = req.auth!;
  const b = req.body as { rows: { userId: string; date: string; status: Status; checkIn?: string; checkOut?: string }[] };
  if (!Array.isArray(b.rows) || b.rows.length === 0) throw ApiError.badRequest("rows[] required");

  let ok_ = 0;
  let failed = 0;
  const errors: { index: number; reason: string }[] = [];

  for (let i = 0; i < b.rows.length; i++) {
    const r = b.rows[i];
    try {
      const user = await prisma.user.findFirst({ where: { id: r.userId, tenantId, deletedAt: null } });
      if (!user) { errors.push({ index: i, reason: "user not found" }); failed++; continue; }
      const date = dayjs(r.date).startOf("day").toDate();
      await prisma.attendance.upsert({
        where: { userId_date: { userId: r.userId, date } },
        create: {
          tenantId,
          branchId: user.branchId ?? null,
          userId: r.userId,
          date,
          status: r.status,
          checkIn: r.checkIn ? new Date(r.checkIn) : null,
          checkOut: r.checkOut ? new Date(r.checkOut) : null,
          recordedById,
        },
        update: {
          status: r.status,
          checkIn: r.checkIn ? new Date(r.checkIn) : undefined,
          checkOut: r.checkOut ? new Date(r.checkOut) : undefined,
        },
      });
      ok_++;
    } catch (e) {
      failed++;
      errors.push({ index: i, reason: (e as Error).message.slice(0, 200) });
    }
  }
  ok(res, { inserted: ok_, failed, errors }, "Bulk attendance processed");
};
