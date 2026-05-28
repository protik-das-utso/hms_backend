import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./invoices.controller";

export const invoicesRouter = Router();

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]),
  referenceNo: z.string().max(100).optional(),
  notes: z.string().optional(),
});

invoicesRouter.use(authenticate);

invoicesRouter.get("/",         requirePermission("invoices:read"),     asyncHandler(ctrl.list));
invoicesRouter.get("/:id",      requirePermission("invoices:read"),     asyncHandler(ctrl.getOne));
invoicesRouter.get("/:id/pdf",  requirePermission("invoices:read"),     asyncHandler(ctrl.downloadPdf));
invoicesRouter.post(
  "/:id/payments",
  requirePermission("invoices:record_payment"),
  validate(paymentSchema),
  asyncHandler(ctrl.recordPayment)
);
invoicesRouter.post(
  "/:id/refund",
  requirePermission("invoices:refund"),
  validate(z.object({ amount: z.number().positive(), reason: z.string().optional() })),
  asyncHandler(ctrl.refund)
);
