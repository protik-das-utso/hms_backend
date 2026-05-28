import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

const D = (n: number | string) => new Prisma.Decimal(n);
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"] as const;

export const listTerms = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  // Show all staff, even those without terms set yet — that's the most useful view for HR.
  const users = await prisma.user.findMany({
    where: { tenantId, deletedAt: null, role: { not: "PATIENT" } },
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      designation: true,
      branchId: true,
      branch: { select: { name: true } },
      employmentTerms: true,
    },
  });

  ok(res, users.map((u) => {
    const t = u.employmentTerms;
    const gross = t
      ? num(t.basicSalary) + num(t.houseAllowance) + num(t.medicalAllowance) + num(t.transportAllowance) + num(t.otherAllowances)
      : 0;
    const tax = t ? (gross * num(t.taxDeductionPercent)) / 100 : 0;
    const pf = t ? (num(t.basicSalary) * num(t.pfEmployeePercent)) / 100 : 0;
    return {
      user: { id: u.id, name: u.name, phone: u.phone, role: u.role, designation: u.designation, branch: u.branch?.name ?? null },
      terms: t,
      estimatedGross: gross,
      estimatedNet: t ? Math.max(0, gross - tax - pf) : 0,
    };
  }));
};

export const getTerms = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const userId = String(req.params.userId);
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, deletedAt: null },
    select: { id: true, name: true, role: true, designation: true, employmentTerms: true },
  });
  if (!user) throw ApiError.notFound("Staff not found");
  ok(res, user);
};

export const upsertTerms = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const userId = String(req.params.userId);
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, deletedAt: null },
  });
  if (!user) throw ApiError.notFound("Staff not found");

  const b = req.body as {
    employmentType?: typeof EMPLOYMENT_TYPES[number];
    designation?: string;
    joinedAt?: string;
    basicSalary?: number;
    houseAllowance?: number;
    medicalAllowance?: number;
    transportAllowance?: number;
    otherAllowances?: number;
    taxDeductionPercent?: number;
    pfEmployeePercent?: number;
    pfEmployerPercent?: number;
    notes?: string;
  };

  const baseData = {
    employmentType: (b.employmentType ?? "FULL_TIME") as typeof EMPLOYMENT_TYPES[number],
    designation: b.designation ?? null,
    joinedAt: b.joinedAt ? dayjs(b.joinedAt).startOf("day").toDate() : null,
    basicSalary: D(b.basicSalary ?? 0),
    houseAllowance: D(b.houseAllowance ?? 0),
    medicalAllowance: D(b.medicalAllowance ?? 0),
    transportAllowance: D(b.transportAllowance ?? 0),
    otherAllowances: D(b.otherAllowances ?? 0),
    taxDeductionPercent: D(b.taxDeductionPercent ?? 0),
    pfEmployeePercent: D(b.pfEmployeePercent ?? 0),
    pfEmployerPercent: D(b.pfEmployerPercent ?? 0),
    notes: b.notes ?? null,
  };

  // Compute cached estimated net for the listing.
  const gross =
    Number(baseData.basicSalary) +
    Number(baseData.houseAllowance) +
    Number(baseData.medicalAllowance) +
    Number(baseData.transportAllowance) +
    Number(baseData.otherAllowances);
  const tax = (gross * Number(baseData.taxDeductionPercent)) / 100;
  const pf = (Number(baseData.basicSalary) * Number(baseData.pfEmployeePercent)) / 100;
  const estimatedNet = D(Math.max(0, gross - tax - pf));

  const terms = await prisma.employmentTerms.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...baseData, estimatedNet },
    update: { ...baseData, estimatedNet },
  });
  ok(res, terms, "Employment terms saved");
};

