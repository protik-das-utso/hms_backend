import { UserRole } from "@prisma/client";

/**
 * Permission catalogue.
 *
 * Each permission is a stable string code in `module:action` form. Add new
 * permissions here as features ship; never rename an existing code without a
 * data migration (RolePermission rows reference these strings).
 *
 * `defaultRoles` lists the roles that have the permission unless a tenant's
 * SUPER_ADMIN overrides via the role_permissions table. SUPER_ADMIN itself is
 * not listed here — it always has every permission (see hasPermission). The
 * UI hides SUPER_ADMIN from the matrix so it can't be locked out by mistake.
 */
export interface PermissionDef {
  code: string;
  module: string; // grouping label in the UI
  label: string;
  description?: string;
  /** Roles that get this permission by default. SUPER_ADMIN is always implicit. */
  defaultRoles: UserRole[];
}

const ADMIN: UserRole[] = ["BRANCH_ADMIN"];
const ALL_STAFF: UserRole[] = [
  "BRANCH_ADMIN", "RECEPTIONIST", "LAB_TECHNICIAN", "DOCTOR",
  "NURSE", "PHARMACIST", "ACCOUNTANT", "HR_MANAGER",
];
const FRONT_DESK: UserRole[] = ["BRANCH_ADMIN", "RECEPTIONIST"];
const CLINICAL: UserRole[] = ["BRANCH_ADMIN", "DOCTOR", "NURSE"];
const FINANCE: UserRole[] = ["BRANCH_ADMIN", "ACCOUNTANT"];
const FINANCE_AND_COUNTER: UserRole[] = ["BRANCH_ADMIN", "ACCOUNTANT", "RECEPTIONIST"];
const PHARMACY: UserRole[] = ["BRANCH_ADMIN", "PHARMACIST"];
const LAB: UserRole[] = ["BRANCH_ADMIN", "LAB_TECHNICIAN"];
const IPD_CARE: UserRole[] = ["BRANCH_ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST"];
const HR: UserRole[] = ["BRANCH_ADMIN", "HR_MANAGER"];

