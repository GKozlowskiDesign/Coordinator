/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';

const app = express();

/**
 * CORS — IMPORTANT: only send ONE Access-Control-Allow-Origin value.
 * Set NEXT_PUBLIC_APP_ORIGIN="http://localhost:3000" for dev.
 */
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN || 'http://localhost:3000';
app.use(cors({ origin: APP_ORIGIN }));
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
  return rows.some(r => r.name === column);
}
function addColumnIfMissing(table: string, column: string, declNoConstraints: string) {
  if (!tableHasColumn(table, column)) {
    console.log(`[db] migrating: adding column ${table}.${column}`);
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${declNoConstraints}`).run();
  }
}
function createIndexIfMissing(sql: string) {
  db.exec(sql); // use IF NOT EXISTS in the SQL passed
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
`);

// ---- MIGRATE older DBs (order matters!) ------------------------------------
addColumnIfMissing('shares', 'device_id', 'TEXT');
addColumnIfMissing('hosts',  'attached_device_id', 'TEXT');
addColumnIfMissing('hosts',  'site_label', 'TEXT');

try { db.prepare(`UPDATE shares SET device_id='' WHERE device_id IS NULL`).run(); } catch {}

createIndexIfMissing(`CREATE INDEX IF NOT EXISTS idx_shares_ts ON shares(ts DESC)`);
createIndexIfMissing(`CREATE INDEX IF NOT EXISTS idx_shares_wallet ON shares(wallet)`);
createIndexIfMissing(`CREATE INDEX IF NOT EXISTS idx_shares_host ON shares(host_id)`);
createIndexIfMissing(`CREATE INDEX IF NOT EXISTS idx_shares_device ON shares(device_id)`);
createIndexIfMissing(`CREATE UNIQUE INDEX IF NOT EXISTS ux_hosts_attached_device ON hosts(attached_device_id)`);

// ---------- prepared statements ---------------------------------------------
const insertShare = db.prepare(`
  INSERT INTO shares (wallet, host_id, device_id, difficulty, ts)
  VALUES (@wallet, @hostId, @deviceId, @difficulty, @ts)
`);
const upsertCredit = db.prepare(`
  INSERT INTO wallet_credits (wallet, total) VALUES (@wallet, @total)
  ON CONFLICT(wallet) DO UPDATE SET total = excluded.total
`);
const getCredit = db.prepare(`SELECT total FROM wallet_credits WHERE wallet = ?`);
const setCredit = db.prepare(`UPDATE wallet_credits SET total = ? WHERE wallet = ?`);

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
const getLastShareForHost = db.prepare(`SELECT MAX(ts) as lastShareTs FROM shares WHERE host_id = ?`);

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

// ---------- SSE --------------------------------------------------------------
type Client = { id: number; res: express.Response };
const clients: Client[] = [];
let nextId = 1;

function broadcast(event: string, payload: any) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) { try { c.res.write(data); } catch {} }
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

// ---------- Miner/device binding --------------------------------------------
app.post('/host/hello', (req, res) => {
  const { hostId, deviceId, wallet, site } = req.body || {};
  if (!hostId || !deviceId || !wallet) {
    return res.status(400).json({ ok:false, error: 'hostId, deviceId and wallet required' });
  }

  const row = db.prepare(`
    SELECT owner_wallet, attached_wallet, attached_device_id
    FROM hosts WHERE host_id=?`).get(hostId) as
      | { owner_wallet: string; attached_wallet?: string | null; attached_device_id?: string | null }
      | undefined;

  if (!row) return res.status(404).json({ ok:false, error: 'host_not_registered' });

  if (!row.attached_device_id) {
    try {
      db.prepare(`UPDATE hosts SET attached_device_id=?, attached_wallet=?, site_label=COALESCE(?, site_label) WHERE host_id=?`)
        .run(deviceId, wallet, site || null, hostId);
      broadcast('host', { hostId });
      return res.json({ ok:true, bound:true, hostId, deviceId, wallet });
    } catch (e: any) {
      return res.status(409).json({ ok: false, error: 'device_bind_conflict' });
    }
  }

  if (row.attached_device_id !== deviceId) {
    return res.status(403).json({ ok:false, error: 'device_mismatch' });
  }

  if (row.attached_wallet !== wallet) {
    db.prepare(`UPDATE hosts SET attached_wallet=? WHERE host_id=?`).run(wallet, hostId);
    broadcast('host', { hostId });
  }

  return res.json({ ok:true, bound:true, hostId, deviceId, wallet });
});

