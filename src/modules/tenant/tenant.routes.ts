import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRoles } from "../../middleware/auth";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UserRole } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { usageSnapshot } from "../../utils/quota";

export const tenantRouter = Router();
tenantRouter.use(authenticate);

// Clinic owner sees current subscription + payment method note
tenantRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const t = await prisma.tenant.findUnique({
      where: { id: req.auth!.tenantId },
      include: { subscription: { include: { planConfig: true } } },
    });
    if (!t) throw ApiError.notFound("Tenant not found");
    ok(res, t);
  })
);

// Usage vs quota for the current tenant — branches/users/patients.
tenantRouter.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const usage = await usageSnapshot(req.auth!.tenantId);
    ok(res, usage);
  })
);

// Tenant subscription invoices (own only). Mirrors /subscription-invoices?tenantId=mine.
tenantRouter.get(
  "/invoices",
  asyncHandler(async (req, res) => {
    const rows = await prisma.subscriptionInvoice.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: "desc" },
      include: { payments: { orderBy: { paidAt: "desc" } } },
      take: 50,
    });
    ok(res, rows);
  })
);

// Tenant requests a plan change. Records the request as a SubscriptionEvent —
// platform admin then approves and runs the actual change.
tenantRouter.post(
  "/subscription/request-plan",
  requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN),
  validate(z.object({ planCode: z.string().min(1).max(40), notes: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const body = req.body as { planCode: string; notes?: string };
    const plan = await prisma.subscriptionPlanConfig.findUnique({ where: { code: body.planCode.toUpperCase() } });
    if (!plan) throw ApiError.badRequest("Plan not found");
    const evt = await prisma.subscriptionEvent.create({
      data: {
        tenantId: req.auth!.tenantId,
        eventType: "PLAN_CHANGE_REQUESTED",
        notes: `Requested: ${plan.name} (${plan.code}). ${body.notes ?? ""}`.trim(),
        createdBy: req.auth!.sub,
      },
    });
    created(res, evt, "Plan change requested — we'll get back to you shortly.");
  })
);

// Update clinic profile (name, address, contact, logo)
tenantRouter.put(
  "/me",
  requireRoles(UserRole.SUPER_ADMIN, UserRole.BRANCH_ADMIN),
  validate(
    z.object({
      name: z.string().min(2).max(150).optional(),
      contactEmail: z.string().email().optional().or(z.literal("")),
      contactPhone: z.string().max(20).optional(),
      address: z.string().optional(),
      logoUrl: z.string().url().optional().or(z.literal("")),
    })
  ),
  asyncHandler(async (req, res) => {
    const updated = await prisma.tenant.update({
      where: { id: req.auth!.tenantId },
      data: req.body,
    });
    ok(res, updated, "Clinic profile updated");
  })
);

// Record a subscription payment (clinic submits a reference, super-admin acknowledges)
// No payment gateway — this is just bookkeeping of the bKash/Nagad/Bank payment the clinic made.
tenantRouter.post(
  "/subscription/record-payment",
  requireRoles(UserRole.SUPER_ADMIN),
  validate(
    z.object({
      amount: z.number().positive(),
      method: z.enum(["CASH", "BKASH", "NAGAD", "ROCKET", "CARD", "BANK_TRANSFER"]),
      referenceNo: z.string().max(100).optional(),
      notes: z.string().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { amount: number; method: "CASH" | "BKASH" | "NAGAD" | "ROCKET" | "CARD" | "BANK_TRANSFER"; referenceNo?: string; notes?: string };
    const evt = await prisma.subscriptionEvent.create({
      data: {
        tenantId: req.auth!.tenantId,
        eventType: "PAYMENT_RECORDED",
        amount: body.amount,
        method: body.method,
        reference: body.referenceNo ?? null,
        notes: body.notes ?? null,
        createdBy: req.auth!.sub,
      },
    });
    created(res, evt, "Subscription payment recorded");
  })
);

// Update subscription payment instruction (what the platform tells clinics how to pay)
tenantRouter.put(
  "/subscription/payment-note",
  requireRoles(UserRole.SUPER_ADMIN),
  validate(z.object({ paymentMethodNote: z.string() })),
  asyncHandler(async (req, res) => {
    const sub = await prisma.subscription.update({
      where: { tenantId: req.auth!.tenantId },
      data: { paymentMethodNote: (req.body as { paymentMethodNote: string }).paymentMethodNote },
    });
    ok(res, sub, "Updated");
  })
);
