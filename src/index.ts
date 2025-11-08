/* src/index.ts */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const app = express();
app.use(cors());
app.use(express.json());

// --- SQLite setup ----------------------------------------------------------
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

  CREATE INDEX IF NOT EXISTS idx_shares_ts ON shares(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_shares_wallet ON shares(wallet);
`);

// prepared statements
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

// --- SSE fanout ------------------------------------------------------------
type Client = { id: number; res: express.Response };
const clients: Client[] = [];
let nextId = 1;

function broadcast(event: string, payload: any) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try { c.res.write(data); } catch {}
  }
}

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  (res as any).flushHeaders?.();

  const id = nextId++;
  clients.push({ id, res });
  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  req.on('close', () => {
    const i = clients.findIndex((c) => c.id === id);
    if (i >= 0) clients.splice(i, 1);
  });
});

// --- API -------------------------------------------------------------------

// record a share and bump credits
app.post('/share', (req, res) => {
  const { wallet, hostId, difficulty = 1 } = req.body || {};
  if (!wallet || !hostId) {
    return res.status(400).json({ error: 'wallet and hostId required' });
  }
  const diff = Number.isFinite(+difficulty) ? Math.max(1, Number(difficulty)) : 1;
  const ts = Date.now();

  const tx = db.transaction(() => {
    insertShare.run({ wallet, hostId, difficulty: diff, ts });
    const current = getCredit.get(wallet) as { total: number } | undefined;
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

// little dashboard
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

// --- start -----------------------------------------------------------------
const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`coordinator listening on :${port}`);
  console.log(`DB: ${DB_PATH}`);
});
