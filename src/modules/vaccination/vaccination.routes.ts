import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./vaccination.controller";

export const vaccinationRouter = Router();

const ADMIN = [UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN];
const STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.DOCTOR,
  UserRole.NURSE,
  UserRole.RECEPTIONIST,
];

const vaccineSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  nameBn: z.string().max(120).optional(),
  description: z.string().optional(),
  doseNumber: z.number().int().nonnegative().optional(),
  totalDoses: z.number().int().positive().optional(),
  recommendedAgeText: z.string().max(60).optional(),
  nextDoseDays: z.number().int().nonnegative().nullable().optional(),
  manufacturer: z.string().max(150).optional(),
  defaultFee: z.number().nonnegative().optional(),
  isEpi: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const recordSchema = z.object({
  patientId: z.string().uuid(),
  vaccineId: z.string().uuid(),
  givenAt: z.string().optional(),
  batchNumber: z.string().max(60).optional(),
  nextDueAt: z.string().optional(),
  notes: z.string().optional(),
});

vaccinationRouter.use(authenticate, requireFeature("vaccination"), requireRoles(...STAFF));

// Catalog
vaccinationRouter.get("/vaccines", asyncHandler(ctrl.listVaccines));
vaccinationRouter.post("/vaccines", requireRoles(...ADMIN), validate(vaccineSchema), asyncHandler(ctrl.createVaccine));
vaccinationRouter.put("/vaccines/:id", requireRoles(...ADMIN), validate(vaccineSchema.partial()), asyncHandler(ctrl.updateVaccine));
vaccinationRouter.post("/vaccines/seed-epi", requireRoles(...ADMIN), asyncHandler(ctrl.seedEpi));

// Patient records
vaccinationRouter.get("/patient/:patientId", asyncHandler(ctrl.listForPatient));
vaccinationRouter.post("/record", validate(recordSchema), asyncHandler(ctrl.recordVaccination));

// Due list
vaccinationRouter.get("/due", asyncHandler(ctrl.dueList));
