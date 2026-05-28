import { PrismaClient, Prisma } from "@prisma/client";
import { env, isProd } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Slow-query threshold — log every Prisma query that takes longer than this.
// 200 ms is a generous bar for OLTP queries; anything slower is worth a look
// (missing index, accidental table scan, hot row lock, etc.).
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? "200");

const buildClient = () => {
  // In dev we also tap the "query" event so we can flag slow ones. In prod we
  // skip it (event emission has measurable overhead at hundreds of QPS).
  const log: Prisma.LogDefinition[] = isProd
    ? [{ level: "error", emit: "event" }, { level: "warn", emit: "event" }]
    : [
        { level: "query", emit: "event" },
        { level: "warn", emit: "event" },
        { level: "error", emit: "event" },
      ];
  const client = new PrismaClient({ log });

  if (!isProd) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).$on("query", (e: { duration: number; query: string; params: string }) => {
      if (e.duration >= SLOW_MS) {
        const short = e.query.length > 220 ? e.query.slice(0, 220) + "…" : e.query;
        // eslint-disable-next-line no-console
        console.warn(`[slow-query ${e.duration}ms] ${short}`);
      }
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).$on("warn", (e: { message: string }) => console.warn("[prisma]", e.message));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).$on("error", (e: { message: string }) => console.error("[prisma]", e.message));

  return client;
};

export const prisma = global.__prisma ?? buildClient();

if (!isProd) global.__prisma = prisma;