app.post('/host/unbind', (req, res) => {
  const { hostId } = req.body || {};
  if (!hostId) return res.status(400).json({ ok:false, error: 'hostId required' });
  db.prepare(`UPDATE hosts SET attached_device_id=NULL, attached_wallet=NULL, enabled=0 WHERE host_id=?`).run(hostId);
  broadcast('host', { hostId, enabled:false });
  res.json({ ok:true, hostId });
});

// ---------- Mining API (strict gate) ----------------------------------------
app.post('/share', (req, res) => {
  const { wallet, hostId, deviceId, difficulty = 1 } = req.body || {};
  if (!wallet || !hostId || !deviceId) {
    return res.status(400).json({ error: 'wallet, hostId, deviceId required' });
  }

  const host = db.prepare(`
    SELECT enabled, owner_wallet, controller_wallet, attached_wallet, attached_device_id
    FROM hosts WHERE host_id=?`).get(hostId) as
      | { enabled: number; owner_wallet: string; controller_wallet?: string | null; attached_wallet?: string | null; attached_device_id?: string | null }
      | undefined;

  if (!host) return res.status(404).json({ error: 'unknown_host' });
  if (Number(host.enabled) !== 1) return res.status(403).json({ error: 'host_disabled' });

  if (!host.attached_device_id || host.attached_device_id !== deviceId) {
    return res.status(403).json({ error: 'device_not_authorized' });
  }

  const allowedWallet = host.attached_wallet || host.owner_wallet;
  if (allowedWallet && allowedWallet !== wallet) {
    return res.status(403).json({ error: 'wallet_not_authorized' });
  }

  const diff = Number.isFinite(+difficulty) ? Math.max(1, Number(difficulty)) : 1;
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

// ---------- Read API ---------------------------------------------------------
app.get('/credits/:wallet', (req, res) => {
  const row = getCredit.get(req.params.wallet) as { total: number } | undefined;
  res.json({ wallet: req.params.wallet, total: row?.total || 0 });
});

/** NEW: settle credits after an airdrop claim
 *  POST /credits/settle { wallet: string, amount: number }
 *  Decreases wallet_credits.total by `amount` (floors at 0) and returns new total.
 */
app.post('/credits/settle', (req, res) => {
  try {
    const wallet = String(req.body?.wallet || '');
    const amount = Number(req.body?.amount || 0);
    if (!wallet) return res.status(400).json({ ok: false, error: 'wallet_required' });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'bad_amount' });
    }

    // ensure row exists
    const curRow = getCredit.get(wallet) as { total?: number } | undefined;
    const cur = Math.max(0, Number(curRow?.total ?? 0));
    const next = Math.max(0, cur - Math.floor(amount));

    if (curRow) {
      setCredit.run(next, wallet);
    } else {
      upsertCredit.run({ wallet, total: next });
    }

    broadcast('credits', { wallet, total: next });
    return res.json({ ok: true, wallet, total: next });
  } catch (e: any) {
    console.error('/credits/settle error', e?.message || e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.get('/shares/recent', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const items = getRecent.all({ limit }) as Array<{ wallet: string; hostId: string; deviceId: string; difficulty: number; ts: number }>;
  res.json({ items });
});

app.get('/stats', (_req, res) => {
  const row = getStats.get() as { totalShares: number; totalWallets: number; lastShareTs: number | null };
  res.json({
    totalShares: row.totalShares || 0,
    totalWallets: row.totalWallets || 0,
    lastShareTs: row.lastShareTs ?? null,
    dbPath: DB_PATH,
    wal: true,
  });
});

app.get('/host-state', (req, res) => {
  const hostId = String(req.query.hostId || '');
  if (!hostId) return res.status(400).json({ error: 'hostId required' });

  const row = db.prepare(`
    SELECT enabled, owner_wallet, controller_wallet, attached_wallet, attached_device_id, site_label
    FROM hosts WHERE host_id=?`).get(hostId) as
      | { enabled: number; owner_wallet: string; controller_wallet?: string | null; attached_wallet?: string | null; attached_device_id?: string | null; site_label?: string | null }
      | undefined;

  if (!row) return res.json({ hostId, enabled: false, wallet: null, controller: null, attached: null, deviceId: null, site: null });

  res.json({
    hostId,
    enabled: Number(row.enabled) === 1,
    wallet: row.owner_wallet,
    controller: row.controller_wallet || null,
    attached: row.attached_wallet || null,
    deviceId: row.attached_device_id || null,
    site: row.site_label || null,
  });
});

app.get('/host/last-share', (req, res) => {
  const hostId = String(req.query.hostId || '');
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  const row = getLastShareForHost.get(hostId) as { lastShareTs: number | null } | undefined;
  res.json({ hostId, lastShareTs: row?.lastShareTs ?? null });
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
  if (!hostId || !ownerWallet) return res.status(400).json({ error: 'hostId and ownerWallet required' });
  db.prepare(`
    INSERT INTO hosts (host_id, owner_wallet, enabled)
    VALUES (?, ?, 0)
    ON CONFLICT(host_id) DO UPDATE SET owner_wallet = excluded.owner_wallet
  `).run(hostId, ownerWallet);
  res.json({ ok: true, hostId, ownerWallet });
});

// Attach designated mining wallet (optional)
app.post('/host/attach', (req, res) => {
  const { hostId, attachedWallet } = req.body || {};
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  db.prepare(`UPDATE hosts SET attached_wallet=? WHERE host_id=?`).run(attachedWallet || null, hostId);
  broadcast('host', { hostId });
  res.json({ ok: true, hostId, attachedWallet: attachedWallet || null });
});

// Manual server enable/disable
app.post('/host/enable', (req, res) => {
  const { hostId } = req.body || {};
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  const r = db.prepare(`UPDATE hosts SET enabled=1 WHERE host_id=?`).run(hostId);
  if (r.changes === 0) return res.status(404).json({ error: 'host_not_registered' });
  broadcast('host', { hostId, enabled: true });
  res.json({ ok: true, hostId, enabled: true });
});

app.post('/host/disable', (req, res) => {
  const { hostId } = req.body || {};
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  const r = db.prepare(`UPDATE hosts SET enabled=0 WHERE host_id=?`).run(hostId);
  if (r.changes === 0) return res.status(404).json({ error: 'host_not_registered' });
  broadcast('host', { hostId, enabled: false });
  res.json({ ok: true, hostId, enabled: false });
});

// ---------- On-chain START/STOP verify via Memo ------------------------------
const RPC_URL = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const MEMO_PROGRAM = new PublicKey(process.env.MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
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
  if (!sig || !hostId) return res.status(400).json({ ok: false, error: 'sig_and_hostId_required' });

  const row = db.prepare(`SELECT owner_wallet, controller_wallet FROM hosts WHERE host_id=?`)
    .get(hostId) as { owner_wallet?: string; controller_wallet?: string | null } | undefined;

  if (!row?.owner_wallet) return res.status(404).json({ ok: false, error: 'host_not_registered' });

  const controller = row.controller_wallet || row.owner_wallet;

  let tx: VersionedTransactionResponse | null = null;
  try {
    tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  } catch {
    return res.status(400).json({ ok: false, error: 'rpc_error' });
  }
  if (!tx) return res.status(400).json({ ok: false, error: 'missing_tx' });

  const feePayer = tx.transaction.message.getAccountKeys().staticAccountKeys[0];
  if (!feePayer?.equals(new PublicKey(controller))) {
    return res.status(403).json({ ok: false, error: 'not_signed_by_controller' });
  }

  const memo = extractMemos(tx).find((m) => m.startsWith('MINER|'));
  if (!memo) return res.status(400).json({ ok: false, error: 'memo_missing' });

  const [, action, memoHost] = memo.split('|'); // MINER|START|HOST|ts
  if (memoHost !== hostId) return res.status(400).json({ ok: false, error: 'host_mismatch' });

  const enabled = action === 'START' ? 1 : 0;
  db.prepare(`UPDATE hosts SET enabled=? WHERE host_id=?`).run(enabled, hostId);

  broadcast('host', { hostId, enabled: enabled === 1 });
  res.json({ ok: true, hostId, enabled: enabled === 1, sig });
});

// ---------- health -----------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid, dbPath: DB_PATH });
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`[db] coordinator listening on :${port}`);
  console.log(`[db] DB: ${DB_PATH}`);
});
