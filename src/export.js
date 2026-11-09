const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * "Export everything": one zip with spreadsheets (CSV, open in Excel) of every invoice, its lines and
 * where they went, every job's costs and profit, the rules and statement checks, plus the original files.
 * Written to the response one file at a time, so big exports don't fill the memory.
 */

// ---------- a small zip writer (stored for PDFs and photos, deflated for text) ----------
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
function createZip(write) {
  const entries = [];
  let offset = 0;
  const now = dosTime(new Date());
  const push = async (buf) => { offset += buf.length; await write(buf); }; // write waits while the download catches up
  return {
    async add(name, data) {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const compress = /\.(csv|txt|json|html)$/i.test(name);
      const body = compress ? zlib.deflateRawSync(raw) : raw;
      const crc = zlib.crc32(raw) >>> 0;
      const nameBuf = Buffer.from(name, 'utf8');
      if (offset + body.length > 0xfffffff0) throw new Error('Export too big for one zip');
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); // utf-8 names
      h.writeUInt16LE(compress ? 8 : 0, 8); h.writeUInt16LE(now.time, 10); h.writeUInt16LE(now.date, 12);
      h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
      h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
      entries.push({ nameBuf, crc, size: body.length, raw: raw.length, method: compress ? 8 : 0, offset });
      await push(h); await push(nameBuf); await push(body);
    },
    async finish() {
      const start = offset;
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(e.method, 10); c.writeUInt16LE(now.time, 12); c.writeUInt16LE(now.date, 14);
        c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.raw, 24);
        c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.offset, 42);
        await push(c); await push(e.nameBuf);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
      await push(end);
    },
  };
}

