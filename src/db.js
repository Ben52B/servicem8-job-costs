const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

/*
 * How costs are stored
 * --------------------
 * - An invoice belongs to the business (a ServiceM8 account), not to a job.
 * - Each invoice line is shared out to jobs through `allocations`: a job gets a
 *   fraction of the line (1 = all of it, 0.1 = 1 of 10 motors), with its own
 *   type (Materials, Subcontractor…) and screw-up tag.
 * - Whatever isn't allocated to any job is "not assigned yet" (e.g. stock).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_uuid      TEXT PRIMARY KEY,
  account_uuid  TEXT,
  inbox_code    TEXT NOT NULL UNIQUE,   -- unused since v2 (one address per business)
  job_number    TEXT,
  job_title     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  account_key     TEXT PRIMARY KEY,       -- ServiceM8 account UUID ('' when testing without ServiceM8)
  inbox_code      TEXT NOT NULL UNIQUE,   -- code in the business's invoice email address
  jobs_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid        TEXT,
  origin_job_uuid     TEXT,               -- job it was uploaded/typed on; it is assigned there once read
  source              TEXT NOT NULL,      -- upload | email | manual
  file_name           TEXT,
  file_path           TEXT,
  mime_type           TEXT,
  email_from          TEXT,
  email_subject       TEXT,
  email_text          TEXT,
  status              TEXT NOT NULL DEFAULT 'processing', -- processing | ready | error
  error               TEXT,
  document_type       TEXT,
  supplier            TEXT,
  supplier_abn        TEXT,
  invoice_number      TEXT,
  invoice_date        TEXT,
  due_date            TEXT,
  currency            TEXT,
  subtotal            REAL,
  tax                 REAL,
  total               REAL,
  notes               TEXT,
  refs                TEXT,               -- JSON list: PO / order / job references printed on the invoice
  site_address        TEXT,
  category            TEXT,               -- default type when assigning
  category_manual     INTEGER NOT NULL DEFAULT 0,
  attached_later      INTEGER NOT NULL DEFAULT 0,
  suggested_job_uuid  TEXT,
  suggestion_reason   TEXT,
  dismissed_jobs      TEXT,               -- JSON list of jobs marked "not this job"
  kept_as_stock       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  quantity      REAL,
  unit          TEXT,
  unit_price    REAL,
  line_total    REAL NOT NULL DEFAULT 0,  -- as printed on the invoice
  cost          REAL NOT NULL DEFAULT 0,  -- share of the invoice total (incl. tax, freight, discounts)
  paid          INTEGER NOT NULL DEFAULT 0,
  paid_at       TEXT
);

CREATE TABLE IF NOT EXISTS allocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  job_uuid        TEXT NOT NULL,
  fraction        REAL NOT NULL,          -- share of the line, 0..1
  category        TEXT,                   -- type for this job's share
  mistake_reason  TEXT,                   -- screw-up tag for this job's share
  mistake_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, job_uuid)
);
CREATE INDEX IF NOT EXISTS idx_alloc_job ON allocations(job_uuid);

-- Emails already read from the mailbox (so the mailbox itself is never changed).
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE IF NOT EXISTS processed_mail (
  mail_key    TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Outlook (Microsoft 365) mailbox connected to a business, read-only.
CREATE TABLE IF NOT EXISTS outlook (
  account_key    TEXT PRIMARY KEY,
  email          TEXT,
  name           TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     TEXT,
  connected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_received  TEXT,
  last_check     TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_alloc_item ON allocations(item_id);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON items(invoice_id);
`;

// Short, easy-to-type code used in the email address (no 0/o/1/l confusion).
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newInboxCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const EPS = 1e-6;
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/**
 * One default type for the whole invoice, from its main items. Delivery and fees ride
 * along with the goods they came with; they only count as their own type when that's
 * all the invoice is.
 */
function invoiceCategory(items) {
  const sums = {};
  for (const it of items) sums[it.category || 'other'] = (sums[it.category || 'other'] || 0) + Math.abs(Number(it.line_total) || 0);
  const main = Object.entries(sums).filter(([c]) => c !== 'freight' && c !== 'fees' && c !== 'other');
  const pick = (main.length ? main : Object.entries(sums)).sort((a, b) => b[1] - a[1])[0];
  return pick ? pick[0] : 'materials';
}

/** Invoice total without GST (no GST shown = nothing to take off). */
function exGst(total, tax) {
  if (total == null || !isFinite(total)) return total;
  return round2(Number(total) - (Number(tax) || 0));
}

/**
 * Spread the invoice total across its lines so that line costs always add up to
 * the amount actually owed (handles tax, freight, rounding and discounts).
 */
function allocateCosts(items, invoiceTotal) {
  const sumLines = items.reduce((s, it) => s + (Number(it.line_total) || 0), 0);
  if (invoiceTotal == null || !isFinite(invoiceTotal) || Math.abs(sumLines) < 0.005) {
    return items.map((it) => round2(it.line_total));
  }
  const factor = invoiceTotal / sumLines;
  const costs = items.map((it) => round2((Number(it.line_total) || 0) * factor));
  const diff = round2(invoiceTotal - costs.reduce((s, c) => s + c, 0));
  if (diff !== 0 && costs.length) {
    let idx = 0;
    costs.forEach((c, i) => { if (Math.abs(c) > Math.abs(costs[idx])) idx = i; });
    costs[idx] = round2(costs[idx] + diff);
  }
  return costs;
}

/**
 * Split jobs: ServiceM8 partial invoicing makes #207974A, #207974B… next to #207974.
 * Returns the main job number for a split part, or null for a normal job number.
 */
function mainJobNumber(jobNumber) {
  const m = String(jobNumber || '').trim().match(/^(\d+)\s*[-/.]?\s*[A-Za-z]{1,2}$/);
  return m ? m[1] : null;
}

/** "12a Smith St, Penrith" -> { number: '12a', street: 'smith' } for address matching. */
function addressKey(text) {
  const m = String(text || '').toLowerCase().match(/(\d+[a-z]?)\s*[,/-]?\s+([a-z]{3,})/);
  return m ? { number: m[1], street: m[2] } : null;
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'jobcosts.sqlite'));
  db.exec('PRAGMA journal_mode = WAL;');
  migrateV1(db);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrateColumns(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(account_uuid)');
  const repo = createRepo(db, dataDir);
  // Costs are counted ex GST (like ServiceM8's prices). Convert invoices saved before that.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'costs_ex_gst'").get()) {
    for (const { id } of db.prepare('SELECT id FROM invoices WHERE total IS NOT NULL').all()) repo.reallocate(id);
    db.prepare("INSERT INTO meta (key, value) VALUES ('costs_ex_gst', '1')").run();
  }
  return repo;
}

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/**
 * Upgrade a database from the first version, where every invoice belonged to one job:
 * invoices now belong to the business and are assigned to jobs line by line.
 */
function migrateV1(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  if (!tables.includes('invoices') || !cols(db, 'invoices').includes('job_uuid')) return;
  const invCols = cols(db, 'invoices');
  const itemCols = cols(db, 'items');
  const has = (c) => invCols.includes(c);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA.replace('CREATE TABLE IF NOT EXISTS invoices (', 'CREATE TABLE invoices_v2 ('));
    db.exec(`INSERT INTO invoices_v2 (id, account_uuid, origin_job_uuid, source, file_name, file_path, mime_type, email_from, email_subject,
        status, error, document_type, supplier, supplier_abn, invoice_number, invoice_date, due_date, currency, subtotal, tax, total, notes,
        category, category_manual, attached_later, created_at)
      SELECT id, (SELECT account_uuid FROM jobs WHERE jobs.job_uuid = invoices.job_uuid), job_uuid, source, file_name, file_path, mime_type,
        email_from, email_subject, status, error, document_type, supplier, supplier_abn, invoice_number, invoice_date, due_date, currency,
        subtotal, tax, total, notes, ${has('category') ? 'category' : 'NULL'}, ${has('category_manual') ? 'category_manual' : '0'},
        ${has('attached_later') ? 'attached_later' : '0'}, created_at
      FROM invoices`);

    // Every line of an invoice that wasn't split goes wholly to its job, keeping type and screw-up tag.
    const allocCols = tables.includes('allocations') ? cols(db, 'allocations') : [];
    if (tables.includes('allocations') && !allocCols.includes('category')) db.exec('ALTER TABLE allocations ADD COLUMN category TEXT');
    const mk = itemCols.includes('mistake_reason');
    const splitCol = has('split') ? 'invoices.split' : '0';
    db.exec(`INSERT OR IGNORE INTO allocations (item_id, job_uuid, fraction, category, mistake_reason, mistake_at)
      SELECT items.id, invoices.job_uuid, 1, ${has('category') ? 'invoices.category' : 'NULL'},
        ${mk ? 'items.mistake_reason' : 'NULL'}, ${mk ? 'items.mistake_at' : 'NULL'}
      FROM items JOIN invoices ON invoices.id = items.invoice_id WHERE ${splitCol} = 0`);
    if (has('category')) {
      db.exec(`UPDATE allocations SET category = (SELECT invoices.category FROM items JOIN invoices ON invoices.id = items.invoice_id
        WHERE items.id = allocations.item_id) WHERE category IS NULL`);
    }
    db.exec('DROP TABLE invoices');
    db.exec('ALTER TABLE invoices_v2 RENAME TO invoices');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Columns added after a table was first created. */
