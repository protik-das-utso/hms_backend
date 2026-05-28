import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db";
import { ApiError } from "./ApiError";

// In-memory cache of {tenantId -> isPlatform} keyed on the JWT's tenantId. The
// flag never changes per-tenant in practice, so caching avoids one DB lookup
// per platform-admin request. The cache is tiny — one entry per logged-in
// platform admin — and we tolerate the (rare) propagation lag if a tenant is
// manually flipped to/from platform: it'll be a short-lived inconsistency that
// resolves on app restart or when the entry ages out.
const ttlMs = 5 * 60 * 1000;
const cache = new Map<string, { isPlatform: boolean; expiresAt: number }>();

const isPlatformTenant = async (tenantId: string): Promise<boolean> => {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.isPlatform;
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { isPlatform: true },
  });
  const v = !!t?.isPlatform;
  cache.set(tenantId, { isPlatform: v, expiresAt: Date.now() + ttlMs });
  return v;
};

/**
 * Allows only SUPER_ADMIN users of the platform tenant. The platform tenant is
 * the single Tenant row with `isPlatform: true` — it owns the SaaS itself, and
 * its admins manage every other tenant's plan, invoices, and suspensions.
 */
export const requirePlatformAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) return next(ApiError.unauthorized());
  if (req.auth.role !== "SUPER_ADMIN") {
    return next(ApiError.forbidden("Platform admin access only"));
  }
  try {
    const ok = await isPlatformTenant(req.auth.tenantId);
    if (!ok) return next(ApiError.forbidden("Platform admin access only"));
    next();
  } catch (e) {
    next(e);
  }
};

/** Same as the above check but as a boolean — for use inside controllers. */
export const isPlatformAdmin = async (req: Request): Promise<boolean> => {
  if (!req.auth || req.auth.role !== "SUPER_ADMIN") return false;
  return isPlatformTenant(req.auth.tenantId);
};
