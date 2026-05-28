import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePlatformAdmin } from "../../utils/platformAccess";
import * as ctrl from "./subscription-invoices.controller";

export const subscriptionInvoicesRouter = Router();

const generateSchema = z.object({
  tenantId: z.string().uuid(),
  periodFrom: z.string().min(8),
  periodTo: z.string().min(8).optional(),
  discountAmount: z.coerce.number().min(0).optional(),
  notes: z.string().optional().or(z.literal("")),
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]).optional(),
  referenceNo: z.string().max(100).optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

subscriptionInvoicesRouter.use(authenticate);
subscriptionInvoicesRouter.get("/", asyncHandler(ctrl.list));
subscriptionInvoicesRouter.get("/:id", asyncHandler(ctrl.getOne));

// Platform-admin-only write actions
subscriptionInvoicesRouter.post(
  "/generate",
  requirePlatformAdmin,
  validate(generateSchema),
  asyncHandler(ctrl.generate)
);
subscriptionInvoicesRouter.post(
  "/:id/payments",
  requirePlatformAdmin,
  validate(paymentSchema),
  asyncHandler(ctrl.recordPayment)
);
subscriptionInvoicesRouter.post(
  "/:id/void",
  requirePlatformAdmin,
  asyncHandler(ctrl.voidInvoice)
);
