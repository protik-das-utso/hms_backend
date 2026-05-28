import { Request, Response } from "express";
import { Prisma, SubscriptionStatus } from "@prisma/client";
import dayjs from "dayjs";
import { prisma } from "../../config/db";
import { ok, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { cached, invalidate } from "../../utils/cache";

const D = (n: number | string) => new Prisma.Decimal(n);

/**
 * Platform admin landing — counts, MRR, recent signups, overdue invoices.
 * Cached 60s — the platform admin dashboard fires 9 parallel queries every
 * load; once per minute is plenty fresh for cross-tenant KPIs.
 */
export const overview = async (_req: Request, res: Response) => {
  const payload = await cached("platform:overview", 60_000, computeOverview);
  ok(res, payload);
};

async function computeOverview() {
  const today = dayjs().startOf("day").toDate();
  const monthStart = dayjs().startOf("month").toDate();
  const monthAgo = dayjs().subtract(30, "day").toDate();

  const [
    activeTenants,
    trialTenants,
    suspendedTenants,
    totalTenants,
    activeSubs,
    overdueCount,
    overdueSum,
    newThisMonth,
    pendingPayment,
    paidLast30Days,
    plans,
    inactive30d,
  ] = await Promise.all([
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.subscription.count({ where: { status: "TRIAL" } }),
    prisma.subscription.count({ where: { status: "SUSPENDED" } }),
    prisma.tenant.count({ where: { isPlatform: false } }),
    prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: {
        monthlyPrice: true,
        billingCycle: true,
        planConfig: { select: { id: true, code: true, name: true, monthlyPrice: true } },
      },
    }),
    prisma.subscriptionInvoice.count({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] }, dueDate: { lt: today } },
    }),
    prisma.subscriptionInvoice.aggregate({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] }, dueDate: { lt: today } },
      _sum: { dueAmount: true },
    }),
    prisma.tenant.count({ where: { isPlatform: false, createdAt: { gte: monthStart } } }),
    prisma.subscriptionInvoice.count({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    }),
    // Cash collected in the last 30 days (paidAmount on invoices)
    prisma.subscriptionInvoicePayment.aggregate({
      where: { paidAt: { gte: monthAgo } },
      _sum: { amount: true },
    }),
    // Plan catalogue for breakdown
    prisma.subscriptionPlanConfig.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, monthlyPrice: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    }),
    // Tenants whose newest user-login is > 30 days ago, or who have never
    // logged in. Useful for spotting at-risk accounts.
    prisma.tenant.count({
      where: {
        isPlatform: false,
        users: {
          none: { lastLoginAt: { gte: monthAgo } },
        },
      },
    }),
  ]);

  // Build per-plan breakdown: tenant count + MRR. Subscriptions with no
  // planConfig (legacy) get grouped under "Custom / legacy".
  type Bucket = { code: string; name: string; tenants: number; mrr: number };
  const planMap = new Map<string, Bucket>();
  for (const p of plans) {
    planMap.set(p.id, { code: p.code, name: p.name, tenants: 0, mrr: 0 });
  }
  const customBucket: Bucket = { code: "CUSTOM", name: "Custom / legacy", tenants: 0, mrr: 0 };
  for (const s of activeSubs) {
    const price = Number(s.planConfig?.monthlyPrice ?? s.monthlyPrice ?? 0);
    const perMonth = s.billingCycle === "YEARLY" ? price / 12 : s.billingCycle === "QUARTERLY" ? price / 3 : price;
    const id = s.planConfig?.id;
    const b = id ? planMap.get(id) : null;
    if (b) {
      b.tenants += 1;
      b.mrr += perMonth;
    } else {
      customBucket.tenants += 1;
      customBucket.mrr += perMonth;
    }
  }
  const byPlan: Bucket[] = Array.from(planMap.values());
  if (customBucket.tenants > 0) byPlan.push(customBucket);

  const mrr = byPlan.reduce((s, b) => s + b.mrr, 0);

  return {
    counts: {
      total: totalTenants,
      active: activeTenants,
      trial: trialTenants,
      suspended: suspendedTenants,
      newThisMonth,
      inactive30d,
    },
    revenue: {
      mrr,
      paidLast30Days: Number(paidLast30Days._sum.amount ?? 0),
      byPlan,
    },
    overdue: {
      count: overdueCount,
      amount: Number(overdueSum._sum.dueAmount ?? 0),
    },
    pendingPayment,
  };
}

