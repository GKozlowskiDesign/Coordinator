/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { paywall } from './x402-paywall';
import { AI_MODELS } from './ai-models';


const PER_DEVICE_PRICE = process.env.SURVEY_DEVICE_PRICE_USDC || '0.25';

const app = express();
app.set('trust proxy', 1);

/**
 * CORS
 * Configure allowed web origins via:
 *   APP_ORIGINS="https://elevator-network-d-app.vercel.app,http://localhost:3000"
 * or set NEXT_PUBLIC_APP_ORIGIN for a single origin.
 */
const rawOrigins =
  process.env.APP_ORIGINS ||
  process.env.NEXT_PUBLIC_APP_ORIGIN ||
  'http://localhost:3000';

const ALLOWED_ORIGINS = rawOrigins.split(',').map((s) => s.trim()).filter(Boolean);

// also allow Vercel previews (optional)
const ALLOW_VERCEL_PREVIEWS = true;

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    const host = (() => {
      try {
        return new URL(origin).hostname;
      } catch {
        return '';
      }
    })();
    const ok =
      ALLOWED_ORIGINS.includes(origin) ||
      (ALLOW_VERCEL_PREVIEWS && /\.vercel\.app$/.test(host));
    return cb(ok ? null : new Error('CORS not allowed'), ok);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-solana-signature', 'X-PAYMENT'],
  credentials: false,
  maxAge: 86400,
};
app.use(cors(corsOptions));
app.use(express.json());

