import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { createInvoice } from "../../utils/invoiceBuilder";

interface UpdateBody {
  chiefComplaint?: string;
  historyOfPresentIllness?: string;
  examination?: string;
  vitals?: Record<string, string | number | null>;
  notes?: string;
  followUpDate?: string | null;
  diagnoses?: { icdCode: string; icdTerm: string; note?: string }[];
  prescription?: {
    notes?: string;
    advice?: string;
    items: {
      medicineName: string;
      dosage?: string;
      frequency?: string;
      durationDays?: number;
      instructions?: string;
    }[];
  };
}

/**
 * Idempotent: returns the existing consultation for this appointment,
 * or creates a fresh one and flips the appointment to IN_CONSULT.
 */
export const startFromAppointment = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const appt = await prisma.appointment.findFirst({
    where: { id: String(req.params.appointmentId), tenantId },
    include: { consultation: true },
  });
  if (!appt) throw ApiError.notFound("Appointment not found");
  if (appt.consultation) return ok(res, appt.consultation, "Consultation already started");

  const consultation = await prisma.$transaction(async (tx) => {
    const c = await tx.consultation.create({
      data: {
        tenantId,
        appointmentId: appt.id,
        patientId: appt.patientId,
        doctorId: appt.doctorId,
      },
    });
    await tx.appointment.update({
      where: { id: appt.id },
      data: { status: "IN_CONSULT" },
    });
    return c;
  });

  created(res, consultation, "Consultation started");
};

export const getOne = async (req: Request, res: Response) => {
  const c = await prisma.consultation.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: true,
      doctor: { select: { id: true, name: true, specialization: true, bmdcNumber: true, qualifications: true, consultationFee: true } },
      appointment: { select: { id: true, slotStart: true, slotEnd: true, tokenNumber: true, status: true, branchId: true } },
      diagnoses: true,
      prescription: { include: { items: { orderBy: { sortOrder: "asc" } } } },
    },
  });
  if (!c) throw ApiError.notFound("Consultation not found");

  if (req.auth!.role === "PATIENT" && c.patientId !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  ok(res, c);
};

export const update = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const c = await prisma.consultation.findFirst({
    where: { id: String(req.params.id), tenantId },
  });
  if (!c) throw ApiError.notFound("Consultation not found");
  if (c.completedAt) throw ApiError.badRequest("Consultation is finalized");

  const body = req.body as UpdateBody;

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.consultation.update({
      where: { id: c.id },
      data: {
        chiefComplaint: body.chiefComplaint ?? undefined,
        historyOfPresentIllness: body.historyOfPresentIllness ?? undefined,
        examination: body.examination ?? undefined,
        vitals: body.vitals as object | undefined,
        notes: body.notes ?? undefined,
        followUpDate:
          body.followUpDate === null
            ? null
            : body.followUpDate
              ? new Date(body.followUpDate)
              : undefined,
      },
    });

    if (body.diagnoses) {
      await tx.diagnosis.deleteMany({ where: { consultationId: c.id } });
      if (body.diagnoses.length) {
        await tx.diagnosis.createMany({
          data: body.diagnoses.map((d) => ({
            consultationId: c.id,
            icdCode: d.icdCode,
            icdTerm: d.icdTerm,
            note: d.note ?? null,
          })),
        });
      }
    }

    if (body.prescription) {
      const existing = await tx.prescription.findUnique({ where: { consultationId: c.id } });
      const rx = existing
        ? await tx.prescription.update({
            where: { id: existing.id },
            data: {
              notes: body.prescription.notes ?? null,
              advice: body.prescription.advice ?? null,
            },
          })
        : await tx.prescription.create({
            data: {
              tenantId,
              consultationId: c.id,
              notes: body.prescription.notes ?? null,
              advice: body.prescription.advice ?? null,
            },
          });
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: rx.id } });
      if (body.prescription.items.length) {
        await tx.prescriptionItem.createMany({
          data: body.prescription.items.map((it, idx) => ({
            prescriptionId: rx.id,
            medicineName: it.medicineName,
            dosage: it.dosage ?? null,
            frequency: it.frequency ?? null,
            durationDays: it.durationDays ?? null,
            instructions: it.instructions ?? null,
            sortOrder: idx,
          })),
        });
      }
    }

    return u;
  });

  ok(res, updated, "Saved");
};

/**
 * Finalize the consultation: marks completedAt, flips appointment to COMPLETED,
 * and (if the doctor has a consultationFee) creates a CONSULTATION-kind invoice.
 */
export const complete = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const c = await prisma.consultation.findFirst({
    where: { id: String(req.params.id), tenantId },
    include: {
      appointment: { select: { id: true, branchId: true } },
      doctor: { select: { id: true, name: true, consultationFee: true } },
    },
  });
  if (!c) throw ApiError.notFound("Consultation not found");
  if (c.completedAt) throw ApiError.badRequest("Consultation already finalized");

  // Allow caller to supply an override fee — typically the schedule's fee
  // takes precedence over the doctor default. UI passes it as `fee`.
  const overrideFee = (req.body as { fee?: number; chargePatient?: boolean }).fee;
  const chargePatient = (req.body as { chargePatient?: boolean }).chargePatient ?? true;
  const fee = overrideFee ?? Number(c.doctor.consultationFee ?? 0);

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.consultation.update({
      where: { id: c.id },
      data: { completedAt: new Date() },
    });
    await tx.appointment.update({
      where: { id: c.appointment.id },
      data: { status: "COMPLETED" },
    });

    let invoice = null;
    if (chargePatient && fee > 0) {
      invoice = await createInvoice(
        {
          tenantId,
          branchId: c.appointment.branchId,
          patientId: c.patientId,
          kind: "CONSULTATION",
          collectedById: req.auth!.sub,
          lines: [
            {
              lineType: "CONSULTATION" as const,
              description: `Consultation — Dr. ${c.doctor.name}`,
              unitPrice: fee,
              qty: 1,
              refTable: "consultations",
              refId: c.id,
            },
          ],
        },
        tx
      );
    }
    return { consultation: updated, invoice };
  });

  ok(res, result, "Consultation completed");
};

