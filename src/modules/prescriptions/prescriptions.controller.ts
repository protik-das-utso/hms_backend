import { Request, Response } from "express";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { streamPrescriptionPdf } from "../../utils/pdf";

export const getOne = async (req: Request, res: Response) => {
  const rx = await prisma.prescription.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      items: {
        orderBy: { sortOrder: "asc" },
        include: {
          medicine: {
            select: { id: true, brandName: true, strength: true, form: true, salePrice: true, isActive: true, deletedAt: true },
          },
        },
      },
      consultation: {
        include: {
          patient: true,
          doctor: { select: { id: true, name: true, bmdcNumber: true, qualifications: true, specialization: true } },
          diagnoses: true,
          appointment: { select: { id: true, slotStart: true, branch: { select: { name: true } } } },
        },
      },
    },
  });
  if (!rx) throw ApiError.notFound("Prescription not found");

  if (req.auth!.role === "PATIENT" && rx.consultation.patientId !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  ok(res, rx);
};

export const downloadPdf = async (req: Request, res: Response) => {
  const rx = await prisma.prescription.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      tenant: true,
      consultation: {
        include: {
          patient: true,
          doctor: { select: { id: true, name: true, bmdcNumber: true, qualifications: true, specialization: true } },
          diagnoses: true,
          appointment: { select: { slotStart: true, branch: { select: { name: true } } } },
        },
      },
    },
  });
  if (!rx) throw ApiError.notFound("Prescription not found");

  if (req.auth!.role === "PATIENT" && rx.consultation.patientId !== req.auth!.sub) {
    throw ApiError.forbidden();
  }

  const patient = rx.consultation.patient;
  const age = patient.dob ? `${dayjs().diff(patient.dob, "year")} y` : undefined;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="prescription-${rx.id.slice(0, 8)}.pdf"`
  );

  await streamPrescriptionPdf(
    {
      tenantName: rx.tenant.name,
      tenantAddress: rx.tenant.address,
      tenantPhone: rx.tenant.contactPhone,
      tenantEmail: rx.tenant.contactEmail,
      branchName: rx.consultation.appointment.branch?.name,

      patientName: patient.name,
      patientCode: patient.patientCode,
      patientAge: age,
      patientGender: patient.gender,
      patientPhone: patient.phone,

      doctorName: rx.consultation.doctor.name,
      doctorBmdc: rx.consultation.doctor.bmdcNumber,
      doctorQualifications: rx.consultation.doctor.qualifications,
      doctorSpecialization: rx.consultation.doctor.specialization,

      visitDate: rx.consultation.appointment.slotStart,
      chiefComplaint: rx.consultation.chiefComplaint,
      examination: rx.consultation.examination,
      vitals: rx.consultation.vitals as Record<string, string | number> | null,
      diagnoses: rx.consultation.diagnoses.map((d) => ({ code: d.icdCode, term: d.icdTerm })),
      advice: rx.advice,
      notes: rx.notes,
      followUpDate: rx.consultation.followUpDate,
      items: rx.items.map((it) => ({
        medicineName: it.medicineName,
        dosage: it.dosage,
        frequency: it.frequency,
        durationDays: it.durationDays,
        instructions: it.instructions,
      })),
    },
    res
  );

  await prisma.prescription.update({
    where: { id: rx.id },
    data: { printedAt: rx.printedAt ?? new Date() },
  });
};

