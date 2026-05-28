import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./doctor-visits.controller";

export const doctorVisitsRouter = Router();

const CLINICAL = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.DOCTOR, UserRole.NURSE];

const createSchema = z.object({
  admissionId: z.string().uuid(),
  doctorId: z.string().uuid(),
  visitAt: z.string().optional(),
  note: z.string().optional(),
  fee: z.number().nonnegative().optional(),
});

doctorVisitsRouter.use(authenticate, requireFeature("ipd"));
doctorVisitsRouter.get("/by-admission/:admissionId", asyncHandler(ctrl.listForAdmission));
doctorVisitsRouter.post("/", requireRoles(...CLINICAL), validate(createSchema), asyncHandler(ctrl.create));
