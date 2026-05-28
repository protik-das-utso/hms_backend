import dayjs from "dayjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db";

/**
 * Daily bed-charge job.
 *
 * For each active admission with an active bed allocation, insert an IpdCharge
 * BED row for yesterday's calendar date (Asia/Dhaka). Idempotent thanks to the
 * partial unique on ipd_charges(admissionId, chargeDate, chargeType) WHERE
 * chargeType='BED' AND refId IS NULL — re-running the same day is a no-op.
 *
 * The admission day itself is charged at `admit` time, so this job only needs
 * to handle every day *after* admission (i.e. days strictly between admittedAt
 * and dischargedAt, inclusive of the previous day, exclusive of the discharge
 * day per common BD hospital billing).
 */
export async function runDailyBedCharges(now: Date = new Date()) {
  const yesterday = dayjs(now).subtract(1, "day").startOf("day").toDate();
  // We only charge if the admission was active AT some point on the target
  // day — i.e. admittedAt <= end of day AND (dischargedAt is null OR
  // dischargedAt > start of day).
  const dayStart = dayjs(yesterday).startOf("day").toDate();
  const dayEnd = dayjs(yesterday).endOf("day").toDate();

  const admissions = await prisma.admission.findMany({
    where: {
      status: "ADMITTED",
      admittedAt: { lte: dayEnd },
    },
    include: {
      allocations: {
        where: { toTs: null },
        include: { bed: { select: { id: true, dailyRate: true, code: true, ward: { select: { name: true } } } } },
      },
    },
  });

  let inserted = 0;
  let skipped = 0;

  for (const a of admissions) {
    // Skip if this admission was admitted today (admit-day charge is created
    // synchronously by the admit endpoint).
    if (dayjs(a.admittedAt).startOf("day").isAfter(dayjs(yesterday))) {
      skipped++;
      continue;
    }
    const alloc = a.allocations[0];
    if (!alloc) {
      // Active admission with no active allocation — data anomaly. Skip
      // rather than guess.
      skipped++;
      continue;
    }
    try {
      await prisma.ipdCharge.create({
        data: {
          tenantId: a.tenantId,
          admissionId: a.id,
          chargeDate: dayStart,
          chargeType: "BED",
          description: `Bed charge — ${alloc.bed.ward.name} · ${alloc.bed.code}`,
          qty: 1,
          unitPrice: alloc.bed.dailyRate,
          amount: alloc.bed.dailyRate,
          refTable: "beds",
          refId: null,
          createdById: null,
        },
      });
      inserted++;
    } catch (err) {
      // P2002 = the partial unique caught a re-run — silently skip.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        skipped++;
        continue;
      }
      throw err;
    }
  }

  return { date: dayjs(yesterday).format("YYYY-MM-DD"), inserted, skipped };
}

/**
 * Small in-process scheduler — no external dependency. Wakes once every hour,
 * runs the job if it's the target hour (00:30 Asia/Dhaka equivalent) and the
 * job hasn't been run for that day yet.
 *
 * In a multi-instance deployment this would need a database lock or a real
 * job runner. For single-node MVP, this is fine.
 */
let lastRunDate: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function startIpdDailyCharges() {
  if (timer) return; // already started
  const tick = async () => {
    try {
      // Create dayjs object for Dhaka time (UTC+6)
      let dhakaNow = dayjs();
      dhakaNow = dhakaNow.add(6, "hour");
      // Run between 00:30 and 01:30 Dhaka — wide window so the next interval
      // tick after midnight always picks it up. The lastRunDate check makes it
      // safe to fire multiple times in the window.
      const hour = dhakaNow.hour();
      if ((hour === 0 || hour === 1) && lastRunDate !== dhakaNow.format("YYYY-MM-DD")) {
        const r = await runDailyBedCharges();
        lastRunDate = dhakaNow.format("YYYY-MM-DD");
        console.log(`[ipd-cron] ${r.date}: +${r.inserted} bed charges, ${r.skipped} skipped`);
      }
    } catch (err) {
      console.error("[ipd-cron] error", err);
    }
  };
  // Run once at startup (catches missed cron runs after a restart) and then hourly.
  void tick();
  timer = setInterval(tick, 60 * 60 * 1000);
}

export function stopIpdDailyCharges() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
