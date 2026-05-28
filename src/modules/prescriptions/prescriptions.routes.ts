import { Router } from "express";
import { authenticate, requireFeature } from "../../middleware/auth";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./prescriptions.controller";

export const prescriptionsRouter = Router();

prescriptionsRouter.use(authenticate, requireFeature("opd"));
prescriptionsRouter.get("/:id", asyncHandler(ctrl.getOne));
prescriptionsRouter.get("/:id/pdf", asyncHandler(ctrl.downloadPdf));
