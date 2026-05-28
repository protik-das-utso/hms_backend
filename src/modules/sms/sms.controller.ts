import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { ok, paginate } from "../../utils/apiResponse";
import { ApiError } from "../../utils/ApiError";
import { getPagination } from "../../utils/pagination";
import { env } from "../../config/env";
import { notify, sendSmsByTemplate } from "../../utils/notify";
import { validatePublicUrl } from "../../utils/urlSafety";
import { runAppointmentReminders } from "../../jobs/appointmentReminders";

interface TemplateVariable {
  name: string;
  description: string;
  /** Sample value rendered in the preview pane so admins see realistic copy. */
  sample: string;
}

interface SeedTemplate {
  code: string;
  name: string;
  body: string;
  description: string;
  variables: TemplateVariable[];
  /** When fires? Shown as a one-liner under the template name. */
  trigger: string;
}

/**
 * Canonical catalogue. Every variable the dispatch code passes per template
 * is documented here so:
 *   1. The editor can show admins which variables they're allowed to use
 *      and what each one means.
 *   2. A click-to-insert chip can append {{varName}} at the cursor.
 *   3. The preview pane can render the body with realistic sample values.
 *
 * When you wire a new SMS send-site, add the variable here too.
 */
const DEFAULT_TEMPLATES: SeedTemplate[] = [
  {
    code: "WELCOME_PATIENT",
    name: "Welcome — new patient",
    body: "Welcome to {{clinic}}, {{name}}! Your patient ID is {{patientCode}}. Save this number for future visits.",
    description: "First SMS a new patient receives. Use a warm tone.",
    trigger: "Auto-sent when a receptionist registers a new patient.",
    variables: [
      { name: "name", description: "Patient's full name", sample: "Md. Rahim Uddin" },
      { name: "patientCode", description: "Their assigned patient ID (e.g. PAT-...)", sample: "PAT-20260527-0042" },
      { name: "clinic", description: "Your clinic's display name", sample: "Popular Diagnostic Centre" },
    ],
  },
  {
    code: "APPT_CONFIRMED",
    name: "Appointment confirmed",
    body: "Hi {{name}}, your appointment with Dr. {{doctor}} is confirmed for {{slot}}. Token #{{token}}.",
    description: "Sent once the appointment is booked.",
    trigger: "Auto-sent when an appointment is created.",
    variables: [
      { name: "name", description: "Patient's full name", sample: "Md. Rahim Uddin" },
      { name: "doctor", description: "Doctor's name (without the Dr. prefix)", sample: "Salma Khatun" },
      { name: "slot", description: "Date + start time, formatted for SMS", sample: "Mon 27 May, 10:30 AM" },
      { name: "token", description: "Per-doctor queue number for that day", sample: "7" },
    ],
  },
  {
    code: "APPT_REMINDER",
    name: "Appointment reminder (24h)",
    body: "Reminder: you have an appointment with Dr. {{doctor}} tomorrow at {{slot}}. Token #{{token}}.",
    description: "24-hour reminder so patients don't no-show.",
    trigger: "Daily cron ~09:00 Dhaka, one day before each booked appointment.",
    variables: [
      { name: "name", description: "Patient's full name", sample: "Md. Rahim Uddin" },
      { name: "doctor", description: "Doctor's name", sample: "Salma Khatun" },
      { name: "slot", description: "Date + start time", sample: "Tue 28 May, 10:30 AM" },
      { name: "token", description: "Queue number for that day", sample: "7" },
    ],
  },
  {
    code: "REPORT_READY",
    name: "Report ready",
    body: "Dear {{name}}, your report for order {{orderNumber}} is ready. Track at {{trackUrl}}.",
    description: "Sent the moment a doctor approves the lab report.",
    trigger: "Auto-sent on doctor approval of a Report.",
    variables: [
      { name: "name", description: "Patient's full name", sample: "Md. Rahim Uddin" },
      { name: "orderNumber", description: "The test order number (ORD-...)", sample: "ORD-260527-00012" },
      { name: "trackUrl", description: "Public link patients can open to view their report", sample: "https://clinic.com/track/ORD-260527-00012" },
    ],
  },
  {
    code: "INVOICE_DUE",
    name: "Invoice due reminder",
    body: "Dear {{name}}, your invoice {{invoiceNumber}} has a pending balance of ৳{{due}}. Please settle at your earliest convenience.",
    description: "Polite nudge for unpaid invoices.",
    trigger: "Daily cron ~09:00 Dhaka for invoices ≥ 3 days old with positive due. Also fires manually from Outstanding Dues.",
    variables: [
      { name: "name", description: "Patient's full name", sample: "Md. Rahim Uddin" },
      { name: "invoiceNumber", description: "Invoice number (INV-...)", sample: "INV-260527-00007" },
      { name: "total", description: "Invoice total amount (number, no symbol)", sample: "3500" },
      { name: "due", description: "Outstanding due amount", sample: "1500" },
    ],
  },
  {
    code: "VACCINE_DUE",
    name: "Vaccination due reminder",
    body: "Dear {{name}}, your {{vaccine}} dose is due on {{dueDate}}. Please visit the clinic.",
    description: "EPI follow-up reminders.",
    trigger: "Optional — fire from a vaccination workflow (not yet automated).",
    variables: [
      { name: "name", description: "Patient's full name", sample: "Md. Rahim Uddin" },
      { name: "vaccine", description: "Vaccine name and dose", sample: "Measles (2nd dose)" },
      { name: "dueDate", description: "Date the dose is due", sample: "05 Jun 2026" },
    ],
  },
];

