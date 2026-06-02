/**
 * OneSet KV Backup Worker.
 *
 * Trigger paths:
 *   1. Cron — env.AGENT_KV → JSON → env.BACKUPS (R2). Fires daily per wrangler.toml.
 *   2. Manual via POST /__run with X-Backup-Secret header (for ad-hoc backup / testing).
 *
 * Why a separate worker (vs adding to agent-cron):
 *   - Isolation: a KV-list scan can be slow and we don't want to block the per-minute
 *     cron tick that drives CCTP V2 state machines.
 *   - Different cadence (daily vs per-minute) → cleaner as its own worker.
 *   - Different KV access pattern (full scan vs sharded indexes) → easier to reason about.
 *
 * Backup format (single JSON blob in R2):
 *   {
 *     "version": 1,
 *     "snapshotAt": "2026-05-17T02:00:00.000Z",
 *     "namespace": "arcswap-agents-prod",
 *     "keyCount": <number>,
 *     "entries": {
 *        "<key1>": <value1>,    // value is JSON-parsed if it parses, else raw string
 *        "<key2>": <value2>,
 *        ...
 *     }
 *   }
 *
 * Stored at TWO paths in R2:
 *   kv-backup-YYYY-MM-DD.json   — date-stamped, kept 30 days
 *   kv-backup-latest.json       — always points to the most recent snapshot
 *
 * Retention: after each successful backup, delete date-stamped objects older than 30 days.
 */

const RETENTION_DAYS = 30;

// Metrics rollup config — must match functions/api/metrics/[[path]].js
const METRICS_EVENT_TYPES = ['trade','deposit','spend','bridge','agent-create','agent-exec','failure'];
const METRICS_CHAIN_KEYS  = ['arc','sepolia','baseSepolia','arbitrumSepolia','optimismSepolia','avalancheFuji','polygonAmoy','unichainSepolia'];
const METRICS_SERIES_DAYS = 30;
const METRICS_SUMMARY_KEY = 'metric:summary:v1';

export default {
  /**
   * Cron trigger — fired by Cloudflare on the schedule in wrangler.toml.
   * Cloudflare passes `event.scheduledTime` (epoch ms) which we use as the snapshot timestamp.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env, new Date(event.scheduledTime), 'cron'));
  },

  /**
   * HTTP trigger — only the /__run endpoint, gated by BACKUP_SECRET.
   * Lets you (or a CI job) trigger a backup on demand without waiting for cron.
   */
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== '/__run') {
      return new Response('Not found', { status: 404 });
    }
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    // Auth: require shared secret matching env.BACKUP_SECRET.
    // Defense-in-depth — even though *.workers.dev URLs are unguessable, a leaked URL
    // shouldn't let anyone trigger arbitrary backups (cost + log noise).
    const provided = req.headers.get('X-Backup-Secret') || '';
    const expected = env.BACKUP_SECRET || '';
    if (!expected) {
      return new Response('Worker misconfigured: BACKUP_SECRET not set', { status: 500 });
    }
    if (!constantTimeEquals(provided, expected)) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const result = await runBackup(env, new Date(), 'manual');
      return Response.json(result);
    } catch (e) {
      return new Response(`Backup failed: ${e?.message || e}`, { status: 500 });
    }
  },
};

/**
 * Core backup routine — runs the KV scan, writes to R2, prunes old snapshots.
 * Returns a summary object for the manual endpoint (cron callers ignore it).
 */