function migrateColumns(db) {
  const jobCols = cols(db, 'jobs');
  if (!jobCols.includes('quote_amount')) db.exec('ALTER TABLE jobs ADD COLUMN quote_amount REAL');
  // 'servicem8' = taken from the job in ServiceM8, 'manual' = typed in on the card (never overwritten)
  if (!jobCols.includes('quote_source')) db.exec('ALTER TABLE jobs ADD COLUMN quote_source TEXT');
  if (!jobCols.includes('sm8_status')) db.exec('ALTER TABLE jobs ADD COLUMN sm8_status TEXT');
  if (!jobCols.includes('client_name')) db.exec('ALTER TABLE jobs ADD COLUMN client_name TEXT');
  if (!jobCols.includes('category_name')) db.exec('ALTER TABLE jobs ADD COLUMN category_name TEXT');
  // Stock order job: auto = matched by client/category; manual = the switch on the card (wins when set).
  if (!jobCols.includes('stock_auto')) db.exec('ALTER TABLE jobs ADD COLUMN stock_auto INTEGER NOT NULL DEFAULT 0');
  if (!jobCols.includes('stock_manual')) db.exec('ALTER TABLE jobs ADD COLUMN stock_manual INTEGER');
  // The stock order job an invoice in stock came in on.
  if (!cols(db, 'invoices').includes('stock_job_uuid')) db.exec('ALTER TABLE invoices ADD COLUMN stock_job_uuid TEXT');
  // Link to the ServiceM8 job diary: the file there (pulled from it, or copied to it) and our note.
  const ic = cols(db, 'invoices');
  const add = (c, type) => { if (!ic.includes(c)) db.exec(`ALTER TABLE invoices ADD COLUMN ${c} ${type}`); };
  add('sm8_attachment_uuid', 'TEXT');
  add('sm8_note_uuid', 'TEXT');
  add('sm8_job_uuid', 'TEXT');           // the job whose diary holds it
  add('sm8_link', 'TEXT');               // 'pulled' (came from the diary) | 'pushed' (copied there by Job Costs)
  add('sm8_missing', 'INTEGER NOT NULL DEFAULT 0'); // the diary file was deleted in ServiceM8
  add('diary_pending', 'INTEGER NOT NULL DEFAULT 0'); // needs a look by the diary copier
  add('purchase_kind', 'TEXT');          // Claude's guess: 'job' | 'stock' | 'unclear'
  // Approved from the Inbox (so it can be undone): when, and onto which job (null = stock).
  add('approved_at', 'TEXT');
  add('approved_job_uuid', 'TEXT');
  if (!cols(db, 'allocations').includes('category')) db.exec('ALTER TABLE allocations ADD COLUMN category TEXT');
  const accCols = cols(db, 'accounts');
  for (const c of ['sm8_access_token', 'sm8_refresh_token', 'sm8_expires_at']) {
    if (!accCols.includes(c)) db.exec(`ALTER TABLE accounts ADD COLUMN ${c} TEXT`);
  }
}

