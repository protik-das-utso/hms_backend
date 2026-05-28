// Daily clinic-operations alerts: invoice-due reminders to patients, plus
// low-stock + near-expiry digests to the pharmacist of each tenant.
//
// Scheduler: hourly tick, fires once between 09:00–10:00 Asia/Dhaka, guarded
// by an in-memory "last-run date" so it can't double-fire even if the tick
// runs more than once in that window. Mirrors the existing
// appointmentReminders / ipdDailyCharges jobs.

import dayjs from "dayjs";
import { prisma } from "../config/db";
import { sendSmsByTemplate, notify } from "../utils/notify";

const NEAR_EXPIRY_DAYS = 90;
const INVOICE_REMINDER_DAYS = 3;

// ─── Invoice-due reminders ────────────────────────────────

/**
 * For every patient invoice with positive `dueAmount` and `dueDate` falling
 * in the next 3 days, send the INVOICE_DUE template — once. Idempotency
 * comes from the Notification row: we check for an existing row with the
 * matching `relatedTo` before sending again.
 *
 * Note: Invoice schema doesn't have a separate dueDate column; we treat the
 * billing flow as "due immediately on creation". To stay useful, we instead
 * remind every 7 days for any unpaid invoice older than 7 days. Adjust by
 * changing the where clause if your billing flow grows a real dueDate.
 */
