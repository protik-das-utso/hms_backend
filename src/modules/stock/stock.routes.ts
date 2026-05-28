import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./stock.controller";

export const stockRouter = Router();

const PHARMACY_STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.PHARMACIST,
];

const receiveSchema = z.object({
  medicineId: z.string().uuid(),
  branchId: z.string().uuid(),
  supplierId: z.string().uuid().optional(),
  batchNumber: z.string().min(1).max(50),
  expiryDate: z.string().min(1),
  mrp: z.number().positive(),
  purchasePrice: z.number().nonnegative(),
  qty: z.number().int().positive(),
});

const adjustSchema = z.object({
  batchId: z.string().uuid(),
  delta: z.number().int(),
  reason: z.enum(["ADJUSTMENT", "WASTAGE", "EXPIRY", "RETURN"]),
  notes: z.string().optional(),
});

stockRouter.use(authenticate, requireFeature("pharmacy"));
stockRouter.get("/", asyncHandler(ctrl.currentStock));
stockRouter.get("/batches-for-medicine", asyncHandler(ctrl.batchesForMedicine));
stockRouter.get("/movements/:batchId", asyncHandler(ctrl.movements));
stockRouter.post("/receive", requireRoles(...PHARMACY_STAFF), validate(receiveSchema), asyncHandler(ctrl.receiveBatch));
stockRouter.post("/adjust", requireRoles(...PHARMACY_STAFF), validate(adjustSchema), asyncHandler(ctrl.adjustBatch));
