import { Request, Response } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { hashPassword } from "../../utils/password";
import { getPagination } from "../../utils/pagination";
import { assertQuota } from "../../utils/quota";

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  branchId: true,
  designation: true,
  isActive: true,
  photoUrl: true,
  bmdcNumber: true,
  specialization: true,
  qualifications: true,
  consultationFee: true,
  lastLoginAt: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
};

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const role = req.query.role as string | undefined;

  const where = {
    tenantId,
    deletedAt: null,
    ...(role ? { role: role as UserRole } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: PUBLIC_FIELDS,
    }),
    prisma.user.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const listDoctors = async (req: Request, res: Response) => {
  const rows = await prisma.user.findMany({
    where: { tenantId: req.auth!.tenantId, role: "DOCTOR", deletedAt: null, isActive: true },
    orderBy: { name: "asc" },
    select: PUBLIC_FIELDS,
  });
  ok(res, rows);
};

export const getOne = async (req: Request, res: Response) => {
  const u = await prisma.user.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    select: PUBLIC_FIELDS,
  });
  if (!u) throw ApiError.notFound("User not found");
  ok(res, u);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  await assertQuota(req.auth!.tenantId, "users");
  const phone = body.phone as string;
  const existing = await prisma.user.findFirst({
    where: { tenantId: req.auth!.tenantId, phone, deletedAt: null },
  });
  if (existing) throw ApiError.conflict("User with this phone already exists");

  const passwordHash = await hashPassword(body.password as string);
  const u = await prisma.user.create({
    data: {
      tenantId: req.auth!.tenantId,
      branchId: (body.branchId as string) ?? null,
      name: body.name as string,
      phone,
      email: (body.email as string) || null,
      passwordHash,
      role: body.role as UserRole,
      designation: (body.designation as string) || null,
      bmdcNumber: (body.bmdcNumber as string) || null,
      specialization: (body.specialization as string) || null,
      qualifications: (body.qualifications as string) || null,
      consultationFee: (body.consultationFee as number) ?? null,
    },
    select: PUBLIC_FIELDS,
  });
  created(res, u, "User created");
};

export const update = async (req: Request, res: Response) => {
  const u = await prisma.user.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!u) throw ApiError.notFound("User not found");
  const body = req.body as Record<string, unknown>;
  const updated = await prisma.user.update({
    where: { id: u.id },
    data: {
      name: (body.name as string) ?? undefined,
      phone: (body.phone as string) ?? undefined,
      email: body.email !== undefined ? ((body.email as string) || null) : undefined,
      role: (body.role as UserRole) ?? undefined,
      branchId: body.branchId !== undefined ? ((body.branchId as string) || null) : undefined,
      designation: body.designation !== undefined ? ((body.designation as string) || null) : undefined,
      bmdcNumber: body.bmdcNumber !== undefined ? ((body.bmdcNumber as string) || null) : undefined,
      specialization:
        body.specialization !== undefined ? ((body.specialization as string) || null) : undefined,
      qualifications:
        body.qualifications !== undefined ? ((body.qualifications as string) || null) : undefined,
      consultationFee:
        body.consultationFee !== undefined ? ((body.consultationFee as number) ?? null) : undefined,
      isActive: (body.isActive as boolean) ?? undefined,
    },
    select: PUBLIC_FIELDS,
  });
  ok(res, updated, "User updated");
};

export const softDelete = async (req: Request, res: Response) => {
  const u = await prisma.user.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!u) throw ApiError.notFound("User not found");
  await prisma.user.update({
    where: { id: u.id },
    data: { deletedAt: new Date(), isActive: false },
  });
  ok(res, { ok: true }, "User archived");
};

