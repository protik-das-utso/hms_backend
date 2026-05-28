import dayjs from "dayjs";
import { prisma } from "../config/db";
import { sendSmsByTemplate } from "../utils/notify";

/**
 * Find tomorrow's confirmed/checked-in appointments and send a reminder SMS
 * to each patient. Idempotency: we mark each appointment's `reminderSentAt`
 * in the notifications log via `relatedTo` so re-runs don't double-send
 * (we filter on already-sent in the current Dhaka day).
 *
 * Designed to fire once a day around 9am Asia/Dhaka.
 */
export async function runAppointmentReminders(now: Date = new Date()) {
  // Get current time in Asia/Dhaka
  const dhakaNow = dayjs(now).add(6, "hour");
  // Tomorrow window in Asia/Dhaka local time.
  const start = dhakaNow.add(1, "day").startOf("day").toDate();
  const end = dhakaNow.add(1, "day").endOf("day").toDate();

  // Today (Dhaka) — used to de-dupe sends.
  const todayStartDhaka = dhakaNow.startOf("day").toDate();

  // Fetch tenant ids once so we can list templates / detect missing config.
  const appointments = await prisma.appointment.findMany({
    where: {
      slotStart: { gte: start, lte: end },
      status: { in: ["BOOKED", "CHECKED_IN"] },
    },
    include: {
      patient: { select: { id: true, name: true, phone: true } },
      doctor: { select: { name: true } },
    },
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const a of appointments) {
    if (!a.patient.phone) { skipped++; continue; }
    // Already sent today?
    const dup = await prisma.notification.findFirst({
      where: {
        tenantId: a.tenantId,
        toAddress: a.patient.phone,
        relatedTo: `APPT_REMINDER:${a.id}`,
        createdAt: { gte: todayStartDhaka },
      },
      select: { id: true },
    });
    if (dup) { skipped++; continue; }

    const res = await sendSmsByTemplate({
      tenantId: a.tenantId,
      code: "APPT_REMINDER",
      to: a.patient.phone,
      vars: {
        name: a.patient.name,
        doctor: a.doctor.name,
        slot: dayjs(a.slotStart).format("DD MMM YYYY, hh:mm A"),
        token: a.tokenNumber,
      },
      relatedTo: `APPT_REMINDER:${a.id}`,
    });
    if (res.status === "SENT") sent++;
    else if (res.status === "SKIPPED") skipped++;
    else failed++;
  }
  return { date: dayjs(start).format("YYYY-MM-DD"), total: appointments.length, sent, skipped, failed };
}

let lastRunDate: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function startAppointmentReminders() {
  if (timer) return;
  const tick = async () => {
    try {
      const now = new Date();
      // Create dayjs object for Dhaka time (UTC+6)
      let dhakaNow = dayjs(now);
      dhakaNow = dhakaNow.add(6, "hour");
      const dateKey = dhakaNow.format("YYYY-MM-DD");
      const hour = dhakaNow.hour();
      // Run between 09:00 and 10:00 Dhaka, once per day
      if ((hour === 9 || hour === 10) && lastRunDate !== dateKey) {
        const r = await runAppointmentReminders(now);
        lastRunDate = dateKey;
        console.log(`[appt-reminder] ${r.date}: ${r.sent} sent · ${r.skipped} skipped · ${r.failed} failed`);
      }
    } catch (err) {
      console.error("[appt-reminder] error", err);
    }
  };
  void tick();
  timer = setInterval(tick, 60 * 60 * 1000);
}

export function stopAppointmentReminders() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
