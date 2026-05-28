import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

// ── Categories ─────────────────────────────────────────────────

export const listCategories = async (req: Request, res: Response) => {
  const rows = await prisma.testCategory.findMany({
    where: { tenantId: req.auth!.tenantId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }],
    include: { _count: { select: { tests: true } } },
  });
  ok(res, rows);
};

export const createCategory = async (req: Request, res: Response) => {
  const body = req.body as { nameEn: string; nameBn?: string; icon?: string; sortOrder?: number };
  const row = await prisma.testCategory.create({
    data: {
      tenantId: req.auth!.tenantId,
      nameEn: body.nameEn,
      nameBn: body.nameBn,
      icon: body.icon,
      sortOrder: body.sortOrder ?? 0,
    },
  });
  created(res, row, "Category created");
};

export const updateCategory = async (req: Request, res: Response) => {
  const cat = await prisma.testCategory.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!cat) throw ApiError.notFound("Category not found");
  const row = await prisma.testCategory.update({ where: { id: cat.id }, data: req.body });
  ok(res, row, "Category updated");
};

export const deleteCategory = async (req: Request, res: Response) => {
  const cat = await prisma.testCategory.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!cat) throw ApiError.notFound("Category not found");
  await prisma.testCategory.update({
    where: { id: cat.id },
    data: { isActive: false },
  });
  ok(res, { ok: true }, "Category deactivated");
};

// ── Tests ──────────────────────────────────────────────────────

export const listTests = async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const categoryId = req.query.categoryId as string | undefined;
  const active = req.query.active !== "false";

  const where = {
    tenantId: req.auth!.tenantId,
    ...(active ? { isActive: true } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(q
      ? {
          OR: [
            { nameEn: { contains: q, mode: "insensitive" as const } },
            { nameBn: { contains: q } },
            { code: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.test.findMany({
      where,
      orderBy: [{ category: { sortOrder: "asc" } }, { nameEn: "asc" }],
      skip,
      take,
      include: { category: { select: { id: true, nameEn: true, nameBn: true } } },
    }),
    prisma.test.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getTest = async (req: Request, res: Response) => {
  const row = await prisma.test.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: { category: true },
  });
  if (!row) throw ApiError.notFound("Test not found");
  ok(res, row);
};

export const createTest = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const test = await prisma.test.create({
    data: {
      tenantId: req.auth!.tenantId,
      categoryId: body.categoryId as string,
      code: body.code as string,
      nameEn: body.nameEn as string,
      nameBn: (body.nameBn as string) ?? null,
      sampleType: (body.sampleType as string) ?? null,
      basePrice: body.basePrice as number,
      turnaroundHours: (body.turnaroundHours as number) ?? 24,
      instructions: (body.instructions as string) ?? null,
      resultSchema: body.resultSchema as object | undefined,
    },
  });
  created(res, test, "Test created");
};

export const updateTest = async (req: Request, res: Response) => {
  const test = await prisma.test.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!test) throw ApiError.notFound("Test not found");
  const body = req.body as Record<string, unknown>;

  // Whitelist updatable fields — keeps tenantId / id / timestamps safe.
  const data: Record<string, unknown> = {};
  for (const k of [
    "categoryId", "code", "nameEn", "nameBn", "sampleType",
    "basePrice", "turnaroundHours", "instructions", "isActive", "resultSchema",
  ]) {
    if (body[k] !== undefined) data[k] = body[k];
  }
  const row = await prisma.test.update({ where: { id: test.id }, data });
  ok(res, row, "Test updated");
};

export const deleteTest = async (req: Request, res: Response) => {
  const test = await prisma.test.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!test) throw ApiError.notFound("Test not found");
  await prisma.test.update({ where: { id: test.id }, data: { isActive: false } });
  ok(res, { ok: true }, "Test deactivated");
};

