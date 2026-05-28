import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./appointments.controller";

export const appointmentsRouter = Router();

const FRONT_DESK = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.RECEPTIONIST,
  UserRole.DOCTOR,
  UserRole.NURSE,
];

const createSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  slotStart: z.string().min(1),
  slotEnd: z.string().optional(),
  bookedVia: z.enum(["COUNTER", "PORTAL", "PHONE"]).optional(),
  reason: z.string().max(255).optional(),
  notes: z.string().optional(),
});

const statusSchema = z.object({
  status: z.enum(["BOOKED", "CHECKED_IN", "IN_CONSULT", "COMPLETED", "NO_SHOW", "CANCELLED"]),
});

appointmentsRouter.use(authenticate, requireFeature("opd"));

appointmentsRouter.get("/", asyncHandler(ctrl.list));
appointmentsRouter.get("/available-slots", asyncHandler(ctrl.availableSlots));
appointmentsRouter.get("/:id", asyncHandler(ctrl.getOne));
appointmentsRouter.post("/", requireRoles(...FRONT_DESK), validate(createSchema), asyncHandler(ctrl.create));
appointmentsRouter.patch("/:id/status", requireRoles(...FRONT_DESK), validate(statusSchema), asyncHandler(ctrl.updateStatus));