async function runBackup(env, snapshotDate, source) {
  const t0 = Date.now();
  const isoDate = snapshotDate.toISOString().slice(0, 10); // "2026-05-17"
  const isoTime = snapshotDate.toISOString();

  console.log(`[kv-backup] start (source=${source}, date=${isoDate})`);

  // Step 1: enumerate every key in AGENT_KV (paginated).
  // We MUST use kv.list() here even though our app code avoids it — backup needs
  // EVERY key, not just the indexed ones.
  const allKeys = await listAllKeys(env.AGENT_KV);
  console.log(`[kv-backup] listed ${allKeys.length} keys in ${Date.now() - t0}ms`);

  // Step 2: fetch each key's value in parallel batches.
  // Workers KV reads are fast (~5ms each) but doing them serially for 1000s of keys
  // is slow. Batches of 50 strike a balance — avoids overwhelming the runtime.
  const entries = await fetchAllValues(env.AGENT_KV, allKeys, 50);
  console.log(`[kv-backup] fetched ${Object.keys(entries).length} values in ${Date.now() - t0}ms total`);

  // Step 3: serialize the snapshot.
  const snapshot = {
    version: 1,
    snapshotAt: isoTime,
    namespace: 'arcswap-agents-prod',
    keyCount: allKeys.length,
    source,
    entries,
  };
  const body = JSON.stringify(snapshot, null, 2);
  const sizeKb = (body.length / 1024).toFixed(1);

  // Step 4: write to R2 at two paths — date-stamped (history) and 'latest' (pointer).
  const datedKey = `kv-backup-${isoDate}.json`;
  const latestKey = 'kv-backup-latest.json';
  const metadata = {
    httpMetadata: { contentType: 'application/json' },
    // Custom metadata lets you find this snapshot's stats without downloading it.
    customMetadata: {
      snapshotAt: isoTime,
      keyCount: String(allKeys.length),
      source,
    },
  };
  await Promise.all([
    env.BACKUPS.put(datedKey, body, metadata),
    env.BACKUPS.put(latestKey, body, metadata),
  ]);
  console.log(`[kv-backup] wrote R2: ${datedKey} (${sizeKb} KB) + ${latestKey}`);

  // Step 5: prune backups older than RETENTION_DAYS.
  // We only delete date-stamped files matching `kv-backup-YYYY-MM-DD.json` —
  // never touch the `kv-backup-latest.json` pointer.
  const cutoff = new Date(snapshotDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const deleted = await pruneOldBackups(env.BACKUPS, cutoff);

  // Step 6: reconcile the metrics rollup cache (`metric:summary:v1`) from
  // raw counters. The /api/metrics/track hot path does best-effort
  // read-modify-write updates that can lose +1 increments on concurrent
  // writes. Once per day we rebuild from the raw `metric:count:*` and
  // `metric:total:*` keys to repair any drift.
  //
  // We already have a fresh `entries` map from the backup scan, so we can
  // reconcile WITHOUT any extra KV reads — just iterate the in-memory map.
  let reconcileResult = null;
  try {
    reconcileResult = await reconcileMetricsRollup(env.AGENT_KV, entries);
    console.log(`[kv-backup] reconciled metrics rollup:`, reconcileResult);
  } catch (e) {
    console.warn(`[kv-backup] reconcile failed (non-fatal):`, e?.message);
  }

  const summary = {
    ok: true,
    source,
    snapshotAt: isoTime,
    keyCount: allKeys.length,
    sizeKb: Number(sizeKb),
    durationMs: Date.now() - t0,
    deletedOldBackups: deleted,
    metricsReconcile: reconcileResult,
  };
  console.log(`[kv-backup] done`, summary);
  return summary;
}

/**
 * Rebuild `metric:summary:v1` from the raw `metric:count:*` and
 * `metric:total:*` keys we already have in `entries` (fresh from the
 * backup scan — zero extra KV reads). Writes the new rollup back to KV.
 *
 * Why: the /track hot path uses read-modify-write on the rollup key,
 * which loses +1 increments under concurrent writes. The raw counters
 * use separate keys per (day, event, chain) so they are far less
 * contended. This nightly reconcile keeps the rollup eventually-correct.
 */
async function reconcileMetricsRollup(kv, entries) {
  const today = utcDateString(new Date());

  // Build day list (last SERIES_DAYS days ending today, UTC).
  const days = [];
  const d0 = new Date();
  for (let i = METRICS_SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(d0); d.setUTCDate(d0.getUTCDate() - i);
    days.push(utcDateString(d));
  }
  const dayHas = new Set(days);

  const r = {
    version: 1,
    computedAt: new Date().toISOString(),
    todayKey: today,
    lifetime: {},
    byDay: {},
    byChainToday: {},
    fpToday: {},
  };
  for (const e of METRICS_EVENT_TYPES) r.lifetime[e] = 0;

  // Lifetime totals
  for (const e of METRICS_EVENT_TYPES) {
    const v = entries[`metric:total:${e}`];
    r.lifetime[e] = parseIntSafe(v);
  }

  // Per-day per-event + per-chain — iterate `entries` once, much cheaper
  // than reading 7×30 + 7×8 individual keys.
  const countRe       = /^metric:count:(\d{4}-\d{2}-\d{2}):([a-z-]+)$/;
  const countChainRe  = /^metric:count:(\d{4}-\d{2}-\d{2}):([a-z-]+):([A-Za-z]+)$/;
  for (const [k, v] of Object.entries(entries)) {
    // Per-day per-event
    let m = k.match(countRe);
    if (m && dayHas.has(m[1])) {
      const day = m[1], event = m[2];
      if (METRICS_EVENT_TYPES.includes(event)) {
        const n = parseIntSafe(v);
        if (n > 0) {
          r.byDay[day] = r.byDay[day] || {};
          r.byDay[day][event] = n;
        }
      }
      continue;
    }
    // Per-day per-event per-chain (only today matters for byChainToday)
    m = k.match(countChainRe);
    if (m && m[1] === today) {
      const event = m[2], chain = m[3];
      if (METRICS_EVENT_TYPES.includes(event) && METRICS_CHAIN_KEYS.includes(chain)) {
        const n = parseIntSafe(v);
        if (n > 0) {
          r.byChainToday[chain] = r.byChainToday[chain] || {};
          r.byChainToday[chain][event] = n;
        }
      }
    }
  }

  // fpToday — count `metric:user:<today>:<fp>` markers from entries.
  const userPrefix = `metric:user:${today}:`;
  for (const k of Object.keys(entries)) {
    if (k.startsWith(userPrefix)) {
      r.fpToday[k.slice(userPrefix.length)] = 1;
    }
  }

  await kv.put(METRICS_SUMMARY_KEY, JSON.stringify(r));

  return {
    todayKey: today,
    seriesDays: Object.keys(r.byDay).length,
    activeFingerprints: Object.keys(r.fpToday).length,
    lifetimeTotal: Object.values(r.lifetime).reduce((a, b) => a + b, 0),
  };
}

function utcDateString(d) {
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth()+1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

function parseIntSafe(v) {
  // entries[k] may be a parsed JSON value (number) or a string (since
  // fetchAllValues JSON.parses when possible). Counters are stored as
  // strings like "42" so they parse to numbers.
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/**
 * Iterate kv.list() with cursor pagination to collect every key name.
 * Cloudflare KV returns up to 1000 keys per list call.
 */
async function listAllKeys(kv) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return names;
}

/**
 * Fetch values for `keys` in parallel batches of `batchSize`.
 * Each value is JSON-parsed if possible (since our app always stores JSON);
 * if a value isn't valid JSON we keep it as a string.
 */
async function fetchAllValues(kv, keys, batchSize) {
  const out = {};
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const values = await Promise.all(batch.map(k => kv.get(k, 'text')));
    for (let j = 0; j < batch.length; j++) {
      const raw = values[j];
      if (raw === null) continue; // key was deleted between list and get — skip
      try {
        out[batch[j]] = JSON.parse(raw);
      } catch {
        out[batch[j]] = raw;
      }
    }
  }
  return out;
}

/**
 * Delete R2 objects matching `kv-backup-YYYY-MM-DD.json` whose date is before `cutoff`.
 * Iterates R2 list with pagination.
 */
async function pruneOldBackups(bucket, cutoff) {
  const namePattern = /^kv-backup-(\d{4}-\d{2}-\d{2})\.json$/;
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const toDelete = [];

  let truncated = true;
  let cursor;
  while (truncated) {
    const listed = await bucket.list({ prefix: 'kv-backup-', cursor, limit: 1000 });
    for (const obj of listed.objects) {
      const m = obj.key.match(namePattern);
      if (!m) continue; // not a date-stamped backup (e.g. kv-backup-latest.json) — skip
      if (m[1] < cutoffIso) toDelete.push(obj.key);
    }
    truncated = listed.truncated;
    cursor = listed.cursor;
  }

  if (toDelete.length > 0) {
    // R2 delete supports a single key per call; loop in parallel batches.
    const batchSize = 20;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      await Promise.all(toDelete.slice(i, i + batchSize).map(k => bucket.delete(k)));
    }
    console.log(`[kv-backup] pruned ${toDelete.length} old backups (< ${cutoffIso})`);
  }
  return toDelete.length;
}

/**
 * Constant-time string compare to prevent timing attacks on BACKUP_SECRET.
 * Even though *.workers.dev URLs are unguessable, every auth check should be
 * constant-time as a matter of habit.
 */
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
