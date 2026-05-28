import dayjs from "dayjs";
import { prisma } from "../config/db";
import { ApiError } from "./ApiError";

export type QuotaKind = "branches" | "users" | "patients";

/**
 * Throws ApiError.forbidden (quota exceeded) when the current count is at or
 * over the subscription's limit. Called at the start of create endpoints for
 * the resource being added (branch, user, patient).
 *
 * The "patients" check is for THIS calendar month (Asia/Dhaka tenant-local
 * approximation — we use UTC month boundaries which is close enough).
 *
 * Returns silently when no Subscription row is present (legacy tenants) — we
 * fail open rather than locking everyone out if a clinic was seeded without a
 * subscription. The platform tenant is also exempt.
 */
export const assertQuota = async (tenantId: string, kind: QuotaKind): Promise<void> => {
  const [tenant, sub] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } }),
    prisma.subscription.findUnique({ where: { tenantId } }),
  ]);
  if (!tenant || tenant.isPlatform) return;
  if (!sub) return;

  if (sub.status === "SUSPENDED" || sub.status === "CANCELLED") {
    throw ApiError.forbidden("Subscription is suspended — settle outstanding bills to continue.");
  }

  if (kind === "branches") {
    const used = await prisma.branch.count({ where: { tenantId, isActive: true } });
    if (used >= sub.maxBranches) {
      throw ApiError.forbidden(`Branch quota reached (${used}/${sub.maxBranches}). Upgrade your plan to add more.`);
    }
    return;
  }
  if (kind === "users") {
    const used = await prisma.user.count({ where: { tenantId, deletedAt: null, isActive: true } });
    if (used >= sub.maxUsers) {
      throw ApiError.forbidden(`User quota reached (${used}/${sub.maxUsers}). Upgrade your plan to add more staff.`);
    }
    return;
  }
  if (kind === "patients") {
    const monthStart = dayjs().startOf("month").toDate();
    const used = await prisma.patient.count({
      where: { tenantId, deletedAt: null, createdAt: { gte: monthStart } },
    });
    if (used >= sub.maxPatientsMonth) {
      throw ApiError.forbidden(
        `Monthly patient quota reached (${used}/${sub.maxPatientsMonth}). Upgrade your plan to register more.`
      );
    }
    return;
  }
};

/**
 * Like assertQuota but returns a summary instead of throwing — useful for the
 * tenant settings page to show "X/Y branches used".
 */
export const usageSnapshot = async (tenantId: string) => {
  const [sub, branches, users, patientsMonth, patientsTotal] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId } }),
    prisma.branch.count({ where: { tenantId, isActive: true } }),
    prisma.user.count({ where: { tenantId, deletedAt: null, isActive: true } }),
    prisma.patient.count({
      where: { tenantId, deletedAt: null, createdAt: { gte: dayjs().startOf("month").toDate() } },
    }),
    prisma.patient.count({ where: { tenantId, deletedAt: null } }),
  ]);
  return {
    branches: { used: branches, max: sub?.maxBranches ?? null },
    users: { used: users, max: sub?.maxUsers ?? null },
    patientsThisMonth: { used: patientsMonth, max: sub?.maxPatientsMonth ?? null },
    patientsTotal,
  };
};
