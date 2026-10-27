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
      db.prepare("UPDATE invoices SET status = 'error', error = ? WHERE id = ?").run(String(message).slice(0, 500), id);
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
      const before = new Map(db.prepare('SELECT * FROM items WHERE invoice_id = ?').all(id).map((o) => [norm(o.description), o]));

      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE invoices SET status = 'ready', error = NULL,
            document_type = ?, supplier = ?, supplier_abn = ?, invoice_number = ?, invoice_date = ?,
            due_date = ?, currency = ?, subtotal = ?, tax = ?, total = ?, notes = ?
          WHERE id = ?`).run(
          x.document_type || null, x.supplier_name || null, x.supplier_abn || null, x.invoice_number || null,
          x.invoice_date || null, x.due_date || null, x.currency || null,
          x.subtotal ?? null, x.tax ?? null, round2(total), x.notes || null, id,
        );
        db.prepare('DELETE FROM items WHERE invoice_id = ?').run(id);
        const ins = db.prepare(`INSERT INTO items
          (invoice_id, position, description, category, quantity, unit, unit_price, line_total, cost, paid, paid_at, mistake_reason, mistake_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();
        items.forEach((it, i) => {
          const old = before.get(norm(it.description));
          const paid = alreadyPaid || !!(old && old.paid);
          ins.run(id, i, String(it.description).slice(0, 500), it.category || 'other',
            it.quantity ?? null, it.unit || null, it.unit_price ?? null, round2(it.line_total), costs[i],
            paid ? 1 : 0, paid ? (old?.paid_at || now) : null, old?.mistake_reason || null, old?.mistake_at || null);
        });
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
      const invoices = db.prepare('SELECT * FROM invoices WHERE job_uuid = ? ORDER BY COALESCE(invoice_date, created_at) DESC, id DESC').all(jobUUID);
      const items = db.prepare(`SELECT items.* FROM items JOIN invoices ON invoices.id = items.invoice_id
        WHERE invoices.job_uuid = ? ORDER BY items.position, items.id`).all(jobUUID);
      const byInvoice = new Map(invoices.map((inv) => [inv.id, []]));
      for (const it of items) byInvoice.get(it.invoice_id)?.push({ ...it, paid: !!it.paid });

      const totals = { total: 0, paid: 0, outstanding: 0, tax: 0, invoiceCount: 0, processing: 0, errors: 0, mistakes: 0 };
      const byReason = {};
      const bySupplier = {};
      const byCategory = {};
      const seen = new Map();

      const outInvoices = invoices.map((inv) => {
        const lines = byInvoice.get(inv.id) || [];
        const paid = round2(lines.filter((l) => l.paid).reduce((s, l) => s + l.cost, 0));
        const total = round2(inv.total || 0);
        let duplicateOf = null;
        if (inv.status === 'ready' && inv.invoice_number) {
          const key = `${(inv.supplier || '').toLowerCase()}|${inv.invoice_number.toLowerCase()}`;
          if (seen.has(key)) duplicateOf = seen.get(key); else seen.set(key, inv.id);
        }
        if (inv.status === 'processing') totals.processing++;
        if (inv.status === 'error') totals.errors++;
        if (inv.status === 'ready' && !duplicateOf) {
          totals.invoiceCount++;
          totals.total += total;
          totals.paid += paid;
          totals.tax += Number(inv.tax) || 0;
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
        return {
          ...inv,
          items: lines,
          paid_amount: paid,
          outstanding: round2(total - paid),
          mistake_amount: round2(lines.filter((l) => l.mistake_reason).reduce((s, l) => s + l.cost, 0)),
          mistake_state: !lines.length || !lines.some((l) => l.mistake_reason) ? 'none' : lines.every((l) => l.mistake_reason) ? 'all' : 'part',
          payment_state: !lines.length ? 'unpaid' : lines.every((l) => l.paid) ? 'paid' : lines.some((l) => l.paid) ? 'part' : 'unpaid',
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
      const jobs = db.prepare(`SELECT jobs.*, MIN(COALESCE(invoices.invoice_date, substr(invoices.created_at, 1, 10))) AS first_date
          FROM jobs JOIN invoices ON invoices.job_uuid = jobs.job_uuid
          WHERE jobs.account_uuid IS ? GROUP BY jobs.job_uuid ORDER BY first_date DESC`).all(accountUUID)
        .filter((j) => (!from || j.first_date >= from) && (!to || j.first_date <= to));

      const t = { jobs: 0, total: 0, mistakes: 0, quoted: 0, quotedJobs: 0, costsOnQuoted: 0, mistakesOnQuoted: 0 };
      const reasons = {};
      const suppliers = {};
      const jobRows = [];
      const mistakeItems = [];
      for (const j of jobs) {
        const s = repo.getJobSummary(j.job_uuid);
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
            if (!l.mistake_reason) continue;
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

module.exports = { openDb, allocateCosts, newInboxCode, round2 };
