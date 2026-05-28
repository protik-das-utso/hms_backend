import { prisma } from "../config/db";
import { resolveFeatures, isCoreFeature } from "./features";

/**
 * In-memory cache of effective feature maps per tenant. Cache is invalidated
 * when an admin updates plan features or tenant overrides.
 */
type FeatureMap = Record<string, boolean>;

const ttlMs = 60_000;
const cache = new Map<string, { data: FeatureMap; expiresAt: number }>();
const inflight = new Map<string, Promise<FeatureMap>>();

export const invalidateTenantFeatures = (tenantId: string): void => {
  cache.delete(tenantId);
};

export const invalidateAllFeatureCaches = (): void => {
  cache.clear();
};

const loadFeatures = async (tenantId: string): Promise<FeatureMap> => {
  const sub = await prisma.subscription.findUnique({
    where: { tenantId },
    select: {
      featureOverrides: true,
      planConfig: { select: { features: true } },
    },
  });
  const planFeatures = (sub?.planConfig?.features ?? null) as Record<string, boolean> | null;
  const overrides = (sub?.featureOverrides ?? null) as Record<string, boolean> | null;
  return resolveFeatures(planFeatures, overrides);
};

const getTenantFeatures = async (tenantId: string): Promise<FeatureMap> => {
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.data;

  const ongoing = inflight.get(tenantId);
  if (ongoing) return ongoing;

  const p = (async () => {
    try {
      const data = await loadFeatures(tenantId);
      cache.set(tenantId, { data, expiresAt: Date.now() + ttlMs });
      return data;
    } finally {
      inflight.delete(tenantId);
    }
  })();
  inflight.set(tenantId, p);
  return p;
};

/**
 * Returns true if this tenant has the feature enabled (plan + overrides).
 * Core features always return true. Unknown codes return false.
 */
export const hasFeature = async (tenantId: string, code: string): Promise<boolean> => {
  if (isCoreFeature(code)) return true;
  const map = await getTenantFeatures(tenantId);
  return !!map[code];
};

/** Returns the full effective feature map for a tenant. */
export const tenantFeatureMap = async (tenantId: string): Promise<FeatureMap> => {
  return getTenantFeatures(tenantId);
};
