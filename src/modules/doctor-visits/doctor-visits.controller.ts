import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

export const listForAdmission = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const a = await prisma.admission.findFirst({ where: { id: String(req.params.admissionId), tenantId } });
  if (!a) throw ApiError.notFound("Admission not found");
  const visits = await prisma.doctorVisit.findMany({
    where: { tenantId, admissionId: a.id },
    orderBy: { visitAt: "desc" },
    include: { doctor: { select: { id: true, name: true, specialization: true } } },
  });
  ok(res, visits);
};

/**
 * Record a doctor visit and create the corresponding DOCTOR_VISIT IpdCharge
 * in the same transaction. Fee defaults to the doctor's consultationFee when
 * not provided. Refusing to silently insert a zero charge — clinics handle
 * "free follow-up" by setting fee=0 explicitly.
 */
export const create = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const createdById = req.auth!.sub;
  const body = req.body as {
    admissionId: string;
    doctorId: string;
    visitAt?: string;
    note?: string;
    fee?: number;
  };

  const result = await prisma.$transaction(async (tx) => {
    const a = await tx.admission.findFirst({
      where: { id: body.admissionId, tenantId, status: "ADMITTED" },
    });
    if (!a) throw ApiError.notFound("Active admission not found");
    const doctor = await tx.user.findFirst({
      where: { id: body.doctorId, tenantId, role: "DOCTOR" },
    });
    if (!doctor) throw ApiError.notFound("Doctor not found");

    const visitAt = body.visitAt ? new Date(body.visitAt) : new Date();
    const fee =
      body.fee != null
        ? new Prisma.Decimal(body.fee)
        : doctor.consultationFee ?? new Prisma.Decimal(0);

    const visit = await tx.doctorVisit.create({
      data: {
        tenantId,
        admissionId: a.id,
        doctorId: body.doctorId,
        visitAt,
        note: body.note ?? null,
        fee,
      },
      include: { doctor: { select: { id: true, name: true, specialization: true } } },
    });

    await tx.ipdCharge.create({
      data: {
        tenantId,
        admissionId: a.id,
        chargeDate: dayjs(visitAt).startOf("day").toDate(),
        chargeType: "DOCTOR_VISIT",
        description: `Dr. ${doctor.name} — visit`,
        qty: 1,
        unitPrice: fee,
        amount: fee,
        refTable: "doctor_visits",
        refId: visit.id,
        createdById,
      },
    });

    return visit;
  });

  created(res, result, "Visit recorded");
};