// ---------- SQLite -----------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'coordinator.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---- helpers for migrations -------------------------------------------------
function tableHasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing(table: string, column: string, declNoConstraints: string) {
  if (!tableHasColumn(table, column)) {
    console.log(`[db] migrating: adding column ${table}.${column}`);
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${declNoConstraints}`).run();
  }
}
function createIndexIfMissing(sql: string) {
  db.exec(sql); // requires IF NOT EXISTS in SQL
}

// ---- create tables if they never existed -----------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    host_id TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    difficulty INTEGER NOT NULL DEFAULT 1,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_credits (
    wallet TEXT PRIMARY KEY,
    total INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hosts (
    host_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    controller_wallet TEXT,
    attached_wallet TEXT,
    attached_device_id TEXT,
    site_label TEXT,
    enabled INTEGER DEFAULT 0
  );

    CREATE TABLE IF NOT EXISTS ai_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    model_id TEXT NOT NULL,
    host_id TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    taken_device_id TEXT,
    taken_ts INTEGER
  );


  -- PUTE credits (AI paywall balance)
  CREATE TABLE IF NOT EXISTS pute_credits (
    wallet TEXT PRIMARY KEY,
    total INTEGER NOT NULL
  );
`);

// ---- MIGRATE older DBs (order matters!) ------------------------------------
addColumnIfMissing('shares', 'device_id', 'TEXT');
addColumnIfMissing('hosts', 'attached_device_id', 'TEXT');
addColumnIfMissing('hosts', 'site_label', 'TEXT');

// GPU-related metadata
addColumnIfMissing('hosts', 'gpu_reported_model', 'TEXT');
addColumnIfMissing('hosts', 'gpu_verified', 'INTEGER NOT NULL DEFAULT 0');

try {
  db.prepare(`UPDATE shares SET device_id='' WHERE device_id IS NULL`).run();
} catch {}

createIndexIfMissing(
  `CREATE INDEX IF NOT EXISTS idx_shares_ts ON shares(ts DESC)`
);
createIndexIfMissing(
  `CREATE INDEX IF NOT EXISTS idx_shares_wallet ON shares(wallet)`
);
createIndexIfMissing(
  `CREATE INDEX IF NOT EXISTS idx_shares_host ON shares(host_id)`
);
createIndexIfMissing(
  `CREATE INDEX IF NOT EXISTS idx_shares_device ON shares(device_id)`
);
createIndexIfMissing(
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_hosts_attached_device ON hosts(attached_device_id)`
);

// ---------- prepared statements ---------------------------------------------
const insertShare = db.prepare(`
  INSERT INTO shares (wallet, host_id, device_id, difficulty, ts)
  VALUES (@wallet, @hostId, @deviceId, @difficulty, @ts)
`);
const upsertCredit = db.prepare(`
  INSERT INTO wallet_credits (wallet, total) VALUES (@wallet, @total)
  ON CONFLICT(wallet) DO UPDATE SET total = excluded.total
`);
const getCredit = db.prepare(
  `SELECT total FROM wallet_credits WHERE wallet = ?`,
);
const setCredit = db.prepare(
  `UPDATE wallet_credits SET total = ? WHERE wallet = ?`,
);

const getRecent = db.prepare(`
  SELECT wallet, host_id as hostId, device_id as deviceId, difficulty, ts
  FROM shares
  ORDER BY ts DESC
  LIMIT @limit
`);
const getStats = db.prepare(`
  SELECT (SELECT COUNT(*) FROM shares) as totalShares,
         (SELECT COUNT(*) FROM wallet_credits) as totalWallets,
         (SELECT MAX(ts) FROM shares) as lastShareTs
`);

const getMarketHosts = db.prepare(`
  SELECT
    h.host_id as hostId,
    h.owner_wallet as owner,
    h.attached_device_id as deviceId,
    h.site_label as site,
    (SELECT MAX(s.ts) FROM shares s WHERE s.host_id = h.host_id) as lastShareTs
  FROM hosts h
  WHERE
    h.enabled = 1
    AND h.attached_device_id IS NOT NULL
`);

// ---- AI job queue ----------------------------------------------------------
const insertAiJob = db.prepare(`
  INSERT INTO ai_jobs (
    wallet,
    model_id,
    host_id,
    prompt,
    status,
    created_ts,
    updated_ts
  )
  VALUES (@wallet, @modelId, @hostId, @prompt, @status, @createdTs, @updatedTs)
`);

const getAiJob = db.prepare(`
  SELECT *
  FROM ai_jobs
  WHERE id = ?
`);

const claimNextAiJob = db.prepare(`
  UPDATE ai_jobs
  SET
    status = 'running',
    host_id = COALESCE(host_id, @hostId),
    taken_device_id = @deviceId,
    taken_ts = @now,
    updated_ts = @now
  WHERE id = (
    SELECT id
    FROM ai_jobs
    WHERE status = 'queued'
      AND (host_id IS NULL OR host_id = @hostId)
    ORDER BY created_ts ASC
    LIMIT 1
  )
  RETURNING *
`);

const completeAiJob = db.prepare(`
  UPDATE ai_jobs
  SET
    status = @status,
    result = @result,
    error = @error,
    updated_ts = @now
  WHERE id = @id
`);


// PUTE credits prepared statements
const getPuteCredit = db.prepare(
  `SELECT total FROM pute_credits WHERE wallet = ?`,
);
const upsertPuteCredit = db.prepare(`
  INSERT INTO pute_credits (wallet, total) VALUES (@wallet, @total)
  ON CONFLICT(wallet) DO UPDATE SET total = excluded.total
`);

// ---------- SSE --------------------------------------------------------------
type Client = { id: number; res: express.Response };
const clients: Client[] = [];
let nextId = 1;

function broadcast(event: string, payload: any) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(data);
    } catch {}
  }
}

app.get('/events', (_req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  (res as any).flushHeaders?.();
  const id = nextId++;
  clients.push({ id, res });
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  res.on('close', () => {
    const i = clients.findIndex((c) => c.id === id);
    if (i >= 0) clients.splice(i, 1);
  });
});

// ---------- Miner/device binding + GPU report --------------------------------
app.post('/host/hello', (req, res) => {
  const { hostId, deviceId, wallet, site, gpuModel } = req.body || {};
  if (!hostId || !deviceId || !wallet) {
    return res
      .status(400)
      .json({ ok: false, error: 'hostId, deviceId and wallet required' });
  }

  const row = db
    .prepare(
      `
    SELECT owner_wallet,
           attached_wallet,
           attached_device_id,
           gpu_reported_model,
           gpu_verified
    FROM hosts WHERE host_id=?`,
    )
    .get(hostId) as
    | {
        owner_wallet: string;
        attached_wallet?: string | null;
        attached_device_id?: string | null;
        gpu_reported_model?: string | null;
        gpu_verified?: number | null;
      }
    | undefined;

  if (!row)
    return res
      .status(404)
      .json({ ok: false, error: 'host_not_registered' });

  const cleanedGpu = (gpuModel && String(gpuModel).trim()) || null;

  if (!row.attached_device_id) {
    try {
      db.prepare(
        `
        UPDATE hosts
        SET attached_device_id = ?,
            attached_wallet    = ?,
            site_label         = COALESCE(?, site_label),
            gpu_reported_model = COALESCE(?, gpu_reported_model),
            gpu_verified       = CASE WHEN ? IS NOT NULL AND ? <> '' THEN 1 ELSE gpu_verified END
        WHERE host_id = ?
      `,
      ).run(deviceId, wallet, site || null, cleanedGpu, cleanedGpu, cleanedGpu, hostId);
      broadcast('host', { hostId });
      return res.json({
        ok: true,
        bound: true,
        hostId,
        deviceId,
        wallet,
      });
    } catch {
      return res
        .status(409)
        .json({ ok: false, error: 'device_bind_conflict' });
    }
  }

  if (row.attached_device_id !== deviceId) {
    return res
      .status(403)
      .json({ ok: false, error: 'device_mismatch' });
  }

  if (row.attached_wallet !== wallet || cleanedGpu !== row.gpu_reported_model) {
    db.prepare(
      `
      UPDATE hosts
      SET attached_wallet    = ?,
          gpu_reported_model = COALESCE(?, gpu_reported_model),
          gpu_verified       = CASE WHEN ? IS NOT NULL AND ? <> '' THEN 1 ELSE gpu_verified END
      WHERE host_id = ?
    `,
    ).run(wallet, cleanedGpu, cleanedGpu, cleanedGpu, hostId);
    broadcast('host', { hostId });
  }

  return res.json({ ok: true, bound: true, hostId, deviceId, wallet });
});

// ---------- SURVEY SUBMIT (paywalled via x402-paywall) -----------------------
app.post(
  '/surveys/:surveyId/devices/:deviceNumber/submit',
  paywall(
    (req) =>
      `survey:${req.params.surveyId}:device:${req.params.deviceNumber}:submit`,
    { currency: 'USDC', value: PER_DEVICE_PRICE },
  ),
  async (req, res) => {
    // Payment verified at this point.
    // TODO: persist payload (answers, files metadata, etc.)
    res.json({
      ok: true,
      surveyId: req.params.surveyId,
      deviceNumber: req.params.deviceNumber,
      paid: true,
    });
  },
);

// ---------- Mining API (NO paywall) -----------------------------------------
app.post('/share', (req, res) => {
  const { wallet, hostId, deviceId, difficulty = 1 } = req.body || {};
  if (!wallet || !hostId || !deviceId) {
    return res
      .status(400)
      .json({ error: 'wallet, hostId, deviceId required' });
  }

  const host = db
    .prepare(
      `
    SELECT enabled,
           owner_wallet,
           controller_wallet,
           attached_wallet,
           attached_device_id,
           gpu_reported_model,
           gpu_verified
    FROM hosts WHERE host_id=?`,
    )
    .get(hostId) as
    | {
        enabled: number;
        owner_wallet: string;
        controller_wallet?: string | null;
        attached_wallet?: string | null;
        attached_device_id?: string | null;
        gpu_reported_model?: string | null;
        gpu_verified?: number | null;
      }
    | undefined;

  if (!host) return res.status(404).json({ error: 'unknown_host' });
  if (Number(host.enabled) !== 1)
    return res.status(403).json({ error: 'host_disabled' });
  if (!host.attached_device_id || host.attached_device_id !== deviceId) {
    return res
      .status(403)
      .json({ error: 'device_not_authorized' });
  }

  // GPU must be reported and verified
  if (!host.gpu_reported_model || Number(host.gpu_verified ?? 0) !== 1) {
    return res.status(403).json({ error: 'gpu_not_verified' });
  }

  const allowedWallet = host.attached_wallet || host.owner_wallet;
  if (allowedWallet && allowedWallet !== wallet) {
    return res
      .status(403)
      .json({ error: 'wallet_not_authorized' });
  }

  const diff = Number.isFinite(+difficulty)
    ? Math.max(1, Number(difficulty))
    : 1;
  const ts = Date.now();

  const tx = db.transaction(() => {
    insertShare.run({ wallet, hostId, deviceId, difficulty: diff, ts });
    const current = getCredit.get(wallet) as { total?: number } | undefined;
    const total = (current?.total || 0) + diff;
    upsertCredit.run({ wallet, total });
    return total;
  });
  const total = tx();

  const payload = { wallet, hostId, deviceId, difficulty: diff, ts, total };
  broadcast('share', payload);
  res.json({ ok: true, ...payload });
});

// ---------- Read API: mining credits / shares / stats ------------------------
app.get('/credits/:wallet', (req, res) => {
  const row = getCredit.get(req.params.wallet) as
    | { total: number }
    | undefined;
  res.json({ wallet: req.params.wallet, total: row?.total || 0 });
});

/** Settle mining credits after an airdrop claim */
app.post('/credits/settle', (req, res) => {
  try {
    const wallet = String(req.body?.wallet || '');
    const amount = Number(req.body?.amount || 0);
    if (!wallet)
      return res
        .status(400)
        .json({ ok: false, error: 'wallet_required' });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'bad_amount' });
    }

    const curRow = getCredit.get(wallet) as { total?: number } | undefined;
    const cur = Math.max(0, Number(curRow?.total ?? 0));
    const next = Math.max(0, cur - Math.floor(amount));

    if (curRow) setCredit.run(next, wallet);
    else upsertCredit.run({ wallet, total: next });

    broadcast('credits', { wallet, total: next });
    return res.json({ ok: true, wallet, total: next });
  } catch (e: any) {
    console.error('/credits/settle error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'internal_error' });
  }
});

app.get('/shares/recent', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const items = getRecent.all({ limit }) as Array<{
    wallet: string;
    hostId: string;
    deviceId: string;
    difficulty: number;
    ts: number;
  }>;
  res.json({ items });
});

app.get('/stats', (_req, res) => {
  const row = getStats.get() as {
    totalShares: number;
    totalWallets: number;
    lastShareTs: number | null;
  };
  res.json({
    totalShares: row.totalShares || 0,
    totalWallets: row.totalWallets || 0,
    lastShareTs: row.lastShareTs ?? null,
    dbPath: DB_PATH,
    wal: true,
  });
});

// ---------- Host read APIs ---------------------------------------------------
app.get('/host-state', (req, res) => {
  const hostId = String(req.query.hostId || '');
  if (!hostId)
    return res.status(400).json({ error: 'hostId required' });

  const row = db
    .prepare(
      `
    SELECT enabled,
           owner_wallet,
           controller_wallet,
           attached_wallet,
           attached_device_id,
           site_label,
           gpu_reported_model,
           gpu_verified
    FROM hosts WHERE host_id=?`,
    )
    .get(hostId) as
    | {
        enabled: number;
        owner_wallet: string;
        controller_wallet?: string | null;
        attached_wallet?: string | null;
        attached_device_id?: string | null;
        site_label?: string | null;
        gpu_reported_model?: string | null;
        gpu_verified?: number | null;
      }
    | undefined;

  if (!row) {
    return res.json({
      hostId,
      enabled: false,
      wallet: null,
      controller: null,
      attached: null,
      deviceId: null,
      site: null,
      gpuReportedModel: null,
      gpuVerified: false,
    });
  }

  res.json({
    hostId,
    enabled: Number(row.enabled) === 1,
    wallet: row.owner_wallet,
    controller: row.controller_wallet || null,
    attached: row.attached_wallet || null,
    deviceId: row.attached_device_id || null,
    site: row.site_label || null,
    gpuReportedModel: row.gpu_reported_model || null,
    gpuVerified: Number(row.gpu_verified ?? 0) === 1,
  });
});

app.get('/host/last-share', (req, res) => {
  const hostId = String(req.query.hostId || '');
  if (!hostId)
    return res.status(400).json({ error: 'hostId required' });

  const cutoff = Date.now() - 5 * 60 * 1000; // last 5 minutes
  const row = db
    .prepare(
      `
    SELECT
      MAX(ts) as lastShareTs,
      MIN(ts) as firstTs,
      SUM(difficulty) as sumDiff
    FROM shares
    WHERE host_id = ?
      AND ts >= ?
  `,
    )
    .get(hostId, cutoff) as
    | { lastShareTs: number | null; firstTs: number | null; sumDiff: number | null }
    | undefined;

  let hashRate: number | null = null;
  if (
    row?.lastShareTs &&
    row.firstTs &&
    row.sumDiff &&
    row.lastShareTs > row.firstTs
  ) {
    const seconds = (row.lastShareTs - row.firstTs) / 1000;
    hashRate = row.sumDiff / Math.max(1, seconds);
  }

  res.json({
    hostId,
    lastShareTs: row?.lastShareTs ?? null,
    hashRate,
  });
});

// Marketplace (enabled + device bound)
app.get('/market/hosts', (_req, res) => {
  try {
    const hosts = getMarketHosts.all();
    res.json({ hosts });
  } catch (e: any) {
    res.status(500).json({ error: 'db_error', message: e?.message });
  }
});

// Register / change owner via UI
app.post('/host/register', (req, res) => {
  const { hostId, ownerWallet } = req.body || {};
  if (!hostId || !ownerWallet)
    return res
      .status(400)
      .json({ error: 'hostId and ownerWallet required' });
  db.prepare(
    `
    INSERT INTO hosts (host_id, owner_wallet, enabled)
    VALUES (?, ?, 0)
    ON CONFLICT(host_id) DO UPDATE SET owner_wallet = excluded.owner_wallet
  `,
  ).run(hostId, ownerWallet);
  res.json({ ok: true, hostId, ownerWallet });
});

// Attach designated mining wallet (optional)
app.post('/host/attach', (req, res) => {
  const { hostId, attachedWallet } = req.body || {};
  if (!hostId)
    return res.status(400).json({ error: 'hostId required' });
  db.prepare(
    `UPDATE hosts SET attached_wallet=? WHERE host_id=?`,
  ).run(attachedWallet || null, hostId);
  broadcast('host', { hostId });
  res.json({
    ok: true,
    hostId,
    attachedWallet: attachedWallet || null,
  });
});

// Manual server enable/disable (NO paywall anymore)
app.post('/host/enable', (req, res) => {
  const { hostId } = req.body || {};
  if (!hostId)
    return res.status(400).json({ error: 'hostId required' });
  const r = db
    .prepare(`UPDATE hosts SET enabled=1 WHERE host_id=?`)
    .run(hostId);
  if (r.changes === 0)
    return res.status(404).json({ error: 'host_not_registered' });
  broadcast('host', { hostId, enabled: true });
  res.json({ ok: true, hostId, enabled: true });
});

app.post('/host/disable', (req, res) => {
  const { hostId } = req.body || {};
  if (!hostId)
    return res.status(400).json({ error: 'hostId required' });
  const r = db
    .prepare(`UPDATE hosts SET enabled=0 WHERE host_id=?`)
    .run(hostId);
  if (r.changes === 0)
    return res.status(404).json({ error: 'host_not_registered' });
  broadcast('host', { hostId, enabled: false });
  res.json({ ok: true, hostId, enabled: false });
});

// ---------- PUTE credits: deposit + balance ----------------------------------

// For now, 1 lamport = 1 PUTE unit (you can change this later with an env).
// If you want a different rate, set PUTE_PER_LAMPORT in the environment.
const PUTE_PER_LAMPORT = Number(process.env.PUTE_PER_LAMPORT || '1');

app.post('/pute/deposit', (req, res) => {
  try {
    const wallet = String(req.body?.wallet || '');
    const lamportsRaw = req.body?.lamports;
    const modelId = req.body?.modelId || null;
    const uiTxId = req.body?.uiTxId || null;

    const lamports = Number(lamportsRaw);
    if (!wallet) {
      return res.status(400).json({ ok: false, error: 'wallet_required' });
    }
    if (!Number.isFinite(lamports) || lamports <= 0) {
      return res.status(400).json({ ok: false, error: 'bad_amount' });
    }

    const minted = Math.floor(lamports * PUTE_PER_LAMPORT);

    const row = getPuteCredit.get(wallet) as { total?: number } | undefined;
    const cur = Math.max(0, Number(row?.total ?? 0));
    const next = cur + minted;

    upsertPuteCredit.run({ wallet, total: next });

    return res.json({
      ok: true,
      wallet,
      lamports,
      minted,
      total: next,
      modelId,
      uiTxId,
    });
  } catch (e: any) {
    console.error('/pute/deposit error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'internal_error' });
  }
});

app.get('/pute/:wallet', (req, res) => {
  const wallet = String(req.params.wallet || '');
  if (!wallet) {
    return res.status(400).json({ ok: false, error: 'wallet_required' });
  }
  const row = getPuteCredit.get(wallet) as { total?: number } | undefined;
  const total = Math.max(0, Number(row?.total ?? 0));
  res.json({ ok: true, wallet, total });
});

// ---------- On-chain START/STOP verify via Memo ------------------------------
const RPC_URL =
  process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const MEMO_PROGRAM = new PublicKey(
  process.env.MEMO_PROGRAM_ID ||
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });

function extractMemos(tx: VersionedTransactionResponse): string[] {
  const out: string[] = [];
  const msg: any = tx.transaction.message;
  const top = msg.compiledInstructions ?? [];
  for (const ix of top) {
    try {
      const pid = msg.staticAccountKeys[ix.programIdIndex];
      if (pid?.equals(MEMO_PROGRAM)) {
        const data = Buffer.from(ix.data, 'base64').toString('utf8');
        if (data) out.push(data);
      }
    } catch {}
  }
  const meta = tx.meta;
  if (meta?.innerInstructions) {
    for (const inner of meta.innerInstructions) {
      for (const ix of inner.instructions as any[]) {
        try {
          const pid = msg.staticAccountKeys[ix.programIdIndex];
          if (pid?.equals(MEMO_PROGRAM)) {
            const data = Buffer.from(ix.data, 'base64').toString('utf8');
            if (data) out.push(data);
          }
        } catch {}
      }
    }
  }
  return out;
}

app.post('/onchain/verify', async (req, res) => {
  const { sig, hostId } = req.body || {};
  if (!sig || !hostId)
    return res
      .status(400)
      .json({ ok: false, error: 'sig_and_hostId_required' });

  const row = db
    .prepare(
      `SELECT owner_wallet, controller_wallet FROM hosts WHERE host_id=?`,
    )
    .get(hostId) as
    | { owner_wallet?: string; controller_wallet?: string | null }
    | undefined;

  if (!row?.owner_wallet)
    return res
      .status(404)
      .json({ ok: false, error: 'host_not_registered' });

  const controller = row.controller_wallet || row.owner_wallet;

  let tx: VersionedTransactionResponse | null = null;
  try {
    tx = await conn.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    return res.status(400).json({ ok: false, error: 'rpc_error' });
  }
  if (!tx)
    return res.status(400).json({ ok: false, error: 'missing_tx' });

  const feePayer =
    tx.transaction.message.getAccountKeys().staticAccountKeys[0];
  if (!feePayer?.equals(new PublicKey(controller))) {
    return res
      .status(403)
      .json({ ok: false, error: 'not_signed_by_controller' });
  }

  const memo = extractMemos(tx).find((m) => m.startsWith('MINER|'));
  if (!memo)
    return res.status(400).json({ ok: false, error: 'memo_missing' });

  const [, action, memoHost] = memo.split('|'); // MINER|START|HOST|ts
  if (memoHost !== hostId)
    return res
      .status(400)
      .json({ ok: false, error: 'host_mismatch' });

  const enabled = action === 'START' ? 1 : 0;
  db.prepare(`UPDATE hosts SET enabled=? WHERE host_id=?`).run(
    enabled,
    hostId,
  );

  broadcast('host', { hostId, enabled: enabled === 1 });
  res.json({ ok: true, hostId, enabled: enabled === 1, sig });
});

// ---------- health -----------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    pid: process.pid,
    dbPath: DB_PATH,
  });
});

app.get('/ai/models', (_req, res) => {
  res.json({ models: AI_MODELS });
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`[db] coordinator listening on :${port}`);
  console.log(`[db] DB: ${DB_PATH}`);
});

// ---------- AI JOB QUEUE (LLM work) -----------------------------------------

/**
 * Enqueue a new AI job from the UI.
 * body: { wallet, modelId, prompt, hostId? }
 */
app.post('/ai/jobs', (req, res) => {
  try {
    const { wallet, modelId, prompt, hostId } = req.body || {};
    if (!wallet || !modelId || !prompt) {
      return res
        .status(400)
        .json({ ok: false, error: 'wallet, modelId, prompt required' });
    }

    const now = Date.now();
    const info = insertAiJob.run({
      wallet: String(wallet),
      modelId: String(modelId),
      hostId: hostId ? String(hostId) : null,
      prompt: String(prompt),
      status: 'queued',
      createdTs: now,
      updatedTs: now,
    });

    const id = Number(info.lastInsertRowid);
    return res.json({ ok: true, id });
  } catch (e: any) {
    console.error('/ai/jobs error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'ai_jobs_internal_error' });
  }
});

/**
 * Claim the next queued job for a given host/device.
 * query: ?hostId=HOST-...&deviceId=...
 */
app.get('/ai/jobs/next', (req, res) => {
  try {
    const hostId = String(req.query.hostId || '');
    const deviceId = String(req.query.deviceId || '');
    if (!hostId) {
      return res
        .status(400)
        .json({ ok: false, error: 'hostId_required' });
    }

    const now = Date.now();
    const row = claimNextAiJob.get({
      hostId,
      deviceId: deviceId || null,
      now,
    }) as any | undefined;

    return res.json({
      ok: true,
      job: row || null,
    });
  } catch (e: any) {
    console.error('/ai/jobs/next error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'ai_jobs_next_internal_error' });
  }
});

/**
 * Fetch job by id (for UI polling).
 */
app.get('/ai/jobs/:id', (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'bad_job_id' });
    }
    const row = getAiJob.get(id) as any | undefined;
    if (!row) {
      return res
        .status(404)
        .json({ ok: false, error: 'job_not_found' });
    }
    return res.json({ ok: true, job: row });
  } catch (e: any) {
    console.error('/ai/jobs/:id error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'ai_jobs_get_internal_error' });
  }
});

/**
 * Worker posts back result when done.
 * body: { result?: string, error?: string }
 */
app.post('/ai/jobs/:id/result', (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const { result, error } = req.body || {};
    if (!Number.isFinite(id) || id <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'bad_job_id' });
    }

    const row = getAiJob.get(id) as any | undefined;
    if (!row) {
      return res
        .status(404)
        .json({ ok: false, error: 'job_not_found' });
    }

    const now = Date.now();
    const status = error ? 'failed' : 'completed';

    completeAiJob.run({
      id,
      status,
      result: result ?? null,
      error: error ?? null,
      now,
    });

    return res.json({ ok: true, id, status });
  } catch (e: any) {
    console.error('/ai/jobs/:id/result error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'ai_jobs_result_internal_error' });
  }
});

