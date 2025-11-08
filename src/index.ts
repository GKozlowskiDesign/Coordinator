/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';

const app = express();
app.use(cors());
app.use(express.json());

// ---------- SQLite -----------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'coordinator.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    host_id TEXT NOT NULL,
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
    enabled INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_shares_ts ON shares(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_shares_wallet ON shares(wallet);
`);

// ---------- prepared statements ---------------------------------------------
const insertShare = db.prepare(`
  INSERT INTO shares (wallet, host_id, difficulty, ts) VALUES (@wallet, @hostId, @difficulty, @ts)
`);
const upsertCredit = db.prepare(`
  INSERT INTO wallet_credits (wallet, total) VALUES (@wallet, @total)
  ON CONFLICT(wallet) DO UPDATE SET total = excluded.total
`);
const getCredit = db.prepare(`SELECT total FROM wallet_credits WHERE wallet = ?`);
const getRecent = db.prepare(`
  SELECT wallet, host_id as hostId, difficulty, ts
  FROM shares
  ORDER BY ts DESC
  LIMIT @limit
`);
const getStats = db.prepare(`
  SELECT (SELECT COUNT(*) FROM shares) as totalShares,
         (SELECT COUNT(*) FROM wallet_credits) as totalWallets,
         (SELECT MAX(ts) FROM shares) as lastShareTs
`);

// ---------- SSE fanout -------------------------------------------------------
type Client = { id: number; res: express.Response };
const clients: Client[] = [];
let nextId = 1;

function broadcast(event: string, payload: any) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try { c.res.write(data); } catch {}
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

// ---------- Mining API (gated) ----------------------------------------------
// POST /share  { wallet, hostId, difficulty }
app.post('/share', (req, res) => {
  const { wallet, hostId, difficulty = 1 } = req.body || {};
  if (!wallet || !hostId) return res.status(400).json({ error: 'wallet and hostId required' });

  const host = db.prepare(`
    SELECT enabled, owner_wallet, controller_wallet, attached_wallet
    FROM hosts WHERE host_id=?`).get(hostId) as
      | { enabled: number; owner_wallet: string; controller_wallet?: string | null; attached_wallet?: string | null }
      | undefined;

  if (!host) return res.status(404).json({ error: 'unknown_host' });
  if (Number(host.enabled) !== 1) return res.status(403).json({ error: 'host_disabled' });

  // Who may mine? Either attached_wallet if set, else owner_wallet.
  const allowedWallet = host.attached_wallet || host.owner_wallet;
  if (allowedWallet && allowedWallet !== wallet) {
    return res.status(403).json({ error: 'wallet_not_authorized' });
  }

  const diff = Number.isFinite(+difficulty) ? Math.max(1, Number(difficulty)) : 1;
  const ts = Date.now();

  const tx = db.transaction(() => {
    insertShare.run({ wallet, hostId, difficulty: diff, ts });
    const current = getCredit.get(wallet) as { total?: number } | undefined;
    const total = (current?.total || 0) + diff;
    upsertCredit.run({ wallet, total });
    return total;
  });
  const total = tx();

  const payload = { wallet, hostId, difficulty: diff, ts, total };
  broadcast('share', payload);
  res.json({ ok: true, ...payload });
});

// credits for one wallet
app.get('/credits/:wallet', (req, res) => {
  const row = getCredit.get(req.params.wallet) as { total: number } | undefined;
  res.json({ wallet: req.params.wallet, total: row?.total || 0 });
});

// recent shares
app.get('/shares/recent', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const items = getRecent.all({ limit }) as Array<{ wallet: string; hostId: string; difficulty: number; ts: number }>;
  res.json({ items });
});

// tiny stats
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

// ---------- Host control (server-side truth) --------------------------------
// Register / change owner
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

// Attach (designate) a mining wallet for this host (optional)
app.post('/host/attach', (req, res) => {
  const { hostId, attachedWallet } = req.body || {};
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  db.prepare(`UPDATE hosts SET attached_wallet=? WHERE host_id=?`).run(attachedWallet || null, hostId);
  broadcast('host', { hostId });
  res.json({ ok: true, hostId, attachedWallet: attachedWallet || null });
});

// Read state
app.get('/host-state', (req, res) => {
  const hostId = String(req.query.hostId || '');
  if (!hostId) return res.status(400).json({ error: 'hostId required' });

  const row = db.prepare(`
    SELECT enabled, owner_wallet, controller_wallet, attached_wallet
    FROM hosts WHERE host_id=?`).get(hostId) as
      | { enabled: number; owner_wallet: string; controller_wallet?: string | null; attached_wallet?: string | null }
      | undefined;

  if (!row) return res.json({ hostId, enabled: false, wallet: null, controller: null, attached: null });
  res.json({
    hostId,
    enabled: Number(row.enabled) === 1,
    wallet: row.owner_wallet,
    controller: row.controller_wallet || null,
    attached: row.attached_wallet || null,
  });
});

// Manual fallback switches (kept)
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

// ---------- On-chain verify (single signature, no retries) ------------------
const RPC_URL = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const MEMO_PROGRAM = new PublicKey(process.env.MEMO_PROGRAM_ID || 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });

// pull memo strings (top-level + inner)
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

// POST /onchain/verify { sig, hostId }
// Controller-only: controller_wallet (if set) else owner_wallet must be the fee payer.
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
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'rpc_error' });
  }
  if (!tx) return res.status(400).json({ ok: false, error: 'missing_tx' });

  const feePayer = tx.transaction.message.getAccountKeys().staticAccountKeys[0];
  if (!feePayer?.equals(new PublicKey(controller))) {
    return res.status(403).json({ ok: false, error: 'not_signed_by_controller' });
  }

  const memos = extractMemos(tx);
  const memo = memos.find((m) => m.startsWith('MINER|'));
  if (!memo) return res.status(400).json({ ok: false, error: 'memo_missing' });

  const [_, action, memoHost] = memo.split('|'); // MINER|START|HOST|ts
  if (memoHost !== hostId) return res.status(400).json({ ok: false, error: 'host_mismatch' });

  const enabled = action === 'START' ? 1 : 0;
  db.prepare(`UPDATE hosts SET enabled=? WHERE host_id=?`).run(enabled, hostId);

  broadcast('host', { hostId, enabled: enabled === 1 });
  res.json({ ok: true, hostId, enabled: enabled === 1, sig });
});

// ---------- start ------------------------------------------------------------
const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`coordinator listening on :${port}`);
  console.log(`DB: ${DB_PATH}`);
});