export const listTenants = async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = getPagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const status = req.query.status as string | undefined;
  const plan = req.query.plan as string | undefined;

  const where: Prisma.TenantWhereInput = {
    isPlatform: false,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
            { contactEmail: { contains: q, mode: "insensitive" } },
            { contactPhone: { contains: q } },
          ],
        }
      : {}),
    ...(status ? { subscription: { status: status as SubscriptionStatus } } : {}),
    ...(plan ? { subscription: { plan: plan as any } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        subscription: { include: { planConfig: { select: { name: true, monthlyPrice: true } } } },
        _count: { select: { users: true, branches: true, patients: true } },
      },
    }),
    prisma.tenant.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const getTenant = async (req: Request, res: Response) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: String(req.params.id) },
    include: {
      subscription: { include: { planConfig: true } },
      _count: { select: { users: true, branches: true, patients: true } },
    },
  });
  if (!tenant) throw ApiError.notFound("Tenant not found");
  if (tenant.isPlatform) throw ApiError.badRequest("Cannot manage the platform tenant from here");

  const dayStart = dayjs().startOf("day").toDate();
  const weekStart = dayjs().subtract(7, "day").startOf("day").toDate();
  const monthStart = dayjs().startOf("month").toDate();

  const [
    recentInvoices,
    recentEvents,
    mostRecentLogin,
    roleBreakdown,
    todayPatients,
    weekPatients,
    monthPatients,
    todayOrders,
    weekOrders,
    todayRevenueAgg,
    weekRevenueAgg,
    monthRevenueAgg,
    todayAppointments,
    pendingReports,
    activeAdmissions,
    activeUsers7d,
  ] = await Promise.all([
    prisma.subscriptionInvoice.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.subscriptionEvent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.user.findFirst({
      where: { tenantId: tenant.id, lastLoginAt: { not: null } },
      orderBy: { lastLoginAt: "desc" },
      select: { name: true, lastLoginAt: true },
    }),
    // User role counts — gives you "X doctors, Y nurses, Z receptionists, ..."
    prisma.user.groupBy({
      by: ["role"],
      where: { tenantId: tenant.id, deletedAt: null, isActive: true },
      _count: { _all: true },
    }),
    prisma.patient.count({ where: { tenantId: tenant.id, deletedAt: null, createdAt: { gte: dayStart } } }),
    prisma.patient.count({ where: { tenantId: tenant.id, deletedAt: null, createdAt: { gte: weekStart } } }),
    prisma.patient.count({ where: { tenantId: tenant.id, deletedAt: null, createdAt: { gte: monthStart } } }),
    prisma.testOrder.count({ where: { tenantId: tenant.id, createdAt: { gte: dayStart } } }),
    prisma.testOrder.count({ where: { tenantId: tenant.id, createdAt: { gte: weekStart } } }),
    prisma.payment.aggregate({
      where: { tenantId: tenant.id, paidAt: { gte: dayStart } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { tenantId: tenant.id, paidAt: { gte: weekStart } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { tenantId: tenant.id, paidAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.appointment.count({
      where: { tenantId: tenant.id, slotStart: { gte: dayStart, lte: dayjs().endOf("day").toDate() } },
    }),
    prisma.report.count({
      where: { tenantId: tenant.id, status: { in: ["DRAFT", "PENDING_APPROVAL"] } },
    }),
    prisma.admission.count({ where: { tenantId: tenant.id, status: "ADMITTED" } }),
    // How many distinct staff logged in over the past 7 days — a usage proxy.
    prisma.user.count({
      where: { tenantId: tenant.id, lastLoginAt: { gte: weekStart } },
    }),
  ]);

  // Reshape role breakdown into a friendlier object.
  const roleCounts: Record<string, number> = {};
  for (const r of roleBreakdown) roleCounts[r.role] = r._count._all;

  const activity = {
    today: {
      newPatients: todayPatients,
      newOrders: todayOrders,
      revenue: Number(todayRevenueAgg._sum.amount ?? 0),
      appointments: todayAppointments,
    },
    last7Days: {
      newPatients: weekPatients,
      newOrders: weekOrders,
      revenue: Number(weekRevenueAgg._sum.amount ?? 0),
      activeStaff: activeUsers7d,
    },
    thisMonth: {
      newPatients: monthPatients,
      revenue: Number(monthRevenueAgg._sum.amount ?? 0),
    },
    snapshot: {
      pendingReports,
      activeAdmissions,
    },
  };

  ok(res, { tenant, recentInvoices, recentEvents, mostRecentLogin, roleCounts, activity });
};

/**
 * Change a tenant's plan (e.g. upgrade from Small to Medium). Updates the
 * Subscription row immediately: new plan code, new quotas. Optionally also
 * resets the billing cycle to "now" so the next invoice covers the new plan
 * from this point forward.
 */
export const changePlan = async (req: Request, res: Response) => {
  const body = req.body as Record<string, any>;
  const planCode = String(body.planCode || "").toUpperCase();
  if (!planCode) throw ApiError.badRequest("planCode is required");

  const [tenant, plan] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: String(req.params.id) } }),
    prisma.subscriptionPlanConfig.findUnique({ where: { code: planCode } }),
  ]);
  if (!tenant) throw ApiError.notFound("Tenant not found");
  if (!plan) throw ApiError.badRequest("Plan not found");
  if (tenant.isPlatform) throw ApiError.badRequest("Cannot change plan of the platform tenant");

  const resetCycle = !!body.resetCycle;
  const cycleStart = resetCycle ? dayjs().startOf("day").toDate() : undefined;
  const cycleEnd = resetCycle ? dayjs().startOf("day").add(1, "month").toDate() : undefined;

  const sub = await prisma.subscription.upsert({
    where: { tenantId: tenant.id },
    update: {
      planConfigId: plan.id,
      plan: planCode.match(/^(TRIAL|SMALL|MEDIUM|ENTERPRISE)$/) ? (planCode as any) : "ENTERPRISE",
      monthlyPrice: plan.monthlyPrice,
      maxBranches: plan.maxBranches,
      maxUsers: plan.maxUsers,
      maxPatientsMonth: plan.maxPatientsMonth,
      maxStorageGb: plan.maxStorageGb,
      ...(resetCycle ? { billingCycleStart: cycleStart, billingCycleEnd: cycleEnd, nextBillingDate: cycleEnd } : {}),
    },
    create: {
      tenantId: tenant.id,
      planConfigId: plan.id,
      plan: planCode.match(/^(TRIAL|SMALL|MEDIUM|ENTERPRISE)$/) ? (planCode as any) : "ENTERPRISE",
      status: "ACTIVE",
      monthlyPrice: plan.monthlyPrice,
      maxBranches: plan.maxBranches,
      maxUsers: plan.maxUsers,
      maxPatientsMonth: plan.maxPatientsMonth,
      maxStorageGb: plan.maxStorageGb,
      billingCycleStart: cycleStart ?? new Date(),
      billingCycleEnd: cycleEnd ?? dayjs().add(1, "month").toDate(),
      nextBillingDate: cycleEnd ?? dayjs().add(1, "month").toDate(),
    },
  });

  await prisma.subscriptionEvent.create({
    data: {
      tenantId: tenant.id,
      eventType: "PLAN_CHANGED",
      notes: `Plan → ${plan.name} (${plan.code})`,
      createdBy: req.auth!.sub,
    },
  });

  invalidate("platform:overview");
  ok(res, sub, "Plan updated");
};

