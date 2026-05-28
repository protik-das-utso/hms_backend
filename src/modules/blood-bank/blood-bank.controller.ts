import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const GROUPS = ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"] as const;
type Group = typeof GROUPS[number];

// ── Donors ──────────────────────────────────────────────────────

export const listDonors = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const bloodGroup = req.query.bloodGroup as string | undefined;

  const where: Prisma.BloodDonorWhereInput = {
    tenantId,
    deletedAt: null,
    ...(bloodGroup ? { bloodGroup: bloodGroup as Group } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { nid: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.bloodDonor.findMany({ where, orderBy: { name: "asc" }, skip, take }),
    prisma.bloodDonor.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const createDonor = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const d = await prisma.bloodDonor.create({
    data: {
      tenantId: req.auth!.tenantId,
      name: body.name as string,
      phone: body.phone as string,
      email: (body.email as string) || null,
      nid: (body.nid as string) || null,
      bloodGroup: body.bloodGroup as Group,
      dob: body.dob ? dayjs(body.dob as string).startOf("day").toDate() : null,
      gender: (body.gender as Prisma.BloodDonorCreateInput["gender"]) ?? null,
      address: (body.address as string) || null,
      occupation: (body.occupation as string) || null,
      optInContact: body.optInContact === undefined ? true : (body.optInContact as boolean),
      notes: (body.notes as string) || null,
    },
  });
  created(res, d, "Donor added");
};

export const updateDonor = async (req: Request, res: Response) => {
  const d = await prisma.bloodDonor.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!d) throw ApiError.notFound("Donor not found");
  const body = req.body as Record<string, unknown>;
  const data: Prisma.BloodDonorUpdateInput = {};
  for (const k of ["name", "phone", "email", "nid", "address", "occupation", "notes"] as const) {
    if (body[k] !== undefined) (data as Record<string, unknown>)[k] = body[k] || null;
  }
  if (body.bloodGroup !== undefined) data.bloodGroup = body.bloodGroup as Group;
  if (body.gender !== undefined) data.gender = (body.gender as Prisma.BloodDonorUpdateInput["gender"]) ?? null;
  if (body.dob !== undefined) data.dob = body.dob ? dayjs(body.dob as string).startOf("day").toDate() : null;
  if (body.optInContact !== undefined) data.optInContact = body.optInContact as boolean;
  const updated = await prisma.bloodDonor.update({ where: { id: d.id }, data });
  ok(res, updated, "Donor updated");
};

export const archiveDonor = async (req: Request, res: Response) => {
  const d = await prisma.bloodDonor.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!d) throw ApiError.notFound("Donor not found");
  await prisma.bloodDonor.update({ where: { id: d.id }, data: { deletedAt: new Date() } });
  ok(res, { ok: true }, "Donor archived");
};

// ── Bags / Inventory ────────────────────────────────────────────

