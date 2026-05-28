import { Router } from "express";
import { authenticate } from "../../middleware/auth";
import { asyncHandler } from "../../utils/asyncHandler";
import * as ctrl from "./icd.controller";

export const icdRouter = Router();
icdRouter.use(authenticate);
icdRouter.get("/search", asyncHandler(ctrl.search));
