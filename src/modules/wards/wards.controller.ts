import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const branchId = req.query.branchId as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();
  const includeBeds = req.query.includeBeds === "true";

  const where: Prisma.WardWhereInput = {
    tenantId,
    deletedAt: null,
    ...(branchId ? { branchId } : {}),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.ward.findMany({
      where,
      orderBy: [{ branchId: "asc" }, { floor: "asc" }, { name: "asc" }],
      skip,
      take,
      include: {
        branch: { select: { id: true, name: true } },
        beds: includeBeds
          ? {
              where: { deletedAt: null },
              orderBy: { code: "asc" },
              include: {
                allocations: {
                  where: { toTs: null },
                  include: {
                    admission: {
                      include: { patient: { select: { id: true, name: true, patientCode: true } } },
                    },
                  },
                },
              },
            }
          : false,
        _count: { select: { beds: { where: { deletedAt: null } } } },
      },
    }),
    prisma.ward.count({ where }),
  ]);

  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const w = await prisma.ward.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    include: { branch: true, beds: { where: { deletedAt: null }, orderBy: { code: "asc" } } },
  });
  if (!w) throw ApiError.notFound("Ward not found");
  ok(res, w);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as { branchId: string; name: string; floor?: string; type?: string; notes?: string; isActive?: boolean };
  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, tenantId: req.auth!.tenantId } });
  if (!branch) throw ApiError.notFound("Branch not found");
  const w = await prisma.ward.create({
    data: {
      tenantId: req.auth!.tenantId,
      branchId: body.branchId,
      name: body.name,
      floor: body.floor ?? null,
      type: (body.type as Prisma.WardCreateInput["type"]) ?? "GENERAL",
      notes: body.notes ?? null,
      isActive: body.isActive ?? true,
    },
  });
  created(res, w, "Ward added");
};

export const update = async (req: Request, res: Response) => {
  const w = await prisma.ward.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!w) throw ApiError.notFound("Ward not found");
  const body = req.body as Record<string, unknown>;
  const updated = await prisma.ward.update({
    where: { id: w.id },
    data: {
      name: (body.name as string) ?? undefined,
      floor: body.floor !== undefined ? ((body.floor as string) || null) : undefined,
      type: body.type !== undefined ? (body.type as Prisma.WardUpdateInput["type"]) : undefined,
      notes: body.notes !== undefined ? ((body.notes as string) || null) : undefined,
      isActive: (body.isActive as boolean) ?? undefined,
    },
  });
  ok(res, updated, "Ward updated");
};

export const remove = async (req: Request, res: Response) => {
  const w = await prisma.ward.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    include: { beds: { where: { deletedAt: null, status: "OCCUPIED" as any } } },
  }) as any;
  if (!w) throw ApiError.notFound("Ward not found");
  if (w.beds.length > 0) throw ApiError.conflict("Cannot archive a ward that still has occupied beds");
  await prisma.ward.update({ where: { id: w.id }, data: { deletedAt: new Date(), isActive: false } });
  ok(res, { ok: true }, "Ward archived");
};

