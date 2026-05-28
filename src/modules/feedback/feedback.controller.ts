import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const TYPES = ["FEEDBACK", "COMPLAINT", "SUGGESTION"] as const;
type FbType = typeof TYPES[number];
const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"] as const;
type FbStatus = typeof STATUSES[number];

export const list = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const type = req.query.type as string | undefined;
  const status = req.query.status as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();

  const where: Prisma.PatientFeedbackWhereInput = {
    tenantId,
    ...(type ? { type: type as FbType } : {}),
    ...(status ? { status: status as FbStatus } : {}),
    ...(q
      ? {
          OR: [
            { subject: { contains: q, mode: "insensitive" } },
            { message: { contains: q, mode: "insensitive" } },
            { visitorName: { contains: q, mode: "insensitive" } },
            { visitorPhone: { contains: q } },
            { patient: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.patientFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip, take,
      include: { patient: { select: { id: true, name: true, patientCode: true, phone: true } } },
    }),
    prisma.patientFeedback.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getOne = async (req: Request, res: Response) => {
  const row = await prisma.patientFeedback.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
    include: { patient: { select: { id: true, name: true, patientCode: true, phone: true } } },
  });
  if (!row) throw ApiError.notFound("Not found");
  ok(res, row);
};

/**
 * Staff-side create — `patientId` may be set to attribute the feedback.
 * For the public portal, see `submitPublic`.
 */
export const create = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const b = req.body as {
    patientId?: string;
    type: FbType;
    rating?: number;
    subject: string;
    message: string;
    visitorName?: string;
    visitorPhone?: string;
    visitorEmail?: string;
  };
  if (b.rating != null && (b.rating < 1 || b.rating > 5)) throw ApiError.badRequest("rating must be 1..5");
  const row = await prisma.patientFeedback.create({
    data: {
      tenantId,
      patientId: b.patientId ?? null,
      type: b.type,
      rating: b.rating ?? null,
      subject: b.subject,
      message: b.message,
      visitorName: b.visitorName ?? null,
      visitorPhone: b.visitorPhone ?? null,
      visitorEmail: b.visitorEmail ?? null,
    },
  });
  created(res, row, "Feedback recorded");
};

/**
 * Update status / assign / respond. Setting `response` stamps respondedAt
 * and (if previously OPEN) flips status to RESOLVED.
 */
export const update = async (req: Request, res: Response) => {
  const row = await prisma.patientFeedback.findFirst({
    where: { id: String(req.params.id), tenantId: req.auth!.tenantId },
  });
  if (!row) throw ApiError.notFound("Not found");

  const b = req.body as { status?: FbStatus; assignedToId?: string | null; response?: string };
  const data: Prisma.PatientFeedbackUpdateInput = {};
  if (b.status !== undefined) data.status = b.status;
  if (b.assignedToId !== undefined) data.assignedToId = b.assignedToId;
  if (b.response !== undefined) {
    data.response = b.response || null;
    if (b.response && b.response.trim().length > 0) {
      data.respondedAt = new Date();
      if (!b.status && row.status === "OPEN") data.status = "RESOLVED";
    }
  }
  const updated = await prisma.patientFeedback.update({ where: { id: row.id }, data });
  ok(res, updated, "Feedback updated");
};

// Public unauthenticated submission — used by the portal landing page.
// Not gated; we still validate inputs.
export const submitPublic = async (req: Request, res: Response) => {
  const b = req.body as {
    tenantSlug: string;
    type: FbType;
    rating?: number;
    subject: string;
    message: string;
    visitorName?: string;
    visitorPhone?: string;
    visitorEmail?: string;
  };
  if (!b.tenantSlug) throw ApiError.badRequest("tenantSlug required");
  const tenant = await prisma.tenant.findUnique({ where: { slug: b.tenantSlug } });
  if (!tenant || !tenant.isActive) throw ApiError.notFound("Clinic not found");
  if (!b.subject?.trim() || !b.message?.trim()) throw ApiError.badRequest("Subject and message required");
  if (b.rating != null && (b.rating < 1 || b.rating > 5)) throw ApiError.badRequest("rating must be 1..5");
  await prisma.patientFeedback.create({
    data: {
      tenantId: tenant.id,
      type: b.type,
      rating: b.rating ?? null,
      subject: b.subject.trim(),
      message: b.message.trim(),
      visitorName: b.visitorName?.trim() || null,
      visitorPhone: b.visitorPhone?.trim() || null,
      visitorEmail: b.visitorEmail?.trim() || null,
    },
  });
  ok(res, { ok: true }, "Thank you — feedback received");
};

/**
 * Quick KPIs: counts per status + type, plus average rating.
 */
export const stats = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const [byStatus, byType, avg] = await Promise.all([
    prisma.patientFeedback.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
    prisma.patientFeedback.groupBy({ by: ["type"], where: { tenantId }, _count: { _all: true } }),
    prisma.patientFeedback.aggregate({ where: { tenantId, rating: { not: null } }, _avg: { rating: true }, _count: { rating: true } }),
  ]);
  ok(res, {
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    byType: Object.fromEntries(byType.map((s) => [s.type, s._count._all])),
    averageRating: avg._avg.rating ?? 0,
    rated: avg._count.rating,
  });
};