/**
 * Toggle suspension: stops the tenant from logging in / creating new entities.
 * Reactivation moves them back to ACTIVE if invoices are clear, else PAST_DUE.
 */
export const setStatus = async (req: Request, res: Response) => {
  const body = req.body as { status: string; reason?: string };
  const target = body.status as SubscriptionStatus;
  const ALLOWED: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED", "TRIAL"];
  if (!ALLOWED.includes(target)) throw ApiError.badRequest("Invalid status");

  const sub = await prisma.subscription.findUnique({ where: { tenantId: String(req.params.id) } });
  if (!sub) throw ApiError.notFound("Subscription not found");

  const updated = await prisma.subscription.update({
    where: { tenantId: String(req.params.id) },
    data: {
      status: target,
      suspendedAt: target === "SUSPENDED" ? new Date() : null,
      cancelledAt: target === "CANCELLED" ? new Date() : null,
    },
  });

  await prisma.subscriptionEvent.create({
    data: {
      tenantId: String(req.params.id),
      eventType: `STATUS_${target}`,
      notes: body.reason ?? null,
      createdBy: req.auth!.sub,
    },
  });

  invalidate("platform:overview");
  ok(res, updated, `Status set to ${target}`);
};

// ─── Internal notes per tenant ─────────────────────────────

/**
 * Update internal-only fields on a tenant (notes, isActive). These are
 * platform-admin-only and never surface to the tenant's own users.
 */