export const listBags = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const bloodGroup = req.query.bloodGroup as string | undefined;
  const status = req.query.status as string | undefined;
  const component = req.query.component as string | undefined;

  const where: Prisma.BloodBagWhereInput = {
    tenantId,
    ...(bloodGroup ? { bloodGroup: bloodGroup as Group } : {}),
    ...(status ? { status: status as Prisma.BloodBagWhereInput["status"] } : {}),
    ...(component ? { component: component as Prisma.BloodBagWhereInput["component"] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.bloodBag.findMany({
      where,
      orderBy: [{ expiryDate: "asc" }, { createdAt: "desc" }],
      skip,
      take,
      include: {
        donor: { select: { id: true, name: true, phone: true } },
        screening: true,
        issue: { include: { patient: { select: { id: true, name: true, patientCode: true } } } },
      },
    }),
    prisma.bloodBag.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

/**
 * Inventory summary by group + component. Cheap counts for the dashboard.
 */
export const inventorySummary = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.bloodBag.groupBy({
    by: ["bloodGroup", "component", "status"],
    where: { tenantId, status: { in: ["QUARANTINE", "AVAILABLE", "RESERVED"] } },
    _count: { _all: true },
  });
  ok(res, rows.map((r) => ({
    bloodGroup: r.bloodGroup,
    component: r.component,
    status: r.status,
    count: r._count._all,
  })));
};

/**
 * Receive a fresh bag from a donor. Lands in QUARANTINE; a screening row
 * is created in PENDING state alongside. Donor stats are bumped.
 */
export const receiveBag = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const body = req.body as {
    donorId?: string;
    bagNumber: string;
    bloodGroup: Group;
    component?: "WHOLE_BLOOD" | "PRBC" | "FFP" | "PLATELET" | "CRYOPRECIPITATE";
    volumeMl?: number;
    collectedOn: string;
    expiryDays?: number; // defaults: PRBC 42d, FFP 365d, PLATELET 5d, WHOLE 35d
    storageLocation?: string;
    notes?: string;
  };

  const component = body.component ?? "WHOLE_BLOOD";
  const collectedOn = dayjs(body.collectedOn).startOf("day");
  const defaultExpiryDays =
    component === "FFP" ? 365 :
    component === "PRBC" ? 42 :
    component === "PLATELET" ? 5 :
    component === "CRYOPRECIPITATE" ? 365 :
    35;
  const expiryDate = collectedOn.add(body.expiryDays ?? defaultExpiryDays, "day").toDate();

  const result = await prisma.$transaction(async (tx) => {
    if (body.donorId) {
      const d = await tx.bloodDonor.findFirst({
        where: { id: body.donorId, tenantId, deletedAt: null },
      });
      if (!d) throw ApiError.notFound("Donor not found");
      if (d.bloodGroup !== body.bloodGroup) {
        throw ApiError.badRequest(`Donor's blood group is ${d.bloodGroup}, not ${body.bloodGroup}`);
      }
      await tx.bloodDonor.update({
        where: { id: d.id },
        data: {
          totalDonations: { increment: 1 },
          lastDonatedAt: collectedOn.toDate(),
        },
      });
    }

    try {
      const bag = await tx.bloodBag.create({
        data: {
          tenantId,
          donorId: body.donorId ?? null,
          bagNumber: body.bagNumber,
          bloodGroup: body.bloodGroup,
          component,
          volumeMl: body.volumeMl ?? 450,
          collectedOn: collectedOn.toDate(),
          expiryDate,
          status: "QUARANTINE",
          storageLocation: body.storageLocation ?? null,
          notes: body.notes ?? null,
          screening: { create: {} },
        },
        include: { screening: true, donor: { select: { id: true, name: true } } },
      });
      return bag;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw ApiError.conflict("Bag number already exists");
      }
      throw err;
    }
  });

  created(res, result, "Bag received in quarantine");
};

/**
 * Update screening results. When all five tests are NEGATIVE the bag is
 * auto-promoted to AVAILABLE. If any test is POSITIVE the bag is auto
 * DISCARDED — the original positive result is retained for audit.
 */
export const updateScreening = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const testedById = req.auth!.sub;
  const bagId = String(req.params.id);
  const body = req.body as {
    hbsAg?: "PENDING" | "NEGATIVE" | "POSITIVE";
    hiv?: "PENDING" | "NEGATIVE" | "POSITIVE";
    hcv?: "PENDING" | "NEGATIVE" | "POSITIVE";
    vdrl?: "PENDING" | "NEGATIVE" | "POSITIVE";
    malaria?: "PENDING" | "NEGATIVE" | "POSITIVE";
    notes?: string;
  };

  const result = await prisma.$transaction(async (tx) => {
    const bag = await tx.bloodBag.findFirst({
      where: { id: bagId, tenantId },
      include: { screening: true },
    });
    if (!bag) throw ApiError.notFound("Bag not found");
    if (bag.status === "ISSUED" || bag.status === "EXPIRED") {
      throw ApiError.badRequest(`Bag is ${bag.status.toLowerCase()}, cannot rescreen`);
    }
    const screening = await tx.bloodScreening.update({
      where: { bagId: bag.id },
      data: {
        hbsAg: body.hbsAg ?? bag.screening?.hbsAg,
        hiv: body.hiv ?? bag.screening?.hiv,
        hcv: body.hcv ?? bag.screening?.hcv,
        vdrl: body.vdrl ?? bag.screening?.vdrl,
        malaria: body.malaria ?? bag.screening?.malaria,
        testedById,
        testedAt: new Date(),
        notes: body.notes ?? bag.screening?.notes ?? null,
      },
    });

    const tests = [screening.hbsAg, screening.hiv, screening.hcv, screening.vdrl, screening.malaria];
    const anyPositive = tests.some((t) => t === "POSITIVE");
    const allNegative = tests.every((t) => t === "NEGATIVE");
    let newStatus: typeof bag.status | undefined;
    if (anyPositive) newStatus = "QUARANTINE";
    else if (allNegative && bag.status === "QUARANTINE") newStatus = "AVAILABLE";

    const updated = newStatus
      ? await tx.bloodBag.update({ where: { id: bag.id }, data: { status: newStatus } })
      : bag;
    return { bag: updated, screening };
  });

  ok(res, result, "Screening updated");
};

