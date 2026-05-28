import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./blood-bank.controller";

export const bloodBankRouter = Router();

const STAFF = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.LAB_TECHNICIAN,
  UserRole.DOCTOR,
  UserRole.NURSE,
  UserRole.RECEPTIONIST,
];

const BLOOD_GROUPS = ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"] as const;
const COMPONENTS = ["WHOLE_BLOOD", "PRBC", "FFP", "PLATELET", "CRYOPRECIPITATE"] as const;
const SCREENING = ["PENDING", "NEGATIVE", "POSITIVE"] as const;

const donorSchema = z.object({
  name: z.string().min(1).max(150),
  phone: z.string().min(6).max(20),
  email: z.string().max(200).optional().or(z.literal("")),
  nid: z.string().max(20).optional(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  dob: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  address: z.string().optional(),
  occupation: z.string().max(100).optional(),
  optInContact: z.boolean().optional(),
  notes: z.string().optional(),
});

const receiveBagSchema = z.object({
  donorId: z.string().uuid().optional(),
  bagNumber: z.string().min(1).max(40),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(COMPONENTS).optional(),
  volumeMl: z.number().int().positive().optional(),
  collectedOn: z.string().min(1),
  expiryDays: z.number().int().positive().optional(),
  storageLocation: z.string().max(60).optional(),
  notes: z.string().optional(),
});

const screeningSchema = z.object({
  hbsAg: z.enum(SCREENING).optional(),
  hiv: z.enum(SCREENING).optional(),
  hcv: z.enum(SCREENING).optional(),
  vdrl: z.enum(SCREENING).optional(),
  malaria: z.enum(SCREENING).optional(),
  notes: z.string().optional(),
});

const issueSchema = z.object({
  bagId: z.string().uuid(),
  patientId: z.string().uuid(),
  admissionId: z.string().uuid().optional(),
  crossmatchResult: z.string().min(1).max(40),
  fee: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

bloodBankRouter.use(authenticate, requireFeature("bloodbank"), requireRoles(...STAFF));

// Donors
bloodBankRouter.get("/donors", asyncHandler(ctrl.listDonors));
bloodBankRouter.get("/donors/find", asyncHandler(ctrl.findDonors));
bloodBankRouter.post("/donors", validate(donorSchema), asyncHandler(ctrl.createDonor));
bloodBankRouter.put("/donors/:id", validate(donorSchema.partial()), asyncHandler(ctrl.updateDonor));
bloodBankRouter.delete("/donors/:id", asyncHandler(ctrl.archiveDonor));

// Bags / inventory
bloodBankRouter.get("/bags", asyncHandler(ctrl.listBags));
bloodBankRouter.get("/inventory/summary", asyncHandler(ctrl.inventorySummary));
bloodBankRouter.post("/bags", validate(receiveBagSchema), asyncHandler(ctrl.receiveBag));
bloodBankRouter.put("/bags/:id/screening", validate(screeningSchema), asyncHandler(ctrl.updateScreening));
bloodBankRouter.post("/issue", validate(issueSchema), asyncHandler(ctrl.issueBag));
