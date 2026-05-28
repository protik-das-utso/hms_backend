// Notification dispatch — provider-pluggable SMS/email.
//
// Provider config has two layers (most specific wins):
//   1. Per-tenant — Tenant.smsProvider + smsApiKey + smsSenderId, etc.
//      Each clinic configures their own SMS account from /settings/sms.
//   2. Platform default — env.sms.* (config/env.ts), used when the tenant
//      hasn't configured their own. Useful for the platform tenant itself.
//
// Every notify() call persists a row in `notifications`, attempts to send
// via the resolved provider, and updates the row to SENT or FAILED so the
// admin UI can show delivery history.

import { prisma } from "../config/db";
import { NotificationChannel } from "@prisma/client";
import { env } from "../config/env";
import { resolvesToPublicOnly } from "./urlSafety";

interface NotifyInput {
  tenantId: string;
  channel?: NotificationChannel;
  to: string;
  subject?: string;
  body: string;
  relatedTo?: string;
}

interface ProviderResult {
  status: "SENT" | "FAILED";
  providerId?: string;
  errorText?: string;
}

/** The minimal set of fields a dispatch call needs, resolved from tenant + env. */
export interface ResolvedSmsConfig {
  provider: string;
  senderId: string;
  apiKey: string;
  httpUrl?: string;
  httpBodyTemplate?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
  enabled: boolean;
}

const sub = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

// ── Provider presets for popular BD SMS gateways ─────────────
interface PresetConfig {
  url: string;
  body: string;
  authHeader?: string;
  authScheme?: string;
  contentType?: string;
}

const PRESETS: Record<string, PresetConfig> = {
  ssl_wireless: {
    url: "https://smsplus.sslwireless.com/api/v3/send-sms",
    body: '{"api_token":"{token}","sid":"{sender}","msisdn":"{to}","sms":"{body}","csms_id":"{csms_id}"}',
    contentType: "application/json",
  },
  onnorokom: {
    url: "https://api.onnorokomsms.com/SendSms",
    body: '{"apiKey":"{token}","mobileNo":"{to}","smsBody":"{body}","senderId":"{sender}","smsType":"TEXT"}',
    contentType: "application/json",
  },
  greenweb: {
    url: "https://api.greenweb.com.bd/api.php",
    body: "token={token}&to={to}&message={body}",
    contentType: "application/x-www-form-urlencoded",
  },
  mim: {
    url: "https://api.mimsms.com/api/SmsSending/SMS",
    body: '{"UserName":"{sender}","Apikey":"{token}","MobileNumber":"{to}","CampaignId":"null","SenderName":"{sender}","TransactionType":"T","Message":"{body}"}',
    contentType: "application/json",
  },
};

export const SUPPORTED_PROVIDERS = ["log", "ssl_wireless", "onnorokom", "greenweb", "mim", "twilio", "http"] as const;

/**
 * Look up a tenant's SMS config; fall back to platform defaults from env.
 */
async function resolveSmsConfig(tenantId: string): Promise<ResolvedSmsConfig> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      smsProvider: true, smsSenderId: true, smsApiKey: true, smsAccountSid: true,
      smsHttpUrl: true, smsHttpBodyTemplate: true, smsEnabled: true,
    },
  }).catch(() => null);

  // Kill-switch: tenant disabled SMS → log only (still records the notification).
  if (t && t.smsEnabled === false) {
    return { provider: "log", senderId: env.sms.senderId, apiKey: "", enabled: false };
  }

  // Tenant has configured their own provider — use that.
  if (t?.smsProvider) {
    return {
      provider: t.smsProvider,
      senderId: t.smsSenderId ?? env.sms.senderId,
      apiKey: t.smsApiKey ?? "",
      httpUrl: t.smsHttpUrl ?? undefined,
      httpBodyTemplate: t.smsHttpBodyTemplate ?? undefined,
      // Twilio uses smsApiKey as the auth token + smsAccountSid + smsSenderId as from-number.
      twilioAccountSid: t.smsAccountSid ?? undefined,
      twilioAuthToken: t.smsApiKey ?? undefined,
      twilioFrom: t.smsSenderId ?? undefined,
      enabled: true,
    };
  }

  // Fall back to env-level defaults.
  return {
    provider: env.sms.provider,
    senderId: env.sms.senderId,
    apiKey: env.sms.httpToken,
    httpUrl: env.sms.httpUrl || undefined,
    httpBodyTemplate: env.sms.httpBodyTemplate || undefined,
    twilioAccountSid: env.sms.twilioAccountSid || undefined,
    twilioAuthToken: env.sms.twilioAuthToken || undefined,
    twilioFrom: env.sms.twilioFrom || undefined,
    enabled: true,
  };
}

