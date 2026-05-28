import { Request, Response } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, created } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import {
  PERMISSIONS, ALL_CODES, CONFIGURABLE_ROLES, defaultAllowed,
} from "../../auth/permissions";
import {
  effectivePermissions, invalidateTenant,
} from "../../auth/permissionResolver";

/** Returns the static permission catalogue (no DB hit). */
export const catalogue = async (_req: Request, res: Response) => {
  // Group by module so the UI can render sections.
  const byModule = new Map<string, typeof PERMISSIONS>();
  for (const p of PERMISSIONS) {
    if (!byModule.has(p.module)) byModule.set(p.module, [] as any);
    byModule.get(p.module)!.push(p);
  }
  const modules = Array.from(byModule.entries()).map(([module, items]) => ({
    module,
    items: items.map((i) => ({ code: i.code, label: i.label, description: i.description })),
  }));

  ok(res, {
    roles: CONFIGURABLE_ROLES,
    modules,
    total: PERMISSIONS.length,
  });
};

/**
 * Current matrix for this tenant: shape is { [role]: { [code]: boolean } }.
 * Each entry resolves to the effective value (override > default).
 */
export const matrix = async (req: Request, res: Response) => {
  const tenantId = req.auth!.tenantId;
  const codes = Array.from(ALL_CODES);
  const out: Record<string, Record<string, boolean>> = {};

  for (const role of CONFIGURABLE_ROLES) {
    const eff = await effectivePermissions(tenantId, role, codes);
    out[role] = Object.fromEntries(eff);
  }

  // Also send the rows that are *explicit overrides* (vs defaults) so the UI
  // can show "modified from default" hints. Storage of overrides as boolean
  // means even when override === default, the row exists; the UI compares.
  const overrides = await prisma.rolePermission.findMany({
    where: { tenantId },
    select: { role: true, code: true, allowed: true, updatedAt: true },
  });

  ok(res, { matrix: out, overrides });
};

/**
 * Update a batch of (role, code, allowed) triples. The body is:
 *   { entries: [{ role, code, allowed }] }
 *
 * For each entry, if `allowed` matches the role's default, the row is
 * deleted (we don't store no-op overrides — keeps the matrix easy to reason
 * about). Otherwise upsert.
 *
 * SUPER_ADMIN role cannot be modified; the meta permission
 * "settings:permissions" is also pinned to SUPER_ADMIN only.
 */
export const update = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { sub: userId } = req.auth!;
  const body = req.body as { entries?: Array<{ role: string; code: string; allowed: boolean }> };
  const entries = body.entries ?? [];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw ApiError.badRequest("entries[] is required");
  }
  if (entries.length > 1000) throw ApiError.badRequest("Too many entries in one request");

  let changed = 0;
  await prisma.$transaction(async (tx) => {
    for (const e of entries) {
      if (!CONFIGURABLE_ROLES.includes(e.role as UserRole)) {
        throw ApiError.badRequest(`Role ${e.role} cannot be configured`);
      }
      if (!ALL_CODES.has(e.code)) {
        throw ApiError.badRequest(`Unknown permission code: ${e.code}`);
      }
      if (e.code === "settings:permissions") {
        throw ApiError.badRequest("settings:permissions is reserved to SUPER_ADMIN");
      }

      const role = e.role as UserRole;
      const def = defaultAllowed(role, e.code);
      const desired = !!e.allowed;

      if (desired === def) {
        // Clear any override so we revert to default.
        await tx.rolePermission.deleteMany({
          where: { tenantId, role, code: e.code },
        });
      } else {
        await tx.rolePermission.upsert({
          where: { tenantId_role_code: { tenantId, role, code: e.code } },
          create: { tenantId, role, code: e.code, allowed: desired, updatedById: userId },
          update: { allowed: desired, updatedById: userId },
        });
      }
      changed++;
    }
  });

  invalidateTenant(tenantId);
  ok(res, { changed }, `${changed} permission${changed === 1 ? "" : "s"} updated`);
};

/** Wipe all per-tenant overrides — revert every role to defaults. */
export const reset = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { count } = await prisma.rolePermission.deleteMany({ where: { tenantId } });
  invalidateTenant(tenantId);
  ok(res, { cleared: count }, "All role permissions reset to defaults");
};

/**
 * Public-ish endpoint: returns the calling user's own effective permissions.
 * Used by the frontend to hide UI affordances they can't act on (e.g. don't
 * show the "Refund" button if the user lacks invoices:refund).
 *
 * No tenant scoping needed — the user is asking about themselves.
 */
export const mine = async (req: Request, res: Response) => {
  const role = req.auth!.role as UserRole;
  const tenantId = req.auth!.tenantId;
  const codes = Array.from(ALL_CODES);
  const eff = await effectivePermissions(tenantId, role, codes);
  ok(res, { role, permissions: Object.fromEntries(eff) });
};
