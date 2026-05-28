import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const D = (n: number | string) => new Prisma.Decimal(n);

// BD national EPI schedule. Seeded on demand via POST /vaccines/seed-epi.
// Source: DGHS EPI program. Fees default to 0 (govt-supplied) — clinics
// can override per vaccine.
const BD_EPI_SEED = [
  { code: "EPI-BCG",       name: "BCG",                          nameBn: "বিসিজি",      doseNumber: 1, totalDoses: 1, recommendedAgeText: "At birth",      nextDoseDays: null },
  { code: "EPI-PENTA-1",   name: "Pentavalent 1 (DPT-HepB-Hib)", nameBn: "পেন্টা ১",     doseNumber: 1, totalDoses: 3, recommendedAgeText: "6 weeks",       nextDoseDays: 28 },
  { code: "EPI-PENTA-2",   name: "Pentavalent 2 (DPT-HepB-Hib)", nameBn: "পেন্টা ২",     doseNumber: 2, totalDoses: 3, recommendedAgeText: "10 weeks",      nextDoseDays: 28 },
  { code: "EPI-PENTA-3",   name: "Pentavalent 3 (DPT-HepB-Hib)", nameBn: "পেন্টা ৩",     doseNumber: 3, totalDoses: 3, recommendedAgeText: "14 weeks",      nextDoseDays: null },
  { code: "EPI-OPV-0",     name: "OPV 0",                        nameBn: "ওপিভি ০",     doseNumber: 0, totalDoses: 4, recommendedAgeText: "At birth",      nextDoseDays: 42 },
  { code: "EPI-OPV-1",     name: "OPV 1",                        nameBn: "ওপিভি ১",     doseNumber: 1, totalDoses: 4, recommendedAgeText: "6 weeks",       nextDoseDays: 28 },
  { code: "EPI-OPV-2",     name: "OPV 2",                        nameBn: "ওপিভি ২",     doseNumber: 2, totalDoses: 4, recommendedAgeText: "10 weeks",      nextDoseDays: 28 },
  { code: "EPI-OPV-3",     name: "OPV 3",                        nameBn: "ওপিভি ৩",     doseNumber: 3, totalDoses: 4, recommendedAgeText: "14 weeks",      nextDoseDays: null },
  { code: "EPI-IPV",       name: "IPV (Inactivated Polio)",      nameBn: "আইপিভি",      doseNumber: 1, totalDoses: 1, recommendedAgeText: "14 weeks",      nextDoseDays: null },
  { code: "EPI-PCV-1",     name: "PCV 1",                        nameBn: "পিসিভি ১",     doseNumber: 1, totalDoses: 3, recommendedAgeText: "6 weeks",       nextDoseDays: 28 },
  { code: "EPI-PCV-2",     name: "PCV 2",                        nameBn: "পিসিভি ২",     doseNumber: 2, totalDoses: 3, recommendedAgeText: "10 weeks",      nextDoseDays: 28 },
  { code: "EPI-PCV-3",     name: "PCV 3",                        nameBn: "পিসিভি ৩",     doseNumber: 3, totalDoses: 3, recommendedAgeText: "14 weeks",      nextDoseDays: null },
  { code: "EPI-MR-1",      name: "MR 1 (Measles-Rubella)",       nameBn: "এমআর ১",       doseNumber: 1, totalDoses: 2, recommendedAgeText: "9 months",      nextDoseDays: 90 },
  { code: "EPI-MR-2",      name: "MR 2 (Measles-Rubella)",       nameBn: "এমআর ২",       doseNumber: 2, totalDoses: 2, recommendedAgeText: "15 months",     nextDoseDays: null },
  { code: "EPI-TT-1",      name: "Tetanus Toxoid 1 (women)",     nameBn: "টিটি ১",       doseNumber: 1, totalDoses: 5, recommendedAgeText: "ANC visit",     nextDoseDays: 28 },
  { code: "EPI-TT-2",      name: "Tetanus Toxoid 2",             nameBn: "টিটি ২",       doseNumber: 2, totalDoses: 5, recommendedAgeText: "TT1 + 4 weeks",  nextDoseDays: 180 },
];

// ── Catalog ─────────────────────────────────────────────────────

export const listVaccines = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const isEpi = req.query.isEpi as string | undefined;
  const rows = await prisma.vaccine.findMany({
    where: { tenantId, ...(isEpi ? { isEpi: isEpi === "true" } : {}) },
    orderBy: [{ isEpi: "desc" }, { recommendedAgeText: "asc" }, { name: "asc" }],
  });
  ok(res, rows);
};

export const createVaccine = async (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  try {
    const v = await prisma.vaccine.create({
      data: {
        tenantId: req.auth!.tenantId,
        code: b.code as string,
        name: b.name as string,
        nameBn: (b.nameBn as string) || null,
        description: (b.description as string) || null,
        doseNumber: (b.doseNumber as number) ?? 1,
        totalDoses: (b.totalDoses as number) ?? 1,
        recommendedAgeText: (b.recommendedAgeText as string) || null,
        nextDoseDays: (b.nextDoseDays as number) ?? null,
        manufacturer: (b.manufacturer as string) || null,
        defaultFee: D((b.defaultFee as number) ?? 0),
        isEpi: (b.isEpi as boolean) ?? false,
        isActive: (b.isActive as boolean) ?? true,
      },
    });
    created(res, v, "Vaccine added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("A vaccine with that code already exists");
    }
    throw err;
  }
};

