import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";

// Endpoints that a SUSPENDED tenant can still hit. Everything else is blocked.
// We deliberately keep this list short and read-only-ish: the user can still
// log in, see what they owe, and pay subscription invoices. They cannot
// register patients, write reports, dispense medicine, etc.
const SUSPENDED_ALLOW: RegExp[] = [
  /^\/auth\b/,
  /^\/me\b/,
  /^\/subscription-invoices(\/[^/]+)?$/, // list + getOne
  /^\/subscription-invoices\/[^/]+\/payments\b/, // record subscription payment
  /^\/notifications\b/,
  /^\/health$/,
];

const isSuspendedAllowed = (originalUrl: string): boolean => {
  // Strip query string for matching.
  const path = originalUrl.split("?")[0];
  // Strip API prefix if present (the middleware is mounted under it).
  const stripped = path.replace(/^\/api\/v\d+/, "");
  return SUSPENDED_ALLOW.some((rx) => rx.test(stripped));
};

/**
 * Refuse to serve mutating traffic for tenants whose subscription is
 * SUSPENDED, CANCELLED, or EXPIRED. Read-only endpoints (and the payment
 * surface so they can settle their bill) remain reachable.
 *
 * The platform tenant is exempt. Tenants without a Subscription row are
 * also exempt (legacy/seeded clinics).
 */
export const enforceSubscription = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.auth) return next();
  // Platform admin always passes.
  if (req.auth.role === "SUPER_ADMIN" && req.auth.tenantId) {
    const t = await prisma.tenant.findUnique({
      where: { id: req.auth.tenantId },
      select: { isPlatform: true },
    });
    if (t?.isPlatform) return next();
  }
  const sub = await prisma.subscription.findUnique({
    where: { tenantId: req.auth.tenantId },
    select: { status: true },
  });
  if (!sub) return next();

  const blocked =
    sub.status === "SUSPENDED" ||
    sub.status === "CANCELLED" ||
    sub.status === "EXPIRED";
  if (!blocked) return next();

  if (isSuspendedAllowed(req.originalUrl)) return next();

  // Block writes always. Allow GETs to /me-style read endpoints already covered
  // above; everything else returns 402-style payment-required.
  return next(
    new ApiError(
      402,
      "Subscription is suspended. Settle outstanding bills to restore access."
    )
  );
};