// ── Templates ───────────────────────────────────────────────

export const listTemplates = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const rows = await prisma.smsTemplate.findMany({
    where: { tenantId },
    orderBy: { code: "asc" },
  });
  ok(res, rows);
};

/**
 * Idempotent seed for the tenant. Existing codes are left alone so admins
 * can edit bodies without their changes being clobbered on re-run.
 */
export const seedDefaults = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  let inserted = 0;
  let skipped = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const exists = await prisma.smsTemplate.findUnique({
      where: { tenantId_code: { tenantId, code: t.code } },
    });
    if (exists) { skipped++; continue; }
    await prisma.smsTemplate.create({
      data: { tenantId, code: t.code, name: t.name, body: t.body, description: t.description, enabled: true },
    });
    inserted++;
  }
  ok(res, { inserted, skipped }, "Templates seeded");
};

export const upsertTemplate = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as { code: string; name?: string; body: string; enabled?: boolean; description?: string };
  if (!b.code?.trim() || !b.body?.trim()) throw ApiError.badRequest("code and body are required");
  const row = await prisma.smsTemplate.upsert({
    where: { tenantId_code: { tenantId, code: b.code } },
    create: {
      tenantId,
      code: b.code,
      name: b.name ?? b.code,
      body: b.body,
      enabled: b.enabled ?? true,
      description: b.description ?? null,
    },
    update: {
      name: b.name ?? undefined,
      body: b.body,
      enabled: b.enabled ?? undefined,
      description: b.description ?? undefined,
    },
  });
  ok(res, row, "Template saved");
};

export const testSend = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const b = req.body as { to: string; code?: string; body?: string };
  if (!b.to) throw ApiError.badRequest("to is required");
  if (b.code) {
    const r = await sendSmsByTemplate({
      tenantId,
      code: b.code,
      to: b.to,
      vars: {
        name: "Test User", clinic: "Demo Clinic", doctor: "Demo", slot: "Today 10:00 AM",
        token: "1", patientCode: "PAT-TEST", orderNumber: "ORD-TEST", trackUrl: `${env.publicBaseUrl}/track`,
        invoiceNumber: "INV-TEST", total: "1000", due: "500", vaccine: "MR-1", dueDate: "tomorrow",
      },
      relatedTo: "TEST",
    });
    ok(res, r, "Test send dispatched");
  } else if (b.body) {
    const r = await notify({ tenantId, to: b.to, body: b.body, relatedTo: "TEST" });
    ok(res, r, "Test send dispatched");
  } else {
    throw ApiError.badRequest("Provide either `code` or `body`");
  }
};

// ── Notifications log + provider status ─────────────────────

export const listNotifications = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { page, pageSize, skip, take } = getPagination(req);
  const status = req.query.status as string | undefined;
  const relatedTo = req.query.relatedTo as string | undefined;

  const where: Prisma.NotificationWhereInput = {
    tenantId,
    ...(status ? { status: status as Prisma.NotificationWhereInput["status"] } : {}),
    ...(relatedTo ? { relatedTo } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.notification.count({ where }),
  ]);
  ok(res, rows, "OK", paginate(page, pageSize, total));
};

export const status = async (_req: Request, res: Response) => {
  // Expose just the safe pieces of provider config. NEVER leak tokens.
  ok(res, {
    provider: env.sms.provider,
    senderId: env.sms.senderId,
    httpConfigured: !!env.sms.httpUrl,
    twilioConfigured: !!env.sms.twilioAccountSid && !!env.sms.twilioAuthToken && !!env.sms.twilioFrom,
  });
};

// ── Manual triggers ─────────────────────────────────────────

export const sendInvoiceDue = async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const invoiceId = (req.body as { invoiceId?: string }).invoiceId;
  if (!invoiceId) throw ApiError.badRequest("invoiceId required");
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: { patient: { select: { name: true, phone: true } } },
  });
  if (!inv) throw ApiError.notFound("Invoice not found");
  if (!inv.patient.phone) throw ApiError.badRequest("Patient has no phone on file");
  const r = await sendSmsByTemplate({
    tenantId,
    code: "INVOICE_DUE",
    to: inv.patient.phone,
    vars: {
      name: inv.patient.name,
      invoiceNumber: inv.invoiceNumber,
      total: Number(inv.totalAmount).toFixed(2),
      due: Number(inv.dueAmount).toFixed(2),
    },
    relatedTo: `INVOICE_DUE:${inv.id}`,
  });
  ok(res, r, "Reminder dispatched");
};

