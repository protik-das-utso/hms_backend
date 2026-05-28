import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles, requireFeature } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import * as ctrl from "./admissions.controller";
import { downloadDischargeSummaryPdf } from "./discharge-summary.pdf";
import { runDailyBedCharges } from "../../jobs/ipdDailyCharges";
import { ok } from "../../utils/apiResponse";

export const admissionsRouter = Router();

const CLINICAL = [
  UserRole.SUPER_ADMIN,
  UserRole.BRANCH_ADMIN,
  UserRole.DOCTOR,
  UserRole.NURSE,
  UserRole.RECEPTIONIST,
];

const admitSchema = z.object({
  patientId: z.string().uuid(),
  bedId: z.string().uuid(),
  admittingDoctorId: z.string().uuid(),
  admittedAt: z.string().optional(),
  diagnosisOnAdmission: z.string().optional(),
  notes: z.string().optional(),
});

const transferSchema = z.object({
  bedId: z.string().uuid(),
  notes: z.string().optional(),
});

const summarySchema = z.object({
  dischargingDoctorId: z.string().uuid(),
  finalDiagnosis: z.string().optional(),
  treatmentSummary: z.string().optional(),
  dischargeAdvice: z.string().optional(),
  followUpDate: z.string().optional(),
});

const dischargeSchema = summarySchema.extend({
  dischargedAt: z.string().optional(),
  leftAgainstAdvice: z.boolean().optional(),
  discountAmount: z.number().nonnegative().optional(),
  vatPercent: z.number().nonnegative().optional(),
  initialPayment: z
    .object({
      amount: z.number().positive(),
      method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]),
      referenceNo: z.string().optional(),
    })
    .optional(),
});

admissionsRouter.use(authenticate, requireFeature("ipd"));
admissionsRouter.post(
  "/run-daily-charges",
  requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN),
  asyncHandler(async (_req, res) => {
    const result = await runDailyBedCharges();
    ok(res, result, "Daily bed charges run");
  })
);
admissionsRouter.get("/", asyncHandler(ctrl.list));
admissionsRouter.get("/:id", asyncHandler(ctrl.getOne));
admissionsRouter.get("/:id/discharge-summary.pdf", asyncHandler(downloadDischargeSummaryPdf));
admissionsRouter.post("/", requireRoles(...CLINICAL), validate(admitSchema), asyncHandler(ctrl.admit));
admissionsRouter.post("/:id/transfer", requireRoles(...CLINICAL), validate(transferSchema), asyncHandler(ctrl.transfer));
admissionsRouter.post("/:id/discharge", requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.DOCTOR), validate(dischargeSchema), asyncHandler(ctrl.discharge));
admissionsRouter.put("/:id/summary", requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN, UserRole.DOCTOR), validate(summarySchema), asyncHandler(ctrl.saveSummary));
