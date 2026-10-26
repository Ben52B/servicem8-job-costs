const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const { verifyEvent, fetchJob } = require('./servicem8');
const { inboxAddress, codesFromAddresses, parseInboundEmail } = require('./inbound');
const { isSupported, guessMime, htmlToText, CATEGORIES } = require('./analyzer');

const MAX_FILE_MB = 25;
const CARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'card.html'), 'utf8');

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
    try {
      const { jobUUID } = jwt.verify(String(token || ''), config.sessionSecret);
      req.job = repo.getJob(jobUUID);
      if (!req.job) throw new Error('unknown job');
      next();
    } catch {
      res.status(401).json({ error: 'Session expired. Close and reopen Job Costs from the job card.' });
    }
  }

  function ownInvoice(req, res) {
    const inv = repo.getInvoice(Number(req.params.id));
    if (!inv || inv.job_uuid !== req.job.job_uuid) { res.status(404).json({ error: 'Not found' }); return null; }
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

  // Local testing without ServiceM8.
  app.get('/dev/job/:jobUUID', (req, res) => {
    if (!config.devMode) return res.status(404).send('Not found');
    const job = repo.ensureJob({ jobUUID: req.params.jobUUID, jobNumber: req.query.number || null, jobTitle: req.query.title || null });
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

  api.post('/invoices', upload.array('files', 30), (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });
    const created = files.map((f) => addInvoiceFile({
      jobUUID: req.job.job_uuid, source: 'upload', name: f.originalname, contentType: f.mimetype, buffer: f.buffer,
    }));
    res.status(201).json({ created: created.map((i) => i.id) });
  });

  api.get('/invoices/:id/file', (req, res) => {
    const inv = ownInvoice(req, res);
    if (!inv) return;
    if (!inv.file_path) return res.status(404).json({ error: 'No file' });
    res.type(inv.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${safeName(inv.file_name)}"`);
    res.sendFile(path.join(repo.filesDir, inv.file_path));
  });

  api.post('/invoices/:id/reanalyze', (req, res) => {
    const inv = ownInvoice(req, res);
    if (!inv) return;
    if (!isSupported(inv.file_name, inv.mime_type)) return res.status(400).json({ error: 'Unsupported file type' });
    processor.enqueue(inv.id);
    res.json({ ok: true });
  });

  api.patch('/invoices/:id', (req, res) => {
    const inv = ownInvoice(req, res);
    if (!inv) return;
    const { paid, supplier, invoice_number, total } = req.body || {};
    if (typeof paid === 'boolean') repo.setInvoicePaid(inv.id, paid);
    if (supplier !== undefined || invoice_number !== undefined || total !== undefined) {
      const t = total === undefined || total === '' ? undefined : Number(total);
      if (t !== undefined && !isFinite(t)) return res.status(400).json({ error: 'Total must be a number' });
      repo.updateInvoice(inv.id, { supplier, invoice_number, total: t });
    }
    res.json({ ok: true });
  });

  api.delete('/invoices/:id', (req, res) => {
    const inv = ownInvoice(req, res);
    if (!inv) return;
    repo.deleteInvoice(inv.id);
    res.json({ ok: true });
  });

  api.patch('/items/:id', (req, res) => {
    const item = repo.getItem(Number(req.params.id));
    if (!item || item.job_uuid !== req.job.job_uuid) return res.status(404).json({ error: 'Not found' });
    const { paid, description, category, line_total } = req.body || {};
    if (typeof paid === 'boolean') repo.setItemPaid(item.id, paid);
    if (category !== undefined && !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });
    if (description !== undefined || category !== undefined || line_total !== undefined) {
      const lt = line_total === undefined || line_total === '' ? undefined : Number(line_total);
      if (lt !== undefined && !isFinite(lt)) return res.status(400).json({ error: 'Amount must be a number' });
      repo.updateItem(item.id, { description, category, line_total: lt });
    }
    res.json({ ok: true });
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
