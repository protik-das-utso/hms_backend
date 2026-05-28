import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePlatformAdmin } from "../../utils/platformAccess";
import * as ctrl from "./subscription-plans.controller";

// Authenticated tenant-facing routes (catalogue read).
export const subscriptionPlansRouter = Router();
// Public pricing page feed.
export const publicSubscriptionPlansRouter = Router();
// Platform admin (write).
export const platformSubscriptionPlansRouter = Router();

const planSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().optional().or(z.literal("")),
  monthlyPrice: z.coerce.number().min(0),
  yearlyPrice: z.coerce.number().min(0).optional(),
  maxBranches: z.coerce.number().int().min(1).max(99999),
  maxUsers: z.coerce.number().int().min(1).max(99999),
  maxPatientsMonth: z.coerce.number().int().min(1).max(9_999_999),
  maxStorageGb: z.coerce.number().int().min(1).max(99999),
  features: z.record(z.any()).optional(),
  sortOrder: z.coerce.number().int().optional(),
  isPublic: z.boolean().optional(),
  isActive: z.boolean().optional(),
  highlightTag: z.string().max(40).optional().or(z.literal("")),
});
const updateSchema = planSchema.omit({ code: true }).partial();

publicSubscriptionPlansRouter.get("/", asyncHandler(ctrl.listPublic));

subscriptionPlansRouter.use(authenticate);
subscriptionPlansRouter.get("/", asyncHandler(ctrl.listAll));
subscriptionPlansRouter.get("/:id", asyncHandler(ctrl.getOne));

platformSubscriptionPlansRouter.use(authenticate, requirePlatformAdmin);
platformSubscriptionPlansRouter.get("/", asyncHandler(ctrl.listAll));
platformSubscriptionPlansRouter.post("/", validate(planSchema), asyncHandler(ctrl.create));
platformSubscriptionPlansRouter.put("/:id", validate(updateSchema), asyncHandler(ctrl.update));
platformSubscriptionPlansRouter.delete("/:id", asyncHandler(ctrl.remove));
