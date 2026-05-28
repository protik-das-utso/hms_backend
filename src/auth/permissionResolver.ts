import { UserRole } from "@prisma/client";
import { prisma } from "../config/db";
import { defaultAllowed } from "./permissions";

/**
 * Cached "overrides per (tenant, role)" map. The cache value is a Map<code,
 * boolean>. Cache is invalidated when an admin updates the matrix (see
 * invalidateTenant below).
 *
 * The cache prevents a DB hit on every authorised request. Without it,
 * requirePermission would issue 1 query per route hit, which adds up across
 * concurrent users.
 */
type RoleOverrides = Map<string /* code */, boolean>;
type TenantCache = Map<UserRole, RoleOverrides>;

const ttlMs = 60_000; // 1 minute
const cache = new Map<string /* tenantId */, { data: TenantCache; expiresAt: number }>();

/** Drop the cached overrides for a tenant — called after the matrix is edited. */
export const invalidateTenant = (tenantId: string): void => {
  cache.delete(tenantId);
};

const loadOverrides = async (tenantId: string): Promise<TenantCache> => {
  const rows = await prisma.rolePermission.findMany({
    where: { tenantId },
    select: { role: true, code: true, allowed: true },
  });
  const map: TenantCache = new Map();
  for (const r of rows) {
    if (!map.has(r.role)) map.set(r.role, new Map());
    map.get(r.role)!.set(r.code, r.allowed);
  }
  return map;
};

const getTenantCache = async (tenantId: string): Promise<TenantCache> => {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const fresh = await loadOverrides(tenantId);
  cache.set(tenantId, { data: fresh, expiresAt: Date.now() + ttlMs });
  return fresh;
};

/**
 * Has the (tenant, role) been granted the permission?
 *
 *   1. SUPER_ADMIN always returns true (cannot be locked out of own tenant).
 *   2. Per-tenant override (if present) wins over default.
 *   3. Otherwise the role's hard-coded default applies.
 */
export const hasPermission = async (
  tenantId: string,
  role: UserRole,
  code: string
): Promise<boolean> => {
  if (role === "SUPER_ADMIN") return true;
  const tenantOverrides = await getTenantCache(tenantId);
  const override = tenantOverrides.get(role)?.get(code);
  if (override !== undefined) return override;
  return defaultAllowed(role, code);
};

/** Resolve all permission codes a role currently has (defaults + overrides). */
export const effectivePermissions = async (
  tenantId: string,
  role: UserRole,
  allCodes: string[]
): Promise<Map<string, boolean>> => {
  const out = new Map<string, boolean>();
  if (role === "SUPER_ADMIN") {
    for (const c of allCodes) out.set(c, true);
    return out;
  }
  const tenantOverrides = await getTenantCache(tenantId);
  const overrides = tenantOverrides.get(role) ?? new Map<string, boolean>();
  for (const c of allCodes) {
    const o = overrides.get(c);
    out.set(c, o !== undefined ? o : defaultAllowed(role, c));
  }
  return out;
};
