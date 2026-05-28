import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";

const D = (n: number | string) => new Prisma.Decimal(n);

export const listPublic = async (_req: Request, res: Response) => {
  // Public pricing-page feed: active + isPublic. No auth needed.
  const plans = await prisma.subscriptionPlanConfig.findMany({
    where: { isActive: true, isPublic: true },
    orderBy: { sortOrder: "asc" },
  });
  ok(res, plans);
};

export const listAll = async (_req: Request, res: Response) => {
  const plans = await prisma.subscriptionPlanConfig.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }],
  });
  ok(res, plans);
};

export const getOne = async (req: Request, res: Response) => {
  const p = await prisma.subscriptionPlanConfig.findUnique({ where: { id: String(req.params.id) } });
  if (!p) throw ApiError.notFound("Plan not found");
  ok(res, p);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as Record<string, any>;
  const code = String(body.code).trim().toUpperCase();
  const existing = await prisma.subscriptionPlanConfig.findUnique({ where: { code } });
  if (existing) throw ApiError.conflict("A plan with this code already exists");

  const p = await prisma.subscriptionPlanConfig.create({
    data: {
      code,
      name: String(body.name).trim(),
      description: body.description || null,
      monthlyPrice: D(body.monthlyPrice ?? 0),
      yearlyPrice: D(body.yearlyPrice ?? Number(body.monthlyPrice ?? 0) * 10),
      maxBranches: Number(body.maxBranches ?? 1),
      maxUsers: Number(body.maxUsers ?? 10),
      maxPatientsMonth: Number(body.maxPatientsMonth ?? 500),
      maxStorageGb: Number(body.maxStorageGb ?? 5),
      features: body.features ?? null,
      sortOrder: Number(body.sortOrder ?? 0),
      isPublic: body.isPublic ?? true,
      isActive: body.isActive ?? true,
      highlightTag: body.highlightTag || null,
    },
  });
  created(res, p, "Plan created");
};

export const update = async (req: Request, res: Response) => {
  const p = await prisma.subscriptionPlanConfig.findUnique({ where: { id: String(req.params.id) } });
  if (!p) throw ApiError.notFound("Plan not found");
  const body = req.body as Record<string, any>;

  // Code is immutable after creation — too many things reference it (Subscription.plan enum, invoice snapshots).
  const updated = await prisma.subscriptionPlanConfig.update({
    where: { id: p.id },
    data: {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      description: body.description !== undefined ? (body.description || null) : undefined,
      monthlyPrice: body.monthlyPrice !== undefined ? D(body.monthlyPrice) : undefined,
      yearlyPrice: body.yearlyPrice !== undefined ? D(body.yearlyPrice) : undefined,
      maxBranches: body.maxBranches !== undefined ? Number(body.maxBranches) : undefined,
      maxUsers: body.maxUsers !== undefined ? Number(body.maxUsers) : undefined,
      maxPatientsMonth: body.maxPatientsMonth !== undefined ? Number(body.maxPatientsMonth) : undefined,
      maxStorageGb: body.maxStorageGb !== undefined ? Number(body.maxStorageGb) : undefined,
      features: body.features !== undefined ? body.features : undefined,
      sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
      isPublic: body.isPublic ?? undefined,
      isActive: body.isActive ?? undefined,
      highlightTag: body.highlightTag !== undefined ? (body.highlightTag || null) : undefined,
    },
  });
  ok(res, updated, "Plan updated");
};

export const remove = async (req: Request, res: Response) => {
  const p = await prisma.subscriptionPlanConfig.findUnique({ where: { id: String(req.params.id) } });
  if (!p) throw ApiError.notFound("Plan not found");

  const subs = await prisma.subscription.count({ where: { planConfigId: p.id } });
  if (subs > 0) {
    // Don't delete — would break invoice history. Soft-disable instead.
    await prisma.subscriptionPlanConfig.update({
      where: { id: p.id },
      data: { isActive: false, isPublic: false },
    });
    return ok(res, { ok: true }, `Plan deactivated (${subs} subscription${subs === 1 ? "" : "s"} still reference it)`);
  }
  await prisma.subscriptionPlanConfig.delete({ where: { id: p.id } });
  ok(res, { ok: true }, "Plan deleted");
};

