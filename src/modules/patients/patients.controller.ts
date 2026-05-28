import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { patientCode } from "../../utils/codes";
import { sendSmsAsync } from "../../utils/notify";
import { assertQuota } from "../../utils/quota";
import dayjs from "dayjs";

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const branchId = req.query.branchId as string | undefined;

  const where = {
    tenantId,
    deletedAt: null,
    ...(branchId ? { branchId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
            { patientCode: { contains: q, mode: "insensitive" as const } },
            { nid: { contains: q } },
            { address: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { branch: { select: { name: true } } },
    }),
    prisma.patient.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const patient = await prisma.patient.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
    include: {
      branch: { select: { id: true, name: true, code: true } },
      corporateClient: {
        select: { id: true, name: true, type: true, discountPercent: true, isActive: true },
      },
    },
  });
  if (!patient) throw ApiError.notFound("Patient not found");
  ok(res, patient);
};

export const create = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const { tenantId, branchId } = req.auth!;
  const today = dayjs().startOf("day").toDate();

  // Subscription quota check (monthly patient cap) — fails before phone-uniq lookup
  // so a quota-blocked clinic gets the right error instead of "duplicate".
  await assertQuota(tenantId, "patients");

  const existing = await prisma.patient.findFirst({
    where: { tenantId, phone: body.phone as string, deletedAt: null },
  });
  if (existing) throw ApiError.conflict("Patient with this phone already exists");

  const count = await prisma.patient.count({
    where: { tenantId, createdAt: { gte: today } },
  });
  const code = patientCode(count + 1);

  // Validate corporate client belongs to this tenant if supplied
  let corporateClientId: string | null = null;
  if (body.corporateClientId) {
    const cc = await prisma.corporateClient.findFirst({
      where: { id: body.corporateClientId as string, tenantId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!cc) throw ApiError.badRequest("Corporate client not found or inactive");
    corporateClientId = cc.id;
  }

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      branchId: (body.branchId as string) || branchId || null,
      patientCode: code,
      name: body.name as string,
      phone: body.phone as string,
      email: (body.email as string) || null,
      dob: body.dob ? new Date(body.dob as string) : null,
      gender: (body.gender as "MALE" | "FEMALE" | "OTHER") || null,
      address: (body.address as string) || null,
      nid: (body.nid as string) || null,
      bloodGroup: (body.bloodGroup as string) || null,
      allergies: (body.allergies as string) || null,
      emergencyContact: (body.emergencyContact as string) || null,
      notes: (body.notes as string) || null,
      photoUrl: (body.photoUrl as string) || null,
      corporateClientId,
      corporateEmpId: corporateClientId ? ((body.corporateEmpId as string) || null) : null,
    },
  });

  // Fire-and-forget welcome SMS — failure shouldn't block registration.
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  sendSmsAsync({
    tenantId,
    code: "WELCOME_PATIENT",
    to: patient.phone,
    vars: { name: patient.name, patientCode: patient.patientCode, clinic: tenant?.name ?? "" },
    relatedTo: "WELCOME",
  });

  created(res, patient, "Patient registered");
};

export const update = async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const patient = await prisma.patient.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!patient) throw ApiError.notFound("Patient not found");

  // Validate corporate client on update if explicitly provided. Pass null/empty
  // to unlink. Pass undefined to leave as-is.
  let corporateClientIdUpdate: string | null | undefined = undefined;
  if (body.corporateClientId !== undefined) {
    if (!body.corporateClientId) {
      corporateClientIdUpdate = null;
    } else {
      const cc = await prisma.corporateClient.findFirst({
        where: {
          id: body.corporateClientId as string,
          tenantId: req.auth!.tenantId,
          deletedAt: null,
          isActive: true,
        },
        select: { id: true },
      });
      if (!cc) throw ApiError.badRequest("Corporate client not found or inactive");
      corporateClientIdUpdate = cc.id;
    }
  }

  const updated = await prisma.patient.update({
    where: { id: patient.id },
    data: {
      name: (body.name as string) ?? undefined,
      phone: (body.phone as string) ?? undefined,
      email: body.email !== undefined ? ((body.email as string) || null) : undefined,
      dob: body.dob ? new Date(body.dob as string) : undefined,
      gender: (body.gender as "MALE" | "FEMALE" | "OTHER") ?? undefined,
      address: body.address !== undefined ? ((body.address as string) || null) : undefined,
      nid: body.nid !== undefined ? ((body.nid as string) || null) : undefined,
      bloodGroup: body.bloodGroup !== undefined ? ((body.bloodGroup as string) || null) : undefined,
      allergies: body.allergies !== undefined ? ((body.allergies as string) || null) : undefined,
      emergencyContact:
        body.emergencyContact !== undefined ? ((body.emergencyContact as string) || null) : undefined,
      notes: body.notes !== undefined ? ((body.notes as string) || null) : undefined,
      photoUrl: body.photoUrl !== undefined ? ((body.photoUrl as string) || null) : undefined,
      branchId: (body.branchId as string) ?? undefined,
      corporateClientId: corporateClientIdUpdate,
      corporateEmpId:
        body.corporateEmpId !== undefined ? ((body.corporateEmpId as string) || null) : undefined,
    },
  });

  ok(res, updated, "Patient updated");
};

export const softDelete = async (req: Request, res: Response) => {
  const patient = await prisma.patient.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId, deletedAt: null },
  });
  if (!patient) throw ApiError.notFound("Patient not found");
  await prisma.patient.update({
    where: { id: patient.id },
    data: { deletedAt: new Date() },
  });
  ok(res, { ok: true }, "Patient archived");
};

export const listOrders = async (req: Request, res: Response) => {
  const orders = await prisma.testOrder.findMany({
    where: { tenantId: req.auth!.tenantId, patientId: String(req.params.id) },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        include: {
          test: { select: { nameEn: true, code: true } },
          report: {
            select: { id: true, status: true, isAbnormal: true, submittedAt: true, approvedAt: true },
          },
        },
      },
      branch: { select: { name: true } },
    },
  });
  ok(res, orders);
};

export const listInvoices = async (req: Request, res: Response) => {
  const invoices = await prisma.invoice.findMany({
    where: { tenantId: req.auth!.tenantId, patientId: String(req.params.id) },
    orderBy: { createdAt: "desc" },
    include: { payments: true },
  });
  ok(res, invoices);
};

