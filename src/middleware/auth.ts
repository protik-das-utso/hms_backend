import { Request, Response, NextFunction } from "express";
import { verifyAccessToken, AccessPayload } from "../utils/jwt";
import { ApiError } from "../utils/ApiError";
import { UserRole } from "@prisma/client";
import { hasPermission } from "../auth/permissionResolver";
import { ALL_CODES } from "../auth/permissions";
import { hasFeature } from "../features/featureResolver";
import { ALL_FEATURE_CODES, getFeature } from "../features/features";
import { enforceSubscription } from "./enforceSubscription";
import { revalidateUser } from "./revalidateUser";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessPayload;
    }
  }
}

const verifyAuth = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(ApiError.unauthorized("Missing or invalid Authorization header"));
  }
  const token = header.slice(7);
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch {
    next(ApiError.unauthorized("Invalid or expired token"));
  }
};

/**
 * Authenticate + revalidate user (role/isActive can change mid-session) +
 * enforce that the tenant's subscription isn't suspended for write paths.
 * Mounted on every protected route via .use(authenticate).
 */
export const authenticate = [verifyAuth, revalidateUser, enforceSubscription];

export const requireRoles =
  (...roles: UserRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!roles.includes(req.auth.role as UserRole)) {
      return next(ApiError.forbidden("You do not have permission to access this resource"));
    }
    next();
  };

/**
 * Permission-based gate. Resolves the (tenant, role) → permission via the
 * RBAC layer (defaults + tenant overrides set by SUPER_ADMIN). SUPER_ADMIN
 * always passes.
 *
 * Use alongside or instead of requireRoles. Where you keep requireRoles, the
 * permission check runs on top and either gate can deny.
 *
 * Unknown codes are rejected at registration time — if you typo the code,
 * the server logs a warning and the request is denied.
 */
export const requirePermission =
  (code: string) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    if (!ALL_CODES.has(code)) {
      // eslint-disable-next-line no-console
      console.warn(`[requirePermission] Unknown permission code: ${code}`);
      return next(ApiError.forbidden("Permission not configured"));
    }
    if (!req.auth) return next(ApiError.unauthorized());
    try {
      const allowed = await hasPermission(
        req.auth.tenantId,
        req.auth.role as UserRole,
        code
      );
      if (!allowed) return next(ApiError.forbidden(`Missing permission: ${code}`));
      next();
    } catch (e) {
      next(e);
    }
  };

/**
 * Feature-based gate. Returns 403 "Upgrade your plan to access X" when the
 * tenant doesn't have the feature enabled in their plan (or via per-tenant
 * override set by the platform owner).
 *
 * Pair with requirePermission for fine-grained control — feature checks the
 * module is unlocked at all; permission checks if this role can use it.
 */
export const requireFeature =
  (code: string) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    if (!ALL_FEATURE_CODES.has(code)) {
      // eslint-disable-next-line no-console
      console.warn(`[requireFeature] Unknown feature code: ${code}`);
      return next(ApiError.forbidden("Feature not configured"));
    }
    if (!req.auth) return next(ApiError.unauthorized());
    try {
      const allowed = await hasFeature(req.auth.tenantId, code);
      if (!allowed) {
        const label = getFeature(code)?.label ?? code;
        // 402 Payment Required is the semantic fit but most clients handle 403.
        return next(ApiError.forbidden(`${label} is not in your plan. Upgrade to unlock.`));
      }
      next();
    } catch (e) {
      next(e);
    }
  };
