import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./cash-close.controller";

export const cashCloseRouter = Router();

const STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.RECEPTIONIST,
  UserRole.ACCOUNTANT,
  UserRole.PHARMACIST,
];

const openSchema = z.object({
  branchId: z.string().uuid().optional(),
  openingFloat: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

const closeSchema = z.object({
  declaredCash: z.number().nonnegative(),
  notes: z.string().optional(),
});

cashCloseRouter.use(authenticate, requireRoles(...STAFF));

cashCloseRouter.get("/", asyncHandler(ctrl.list));
cashCloseRouter.get("/current", asyncHandler(ctrl.currentShift));
cashCloseRouter.get("/:id/summary", asyncHandler(ctrl.shiftSummary));
cashCloseRouter.post("/open", validate(openSchema), asyncHandler(ctrl.openShift));
cashCloseRouter.post("/:id/close", validate(closeSchema), asyncHandler(ctrl.closeShift));
