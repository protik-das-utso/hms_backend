import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePlatformAdmin } from "../../utils/platformAccess";
import { runSubscriptionLifecycle } from "../../jobs/subscriptionLifecycle";
import { runClinicOpsAlerts } from "../../jobs/clinicOpsAlerts";
import { ok } from "../../utils/apiResponse";
import * as ctrl from "./platform.controller";

export const platformRouter = Router();

platformRouter.use(authenticate, requirePlatformAdmin);

// Manual trigger for the subscription lifecycle cron — useful for testing
// without waiting for 01:00 Dhaka. Idempotent (skips work already done).
platformRouter.post(
  "/cron/subscription-lifecycle",
  asyncHandler(async (_req, res) => {
    const result = await runSubscriptionLifecycle();
    ok(res, result, "Lifecycle pass complete");
  })
);

// Manual trigger for the clinic-ops alerts (invoice-due reminders + pharmacy
// stock digest). Idempotent — uses Notification.relatedTo to skip duplicates.
platformRouter.post(
  "/cron/clinic-ops-alerts",
  asyncHandler(async (_req, res) => {
    const result = await runClinicOpsAlerts();
    ok(res, result, "Clinic ops alerts pass complete");
  })
);

platformRouter.get("/overview", asyncHandler(ctrl.overview));
platformRouter.get("/tenants", asyncHandler(ctrl.listTenants));
platformRouter.get("/tenants/:id", asyncHandler(ctrl.getTenant));

const changePlanSchema = z.object({
  planCode: z.string().min(1).max(40),
  resetCycle: z.boolean().optional(),
});
platformRouter.post("/tenants/:id/change-plan", validate(changePlanSchema), asyncHandler(ctrl.changePlan));

const statusSchema = z.object({
  status: z.enum(["ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED", "TRIAL"]),
  reason: z.string().optional().or(z.literal("")),
});
platformRouter.post("/tenants/:id/status", validate(statusSchema), asyncHandler(ctrl.setStatus));

// ─── Tenant profile / internal notes ────────────────────────
const updateTenantSchema = z.object({
  name: z.string().max(150).optional(),
  contactEmail: z.string().email().max(200).optional().or(z.literal("")),
  contactPhone: z.string().max(20).optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  platformNotes: z.string().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});
platformRouter.put("/tenants/:id", validate(updateTenantSchema), asyncHandler(ctrl.updateTenant));

// ─── Direct subscription edit ───────────────────────────────
const subscriptionSchema = z.object({
  monthlyPrice: z.coerce.number().min(0).optional(),
  maxBranches: z.coerce.number().int().min(1).max(9999).optional(),
  maxUsers: z.coerce.number().int().min(1).max(99999).optional(),
  maxPatientsMonth: z.coerce.number().int().min(1).max(9_999_999).optional(),
  maxStorageGb: z.coerce.number().int().min(1).max(99999).optional(),
  billingCycle: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
  status: z.enum(["ACTIVE", "TRIAL", "PAST_DUE", "SUSPENDED", "CANCELLED", "EXPIRED"]).optional(),
  trialEndsAt: z.string().optional().or(z.literal("")).nullable(),
  billingCycleStart: z.string().optional().or(z.literal("")).nullable(),
  billingCycleEnd: z.string().optional().or(z.literal("")).nullable(),
  nextBillingDate: z.string().optional().or(z.literal("")).nullable(),
  paymentMethodNote: z.string().optional().or(z.literal("")).nullable(),
});
platformRouter.put("/tenants/:id/subscription", validate(subscriptionSchema), asyncHandler(ctrl.updateSubscription));

// ─── Tenant users + password reset ──────────────────────────
platformRouter.get("/tenants/:id/users", asyncHandler(ctrl.listTenantUsers));
platformRouter.post("/tenants/:id/users/:userId/reset-password", asyncHandler(ctrl.resetTenantUserPassword));
