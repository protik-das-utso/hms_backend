import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { admissionNumber } from "../../utils/codes";
import { createInvoice } from "../../utils/invoiceBuilder";

const D = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.AdmissionWhereInput = {
    tenantId,
    ...(branchId ? { branchId } : {}),
    ...(status ? { status: status as Prisma.AdmissionWhereInput["status"] } : {}),
    ...(q
      ? {
          OR: [
            { admissionNumber: { contains: q, mode: "insensitive" } },
            { patient: { name: { contains: q, mode: "insensitive" } } },
            { patient: { patientCode: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.admission.findMany({
      where,
      orderBy: { admittedAt: "desc" },
      skip,
      take,
      include: {
        patient: { select: { id: true, name: true, patientCode: true, phone: true, gender: true, dob: true } },
        admittingDoctor: { select: { id: true, name: true, specialization: true } },
        branch: { select: { id: true, name: true } },
        allocations: {
          where: { toTs: null },
          include: { bed: { include: { ward: { select: { name: true, type: true } } } } },
        },
        invoice: { select: { id: true, invoiceNumber: true, totalAmount: true, dueAmount: true, status: true } },
      },
    }),
    prisma.admission.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const a = await prisma.admission.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: {
      patient: true,
      admittingDoctor: { select: { id: true, name: true, specialization: true, bmdcNumber: true } },
      branch: true,
      allocations: {
        orderBy: { fromTs: "asc" },
        include: { bed: { include: { ward: true } } },
      },
      charges: { orderBy: { chargeDate: "asc" } },
      nursingNotes: {
        orderBy: { recordedAt: "desc" },
        include: { nurse: { select: { id: true, name: true } } },
      },
      doctorVisits: {
        orderBy: { visitAt: "desc" },
        include: { doctor: { select: { id: true, name: true, specialization: true } } },
      },
      dischargeSummary: { include: { dischargingDoctor: { select: { id: true, name: true, bmdcNumber: true } } } },
      invoice: { include: { payments: true, lines: true } },
    },
  });
  if (!a) throw ApiError.notFound("Admission not found");
  ok(res, a);
};

/**
 * Create an admission. Transaction: verify the bed is available, mark it
 * OCCUPIED, open a BedAllocation, create the Admission row.
 */
export const admit = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const body = req.body as {
    patientId: string;
    bedId: string;
    admittingDoctorId: string;
    diagnosisOnAdmission?: string;
    admittedAt?: string;
    notes?: string;
  };

  const result = await prisma.$transaction(async (tx) => {
    const [patient, bed, doctor] = await Promise.all([
      tx.patient.findFirst({ where: { id: body.patientId, tenantId, deletedAt: null } }),
      tx.bed.findFirst({
        where: { id: body.bedId, tenantId, deletedAt: null },
        include: { ward: true, allocations: { where: { toTs: null } } },
      }),
      tx.user.findFirst({ where: { id: body.admittingDoctorId, tenantId, role: "DOCTOR" } }),
    ]);
    if (!patient) throw ApiError.notFound("Patient not found");
    if (!bed) throw ApiError.notFound("Bed not found");
    if (!doctor) throw ApiError.notFound("Doctor not found");
    if (bed.status !== "AVAILABLE" && bed.status !== "RESERVED") {
      throw ApiError.conflict(`Bed is ${bed.status.toLowerCase()}, cannot admit`);
    }
    // The application-level check below catches the common case; the partial
    // unique index `bed_allocations_bed_open_uniq` (migration 20260528*) is
    // the durable backstop that prevents two concurrent admits from stacking
    // allocations on the same bed.
    if (bed.allocations.length > 0) {
      throw ApiError.conflict("Bed already has an active allocation");
    }

    // Prevent double-admitting a patient
    const existing = await tx.admission.findFirst({
      where: { tenantId, patientId: body.patientId, status: "ADMITTED" },
    });
    if (existing) throw ApiError.conflict("Patient already has an active admission");

    const todayStart = dayjs().startOf("day").toDate();
    const seq = await tx.admission.count({ where: { tenantId, createdAt: { gte: todayStart } } });

    const admission = await tx.admission.create({
      data: {
        tenantId,
        branchId: bed.ward.branchId,
        patientId: body.patientId,
        admittingDoctorId: body.admittingDoctorId,
        admissionNumber: admissionNumber(seq + 1),
        admittedAt: body.admittedAt ? new Date(body.admittedAt) : new Date(),
        diagnosisOnAdmission: body.diagnosisOnAdmission ?? null,
        notes: body.notes ?? null,
      },
    });

    await tx.bedAllocation.create({
      data: { admissionId: admission.id, bedId: bed.id, fromTs: admission.admittedAt, notes: null },
    });
    await tx.bed.update({ where: { id: bed.id }, data: { status: "OCCUPIED" } });

    // Seed a bed charge for the admission day so the patient is billed for
    // their first day immediately (the nightly cron only charges full days
    // going forward). Idempotent via the partial unique on BED charges.
    await tx.ipdCharge.create({
      data: {
        tenantId,
        admissionId: admission.id,
        chargeDate: dayjs(admission.admittedAt).startOf("day").toDate(),
        chargeType: "BED",
        description: `Bed charge — ${bed.ward.name} · ${bed.code}`,
        qty: 1,
        unitPrice: bed.dailyRate,
        amount: bed.dailyRate,
        refTable: "beds",
        refId: bed.id,
        createdById: userId,
      },
    });

    return admission;
  });

  created(res, result, "Patient admitted");
};

/**
 * Transfer the patient to a different bed. Closes the current allocation,
 * opens a new one on the target bed, swaps bed statuses, and updates the
 * "Bed charge" description on today's row to reflect the new bed.
 */
export const transfer = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const body = req.body as { bedId: string; notes?: string };
  const admissionId = String(req.params.id);

  await prisma.$transaction(async (tx) => {
    const admission = await tx.admission.findFirst({
      where: { id: admissionId, tenantId, status: "ADMITTED" },
      include: { allocations: { where: { toTs: null } } },
    });
    if (!admission) throw ApiError.notFound("Active admission not found");
    if (admission.allocations.length === 0) {
      throw ApiError.badRequest("Admission has no active bed allocation");
    }
    const current = admission.allocations[0];
    if (current.bedId === body.bedId) throw ApiError.badRequest("Already on this bed");

    const targetBed = await tx.bed.findFirst({
      where: { id: body.bedId, tenantId, deletedAt: null },
      include: { ward: true, allocations: { where: { toTs: null } } },
    });
    if (!targetBed) throw ApiError.notFound("Target bed not found");
    if (targetBed.status !== "AVAILABLE" && targetBed.status !== "RESERVED") {
      throw ApiError.conflict(`Target bed is ${targetBed.status.toLowerCase()}`);
    }
    if (targetBed.allocations.length > 0) {
      throw ApiError.conflict("Target bed already has an active allocation");
    }

    const now = new Date();
    await tx.bedAllocation.update({
      where: { id: current.id },
      data: { toTs: now, notes: body.notes ?? null },
    });
    await tx.bed.update({ where: { id: current.bedId }, data: { status: "CLEANING" } });
    await tx.bedAllocation.create({
      data: { admissionId, bedId: targetBed.id, fromTs: now, notes: body.notes ?? null },
    });
    await tx.bed.update({ where: { id: targetBed.id }, data: { status: "OCCUPIED" } });

    // A bed charge for today already exists from the previous bed/admit day.
    // Going forward the cron will charge the new bed's rate (it looks up the
    // active allocation each night). We don't retroactively split today's
    // charge — that's a finance policy decision; clinics can adjust manually.
    void userId; // (kept for symmetry with other writes)
  });

  ok(res, { ok: true }, "Patient transferred");
};

/**
 * Discharge — closes the active allocation, marks the bed CLEANING (front
 * desk will mark it AVAILABLE after housekeeping), stamps the admission as
 * DISCHARGED, creates/updates the DischargeSummary, then builds the final
 * IPD invoice from all IpdCharge rows via the shared invoiceBuilder.
 */
export const discharge = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const admissionId = String(req.params.id);
  const body = req.body as {
    dischargingDoctorId: string;
    finalDiagnosis?: string;
    treatmentSummary?: string;
    dischargeAdvice?: string;
    followUpDate?: string;
    dischargedAt?: string;
    leftAgainstAdvice?: boolean;
    discountAmount?: number;
    vatPercent?: number;
    initialPayment?: {
      amount: number;
      method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER";
      referenceNo?: string;
    };
  };

  const result = await prisma.$transaction(async (tx) => {
    const admission = await tx.admission.findFirst({
      where: { id: admissionId, tenantId },
      include: {
        patient: true,
        allocations: { where: { toTs: null }, include: { bed: true } },
        charges: true,
      },
    });
    if (!admission) throw ApiError.notFound("Admission not found");
    if (admission.status !== "ADMITTED") throw ApiError.badRequest("Admission is not active");
    if (admission.charges.length === 0) {
      throw ApiError.badRequest("Admission has no charges to bill");
    }

    const doctor = await tx.user.findFirst({
      where: { id: body.dischargingDoctorId, tenantId, role: "DOCTOR" },
    });
    if (!doctor) throw ApiError.notFound("Discharging doctor not found");

    const now = body.dischargedAt ? new Date(body.dischargedAt) : new Date();

    // Close active allocation + free the bed.
    for (const alloc of admission.allocations) {
      await tx.bedAllocation.update({ where: { id: alloc.id }, data: { toTs: now } });
      await tx.bed.update({ where: { id: alloc.bedId }, data: { status: "CLEANING" } });
    }

    // Build invoice lines from the per-charge rows. We collapse identical bed
    // charges into one "Bed × N days" line for tidiness on the bill.
    const bedCharges = admission.charges.filter((c) => c.chargeType === "BED");
    const otherCharges = admission.charges.filter((c) => c.chargeType !== "BED");

    const lines: Parameters<typeof createInvoice>[0]["lines"] = [];

    if (bedCharges.length > 0) {
      const totalDays = bedCharges.reduce((s, c) => s + c.qty, 0);
      const totalAmt = bedCharges.reduce((s, c) => s.plus(c.amount), D(0));
      const unit = totalDays > 0 ? totalAmt.dividedBy(totalDays) : D(0);
      lines.push({
        lineType: "BED",
        description: `Bed charges × ${totalDays} day${totalDays === 1 ? "" : "s"}`,
        qty: totalDays,
        // Pass Decimal directly — invoiceBuilder accepts it and avoids the
        // Number(...toFixed(2)) round-trip that silently drops precision.
        unitPrice: unit,
        refTable: "ipd_charges",
      });
    }
    for (const c of otherCharges) {
      lines.push({
        lineType:
          c.chargeType === "MEDICINE"
            ? "MEDICINE"
            : c.chargeType === "DOCTOR_VISIT"
              ? "CONSULTATION"
              : c.chargeType === "PROCEDURE"
                ? "PROCEDURE"
                : c.chargeType === "CONSUMABLE"
                  ? "CONSUMABLE"
                  : c.chargeType === "INVESTIGATION"
                    ? "TEST"
                    : "OTHER",
        description: c.description,
        qty: c.qty,
        unitPrice: c.unitPrice,
        refTable: c.refTable ?? "ipd_charges",
        refId: c.refId ?? c.id,
      });
    }

    const invoice = await createInvoice(
      {
        tenantId,
        branchId: admission.branchId,
        patientId: admission.patientId,
        kind: "IPD",
        discountAmount: body.discountAmount,
        vatPercent: body.vatPercent,
        collectedById: userId,
        initialPayment: body.initialPayment,
        lines,
      },
      tx
    );

    const updatedAdmission = await tx.admission.update({
      where: { id: admission.id },
      data: {
        status: body.leftAgainstAdvice ? "LEFT_AGAINST_ADVICE" : "DISCHARGED",
        dischargedAt: now,
        invoiceId: invoice.id,
      },
    });

    const summary = await tx.dischargeSummary.upsert({
      where: { admissionId: admission.id },
      create: {
        admissionId: admission.id,
        dischargingDoctorId: body.dischargingDoctorId,
        finalDiagnosis: body.finalDiagnosis ?? null,
        treatmentSummary: body.treatmentSummary ?? null,
        dischargeAdvice: body.dischargeAdvice ?? null,
        followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
      },
      update: {
        dischargingDoctorId: body.dischargingDoctorId,
        finalDiagnosis: body.finalDiagnosis ?? null,
        treatmentSummary: body.treatmentSummary ?? null,
        dischargeAdvice: body.dischargeAdvice ?? null,
        followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
      },
    });

    return { admission: updatedAdmission, invoice, summary };
  });

  ok(res, result, "Patient discharged");
};

