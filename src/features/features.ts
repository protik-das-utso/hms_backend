/**
 * Feature catalogue. Each "feature" is a module the platform owner can sell
 * or bundle per plan. Unlike permissions (which control what a *role* inside
 * a tenant can do), features control which modules a *tenant* has access to
 * at all.
 *
 * Resolution order (most specific wins):
 *   1. Subscription.featureOverrides (per-tenant override)
 *   2. SubscriptionPlanConfig.features (plan default)
 *   3. CORE features → always on
 *   4. Otherwise → off
 *
 * Adding a new feature: append below and run a one-line script to set its
 * default in each plan. The frontend `useFeatures().has(code)` and backend
 * `requireFeature(code)` middleware pick it up automatically.
 */
export interface FeatureDef {
  code: string;
  module: string; // group label in UI
  label: string;
  description: string;
  /** If true, every tenant gets this regardless of plan (core SaaS surface). */
  core?: boolean;
}

export const FEATURES: FeatureDef[] = [
  // ── Core (always on; here for visibility) ──────────────
  { code: "patients",     module: "Core",     label: "Patient management",         description: "Register, search, edit, history",          core: true },
  { code: "orders",       module: "Core",     label: "Test orders & lab queue",    description: "Order → sample → processing → report",     core: true },
  { code: "reports",      module: "Core",     label: "Diagnostic reports",         description: "Result entry, doctor approval, PDF + QR",  core: true },
  { code: "billing",      module: "Core",     label: "Invoicing & payments",       description: "Multi-method recording, refunds",          core: true },
  { code: "dashboard",    module: "Core",     label: "Dashboards",                 description: "KPIs and revenue trend",                   core: true },

  // ── Premium clinical modules ───────────────────────────
  { code: "opd",         module: "Clinical", label: "OPD + appointments",        description: "Doctor schedules, appointments, consultations, prescriptions" },
  { code: "pharmacy",    module: "Clinical", label: "Pharmacy & inventory",      description: "POS, batches, suppliers, stock movements" },
  { code: "ipd",         module: "Clinical", label: "IPD / Inpatient",           description: "Wards, beds, admissions, daily charges, discharge summaries" },
  { code: "radiology",   module: "Clinical", label: "Radiology / imaging",       description: "X-Ray, USG, CT, MRI report templates & image gallery" },
  { code: "bloodbank",   module: "Clinical", label: "Blood bank",                description: "Donors, bags, screening, crossmatch & issue" },
  { code: "ot",          module: "Clinical", label: "Operation Theatre",         description: "OT scheduling and operation notes" },
  { code: "vaccination", module: "Clinical", label: "Vaccination / EPI",         description: "Vaccine register and next-dose reminders" },
  { code: "ambulance",   module: "Clinical", label: "Ambulance dispatch",        description: "Fleet, trips, distance-based billing" },

  // ── Premium business modules ───────────────────────────
  { code: "hr",          module: "Business", label: "HR & Payroll",              description: "Employment terms, payslips, attendance, leave, loans" },
  { code: "corporate",   module: "Business", label: "Corporate / Insurance billing", description: "Bulk monthly statements to companies & insurers" },
  { code: "audit_log",   module: "Business", label: "Audit log access",          description: "Full audit trail browsing in admin UI" },

  // ── Premium platform modules ───────────────────────────
  { code: "whitelabel",  module: "Platform", label: "White-label branding",      description: "Custom domain, logo, color theme" },
  { code: "patient_portal", module: "Platform", label: "Patient self-service portal", description: "OTP login, report download, online booking" },
];

const BY_CODE: Map<string, FeatureDef> = new Map(FEATURES.map((f) => [f.code, f]));

export const ALL_FEATURE_CODES = new Set(FEATURES.map((f) => f.code));

export const isCoreFeature = (code: string): boolean => !!BY_CODE.get(code)?.core;

export const getFeature = (code: string): FeatureDef | undefined => BY_CODE.get(code);

/**
 * Resolve effective enabled features for a tenant given the plan's feature
 * map and per-tenant overrides. Pure function — easy to test.
 */
export function resolveFeatures(
  planFeatures: Record<string, boolean> | null | undefined,
  tenantOverrides: Record<string, boolean> | null | undefined
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of FEATURES) {
    if (f.core) {
      out[f.code] = true;
      continue;
    }
    if (tenantOverrides && Object.prototype.hasOwnProperty.call(tenantOverrides, f.code)) {
      out[f.code] = !!tenantOverrides[f.code];
      continue;
    }
    out[f.code] = !!(planFeatures && planFeatures[f.code]);
  }
  return out;
}