export const updateVaccine = async (req: Request, res: Response) => {
  const v = await prisma.vaccine.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!v) throw ApiError.notFound("Vaccine not found");
  const b = req.body as Record<string, unknown>;
  const data: Prisma.VaccineUpdateInput = {};
  for (const k of ["code", "name", "nameBn", "description", "recommendedAgeText", "manufacturer"] as const) {
    if (b[k] !== undefined) (data as Record<string, unknown>)[k] = b[k] || null;
  }
  if (b.doseNumber !== undefined) data.doseNumber = b.doseNumber as number;
  if (b.totalDoses !== undefined) data.totalDoses = b.totalDoses as number;
  if (b.nextDoseDays !== undefined) data.nextDoseDays = (b.nextDoseDays as number) ?? null;
  if (b.defaultFee !== undefined) data.defaultFee = D(b.defaultFee as number);
  if (b.isEpi !== undefined) data.isEpi = b.isEpi as boolean;
  if (b.isActive !== undefined) data.isActive = b.isActive as boolean;
  const updated = await prisma.vaccine.update({ where: { id: v.id }, data });
  ok(res, updated, "Vaccine updated");
};

/**
 * Idempotent seed of the BD EPI vaccine catalog for the current tenant.
 * Already-existing codes (per tenant) are skipped — safe to re-run.
 */
export const seedEpi = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  let inserted = 0;
  let skipped = 0;
  for (const v of BD_EPI_SEED) {
    const exists = await prisma.vaccine.findUnique({
      where: { tenantId_code: { tenantId, code: v.code } },
    });
    if (exists) { skipped++; continue; }
    await prisma.vaccine.create({
      data: {
        tenantId,
        code: v.code,
        name: v.name,
        nameBn: v.nameBn,
        doseNumber: v.doseNumber,
        totalDoses: v.totalDoses,
        recommendedAgeText: v.recommendedAgeText,
        nextDoseDays: v.nextDoseDays,
        isEpi: true,
      },
    });
    inserted++;
  }
  ok(res, { inserted, skipped }, "EPI catalog seeded");
};

// ── Patient vaccinations ────────────────────────────────────────

export const listForPatient = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.patientVaccination.findMany({
    where: { tenantId, patientId: String(req.params.patientId) },
    orderBy: { givenAt: "desc" },
    include: { vaccine: true, patient: { select: { id: true, name: true, patientCode: true } } },
  });
  ok(res, rows);
};

export const recordVaccination = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const givenById = req.auth!.sub;
  const b = req.body as {
    patientId: string;
    vaccineId: string;
    givenAt?: string;
    batchNumber?: string;
    nextDueAt?: string;
    notes?: string;
  };
  const v = await prisma.vaccine.findFirst({
    where: { id: b.vaccineId, tenantId, isActive: true },
  });
  if (!v) throw ApiError.notFound("Vaccine not found");
  const patient = await prisma.patient.findFirst({
    where: { id: b.patientId, tenantId, deletedAt: null },
  });
  if (!patient) throw ApiError.notFound("Patient not found");

  const givenAt = b.givenAt ? new Date(b.givenAt) : new Date();
  const nextDueAt = b.nextDueAt
    ? new Date(b.nextDueAt)
    : v.nextDoseDays != null
      ? dayjs(givenAt).add(v.nextDoseDays, "day").toDate()
      : null;

  const row = await prisma.patientVaccination.create({
    data: {
      tenantId,
      patientId: b.patientId,
      vaccineId: b.vaccineId,
      givenAt,
      batchNumber: b.batchNumber ?? null,
      givenById,
      nextDueAt,
      notes: b.notes ?? null,
    },
    include: { vaccine: true },
  });
  created(res, row, "Vaccination recorded");
};

/**
 * Upcoming + overdue doses across all patients. Used by the EPI follow-up
 * desk + the SMS reminder job (later).
 */
export const dueList = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const horizonDays = Number(req.query.horizonDays ?? 30);
  const now = dayjs();
  const cutoff = now.add(horizonDays, "day").toDate();

  const where: Prisma.PatientVaccinationWhereInput = {
    tenantId,
    nextDueAt: { not: null, lte: cutoff },
  };
  const [rows, total] = await Promise.all([
    prisma.patientVaccination.findMany({
      where,
      orderBy: { nextDueAt: "asc" },
      skip,
      take,
      include: {
        vaccine: { select: { id: true, code: true, name: true, doseNumber: true, totalDoses: true } },
        patient: { select: { id: true, name: true, patientCode: true, phone: true } },
      },
    }),
    prisma.patientVaccination.count({ where }),
  ]);
  ok(res, rows.map((r) => ({
    ...r,
    overdueDays: r.nextDueAt ? Math.max(0, Math.floor((Date.now() - new Date(r.nextDueAt).getTime()) / (24 * 3600 * 1000))) : 0,
  })), "OK", paginate(page, pageSize, total));
};

