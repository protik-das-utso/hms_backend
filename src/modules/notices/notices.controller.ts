import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";

const AUDIENCES = ["ALL_STAFF", "DOCTORS", "NURSES", "RECEPTIONISTS", "LAB", "PHARMACY", "ACCOUNTS", "ADMINS"] as const;
type Aud = typeof AUDIENCES[number];

// Map a user role → set of audience values they can see.
function audienceMatches(role: string): Aud[] {
  const base: Aud[] = ["ALL_STAFF"];
  if (role === "SUPER_ADMIN" || role === "BRANCH_ADMIN") return [...base, "ADMINS", "DOCTORS", "NURSES", "RECEPTIONISTS", "LAB", "PHARMACY", "ACCOUNTS"];
  if (role === "DOCTOR") return [...base, "DOCTORS"];
  if (role === "NURSE") return [...base, "NURSES"];
  if (role === "RECEPTIONIST") return [...base, "RECEPTIONISTS"];
  if (role === "LAB_TECHNICIAN") return [...base, "LAB"];
  if (role === "PHARMACIST") return [...base, "PHARMACY"];
  if (role === "ACCOUNTANT") return [...base, "ACCOUNTS"];
  return base;
}

export const list = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role, branchId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const audiences = audienceMatches(role);

  const where: Prisma.NoticeWhereInput = {
    tenantId,
    deletedAt: null,
    audience: { in: audiences },
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    // Branch-targeted notices (when branchId set on Notice) only visible to
    // users at that branch — or to anyone if Notice.branchId is null.
    AND: [{ OR: [{ branchId: null }, { branchId: branchId ?? undefined }] }],
  };

  const [rows, total] = await Promise.all([
    prisma.notice.findMany({
      where,
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      include: { receipts: { where: { userId }, select: { id: true } } },
    }),
    prisma.notice.count({ where }),
  ]);

  // Lookup poster names in a single query
  const posters = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: Array.from(new Set(rows.map((r) => r.postedById))) }, tenantId },
        select: { id: true, name: true, role: true },
      })
    : [];

  ok(res, rows.map((n) => ({
    ...n,
    postedBy: posters.find((p) => p.id === n.postedById) ?? null,
    isRead: n.receipts.length > 0,
  })), "OK", paginate(page, pageSize, total));
};

export const unreadCount = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role, branchId } = req.auth!;
  const audiences = audienceMatches(role);

  const total = await prisma.notice.count({
    where: {
      tenantId,
      deletedAt: null,
      audience: { in: audiences },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      AND: [{ OR: [{ branchId: null }, { branchId: branchId ?? undefined }] }],
      receipts: { none: { userId } },
    },
  });
  ok(res, { unread: total });
};

export const create = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const b = req.body as {
    title: string;
    body: string;
    branchId?: string;
    audience?: Aud;
    pinned?: boolean;
    expiresAt?: string;
  };
  const row = await prisma.notice.create({
    data: {
      tenantId,
      branchId: b.branchId ?? null,
      postedById: userId,
      title: b.title,
      body: b.body,
      audience: b.audience ?? "ALL_STAFF",
      pinned: b.pinned ?? false,
      expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
    },
  });
  created(res, row, "Notice posted");
};

export const update = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role } = req.auth!;
  const row = await prisma.notice.findFirst({
    where: { id: String(req.params.id), tenantId, deletedAt: null },
  });
  if (!row) throw ApiError.notFound("Notice not found");
  // Only the poster or an admin can edit.
  if (row.postedById !== userId && role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN") {
    throw ApiError.forbidden("Only the poster or an admin can edit");
  }
  const b = req.body as Record<string, unknown>;
  const data: Prisma.NoticeUpdateInput = {};
  if (b.title !== undefined) data.title = b.title as string;
  if (b.body !== undefined) data.body = b.body as string;
  if (b.audience !== undefined) data.audience = b.audience as Aud;
  if (b.pinned !== undefined) data.pinned = b.pinned as boolean;
  if (b.expiresAt !== undefined) data.expiresAt = b.expiresAt ? new Date(b.expiresAt as string) : null;
  const updated = await prisma.notice.update({ where: { id: row.id }, data });
  ok(res, updated, "Notice updated");
};

export const remove = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role } = req.auth!;
  const row = await prisma.notice.findFirst({
    where: { id: String(req.params.id), tenantId, deletedAt: null },
  });
  if (!row) throw ApiError.notFound("Notice not found");
  if (row.postedById !== userId && role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN") {
    throw ApiError.forbidden("Only the poster or an admin can delete");
  }
  await prisma.notice.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
  ok(res, { ok: true }, "Notice removed");
};

export const markRead = async (req: Request, res: Response) => {
  const { tenantId, sub: userId } = req.auth!;
  const row = await prisma.notice.findFirst({
    where: { id: String(req.params.id), tenantId, deletedAt: null },
  });
  if (!row) throw ApiError.notFound("Notice not found");
  await prisma.noticeReceipt.upsert({
    where: { noticeId_userId: { noticeId: row.id, userId } },
    create: { noticeId: row.id, userId },
    update: {},
  });
  ok(res, { ok: true });
};

export const markAllRead = async (req: Request, res: Response) => {
  const { tenantId, sub: userId, role, branchId } = req.auth!;
  const audiences = audienceMatches(role);
  const unread = await prisma.notice.findMany({
    where: {
      tenantId,
      deletedAt: null,
      audience: { in: audiences },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      AND: [{ OR: [{ branchId: null }, { branchId: branchId ?? undefined }] }],
      receipts: { none: { userId } },
    },
    select: { id: true },
  });
  if (unread.length === 0) return ok(res, { marked: 0 });
  await prisma.noticeReceipt.createMany({
    data: unread.map((n) => ({ noticeId: n.id, userId })),
    skipDuplicates: true,
  });
  ok(res, { marked: unread.length });
};

