import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string) => new Prisma.Decimal(n);

// ── Operating rooms (OR) ────────────────────────────────────────

export const listRooms = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const branchId = req.query.branchId as string | undefined;
  const rows = await prisma.operatingRoom.findMany({
    where: { tenantId, deletedAt: null, ...(branchId ? { branchId } : {}) },
    orderBy: [{ branchId: "asc" }, { name: "asc" }],
    include: { branch: { select: { id: true, name: true } } },
  });
  ok(res, rows);
};

export const createRoom = async (req: Request, res: Response) => {
  const b = req.body as { branchId: string; name: string; notes?: string };
  const branch = await prisma.branch.findFirst({ where: { id: b.branchId, tenantId: req.auth!.tenantId } });
  if (!branch) throw ApiError.notFound("Branch not found");
  const row = await prisma.operatingRoom.create({
    data: {
      tenantId: req.auth!.tenantId,
      branchId: b.branchId,
      name: b.name,
      notes: b.notes ?? null,
    },
  });
  created(res, row, "OR added");
};

export const updateRoom = async (req: Request, res: Response) => {
  const r = await prisma.operatingRoom.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!r) throw ApiError.notFound("OR not found");
  const b = req.body as Record<string, unknown>;
  const updated = await prisma.operatingRoom.update({
    where: { id: r.id },
    data: {
      name: (b.name as string) ?? undefined,
      notes: b.notes !== undefined ? ((b.notes as string) || null) : undefined,
      isActive: (b.isActive as boolean) ?? undefined,
    },
  });
  ok(res, updated, "OR updated");
};

export const archiveRoom = async (req: Request, res: Response) => {
  const r = await prisma.operatingRoom.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!r) throw ApiError.notFound("OR not found");
  await prisma.operatingRoom.update({ where: { id: r.id }, data: { deletedAt: new Date(), isActive: false } });
  ok(res, { ok: true }, "OR archived");
};

// ── Bookings ────────────────────────────────────────────────────

export const listBookings = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const operatingRoomId = req.query.operatingRoomId as string | undefined;

  const where: Prisma.OtBookingWhereInput = {
    tenantId,
    ...(status ? { status: status as Prisma.OtBookingWhereInput["status"] } : {}),
    ...(operatingRoomId ? { operatingRoomId } : {}),
    ...(from || to
      ? {
          scheduledStart: {
            ...(from ? { gte: dayjs(from).startOf("day").toDate() } : {}),
            ...(to ? { lte: dayjs(to).endOf("day").toDate() } : {}),
          },
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.otBooking.findMany({
      where,
      orderBy: { scheduledStart: "asc" },
      skip,
      take,
      include: {
        operatingRoom: { select: { id: true, name: true } },
        patient: { select: { id: true, name: true, patientCode: true } },
      },
    }),
    prisma.otBooking.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getBooking = async (req: Request, res: Response) => {
  const row = await prisma.otBooking.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      operatingRoom: true,
      patient: true,
      note: true,
    },
  });
  if (!row) throw ApiError.notFound("Booking not found");
  // Resolve surgeon + anesthesiologist + team names from users
  const userIds = [row.surgeonId, row.anesthesiologistId, ...row.assistantIds, ...row.nurseIds].filter(Boolean) as string[];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, tenantId: req.auth!.tenantId },
    select: { id: true, name: true, role: true, specialization: true, bmdcNumber: true },
  });
  ok(res, { ...row, users });
};

export const createBooking = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const b = req.body as {
    operatingRoomId: string;
    patientId: string;
    admissionId?: string;
    surgeonId: string;
    procedureName: string;
    anesthesiaType?: string;
    anesthesiologistId?: string;
    assistantIds?: string[];
    nurseIds?: string[];
    scheduledStart: string;
    scheduledEnd: string;
    fee?: number;
    notes?: string;
  };
  const start = new Date(b.scheduledStart);
  const end = new Date(b.scheduledEnd);
  if (!(end > start)) throw ApiError.badRequest("scheduledEnd must be after scheduledStart");

  const [or, patient, surgeon] = await Promise.all([
    prisma.operatingRoom.findFirst({ where: { id: b.operatingRoomId, tenantId, deletedAt: null, isActive: true } }),
    prisma.patient.findFirst({ where: { id: b.patientId, tenantId, deletedAt: null } }),
    prisma.user.findFirst({ where: { id: b.surgeonId, tenantId, role: "DOCTOR" } }),
  ]);
  if (!or) throw ApiError.notFound("OR not found or inactive");
  if (!patient) throw ApiError.notFound("Patient not found");
  if (!surgeon) throw ApiError.notFound("Surgeon not found");

  // Refuse overlapping bookings in the same OR (active statuses only).
  const overlap = await prisma.otBooking.findFirst({
    where: {
      tenantId,
      operatingRoomId: b.operatingRoomId,
      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      AND: [{ scheduledStart: { lt: end } }, { scheduledEnd: { gt: start } }],
    },
  });
  if (overlap) throw ApiError.conflict("OR has a conflicting booking in that window");

  const row = await prisma.otBooking.create({
    data: {
      tenantId,
      operatingRoomId: b.operatingRoomId,
      patientId: b.patientId,
      admissionId: b.admissionId ?? null,
      surgeonId: b.surgeonId,
      procedureName: b.procedureName,
      anesthesiaType: b.anesthesiaType ?? null,
      anesthesiologistId: b.anesthesiologistId ?? null,
      assistantIds: b.assistantIds ?? [],
      nurseIds: b.nurseIds ?? [],
      scheduledStart: start,
      scheduledEnd: end,
      fee: D(b.fee ?? 0),
      notes: b.notes ?? null,
      note: { create: {} },
    },
    include: { note: true },
  });
  created(res, row, "OT booking created");
};

