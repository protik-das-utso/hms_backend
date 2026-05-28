import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./sms.controller";

export const smsRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];

const upsertSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().max(120).optional(),
  body: z.string().min(1).max(640),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});

const testSchema = z.object({
  to: z.string().min(6).max(20),
  code: z.string().optional(),
  body: z.string().optional(),
});

const dueSchema = z.object({ invoiceId: z.string().uuid() });

const providerConfigSchema = z.object({
  provider: z.string().max(40).optional(),
  senderId: z.string().max(40).optional().nullable(),
  apiKey: z.string().max(500).optional().nullable(),
  accountSid: z.string().max(120).optional().nullable(),
  httpUrl: z.string().max(500).optional().nullable(),
  httpBodyTemplate: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
});

smsRouter.use(authenticate, requireRoles(...ADMIN));

smsRouter.get("/status", asyncHandler(ctrl.status));
smsRouter.get("/catalogue", asyncHandler(ctrl.catalogue));
smsRouter.get("/provider-config", asyncHandler(ctrl.getProviderConfig));
smsRouter.put("/provider-config", validate(providerConfigSchema), asyncHandler(ctrl.updateProviderConfig));
smsRouter.get("/templates", asyncHandler(ctrl.listTemplates));
smsRouter.post("/templates/seed", asyncHandler(ctrl.seedDefaults));
smsRouter.post("/templates", validate(upsertSchema), asyncHandler(ctrl.upsertTemplate));
smsRouter.post("/test", validate(testSchema), asyncHandler(ctrl.testSend));
smsRouter.get("/notifications", asyncHandler(ctrl.listNotifications));
smsRouter.post("/send-invoice-due", validate(dueSchema), asyncHandler(ctrl.sendInvoiceDue));
smsRouter.post("/run-reminders", asyncHandler(ctrl.runReminders));
