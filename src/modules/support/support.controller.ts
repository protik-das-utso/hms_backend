import { Request, Response } from "express";
import {
  Prisma, SupportTicketStatus, SupportTicketCategory, SupportTicketSeverity,
} from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, created, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { isPlatformAdmin } from "../../utils/platformAccess";

const nextTicketNumber = async (): Promise<string> => {
  const prefix = `SUP-${dayjs().format("YYMMDD")}-`;
  const last = await prisma.supportTicket.findFirst({
    where: { ticketNumber: { startsWith: prefix } },
    orderBy: { ticketNumber: "desc" },
    select: { ticketNumber: true },
  });
  const seq = last ? Number(last.ticketNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

// ─── Tenant-side: any authenticated user of the tenant ────────

/**
 * List tickets for the current tenant. Platform admins can pass ?tenantId= to
 * filter, or omit to see every tenant's tickets.
 */
export const listTickets = async (req: Request, res: Response) => {
  const platform = await isPlatformAdmin(req);
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const tenantQ = req.query.tenantId as string | undefined;

  const where: Prisma.SupportTicketWhereInput = {
    ...(platform ? (tenantQ ? { tenantId: tenantQ } : {}) : { tenantId: req.auth!.tenantId }),
    ...(status ? { status: status as SupportTicketStatus } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ status: "asc" }, { lastMessageAt: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      include: platform
        ? { tenant: { select: { id: true, name: true, slug: true } } }
        : undefined,
    }),
    prisma.supportTicket.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

/** Get one ticket + its full message thread. */
export const getTicket = async (req: Request, res: Response) => {
  const platform = await isPlatformAdmin(req);
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: String(req.params.id) },
    include: {
      tenant: platform ? { select: { id: true, name: true, slug: true, contactPhone: true, contactEmail: true } } : false,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!ticket) throw ApiError.notFound("Ticket not found");
  if (!platform && ticket.tenantId !== req.auth!.tenantId) {
    throw ApiError.forbidden("Not your ticket");
  }

  // Clear the unread flag for the side that's reading.
  if (platform && ticket.platformUnread) {
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { platformUnread: false } });
    ticket.platformUnread = false;
  }
  if (!platform && ticket.tenantUnread) {
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { tenantUnread: false } });
    ticket.tenantUnread = false;
  }

  ok(res, ticket);
};

/** Tenant opens a new ticket. */
export const createTicket = async (req: Request, res: Response) => {
  const body = req.body as Record<string, any>;
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.sub },
    select: { id: true, name: true },
  });
  if (!user) throw ApiError.unauthorized();

  const ticketNumber = await nextTicketNumber();
  const ticket = await prisma.supportTicket.create({
    data: {
      tenantId: req.auth!.tenantId,
      ticketNumber,
      title: String(body.title).trim().slice(0, 200),
      category: (body.category as SupportTicketCategory) || "QUESTION",
      severity: (body.severity as SupportTicketSeverity) || "MEDIUM",
      status: "RECEIVED",
      createdById: user.id,
      lastMessageAt: new Date(),
      lastMessageSide: "TENANT",
      platformUnread: true,
      tenantUnread: false,
      messages: {
        create: {
          side: "TENANT",
          authorId: user.id,
          authorName: user.name,
          body: String(body.body).trim(),
          attachmentUrls: Array.isArray(body.attachmentUrls) ? (body.attachmentUrls as string[]) : [],
        },
      },
    },
    include: { messages: true },
  });

  created(res, ticket, "Ticket opened");
};

/** Post a reply on a ticket (either side). */
export const postMessage = async (req: Request, res: Response) => {
  const platform = await isPlatformAdmin(req);
  const body = req.body as { body?: string; attachmentUrls?: string[] };
  const text = String(body.body ?? "").trim();
  const attachments = Array.isArray(body.attachmentUrls) ? body.attachmentUrls.filter(Boolean) : [];
  if (!text && attachments.length === 0) throw ApiError.badRequest("Message body or attachment required");

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, tenantId: true, status: true },
  });
  if (!ticket) throw ApiError.notFound("Ticket not found");
  if (!platform && ticket.tenantId !== req.auth!.tenantId) {
    throw ApiError.forbidden("Not your ticket");
  }
  if (ticket.status === "CLOSED") {
    throw ApiError.badRequest("Ticket is closed — open a new one to continue.");
  }

  const author = await prisma.user.findUnique({
    where: { id: req.auth!.sub },
    select: { id: true, name: true },
  });

  const side = platform ? "PLATFORM" : "TENANT";
  let nextStatus: SupportTicketStatus | undefined;
  // When platform replies on a RECEIVED ticket, move to PENDING (awaiting tenant).
  if (platform && ticket.status === "RECEIVED") nextStatus = "PENDING";

  const now = new Date();
  const [, updated] = await prisma.$transaction([
    prisma.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        side,
        authorId: author?.id ?? req.auth!.sub,
        authorName: author?.name ?? "Unknown",
        body: text,
        attachmentUrls: attachments,
      },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        lastMessageAt: now,
        lastMessageSide: side,
        // Mark the OTHER side as unread.
        platformUnread: side === "TENANT" ? true : false,
        tenantUnread: side === "PLATFORM" ? true : false,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    }),
  ]);

  ok(res, updated, "Reply posted");
};

/**
 * Platform admin updates ticket meta (status / severity / category / assignee).
 */
export const updateTicket = async (req: Request, res: Response) => {
  const platform = await isPlatformAdmin(req);
  if (!platform) throw ApiError.forbidden("Platform admin only");

  const ticket = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
  if (!ticket) throw ApiError.notFound("Ticket not found");

  const body = req.body as Record<string, any>;
  const now = new Date();

  const newStatus = body.status as SupportTicketStatus | undefined;
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      status: newStatus,
      severity: body.severity ?? undefined,
      category: body.category ?? undefined,
      assignedToId: body.assignedToId !== undefined ? (body.assignedToId || null) : undefined,
      resolvedAt: newStatus === "CLOSED" ? now : newStatus ? null : undefined,
      closedAt: newStatus === "CLOSED" ? now : newStatus ? null : undefined,
      // Tenant should see the status change.
      tenantUnread: newStatus ? true : undefined,
    },
  });

  ok(res, updated, "Ticket updated");
};

/** Counts for badges. Platform sees platform-unread; tenants see tenant-unread. */
export const unreadCounts = async (req: Request, res: Response) => {
  const platform = await isPlatformAdmin(req);
  if (platform) {
    const [unread, open] = await Promise.all([
      prisma.supportTicket.count({ where: { platformUnread: true, status: { notIn: ["CLOSED"] } } }),
      prisma.supportTicket.count({ where: { status: { notIn: ["CLOSED"] } } }),
    ]);
    return ok(res, { unread, open });
  }
  const tenantId = req.auth!.tenantId;
  const [unread, open] = await Promise.all([
    prisma.supportTicket.count({ where: { tenantId, tenantUnread: true, status: { notIn: ["CLOSED"] } } }),
    prisma.supportTicket.count({ where: { tenantId, status: { notIn: ["CLOSED"] } } }),
  ]);
  ok(res, { unread, open });
};

