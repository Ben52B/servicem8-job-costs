const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_uuid      TEXT PRIMARY KEY,
  account_uuid  TEXT,
  inbox_code    TEXT NOT NULL UNIQUE,
  job_number    TEXT,
  job_title     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_uuid        TEXT NOT NULL REFERENCES jobs(job_uuid),
  source          TEXT NOT NULL,            -- upload | email
  file_name       TEXT,
  file_path       TEXT,
  mime_type       TEXT,
  email_from      TEXT,
  email_subject   TEXT,
  status          TEXT NOT NULL DEFAULT 'processing', -- processing | ready | error
  error           TEXT,
  document_type   TEXT,
  supplier        TEXT,
  supplier_abn    TEXT,
  invoice_number  TEXT,
  invoice_date    TEXT,
  due_date        TEXT,
  currency        TEXT,
  subtotal        REAL,
  tax             REAL,
  total           REAL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Split invoices: which share of each line is charged to which job.
-- Only used when invoices.split = 1; otherwise every line belongs to the invoice's own job.
CREATE TABLE IF NOT EXISTS allocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  job_uuid        TEXT NOT NULL,
  fraction        REAL NOT NULL,          -- share of the line, 0..1 (e.g. 1 of 10 motors = 0.1)
  mistake_reason  TEXT,                   -- screw-up tag for this job's share
  mistake_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, job_uuid)
);
CREATE INDEX IF NOT EXISTS idx_alloc_job ON allocations(job_uuid);

CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_uuid);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON items(invoice_id);
`;

// Short, easy-to-type code used in each job's email address (no 0/o/1/l confusion).
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newInboxCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * One type for the whole invoice, from its main items. Delivery and fees ride along
 * with the goods they came with (a gate supplier's delivery counts as Materials);
 * they only count as their own type when that's all the invoice is.
 */
function invoiceCategory(items) {
  const sums = {};
  for (const it of items) sums[it.category || 'other'] = (sums[it.category || 'other'] || 0) + Math.abs(Number(it.line_total) || 0);
  const main = Object.entries(sums).filter(([c]) => c !== 'freight' && c !== 'fees' && c !== 'other');
  const pick = (main.length ? main : Object.entries(sums)).sort((a, b) => b[1] - a[1])[0];
  return pick ? pick[0] : 'materials';
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
  // Put any rounding difference on the largest line so the sum matches exactly.
  const diff = round2(invoiceTotal - costs.reduce((s, c) => s + c, 0));
  if (diff !== 0 && costs.length) {
    let idx = 0;
    costs.forEach((c, i) => { if (Math.abs(c) > Math.abs(costs[idx])) idx = i; });
    costs[idx] = round2(costs[idx] + diff);
  }
  return costs;
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'jobcosts.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return createRepo(db, dataDir);
}

/** Add columns introduced after the first release to existing databases. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  if (!cols.includes('quote_amount')) db.exec('ALTER TABLE jobs ADD COLUMN quote_amount REAL');
  // 'servicem8' = taken from the job in ServiceM8, 'manual' = typed in on the card (never overwritten)
  if (!cols.includes('quote_source')) db.exec('ALTER TABLE jobs ADD COLUMN quote_source TEXT');
  const itemCols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  // Screw-up tag: a reason code from src/mistakes.js, or NULL when the line is not a mistake.
  if (!itemCols.includes('mistake_reason')) db.exec('ALTER TABLE items ADD COLUMN mistake_reason TEXT');
  if (!itemCols.includes('mistake_at')) db.exec('ALTER TABLE items ADD COLUMN mistake_at TEXT');
  const invCols = db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name);
  if (!invCols.includes('split')) db.exec('ALTER TABLE invoices ADD COLUMN split INTEGER NOT NULL DEFAULT 0');
  if (!invCols.includes('attached_later')) db.exec('ALTER TABLE invoices ADD COLUMN attached_later INTEGER NOT NULL DEFAULT 0');
  if (!invCols.includes('category')) {
    // One type per invoice (Materials, Subcontractor…); category_manual = 1 when changed by hand.
    db.exec('ALTER TABLE invoices ADD COLUMN category TEXT');
    db.exec('ALTER TABLE invoices ADD COLUMN category_manual INTEGER NOT NULL DEFAULT 0');
    const upd = db.prepare('UPDATE invoices SET category = ? WHERE id = ?');
    for (const inv of db.prepare("SELECT id FROM invoices WHERE status = 'ready'").all()) {
      upd.run(invoiceCategory(db.prepare('SELECT category, line_total FROM items WHERE invoice_id = ?').all(inv.id)), inv.id);
    }
  }
}

function createRepo(db, dataDir) {
  const repo = {
    db,
    filesDir: path.join(dataDir, 'files'),

    ensureJob({ jobUUID, accountUUID = null, jobNumber = null, jobTitle = null, quoteAmount = null }) {
      let job = db.prepare('SELECT * FROM jobs WHERE job_uuid = ?').get(jobUUID);
      if (!job) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            db.prepare('INSERT INTO jobs (job_uuid, account_uuid, inbox_code, job_number, job_title) VALUES (?, ?, ?, ?, ?)')
              .run(jobUUID, accountUUID, newInboxCode(), jobNumber, jobTitle);
            break;
          } catch (e) {
            if (!String(e.message).includes('UNIQUE') || attempt === 4) throw e;
          }
        }
      } else if (jobNumber || jobTitle || accountUUID) {
        db.prepare(`UPDATE jobs SET
            job_number = COALESCE(?, job_number),
            job_title = COALESCE(?, job_title),
            account_uuid = COALESCE(?, account_uuid)
          WHERE job_uuid = ?`).run(jobNumber, jobTitle, accountUUID, jobUUID);
      }
      if (quoteAmount != null && isFinite(quoteAmount)) {
        db.prepare(`UPDATE jobs SET quote_amount = ?, quote_source = 'servicem8'
          WHERE job_uuid = ? AND COALESCE(quote_source, '') != 'manual'`).run(round2(quoteAmount), jobUUID);
      }
      return db.prepare('SELECT * FROM jobs WHERE job_uuid = ?').get(jobUUID);
    },

    /** Quoted price typed on the card. null clears it so ServiceM8's value is used again. */
    setQuote(jobUUID, amount) {
      if (amount == null) db.prepare('UPDATE jobs SET quote_amount = NULL, quote_source = NULL WHERE job_uuid = ?').run(jobUUID);
      else db.prepare("UPDATE jobs SET quote_amount = ?, quote_source = 'manual' WHERE job_uuid = ?").run(round2(amount), jobUUID);
    },

    getJob(jobUUID) {
      return db.prepare('SELECT * FROM jobs WHERE job_uuid = ?').get(jobUUID);
    },

    getJobByInboxCode(code) {
      return db.prepare('SELECT * FROM jobs WHERE inbox_code = ?').get(String(code).toLowerCase());
    },

    createInvoice(fields) {
      const r = db.prepare(`INSERT INTO invoices
        (job_uuid, source, file_name, file_path, mime_type, email_from, email_subject, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`).run(
        fields.jobUUID, fields.source, fields.fileName || null, fields.filePath || null,
        fields.mimeType || null, fields.emailFrom || null, fields.emailSubject || null,
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
          attached_later = 1 WHERE id = ?`).run(fileName, filePath, mimeType, id);
    },

    /** Save what Claude read from the document, replacing any earlier result. */
    saveExtraction(id, x) {
      const items = (x.items || []).filter((it) => it && it.description);
      if (!items.length && x.total != null) {
        items.push({ description: x.supplier_name ? `Invoice from ${x.supplier_name}` : 'Invoice total', category: 'other', line_total: x.total });
      }
      const total = x.total != null ? x.total : items.reduce((s, it) => s + (Number(it.line_total) || 0), 0);
      const costs = allocateCosts(items, total);
      const alreadyPaid = x.payment_status === 'paid';

      // Keep ticks and screw-up tags from an earlier reading of the same lines.
      const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const oldItems = db.prepare('SELECT * FROM items WHERE invoice_id = ?').all(id);
      const before = new Map(oldItems.map((o) => [norm(o.description), o]));
      // Settings made for the whole invoice carry over even if the lines are different now
      // (e.g. a hand-entered invoice gets its real file).
      const wasAllPaid = oldItems.length > 0 && oldItems.every((o) => o.paid);
      const oldReasons = [...new Set(oldItems.map((o) => o.mistake_reason))];
      const wholeReason = oldItems.length > 0 && oldReasons.length === 1 && oldReasons[0] ? oldReasons[0] : null;
      const wholeReasonAt = wholeReason ? oldItems[0].mistake_at : null;
      const oldAllocs = db.prepare(`SELECT allocations.*, items.description FROM allocations
        JOIN items ON items.id = allocations.item_id WHERE items.invoice_id = ?`).all(id);

      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE invoices SET status = 'ready', error = NULL,
            document_type = ?, supplier = ?, supplier_abn = ?, invoice_number = ?, invoice_date = ?,
            due_date = ?, currency = ?, subtotal = ?, tax = ?, total = ?, notes = ?,
            category = CASE WHEN category_manual = 1 THEN category ELSE ? END
          WHERE id = ?`).run(
          x.document_type || null, x.supplier_name || null, x.supplier_abn || null, x.invoice_number || null,
          x.invoice_date || null, x.due_date || null, x.currency || null,
          x.subtotal ?? null, x.tax ?? null, round2(total), x.notes || null, invoiceCategory(items), id,
        );
        db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(id);
        db.prepare('DELETE FROM items WHERE invoice_id = ?').run(id);
        const ins = db.prepare(`INSERT INTO items
          (invoice_id, position, description, category, quantity, unit, unit_price, line_total, cost, paid, paid_at, mistake_reason, mistake_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();
        items.forEach((it, i) => {
          const old = before.get(norm(it.description));
          const paid = alreadyPaid || wasAllPaid || !!(old && old.paid);
          ins.run(id, i, String(it.description).slice(0, 500), it.category || 'other',
            it.quantity ?? null, it.unit || null, it.unit_price ?? null, round2(it.line_total), costs[i],
            paid ? 1 : 0, paid ? (old?.paid_at || oldItems[0]?.paid_at || now) : null,
            old?.mistake_reason || wholeReason, old?.mistake_at || wholeReasonAt);
        });
        // Job shares follow their line (matched by description).
        if (oldAllocs.length) {
          const newIds = new Map(db.prepare('SELECT id, description FROM items WHERE invoice_id = ?').all(id).map((r) => [norm(r.description), r.id]));
          const insA = db.prepare('INSERT OR IGNORE INTO allocations (item_id, job_uuid, fraction, mistake_reason, mistake_at) VALUES (?, ?, ?, ?, ?)');
          for (const a of oldAllocs) {
            const itemId = newIds.get(norm(a.description));
            if (itemId) insA.run(itemId, a.job_uuid, a.fraction, a.mistake_reason, a.mistake_at);
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return repo.getInvoice(id);
    },

    deleteInvoice(id) {
      const inv = repo.getInvoice(id);
      if (!inv) return;
      db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(id);
      db.prepare('DELETE FROM items WHERE invoice_id = ?').run(id);
      db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
      if (inv.file_path) fs.rm(path.join(repo.filesDir, inv.file_path), { force: true }, () => {});
    },

    getItem(id) {
      return db.prepare('SELECT items.*, invoices.job_uuid FROM items JOIN invoices ON invoices.id = items.invoice_id WHERE items.id = ?').get(id);
    },

    setItemPaid(id, paid) {
      db.prepare('UPDATE items SET paid = ?, paid_at = ? WHERE id = ?')
        .run(paid ? 1 : 0, paid ? new Date().toISOString() : null, id);
    },

    setInvoicePaid(id, paid) {
      db.prepare('UPDATE items SET paid = ?, paid_at = ? WHERE invoice_id = ?')
        .run(paid ? 1 : 0, paid ? new Date().toISOString() : null, id);
    },

    // ----- Split invoices -----

    /** Jobs other than the invoice's own job that have a share of it. */
    otherJobsOnInvoice(invoiceId) {
      return db.prepare(`SELECT DISTINCT jobs.job_uuid, jobs.job_number, jobs.job_title FROM allocations
        JOIN items ON items.id = allocations.item_id JOIN invoices ON invoices.id = items.invoice_id
        LEFT JOIN jobs ON jobs.job_uuid = allocations.job_uuid
        WHERE items.invoice_id = ? AND allocations.job_uuid != invoices.job_uuid`).all(invoiceId);
    },

    /**
     * Turn splitting on: the invoice's own job starts with all of every line (so nothing
     * changes until you reduce it). Turning it off gives everything back to the own job,
     * which is only allowed when no other job has a share.
     */
    setSplit(invoiceId, on) {
      const inv = repo.getInvoice(invoiceId);
      if (!inv) return;
      db.exec('BEGIN');
      try {
        if (on && !inv.split) {
          db.prepare(`INSERT OR IGNORE INTO allocations (item_id, job_uuid, fraction, mistake_reason, mistake_at)
            SELECT id, ?, 1, mistake_reason, mistake_at FROM items WHERE invoice_id = ?`).run(inv.job_uuid, invoiceId);
          db.prepare('UPDATE invoices SET split = 1 WHERE id = ?').run(invoiceId);
        } else if (!on && inv.split) {
          if (repo.otherJobsOnInvoice(invoiceId).length) throw Object.assign(new Error('Other jobs have part of this invoice'), { status: 409 });
          // The own job's screw-up tags go back onto the lines.
          db.prepare(`UPDATE items SET mistake_reason = (SELECT mistake_reason FROM allocations a WHERE a.item_id = items.id AND a.job_uuid = ?),
              mistake_at = (SELECT mistake_at FROM allocations a WHERE a.item_id = items.id AND a.job_uuid = ?)
            WHERE invoice_id = ?`).run(inv.job_uuid, inv.job_uuid, invoiceId);
          db.prepare('DELETE FROM allocations WHERE item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(invoiceId);
          db.prepare('UPDATE invoices SET split = 0 WHERE id = ?').run(invoiceId);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    /**
     * Set how much of a line a job gets (fraction 0..1). 0 removes the job's share.
     * Fails if the jobs together would get more than the whole line.
     */
    setShare(itemId, jobUUID, fraction) {
      const others = db.prepare('SELECT COALESCE(SUM(fraction), 0) AS f FROM allocations WHERE item_id = ? AND job_uuid != ?').get(itemId, jobUUID).f;
      if (fraction < 0) throw Object.assign(new Error('Amount cannot be negative'), { status: 400 });
      if (fraction + others > 1 + 1e-6) {
        throw Object.assign(new Error('That is more than is left on this line'), { status: 400, left: Math.max(0, 1 - others) });
      }
      if (fraction <= 1e-9) db.prepare('DELETE FROM allocations WHERE item_id = ? AND job_uuid = ?').run(itemId, jobUUID);
      else {
        db.prepare(`INSERT INTO allocations (item_id, job_uuid, fraction) VALUES (?, ?, ?)
          ON CONFLICT (item_id, job_uuid) DO UPDATE SET fraction = excluded.fraction`).run(itemId, jobUUID, Math.min(1, fraction));
      }
    },

    getShare(itemId, jobUUID) {
      return db.prepare('SELECT * FROM allocations WHERE item_id = ? AND job_uuid = ?').get(itemId, jobUUID);
    },

    /** A job gives back everything it took from an invoice that belongs to another job. */
    giveBack(invoiceId, jobUUID) {
      db.prepare('DELETE FROM allocations WHERE job_uuid = ? AND item_id IN (SELECT id FROM items WHERE invoice_id = ?)').run(jobUUID, invoiceId);
    },

    setShareMistake(itemId, jobUUID, reason) {
      db.prepare('UPDATE allocations SET mistake_reason = ?, mistake_at = ? WHERE item_id = ? AND job_uuid = ?')
        .run(reason || null, reason ? new Date().toISOString() : null, itemId, jobUUID);
    },

    setInvoiceShareMistake(invoiceId, jobUUID, reason) {
      db.prepare(`UPDATE allocations SET mistake_reason = ?, mistake_at = ?
        WHERE job_uuid = ? AND item_id IN (SELECT id FROM items WHERE invoice_id = ?)`)
        .run(reason || null, reason ? new Date().toISOString() : null, jobUUID, invoiceId);
    },

    /** Is this invoice's own job in the given ServiceM8 account? */
    invoiceAccount(invoiceId) {
      return db.prepare('SELECT jobs.account_uuid FROM invoices JOIN jobs ON jobs.job_uuid = invoices.job_uuid WHERE invoices.id = ?').get(invoiceId)?.account_uuid ?? null;
    },

    /** Lines of split invoices (same account) that still have something left to take. */
    getAvailable(accountUUID, jobUUID) {
      const rows = db.prepare(`SELECT items.*, invoices.supplier, invoices.invoice_number, invoices.invoice_date, invoices.job_uuid AS home_job,
            jobs.job_number AS home_job_number, jobs.job_title AS home_job_title,
            COALESCE((SELECT SUM(fraction) FROM allocations a WHERE a.item_id = items.id), 0) AS taken,
            COALESCE((SELECT fraction FROM allocations a WHERE a.item_id = items.id AND a.job_uuid = ?), 0) AS mine
          FROM items JOIN invoices ON invoices.id = items.invoice_id JOIN jobs ON jobs.job_uuid = invoices.job_uuid
          WHERE invoices.split = 1 AND invoices.status = 'ready' AND jobs.account_uuid IS ?
          ORDER BY COALESCE(invoices.invoice_date, invoices.created_at) DESC, invoices.id DESC, items.position`).all(jobUUID, accountUUID);
      const out = new Map();
      for (const r of rows) {
        const left = Math.max(0, 1 - r.taken);
        if (left < 1e-6) continue;
        if (!out.has(r.invoice_id)) {
          out.set(r.invoice_id, {
            invoice_id: r.invoice_id, supplier: r.supplier, invoice_number: r.invoice_number, invoice_date: r.invoice_date,
            home_job: r.home_job, home_job_number: r.home_job_number, home_job_title: r.home_job_title, lines: [],
          });
        }
        const q = Number(r.quantity) > 0 ? Number(r.quantity) : null;
        out.get(r.invoice_id).lines.push({
          item_id: r.id, description: r.description, unit: r.unit, quantity: q, cost: r.cost,
          unit_cost: q ? round2(r.cost / q) : null,
          left_fraction: left, left_quantity: q ? Math.round(left * q * 1000) / 1000 : null, left_amount: round2(left * r.cost),
          mine_fraction: r.mine,
        });
      }
      return [...out.values()];
    },

    /** Tag a line as a screw-up (reason code) or clear it (null). */
    setItemMistake(id, reason) {
      db.prepare('UPDATE items SET mistake_reason = ?, mistake_at = ? WHERE id = ?')
        .run(reason || null, reason ? new Date().toISOString() : null, id);
    },

    setInvoiceMistake(id, reason) {
      db.prepare('UPDATE items SET mistake_reason = ?, mistake_at = ? WHERE invoice_id = ?')
        .run(reason || null, reason ? new Date().toISOString() : null, id);
    },

    /** Manual correction of a line; re-spreads the invoice total over the lines. */
    updateItem(id, { description, category, line_total }) {
      const item = repo.getItem(id);
      if (!item) return;
      db.prepare(`UPDATE items SET description = COALESCE(?, description), category = COALESCE(?, category),
          line_total = COALESCE(?, line_total) WHERE id = ?`)
        .run(description ?? null, category ?? null, line_total == null ? null : round2(line_total), id);
      repo.reallocate(item.invoice_id);
    },

    /** Manual correction of the header fields of an invoice. */
    /** Change the invoice's type by hand; kept when the invoice is read again. */
    setInvoiceCategory(id, category) {
      db.prepare('UPDATE invoices SET category = ?, category_manual = 1 WHERE id = ?').run(category, id);
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
      const costs = allocateCosts(items, inv.total);
      const upd = db.prepare('UPDATE items SET cost = ? WHERE id = ?');
      items.forEach((it, i) => upd.run(costs[i], it.id));
    },

    /** Everything the job card needs: invoices, their lines, and totals. */
    getJobSummary(jobUUID) {
      const job = repo.getJob(jobUUID);
      // This job's own invoices, plus split invoices of other jobs that this job took a share of.
      const invoices = db.prepare(`SELECT invoices.*, jobs.job_number AS home_job_number, jobs.job_title AS home_job_title
          FROM invoices LEFT JOIN jobs ON jobs.job_uuid = invoices.job_uuid
          WHERE invoices.job_uuid = ? OR (invoices.split = 1 AND invoices.id IN (
            SELECT items.invoice_id FROM allocations JOIN items ON items.id = allocations.item_id WHERE allocations.job_uuid = ?))
          ORDER BY COALESCE(invoices.invoice_date, invoices.created_at) DESC, invoices.id DESC`).all(jobUUID, jobUUID);
      const ids = invoices.map((i) => i.id);
      const inList = ids.length ? ids.join(',') : '0';
      const items = db.prepare(`SELECT * FROM items WHERE invoice_id IN (${inList}) ORDER BY position, id`).all();
      const allocs = db.prepare(`SELECT allocations.*, jobs.job_number, jobs.job_title FROM allocations
          JOIN items ON items.id = allocations.item_id LEFT JOIN jobs ON jobs.job_uuid = allocations.job_uuid
          WHERE items.invoice_id IN (${inList})`).all();
      const allocsByItem = new Map();
      for (const a of allocs) (allocsByItem.get(a.item_id) || allocsByItem.set(a.item_id, []).get(a.item_id)).push(a);
      const splitIds = new Set(invoices.filter((i) => i.split).map((i) => i.id));

      // Each line: `cost` is what THIS job is charged; `line_cost` is the whole line.
      const byInvoice = new Map(invoices.map((inv) => [inv.id, []]));
      for (const it of items) {
        const line = { ...it, paid: !!it.paid, line_cost: it.cost };
        if (splitIds.has(it.invoice_id)) {
          const list = allocsByItem.get(it.id) || [];
          const mine = list.find((a) => a.job_uuid === jobUUID);
          const q = Number(it.quantity) > 0 ? Number(it.quantity) : null;
          line.share = mine ? mine.fraction : 0;
          line.share_quantity = q ? Math.round(line.share * q * 1000) / 1000 : null;
          line.left = Math.max(0, 1 - list.reduce((sum, a) => sum + a.fraction, 0));
          line.left_quantity = q ? Math.round(line.left * q * 1000) / 1000 : null;
          line.others = list.filter((a) => a.job_uuid !== jobUUID).map((a) => ({
            job_number: a.job_number, job_title: a.job_title, share: a.fraction, quantity: q ? Math.round(a.fraction * q * 1000) / 1000 : null,
          }));
          line.cost = round2(it.cost * line.share);
          line.mistake_reason = mine ? mine.mistake_reason : null;
          line.mistake_at = mine ? mine.mistake_at : null;
        }
        byInvoice.get(it.invoice_id)?.push(line);
      }

      const totals = { total: 0, paid: 0, outstanding: 0, tax: 0, invoiceCount: 0, processing: 0, errors: 0, mistakes: 0 };
      const byReason = {};
      const bySupplier = {};
      const byCategory = {};
      const seen = new Map();

      const outInvoices = invoices.map((inv) => {
        const allLines = byInvoice.get(inv.id) || [];
        const foreign = inv.job_uuid !== jobUUID;
        // On another job's invoice, only the lines this job took are shown.
        const lines = foreign ? allLines.filter((l) => l.share > 0) : allLines;
        const paid = round2(lines.filter((l) => l.paid).reduce((s, l) => s + l.cost, 0));
        const total = inv.split ? round2(lines.reduce((s, l) => s + l.cost, 0)) : round2(inv.total || 0);
        const shareOfInvoice = inv.total ? total / inv.total : 0;
        let duplicateOf = null;
        if (!foreign && inv.status === 'ready' && inv.invoice_number) {
          const key = `${(inv.supplier || '').toLowerCase()}|${inv.invoice_number.toLowerCase()}`;
          if (seen.has(key)) duplicateOf = seen.get(key); else seen.set(key, inv.id);
        }
        if (inv.status === 'processing') totals.processing++;
        if (inv.status === 'error') totals.errors++;
        if (inv.status === 'ready' && !duplicateOf) {
          totals.invoiceCount++;
          totals.total += total;
          totals.paid += paid;
          totals.tax += (Number(inv.tax) || 0) * (inv.split ? shareOfInvoice : 1);
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
            const cat = inv.category || 'materials';
            byCategory[cat] = byCategory[cat] || { total: 0, paid: 0 };
            byCategory[cat].total += l.cost;
            if (l.paid) byCategory[cat].paid += l.cost;
          }
        }
        const charged = lines.filter((l) => l.cost !== 0 || !inv.split);
        return {
          ...inv,
          items: lines,
          job_total: total,
          foreign,
          not_assigned: inv.split ? round2(allLines.reduce((s, l) => s + l.line_cost * l.left, 0)) : 0,
          other_jobs: inv.split ? [...new Map(allLines.flatMap((l) => l.others).map((o) => [o.job_number, o])).values()].map((o) => ({ job_number: o.job_number, job_title: o.job_title })) : [],
          paid_amount: paid,
          outstanding: round2(total - paid),
          mistake_amount: round2(lines.filter((l) => l.mistake_reason).reduce((s, l) => s + l.cost, 0)),
          mistake_state: !charged.length || !charged.some((l) => l.mistake_reason) ? 'none' : charged.every((l) => l.mistake_reason) ? 'all' : 'part',
          // Paid is about the supplier's bill, so it looks at every line of the invoice.
          payment_state: !allLines.length ? 'unpaid' : allLines.every((l) => l.paid) ? 'paid' : allLines.some((l) => l.paid) ? 'part' : 'unpaid',
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
      return { job, totals, invoices: outInvoices, bySupplier: roundMap(bySupplier), byCategory: roundMap(byCategory), byReason: roundMap(byReason) };
    },

    /**
     * Totals across every job of a ServiceM8 account, for the reports page.
     * from/to (YYYY-MM-DD) filter jobs by the date of their first invoice.
     */
    getReport(accountUUID, { from = null, to = null } = {}) {
      const firstDate = (s) => s.invoices.filter((i) => i.status === 'ready').map((i) => i.invoice_date || String(i.created_at).slice(0, 10)).sort()[0] || null;
      const jobs = db.prepare(`SELECT jobs.* FROM jobs WHERE jobs.account_uuid IS ? AND (
            EXISTS (SELECT 1 FROM invoices WHERE invoices.job_uuid = jobs.job_uuid)
            OR EXISTS (SELECT 1 FROM allocations WHERE allocations.job_uuid = jobs.job_uuid))`).all(accountUUID)
        .map((j) => ({ ...j, summary: repo.getJobSummary(j.job_uuid) }))
        .map((j) => ({ ...j, first_date: firstDate(j.summary) }))
        .filter((j) => j.first_date && (!from || j.first_date >= from) && (!to || j.first_date <= to))
        .sort((a, b) => String(b.first_date).localeCompare(String(a.first_date)));

      const t = { jobs: 0, total: 0, mistakes: 0, quoted: 0, quotedJobs: 0, costsOnQuoted: 0, mistakesOnQuoted: 0 };
      const reasons = {};
      const suppliers = {};
      const jobRows = [];
      const mistakeItems = [];
      let notAssigned = 0;
      for (const j of jobs) {
        const s = j.summary;
        for (const inv of s.invoices) if (!inv.foreign && inv.status === 'ready') notAssigned += inv.not_assigned || 0;
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
      const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
      const totals = {
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
      };
      return {
        totals,
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

module.exports = { openDb, allocateCosts, newInboxCode, round2, invoiceCategory };