export const PERMISSIONS: PermissionDef[] = [
  // ─── Patients ─────────────────────────────────────────────
  { code: "patients:read",   module: "Patients", label: "View patient list & details", defaultRoles: ALL_STAFF },
  { code: "patients:create", module: "Patients", label: "Register new patients",       defaultRoles: FRONT_DESK },
  { code: "patients:update", module: "Patients", label: "Edit patient details",        defaultRoles: FRONT_DESK },
  { code: "patients:delete", module: "Patients", label: "Archive (soft delete) patients", defaultRoles: ADMIN },

  // ─── Test catalog ─────────────────────────────────────────
  { code: "tests:read",   module: "Test catalog", label: "View test catalog", defaultRoles: ALL_STAFF },
  { code: "tests:manage", module: "Test catalog", label: "Add / edit tests & categories", defaultRoles: ADMIN },

  // ─── Orders ───────────────────────────────────────────────
  { code: "orders:read",          module: "Test orders", label: "View test orders",         defaultRoles: ALL_STAFF },
  { code: "orders:create",        module: "Test orders", label: "Create test orders",       defaultRoles: FRONT_DESK },
  { code: "orders:update_status", module: "Test orders", label: "Move orders through lab queue", defaultRoles: ["BRANCH_ADMIN", "LAB_TECHNICIAN", "RECEPTIONIST"] },
  { code: "orders:cancel",        module: "Test orders", label: "Cancel orders",            defaultRoles: ADMIN },

  // ─── Reports ─────────────────────────────────────────────
  { code: "reports:read",     module: "Reports", label: "View reports",                     defaultRoles: ["BRANCH_ADMIN", "LAB_TECHNICIAN", "DOCTOR", "RECEPTIONIST"] },
  { code: "reports:enter",    module: "Reports", label: "Enter / edit result values",       defaultRoles: LAB },
  { code: "reports:approve",  module: "Reports", label: "Approve & sign off reports",       defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },
  { code: "reports:download", module: "Reports", label: "Download report PDFs",             defaultRoles: ["BRANCH_ADMIN", "LAB_TECHNICIAN", "DOCTOR", "RECEPTIONIST"] },

  // ─── Billing ─────────────────────────────────────────────
  { code: "invoices:read",           module: "Billing", label: "View invoices",                   defaultRoles: FINANCE_AND_COUNTER },
  { code: "invoices:create",         module: "Billing", label: "Create invoices",                 defaultRoles: FRONT_DESK },
  { code: "invoices:record_payment", module: "Billing", label: "Record incoming payments",        defaultRoles: FINANCE_AND_COUNTER },
  { code: "invoices:refund",         module: "Billing", label: "Issue refunds",                   defaultRoles: ["BRANCH_ADMIN", "ACCOUNTANT"] },
  { code: "invoices:discount",       module: "Billing", label: "Apply manual discount on invoice", defaultRoles: ["BRANCH_ADMIN", "ACCOUNTANT"] },

  // ─── OPD ─────────────────────────────────────────────────
  { code: "opd:book_appointment",     module: "OPD",       label: "Book appointments",          defaultRoles: FRONT_DESK },
  { code: "opd:check_in",             module: "OPD",       label: "Check patients in",          defaultRoles: FRONT_DESK },
  { code: "opd:start_consultation",   module: "OPD",       label: "Start a consultation",       defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },
  { code: "opd:write_prescription",   module: "OPD",       label: "Write & sign prescription",  defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },
  { code: "opd:manage_schedules",     module: "OPD",       label: "Edit doctor schedules",      defaultRoles: ADMIN },

  // ─── Pharmacy ────────────────────────────────────────────
  { code: "pharmacy:sell",             module: "Pharmacy", label: "Run a sale (POS)",            defaultRoles: PHARMACY },
  { code: "pharmacy:void_sale",        module: "Pharmacy", label: "Void / refund a sale",        defaultRoles: ADMIN },
  { code: "pharmacy:receive_stock",    module: "Pharmacy", label: "Receive stock / record GRN",  defaultRoles: PHARMACY },
  { code: "pharmacy:manage_medicines", module: "Pharmacy", label: "Add / edit medicines",        defaultRoles: PHARMACY },
  { code: "pharmacy:manage_suppliers", module: "Pharmacy", label: "Manage suppliers",            defaultRoles: PHARMACY },
  { code: "pharmacy:adjust_stock",     module: "Pharmacy", label: "Adjust stock (write-offs, corrections)", defaultRoles: ADMIN },

  // ─── IPD ────────────────────────────────────────────────
  { code: "ipd:admit",             module: "IPD", label: "Admit patient",                defaultRoles: IPD_CARE },
  { code: "ipd:transfer_bed",      module: "IPD", label: "Transfer bed within admission", defaultRoles: ["BRANCH_ADMIN", "DOCTOR", "NURSE"] },
  { code: "ipd:discharge",         module: "IPD", label: "Discharge patient",            defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },
  { code: "ipd:add_charge",        module: "IPD", label: "Add ad-hoc charge to admission", defaultRoles: IPD_CARE },
  { code: "ipd:nursing_note",      module: "IPD", label: "Record nursing notes",         defaultRoles: ["BRANCH_ADMIN", "NURSE", "DOCTOR"] },
  { code: "ipd:doctor_visit",      module: "IPD", label: "Log doctor visit",             defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },
  { code: "ipd:manage_wards_beds", module: "IPD", label: "Manage wards & beds",          defaultRoles: ADMIN },

  // ─── Radiology / extension of reports ──────────────────
  // (uses same reports:* permissions for now)

  // ─── Blood Bank ────────────────────────────────────────
  { code: "bloodbank:read",        module: "Blood bank", label: "View blood bank",          defaultRoles: CLINICAL },
  { code: "bloodbank:donors",      module: "Blood bank", label: "Manage donor registry",    defaultRoles: CLINICAL },
  { code: "bloodbank:bags",        module: "Blood bank", label: "Receive / screen bags",    defaultRoles: ["BRANCH_ADMIN", "LAB_TECHNICIAN", "DOCTOR"] },
  { code: "bloodbank:issue",       module: "Blood bank", label: "Issue / crossmatch bag to patient", defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },

  // ─── Ambulance ─────────────────────────────────────────
  { code: "ambulance:dispatch",  module: "Ambulance", label: "Dispatch / complete trips",  defaultRoles: ["BRANCH_ADMIN", "RECEPTIONIST"] },
  { code: "ambulance:manage",    module: "Ambulance", label: "Manage fleet",               defaultRoles: ADMIN },

  // ─── Vaccination ───────────────────────────────────────
  { code: "vaccination:read",       module: "Vaccination", label: "View vaccination records", defaultRoles: ["BRANCH_ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST"] },
  { code: "vaccination:administer", module: "Vaccination", label: "Administer / record vaccination", defaultRoles: ["BRANCH_ADMIN", "DOCTOR", "NURSE"] },

  // ─── Operation Theatre ─────────────────────────────────
  { code: "ot:book",   module: "Operation Theatre", label: "Schedule OT booking", defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },
  { code: "ot:edit_note", module: "Operation Theatre", label: "Edit OT note",       defaultRoles: ["BRANCH_ADMIN", "DOCTOR"] },

  // ─── Cash / petty / commissions / expenses ─────────────
  { code: "cash:close",         module: "Cash / Finance", label: "Run end-of-day cash close", defaultRoles: ["BRANCH_ADMIN", "ACCOUNTANT", "RECEPTIONIST", "PHARMACIST"] },
  { code: "cash:petty",         module: "Cash / Finance", label: "Record petty cash entries", defaultRoles: FINANCE },
  { code: "commissions:read",   module: "Cash / Finance", label: "View commission ledger",    defaultRoles: FINANCE },
  { code: "commissions:payout", module: "Cash / Finance", label: "Pay commission payouts",    defaultRoles: FINANCE },
  { code: "expenses:read",      module: "Cash / Finance", label: "View expenses",             defaultRoles: FINANCE },
  { code: "expenses:create",    module: "Cash / Finance", label: "Record expenses",           defaultRoles: FINANCE },

  // ─── Corporate billing ─────────────────────────────────
  { code: "corporate:read",         module: "Corporate", label: "View corporate clients",       defaultRoles: FINANCE_AND_COUNTER },
  { code: "corporate:manage",       module: "Corporate", label: "Add / edit corporate clients", defaultRoles: ["BRANCH_ADMIN", "ACCOUNTANT"] },
  { code: "corporate:statements",   module: "Corporate", label: "Generate & manage statements", defaultRoles: ["BRANCH_ADMIN", "ACCOUNTANT"] },

  // ─── HR & Payroll ──────────────────────────────────────
  { code: "hr:read",              module: "HR", label: "View HR data (own only)",                defaultRoles: ALL_STAFF },
  { code: "hr:manage_employment", module: "HR", label: "Edit employment terms / loans",          defaultRoles: HR },
  { code: "hr:manage_payroll",    module: "HR", label: "Run & finalise payroll",                 defaultRoles: HR },
  { code: "hr:manage_attendance", module: "HR", label: "Edit attendance & roster for others",    defaultRoles: HR },
  { code: "hr:approve_leave",     module: "HR", label: "Approve / reject leave requests",        defaultRoles: HR },

  // ─── Staff / users / branches ──────────────────────────
  { code: "users:read",     module: "Staff", label: "View staff list",         defaultRoles: ADMIN },
  { code: "users:create",   module: "Staff", label: "Add new staff",           defaultRoles: ADMIN },
  { code: "users:update",   module: "Staff", label: "Edit staff details",      defaultRoles: ADMIN },
  { code: "users:delete",   module: "Staff", label: "Deactivate staff",        defaultRoles: ADMIN },
  { code: "branches:manage", module: "Staff", label: "Add / edit branches",   defaultRoles: ["BRANCH_ADMIN"] },

  // ─── Tenant settings ───────────────────────────────────
  { code: "settings:tenant",          module: "Settings", label: "Edit clinic profile",  defaultRoles: ADMIN },
  { code: "settings:subscription",    module: "Settings", label: "View & record subscription payments", defaultRoles: ADMIN },
  { code: "settings:sms_templates",   module: "Settings", label: "Edit SMS templates",   defaultRoles: ADMIN },
  { code: "settings:notices",         module: "Settings", label: "Post staff notices",   defaultRoles: ADMIN },
  { code: "settings:permissions",     module: "Settings", label: "Manage role permissions (this page)", defaultRoles: [] }, // SUPER_ADMIN-only by design

  // ─── Audit / reports ───────────────────────────────────
  { code: "audit:read",          module: "Audit", label: "View audit log", defaultRoles: ADMIN },
  { code: "dashboard:revenue",   module: "Audit", label: "View revenue dashboards",  defaultRoles: FINANCE },
];

// Set-of-codes per role for fast default lookup.
const DEFAULT_MAP: Map<UserRole, Set<string>> = (() => {
  const m = new Map<UserRole, Set<string>>();
  for (const p of PERMISSIONS) {
    for (const r of p.defaultRoles) {
      if (!m.has(r)) m.set(r, new Set());
      m.get(r)!.add(p.code);
    }
  }
  return m;
})();

/** Default permission state for (role, code), ignoring tenant overrides. */
export const defaultAllowed = (role: UserRole, code: string): boolean => {
  if (role === "SUPER_ADMIN") return true;
  return DEFAULT_MAP.get(role)?.has(code) ?? false;
};

/** Full set of permission codes (used to validate input from the matrix UI). */
export const ALL_CODES: Set<string> = new Set(PERMISSIONS.map((p) => p.code));

/** Roles whose permissions can be configured. SUPER_ADMIN and PATIENT are hidden. */
export const CONFIGURABLE_ROLES: UserRole[] = [
  "BRANCH_ADMIN",
  "RECEPTIONIST",
  "LAB_TECHNICIAN",
  "DOCTOR",
  "NURSE",
  "PHARMACIST",
  "ACCOUNTANT",
  "HR_MANAGER",
  "DELIVERY_STAFF",
];
