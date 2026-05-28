import { Router } from "express";
import { z } from "zod";
import { UserRole } from "@prisma/client";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./referrers.controller";

export const referrersRouter = Router();

const ADMIN = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.ACCOUNTANT,
  UserRole.RECEPTIONIST,
];

const baseSchema = z.object({
  name: z.string().min(2).max(150),
  phone: z.string().min(6).max(20),
  email: z.string().email().optional().or(z.literal("")),
  designation: z.string().max(100).optional(),
  hospital: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  bmdcNumber: z.string().max(50).optional(),
  defaultCommissionPercent: z.number().min(0).max(100).optional(),
  photoUrl: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
});
const updateSchema = baseSchema.partial().extend({
  isActive: z.boolean().optional(),
});

referrersRouter.use(authenticate);

referrersRouter.get("/", asyncHandler(ctrl.list));
referrersRouter.get("/:id", asyncHandler(ctrl.getOne));
referrersRouter.get("/:id/commissions", asyncHandler(ctrl.commissions));
referrersRouter.post("/", requireRoles(...ADMIN), validate(baseSchema), asyncHandler(ctrl.create));
referrersRouter.put("/:id", requireRoles(...ADMIN), validate(updateSchema), asyncHandler(ctrl.update));
referrersRouter.delete("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.softDelete));
