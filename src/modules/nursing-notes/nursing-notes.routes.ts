import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./nursing-notes.controller";

export const nursingNotesRouter = Router();

const CLINICAL = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.NURSE, UserRole.DOCTOR];

const createSchema = z.object({
  admissionId: z.string().uuid(),
  note: z.string().min(1),
  vitals: z.record(z.unknown()).optional(),
});

nursingNotesRouter.use(authenticate, requireFeature("ipd"));
nursingNotesRouter.get("/by-admission/:admissionId", asyncHandler(ctrl.listForAdmission));
nursingNotesRouter.post("/", requireRoles(...CLINICAL), validate(createSchema), asyncHandler(ctrl.create));
