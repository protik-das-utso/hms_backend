import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { notify, sendSmsAsync } from "../../utils/notify";

interface CreateBody {
  patientId: string;
  doctorId: string;
  branchId?: string;
  slotStart: string;
  slotEnd?: string;
  bookedVia?: "COUNTER" | "PORTAL" | "PHONE";
  reason?: string;
  notes?: string;
}

const parseDay = (s?: string) => {
  if (!s) return dayjs().startOf("day");
  const d = dayjs(s);
  return d.isValid() ? d.startOf("day") : dayjs().startOf("day");
};

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const date = req.query.date as string | undefined;
  const doctorId = req.query.doctorId as string | undefined;
  const status = req.query.status as string | undefined;

  const where: Prisma.AppointmentWhereInput = { tenantId };
  if (doctorId) where.doctorId = doctorId;
  if (status) where.status = status as Prisma.AppointmentWhereInput["status"];
  if (date) {
    const start = parseDay(date).toDate();
    const end = parseDay(date).add(1, "day").toDate();
    where.slotStart = { gte: start, lt: end };
  }

  const [rows, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      orderBy: { slotStart: "asc" },
      skip,
      take,
      include: {
        patient: { select: { id: true, name: true, patientCode: true, phone: true, gender: true, dob: true } },
        doctor: { select: { id: true, name: true, specialization: true } },
        branch: { select: { id: true, name: true } },
        consultation: { select: { id: true, completedAt: true } },
      },
    }),
    prisma.appointment.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const appt = await prisma.appointment.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: true,
      doctor: { select: { id: true, name: true, specialization: true, bmdcNumber: true, consultationFee: true } },
      branch: { select: { id: true, name: true } },
      bookedBy: { select: { id: true, name: true } },
      consultation: {
        include: {
          diagnoses: true,
          prescription: { include: { items: { orderBy: { sortOrder: "asc" } } } },
        },
      },
    },
  });
  if (!appt) throw ApiError.notFound("Appointment not found");

  if (req.auth!.role === "PATIENT" && appt.patientId !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  ok(res, appt);
};

/**
 * Compute slot start/end and validate against the doctor's weekly schedule.
 * Returns the resolved end time and the schedule used (for fee fallback).
 */