function createRepo(db, dataDir) {
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

  const repo = {
    db,
    filesDir: path.join(dataDir, 'files'),

    // ---------- jobs & accounts ----------

    ensureJob({ jobUUID, accountUUID = null, jobNumber = null, jobTitle = null, quoteAmount = null, status = null,
      clientName = null, categoryName = null, stockAuto = undefined }) {
      const job = db.prepare('SELECT * FROM jobs WHERE job_uuid = ?').get(jobUUID);
      if (!job) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            db.prepare('INSERT INTO jobs (job_uuid, account_uuid, inbox_code, job_number, job_title, sm8_status) VALUES (?, ?, ?, ?, ?, ?)')
              .run(jobUUID, accountUUID, newInboxCode(10), jobNumber, jobTitle, status);
            break;
          } catch (e) {
            if (!String(e.message).includes('UNIQUE') || attempt === 4) throw e;
          }
        }
      } else {
        db.prepare(`UPDATE jobs SET job_number = COALESCE(?, job_number), job_title = COALESCE(?, job_title),
            account_uuid = COALESCE(?, account_uuid), sm8_status = COALESCE(?, sm8_status) WHERE job_uuid = ?`)
          .run(jobNumber, jobTitle, accountUUID, status, jobUUID);
      }
      if (clientName || categoryName) {
        db.prepare('UPDATE jobs SET client_name = COALESCE(?, client_name), category_name = COALESCE(?, category_name) WHERE job_uuid = ?')
          .run(clientName, categoryName, jobUUID);
      }
      if (stockAuto !== undefined) db.prepare('UPDATE jobs SET stock_auto = ? WHERE job_uuid = ?').run(stockAuto ? 1 : 0, jobUUID);
      if (quoteAmount != null && isFinite(quoteAmount)) {
        db.prepare(`UPDATE jobs SET quote_amount = ?, quote_source = 'servicem8'
          WHERE job_uuid = ? AND COALESCE(quote_source, '') != 'manual'`).run(round2(quoteAmount), jobUUID);
      }
      return repo.getJob(jobUUID);
    },

    getJob(jobUUID) {
      const j = db.prepare('SELECT * FROM jobs WHERE job_uuid = ?').get(jobUUID);
      return j ? { ...j, is_stock: j.stock_manual != null ? !!j.stock_manual : !!j.stock_auto } : j;
    },

    /**
     * Move everything on one job to another (a split part's costs go to its main job):
     * shares of invoice lines, uploads still being read, suggestions.
     */
    mergeJobInto(fromUUID, toUUID) {
      if (!fromUUID || !toUUID || fromUUID === toUUID) return 0;
      let moved = 0;
      tx(() => {
        for (const a of db.prepare('SELECT * FROM allocations WHERE job_uuid = ?').all(fromUUID)) {
          const existing = repo.getShare(a.item_id, toUUID);
          if (existing) {
            db.prepare('UPDATE allocations SET fraction = ? WHERE id = ?').run(Math.min(1, existing.fraction + a.fraction), existing.id);
            db.prepare('DELETE FROM allocations WHERE id = ?').run(a.id);
          } else {
            db.prepare('UPDATE allocations SET job_uuid = ? WHERE id = ?').run(toUUID, a.id);
          }
          moved++;
        }
        db.prepare('UPDATE invoices SET origin_job_uuid = ? WHERE origin_job_uuid = ?').run(toUUID, fromUUID);
        db.prepare('UPDATE invoices SET suggested_job_uuid = ? WHERE suggested_job_uuid = ?').run(toUUID, fromUUID);
      });
      return moved;
    },

    /** Job numbers written on an invoice (references, email subject, file name), e.g. "207932-1" → 207932. */
    jobNumbersOn(invoiceId) {
      const inv = repo.getInvoice(invoiceId);
      if (!inv) return [];
      const text = [parseJson(inv.refs, []).join(' | '), inv.email_subject, inv.file_name].filter(Boolean).join(' | ');
      return [...new Set([...text.matchAll(/(?:^|[^0-9A-Za-z])(\d{6})(?![0-9])/g)].map((m) => m[1]))].slice(0, 4);
    },

    findJobByNumber(accountUUID, jobNumber) {
      return db.prepare('SELECT job_uuid FROM jobs WHERE account_uuid IS ? AND job_number = ? LIMIT 1').get(accountUUID, String(jobNumber))?.job_uuid || null;
    },

    /** Split parts of a main job that we know of (e.g. ['207974A', '207974B']). */
    splitParts(accountUUID, jobNumber) {
      if (!jobNumber || mainJobNumber(jobNumber)) return [];
      return db.prepare("SELECT job_number FROM jobs WHERE account_uuid IS ? AND job_number LIKE ? ORDER BY job_number").all(accountUUID, `${jobNumber}%`)
        .map((j) => j.job_number).filter((n) => mainJobNumber(n) === String(jobNumber));
    },

    /** Leave out split parts whose main job we know: they're shown as the main job. */
    _withoutSplitParts(jobs) {
      const numbers = new Set(jobs.map((j) => String(j.job_number)));
      return jobs.filter((j) => { const main = mainJobNumber(j.job_number); return !main || !numbers.has(main); });
    },

    /** This job and its split parts (#207974A, #207974B…) we know of. */
    familyJobUUIDs(jobUUID) {
      const job = repo.getJob(jobUUID);
      if (!job) return [jobUUID];
      const parts = repo.splitParts(job.account_uuid, job.job_number);
      const uuids = parts.length ? db.prepare(`SELECT job_uuid FROM jobs WHERE account_uuid IS ? AND job_number IN (${parts.map(() => '?').join(',')})`)
        .all(job.account_uuid, ...parts).map((r) => r.job_uuid) : [];
      return [jobUUID, ...uuids];
    },

    isStockJob(jobUUID) {
      return !!repo.getJob(jobUUID)?.is_stock;
    },

    /**
     * The "stock order job" switch. true/false sets it by hand; null goes back to the
     * automatic rule. A job that becomes a stock order job hands its invoices over to stock.
     */
    setStockManual(jobUUID, value) {
      db.prepare('UPDATE jobs SET stock_manual = ? WHERE job_uuid = ?').run(value == null ? null : (value ? 1 : 0), jobUUID);
      if (repo.isStockJob(jobUUID)) {
        const invs = db.prepare(`SELECT DISTINCT items.invoice_id AS id FROM allocations JOIN items ON items.id = allocations.item_id
          WHERE allocations.job_uuid = ?`).all(jobUUID);
        tx(() => { for (const { id } of invs) { repo.removeFromJob(id, jobUUID); repo.linkToStock(id, jobUUID); } });
      } else {
        db.prepare('UPDATE invoices SET stock_job_uuid = NULL WHERE stock_job_uuid = ?').run(jobUUID);
      }
    },

    /** Take an invoice off a stock order job; it stays in stock. */
    unlinkStock(invoiceId) {
      db.prepare('UPDATE invoices SET stock_job_uuid = NULL WHERE id = ?').run(invoiceId);
    },

    /** Put an invoice into stock, noting which stock order job it came in on. */
    linkToStock(invoiceId, jobUUID) {
      db.prepare(`UPDATE invoices SET kept_as_stock = 1, stock_job_uuid = ?, suggested_job_uuid = NULL, suggestion_reason = NULL
        WHERE id = ?`).run(jobUUID || null, invoiceId);
    },

    /** Quoted price typed on the card. null clears it so ServiceM8's value is used again. */
    setQuote(jobUUID, amount) {
      if (amount == null) db.prepare('UPDATE jobs SET quote_amount = NULL, quote_source = NULL WHERE job_uuid = ?').run(jobUUID);
      else db.prepare("UPDATE jobs SET quote_amount = ?, quote_source = 'manual' WHERE job_uuid = ?").run(round2(amount), jobUUID);
    },

    /** Jobs to pick from (newest job numbers first). */
    listJobs(accountUUID) {
      return repo._withoutSplitParts(db.prepare(`SELECT job_uuid, job_number, job_title, sm8_status, COALESCE(stock_manual, stock_auto) AS is_stock FROM jobs WHERE account_uuid IS ? AND job_number IS NOT NULL
        ORDER BY CAST(job_number AS INTEGER) DESC, job_number DESC`).all(accountUUID));
    },

    /** The business's account row (created on first use) – holds its one inbox code. */
    ensureAccount(accountUUID) {
      const key = accountUUID ?? '';
      let acc = db.prepare('SELECT * FROM accounts WHERE account_key = ?').get(key);
      for (let attempt = 0; !acc && attempt < 5; attempt++) {
        try { db.prepare('INSERT INTO accounts (account_key, inbox_code) VALUES (?, ?)').run(key, newInboxCode()); } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; }
        acc = db.prepare('SELECT * FROM accounts WHERE account_key = ?').get(key);
      }
      return acc;
    },

    /** Returns { accountUUID } for an inbox code, or null. */
    accountByInboxCode(code) {
      const acc = db.prepare('SELECT * FROM accounts WHERE inbox_code = ?').get(String(code).toLowerCase());
      return acc ? { accountUUID: acc.account_key === '' ? null : acc.account_key } : null;
    },

    /**
     * The business an email belongs to when its address has no code (a mailbox the app
     * checks belongs to one business): the only ServiceM8 account, or the local test one.
     */
    defaultAccount() {
      const real = db.prepare("SELECT account_key FROM accounts WHERE account_key NOT IN ('', '__pending__')").all();
      if (real.length === 1) return { accountUUID: real[0].account_key };
      if (!real.length && db.prepare("SELECT 1 FROM accounts WHERE account_key = ''").get()) return { accountUUID: null };
      return null;
    },

    isMailProcessed(key) {
      return !!db.prepare('SELECT 1 FROM processed_mail WHERE mail_key = ?').get(key);
    },

    markMailProcessed(key) {
      db.prepare('INSERT OR IGNORE INTO processed_mail (mail_key) VALUES (?)').run(key);
    },

    /** ServiceM8 access for an account, from approving the add-on (OAuth). */
    // ----- Outlook -----
    saveOutlook(accountKey, f) {
      const key = accountKey ?? '';
      db.prepare('INSERT INTO outlook (account_key) VALUES (?) ON CONFLICT (account_key) DO NOTHING').run(key);
      const cols = { email: f.email, name: f.name, access_token: f.accessToken, refresh_token: f.refreshToken, expires_at: f.expiresAt,
        connected_at: f.connectedAt, last_received: f.lastReceived, last_check: f.lastCheck, error: f.error };
      const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
      if (keys.length) db.prepare(`UPDATE outlook SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE account_key = ?`).run(...keys.map((k) => cols[k]), key);
    },
    getOutlook(accountUUID) {
      return db.prepare('SELECT * FROM outlook WHERE account_key = ?').get(accountUUID ?? '') || null;
    },
    listOutlookConnections() {
      return db.prepare('SELECT * FROM outlook WHERE refresh_token IS NOT NULL').all();
    },
    removeOutlook(accountUUID) {
      db.prepare('DELETE FROM outlook WHERE account_key = ?').run(accountUUID ?? '');
    },

    saveTokens(accountUUID, { accessToken, refreshToken, expiresIn }) {
      repo.ensureAccount(accountUUID);
      db.prepare(`UPDATE accounts SET sm8_access_token = ?, sm8_refresh_token = COALESCE(?, sm8_refresh_token), sm8_expires_at = ?
        WHERE account_key = ?`).run(accessToken, refreshToken || null, new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString(), accountUUID ?? '');
    },

    /**
     * Approval saved before we knew which account it was for: it's kept aside and handed
     * to the first account whose Job Costs button is clicked.
     */
    savePendingTokens(tokens) {
      db.prepare(`INSERT INTO accounts (account_key, inbox_code) VALUES ('__pending__', ?)
        ON CONFLICT (account_key) DO NOTHING`).run('pending-' + newInboxCode(12));
      db.prepare(`UPDATE accounts SET sm8_access_token = ?, sm8_refresh_token = ?, sm8_expires_at = ? WHERE account_key = '__pending__'`)
        .run(tokens.accessToken, tokens.refreshToken || null, new Date(Date.now() + (tokens.expiresIn || 3600) * 1000).toISOString());
    },

    /**
     * Give a waiting approval to this account. It's the newest approval (e.g. after
     * re-installing with more permissions), so it replaces an older one. Returns true if it did.
     */
    claimPendingTokens(accountUUID) {
      if (accountUUID == null) return false;
      const p = db.prepare("SELECT * FROM accounts WHERE account_key = '__pending__' AND sm8_access_token IS NOT NULL").get();
      if (!p) return false;
      repo.ensureAccount(accountUUID);
      tx(() => {
        db.prepare('UPDATE accounts SET sm8_access_token = ?, sm8_refresh_token = ?, sm8_expires_at = ? WHERE account_key = ?')
          .run(p.sm8_access_token, p.sm8_refresh_token, p.sm8_expires_at, accountUUID);
        db.prepare("DELETE FROM accounts WHERE account_key = '__pending__'").run();
      });
      return true;
    },

    getTokens(accountUUID) {
      const a = db.prepare('SELECT sm8_access_token, sm8_refresh_token, sm8_expires_at FROM accounts WHERE account_key = ?').get(accountUUID ?? '');
      return a && a.sm8_access_token ? { accessToken: a.sm8_access_token, refreshToken: a.sm8_refresh_token, expiresAt: a.sm8_expires_at } : null;
    },

    jobsSyncedRecently(accountUUID, minutes) {
      const acc = repo.ensureAccount(accountUUID);
      return acc.jobs_synced_at && Date.now() - Date.parse(acc.jobs_synced_at) < minutes * 60000;
    },

    /** Store active jobs fetched from ServiceM8, so emailed invoices can be matched to them. */
    saveSyncedJobs(accountUUID, jobs) {
      tx(() => {
        for (const j of jobs) repo.ensureJob({ ...j, accountUUID });
        db.prepare('UPDATE accounts SET jobs_synced_at = ? WHERE account_key = ?').run(new Date().toISOString(), accountUUID ?? '');
      });
    },

    // ---------- invoices ----------

    createInvoice(f) {
      const r = db.prepare(`INSERT INTO invoices
        (account_uuid, origin_job_uuid, source, file_name, file_path, mime_type, email_from, email_subject, email_text, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')`).run(
        f.accountUUID ?? null, f.originJobUUID || null, f.source, f.fileName || null, f.filePath || null, f.mimeType || null,
        f.emailFrom || null, f.emailSubject || null, f.emailText ? String(f.emailText).slice(0, 5000) : null,
      );
      return repo.getInvoice(Number(r.lastInsertRowid));
    },

    getInvoice(id) {
      return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    },

    setInvoiceProcessing(id) {
      db.prepare("UPDATE invoices SET status = 'processing', error = NULL WHERE id = ?").run(id);
    },

    setInvoiceError(id, message) {
      // If the invoice already has details (read before, or added by hand), keep them
      // counted and just show the problem; otherwise it needs attention.
      const hasItems = db.prepare('SELECT 1 FROM items WHERE invoice_id = ? LIMIT 1').get(id);
      db.prepare('UPDATE invoices SET status = ?, error = ? WHERE id = ?')
        .run(hasItems ? 'ready' : 'error', String(message).slice(0, 500), id);
    },

    /** Put a file on an invoice that was added by hand; it is then read like any other. */
    attachFile(id, { fileName, filePath, mimeType }) {
      db.prepare(`UPDATE invoices SET file_name = ?, file_path = ?, mime_type = ?, source = 'upload',
          attached_later = 1, diary_pending = 1 WHERE id = ?`).run(fileName, filePath, mimeType, id);
    },

    // ----- ServiceM8 job diary -----

    /** The one job that has ALL of this invoice (shared / partly used invoices return null). */
    wholeJobOf(invoiceId) {
      const items = db.prepare('SELECT id FROM items WHERE invoice_id = ?').all(invoiceId);
      if (!items.length) return null;
      let job = null;
      for (const it of items) {
        const list = db.prepare('SELECT job_uuid, fraction FROM allocations WHERE item_id = ?').all(it.id);
        if (list.length !== 1 || list[0].fraction < 1 - EPS) return null;
        if (job && job !== list[0].job_uuid) return null;
        job = list[0].job_uuid;
      }
      return job;
    },

    listDiaryPending() {
      return db.prepare("SELECT * FROM invoices WHERE diary_pending = 1 AND status = 'ready'").all();
    },

    setDiary(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      db.prepare(`UPDATE invoices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    },

    /** Invoices whose file came from / went to this job's diary (to spot ones deleted there). */
    diaryLinked(jobUUIDs) {
      if (!jobUUIDs.length) return [];
      return db.prepare(`SELECT * FROM invoices WHERE sm8_attachment_uuid IS NOT NULL AND sm8_job_uuid IN (${jobUUIDs.map(() => '?').join(',')})`).all(...jobUUIDs);
    },

    invoiceByAttachment(attachmentUUID) {
      return db.prepare('SELECT * FROM invoices WHERE sm8_attachment_uuid = ?').get(attachmentUUID);
    },

    /** Save what Claude read from the document, replacing any earlier result. */
    saveExtraction(id, x) {
      const items = (x.items || []).filter((it) => it && it.description);
      if (!items.length && x.total != null) {
        items.push({ description: x.supplier_name ? `Invoice from ${x.supplier_name}` : 'Invoice total', category: 'other', line_total: x.total });
      }
      const total = x.total != null ? x.total : items.reduce((s, it) => s + (Number(it.line_total) || 0), 0);
      const costs = allocateCosts(items, exGst(total, x.tax));
      const alreadyPaid = x.payment_status === 'paid';

      // Keep paid ticks and job assignments from an earlier reading of the same lines.
      const oldItems = db.prepare('SELECT * FROM items WHERE invoice_id = ?').all(id);
      const before = new Map(oldItems.map((o) => [norm(o.description), o]));
      const wasAllPaid = oldItems.length > 0 && oldItems.every((o) => o.paid);
      const oldAllocs = db.prepare(`SELECT allocations.*, items.description FROM allocations
        JOIN items ON items.id = allocations.item_id WHERE items.invoice_id = ?`).all(id);
      // Jobs that had the whole invoice keep the whole invoice, even if the lines are different now
      // (e.g. a hand-entered invoice gets its real file).
      const wholeJobs = [...new Set(oldAllocs.map((a) => a.job_uuid))].filter((job) =>
        oldItems.length && oldItems.every((o) => oldAllocs.some((a) => a.item_id === o.id && a.job_uuid === job && a.fraction >= 1 - EPS)));

      tx(() => {
        db.prepare(`UPDATE invoices SET status = 'ready', error = NULL,
            document_type = ?, supplier = ?, supplier_abn = ?, invoice_number = ?, invoice_date = ?,
            due_date = ?, currency = ?, subtotal = ?, tax = ?, total = ?, notes = ?, refs = ?, site_address = ?, purchase_kind = ?,
            category = CASE WHEN category_manual = 1 THEN category ELSE ? END
          WHERE id = ?`).run(
          x.document_type || null, x.supplier_name || null, x.supplier_abn || null, x.invoice_number || null,
          x.invoice_date || null, x.due_date || null, x.currency || null,
          x.subtotal ?? null, x.tax ?? null, round2(total), x.notes || null,
          JSON.stringify((x.references || []).filter(Boolean).slice(0, 20)), x.site_address || null, x.purchase_kind || null, invoiceCategory(items), id,
        );
        db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(id);
        db.prepare('DELETE FROM items WHERE invoice_id = ?').run(id);
        const ins = db.prepare(`INSERT INTO items
          (invoice_id, position, description, category, quantity, unit, unit_price, line_total, cost, paid, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();
        items.forEach((it, i) => {
          const old = before.get(norm(it.description));
          const paid = alreadyPaid || wasAllPaid || !!(old && old.paid);
          ins.run(id, i, String(it.description).slice(0, 500), it.category || 'other',
            it.quantity ?? null, it.unit || null, it.unit_price ?? null, round2(it.line_total), costs[i],
            paid ? 1 : 0, paid ? (old?.paid_at || oldItems[0]?.paid_at || now) : null);
        });
        const newItems = db.prepare('SELECT id, description FROM items WHERE invoice_id = ?').all(id);
        const insA = db.prepare(`INSERT INTO allocations (item_id, job_uuid, fraction, category, mistake_reason, mistake_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id, job_uuid) DO NOTHING`);
        // Whole-invoice jobs first (their tags come from their first old line)…
        for (const job of wholeJobs) {
          const sample = oldAllocs.find((a) => a.job_uuid === job);
          const allSameMk = oldAllocs.filter((a) => a.job_uuid === job).every((a) => a.mistake_reason === sample.mistake_reason);
          for (const it of newItems) insA.run(it.id, job, 1, sample.category, allSameMk ? sample.mistake_reason : null, allSameMk ? sample.mistake_at : null);
        }
        // …then shares of matching lines.
        const byDesc = new Map(newItems.map((r) => [norm(r.description), r.id]));
        for (const a of oldAllocs) {
          if (wholeJobs.includes(a.job_uuid)) continue;
          const itemId = byDesc.get(norm(a.description));
          if (itemId) insA.run(itemId, a.job_uuid, a.fraction, a.category, a.mistake_reason, a.mistake_at);
        }
      });
      return repo.getInvoice(id);
    },

    deleteInvoice(id) {
      const inv = repo.getInvoice(id);
      if (!inv) return;
      tx(() => {
        db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(id);
        db.prepare('DELETE FROM items WHERE invoice_id = ?').run(id);
        db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
      });
      if (inv.file_path) fs.rm(path.join(repo.filesDir, inv.file_path), { force: true }, () => {});
    },

    getItem(id) {
      return db.prepare('SELECT items.*, invoices.account_uuid FROM items JOIN invoices ON invoices.id = items.invoice_id WHERE items.id = ?').get(id);
    },

    /** Every read invoice of the business, for the Bills page: who, how much, which jobs, paid or not. */
    listBills(accountUUID) {
      const invs = db.prepare(`SELECT * FROM invoices WHERE account_uuid IS ? AND status = 'ready' ORDER BY COALESCE(invoice_date, created_at) DESC, id DESC`).all(accountUUID);
      if (!invs.length) return [];
      const ids = invs.map((i) => i.id).join(',');
      const paid = new Map(db.prepare(`SELECT invoice_id, COUNT(*) AS n, SUM(paid) AS p, MAX(paid_at) AS at FROM items WHERE invoice_id IN (${ids}) GROUP BY invoice_id`).all()
        .map((r) => [r.invoice_id, r]));
      const jobs = new Map();
      for (const r of db.prepare(`SELECT DISTINCT items.invoice_id, jobs.job_uuid, jobs.job_number FROM allocations JOIN items ON items.id = allocations.item_id
          LEFT JOIN jobs ON jobs.job_uuid = allocations.job_uuid WHERE items.invoice_id IN (${ids})`).all()) {
        if (!jobs.has(r.invoice_id)) jobs.set(r.invoice_id, []);
        jobs.get(r.invoice_id).push({ job_uuid: r.job_uuid, job_number: r.job_number });
      }
      return invs.map((i) => {
        const p = paid.get(i.id) || { n: 0, p: 0 };
        return {
          id: i.id, supplier: i.supplier, invoice_number: i.invoice_number, invoice_date: i.invoice_date, due_date: i.due_date,
          total: i.total, total_ex: exGst(i.total, i.tax), file_path: i.file_path, mime_type: i.mime_type, source: i.source,
          jobs: jobs.get(i.id) || [], in_stock: !!i.kept_as_stock, paid_at: p.at || null,
          payment_state: !p.n ? 'unpaid' : p.p >= p.n ? 'paid' : p.p > 0 ? 'part' : 'unpaid',
        };
      });
    },

    setInvoicePaid(id, paid) {
      db.prepare('UPDATE items SET paid = ?, paid_at = ? WHERE invoice_id = ?')
        .run(paid ? 1 : 0, paid ? new Date().toISOString() : null, id);
    },

    /** Change the invoice's default type by hand; kept when the invoice is read again. */
    setInvoiceCategory(id, category) {
      db.prepare('UPDATE invoices SET category = ?, category_manual = 1 WHERE id = ?').run(category, id);
    },

    /** Manual correction of a line; re-spreads the invoice total over the lines. */
    updateItem(id, { description, line_total }) {
      const item = repo.getItem(id);
      if (!item) return;
      db.prepare('UPDATE items SET description = COALESCE(?, description), line_total = COALESCE(?, line_total) WHERE id = ?')
        .run(description ?? null, line_total == null ? null : round2(line_total), id);
      repo.reallocate(item.invoice_id);
    },

    updateInvoice(id, { supplier, invoice_number, total }) {
      db.prepare(`UPDATE invoices SET supplier = COALESCE(?, supplier), invoice_number = COALESCE(?, invoice_number),
          total = COALESCE(?, total) WHERE id = ?`)
        .run(supplier ?? null, invoice_number ?? null, total == null ? null : round2(total), id);
      repo.reallocate(id);
    },

    reallocate(invoiceId) {
      const inv = repo.getInvoice(invoiceId);
      const items = db.prepare('SELECT * FROM items WHERE invoice_id = ? ORDER BY position, id').all(invoiceId);
      const costs = allocateCosts(items, exGst(inv.total, inv.tax));
      const upd = db.prepare('UPDATE items SET cost = ? WHERE id = ?');
      items.forEach((it, i) => upd.run(costs[i], it.id));
    },

    // ---------- assigning to jobs ----------

    /** Fraction of a line not assigned to any job. */
    leftOf(itemId) {
      return Math.max(0, 1 - db.prepare('SELECT COALESCE(SUM(fraction), 0) AS f FROM allocations WHERE item_id = ?').get(itemId).f);
    },

    getShare(itemId, jobUUID) {
      return db.prepare('SELECT * FROM allocations WHERE item_id = ? AND job_uuid = ?').get(itemId, jobUUID);
    },

    /**
     * Set a job's share of a line (0..1). 0 removes it. `fields` may set the type and
     * screw-up tag for this share. Fails if the jobs together would get more than the line.
     */
    setShare(itemId, jobUUID, fraction, fields = {}) {
      if (!(fraction >= 0)) throw fail('Amount cannot be negative');
      if (fraction > EPS && repo.isStockJob(jobUUID)) throw fail('This is a stock order job, so it doesn\u2019t take costs. Add items to the job that uses them.');
      const others = db.prepare('SELECT COALESCE(SUM(fraction), 0) AS f FROM allocations WHERE item_id = ? AND job_uuid != ?').get(itemId, jobUUID).f;
      if (fraction + others > 1 + EPS) throw fail('That is more than is left on this line', 400, { left: Math.max(0, 1 - others) });
      if (fraction <= EPS) { db.prepare('DELETE FROM allocations WHERE item_id = ? AND job_uuid = ?').run(itemId, jobUUID); return; }
      const item = repo.getItem(itemId);
      const category = fields.category || repo.getShare(itemId, jobUUID)?.category || repo.getInvoice(item.invoice_id)?.category || 'materials';
      db.prepare(`INSERT INTO allocations (item_id, job_uuid, fraction, category) VALUES (?, ?, ?, ?)
        ON CONFLICT (item_id, job_uuid) DO UPDATE SET fraction = excluded.fraction, category = excluded.category`)
        .run(itemId, jobUUID, Math.min(1, fraction), category);
      if (fields.mistake_reason !== undefined) repo.setShareFields(itemId, jobUUID, { mistake_reason: fields.mistake_reason });
    },

    /** Add more of a line to a job (on top of what it already has). */
    addShare(itemId, jobUUID, extra, fields = {}) {
      const mine = repo.getShare(itemId, jobUUID)?.fraction || 0;
      repo.setShare(itemId, jobUUID, mine + extra, fields);
    },

    /** Give a job everything that's still left on an invoice. */
    assignWhole(invoiceId, jobUUID, fields = {}) {
      if (repo.isStockJob(jobUUID)) { repo.linkToStock(invoiceId, jobUUID); return; }
      tx(() => {
        for (const it of db.prepare('SELECT id FROM items WHERE invoice_id = ?').all(invoiceId)) {
          const left = repo.leftOf(it.id);
          if (left > EPS) repo.addShare(it.id, jobUUID, left, fields);
        }
        db.prepare('UPDATE invoices SET suggested_job_uuid = NULL, suggestion_reason = NULL, diary_pending = 1 WHERE id = ?').run(invoiceId);
      });
    },

    setShareFields(itemId, jobUUID, { category, mistake_reason }) {
      if (category !== undefined) db.prepare('UPDATE allocations SET category = ? WHERE item_id = ? AND job_uuid = ?').run(category, itemId, jobUUID);
      if (mistake_reason !== undefined) {
        db.prepare('UPDATE allocations SET mistake_reason = ?, mistake_at = ? WHERE item_id = ? AND job_uuid = ?')
          .run(mistake_reason || null, mistake_reason ? new Date().toISOString() : null, itemId, jobUUID);
      }
    },

    /** Set type / screw-up on all of a job's shares of an invoice. */
    setInvoiceShareFields(invoiceId, jobUUID, fields) {
      for (const it of db.prepare('SELECT id FROM items WHERE invoice_id = ?').all(invoiceId)) repo.setShareFields(it.id, jobUUID, fields);
    },

    /** Take a job's shares of an invoice off it; they become "not assigned yet" again. */
    removeFromJob(invoiceId, jobUUID) {
      db.prepare('DELETE FROM allocations WHERE job_uuid = ? AND item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(jobUUID, invoiceId);
    },

    /** Jobs with a share of this invoice. */
    jobsOnInvoice(invoiceId) {
      return db.prepare(`SELECT DISTINCT allocations.job_uuid, jobs.job_number, jobs.job_title FROM allocations
        JOIN items ON items.id = allocations.item_id LEFT JOIN jobs ON jobs.job_uuid = allocations.job_uuid
        WHERE items.invoice_id = ?`).all(invoiceId);
    },

    /** Assign an invoice uploaded or typed on a job to that job, once it has been read. */
    assignToOrigin(invoiceId) {
      const inv = repo.getInvoice(invoiceId);
      if (!inv || !inv.origin_job_uuid || inv.status !== 'ready') return;
      const hasAny = db.prepare('SELECT 1 FROM allocations JOIN items ON items.id = allocations.item_id WHERE items.invoice_id = ? LIMIT 1').get(invoiceId);
      if (!hasAny) repo.assignWhole(invoiceId, inv.origin_job_uuid, { category: inv.category });
    },

    // ---------- suggestions ----------

    /**
     * Guess which job an emailed invoice is for: a job number in the email subject/text,
     * the invoice's references or the file name, or the site address. Stores the best
     * guess (only if it's clear) with the reason.
     */
    suggestJob(invoiceId) {
      const inv = repo.getInvoice(invoiceId);
      if (!inv || inv.status !== 'ready') return null;
      const dismissed = new Set(parseJson(inv.dismissed_jobs, []));
      // A job number written on the invoice counts for any job (also completed ones);
      // a matching address only for jobs still open.
      const jobs = db.prepare(`SELECT * FROM jobs WHERE account_uuid IS ? AND job_number IS NOT NULL`).all(inv.account_uuid)
        .filter((j) => !dismissed.has(j.job_uuid));
      const isOpen = (j) => ['Quote', 'Work Order'].includes(j.sm8_status || 'Work Order');
      const activeJobs = repo._withoutSplitParts(jobs);
      const places = [
        ['the email subject', inv.email_subject],
        ['the invoice reference', parseJson(inv.refs, []).join(' | ')],
        ['the file name', inv.file_name],
        ['the email', inv.email_text],
      ];
      const site = addressKey(inv.site_address);
      const scored = [];
      for (const j of activeJobs) {
        const num = String(j.job_number).trim();
        let best = null;
        if (num.length >= 3) {
          const re = new RegExp(`(^|[^0-9])${num.replace(/[^0-9a-z]/gi, '')}([^0-9]|$)`, 'i');
          for (const [where, text] of places) if (text && re.test(text)) { best = { score: 3, reason: `Found “${num}” in ${where}` }; break; }
        }
        const jobAddr = addressKey(j.job_title);
        if (!best && isOpen(j) && site && jobAddr && site.number === jobAddr.number && site.street === jobAddr.street) {
          best = { score: 2, reason: `Site address matches ${String(j.job_title).split(',')[0]}` };
        }
        if (best) scored.push({ job: j, ...best });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored[0];
      const clear = top && !(scored[1] && scored[1].score === top.score);
      db.prepare('UPDATE invoices SET suggested_job_uuid = ?, suggestion_reason = ? WHERE id = ?')
        .run(clear ? top.job.job_uuid : null, clear ? top.reason : null, invoiceId);
      return clear ? top.job.job_uuid : null;
    },

    /** "Not this job": forget the suggestion and don't suggest that job again for this invoice. */
    dismissSuggestion(invoiceId) {
      const inv = repo.getInvoice(invoiceId);
      if (!inv) return;
      const dismissed = new Set(parseJson(inv.dismissed_jobs, []));
      if (inv.suggested_job_uuid) dismissed.add(inv.suggested_job_uuid);
      db.prepare('UPDATE invoices SET suggested_job_uuid = NULL, suggestion_reason = NULL, dismissed_jobs = ? WHERE id = ?')
        .run(JSON.stringify([...dismissed]), invoiceId);
      repo.suggestJob(invoiceId);
    },

    /** Leave an invoice unassigned on purpose (stock); it stops showing as new in the inbox. */
    // ----- approvals from the Inbox (can be undone) -----
    markApproved(invoiceId, jobUUID) {
      db.prepare("UPDATE invoices SET approved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), approved_job_uuid = ? WHERE id = ?").run(jobUUID || null, invoiceId);
    },
    listRecentlyApproved(accountUUID, days = 14) {
      return db.prepare(`SELECT invoices.*, jobs.job_number, jobs.job_title FROM invoices LEFT JOIN jobs ON jobs.job_uuid = invoices.approved_job_uuid
        WHERE invoices.account_uuid IS ? AND approved_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) ORDER BY approved_at DESC LIMIT 30`)
        .all(accountUUID, `-${days} days`).map((i) => ({
          id: i.id, supplier: i.supplier, invoice_number: i.invoice_number, invoice_date: i.invoice_date, total: i.total, total_ex: exGst(i.total, i.tax),
          approved_at: i.approved_at, job_uuid: i.approved_job_uuid, job_number: i.job_number, job_title: i.job_title, to_stock: !i.approved_job_uuid,
          file_path: i.file_path, mime_type: i.mime_type, possible_duplicate: repo.possibleDuplicate(i),
        }));
    },
    /** Put an approved invoice back in the Inbox. */
    undoApproval(invoiceId) {
      const inv = repo.getInvoice(invoiceId);
      if (!inv || !inv.approved_at) return null;
      tx(() => {
        if (inv.approved_job_uuid) repo.removeFromJob(invoiceId, inv.approved_job_uuid);
        db.prepare('UPDATE invoices SET kept_as_stock = 0, stock_job_uuid = NULL, approved_at = NULL, approved_job_uuid = NULL WHERE id = ?').run(invoiceId);
      });
      return inv;
    },

    /**
     * Another invoice that looks like the same bill: same supplier and invoice number, or
     * (when a number is missing) same supplier, amount and date. Says which job(s) it's on.
     */
    possibleDuplicate(inv) {
      if (!inv || !inv.supplier) return null;
      const sup = String(inv.supplier).trim().toLowerCase();
      const others = db.prepare(`SELECT * FROM invoices WHERE account_uuid IS ? AND id != ? AND status = 'ready' AND LOWER(TRIM(supplier)) = ?`).all(inv.account_uuid, inv.id, sup);
      let match = null; let reason = null;
      if (inv.invoice_number) {
        // "INV-00003379" and "3379" are the same number
        const norm = (n) => String(n).replace(/\D/g, '').replace(/^0+/, '') || String(n).toLowerCase().replace(/[^0-9a-z]/g, '');
        match = others.find((o) => o.invoice_number && norm(o.invoice_number) === norm(inv.invoice_number));
        if (match) reason = 'same supplier and invoice number';
      }
      if (!match && inv.total != null) {
        match = others.find((o) => o.total != null && Math.abs(o.total - inv.total) < 0.01 && (o.invoice_date || null) === (inv.invoice_date || null)
          && (!o.invoice_number || !inv.invoice_number));
        if (match) reason = 'same supplier, amount and date';
      }
      if (!match) return null;
      const jobs = repo.jobsOnInvoice(match.id).map((j) => ({ job_uuid: j.job_uuid, job_number: j.job_number }));
      return { id: match.id, invoice_number: match.invoice_number, reason, jobs, in_stock: !!match.kept_as_stock, in_inbox: !jobs.length && !match.kept_as_stock };
    },

    keepAsStock(invoiceId) {
      db.prepare('UPDATE invoices SET kept_as_stock = 1, suggested_job_uuid = NULL, suggestion_reason = NULL WHERE id = ?').run(invoiceId);
    },

    // ---------- reading it all back ----------

    /** Allocations of the given invoices, with job numbers, grouped by line. */
    _allocsByItem(invoiceIds) {
      const map = new Map();
      if (!invoiceIds.length) return map;
      const rows = db.prepare(`SELECT allocations.*, jobs.job_number, jobs.job_title FROM allocations
        JOIN items ON items.id = allocations.item_id LEFT JOIN jobs ON jobs.job_uuid = allocations.job_uuid
        WHERE items.invoice_id IN (${invoiceIds.map(Number).join(',')}) ORDER BY allocations.created_at, allocations.id`).all();
      for (const a of rows) (map.get(a.item_id) || map.set(a.item_id, []).get(a.item_id)).push(a);
      return map;
    },

    /** Where a line went: every job with a share, and what's left. */
    _trace(item, list, jobUUID) {
      const q = Number(item.quantity) > 0 ? Number(item.quantity) : null;
      const taken = list.reduce((s, a) => s + a.fraction, 0);
      return {
        quantity: q,
        jobs: list.map((a) => ({
          job_uuid: a.job_uuid, job_number: a.job_number, job_title: a.job_title, this_job: a.job_uuid === jobUUID,
          share: a.fraction, quantity: q ? round3(a.fraction * q) : null, amount: round2(a.fraction * item.cost),
        })),
        left: Math.max(0, 1 - taken),
        left_quantity: q ? round3(Math.max(0, 1 - taken) * q) : null,
        left_amount: round2(Math.max(0, 1 - taken) * item.cost),
      };
    },

    /** Everything the job card needs: this job's share of each invoice, and totals. */
    getJobSummary(jobUUID) {
      if (repo.isStockJob(jobUUID)) return repo.getStockSummary(jobUUID);
      const job = repo.getJob(jobUUID);
      // Invoices with a share on this job, plus uploads from this job still being read.
      const invoices = db.prepare(`SELECT * FROM invoices
          WHERE id IN (SELECT items.invoice_id FROM allocations JOIN items ON items.id = allocations.item_id WHERE allocations.job_uuid = ?)
             OR (origin_job_uuid = ? AND NOT EXISTS (SELECT 1 FROM items WHERE items.invoice_id = invoices.id))
          ORDER BY COALESCE(invoice_date, created_at) DESC, id DESC`).all(jobUUID, jobUUID);
      const ids = invoices.map((i) => i.id);
      const items = ids.length ? db.prepare(`SELECT * FROM items WHERE invoice_id IN (${ids.join(',')}) ORDER BY position, id`).all() : [];
      const allocs = repo._allocsByItem(ids);
      const itemsByInvoice = new Map(ids.map((id) => [id, []]));
      for (const it of items) itemsByInvoice.get(it.invoice_id).push(it);

      const totals = { total: 0, paid: 0, outstanding: 0, tax: 0, invoiceCount: 0, processing: 0, errors: 0, mistakes: 0 };
      const byReason = {};
      const bySupplier = {};
      const byCategory = {};
      const seen = new Map();

      const outInvoices = invoices.map((inv) => {
        const all = itemsByInvoice.get(inv.id) || [];
        const lines = [];
        const otherLines = [];
        for (const it of all) {
          const list = allocs.get(it.id) || [];
          const mine = list.find((a) => a.job_uuid === jobUUID);
          const trace = repo._trace(it, list, jobUUID);
          const base = { ...it, paid: !!it.paid, line_cost: it.cost, trace };
          if (mine) {
            lines.push({
              ...base, share: mine.fraction, share_quantity: trace.quantity ? round3(mine.fraction * trace.quantity) : null,
              cost: round2(it.cost * mine.fraction), category: mine.category || inv.category || 'materials',
              mistake_reason: mine.mistake_reason, mistake_at: mine.mistake_at,
            });
          } else otherLines.push(base);
        }
        const total = round2(lines.reduce((s, l) => s + l.cost, 0));
        const paid = round2(lines.filter((l) => l.paid).reduce((s, l) => s + l.cost, 0));
        let duplicateOf = null;
        if (inv.status === 'ready' && inv.invoice_number) {
          const key = `${(inv.supplier || '').toLowerCase()}|${inv.invoice_number.toLowerCase()}`;
          if (seen.has(key)) duplicateOf = seen.get(key); else seen.set(key, inv.id);
        }
        if (inv.status === 'processing') totals.processing++;
        if (inv.status === 'error') totals.errors++;
        if (inv.status === 'ready' && !duplicateOf && lines.length) {
          totals.invoiceCount++;
          totals.total += total;
          totals.paid += paid;
          const ex = exGst(inv.total, inv.tax);
          totals.tax += ex ? (Number(inv.tax) || 0) * (total / ex) : 0;
          const s = inv.supplier || 'Unknown supplier';
          bySupplier[s] = bySupplier[s] || { total: 0, paid: 0 };
          bySupplier[s].total += total;
          bySupplier[s].paid += paid;
          for (const l of lines) {
            if (l.mistake_reason) {
              totals.mistakes += l.cost;
              byReason[l.mistake_reason] = byReason[l.mistake_reason] || { total: 0, paid: 0, count: 0 };
              byReason[l.mistake_reason].total += l.cost;
              byReason[l.mistake_reason].count++;
              if (l.paid) byReason[l.mistake_reason].paid += l.cost;
            }
            byCategory[l.category] = byCategory[l.category] || { total: 0, paid: 0 };
            byCategory[l.category].total += l.cost;
            if (l.paid) byCategory[l.category].paid += l.cost;
          }
        }
        const cats = [...new Set(lines.map((l) => l.category))];
        return {
          ...inv,
          in_diary: !!((inv.sm8_attachment_uuid || inv.sm8_note_uuid) && !inv.sm8_missing),
          diary_missing: !!inv.sm8_missing,
          total_ex: exGst(inv.total, inv.tax),
          refs: parseJson(inv.refs, []),
          items: lines,
          other_lines: otherLines,
          job_total: total,
          whole: all.length > 0 && lines.length === all.length && lines.every((l) => l.share >= 1 - EPS),
          from_stock: lines.some((l) => l.share < 1 - EPS || l.trace.jobs.length > 1),
          category: cats.length === 1 ? cats[0] : (cats.length ? 'mixed' : inv.category),
          other_jobs: [...new Map(all.flatMap((it) => (allocs.get(it.id) || []).filter((a) => a.job_uuid !== jobUUID))
            .map((a) => [a.job_uuid, { job_number: a.job_number, job_title: a.job_title }])).values()],
          paid_amount: paid,
          outstanding: round2(total - paid),
          mistake_amount: round2(lines.filter((l) => l.mistake_reason).reduce((s, l) => s + l.cost, 0)),
          mistake_state: !lines.length || !lines.some((l) => l.mistake_reason) ? 'none' : lines.every((l) => l.mistake_reason) ? 'all' : 'part',
          // Paid is about the supplier's bill, so it looks at every line of the invoice.
          payment_state: !all.length ? 'unpaid' : all.every((l) => l.paid) ? 'paid' : all.some((l) => l.paid) ? 'part' : 'unpaid',
          duplicate_of: duplicateOf,
        };
      });

      totals.total = round2(totals.total);
      totals.paid = round2(totals.paid);
      totals.tax = round2(totals.tax);
      totals.outstanding = round2(totals.total - totals.paid);
      const roundMap = (m) => Object.entries(m)
        .map(([name, v]) => ({ name, total: round2(v.total), paid: round2(v.paid), outstanding: round2(v.total - v.paid), ...(v.count != null ? { count: v.count } : {}) }))
        .sort((a, b) => b.total - a.total);

      const quote = job && job.quote_amount != null ? job.quote_amount : null;
      totals.quote = quote;
      totals.margin = quote != null ? round2(quote - totals.total) : null;
      totals.marginPct = quote ? Math.round((quote - totals.total) / quote * 1000) / 10 : null;
      // "Should have cost": the same job done again without the screw-ups.
      totals.mistakes = round2(totals.mistakes);
      totals.cleanTotal = round2(totals.total - totals.mistakes);
      totals.mistakePct = totals.total ? Math.round(totals.mistakes / totals.total * 1000) / 10 : 0;
      totals.cleanMargin = quote != null ? round2(quote - totals.cleanTotal) : null;
      totals.cleanMarginPct = quote ? Math.round((quote - totals.cleanTotal) / quote * 1000) / 10 : null;

      return { job, totals, invoices: outInvoices, bySupplier: roundMap(bySupplier), byCategory: roundMap(byCategory), byReason: roundMap(byReason), suggestions: repo._suggestionsFor(jobUUID) };
    },

    _suggestionsFor(jobUUID) {
      return db.prepare(`SELECT * FROM invoices WHERE suggested_job_uuid = ? AND status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM allocations JOIN items ON items.id = allocations.item_id WHERE items.invoice_id = invoices.id)
          ORDER BY id DESC`).all(jobUUID)
        .map((i) => ({ id: i.id, supplier: i.supplier, invoice_number: i.invoice_number, invoice_date: i.invoice_date, total: i.total,
          total_ex: exGst(i.total, i.tax), category: i.category, reason: i.suggestion_reason }));
    },

    /** A stock order job: what was bought on it, which jobs took it, and what's left. */
    getStockSummary(jobUUID) {
      const job = repo.getJob(jobUUID);
      const invoices = db.prepare(`SELECT * FROM invoices WHERE stock_job_uuid = ?
          OR (origin_job_uuid = ? AND NOT EXISTS (SELECT 1 FROM items WHERE items.invoice_id = invoices.id))
          ORDER BY COALESCE(invoice_date, created_at) DESC, id DESC`).all(jobUUID, jobUUID);
      const ids = invoices.map((i) => i.id);
      const items = ids.length ? db.prepare(`SELECT * FROM items WHERE invoice_id IN (${ids.join(',')}) ORDER BY position, id`).all() : [];
      const allocs = repo._allocsByItem(ids);
      const totals = { bought: 0, used: 0, left: 0, paid: 0, outstanding: 0, invoiceCount: 0, processing: 0, errors: 0, jobs: new Set() };
      const out = invoices.map((inv) => {
        const lines = items.filter((it) => it.invoice_id === inv.id).map((it) => {
          const trace = repo._trace(it, allocs.get(it.id) || [], jobUUID);
          for (const j of trace.jobs) totals.jobs.add(j.job_uuid);
          return { ...it, paid: !!it.paid, line_cost: it.cost, cost: it.cost, trace };
        });
        const used = round2(lines.reduce((s, l) => s + l.trace.jobs.reduce((t, j) => t + j.amount, 0), 0));
        const left = round2(lines.reduce((s, l) => s + l.trace.left_amount, 0));
        const paid = lines.length > 0 && lines.every((l) => l.paid);
        if (inv.status === 'processing') totals.processing++;
        if (inv.status === 'error') totals.errors++;
        if (inv.status === 'ready') {
          totals.invoiceCount++;
          const ex = round2(lines.reduce((s, l) => s + l.line_cost, 0));
          totals.bought += ex;
          totals.used += used;
          totals.left += left;
          if (paid) totals.paid += ex;
        }
        return {
          ...inv, refs: parseJson(inv.refs, []), items: lines, other_lines: [], other_jobs: [], job_total: round2(lines.reduce((s, l) => s + l.line_cost, 0)),
          total_ex: exGst(inv.total, inv.tax),
          used, left, whole: false, from_stock: false, category: inv.category || 'materials', mistake_state: 'none', duplicate_of: null,
          payment_state: !lines.length ? 'unpaid' : paid ? 'paid' : lines.some((l) => l.paid) ? 'part' : 'unpaid',
        };
      });
      for (const k of ['bought', 'used', 'left', 'paid']) totals[k] = round2(totals[k]);
      totals.outstanding = round2(totals.bought - totals.paid);
      totals.jobs = totals.jobs.size;
      return { job, stock: true, totals, invoices: out, byCategory: [], byReason: [], bySupplier: [], suggestions: repo._suggestionsFor(jobUUID) };
    },

    /**
     * What can still be added to a job: invoices nothing has been assigned from yet
     * ("whole"), and lines with something left (e.g. 4 of 10 motors).
     */
    getUnassigned(accountUUID, jobUUID = null) {
      const invoices = db.prepare(`SELECT * FROM invoices WHERE account_uuid IS ? AND status = 'ready'
        ORDER BY COALESCE(invoice_date, created_at) DESC, id DESC`).all(accountUUID);
      const ids = invoices.map((i) => i.id);
      const items = ids.length ? db.prepare(`SELECT * FROM items WHERE invoice_id IN (${ids.join(',')}) ORDER BY position, id`).all() : [];
      const allocs = repo._allocsByItem(ids);
      const byInv = new Map(ids.map((id) => [id, []]));
      for (const it of items) byInv.get(it.invoice_id).push(it);
      const jobsById = new Map(db.prepare('SELECT job_uuid, job_number, job_title, COALESCE(stock_manual, stock_auto) AS is_stock FROM jobs WHERE account_uuid IS ?').all(accountUUID).map((j) => [j.job_uuid, j]));
      const firstSeen = new Map();
      const out = [];
      for (const inv of invoices.slice().reverse()) {
        const key = inv.invoice_number ? `${(inv.supplier || '').toLowerCase()}|${inv.invoice_number.toLowerCase()}` : null;
        if (key && !firstSeen.has(key)) firstSeen.set(key, inv.id);
      }
      for (const inv of invoices) {
        const lines = (byInv.get(inv.id) || []).map((it) => ({ ...it, trace: repo._trace(it, allocs.get(it.id) || [], jobUUID) }));
        const left = lines.filter((l) => l.trace.left > EPS);
        if (!left.length) continue;
        const untouched = lines.every((l) => !l.trace.jobs.length);
        const key = inv.invoice_number ? `${(inv.supplier || '').toLowerCase()}|${inv.invoice_number.toLowerCase()}` : null;
        const dupOf = key && firstSeen.get(key) !== inv.id ? firstSeen.get(key) : null;
        const sj = inv.suggested_job_uuid ? jobsById.get(inv.suggested_job_uuid) : null;
        out.push({
          id: inv.id, supplier: inv.supplier, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, total: inv.total,
          total_ex: exGst(inv.total, inv.tax), category: inv.category, source: inv.source, file_path: inv.file_path, mime_type: inv.mime_type, email_from: inv.email_from, email_subject: inv.email_subject,
          untouched, kept_as_stock: !!inv.kept_as_stock, duplicate_of: dupOf, possible_duplicate: untouched ? repo.possibleDuplicate(inv) : null,
          stock_job: inv.stock_job_uuid && jobsById.get(inv.stock_job_uuid)
            ? { job_uuid: inv.stock_job_uuid, job_number: jobsById.get(inv.stock_job_uuid).job_number } : null,
          left_amount: round2(left.reduce((s, l) => s + l.trace.left_amount, 0)),
          suggestion: sj && untouched ? { job_uuid: sj.job_uuid, job_number: sj.job_number, job_title: sj.job_title, reason: inv.suggestion_reason, is_stock: !!sj.is_stock } : null,
          // No job found, but it reads like a restock order: suggest stock.
          looks_like_stock: !sj && untouched && !inv.kept_as_stock && inv.purchase_kind === 'stock',
          lines: left.map((l) => ({
            item_id: l.id, description: l.description, unit: l.unit, quantity: l.trace.quantity, cost: l.cost,
            unit_cost: l.trace.quantity ? round2(l.cost / l.trace.quantity) : null, trace: l.trace,
          })),
        });
      }
      // Invoices that need a decision also include those still being read or that failed.
      const pending = db.prepare(`SELECT id, supplier, file_name, status, error, source, email_from, email_subject FROM invoices
        WHERE account_uuid IS ? AND status != 'ready' AND origin_job_uuid IS NULL ORDER BY id DESC`).all(accountUUID);
      return { invoices: out, pending };
    },

    /** Count for the Inbox badge: invoices waiting for a decision. */
    inboxCount(accountUUID) {
      const u = repo.getUnassigned(accountUUID);
      return u.invoices.filter((i) => i.untouched && !i.kept_as_stock).length + u.pending.length;
    },

    /**
     * Totals across every job of a ServiceM8 account, for the reports page.
     * from/to (YYYY-MM-DD) filter jobs by the date of their first invoice.
     */
    getReport(accountUUID, { from = null, to = null } = {}) {
      const firstDate = (s) => s.invoices.filter((i) => i.status === 'ready').map((i) => i.invoice_date || String(i.created_at).slice(0, 10)).sort()[0] || null;
      const jobs = db.prepare(`SELECT jobs.* FROM jobs WHERE jobs.account_uuid IS ? AND COALESCE(stock_manual, stock_auto) = 0 AND
            EXISTS (SELECT 1 FROM allocations WHERE allocations.job_uuid = jobs.job_uuid)`).all(accountUUID)
        .map((j) => ({ ...j, summary: repo.getJobSummary(j.job_uuid) }))
        .map((j) => ({ ...j, first_date: firstDate(j.summary) }))
        .filter((j) => j.first_date && (!from || j.first_date >= from) && (!to || j.first_date <= to))
        .sort((a, b) => String(b.first_date).localeCompare(String(a.first_date)));

      const t = { jobs: 0, total: 0, mistakes: 0, quoted: 0, quotedJobs: 0, costsOnQuoted: 0, mistakesOnQuoted: 0 };
      const reasons = {};
      const suppliers = {};
      const jobRows = [];
      const mistakeItems = [];
      for (const j of jobs) {
        const s = j.summary;
        if (!s.totals.invoiceCount) continue;
        t.jobs++;
        t.total += s.totals.total;
        t.mistakes += s.totals.mistakes;
        if (s.totals.quote != null) {
          t.quotedJobs++;
          t.quoted += s.totals.quote;
          t.costsOnQuoted += s.totals.total;
          t.mistakesOnQuoted += s.totals.mistakes;
        }
        jobRows.push({
          job_uuid: j.job_uuid, job_number: j.job_number, job_title: j.job_title, date: j.first_date,
          quote: s.totals.quote, total: s.totals.total, mistakes: s.totals.mistakes, mistakePct: s.totals.mistakePct,
          profit: s.totals.margin, profitPct: s.totals.marginPct, cleanProfit: s.totals.cleanMargin, cleanProfitPct: s.totals.cleanMarginPct,
        });
        for (const inv of s.invoices) {
          if (inv.status !== 'ready' || inv.duplicate_of) continue;
          for (const l of inv.items) {
            if (!l.mistake_reason || !l.cost) continue;
            reasons[l.mistake_reason] = reasons[l.mistake_reason] || { count: 0, total: 0, jobs: new Set() };
            reasons[l.mistake_reason].count++;
            reasons[l.mistake_reason].total += l.cost;
            reasons[l.mistake_reason].jobs.add(j.job_uuid);
            const sup = inv.supplier || 'Unknown supplier';
            suppliers[sup] = suppliers[sup] || { count: 0, total: 0 };
            suppliers[sup].count++;
            suppliers[sup].total += l.cost;
            mistakeItems.push({
              date: inv.invoice_date || String(inv.created_at).slice(0, 10), job_number: j.job_number, job_title: j.job_title,
              supplier: sup, invoice_number: inv.invoice_number, description: l.description, reason: l.mistake_reason, cost: l.cost, paid: l.paid,
            });
          }
        }
      }
      const notAssigned = repo.getUnassigned(accountUUID).invoices.filter((i) => !i.duplicate_of).reduce((s, i) => s + i.left_amount, 0);
      const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
      return {
        totals: {
          jobs: t.jobs,
          total: round2(t.total),
          mistakes: round2(t.mistakes),
          mistakePct: pct(t.mistakes, t.total),
          cleanTotal: round2(t.total - t.mistakes),
          quotedJobs: t.quotedJobs,
          quoted: round2(t.quoted),
          profit: t.quotedJobs ? round2(t.quoted - t.costsOnQuoted) : null,
          profitPct: pct(t.quoted - t.costsOnQuoted, t.quoted),
          cleanProfit: t.quotedJobs ? round2(t.quoted - t.costsOnQuoted + t.mistakesOnQuoted) : null,
          cleanProfitPct: pct(t.quoted - t.costsOnQuoted + t.mistakesOnQuoted, t.quoted),
          jobsWithMistakes: jobRows.filter((r) => r.mistakes > 0).length,
          notAssigned: round2(notAssigned),
        },
        byReason: Object.entries(reasons).map(([reason, v]) => ({ reason, count: v.count, jobs: v.jobs.size, total: round2(v.total), pct: pct(v.total, t.mistakes) }))
          .sort((a, b) => b.total - a.total),
        bySupplier: Object.entries(suppliers).map(([name, v]) => ({ name, count: v.count, total: round2(v.total) })).sort((a, b) => b.total - a.total),
        jobs: jobRows,
        mistakeItems: mistakeItems.sort((a, b) => String(b.date).localeCompare(String(a.date))),
      };
    },

    listStuckInvoices() {
      return db.prepare("SELECT * FROM invoices WHERE status = 'processing'").all();
    },
  };
  return repo;
}

module.exports = { openDb, allocateCosts, newInboxCode, round2, invoiceCategory, addressKey, mainJobNumber };
