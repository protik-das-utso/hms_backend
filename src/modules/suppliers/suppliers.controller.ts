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

  const where: Prisma.SupplierWhereInput = {
    tenantId,
    ...(activeOnly ? { isActive: true } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: { name: "asc" }, skip, take }),
    prisma.supplier.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const s = await prisma.supplier.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!s) throw ApiError.notFound("Supplier not found");
  ok(res, s);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const s = await prisma.supplier.create({
    data: {
      tenantId: req.auth!.tenantId,
      name: body.name as string,
      contactPerson: (body.contactPerson as string) || null,
      phone: (body.phone as string) || null,
      email: (body.email as string) || null,
      address: (body.address as string) || null,
      vatRegNo: (body.vatRegNo as string) || null,
      notes: (body.notes as string) || null,
      isActive: (body.isActive as boolean) ?? true,
    },
  });
  created(res, s, "Supplier added");
};

export const update = async (req: Request, res: Response) => {
  const s = await prisma.supplier.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!s) throw ApiError.notFound("Supplier not found");

  const body = req.body as Record<string, unknown>;
  const updated = await prisma.supplier.update({
    where: { id: s.id },
    data: {
      name: (body.name as string) ?? undefined,
      contactPerson: body.contactPerson !== undefined ? ((body.contactPerson as string) || null) : undefined,
      phone: body.phone !== undefined ? ((body.phone as string) || null) : undefined,
      email: body.email !== undefined ? ((body.email as string) || null) : undefined,
      address: body.address !== undefined ? ((body.address as string) || null) : undefined,
      vatRegNo: body.vatRegNo !== undefined ? ((body.vatRegNo as string) || null) : undefined,
      notes: body.notes !== undefined ? ((body.notes as string) || null) : undefined,
      isActive: (body.isActive as boolean) ?? undefined,
    },
  });
  ok(res, updated, "Supplier updated");
};

export const remove = async (req: Request, res: Response) => {
  const s = await prisma.supplier.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!s) throw ApiError.notFound("Supplier not found");
  // Soft-delete via isActive — preserves history on past batches
  await prisma.supplier.update({ where: { id: s.id }, data: { isActive: false } });
  ok(res, { ok: true }, "Supplier deactivated");
};

