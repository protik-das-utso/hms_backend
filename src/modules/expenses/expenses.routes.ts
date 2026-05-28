import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./expenses.controller";

export const expensesRouter = Router();

const FIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.ACCOUNTANT];

const createSchema = z.object({
  branchId: z.string().uuid().optional(),
  spentOn: z.string().min(1),
  category: z.enum([
    "SALARY", "RENT", "UTILITIES", "SUPPLIES", "EQUIPMENT",
    "MARKETING", "MAINTENANCE", "TAX", "TRAVEL", "GOVT_FEE", "COMMISSION_PAYOUT", "OTHER",
  ]),
  description: z.string().min(1).max(200),
  amount: z.number().nonnegative(),
  paidVia: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]).optional(),
  vendorName: z.string().max(150).optional(),
  referenceNo: z.string().max(80).optional(),
  notes: z.string().optional(),
});

const updateSchema = createSchema.partial();

expensesRouter.use(authenticate, requireRoles(...FIN));
expensesRouter.get("/", asyncHandler(ctrl.list));
expensesRouter.get("/summary", asyncHandler(ctrl.summary));
expensesRouter.post("/", validate(createSchema), asyncHandler(ctrl.create));
expensesRouter.put("/:id", validate(updateSchema), asyncHandler(ctrl.update));
expensesRouter.delete("/:id", asyncHandler(ctrl.remove));
