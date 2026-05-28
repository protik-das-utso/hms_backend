import { Router } from "express";
import { authenticate, requireRoles } from "../../middleware/auth";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./dashboard.controller";

export const dashboardRouter = Router();

const FIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.ACCOUNTANT];

dashboardRouter.use(authenticate);
dashboardRouter.get("/summary", asyncHandler(ctrl.summary));
dashboardRouter.get("/revenue-trend", asyncHandler(ctrl.revenueTrend));
dashboardRouter.get("/top-tests", asyncHandler(ctrl.topTests));
dashboardRouter.get("/recent-orders", asyncHandler(ctrl.recentOrders));

// Financial / executive endpoints
dashboardRouter.get("/overview", requireRoles(...FIN), asyncHandler(ctrl.overview));
dashboardRouter.get("/top-doctors", requireRoles(...FIN), asyncHandler(ctrl.topDoctors));
dashboardRouter.get("/top-medicines", requireRoles(...FIN), asyncHandler(ctrl.topMedicines));
dashboardRouter.get("/outstanding-top", requireRoles(...FIN), asyncHandler(ctrl.outstandingTop));
dashboardRouter.get("/outstanding", requireRoles(...FIN), asyncHandler(ctrl.outstandingAll));
