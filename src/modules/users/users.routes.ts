import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./users.controller";

export const usersRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];

const createSchema = z.object({
  name: z.string().min(2).max(150),
  phone: z.string().min(6).max(20),
  email: z.string().email().optional().or(z.literal("")),
  password: z.string().min(6).max(100),
  role: z.enum([
    "SUPER_ADMIN",
    "BRANCH_ADMIN",
    "RECEPTIONIST",
    "LAB_TECHNICIAN",
    "DOCTOR",
    "NURSE",
    "PHARMACIST",
    "ACCOUNTANT",
    "HR_MANAGER",
    "DELIVERY_STAFF",
  ]),
  branchId: z.string().uuid().optional(),
  designation: z.string().max(100).optional(),
  bmdcNumber: z.string().max(50).optional(),
  specialization: z.string().max(150).optional(),
  qualifications: z.string().max(255).optional(),
  consultationFee: z.number().nonnegative().optional(),
});

const updateSchema = createSchema.partial().omit({ password: true }).extend({
  isActive: z.boolean().optional(),
});

usersRouter.use(authenticate, requireRoles(...ADMIN));
usersRouter.get("/", asyncHandler(ctrl.list));
usersRouter.get("/doctors", asyncHandler(ctrl.listDoctors));
usersRouter.get("/:id", asyncHandler(ctrl.getOne));
usersRouter.post("/", validate(createSchema), asyncHandler(ctrl.create));
usersRouter.put("/:id", validate(updateSchema), asyncHandler(ctrl.update));
usersRouter.delete("/:id", asyncHandler(ctrl.softDelete));
