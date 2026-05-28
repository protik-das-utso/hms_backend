import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const activeOnly = req.query.activeOnly === "true";

  const where: Prisma.MedicineWhereInput = {
    tenantId,
    deletedAt: null,
    ...(activeOnly ? { isActive: true } : {}),
    ...(q
      ? {
          OR: [
            { brandName: { contains: q, mode: "insensitive" } },
            { genericName: { contains: q, mode: "insensitive" } },
            { manufacturer: { contains: q, mode: "insensitive" } },
            { dgdaCode: { contains: q, mode: "insensitive" } },
            { barcode: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.medicine.findMany({
      where,
      orderBy: { brandName: "asc" },
      skip,
      take,
    }),
    prisma.medicine.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const m = await prisma.medicine.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!m) throw ApiError.notFound("Medicine not found");
  ok(res, m);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as {
    brandName: string;
    genericName?: string;
    strength?: string;
    form?: string;
    manufacturer?: string;
    dgdaCode?: string;
    barcode?: string;
    salePrice: number;
    unitsPerBox?: number;
    boxPrice?: number | null;
    reorderLevel?: number;
    taxRate?: number;
    isActive?: boolean;
  };
  try {
    const m = await prisma.medicine.create({
      data: {
        tenantId: req.auth!.tenantId,
        brandName: body.brandName,
        genericName: body.genericName ?? null,
        strength: body.strength ?? null,
        form: body.form ?? null,
        manufacturer: body.manufacturer ?? null,
        dgdaCode: body.dgdaCode ?? null,
        barcode: body.barcode ?? null,
        salePrice: new Prisma.Decimal(body.salePrice),
        unitsPerBox: body.unitsPerBox && body.unitsPerBox > 0 ? body.unitsPerBox : 1,
        boxPrice: body.boxPrice != null ? new Prisma.Decimal(body.boxPrice) : null,
        reorderLevel: body.reorderLevel ?? 10,
        taxRate: new Prisma.Decimal(body.taxRate ?? 0),
        isActive: body.isActive ?? true,
      },
    });
    created(res, m, "Medicine added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("A medicine with that barcode already exists");
    }
    throw err;
  }
};

export const update = async (req: Request, res: Response) => {
  const m = await prisma.medicine.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!m) throw ApiError.notFound("Medicine not found");

  const body = req.body as Record<string, unknown>;
  try {
    const updated = await prisma.medicine.update({
      where: { id: m.id },
      data: {
        brandName: (body.brandName as string) ?? undefined,
        genericName: body.genericName !== undefined ? ((body.genericName as string) || null) : undefined,
        strength: body.strength !== undefined ? ((body.strength as string) || null) : undefined,
        form: body.form !== undefined ? ((body.form as string) || null) : undefined,
        manufacturer: body.manufacturer !== undefined ? ((body.manufacturer as string) || null) : undefined,
        dgdaCode: body.dgdaCode !== undefined ? ((body.dgdaCode as string) || null) : undefined,
        barcode: body.barcode !== undefined ? ((body.barcode as string) || null) : undefined,
        salePrice:
          body.salePrice !== undefined ? new Prisma.Decimal(body.salePrice as number) : undefined,
        unitsPerBox:
          body.unitsPerBox !== undefined && (body.unitsPerBox as number) > 0
            ? (body.unitsPerBox as number)
            : undefined,
        boxPrice:
          body.boxPrice !== undefined
            ? body.boxPrice == null
              ? null
              : new Prisma.Decimal(body.boxPrice as number)
            : undefined,
        reorderLevel: body.reorderLevel !== undefined ? (body.reorderLevel as number) : undefined,
        taxRate:
          body.taxRate !== undefined ? new Prisma.Decimal(body.taxRate as number) : undefined,
        isActive: (body.isActive as boolean) ?? undefined,
      },
    });
    ok(res, updated, "Medicine updated");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("A medicine with that barcode already exists");
    }
    throw err;
  }
};

/**
 * Barcode lookup — used by the pharmacy POS scanner. Strict exact match on
 * (tenantId, barcode) of a live medicine. Returns 404 (not an error) when the
 * scanned code doesn't resolve, so the POS can surface a friendly "unknown
 * barcode" toast without treating it as a crash.
 */
export const byBarcode = async (req: Request, res: Response) => {
  const code = ((req.query.code as string | undefined) ?? "").trim();
  if (!code) throw ApiError.badRequest("code is required");
  const m = await prisma.medicine.findFirst({
    where: {
      tenantId: req.auth!.tenantId,
      deletedAt: null,
      isActive: true,
      barcode: code,
    },
  });
  if (!m) throw ApiError.notFound("No medicine with that barcode");
  ok(res, m);
};

export const softDelete = async (req: Request, res: Response) => {
  const m = await prisma.medicine.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!m) throw ApiError.notFound("Medicine not found");
  await prisma.medicine.update({
    where: { id: m.id },
    data: { deletedAt: new Date(), isActive: false },
  });
  ok(res, { ok: true }, "Medicine archived");
};

