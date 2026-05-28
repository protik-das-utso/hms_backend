import { Router } from "express";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./doctor-schedules.controller";

export const doctorSchedulesRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.DOCTOR];

doctorSchedulesRouter.use(authenticate, requireFeature("opd"));
doctorSchedulesRouter.get("/", asyncHandler(ctrl.list));
doctorSchedulesRouter.post("/", requireRoles(...ADMIN), asyncHandler(ctrl.create));
doctorSchedulesRouter.put("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.update));
doctorSchedulesRouter.delete("/:id", requireRoles(...ADMIN), asyncHandler(ctrl.remove));