/**
 * Issue a bag to a patient — includes a crossmatch result. If admissionId is
 * supplied, an IpdCharge OTHER row is written; otherwise the fee creates a
 * standalone DIAGNOSTIC-style invoice (kept simple — clinics can run a
 * separate cash collection for blood fees).
 */
export const issueBag = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const userId = req.auth!.sub;
  const body = req.body as {
    bagId: string;
    patientId: string;
    admissionId?: string;
    crossmatchResult: string;
    fee?: number;
    notes?: string;
  };

  const result = await prisma.$transaction(async (tx) => {
    const bag = await tx.bloodBag.findFirst({
      where: { id: body.bagId, tenantId },
      include: { issue: true },
    });
    if (!bag) throw ApiError.notFound("Bag not found");
    if (bag.status !== "AVAILABLE" && bag.status !== "RESERVED") {
      throw ApiError.badRequest(`Bag is ${bag.status.toLowerCase()}, cannot issue`);
    }
    if (bag.issue) throw ApiError.conflict("Bag already issued");

    const patient = await tx.patient.findFirst({
      where: { id: body.patientId, tenantId, deletedAt: null },
    });
    if (!patient) throw ApiError.notFound("Patient not found");
    if (body.admissionId) {
      const a = await tx.admission.findFirst({
        where: { id: body.admissionId, tenantId, status: "ADMITTED", patientId: body.patientId },
      });
      if (!a) throw ApiError.badRequest("Active admission not found for this patient");
    }

    const issue = await tx.bloodIssue.create({
      data: {
        tenantId,
        bagId: bag.id,
        patientId: body.patientId,
        admissionId: body.admissionId ?? null,
        crossmatchResult: body.crossmatchResult,
        crossmatchedById: userId,
        crossmatchedAt: new Date(),
        issuedById: userId,
        fee: body.fee != null ? new Prisma.Decimal(body.fee) : null,
        notes: body.notes ?? null,
      },
    });
    await tx.bloodBag.update({ where: { id: bag.id }, data: { status: "ISSUED" } });

    // Bill into admission when present.
    if (body.admissionId && body.fee && body.fee > 0) {
      await tx.ipdCharge.create({
        data: {
          tenantId,
          admissionId: body.admissionId,
          chargeDate: dayjs().startOf("day").toDate(),
          chargeType: "OTHER",
          description: `Blood ${bag.bloodGroup.replace("_", "")} (${bag.component}) — ${bag.bagNumber}`,
          qty: 1,
          unitPrice: new Prisma.Decimal(body.fee),
          amount: new Prisma.Decimal(body.fee),
          refTable: "blood_issues",
          refId: issue.id,
          createdById: userId,
        },
      });
    }
    return issue;
  });

  created(res, result, "Bag issued");
};

/**
 * Search donors by group + opt-in. Used in emergency donor lookup screens.
 */
export const findDonors = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const bloodGroup = req.query.bloodGroup as Group | undefined;
  if (!bloodGroup) throw ApiError.badRequest("bloodGroup is required");
  const recentMonths = Number(req.query.recentMonths ?? 6);
  const since = dayjs().subtract(recentMonths, "month").toDate();
  const rows = await prisma.bloodDonor.findMany({
    where: {
      tenantId,
      deletedAt: null,
      optInContact: true,
      bloodGroup,
      OR: [
        { lastDonatedAt: null },
        { lastDonatedAt: { lte: dayjs().subtract(56, "day").toDate() } }, // 8-week interval guideline
      ],
    },
    orderBy: [{ lastDonatedAt: "asc" }, { totalDonations: "desc" }],
    take: 30,
  });
  ok(res, rows.map((d) => ({
    ...d,
    eligible: !d.lastDonatedAt || d.lastDonatedAt < since,
  })));
};

