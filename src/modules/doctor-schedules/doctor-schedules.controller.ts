import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface UpsertBody {
  doctorId: string;
  branchId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotMinutes?: number;
  consultationFee?: number | null;
  isActive?: boolean;
}

const validate = (b: UpsertBody) => {
  if (b.dayOfWeek < 0 || b.dayOfWeek > 6) {
    throw ApiError.badRequest("dayOfWeek must be 0–6 (Sun..Sat)");
  }
  if (!TIME_RE.test(b.startTime) || !TIME_RE.test(b.endTime)) {
    throw ApiError.badRequest("startTime/endTime must be HH:mm");
  }
  if (b.startTime >= b.endTime) {
    throw ApiError.badRequest("startTime must be before endTime");
  }
  if (b.slotMinutes && (b.slotMinutes < 5 || b.slotMinutes > 240)) {
    throw ApiError.badRequest("slotMinutes must be between 5 and 240");
  }
};

export const list = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const doctorId = req.query.doctorId as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  const rows = await prisma.doctorSchedule.findMany({
    where: {
      tenantId,
      ...(doctorId ? { doctorId } : {}),
      ...(branchId ? { branchId } : {}),
    },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    include: {
      doctor: { select: { id: true, name: true, specialization: true } },
      branch: { select: { id: true, name: true } },
    },
  });
  ok(res, rows);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as UpsertBody;
  validate(body);
  const tenantId = req.auth!.tenantId;

  const [doctor, branch] = await Promise.all([
    prisma.user.findFirst({
      where: { id: body.doctorId, tenantId, role: "DOCTOR", deletedAt: null },
    }),
    prisma.branch.findFirst({ where: { id: body.branchId, tenantId } }),
  ]);
  if (!doctor) throw ApiError.notFound("Doctor not found");
  if (!branch) throw ApiError.notFound("Branch not found");

  const row = await prisma.doctorSchedule.create({
    data: {
      tenantId,
      doctorId: body.doctorId,
      branchId: body.branchId,
      dayOfWeek: body.dayOfWeek,
      startTime: body.startTime,
      endTime: body.endTime,
      slotMinutes: body.slotMinutes ?? 15,
      consultationFee: body.consultationFee ?? null,
      isActive: body.isActive ?? true,
    },
  });
  created(res, row, "Schedule added");
};

export const update = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const existing = await prisma.doctorSchedule.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!existing) throw ApiError.notFound("Schedule not found");

  const body = req.body as Partial<UpsertBody>;
  const merged = { ...existing, ...body } as UpsertBody;
  validate(merged);

  const row = await prisma.doctorSchedule.update({
    where: { id: existing.id },
    data: {
      dayOfWeek: body.dayOfWeek ?? undefined,
      startTime: body.startTime ?? undefined,
      endTime: body.endTime ?? undefined,
      slotMinutes: body.slotMinutes ?? undefined,
      consultationFee:
        body.consultationFee !== undefined ? (body.consultationFee ?? null) : undefined,
      isActive: body.isActive ?? undefined,
    },
  });
  ok(res, row, "Schedule updated");
};

export const remove = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const existing = await prisma.doctorSchedule.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!existing) throw ApiError.notFound("Schedule not found");
  await prisma.doctorSchedule.delete({ where: { id: existing.id } });
  ok(res, { ok: true }, "Schedule removed");
};