const resolveSlot = async (params: {
  tenantId: string;
  doctorId: string;
  branchId: string;
  slotStart: Date;
  slotEnd?: Date;
}) => {
  const dow = params.slotStart.getDay();
  const schedules = await prisma.doctorSchedule.findMany({
    where: {
      tenantId: params.tenantId,
      doctorId: params.doctorId,
      branchId: params.branchId,
      dayOfWeek: dow,
      isActive: true,
    },
  });
  if (!schedules.length) {
    throw ApiError.badRequest("Doctor is not scheduled at this branch on that day");
  }
  // Find a schedule whose [start, end] contains the requested slotStart.
  const hh = params.slotStart.getHours().toString().padStart(2, "0");
  const mm = params.slotStart.getMinutes().toString().padStart(2, "0");
  const hhmm = `${hh}:${mm}`;
  const match = schedules.find((s) => hhmm >= s.startTime && hhmm < s.endTime);
  if (!match) {
    throw ApiError.badRequest("Slot is outside the doctor's working hours");
  }
  const slotEnd =
    params.slotEnd ?? new Date(params.slotStart.getTime() + match.slotMinutes * 60_000);
  if (slotEnd <= params.slotStart) {
    throw ApiError.badRequest("slotEnd must be after slotStart");
  }
  return { slotEnd, schedule: match };
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as CreateBody;
  const { tenantId, sub: userId, branchId: userBranchId } = req.auth!;
  const branchId = body.branchId ?? userBranchId;
  if (!branchId) throw ApiError.badRequest("branchId required");

  const slotStart = new Date(body.slotStart);
  if (isNaN(slotStart.getTime())) throw ApiError.badRequest("slotStart is not a valid datetime");
  const requestedEnd = body.slotEnd ? new Date(body.slotEnd) : undefined;

  const [patient, doctor] = await Promise.all([
    prisma.patient.findFirst({ where: { id: body.patientId, tenantId, deletedAt: null } }),
    prisma.user.findFirst({
      where: { id: body.doctorId, tenantId, role: "DOCTOR", deletedAt: null, isActive: true },
    }),
  ]);
  if (!patient) throw ApiError.notFound("Patient not found");
  if (!doctor) throw ApiError.notFound("Doctor not found");

  const { slotEnd } = await resolveSlot({
    tenantId,
    doctorId: doctor.id,
    branchId,
    slotStart,
    slotEnd: requestedEnd,
  });

  // Token = count of existing non-cancelled appointments for this doctor on this day + 1.
  const dayStart = dayjs(slotStart).startOf("day").toDate();
  const dayEnd = dayjs(slotStart).endOf("day").toDate();
  const dayCount = await prisma.appointment.count({
    where: {
      tenantId,
      doctorId: doctor.id,
      slotStart: { gte: dayStart, lte: dayEnd },
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
  });

  // Classify this visit: NEW if patient has no prior appointment at this
  // tenant, FOLLOW_UP if a prior appointment exists within 30 days, else OLD.
  const priorWhere = {
    tenantId,
    patientId: patient.id,
    status: { notIn: ["CANCELLED", "NO_SHOW"] as any },
  };
  const [hasAny, hadRecent] = await Promise.all([
    prisma.appointment.findFirst({ where: priorWhere, select: { id: true } }),
    prisma.appointment.findFirst({
      where: { ...priorWhere, slotStart: { gte: dayjs(slotStart).subtract(30, "day").toDate(), lte: slotStart } },
      select: { id: true },
    }),
  ]);
  const visitType = !hasAny ? "NEW" : hadRecent ? "FOLLOW_UP" : "OLD";

  let appt;
  try {
    appt = await prisma.appointment.create({
      data: {
        tenantId,
        branchId,
        patientId: patient.id,
        doctorId: doctor.id,
        slotStart,
        slotEnd,
        tokenNumber: dayCount + 1,
        status: "BOOKED",
        visitType,
        bookedById: userId,
        bookedVia: body.bookedVia ?? "COUNTER",
        reason: body.reason ?? null,
        notes: body.notes ?? null,
      },
      include: {
        patient: { select: { id: true, name: true, patientCode: true, phone: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
  } catch (err) {
    // Postgres exclusion constraint surfaces as 23P01.
    const e = err as { code?: string };
    if (e.code === "23P01") {
      throw ApiError.conflict("That slot just got booked by someone else — pick another");
    }
    throw err;
  }

  // Confirmation SMS via the editable template. Falls back to inline body
  // if the tenant hasn't configured APPT_CONFIRMED yet.
  if (patient.phone) {
    const haveTpl = await prisma.smsTemplate.findUnique({
      where: { tenantId_code: { tenantId, code: "APPT_CONFIRMED" } },
    });
    if (haveTpl) {
      sendSmsAsync({
        tenantId,
        code: "APPT_CONFIRMED",
        to: patient.phone,
        vars: {
          name: patient.name,
          doctor: doctor.name,
          slot: dayjs(slotStart).format("DD MMM YYYY, hh:mm A"),
          token: appt.tokenNumber,
        },
        relatedTo: "APPOINTMENT_BOOKED",
      });
    } else {
      void notify({
        tenantId,
        to: patient.phone,
        body: `Hi ${patient.name}, your appointment with Dr. ${doctor.name} is confirmed for ${dayjs(slotStart).format("DD MMM YYYY, hh:mm A")}. Token #${appt.tokenNumber}.`,
        relatedTo: "APPOINTMENT_BOOKED",
      });
    }
  }

  created(res, appt, "Appointment booked");
};

export const updateStatus = async (req: Request, res: Response) => {
  const { status } = req.body as {
    status: "BOOKED" | "CHECKED_IN" | "IN_CONSULT" | "COMPLETED" | "NO_SHOW" | "CANCELLED";
  };
  const appt = await prisma.appointment.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!appt) throw ApiError.notFound("Appointment not found");

  const updated = await prisma.appointment.update({
    where: { id: appt.id },
    data: { status },
  });
  ok(res, updated, "Status updated");
};

/**
 * Returns occupied + available slot starts for a doctor on a given day,
 * derived from DoctorSchedule + existing non-cancelled Appointments.
 */
export const availableSlots = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const doctorId = req.query.doctorId as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  const date = req.query.date as string | undefined;
  if (!doctorId || !branchId || !date) {
    throw ApiError.badRequest("doctorId, branchId and date are required");
  }
  const day = parseDay(date);
  const dow = day.day();

  const schedules = await prisma.doctorSchedule.findMany({
    where: { tenantId, doctorId, branchId, dayOfWeek: dow, isActive: true },
  });

  const allSlots: { start: Date; end: Date }[] = [];
  for (const s of schedules) {
    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    const start = day.hour(sh).minute(sm).second(0).millisecond(0);
    const end = day.hour(eh).minute(em).second(0).millisecond(0);
    for (let t = start; t.isBefore(end); t = t.add(s.slotMinutes, "minute")) {
      const slotEnd = t.add(s.slotMinutes, "minute");
      if (slotEnd.isAfter(end)) break;
      allSlots.push({ start: t.toDate(), end: slotEnd.toDate() });
    }
  }

  const dayStart = day.toDate();
  const dayEnd = day.add(1, "day").toDate();
  const existing = await prisma.appointment.findMany({
    where: {
      tenantId,
      doctorId,
      slotStart: { gte: dayStart, lt: dayEnd },
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    select: { slotStart: true, slotEnd: true },
  });
  const takenKeys = new Set(existing.map((a) => a.slotStart.toISOString()));

  ok(res, {
    slots: allSlots.map((s) => ({
      start: s.start,
      end: s.end,
      available: !takenKeys.has(s.start.toISOString()),
    })),
  });
};

