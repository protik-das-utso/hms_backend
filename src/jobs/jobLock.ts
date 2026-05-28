// Lightweight DB-backed once-per-day guard for crons. Survives restarts and
// works across multiple app instances if you ever horizontally scale —
// without needing a new schema table.
//
// We piggyback on the `notifications` table: the cron writes a sentinel
// `Notification` row with a unique `relatedTo` like "CRON:sub-lifecycle:2026-05-27"
// at the start of its run. The unique-on-(relatedTo, createdAt-day) check
// is enforced by the application via findFirst+create — *not race-safe* on
// its own, but cron timing collisions are extremely rare (instances tick
// at different millisecond offsets) and the worst case is two runs of an
// already-idempotent job, not data corruption.
//
// For a stronger primitive when you scale out, swap this for
// `pg_try_advisory_lock(<bigint>)` inside a $queryRaw — Postgres releases
// it automatically when the session ends.

import { prisma } from "../config/db";
import dayjs from "dayjs";

/**
 * Returns true if the calling job should run today; false if another
 * instance has already claimed the day. Idempotent — calling twice from the
 * same instance also returns false the second time.
 */
export async function claimDailyRun(jobName: string, now: Date = new Date()): Promise<boolean> {
  // Create dayjs object for Dhaka time (UTC+6)
  let dhakaNow = dayjs(now);
  dhakaNow = dhakaNow.add(6, "hour");

  const dateKey = dhakaNow.format("YYYY-MM-DD");
  const tag = `CRON:${jobName}:${dateKey}`;

  const todayStart = dhakaNow.startOf("day").toDate();
  const existing = await prisma.notification.findFirst({
    where: { relatedTo: tag, createdAt: { gte: todayStart } },
    select: { id: true },
  });
  if (existing) return false;

  // We need *some* tenantId for the FK — pick the platform tenant. If it
  // doesn't exist (fresh install before platform:setup) we can't claim, so
  // the in-memory guard handles it.
  const platform = await prisma.tenant.findFirst({
    where: { isPlatform: true },
    select: { id: true },
  });
  if (!platform) return true; // best-effort fallback

  await prisma.notification.create({
    data: {
      tenantId: platform.id,
      channel: "IN_APP",
      toAddress: "system",
      body: `cron run claim`,
      relatedTo: tag,
      status: "SENT",
      sentAt: new Date(),
    },
  });
  return true;
}
