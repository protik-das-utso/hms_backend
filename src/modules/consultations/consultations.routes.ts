import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./consultations.controller";

export const consultationsRouter = Router();

const CLINICAL = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.DOCTOR,
];
const CLINICAL_WITH_NURSE = [...CLINICAL, UserRole.NURSE];

const updateSchema = z.object({
  chiefComplaint: z.string().optional(),
  historyOfPresentIllness: z.string().optional(),
  examination: z.string().optional(),
  vitals: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  notes: z.string().optional(),
  followUpDate: z.string().nullable().optional(),
  diagnoses: z
    .array(z.object({ icdCode: z.string().max(20), icdTerm: z.string().max(255), note: z.string().optional() }))
    .optional(),
  prescription: z
    .object({
      notes: z.string().optional(),
      advice: z.string().optional(),
      items: z.array(
        z.object({
          medicineName: z.string().min(1).max(200),
          dosage: z.string().max(100).optional(),
          frequency: z.string().max(100).optional(),
          durationDays: z.number().int().positive().optional(),
          instructions: z.string().max(255).optional(),
        })
      ),
    })
    .optional(),
});

const completeSchema = z.object({
  fee: z.number().nonnegative().optional(),
  chargePatient: z.boolean().optional(),
});

consultationsRouter.use(authenticate, requireFeature("opd"));

consultationsRouter.post(
  "/from-appointment/:appointmentId",
  requireRoles(...CLINICAL_WITH_NURSE),
  asyncHandler(ctrl.startFromAppointment)
);
consultationsRouter.get("/:id", asyncHandler(ctrl.getOne));
consultationsRouter.put(
  "/:id",
  requireRoles(...CLINICAL_WITH_NURSE),
  validate(updateSchema),
  asyncHandler(ctrl.update)
);
consultationsRouter.post(
  "/:id/complete",
  requireRoles(...CLINICAL),
  validate(completeSchema),
  asyncHandler(ctrl.complete)
);
