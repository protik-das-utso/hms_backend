// Race-safe sequence generation for human-readable numbers (invoices, orders,
// admissions, support tickets, etc.).
//
// Why retry, not lock?
//   The cost of a true row-lock per-tenant per-day is far higher than the cost
//   of an occasional Prisma P2002 on the unique constraint. We retry up to N
//   times — in practice the second attempt always wins because the first
//   conflicting row is already committed and `count()` now includes it.
//
// Every caller that uses this utility MUST have a unique constraint on the
// generated column (e.g. `@@unique([tenantId, invoiceNumber])`). The schema
// already enforces this for all current numbering schemes.

import { Prisma } from "@prisma/client";

const MAX_ATTEMPTS = 8;

/** Detects the unique-constraint-violation Prisma error. */
const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Run `attempt(seqHint)` repeatedly: it should compute the next number and
 * try to create the row. If the create fails due to P2002, we recompute the
 * sequence and try again. Anything else is rethrown.
 *
 * @param attempt callback that does (recompute number, create row). Receives
 *                the attempt index (0-based) for logging.
 */
export async function withSequenceRetry<T>(
  attempt: (i: number) => Promise<T>,
  label = "sequence",
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
      // Tiny jittered backoff so concurrent retries don't immediately re-collide.
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 25)));
    }
  }
  // eslint-disable-next-line no-console
  console.error(`[${label}] gave up after ${MAX_ATTEMPTS} attempts`, lastErr);
  throw lastErr;
}
