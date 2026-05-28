import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./reports.controller";

export const reportsRouter = Router();

const LAB = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.LAB_TECHNICIAN];
const DOCTOR = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.DOCTOR];

const updateSchema = z.object({
  resultData: z.record(
    z.object({
      value: z.string().optional(),
      unit: z.string().optional(),
      refRange: z.string().optional(),
      flag: z.enum(["H", "L", "N"]).optional(),
    })
  ).optional(),
  conclusion: z.string().optional(),
  isAbnormal: z.boolean().optional(),
  attachmentUrls: z.array(z.string().min(1).max(500)).max(20).optional(),
});

reportsRouter.use(authenticate);

reportsRouter.get("/", asyncHandler(ctrl.list));
reportsRouter.get("/pending-approval", requireRoles(...DOCTOR), asyncHandler(ctrl.pendingApproval));
reportsRouter.get("/:id", asyncHandler(ctrl.getOne));
reportsRouter.put("/:id", requireRoles(...LAB), validate(updateSchema), asyncHandler(ctrl.update));
reportsRouter.post("/:id/submit", requireRoles(...LAB), asyncHandler(ctrl.submitForApproval));
reportsRouter.post("/:id/approve", requireRoles(...DOCTOR), asyncHandler(ctrl.approve));
reportsRouter.get("/:id/pdf", asyncHandler(ctrl.downloadPdf));
