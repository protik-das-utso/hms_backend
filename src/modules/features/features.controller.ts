import { Request, Response } from "express";
import { prisma } from "../../config/db";
import { ok } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { FEATURES, ALL_FEATURE_CODES, isCoreFeature } from "../../features/features";
import {
  tenantFeatureMap, invalidateTenantFeatures, invalidateAllFeatureCaches,
} from "../../features/featureResolver";

/** Public catalogue — every feature with label/description. */
export const catalogue = async (_req: Request, res: Response) => {
  // Group by module for the UI.
  const byModule = new Map<string, typeof FEATURES>();
  for (const f of FEATURES) {
    if (!byModule.has(f.module)) byModule.set(f.module, [] as any);
    byModule.get(f.module)!.push(f);
  }
  ok(res, {
    modules: Array.from(byModule.entries()).map(([module, items]) => ({
      module,
      items: items.map((i) => ({
        code: i.code,
        label: i.label,
        description: i.description,
        core: !!i.core,
      })),
    })),
    total: FEATURES.length,
  });
};

/** Caller's tenant feature map — used by the sidebar to hide locked modules. */
export const mine = async (req: Request, res: Response) => {
  const map = await tenantFeatureMap(req.auth!.tenantId);
  ok(res, { features: map });
};

/**
 * Update plan-level feature toggles. Platform-admin only (mounted under
 * the platform router so the requirePlatformAdmin middleware enforces it).
 *
 * Body: { features: { code: boolean, ... } }
 */
export const updatePlanFeatures = async (req: Request, res: Response) => {
  const plan = await prisma.subscriptionPlanConfig.findUnique({
    where: { id: String(req.params.id) },
  });
  if (!plan) throw ApiError.notFound("Plan not found");

  const features = (req.body as { features?: Record<string, boolean> }).features ?? {};
  // Strict whitelist: only known feature codes get persisted.
  const sanitised: Record<string, boolean> = {};
  for (const [code, val] of Object.entries(features)) {
    if (!ALL_FEATURE_CODES.has(code)) continue;
    if (isCoreFeature(code)) continue; // core always on, ignore
    sanitised[code] = !!val;
  }

  const updated = await prisma.subscriptionPlanConfig.update({
    where: { id: plan.id },
    data: { features: sanitised },
  });

  // Plan features changed — every tenant on this plan needs cache cleared.
  invalidateAllFeatureCaches();
  ok(res, updated, "Plan features updated");
};

/**
 * Update tenant-level feature overrides. Body: { features: { code: boolean, ... } }.
 * Pass an empty object (or omit the key) to remove an override and revert to
 * plan default.
 */
export const updateTenantFeatures = async (req: Request, res: Response) => {
  const sub = await prisma.subscription.findUnique({
    where: { tenantId: String(req.params.id) },
  });
  if (!sub) throw ApiError.notFound("Tenant subscription not found");

  const features = (req.body as { features?: Record<string, boolean> }).features ?? {};
  const sanitised: Record<string, boolean> = {};
  for (const [code, val] of Object.entries(features)) {
    if (!ALL_FEATURE_CODES.has(code)) continue;
    if (isCoreFeature(code)) continue;
    sanitised[code] = !!val;
  }
  // If the override matches the plan default, store nothing for that key
  // (cleaner storage; tenant simply inherits). Match check happens later in
  // resolution, so we keep the override as long as the admin explicitly set
  // one — that way "force enable, even if plan changes" still works.

  const updated = await prisma.subscription.update({
    where: { tenantId: String(req.params.id) },
    data: { featureOverrides: Object.keys(sanitised).length ? sanitised : null },
  });

  invalidateTenantFeatures(String(req.params.id));
  ok(res, updated, "Tenant feature overrides updated");
};

/**
 * Read a tenant's effective feature map (with the override JSON, plan
 * features, and resolved final state). Used by the platform admin UI.
 */
export const tenantFeatureView = async (req: Request, res: Response) => {
  const sub = await prisma.subscription.findUnique({
    where: { tenantId: String(req.params.id) },
    include: { planConfig: { select: { code: true, name: true, features: true } } },
  });
  if (!sub) throw ApiError.notFound("Tenant subscription not found");

  const effective = await tenantFeatureMap(String(req.params.id));
  ok(res, {
    plan: sub.planConfig
      ? {
          code: sub.planConfig.code,
          name: sub.planConfig.name,
          features: sub.planConfig.features ?? {},
        }
      : null,
    overrides: sub.featureOverrides ?? {},
    effective,
  });
};

