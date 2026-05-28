import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePlatformAdmin } from "../../utils/platformAccess";
import * as ctrl from "./features.controller";

export const featuresRouter = Router();
export const platformFeaturesRouter = Router();

featuresRouter.use(authenticate);
featuresRouter.get("/catalogue", asyncHandler(ctrl.catalogue));
featuresRouter.get("/mine", asyncHandler(ctrl.mine));

const featuresUpdateSchema = z.object({
  features: z.record(z.boolean()),
});

platformFeaturesRouter.use(authenticate, requirePlatformAdmin);
platformFeaturesRouter.put("/plans/:id/features",  validate(featuresUpdateSchema), asyncHandler(ctrl.updatePlanFeatures));
platformFeaturesRouter.get("/tenants/:id/features", asyncHandler(ctrl.tenantFeatureView));
platformFeaturesRouter.put("/tenants/:id/features", validate(featuresUpdateSchema), asyncHandler(ctrl.updateTenantFeatures));
