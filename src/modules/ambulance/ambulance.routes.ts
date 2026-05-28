import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./ambulance.controller";

export const ambulanceRouter = Router();

const STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.RECEPTIONIST,
  UserRole.NURSE,
  UserRole.DOCTOR,
  UserRole.ACCOUNTANT,
];

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];

const vehicleSchema = z.object({
  branchId: z.string().uuid().optional(),
  vehicleNumber: z.string().min(1).max(40),
  type: z.enum(["AC", "NON_AC", "ICU", "FREEZER"]).optional(),
  driverName: z.string().max(150).optional(),
  driverPhone: z.string().max(20).optional(),
  baseRate: z.number().nonnegative().optional(),
  perKmRate: z.number().nonnegative().optional(),
  fuelType: z.string().max(30).optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
});

const dispatchSchema = z.object({
  ambulanceId: z.string().uuid(),
  patientId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  callerName: z.string().max(150).optional(),
  callerPhone: z.string().max(20).optional(),
  pickup: z.string().min(1).max(200),
  destination: z.string().min(1).max(200),
  notes: z.string().optional(),
});

const completeSchema = z.object({
  distanceKm: z.number().nonnegative(),
  feeOverride: z.number().nonnegative().optional(),
  initialPayment: z
    .object({
      amount: z.number().positive(),
      method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]),
      referenceNo: z.string().optional(),
    })
    .optional(),
});

ambulanceRouter.use(authenticate, requireFeature("ambulance"), requireRoles(...STAFF));

ambulanceRouter.get("/vehicles", asyncHandler(ctrl.listVehicles));
ambulanceRouter.post("/vehicles", requireRoles(...ADMIN), validate(vehicleSchema), asyncHandler(ctrl.createVehicle));
ambulanceRouter.put("/vehicles/:id", requireRoles(...ADMIN), validate(vehicleSchema.partial()), asyncHandler(ctrl.updateVehicle));
ambulanceRouter.delete("/vehicles/:id", requireRoles(...ADMIN), asyncHandler(ctrl.archiveVehicle));

ambulanceRouter.get("/trips", asyncHandler(ctrl.listTrips));
ambulanceRouter.post("/trips", validate(dispatchSchema), asyncHandler(ctrl.dispatchTrip));
ambulanceRouter.post("/trips/:id/start", asyncHandler(ctrl.startTrip));
ambulanceRouter.post("/trips/:id/complete", validate(completeSchema), asyncHandler(ctrl.completeTrip));
ambulanceRouter.post("/trips/:id/cancel", asyncHandler(ctrl.cancelTrip));
