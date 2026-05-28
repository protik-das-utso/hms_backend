import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { UserRole } from "@prisma/client";

// Cache user (role, isActive) for a short window so we don't issue an extra
// SELECT on every authenticated request. 15s is short enough that a
// demote/deactivate takes effect within the user's next page load, and long
// enough to absorb the typical click-through burst.
const TTL = 15_000;
const cache = new Map<string, { role: UserRole; isActive: boolean; expiresAt: number }>();

/** Forces a fresh read on next access. Call after edit/disable user. */
export const invalidateUser = (userId: string): void => {
  cache.delete(userId);
};

/**
 * Re-validate the JWT-asserted user against current DB state. Catches:
 *   - Demoted role (JWT still says DOCTOR but DB says RECEPTIONIST).
 *   - Deactivated user (`isActive=false`).
 *   - Soft-deleted user (`deletedAt` set).
 *
 * Without this, a demoted/deactivated user keeps full access for the
 * remainder of the access-token TTL (15 min by default).
 */
export const revalidateUser = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.auth) return next();
  // Skip for the patient portal (sub === patientId, not a User row).
  if (req.auth.role === "PATIENT") return next();

  const cached = cache.get(req.auth.sub);
  let role: UserRole;
  let isActive: boolean;

  if (cached && cached.expiresAt > Date.now()) {
    role = cached.role;
    isActive = cached.isActive;
  } else {
    const user = await prisma.user.findFirst({
      where: { id: req.auth.sub, tenantId: req.auth.tenantId, deletedAt: null },
      select: { role: true, isActive: true },
    });
    if (!user) {
      cache.delete(req.auth.sub);
      return next(ApiError.unauthorized("User account no longer exists"));
    }
    role = user.role;
    isActive = user.isActive;
    cache.set(req.auth.sub, { role, isActive, expiresAt: Date.now() + TTL });
  }

  if (!isActive) {
    return next(ApiError.unauthorized("User account is disabled"));
  }
  // If the role changed since the JWT was issued, override the JWT's claim
  // with the live value so requirePermission resolves against the current
  // role. The user keeps their session but with reduced privileges.
  if (req.auth.role !== role) {
    req.auth.role = role;
  }
  next();
};
