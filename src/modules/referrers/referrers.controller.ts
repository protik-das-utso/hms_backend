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

  const where: Prisma.ReferrerWhereInput = {
    tenantId,
    deletedAt: null,
    ...(activeOnly ? { isActive: true } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { hospital: { contains: q, mode: "insensitive" } },
            { designation: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.referrer.findMany({
      where,
      orderBy: { name: "asc" },
      skip,
      take,
    }),
    prisma.referrer.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const r = await prisma.referrer.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!r) throw ApiError.notFound("Referrer not found");
  ok(res, r);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const r = await prisma.referrer.create({
    data: {
      tenantId: req.auth!.tenantId,
      name: body.name as string,
      phone: body.phone as string,
      email: (body.email as string) || null,
      designation: (body.designation as string) || null,
      hospital: (body.hospital as string) || null,
      address: (body.address as string) || null,
      bmdcNumber: (body.bmdcNumber as string) || null,
      defaultCommissionPercent: new Prisma.Decimal(
        (body.defaultCommissionPercent as number) ?? 0
      ),
      photoUrl: (body.photoUrl as string) || null,
      notes: (body.notes as string) || null,
    },
  });
  created(res, r, "Referrer added");
};

export const update = async (req: Request, res: Response) => {
  const existing = await prisma.referrer.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!existing) throw ApiError.notFound("Referrer not found");

  const body = req.body as Record<string, unknown>;
  const updated = await prisma.referrer.update({
    where: { id: existing.id },
    data: {
      name: (body.name as string) ?? undefined,
      phone: (body.phone as string) ?? undefined,
      email: body.email !== undefined ? ((body.email as string) || null) : undefined,
      designation: body.designation !== undefined ? ((body.designation as string) || null) : undefined,
      hospital: body.hospital !== undefined ? ((body.hospital as string) || null) : undefined,
      address: body.address !== undefined ? ((body.address as string) || null) : undefined,
      bmdcNumber: body.bmdcNumber !== undefined ? ((body.bmdcNumber as string) || null) : undefined,
      defaultCommissionPercent:
        body.defaultCommissionPercent !== undefined
          ? new Prisma.Decimal(body.defaultCommissionPercent as number)
          : undefined,
      photoUrl: body.photoUrl !== undefined ? ((body.photoUrl as string) || null) : undefined,
      notes: body.notes !== undefined ? ((body.notes as string) || null) : undefined,
      isActive: (body.isActive as boolean) ?? undefined,
    },
  });
  ok(res, updated, "Referrer updated");
};

export const softDelete = async (req: Request, res: Response) => {
  const r = await prisma.referrer.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!r) throw ApiError.notFound("Referrer not found");
  await prisma.referrer.update({
    where: { id: r.id },
    data: { deletedAt: new Date(), isActive: false },
  });
  ok(res, { ok: true }, "Referrer archived");
};

// Commissions earned by a referrer
export const commissions = async (req: Request, res: Response) => {
  const r = await prisma.referrer.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!r) throw ApiError.notFound("Referrer not found");

  const orders = await prisma.testOrder.findMany({
    where: { tenantId: req.auth!.tenantId, referrerId: r.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderNumber: true,
      createdAt: true,
      commissionPercent: true,
      commissionAmount: true,
      status: true,
      patient: { select: { name: true, patientCode: true } },
      items: { select: { price: true } },
    },
  });

  const totals = orders.reduce(
    (acc, o) => {
      const subtotal = o.items.reduce((s, it) => s + Number(it.price), 0);
      const earned = Number(o.commissionAmount ?? 0);
      acc.orderCount += 1;
      acc.subtotal += subtotal;
      acc.earned += earned;
      return acc;
    },
    { orderCount: 0, subtotal: 0, earned: 0 }
  );

  ok(res, { referrer: r, orders, totals });
};

