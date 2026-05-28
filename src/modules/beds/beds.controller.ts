import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const wardId = req.query.wardId as string | undefined;
  const branchId = req.query.branchId as string | undefined;
  const status = req.query.status as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.BedWhereInput = {
    tenantId,
    deletedAt: null,
    ...(wardId ? { wardId } : {}),
    ...(branchId ? { ward: { branchId } } : {}),
    ...(status ? { status: status as Prisma.BedWhereInput["status"] } : {}),
    ...(q ? { code: { contains: q, mode: "insensitive" } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.bed.findMany({
      where,
      orderBy: [{ wardId: "asc" }, { code: "asc" }],
      skip,
      take,
      include: {
        ward: { select: { id: true, name: true, branchId: true, type: true, branch: { select: { id: true, name: true } } } },
        allocations: {
          where: { toTs: null },
          include: {
            admission: { include: { patient: { select: { id: true, name: true, patientCode: true } } } },
          },
        },
      },
    }),
    prisma.bed.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as { wardId: string; code: string; dailyRate: number; status?: string; notes?: string };
  const ward = await prisma.ward.findFirst({
    where: { id: body.wardId, tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!ward) throw ApiError.notFound("Ward not found");
  try {
    const b = await prisma.bed.create({
      data: {
        tenantId: req.auth!.tenantId,
        wardId: body.wardId,
        code: body.code,
        dailyRate: new Prisma.Decimal(body.dailyRate),
        status: (body.status as Prisma.BedCreateInput["status"]) ?? "AVAILABLE",
        notes: body.notes ?? null,
      },
    });
    created(res, b, "Bed added");
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("Another live bed already uses this code in this ward");
    }
    throw err;
  }
};

export const update = async (req: Request, res: Response) => {
  const b = await prisma.bed.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!b) throw ApiError.notFound("Bed not found");
  const body = req.body as Record<string, unknown>;
  const updated = await prisma.bed.update({
    where: { id: b.id },
    data: {
      code: (body.code as string) ?? undefined,
      dailyRate: body.dailyRate !== undefined ? new Prisma.Decimal(body.dailyRate as number) : undefined,
      notes: body.notes !== undefined ? ((body.notes as string) || null) : undefined,
    },
  });
  ok(res, updated, "Bed updated");
};

/**
 * Manual status set — used to mark CLEANING / OUT_OF_SERVICE / back to
 * AVAILABLE. Won't touch a bed that has an active allocation (those are
 * managed by admissions). Allocating beds happens via the admissions module.
 */
export const setStatus = async (req: Request, res: Response) => {
  const b = await prisma.bed.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    include: { allocations: { where: { toTs: null } } },
  });
  if (!b) throw ApiError.notFound("Bed not found");
  const newStatus = req.body.status as Prisma.BedUpdateInput["status"];
  if (b.allocations.length > 0 && newStatus !== "OCCUPIED") {
    throw ApiError.conflict("Bed is currently allocated to an admission; discharge or transfer first");
  }
  if (newStatus === "OCCUPIED" && b.allocations.length === 0) {
    throw ApiError.badRequest("Use the admissions flow to mark a bed occupied");
  }
  const u = await prisma.bed.update({ where: { id: b.id }, data: { status: newStatus } });
  ok(res, u, "Status updated");
};

export const remove = async (req: Request, res: Response) => {
  const b = await prisma.bed.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    include: { allocations: { where: { toTs: null } } },
  });
  if (!b) throw ApiError.notFound("Bed not found");
  if (b.allocations.length > 0) throw ApiError.conflict("Cannot archive a currently-occupied bed");
  await prisma.bed.update({ where: { id: b.id }, data: { deletedAt: new Date(), status: "OUT_OF_SERVICE" } });
  ok(res, { ok: true }, "Bed archived");
};

/**
 * Live bed status board — wards + beds + active occupant. Used by
 * frontend ipd/board page. Stays light by selecting only the fields we render.
 */
export const board = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const branchId = req.query.branchId as string | undefined;

  const wards = await prisma.ward.findMany({
    where: { tenantId, deletedAt: null, ...(branchId ? { branchId } : {}) },
    orderBy: [{ floor: "asc" }, { name: "asc" }],
    include: {
      beds: {
        where: { deletedAt: null },
        orderBy: { code: "asc" },
        include: {
          allocations: {
            where: { toTs: null },
            select: {
              id: true,
              fromTs: true,
              admission: {
                select: {
                  id: true,
                  admissionNumber: true,
                  patient: { select: { id: true, name: true, patientCode: true } },
                  admittingDoctor: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  ok(res, wards);
};

