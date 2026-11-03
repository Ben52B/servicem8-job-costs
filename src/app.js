const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const { verifyEvent, fetchJob } = require('./servicem8');
const { inboxAddress, codesFromAddresses, parseInboundEmail } = require('./inbound');
const { isSupported, guessMime, htmlToText, CATEGORIES } = require('./analyzer');
const { MISTAKE_REASONS, REASON_CODES } = require('./mistakes');

const MAX_FILE_MB = 25;
const CARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'card.html'), 'utf8');
const REPORT_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'report.html'), 'utf8');

/** undefined = not sent, null/'' = clear, a known code = set; anything else is invalid. */
function parseReason(value) {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { reason: null };
  if (REASON_CODES.has(value)) return { reason: value };
  return { error: 'Unknown screw-up reason' };
}

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
}

function createApp({ config, repo, processor, fetchJobImpl = fetchJob }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 30 } });

  // ---------- helpers ----------
  function saveFile(jobUUID, name, buffer) {
    const dir = path.join(repo.filesDir, jobUUID);
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(jobUUID, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName(name)}`);
    fs.writeFileSync(path.join(repo.filesDir, rel), buffer);
    return rel;
  }

  function addInvoiceFile({ jobUUID, source, name, contentType, buffer, emailFrom, emailSubject }) {
    const mimeType = guessMime(name, contentType);
    const inv = repo.createInvoice({
      jobUUID, source, fileName: name, filePath: saveFile(jobUUID, name, buffer), mimeType, emailFrom, emailSubject,
    });
    if (isSupported(name, mimeType)) processor.enqueue(inv.id);
    else repo.setInvoiceError(inv.id, 'Unsupported file type. Send a PDF or a photo (JPG/PNG).');
    return inv;
  }

  function sessionToken(jobUUID) {
    return jwt.sign({ jobUUID }, config.sessionSecret, { expiresIn: '12h' });
  }

  function renderCard(res, job, { embedded }) {
    const boot = {
      token: sessionToken(job.job_uuid),
      embedded,
      categories: CATEGORIES,
      reasons: MISTAKE_REASONS,
    };
    const html = CARD_HTML
      .replace('/*__BOOT__*/null', JSON.stringify(boot).replace(/</g, '\\u003c'))
      .replace('<!--__SM8_SDK__-->', embedded ? '<script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>' : '');
    res.set('Cache-Control', 'no-store').type('html').send(html);
  }

  // Card API auth: short-lived token handed to the card when ServiceM8 opened it.
  function requireSession(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.t;
    let job = null;
    try {
      const { jobUUID } = jwt.verify(String(token || ''), config.sessionSecret);
      job = repo.getJob(jobUUID);
    } catch { /* bad or expired token */ }
    if (!job) return res.status(401).json({ error: 'Session expired. Close and reopen Job Costs from the job card.' });
    req.job = job;
    next(); // outside the try, so a bug in a route isn't reported as an expired session
  }

  function ownInvoice(req, res) {
    const inv = repo.getInvoice(Number(req.params.id));
    if (!inv || inv.job_uuid !== req.job.job_uuid) { res.status(404).json({ error: 'Not found' }); return null; }
    return inv;
  }

  const sameAccount = (req, invoiceId) => (repo.invoiceAccount(invoiceId) ?? null) === (req.job.account_uuid ?? null);
  const hasShareIn = (req, invoiceId) => repo.db.prepare(`SELECT 1 FROM allocations JOIN items ON items.id = allocations.item_id
    WHERE items.invoice_id = ? AND allocations.job_uuid = ? LIMIT 1`).get(invoiceId, req.job.job_uuid);

  /** This job's own invoice, or another job's split invoice this job has a share of. */
  function visibleInvoice(req, res) {
    const inv = repo.getInvoice(Number(req.params.id));
    const ok = inv && (inv.job_uuid === req.job.job_uuid || (inv.split && sameAccount(req, inv.id) && hasShareIn(req, inv.id)));
    if (!ok) { res.status(404).json({ error: 'Not found' }); return null; }
    return inv;
  }

  // ---------- ServiceM8 ----------
  app.get('/manifest.json', (req, res) => {
    res.json({
      name: 'Job Costs',
      version: '1.0',
      iconURL: `${config.publicUrl}/icon.png`,
      supportURL: config.publicUrl,
      actions: [{
        name: 'Job Costs',
        type: 'online',
        entity: 'job',
        iconURL: `${config.publicUrl}/icon.png`,
        event: 'job_costs_open',
      }],
    });
  });

  // ServiceM8 calls this when someone clicks "Job Costs" on a job card.
  app.post('/servicem8/addon', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = verifyEvent(req.body, config.servicem8AppSecret);
    } catch (e) {
      return res.status(401).type('html').send(`<p style="font-family:sans-serif">Could not open Job Costs: ${String(e.message).replace(/</g, '&lt;')}</p>`);
    }
    const info = await fetchJobImpl(event.jobUUID, event.accessToken);
    const job = repo.ensureJob({ jobUUID: event.jobUUID, accountUUID: event.accountUUID, ...(info || {}) });
    renderCard(res, job, { embedded: true });
  });

  // Reports page (opened from the card, uses the card's session).
  app.get('/report', (req, res) => {
    try {
      const { jobUUID } = jwt.verify(String(req.query.t || ''), config.sessionSecret);
      if (!repo.getJob(jobUUID)) throw new Error('unknown job');
    } catch {
      return res.status(401).type('html').send('<p style="font-family:sans-serif">Session expired. Open Job Costs from a job in ServiceM8 and click Reports again.</p>');
    }
    const boot = { token: String(req.query.t), reasons: MISTAKE_REASONS };
    res.set('Cache-Control', 'no-store').type('html')
      .send(REPORT_HTML.replace('/*__BOOT__*/null', JSON.stringify(boot).replace(/</g, '\\u003c')));
  });

  // Local testing without ServiceM8.
  app.get('/dev/job/:jobUUID', (req, res) => {
    if (!config.devMode) return res.status(404).send('Not found');
    const job = repo.ensureJob({ jobUUID: req.params.jobUUID, jobNumber: req.query.number || null, jobTitle: req.query.title || null,
      quoteAmount: req.query.quote ? Number(req.query.quote) : null });
    renderCard(res, job, { embedded: false });
  });

  // ---------- Card API ----------
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(requireSession);

  api.get('/job', (req, res) => {
    const summary = repo.getJobSummary(req.job.job_uuid);
    res.json({ ...summary, inboxAddress: inboxAddress(req.job.inbox_code, config) });
  });

  api.patch('/job', (req, res) => {
    const { quote_amount } = req.body || {};
    if (quote_amount === null || quote_amount === '') repo.setQuote(req.job.job_uuid, null);
    else {
      const q = Number(String(quote_amount).replace(/[$,\s]/g, ''));
      if (!isFinite(q) || q < 0) return res.status(400).json({ error: 'Quoted price must be a number' });
      repo.setQuote(req.job.job_uuid, q);
    }
    res.json({ ok: true });
  });

  // An invoice typed in by hand (e.g. the paper copy was lost). Lines are optional;
  // whatever the listed lines don't cover shows as "Other items (not listed)".
  api.post('/invoices/manual', (req, res) => {
    const b = req.body || {};
    const supplier = String(b.supplier || '').trim().slice(0, 200);
    if (!supplier) return res.status(400).json({ error: 'Supplier is required' });
    const date = String(b.invoice_date || '');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    const category = b.category || 'materials';
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown type' });
    const money = (v) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/[$,\s]/g, '')));

    const lines = [];
    for (const l of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
      const description = String(l?.description || '').trim().slice(0, 500);
      const amount = money(l?.amount);
      if (!description && amount == null) continue; // empty row
      if (!description) return res.status(400).json({ error: 'Each line needs a description' });
      if (amount == null || !isFinite(amount)) return res.status(400).json({ error: `Enter an amount for "${description}"` });
      lines.push({ description, category, line_total: amount });
    }
    const listed = lines.reduce((sum, l) => sum + l.line_total, 0);
    let total = money(b.total);
    if (total != null && !isFinite(total)) return res.status(400).json({ error: 'Total must be a number' });
    if (total == null) total = listed;
    if (!lines.length && !total) return res.status(400).json({ error: 'Enter the total or at least one line' });
    if (listed - total > 0.005) return res.status(400).json({ error: 'The lines add up to more than the total' });
    if (total - listed > 0.005) lines.push({ description: lines.length ? 'Other items (not listed)' : `Invoice from ${supplier}`, category, line_total: Math.round((total - listed) * 100) / 100 });

    const gst = b.includes_gst === false ? 0 : Math.round(total / 11 * 100) / 100;
    const inv = repo.createInvoice({ jobUUID: req.job.job_uuid, source: 'manual' });
    repo.saveExtraction(inv.id, {
      document_type: 'manual', supplier_name: supplier, invoice_number: String(b.invoice_number || '').trim().slice(0, 100) || null,
      invoice_date: date || null, currency: 'AUD', subtotal: Math.round((total - gst) * 100) / 100, tax: gst, total,
      notes: 'Added by hand – no invoice file.', items: lines,
    });
    repo.setInvoiceCategory(inv.id, category);
    if (b.paid === true) repo.setInvoicePaid(inv.id, true);
    res.status(201).json({ id: inv.id });
  });

  // Found the paper invoice for one that was added by hand: attach it and read it.
  api.post('/invoices/:id/file', upload.single('file'), (req, res) => {
    const inv = ownInvoice(req, res);
    if (!inv) return;
    if (inv.file_path) return res.status(400).json({ error: 'This invoice already has a file' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mimeType = guessMime(req.file.originalname, req.file.mimetype);
    if (!isSupported(req.file.originalname, mimeType)) return res.status(400).json({ error: 'Unsupported file type. Use a PDF or a photo (JPG/PNG).' });
    repo.attachFile(inv.id, {
      fileName: req.file.originalname, mimeType,
      filePath: saveFile(req.job.job_uuid, req.file.originalname, req.file.buffer),
    });
    processor.enqueue(inv.id);
    res.json({ ok: true });
  });

  api.post('/invoices', upload.array('files', 30), (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });
    const created = files.map((f) => addInvoiceFile({
      jobUUID: req.job.job_uuid, source: 'upload', name: f.originalname, contentType: f.mimetype, buffer: f.buffer,
    }));
    res.status(201).json({ created: created.map((i) => i.id) });
  });

  api.get('/invoices/:id/file', (req, res) => {
    const inv = visibleInvoice(req, res);
    if (!inv) return;
    if (!inv.file_path) return res.status(404).json({ error: 'No file' });
    res.type(inv.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${safeName(inv.file_name)}"`);
    res.sendFile(path.join(repo.filesDir, inv.file_path));
  });

  api.post('/invoices/:id/reanalyze', (req, res) => {
    const inv = ownInvoice(req, res);
    if (!inv) return;
    if (!inv.file_path) return res.status(400).json({ error: 'This invoice was added by hand, so there is no file to read' });
    if (!isSupported(inv.file_name, inv.mime_type)) return res.status(400).json({ error: 'Unsupported file type' });
    processor.enqueue(inv.id);
    res.json({ ok: true });
  });

  api.patch('/invoices/:id', (req, res) => {
    const inv = visibleInvoice(req, res);
    if (!inv) return;
    const { paid, supplier, invoice_number, total, mistake_reason, category, split } = req.body || {};
    const own = inv.job_uuid === req.job.job_uuid;
    // Another job's invoice: this job may only change paid and its own screw-up tags.
    if (!own && (supplier !== undefined || invoice_number !== undefined || total !== undefined || category !== undefined || split !== undefined)) {
      return res.status(403).json({ error: 'Change this on the job the invoice belongs to' });
    }
    if (typeof split === 'boolean') {
      if (inv.status !== 'ready') return res.status(400).json({ error: 'Wait until the invoice has been read' });
      try { repo.setSplit(inv.id, split); } catch (e) {
        if (e.status === 409) {
          const jobs = repo.otherJobsOnInvoice(inv.id).map((j) => (j.job_number ? '#' + j.job_number : 'another job')).join(', ');
          return res.status(409).json({ error: `Other jobs have part of this invoice (${jobs}). They need to give it back first.` });
        }
        throw e;
      }
    }
    const m = parseReason(mistake_reason);
    if (m.error) return res.status(400).json({ error: m.error });
    if (category !== undefined && !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown type' });
    const t = total === undefined || total === '' ? undefined : Number(total);
    if (t !== undefined && !isFinite(t)) return res.status(400).json({ error: 'Total must be a number' });
    if (typeof paid === 'boolean') repo.setInvoicePaid(inv.id, paid);
    if (!m.skip) {
      if (repo.getInvoice(inv.id).split) repo.setInvoiceShareMistake(inv.id, req.job.job_uuid, m.reason);
      else repo.setInvoiceMistake(inv.id, m.reason);
    }
    if (category !== undefined) repo.setInvoiceCategory(inv.id, category);
    if (supplier !== undefined || invoice_number !== undefined || t !== undefined) {
      repo.updateInvoice(inv.id, { supplier, invoice_number, total: t });
    }
    res.json({ ok: true });
  });

  api.delete('/invoices/:id', (req, res) => {
    const inv = visibleInvoice(req, res);
    if (!inv) return;
    // On another job's invoice, "remove" gives this job's share back.
    if (inv.job_uuid !== req.job.job_uuid) { repo.giveBack(inv.id, req.job.job_uuid); return res.json({ ok: true, gaveBack: true }); }
    const others = repo.otherJobsOnInvoice(inv.id);
    if (others.length) {
      return res.status(409).json({ error: `Other jobs have part of this invoice (${others.map((j) => (j.job_number ? '#' + j.job_number : 'another job')).join(', ')}). They need to give it back first.` });
    }
    repo.deleteInvoice(inv.id);
    res.json({ ok: true });
  });

  // How much of a line this job gets, from a split invoice of this job or another job.
  // Body: { quantity } for lines with a quantity, or { amount } in dollars (incl. GST).
  api.put('/items/:id/share', (req, res) => {
    const item = repo.getItem(Number(req.params.id));
    const inv = item && repo.getInvoice(item.invoice_id);
    if (!inv || !sameAccount(req, inv.id)) return res.status(404).json({ error: 'Not found' });
    if (!inv.split) return res.status(400).json({ error: 'Split this invoice first (on the job it belongs to)' });
    const n = (v) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/[$,\s]/g, '')));
    const qty = n(req.body?.quantity);
    const amount = n(req.body?.amount);
    let fraction;
    if (qty != null && Number(item.quantity) > 0) fraction = qty / Number(item.quantity);
    else if (amount != null) fraction = item.cost ? amount / item.cost : 0;
    else return res.status(400).json({ error: 'Enter a quantity or an amount' });
    if (!isFinite(fraction)) return res.status(400).json({ error: 'Enter a number' });
    try {
      repo.setShare(item.id, req.job.job_uuid, fraction);
    } catch (e) {
      if (e.status !== 400) throw e;
      const q = Number(item.quantity) > 0 ? Number(item.quantity) : null;
      const left = q ? `${Math.round(e.left * q * 1000) / 1000} left` : `$${(e.left * item.cost).toFixed(2)} left`;
      return res.status(400).json({ error: `${e.message} (${left})` });
    }
    res.json({ ok: true });
  });

  // Lines of split invoices that other jobs can still take from.
  api.get('/available', (req, res) => {
    res.json({ invoices: repo.getAvailable(req.job.account_uuid ?? null, req.job.job_uuid) });
  });

  api.patch('/items/:id', (req, res) => {
    const item = repo.getItem(Number(req.params.id));
    const inv = item && repo.getInvoice(item.invoice_id);
    const share = inv && inv.split ? repo.getShare(item.id, req.job.job_uuid) : null;
    const own = item && item.job_uuid === req.job.job_uuid;
    if (!item || (!own && !(inv.split && share && sameAccount(req, inv.id)))) return res.status(404).json({ error: 'Not found' });
    const { paid, description, category, line_total, mistake_reason } = req.body || {};
    if (!own && (paid !== undefined || description !== undefined || category !== undefined || line_total !== undefined)) {
      return res.status(403).json({ error: 'Change this on the job the invoice belongs to' });
    }
    // On a split invoice the screw-up tag belongs to this job's share of the line.
    if (inv.split && mistake_reason !== undefined) {
      const m = parseReason(mistake_reason);
      if (m.error) return res.status(400).json({ error: m.error });
      if (!share) return res.status(400).json({ error: 'This job has none of this line' });
      repo.setShareMistake(item.id, req.job.job_uuid, m.reason);
      return res.json({ ok: true });
    }
    if (category !== undefined && !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });
    const m = parseReason(mistake_reason);
    if (m.error) return res.status(400).json({ error: m.error });
    const lt = line_total === undefined || line_total === '' ? undefined : Number(line_total);
    if (lt !== undefined && !isFinite(lt)) return res.status(400).json({ error: 'Amount must be a number' });
    if (typeof paid === 'boolean') repo.setItemPaid(item.id, paid);
    if (!m.skip) repo.setItemMistake(item.id, m.reason);
    if (description !== undefined || category !== undefined || lt !== undefined) {
      repo.updateItem(item.id, { description, category, line_total: lt });
    }
    res.json({ ok: true });
  });

  // Reports across all jobs of the same ServiceM8 account as the job the card was opened from.
  api.get('/report', (req, res) => {
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    res.json(repo.getReport(req.job.account_uuid ?? null, { from: date(req.query.from), to: date(req.query.to) }));
  });

  app.use('/api', api);

  // ---------- Inbound email webhook ----------
  app.post('/inbound/email',
    (req, res, next) => {
      const key = req.query.key || '';
      const ok = config.inboundSecret && key.length === config.inboundSecret.length &&
        crypto.timingSafeEqual(Buffer.from(String(key)), Buffer.from(config.inboundSecret));
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
      next();
    },
    express.json({ limit: '60mb' }),
    upload.any(),
    (req, res) => {
      const mail = parseInboundEmail(req);
      const jobs = codesFromAddresses(mail.recipients).map((c) => repo.getJobByInboxCode(c)).filter(Boolean);
      // Always answer 200 so the email provider doesn't keep retrying mail for unknown jobs.
      if (!jobs.length) return res.json({ ok: true, matched: 0 });

      const pdfs = mail.attachments.filter((a) => guessMime(a.name, a.contentType) === 'application/pdf');
      let files;
      if (pdfs.length) files = pdfs;
      else {
        // No PDFs: use real photos (skip small logos / signature images), else unsupported files so the user sees them.
        files = mail.attachments.filter((a) => {
          const m = guessMime(a.name, a.contentType);
          if (m.startsWith('image/')) return a.buffer.length >= 20 * 1024;
          return !m.startsWith('text/');
        });
      }
      const body = mail.text || (mail.html ? htmlToText(mail.html) : '');
      if (!files.length && body.trim().length > 80) {
        files = [{ name: `${safeName(mail.subject || 'email').slice(0, 60)}.txt`, contentType: 'text/plain', buffer: Buffer.from(body, 'utf8') }];
      }

      let created = 0;
      for (const job of jobs) {
        for (const f of files) {
          addInvoiceFile({
            jobUUID: job.job_uuid, source: 'email', name: f.name, contentType: f.contentType, buffer: f.buffer,
            emailFrom: mail.from, emailSubject: mail.subject,
          });
          created++;
        }
      }
      res.json({ ok: true, matched: jobs.length, created });
    });

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.get('/', (req, res) => res.type('text').send('Job Costs add-on for ServiceM8 is running.'));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files must be under ${MAX_FILE_MB} MB` : err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
