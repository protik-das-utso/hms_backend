import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./orders.controller";

export const ordersRouter = Router();

const ORDER_STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.RECEPTIONIST,
];

const LAB_STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.LAB_TECHNICIAN,
];

const createSchema = z.object({
  patientId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  referralDoctor: z.string().max(150).optional(),
  referrerUserId: z.string().uuid().optional(),
  referrerId: z.string().uuid().optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  isHomeCollection: z.boolean().optional(),
  homeAddress: z.string().optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        testId: z.string().uuid(),
        price: z.number().nonnegative().optional(),
      })
    )
    .min(1),

  // Optional invoice info — created together
  discountAmount: z.number().nonnegative().optional(),
  discountReason: z.string().optional(),
  vatPercent: z.number().nonnegative().optional(),

  // Optional initial payment recording
  initialPayment: z
    .object({
      amount: z.number().nonnegative(),
      method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]),
      referenceNo: z.string().optional(),
      notes: z.string().optional(),
    })
    .optional(),
});

const itemStatusSchema = z.object({
  status: z.enum(["PENDING", "SAMPLE_COLLECTED", "IN_LAB", "PROCESSING", "COMPLETED", "DELIVERED", "CANCELLED"]),
});

ordersRouter.use(authenticate);

ordersRouter.get("/", asyncHandler(ctrl.list));
ordersRouter.get("/lab-queue", requireRoles(...LAB_STAFF), asyncHandler(ctrl.labQueue));
ordersRouter.get("/:id", asyncHandler(ctrl.getOne));
ordersRouter.post("/", requireRoles(...ORDER_STAFF), validate(createSchema), asyncHandler(ctrl.create));
ordersRouter.patch(
  "/items/:itemId/status",
  requireRoles(...LAB_STAFF),
  validate(itemStatusSchema),
  asyncHandler(ctrl.updateItemStatus)
);