async function sendViaHttp(to: string, body: string, cfg: ResolvedSmsConfig): Promise<ProviderResult> {
  const preset = PRESETS[cfg.provider];
  const url = cfg.httpUrl || preset?.url || "";
  const tpl = cfg.httpBodyTemplate || preset?.body || env.sms.httpBodyTemplate;
  const contentType = preset?.contentType ?? "application/json";

  if (!url) {
    return { status: "FAILED", errorText: `SMS URL not configured for provider ${cfg.provider}` };
  }
  // Defense-in-depth SSRF check at dispatch — catches DNS rebinding and any
  // legacy URLs that bypassed validation.
  if (!(await resolvesToPublicOnly(url))) {
    return { status: "FAILED", errorText: "SMS URL resolves to a private/internal address" };
  }
  if (!cfg.apiKey && preset) {
    return { status: "FAILED", errorText: `API key (smsApiKey) missing for ${cfg.provider}` };
  }
  try {
    const payload = sub(tpl, {
      to,
      body: body.replace(/"/g, '\\"').replace(/\n/g, " "),
      sender: cfg.senderId,
      token: cfg.apiKey,
      csms_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const headers: Record<string, string> = { "Content-Type": contentType };
    const authHeader = preset?.authHeader ?? (process.env.SMS_HTTP_AUTH_HEADER ? env.sms.httpAuthHeader : "");
    if (authHeader && cfg.apiKey) {
      const scheme = preset?.authScheme ?? env.sms.httpAuthScheme;
      headers[authHeader] = `${scheme} ${cfg.apiKey}`.trim();
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { status: "FAILED", errorText: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { status: "SENT", providerId: text.slice(0, 100) };
  } catch (err) {
    return { status: "FAILED", errorText: (err as Error).message };
  }
}

async function sendViaTwilio(to: string, body: string, cfg: ResolvedSmsConfig): Promise<ProviderResult> {
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken || !cfg.twilioFrom) {
    return { status: "FAILED", errorText: "Twilio credentials missing (smsAccountSid / smsApiKey / smsSenderId)" };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: cfg.twilioFrom, Body: body });
    const auth = Buffer.from(`${cfg.twilioAccountSid}:${cfg.twilioAuthToken}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) {
      return { status: "FAILED", errorText: json.message ?? `HTTP ${res.status}` };
    }
    return { status: "SENT", providerId: json.sid };
  } catch (err) {
    return { status: "FAILED", errorText: (err as Error).message };
  }
}

async function dispatch(channel: NotificationChannel, to: string, body: string, cfg: ResolvedSmsConfig): Promise<ProviderResult> {
  // Email is recorded but not sent (no SMTP wired yet).
  if (channel !== "SMS") return { status: "SENT" };
  if (!cfg.enabled) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[SMS:disabled] → ${to}\n  ${body.replace(/\n/g, "\n  ")}`);
    }
    return { status: "SENT", providerId: "disabled" };
  }
  if (PRESETS[cfg.provider]) {
    return sendViaHttp(to, body, cfg);
  }
  switch (cfg.provider) {
    case "http": return sendViaHttp(to, body, cfg);
    case "twilio": return sendViaTwilio(to, body, cfg);
    case "log":
    case "mock":
    default:
      if (process.env.NODE_ENV !== "production") {
        console.log(`[SMS:log] → ${to}\n  ${body.replace(/\n/g, "\n  ")}`);
      }
      return { status: "SENT", providerId: "log" };
  }
}

export const notify = async ({
  tenantId,
  channel = NotificationChannel.SMS,
  to,
  subject,
  body,
  relatedTo,
}: NotifyInput) => {
  if (!to || !to.trim()) return null;

  const row = await prisma.notification.create({
    data: {
      tenantId,
      channel,
      toAddress: to,
      subject,
      body,
      status: "PENDING",
      relatedTo,
    },
  });

  const cfg = await resolveSmsConfig(tenantId);
  const result = await dispatch(channel, to, body, cfg);
  await prisma.notification.update({
    where: { id: row.id },
    data: {
      status: result.status,
      sentAt: result.status === "SENT" ? new Date() : null,
      providerId: result.providerId ?? null,
      errorText: result.errorText ?? null,
    },
  });
  return { ...row, ...result };
};

// ── Template renderer ───────────────────────────────────────────

const renderTemplate = (template: string, vars: Record<string, string | number | undefined | null>) =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? "" : String(v);
  });

export async function sendSmsByTemplate(opts: {
  tenantId: string;
  code: string;
  to: string;
  vars: Record<string, string | number | undefined | null>;
  relatedTo?: string;
}): Promise<{ status: "SENT" | "SKIPPED" | "FAILED"; errorText?: string }> {
  if (!opts.to) return { status: "SKIPPED", errorText: "No recipient" };
  const tpl = await prisma.smsTemplate.findUnique({
    where: { tenantId_code: { tenantId: opts.tenantId, code: opts.code } },
  });
  if (!tpl) return { status: "SKIPPED", errorText: "Template not configured" };
  if (!tpl.enabled) return { status: "SKIPPED", errorText: "Template disabled" };
  const body = renderTemplate(tpl.body, opts.vars);
  try {
    const r = await notify({ tenantId: opts.tenantId, to: opts.to, body, relatedTo: opts.relatedTo ?? opts.code });
    return { status: r?.status === "FAILED" ? "FAILED" : "SENT", errorText: r?.errorText };
  } catch (err) {
    return { status: "FAILED", errorText: (err as Error).message };
  }
}

export function sendSmsAsync(opts: Parameters<typeof sendSmsByTemplate>[0]) {
  void sendSmsByTemplate(opts).catch((err) => {
    console.error("[notify] async send failed", err);
  });
}
