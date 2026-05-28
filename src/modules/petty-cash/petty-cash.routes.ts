import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./petty-cash.controller";

export const pettyCashRouter = Router();

const STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.ACCOUNTANT,
  UserRole.RECEPTIONIST,
];

const CATEGORIES = ["SALARY", "RENT", "UTILITIES", "SUPPLIES", "EQUIPMENT", "MARKETING", "MAINTENANCE", "TAX", "TRAVEL", "GOVT_FEE", "COMMISSION_PAYOUT", "OTHER"] as const;

const createSchema = z.object({
  branchId: z.string().uuid(),
  type: z.enum(["TOP_UP", "PAYOUT", "ADJUSTMENT"]),
  amount: z.number().nonnegative(),
  description: z.string().min(1).max(200),
  voucherNo: z.string().max(40).optional(),
  occurredOn: z.string().optional(),
  alsoExpense: z.object({
    category: z.enum(CATEGORIES),
    vendorName: z.string().max(150).optional(),
  }).optional(),
});

pettyCashRouter.use(authenticate, requireRoles(...STAFF));
pettyCashRouter.get("/", asyncHandler(ctrl.list));
pettyCashRouter.get("/balance", asyncHandler(ctrl.balance));
pettyCashRouter.post("/", validate(createSchema), asyncHandler(ctrl.create));
pettyCashRouter.delete("/:id", asyncHandler(ctrl.remove));