// ---------- CSV (with a BOM so Excel reads the $ and – right) ----------
function csv(rows) {
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const exGst = (total, tax) => (total == null ? null : Math.round((Number(total) - (Number(tax) || 0)) * 100) / 100);

async function exportEverything(repo, accountUUID, write) {
  const zip = createZip(write);
  const db = repo.db;
  const invoices = db.prepare(`SELECT * FROM invoices WHERE account_uuid IS ? ORDER BY COALESCE(invoice_date, created_at), id`).all(accountUUID);
  const jobsById = new Map(db.prepare('SELECT * FROM jobs WHERE account_uuid IS ?').all(accountUUID).map((j) => [j.job_uuid, j]));
  const jobNo = (uuid) => (jobsById.get(uuid) || {}).job_number || '?';

  // the original files, with readable names
  const fileNames = new Map();
  const used = new Set();
  for (const inv of invoices) {
    if (!inv.file_path) continue;
    const jobs = repo.jobsOnInvoice(inv.id).map((j) => j.job_number).filter(Boolean);
    const ext = path.extname(inv.file_name || inv.file_path) || '.pdf';
    let base = safe([inv.supplier || 'Unknown supplier', inv.invoice_number || `id ${inv.id}`, jobs.length ? 'job ' + jobs.join(' ') : inv.kept_as_stock ? 'stock' : ''].filter(Boolean).join(' – '));
    let name = `invoices/${base}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `invoices/${base} (${n})${ext}`;
    used.add(name.toLowerCase());
    fileNames.set(inv.id, name);
  }

  // 1. Invoices: one row each
  const invRows = [['Invoice id', 'Supplier', 'Invoice number', 'Invoice date', 'Due date', 'Ex GST', 'GST', 'Total inc GST', 'Paid', 'Paid on',
    'Jobs (share of the invoice)', 'Stock', 'Status', 'Came from', 'Email subject', 'File in this zip']];
  const lineRows = [['Invoice id', 'Supplier', 'Invoice number', 'Line', 'Quantity', 'Unit', 'Line ex GST', 'Type', 'Paid', 'Job', 'Job’s quantity', 'Job’s amount ex GST', 'Screw-up', 'Left (not on a job)']];
  for (const inv of invoices) {
    const items = db.prepare('SELECT * FROM items WHERE invoice_id = ? ORDER BY position, id').all(inv.id);
    const paidN = items.filter((i) => i.paid).length;
    const paidAt = items.map((i) => i.paid_at).filter(Boolean).sort().pop() || null;
    const shares = new Map();
    let cost = 0;
    for (const it of items) {
      cost += it.cost || 0;
      const allocs = db.prepare('SELECT * FROM allocations WHERE item_id = ?').all(it.id);
      let given = 0;
      for (const a of allocs) {
        given += a.fraction;
        shares.set(a.job_uuid, (shares.get(a.job_uuid) || 0) + a.fraction * (it.cost || 0));
        lineRows.push([inv.id, inv.supplier, inv.invoice_number, it.description, it.quantity, it.unit, it.cost, a.category || it.category, it.paid ? 'Yes' : 'No',
          '#' + jobNo(a.job_uuid), it.quantity != null ? Math.round(a.fraction * it.quantity * 1000) / 1000 : null, (it.cost || 0) * a.fraction, a.mistake_reason || '', '']);
      }
      if (given < 1 - 1e-6) {
        lineRows.push([inv.id, inv.supplier, inv.invoice_number, it.description, it.quantity, it.unit, it.cost, it.category, it.paid ? 'Yes' : 'No', '', '', '', '',
          it.quantity != null ? Math.round((1 - given) * it.quantity * 1000) / 1000 + ' ' + (it.unit || '') : Math.round((1 - given) * (it.cost || 0) * 100) / 100]);
      }
    }
    const jobText = [...shares].map(([u, amt]) => `#${jobNo(u)}${cost ? ' (' + Math.round(amt / cost * 100) + '%)' : ''}`).join('; ');
    invRows.push([inv.id, inv.supplier, inv.invoice_number, inv.invoice_date, inv.due_date, exGst(inv.total, inv.tax), inv.tax, inv.total,
      !items.length ? '' : paidN === items.length ? 'Yes' : paidN ? 'Part' : 'No', paidAt ? paidAt.slice(0, 10) : '',
      jobText, inv.kept_as_stock ? 'Yes' : '', inv.status === 'ready' ? '' : inv.status + (inv.error ? ': ' + inv.error : ''), inv.source, inv.email_subject, fileNames.get(inv.id) || '']);
  }
  await zip.add('Invoices.csv', csv(invRows));
  await zip.add('Invoice lines.csv', csv(lineRows));

  // 2. Jobs: costs, paid, profit
  const jobRows = [['Job', 'Client', 'Address / title', 'Status in ServiceM8', 'Stock order job', 'Quoted ex GST', 'Costs ex GST', 'Paid', 'Still to pay', 'Profit', 'Margin %', 'Screw-ups', 'Invoices']];
  for (const j of jobsById.values()) {
    const s = repo.getJobSummary(j.job_uuid);
    const t = s.totals || {};
    if (!(s.invoices || []).length && j.quote_amount == null) continue;
    jobRows.push([j.job_number, j.client_name, j.job_title, j.sm8_status, (j.stock_manual != null ? j.stock_manual : j.stock_auto) ? 'Yes' : '',
      t.quote, t.total, t.paid, t.outstanding, t.margin, t.marginPct, t.mistakes, t.invoiceCount]);
  }
  jobRows.splice(1, jobRows.length - 1, ...jobRows.slice(1).sort((a, b) => String(b[0]).localeCompare(String(a[0]), undefined, { numeric: true })));
  await zip.add('Jobs.csv', csv(jobRows));

  // 3. Rules, price lists, statement checks
  await zip.add('Rules.csv', csv([['Rule', 'On', 'Kind', 'Supplier only', 'For invoice', 'Used on', 'Added'],
    ...repo.listRules(accountUUID).map((r) => [r.text, r.active ? 'Yes' : 'No', r.kind, r.supplier, r.target, r.used_on, String(r.created_at).slice(0, 10)])]));
  const plRows = [['Supplier', 'File in this zip', 'Uploaded']];
  for (const p of repo.listPriceLists(accountUUID)) {
    const name = `price lists/${safe(p.supplier)} – ${safe(p.name || 'price list')}`;
    plRows.push([p.supplier, name, String(p.created_at).slice(0, 10)]);
    try { await zip.add(name, fs.readFileSync(path.join(repo.filesDir, p.file_path))); } catch { plRows[plRows.length - 1][1] = '(file missing)'; }
  }
  await zip.add('Price lists.csv', csv(plRows));
  const ckRows = [['Check', 'Supplier', 'Statement date', 'Invoices from', 'to', 'Statement total', 'Checked total', 'Status', 'Bottom line', 'Before you pay']];
  const ckLines = [['Check', 'Invoice', 'Date', 'Amount', 'Result', 'What we found', 'Price', 'Job', 'Difference ex GST', 'Resolved']];
  for (const row of repo.listChecks(accountUUID)) {
    const c = repo.getCheck(accountUUID, row.id);
    const r = c.result || {};
    ckRows.push([c.id, c.supplier, c.statement_date, c.date_from, c.date_to, row.total_due, row.period_total, c.status, r.summary, (r.actions || []).join(' | ')]);
    const byRef = new Map((r.invoices || []).map((x) => [String(x.reference).toLowerCase(), x]));
    for (const m of c.matched || []) {
      const v = byRef.get(String(m.reference).toLowerCase()) || {};
      ckLines.push([c.id, m.reference, m.date, m.amount, v.verdict, v.headline, v.price, v.job, v.difference_ex_gst, (c.resolved || {})[m.reference] ? 'Yes' : '']);
    }
    if (c.file_path) { try { await zip.add(`statements/check ${c.id} – ${safe(c.supplier || c.file_name)}${path.extname(c.file_name || '.pdf') || '.pdf'}`, fs.readFileSync(path.join(repo.filesDir, c.file_path))); } catch { /* missing */ } }
  }
  await zip.add('Statement checks.csv', csv(ckRows));
  await zip.add('Statement check lines.csv', csv(ckLines));

  // 4. The invoice files
  let missing = 0;
  for (const inv of invoices) {
    const name = fileNames.get(inv.id);
    if (!name) continue;
    try { await zip.add(name, fs.readFileSync(path.join(repo.filesDir, inv.file_path))); } catch { missing++; }
  }
  await zip.add('READ ME.txt', [
    'Job Costs – everything, exported ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)',
    '',
    'Invoices.csv            one row per invoice: amounts, paid or not, which job(s) it is on, stock',
    'Invoice lines.csv       every line of every invoice and which job got how much; what is left in stock',
    'Jobs.csv                each job: quoted price, costs, paid, still to pay, profit',
    'Rules.csv, Price lists.csv, Statement checks.csv, Statement check lines.csv',
    'invoices/, price lists/, statements/   the original files',
    '',
    'The .csv files open in Excel. Amounts are AUD; "ex GST" unless it says otherwise.',
    'Not included: the Outlook and ServiceM8 connections (reconnect them if you ever move).',
    missing ? `\n${missing} invoice file(s) were missing on the server and are not in this zip.` : '',
  ].join('\r\n'));
  await zip.finish();
  return { invoices: invoices.length, jobs: jobRows.length - 1 };
}

module.exports = { exportEverything, createZip, csv };