export const runReminders = async (_req: Request, res: Response) => {
  const result = await runAppointmentReminders();
  ok(res, result, "Reminder cron run");
};


// ── Per-tenant SMS provider config ──────────────────────────

const SUPPORTED_PROVIDERS = ["log", "ssl_wireless", "onnorokom", "greenweb", "mim", "twilio", "http"] as const;

/**
 * Returns the tenant's saved gateway config plus the catalogue of supported
 * providers. Mask the API key so it doesn't round-trip in plaintext — just
 * report whether it's set so the UI can show "•••" instead of an empty box.
 */
export const getProviderConfig = async (req: Request, res: Response) => {
  const t = await prisma.tenant.findUnique({
    where: { id: req.auth!.tenantId },
    select: {
      smsProvider: true, smsSenderId: true, smsApiKey: true, smsAccountSid: true,
      smsHttpUrl: true, smsHttpBodyTemplate: true, smsEnabled: true,
    },
  });
  ok(res, {
    config: {
      provider: t?.smsProvider ?? null,
      senderId: t?.smsSenderId ?? null,
      apiKeyMasked: t?.smsApiKey ? `••• ${t.smsApiKey.slice(-4)}` : null,
      accountSid: t?.smsAccountSid ?? null,
      httpUrl: t?.smsHttpUrl ?? null,
      httpBodyTemplate: t?.smsHttpBodyTemplate ?? null,
      enabled: t?.smsEnabled ?? true,
    },
    providers: SUPPORTED_PROVIDERS,
    platformDefault: {
      // For transparency — what would dispatch fall back to without tenant config?
      provider: env.sms.provider,
      senderId: env.sms.senderId,
    },
  });
};

/**
 * Update the tenant's gateway config. Empty string on apiKey means "keep
 * existing value" — the masked round-trip from getProviderConfig means the
 * UI never sees the real key, so when the user doesn't re-enter it, we
 * preserve the stored value. A literal `null` means "clear".
 */
export const updateProviderConfig = async (req: Request, res: Response) => {
  const body = req.body as {
    provider?: string;
    senderId?: string | null;
    apiKey?: string | null;
    accountSid?: string | null;
    httpUrl?: string | null;
    httpBodyTemplate?: string | null;
    enabled?: boolean;
  };

  if (body.provider && !SUPPORTED_PROVIDERS.includes(body.provider as (typeof SUPPORTED_PROVIDERS)[number])) {
    throw ApiError.badRequest(`Unknown provider: ${body.provider}`);
  }

  // SSRF guard — when an admin supplies a custom HTTP gateway URL it must be
  // a public http(s) endpoint, not internal infrastructure or metadata.
  if (typeof body.httpUrl === "string" && body.httpUrl.length > 0) {
    validatePublicUrl(body.httpUrl);
  }

  const data: Record<string, unknown> = {};
  if (body.provider !== undefined) data.smsProvider = body.provider || null;
  if (body.senderId !== undefined) data.smsSenderId = (body.senderId || null);
  if (body.accountSid !== undefined) data.smsAccountSid = (body.accountSid || null);
  if (body.httpUrl !== undefined) data.smsHttpUrl = (body.httpUrl || null);
  if (body.httpBodyTemplate !== undefined) data.smsHttpBodyTemplate = (body.httpBodyTemplate || null);
  if (body.enabled !== undefined) data.smsEnabled = !!body.enabled;
  // Treat empty string as "leave alone"; null clears.
  if (body.apiKey === null) data.smsApiKey = null;
  else if (typeof body.apiKey === "string" && body.apiKey.length > 0) data.smsApiKey = body.apiKey;

  const updated = await prisma.tenant.update({
    where: { id: req.auth!.tenantId },
    data,
    select: {
      smsProvider: true, smsSenderId: true, smsApiKey: true, smsAccountSid: true,
      smsHttpUrl: true, smsHttpBodyTemplate: true, smsEnabled: true,
    },
  });
  ok(res, {
    provider: updated.smsProvider,
    senderId: updated.smsSenderId,
    apiKeyMasked: updated.smsApiKey ? `••• ${updated.smsApiKey.slice(-4)}` : null,
    accountSid: updated.smsAccountSid,
    httpUrl: updated.smsHttpUrl,
    httpBodyTemplate: updated.smsHttpBodyTemplate,
    enabled: updated.smsEnabled,
  }, "Gateway config saved");
};

/**
 * Static catalogue of templates + their variable list. Used by the editor
 * to show admins which {{...}} placeholders are valid for each template.
 * The catalogue exists in code (not DB) because variables are tied to the
 * dispatch code that fills them — admins shouldn't be able to invent new
 * variable names that won't substitute anything.
 */
export const catalogue = async (_req: Request, res: Response) => {
  ok(res, DEFAULT_TEMPLATES.map((t) => ({
    code: t.code,
    name: t.name,
    description: t.description,
    trigger: t.trigger,
    variables: t.variables,
    defaultBody: t.body,
  })));
};