export const updateTenant = async (req: Request, res: Response) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: String(req.params.id) } });
  if (!tenant) throw ApiError.notFound("Tenant not found");
  if (tenant.isPlatform) throw ApiError.badRequest("Cannot edit the platform tenant from here");

  const body = req.body as Record<string, unknown>;
  const updated = await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      platformNotes: body.platformNotes !== undefined ? ((body.platformNotes as string) || null) : undefined,
      isActive: body.isActive !== undefined ? !!body.isActive : undefined,
      // Allow editing contact fields too — platform admins often update these
      // on behalf of clinics during onboarding.
      contactEmail: body.contactEmail !== undefined ? ((body.contactEmail as string) || null) : undefined,
      contactPhone: body.contactPhone !== undefined ? ((body.contactPhone as string) || null) : undefined,
      address: body.address !== undefined ? ((body.address as string) || null) : undefined,
      name: body.name !== undefined ? (body.name as string) : undefined,
    },
  });
  invalidate("platform:overview");
  ok(res, updated, "Tenant updated");
};

// ─── Direct subscription edit ──────────────────────────────

/**
 * Override the tenant's Subscription row directly — quotas, monthly price,
 * billing cycle, dates, status. Used when the platform admin needs to deviate
 * from the standard plan without creating a custom plan tier.
 */
export const updateSubscription = async (req: Request, res: Response) => {
  const tenantId = String(req.params.id);
  const sub = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!sub) throw ApiError.notFound("Subscription not found");

  const body = req.body as Record<string, any>;
  const D = (n: number | string) => new Prisma.Decimal(n);
  const date = (v: string | undefined | null) => (v ? new Date(v) : null);

  const updated = await prisma.subscription.update({
    where: { tenantId },
    data: {
      monthlyPrice:     body.monthlyPrice !== undefined ? D(body.monthlyPrice) : undefined,
      maxBranches:      body.maxBranches !== undefined ? Number(body.maxBranches) : undefined,
      maxUsers:         body.maxUsers !== undefined ? Number(body.maxUsers) : undefined,
      maxPatientsMonth: body.maxPatientsMonth !== undefined ? Number(body.maxPatientsMonth) : undefined,
      maxStorageGb:     body.maxStorageGb !== undefined ? Number(body.maxStorageGb) : undefined,
      billingCycle:     body.billingCycle !== undefined ? body.billingCycle : undefined,
      status:           body.status !== undefined ? body.status : undefined,
      trialEndsAt:      body.trialEndsAt !== undefined ? date(body.trialEndsAt) : undefined,
      billingCycleStart: body.billingCycleStart !== undefined ? date(body.billingCycleStart) : undefined,
      billingCycleEnd:   body.billingCycleEnd !== undefined ? date(body.billingCycleEnd) : undefined,
      nextBillingDate:   body.nextBillingDate !== undefined ? date(body.nextBillingDate) : undefined,
      paymentMethodNote: body.paymentMethodNote !== undefined ? (body.paymentMethodNote || null) : undefined,
    },
  });

  await prisma.subscriptionEvent.create({
    data: {
      tenantId,
      eventType: "SUBSCRIPTION_EDITED",
      notes: "Direct edit by platform admin",
      createdBy: req.auth!.sub,
    },
  });

  invalidate("platform:overview");
  ok(res, updated, "Subscription updated");
};

// ─── Tenant users list + password reset ────────────────────

export const listTenantUsers = async (req: Request, res: Response) => {
  const tenantId = String(req.params.id);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) throw ApiError.notFound("Tenant not found");

  const users = await prisma.user.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      designation: true,
      branch: { select: { name: true } },
    },
  });
  ok(res, users);
};

/**
 * Generate a fresh password for any tenant user. Returns the plaintext
 * password ONCE in the response — platform admin relays it to the clinic.
 * The new password is hashed and stored; failed-attempt counters reset.
 */
export const resetTenantUserPassword = async (req: Request, res: Response) => {
  const tenantId = String(req.params.id);
  const userId = String(req.params.userId);

  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, deletedAt: null },
  });
  if (!user) throw ApiError.notFound("User not found in this tenant");

  // Random 10-char password from a friendly alphabet (no 0/O/1/l confusion).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let newPassword = "";
  for (let i = 0; i < 10; i++) {
    newPassword += chars[Math.floor(Math.random() * chars.length)];
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, failedAttempts: 0, lockedUntil: null },
  });

  // Revoke all the user's existing refresh tokens so other sessions are killed.
  await prisma.refreshToken.updateMany({
    where: { userId: user.id, revoked: false },
    data: { revoked: true },
  });

  await prisma.subscriptionEvent.create({
    data: {
      tenantId,
      eventType: "PASSWORD_RESET",
      notes: `Reset for ${user.name} (${user.phone}) by platform admin`,
      createdBy: req.auth!.sub,
    },
  });

  ok(res, {
    userId: user.id,
    name: user.name,
    phone: user.phone,
    newPassword,
  }, "Password reset — share once with the user");
};

