import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./pharmacy.controller";

export const pharmacyRouter = Router();

const itemSchema = z.object({
  medicineId: z.string().uuid(),
  qty: z.number().int().positive(),
  unit: z.enum(["PIECE", "BOX"]).optional(),
  discount: z.number().nonnegative().optional(),
  batchId: z.string().uuid().optional(),
});

const saleSchema = z.object({
  branchId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  prescriptionId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  customerName: z.string().max(150).optional(),
  customerPhone: z.string().max(20).optional(),
  notes: z.string().optional(),
  items: z.array(itemSchema).min(1),
  discountAmount: z.number().nonnegative().optional(),
  vatPercent: z.number().nonnegative().optional(),
  initialPayment: z
    .object({
      amount: z.number().positive(),
      method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]),
      referenceNo: z.string().optional(),
    })
    .optional(),
});

pharmacyRouter.use(authenticate);
// Module-level feature gate: every pharmacy route requires the tenant to
// have the "pharmacy" feature enabled in their plan or as an override.
pharmacyRouter.use(requireFeature("pharmacy"));
pharmacyRouter.get("/sales",     requirePermission("pharmacy:sell"), asyncHandler(ctrl.list));
pharmacyRouter.get("/day-end",   requirePermission("pharmacy:sell"), asyncHandler(ctrl.dayEnd));
pharmacyRouter.get("/sales/:id", requirePermission("pharmacy:sell"), asyncHandler(ctrl.getOne));
pharmacyRouter.post(
  "/sales",
  requirePermission("pharmacy:sell"),
  validate(saleSchema),
  asyncHandler(ctrl.create)
);
