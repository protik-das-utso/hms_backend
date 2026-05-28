/**
 * In-process TTL cache. Sized for 30-40 clinics: caching the half-dozen
 * "hot read" endpoints (dashboard, token board, platform overview) in
 * the Node process is enough to keep DB load reasonable without pulling
 * Redis into the stack.
 *
 * If you ever run multiple Node instances behind a load balancer, each
 * instance gets its own cache — that's fine (lower hit rate, still works).
 * Promote to Redis only when you have 100+ clinics and 3+ app servers.
 *
 * Concurrency note: `cached()` deduplicates in-flight loads — if 20
 * requests for the same key arrive while the loader is still running, all
 * 20 get the same Promise back. This is critical for hot endpoints — without
 * it a cache miss could trigger 20 parallel identical DB queries.
 */

type Entry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// Soft cap on entries to prevent unbounded growth (e.g. token board with
// dozens of tenantSlug variants). LRU-ish: when over the cap, the oldest
// expired entries are dropped first.
const MAX_ENTRIES = 1000;

const sweep = () => {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
    if (store.size <= MAX_ENTRIES) return;
  }
  // If still over after expiry sweep, drop the oldest entries by insertion order.
  const overflow = store.size - MAX_ENTRIES;
  let dropped = 0;
  for (const k of store.keys()) {
    if (dropped >= overflow) break;
    store.delete(k);
    dropped++;
  }
};

/**
 * Memoise a loader behind a TTL. The loader is only called on miss or
 * expiry; concurrent callers de-duplicate to a single load.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }

  // Single-flight: if another caller is already loading this key, wait for it.
  const ongoing = inflight.get(key);
  if (ongoing) return ongoing as Promise<T>;

  const p = (async () => {
    try {
      const value = await loader();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      sweep();
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** Manually drop a cached entry — call this from mutation paths. */
export function invalidate(key: string): void {
  store.delete(key);
}

/** Drop every key whose name starts with the given prefix. */
export function invalidatePrefix(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

/** Wipe the entire cache. Useful in tests or after a bulk import. */
export function clearAll(): void {
  store.clear();
}

/** Cache stats for /health diagnostics. */
export function stats() {
  const now = Date.now();
  let live = 0;
  for (const v of store.values()) if (v.expiresAt > now) live++;
  return { total: store.size, live, inflight: inflight.size };
}
