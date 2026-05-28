import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./ot.controller";

export const otRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];
const CLINICAL = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.DOCTOR,
  UserRole.NURSE,
];

const roomSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1).max(80),
  notes: z.string().optional(),
});

const bookingSchema = z.object({
  operatingRoomId: z.string().uuid(),
  patientId: z.string().uuid(),
  admissionId: z.string().uuid().optional(),
  surgeonId: z.string().uuid(),
  procedureName: z.string().min(1).max(200),
  anesthesiaType: z.string().max(60).optional(),
  anesthesiologistId: z.string().uuid().optional(),
  assistantIds: z.array(z.string().uuid()).optional(),
  nurseIds: z.array(z.string().uuid()).optional(),
  scheduledStart: z.string().min(1),
  scheduledEnd: z.string().min(1),
  fee: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

const noteSchema = z.object({
  preOpDiagnosis: z.string().optional(),
  postOpDiagnosis: z.string().optional(),
  procedureNotes: z.string().optional(),
  findings: z.string().optional(),
  complications: z.string().optional(),
  estimatedBloodLossMl: z.number().int().nonnegative().nullable().optional(),
  specimensCollected: z.string().optional(),
  anesthesiaNotes: z.string().optional(),
  anesthesiaStart: z.string().optional().nullable(),
  anesthesiaEnd: z.string().optional().nullable(),
});

otRouter.use(authenticate, requireFeature("ot"));

otRouter.get("/rooms", asyncHandler(ctrl.listRooms));
otRouter.post("/rooms", requireRoles(...ADMIN), validate(roomSchema), asyncHandler(ctrl.createRoom));
otRouter.put("/rooms/:id", requireRoles(...ADMIN), validate(roomSchema.partial().extend({ isActive: z.boolean().optional() })), asyncHandler(ctrl.updateRoom));
otRouter.delete("/rooms/:id", requireRoles(...ADMIN), asyncHandler(ctrl.archiveRoom));

otRouter.get("/bookings", asyncHandler(ctrl.listBookings));
otRouter.get("/bookings/:id", asyncHandler(ctrl.getBooking));
otRouter.post("/bookings", requireRoles(...CLINICAL), validate(bookingSchema), asyncHandler(ctrl.createBooking));
otRouter.post("/bookings/:id/start", requireRoles(...CLINICAL), asyncHandler(ctrl.startBooking));
otRouter.post("/bookings/:id/complete", requireRoles(...CLINICAL), validate(z.object({ feeOverride: z.number().nonnegative().optional() })), asyncHandler(ctrl.completeBooking));
otRouter.post("/bookings/:id/cancel", requireRoles(...CLINICAL), asyncHandler(ctrl.cancelBooking));
otRouter.put("/bookings/:id/note", requireRoles(...CLINICAL), validate(noteSchema), asyncHandler(ctrl.updateNote));