/**
 * Update / save a draft discharge summary without actually discharging.
 * Lets the doctor compose the summary across multiple sessions before
 * pressing the final Discharge button.
 */
export const saveSummary = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const admissionId = String(req.params.id);
  const body = req.body as {
    dischargingDoctorId: string;
    finalDiagnosis?: string;
    treatmentSummary?: string;
    dischargeAdvice?: string;
    followUpDate?: string;
  };

  const a = await prisma.admission.findFirst({ where: { id: admissionId, tenantId } });
  if (!a) throw ApiError.notFound("Admission not found");
  const doctor = await prisma.user.findFirst({
    where: { id: body.dischargingDoctorId, tenantId, role: "DOCTOR" },
  });
  if (!doctor) throw ApiError.notFound("Doctor not found");

  const s = await prisma.dischargeSummary.upsert({
    where: { admissionId },
    create: {
      admissionId,
      dischargingDoctorId: body.dischargingDoctorId,
      finalDiagnosis: body.finalDiagnosis ?? null,
      treatmentSummary: body.treatmentSummary ?? null,
      dischargeAdvice: body.dischargeAdvice ?? null,
      followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
    },
    update: {
      dischargingDoctorId: body.dischargingDoctorId,
      finalDiagnosis: body.finalDiagnosis ?? null,
      treatmentSummary: body.treatmentSummary ?? null,
      dischargeAdvice: body.dischargeAdvice ?? null,
      followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
    },
  });
  ok(res, s, "Discharge summary saved");
};

