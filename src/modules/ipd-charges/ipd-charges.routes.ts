import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./ipd-charges.controller";

export const ipdChargesRouter = Router();

const CLINICAL = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.DOCTOR,
  UserRole.NURSE,
];

const createSchema = z.object({
  admissionId: z.string().uuid(),
  chargeDate: z.string().optional(),
  chargeType: z.enum(["BED", "DOCTOR_VISIT", "NURSING", "MEDICINE", "PROCEDURE", "CONSUMABLE", "INVESTIGATION", "OTHER"]),
  description: z.string().min(1).max(200),
  qty: z.number().int().positive().optional(),
  unitPrice: z.number().nonnegative(),
  refTable: z.string().optional(),
  refId: z.string().optional(),
});

ipdChargesRouter.use(authenticate, requireFeature("ipd"));
ipdChargesRouter.get("/by-admission/:admissionId", asyncHandler(ctrl.listForAdmission));
ipdChargesRouter.post("/", requireRoles(...CLINICAL), validate(createSchema), asyncHandler(ctrl.create));
ipdChargesRouter.delete("/:id", requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN), asyncHandler(ctrl.remove));