export const startBooking = async (req: Request, res: Response) => {
  const row = await prisma.otBooking.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!row) throw ApiError.notFound("Booking not found");
  if (row.status !== "SCHEDULED") throw ApiError.badRequest("Booking is not SCHEDULED");
  const updated = await prisma.otBooking.update({
    where: { id: row.id },
    data: { status: "IN_PROGRESS", actualStart: new Date() },
  });
  ok(res, updated, "OT started");
};

/**
 * Complete the booking + write IpdCharge PROCEDURE row if there's an
 * admission. Fee can be overridden at completion (final billing).
 */
export const completeBooking = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const b = req.body as { feeOverride?: number };

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.otBooking.findFirst({
      where: { id: String(req.params.id), tenantId },
    });
    if (!row) throw ApiError.notFound("Booking not found");
    if (row.status === "COMPLETED" || row.status === "CANCELLED") {
      throw ApiError.badRequest(`Booking is already ${row.status.toLowerCase()}`);
    }
    const finalFee = b.feeOverride != null ? b.feeOverride : Number(row.fee);
    const updated = await tx.otBooking.update({
      where: { id: row.id },
      data: { status: "COMPLETED", actualEnd: new Date(), fee: D(finalFee) },
      include: { operatingRoom: true },
    });

    if (row.admissionId && finalFee > 0) {
      const admission = await tx.admission.findFirst({
        where: { id: row.admissionId, tenantId, status: "ADMITTED" },
      });
      if (admission) {
        await tx.ipdCharge.create({
          data: {
            tenantId,
            admissionId: row.admissionId,
            chargeDate: dayjs().startOf("day").toDate(),
            chargeType: "PROCEDURE",
            description: `OT — ${row.procedureName} (${updated.operatingRoom.name})`,
            qty: 1,
            unitPrice: D(finalFee),
            amount: D(finalFee),
            refTable: "ot_bookings",
            refId: row.id,
            createdById: userId,
          },
        });
      }
    }
    return updated;
  });
  ok(res, result, "OT completed");
};

export const cancelBooking = async (req: Request, res: Response) => {
  const row = await prisma.otBooking.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!row) throw ApiError.notFound("Booking not found");
  if (row.status === "COMPLETED") throw ApiError.badRequest("Cannot cancel a completed booking");
  const updated = await prisma.otBooking.update({
    where: { id: row.id },
    data: { status: "CANCELLED" },
  });
  ok(res, updated, "Booking cancelled");
};

export const updateNote = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const row = await prisma.otBooking.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: { note: true },
  });
  if (!row) throw ApiError.notFound("Booking not found");
  const b = req.body as Record<string, unknown>;
  const data: Prisma.OtNoteUpdateInput = {};
  for (const k of [
    "preOpDiagnosis", "postOpDiagnosis", "procedureNotes", "findings", "complications",
    "specimensCollected", "anesthesiaNotes",
  ] as const) {
    if (b[k] !== undefined) (data as Record<string, unknown>)[k] = (b[k] as string) || null;
  }
  if (b.estimatedBloodLossMl !== undefined) data.estimatedBloodLossMl = (b.estimatedBloodLossMl as number) ?? null;
  if (b.anesthesiaStart !== undefined) data.anesthesiaStart = b.anesthesiaStart ? new Date(b.anesthesiaStart as string) : null;
  if (b.anesthesiaEnd !== undefined) data.anesthesiaEnd = b.anesthesiaEnd ? new Date(b.anesthesiaEnd as string) : null;

  const note = row.note
    ? await prisma.otNote.update({ where: { bookingId: row.id }, data })
    : await prisma.otNote.create({ data: { bookingId: row.id, ...(data as Prisma.OtNoteUncheckedCreateInput) } });
  ok(res, note, "OT note saved");
};

