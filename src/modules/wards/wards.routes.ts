import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./wards.controller";

export const wardsRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];

const createSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1).max(120),
  floor: z.string().max(40).optional(),
  type: z.enum(["GENERAL", "CABIN", "ICU", "HDU", "NICU", "ISOLATION"]).optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

wardsRouter.use(authenticate, requireFeature("ipd"));
wardsRouter.get("/", asyncHandler(ctrl.list));
wardsRouter.get("/:id", asyncHandler(ctrl.getOne));
wardsRouter.post("/", requireRoles(...ADMIN), validate(createSchema), asyncHandler(ctrl.create));
wardsRouter.put("/:id", requireRoles(...ADMIN), validate(updateSchema), asyncHandler(ctrl.update));
wardsRouter.delete("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.remove));
