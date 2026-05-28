import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./support.controller";

export const supportRouter = Router();

supportRouter.use(authenticate);

const attachmentsSchema = z.array(z.string().max(500)).max(8).optional();

const ticketCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10000),
  category: z.enum(["BUG", "FEATURE_REQUEST", "QUESTION", "BILLING", "ACCOUNT", "OTHER"]).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  attachmentUrls: attachmentsSchema,
});

const messageSchema = z.object({
  body: z.string().trim().max(10000).optional(),
  attachmentUrls: attachmentsSchema,
}).refine((d) => (d.body && d.body.trim().length > 0) || (d.attachmentUrls && d.attachmentUrls.length > 0), {
  message: "Either body or attachmentUrls must be present",
});

const updateSchema = z.object({
  status: z.enum(["RECEIVED", "PENDING", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  category: z.enum(["BUG", "FEATURE_REQUEST", "QUESTION", "BILLING", "ACCOUNT", "OTHER"]).optional(),
  assignedToId: z.string().optional().or(z.literal("")),
});

supportRouter.get("/unread", asyncHandler(ctrl.unreadCounts));
supportRouter.get("/", asyncHandler(ctrl.listTickets));
supportRouter.get("/:id", asyncHandler(ctrl.getTicket));
supportRouter.post("/", validate(ticketCreateSchema), asyncHandler(ctrl.createTicket));
supportRouter.post("/:id/messages", validate(messageSchema), asyncHandler(ctrl.postMessage));
// Platform-admin meta update (status / severity / assign). Authorization handled
// inside the controller via isPlatformAdmin.
supportRouter.put("/:id", validate(updateSchema), asyncHandler(ctrl.updateTicket));
