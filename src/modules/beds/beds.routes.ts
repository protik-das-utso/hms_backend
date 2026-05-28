import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./beds.controller";

export const bedsRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];

const createSchema = z.object({
  wardId: z.string().uuid(),
  code: z.string().min(1).max(30),
  dailyRate: z.number().nonnegative(),
  status: z.enum(["AVAILABLE", "OCCUPIED", "CLEANING", "RESERVED", "OUT_OF_SERVICE"]).optional(),
  notes: z.string().optional(),
});

const updateSchema = z.object({
  code: z.string().min(1).max(30).optional(),
  dailyRate: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

const statusSchema = z.object({
  status: z.enum(["AVAILABLE", "CLEANING", "RESERVED", "OUT_OF_SERVICE", "OCCUPIED"]),
});

bedsRouter.use(authenticate, requireFeature("ipd"));
bedsRouter.get("/board", asyncHandler(ctrl.board));
bedsRouter.get("/", asyncHandler(ctrl.list));
bedsRouter.post("/", requireRoles(...ADMIN), validate(createSchema), asyncHandler(ctrl.create));
bedsRouter.put("/:id", requireRoles(...ADMIN), validate(updateSchema), asyncHandler(ctrl.update));
bedsRouter.post("/:id/status", requireRoles(...ADMIN, UserRole.NURSE), validate(statusSchema), asyncHandler(ctrl.setStatus));
bedsRouter.delete("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.remove));