export async function runInvoiceDueReminders(now: Date = new Date()) {
  // Find all invoices that have outstanding balance AND are at least 3 days old.
  // 3-day spacing avoids spamming patients on the day of issue.
  const since = dayjs(now).subtract(60, "day").toDate(); // don't scan ancient history
  const olderThan = dayjs(now).subtract(INVOICE_REMINDER_DAYS, "day").toDate();

  const invoices = await prisma.invoice.findMany({
    where: {
      createdAt: { gte: since, lte: olderThan },
      status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      dueAmount: { gt: 0 },
    },
    include: {
      patient: { select: { id: true, name: true, phone: true } },
      tenant: { select: { id: true } },
    },
  });

  let sent = 0, skipped = 0, failed = 0;
  for (const inv of invoices) {
    if (!inv.patient.phone) { skipped++; continue; }

    // Has a reminder already gone out in the last 7 days?
    const lastReminder = await prisma.notification.findFirst({
      where: {
        tenantId: inv.tenantId,
        relatedTo: `INVOICE_DUE:${inv.id}`,
        createdAt: { gte: dayjs(now).subtract(7, "day").toDate() },
      },
      select: { id: true },
    });
    if (lastReminder) { skipped++; continue; }

    const r = await sendSmsByTemplate({
      tenantId: inv.tenantId,
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
    if (r.status === "SENT") sent++;
    else if (r.status === "SKIPPED") skipped++;
    else failed++;
  }
  return { sent, skipped, failed, scanned: invoices.length };
}

// ─── Pharmacy stock digest ────────────────────────────────

/**
 * Per tenant, build a daily digest of:
 *   - Batches at/below their medicine's reorderLevel (low stock)
 *   - Batches expiring within NEAR_EXPIRY_DAYS (near expiry)
 *
 * Send one compact summary SMS to each PHARMACIST + each BRANCH_ADMIN for
 * the affected branches. Skip tenants with the "pharmacy" feature disabled
 * (no point alerting tenants who don't use the module).
 *
 * Idempotency: tagged with `STOCK_DIGEST:<tenantId>:<YYYY-MM-DD>` — one
 * digest per tenant per day.
 */
export async function runStockAlerts(now: Date = new Date()) {
  const dateKey = dayjs(now).format("YYYY-MM-DD");
  const expiryCutoff = dayjs(now).add(NEAR_EXPIRY_DAYS, "day").toDate();

  // Discover every tenant that has at least one MedicineBatch — this is our
  // "uses pharmacy" proxy without needing to query the feature resolver
  // for every tenant.
  const activeTenants = await prisma.tenant.findMany({
    where: { isActive: true, isPlatform: false, medicineBatches: { some: {} } },
    select: { id: true, name: true },
  });

  let tenantsAlerted = 0, smsAttempts = 0;

  for (const tenant of activeTenants) {
    const sentToday = await prisma.notification.findFirst({
      where: {
        tenantId: tenant.id,
        relatedTo: `STOCK_DIGEST:${dateKey}`,
      },
      select: { id: true },
    });
    if (sentToday) continue;

    const [lowStock, nearExpiry] = await Promise.all([
      prisma.medicineBatch.findMany({
        where: {
          tenantId: tenant.id,
          qtyOnHand: { gt: 0 },          // exhausted batches aren't actionable
          medicine: { isActive: true },
        },
        include: { medicine: { select: { brandName: true, reorderLevel: true } } },
        take: 100,
      }),
      prisma.medicineBatch.findMany({
        where: {
          tenantId: tenant.id,
          qtyOnHand: { gt: 0 },
          expiryDate: { lte: expiryCutoff, gte: now },
        },
        include: { medicine: { select: { brandName: true } } },
        orderBy: { expiryDate: "asc" },
        take: 100,
      }),
    ]);

    // Filter low-stock to ones actually below threshold (SQL had qty>0 only).
    const lowList = lowStock.filter((b) => b.qtyOnHand <= b.medicine.reorderLevel);
    if (lowList.length === 0 && nearExpiry.length === 0) continue;

    // Build the digest body — keep it under ~3 SMS pages (~480 chars).
    const lines: string[] = [`Daily stock alert — ${tenant.name}`];
    if (lowList.length > 0) {
      lines.push(`Low stock (${lowList.length}):`);
      lowList.slice(0, 5).forEach((b) => {
        lines.push(`• ${b.medicine.brandName} — ${b.qtyOnHand} left (reorder at ${b.medicine.reorderLevel})`);
      });
      if (lowList.length > 5) lines.push(`...and ${lowList.length - 5} more`);
    }
    if (nearExpiry.length > 0) {
      lines.push(`Expiring < ${NEAR_EXPIRY_DAYS}d (${nearExpiry.length}):`);
      nearExpiry.slice(0, 5).forEach((b) => {
        lines.push(`• ${b.medicine.brandName} — ${dayjs(b.expiryDate).format("DD MMM")}`);
      });
      if (nearExpiry.length > 5) lines.push(`...and ${nearExpiry.length - 5} more`);
    }
    const body = lines.join("\n");

    // Recipients: PHARMACIST + BRANCH_ADMIN of this tenant. SUPER_ADMIN too —
    // owners want to see the alert.
    const recipients = await prisma.user.findMany({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        isActive: true,
        role: { in: ["PHARMACIST", "BRANCH_ADMIN", "SUPER_ADMIN"] },
        phone: { not: "" },
      },
      select: { id: true, phone: true },
      take: 10,
    });
    if (recipients.length === 0) continue;

    for (const r of recipients) {
      if (!r.phone) continue;
      await notify({
        tenantId: tenant.id,
        to: r.phone,
        body,
        relatedTo: `STOCK_DIGEST:${dateKey}`,
      });
      smsAttempts++;
    }
    tenantsAlerted++;
  }
  return { tenantsAlerted, smsAttempts, scanned: activeTenants.length };
}

// ─── Combined run ────────────────────────────────────────

export async function runClinicOpsAlerts(now: Date = new Date()) {
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[clinic-ops-alerts:${label}]`, err);
      return { error: (err as Error).message };
    }
  };
  const a = await safe("invoiceDue", () => runInvoiceDueReminders(now));
  const b = await safe("stockDigest", () => runStockAlerts(now));
  return { invoiceDue: a, stockDigest: b };
}

// ── Scheduler ────────────────────────────────────────────

let lastRunDate: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function startClinicOpsAlerts() {
  if (timer) return;
  const tick = async () => {
    try {
      // Create dayjs object for Dhaka time (UTC+6)
      let dhakaNow = dayjs();
      dhakaNow = dhakaNow.add(6, "hour");
      const dateKey = dhakaNow.format("YYYY-MM-DD");
      const hour = dhakaNow.hour();
      // Run between 09:00 and 10:00 Dhaka, once per day.
      if ((hour === 9 || hour === 10) && lastRunDate !== dateKey) {
        const r = await runClinicOpsAlerts();
        lastRunDate = dateKey;
        console.log(`[clinic-ops-alerts] ${dateKey}`, JSON.stringify(r));
      }
    } catch (err) {
      console.error("[clinic-ops-alerts] error", err);
    }
  };
  void tick();
  timer = setInterval(tick, 60 * 60 * 1000);
}

export function stopClinicOpsAlerts() {
  if (timer) clearInterval(timer);
  timer = null;
}
