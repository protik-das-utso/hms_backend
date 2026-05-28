import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./commissions.controller";

export const commissionsRouter = Router();

const FIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.ACCOUNTANT];

const recordSchema = z.object({
  kind: z.enum(["EXTERNAL", "INTERNAL"]),
  referrerId: z.string().uuid().optional(),
  referrerUserId: z.string().uuid().optional(),
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]).optional(),
  referenceNo: z.string().max(80).optional(),
  orderIds: z.array(z.string().uuid()).optional(),
  notes: z.string().optional(),
  writeExpense: z.boolean().optional(),
});

commissionsRouter.use(authenticate, requireRoles(...FIN));

commissionsRouter.get("/pending", asyncHandler(ctrl.pendingByReferrer));
commissionsRouter.get("/detail", asyncHandler(ctrl.referrerDetail));
commissionsRouter.get("/payouts", asyncHandler(ctrl.listPayouts));
commissionsRouter.post("/payouts", validate(recordSchema), asyncHandler(ctrl.recordPayout));
