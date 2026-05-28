import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./feedback.controller";

export const feedbackRouter = Router();

const STAFF = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.RECEPTIONIST];

const createSchema = z.object({
  patientId: z.string().uuid().optional(),
  type: z.enum(["FEEDBACK", "COMPLAINT", "SUGGESTION"]),
  rating: z.number().int().min(1).max(5).optional(),
  subject: z.string().min(1).max(200),
  message: z.string().min(1),
  visitorName: z.string().max(150).optional(),
  visitorPhone: z.string().max(20).optional(),
  visitorEmail: z.string().email().max(200).optional().or(z.literal("")),
});

const publicSchema = createSchema.extend({
  tenantSlug: z.string().min(1).max(80),
});

const updateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"]).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  response: z.string().optional(),
});

// Public sub-router (unauthenticated) — mounted at /public/feedback in modules/index
export const publicFeedbackRouter = Router();
publicFeedbackRouter.post("/", validate(publicSchema), asyncHandler(ctrl.submitPublic));

// Staff
feedbackRouter.use(authenticate, requireRoles(...STAFF));
feedbackRouter.get("/", asyncHandler(ctrl.list));
feedbackRouter.get("/stats", asyncHandler(ctrl.stats));
feedbackRouter.get("/:id", asyncHandler(ctrl.getOne));
feedbackRouter.post("/", validate(createSchema), asyncHandler(ctrl.create));
feedbackRouter.put("/:id", validate(updateSchema), asyncHandler(ctrl.update));
