const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const sm8 = require('./servicem8');
const outlook = require('./outlook');
const { verifyEvent, fetchJob, fetchActiveJobs, looksLikeStockJob } = sm8;
const { inboxAddress, codesFromAddresses, parseInboundEmail } = require('./inbound');
const { isSupported, guessMime, htmlToText, CATEGORIES } = require('./analyzer');
const { MISTAKE_REASONS, REASON_CODES } = require('./mistakes');
const { mainJobNumber } = require('./db');

const MAX_FILE_MB = 25;
const page = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
const PAGES = { card: page('card.html'), report: page('report.html'), inbox: page('inbox.html') };

/** undefined = not sent, null/'' = clear, a known code = set; anything else is invalid. */
function parseReason(value) {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { reason: null };
  if (REASON_CODES.has(value)) return { reason: value };
  return { error: 'Unknown screw-up reason' };
}

/** undefined = not sent; otherwise must be a known type. */
function parseCategory(value) {
  if (value === undefined) return { skip: true };
  if (CATEGORIES.includes(value)) return { category: value };
  return { error: 'Unknown type' };
}

const money = (v) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/[$,\s]/g, '')));

function safeName(name) {
  return String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
}

function createApp({ config, repo, processor, fetchJobImpl = fetchJob, fetchActiveJobsImpl = fetchActiveJobs, oauth = sm8,
  findJobByNumberImpl = sm8.findJobByNumber, diaryApi = sm8, outlookApi = outlook.graphApi }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 30 } });

  // ---------- helpers ----------
  function saveFile(folder, name, buffer) {
    const dir = path.join(repo.filesDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(folder, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName(name)}`);
    fs.writeFileSync(path.join(repo.filesDir, rel), buffer);
    return rel;
  }

  const folderFor = (accountUUID) => (accountUUID ? safeName(accountUUID) : '_local');

  /** Store a file as a new invoice and queue it for reading. */
  function addInvoiceFile({ accountUUID, originJobUUID = null, source, name, contentType, buffer, emailFrom, emailSubject, emailText }) {
    const mimeType = guessMime(name, contentType);
    const inv = repo.createInvoice({
      accountUUID, originJobUUID, source, fileName: name, filePath: saveFile(folderFor(accountUUID), name, buffer), mimeType, emailFrom, emailSubject, emailText,
    });
    if (isSupported(name, mimeType)) processor.enqueue(inv.id);
    else repo.setInvoiceError(inv.id, 'Unsupported file type. Send a PDF or a photo (JPG/PNG).');
    return inv;
  }

  const sessionToken = (jobUUID) => jwt.sign({ jobUUID }, config.sessionSecret, { expiresIn: '12h' });
  const inject = (html, boot) => html.replace('/*__BOOT__*/null', JSON.stringify(boot).replace(/</g, '\\u003c'));

  function renderCard(res, job, { embedded }) {
    const boot = { token: sessionToken(job.job_uuid), embedded, categories: CATEGORIES, reasons: MISTAKE_REASONS };
    const html = inject(PAGES.card, boot)
      .replace('<!--__SM8_SDK__-->', embedded ? '<script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>' : '');
    res.set('Cache-Control', 'no-store').type('html').send(html);
  }

  const jobFromToken = (token) => {
    try { return repo.getJob(jwt.verify(String(token || ''), config.sessionSecret).jobUUID) || null; } catch { return null; }
  };

  // Card API auth: short-lived token handed to the card when ServiceM8 opened it.
  function requireSession(req, res, next) {
    const header = req.get('authorization') || '';
    const job = jobFromToken(header.startsWith('Bearer ') ? header.slice(7) : req.query.t);
    if (!job) return res.status(401).json({ error: 'Session expired. Close and reopen Job Costs from the job card.' });
    req.job = job;
    req.account = job.account_uuid ?? null;
    next(); // outside any try, so a bug in a route isn't reported as an expired session
  }

  /** An invoice of the same business as the job the card was opened from. */
  function accountInvoice(req, res, id = req.params.id) {
    const inv = repo.getInvoice(Number(id));
    if (!inv || (inv.account_uuid ?? null) !== req.account) { res.status(404).json({ error: 'Not found' }); return null; }
    return inv;
  }
  function accountItem(req, res, id = req.params.id) {
    const item = repo.getItem(Number(id));
    if (!item || (item.account_uuid ?? null) !== req.account) { res.status(404).json({ error: 'Not found' }); return null; }
    return item;
  }

  /** Turn { quantity } or { amount } into a share of the line (0..1). */
  function fractionFrom(item, body) {
    const qty = money(body?.quantity);
    const amount = money(body?.amount);
    if (qty != null && Number(item.quantity) > 0) return qty / Number(item.quantity);
    if (amount != null) return item.cost ? amount / item.cost : 0;
    return null;
  }
  const leftText = (item, left) => (Number(item.quantity) > 0
    ? `${Math.round(left * item.quantity * 1000) / 1000} left` : `$${(left * item.cost).toFixed(2)} left`);
  const jobList = (jobs) => jobs.map((j) => (j.job_number ? '#' + j.job_number : 'another job')).join(', ');

  // A job is a stock order job when its client or category matches (see config); unknown names change nothing.
  const withStockFlag = (info) => (info && (info.clientName || info.categoryName)
    ? { ...info, stockAuto: looksLikeStockJob(info, config) } : info);

  // Keep a list of the business's active jobs, so emailed invoices can be matched to them.
  async function syncJobs(accountUUID, accessToken, { force = false } = {}) {
    if (!accessToken || (!force && repo.jobsSyncedRecently(accountUUID, 10))) return;
    const jobs = await fetchActiveJobsImpl(accessToken);
    if (jobs.length) repo.saveSyncedJobs(accountUUID, jobs.map(withStockFlag));
  }

  /**
   * A ServiceM8 access token for an account: the one in the click event if ServiceM8
   * sent one, otherwise the one saved when the add-on was approved (refreshed when due).
   */
  async function accessTokenFor(accountUUID, eventToken) {
    const t = repo.getTokens(accountUUID);
    if (!t) return eventToken || null;
    if (t.refreshToken && Date.parse(t.expiresAt) - Date.now() < 120000) {
      try {
        const fresh = await oauth.refreshAccessToken({ appId: config.servicem8AppId, appSecret: config.servicem8AppSecret, refreshToken: t.refreshToken });
        repo.saveTokens(accountUUID, fresh);
        return fresh.accessToken;
      } catch (e) {
        console.error(`ServiceM8 token refresh failed: ${e.message}`);
      }
    }
    return t.accessToken;
  }

  // ---------- ServiceM8 job diary ----------
  const eventTokens = new Map(); // account -> access token from the last click (used if there's no saved approval)
  const diaryErrors = new Map(); // account -> why copying to the diary failed (shown on the card)
  const diaryToken = (accountUUID) => accessTokenFor(accountUUID, eventTokens.get(accountUUID ?? null));
  const diaryProblem = (e) => (/\b(401|403)\b/.test(e.message)
    ? `ServiceM8 didn\u2019t allow Job Costs to use the job diary. Open the add-on\u2019s install link again and approve it. (${e.message})`
    : `Couldn\u2019t reach the ServiceM8 job diary (${e.message}).`);
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function diaryNoteText(inv) {
    const ex = Number(inv.total || 0) - Number(inv.tax || 0);
    const what = `${inv.supplier || 'Supplier'} invoice${inv.invoice_number ? ' #' + inv.invoice_number : ''}`;
    return `Job Costs: ${what} added \u2013 $${fmt(ex)} ex GST${inv.file_path ? '' : ' (typed in, no file)'}.`;
  }

  /**
   * Copy invoices that are wholly on one job to that job's ServiceM8 diary (file + a note).
   * Shared invoices, stock, and files that came from the diary stay in Job Costs only.
   */
  let diaryRunning = null;
  let diaryAgain = false;
  const diaryRetryAt = new Map(); // invoice -> don't try again before (after a failure)
  function syncDiary() {
    if (diaryRunning) { diaryAgain = true; return diaryRunning; } // a run is going: it goes round once more
    diaryRunning = (async () => {
      try {
        do {
          diaryAgain = false;
          await diaryPass();
        } while (diaryAgain);
      } catch (e) {
        console.error(`Diary copier: ${e.message}`);
      } finally {
        diaryRunning = null;
      }
    })();
    return diaryRunning;
  }
  async function diaryPass() {
    for (const inv of repo.listDiaryPending()) {
      const jobUUID = repo.wholeJobOf(inv.id);
      if (inv.sm8_link === 'pulled' || !jobUUID || repo.isStockJob(jobUUID)
        || (inv.sm8_job_uuid && inv.sm8_job_uuid !== jobUUID) || inv.sm8_missing
        || (inv.sm8_note_uuid && (inv.sm8_attachment_uuid || !inv.file_path))) {
        repo.setDiary(inv.id, { diary_pending: 0 });
        continue;
      }
      if ((diaryRetryAt.get(inv.id) || 0) > Date.now()) continue; // failed a moment ago
      const token = await diaryToken(inv.account_uuid);
      if (!token) continue; // not approved yet: try again later
      try {
        const fields = { sm8_job_uuid: jobUUID, sm8_link: 'pushed' };
        if (inv.file_path && !inv.sm8_attachment_uuid) {
          const buffer = fs.readFileSync(path.join(repo.filesDir, inv.file_path));
          fields.sm8_attachment_uuid = await diaryApi.addJobFile({ jobUUID, name: inv.file_name || 'Invoice.pdf', buffer, contentType: inv.mime_type }, token);
          repo.setDiary(inv.id, fields);
        }
        if (!inv.sm8_note_uuid) {
          try {
            fields.sm8_note_uuid = await diaryApi.addJobNote({ jobUUID, text: diaryNoteText(inv) }, token);
          } catch (e) {
            if (!fields.sm8_attachment_uuid && !inv.sm8_attachment_uuid) throw e;
            console.error(`Diary note for invoice ${inv.id} not added: ${e.message}`); // the file is there; the note is a nice-to-have
          }
        }
        repo.setDiary(inv.id, { ...fields, diary_pending: 0 });
        diaryErrors.delete(inv.account_uuid ?? null);
        diaryRetryAt.delete(inv.id);
      } catch (e) {
        console.error(`Copy to ServiceM8 diary failed for invoice ${inv.id}: ${e.message}`);
        diaryErrors.set(inv.account_uuid ?? null, diaryProblem(e));
        diaryRetryAt.set(inv.id, Date.now() + 5 * 60000);
      }
    }
  }
  let diaryKick = null;
  const kickDiary = () => { if (!diaryKick) diaryKick = setTimeout(() => { diaryKick = null; syncDiary(); }, 1500); };
  app.locals.syncDiary = syncDiary;
  app.locals.startDiaryWorker = (seconds = 30) => setInterval(syncDiary, seconds * 1000).unref();

  /** Spot invoices whose diary file was deleted in ServiceM8 (asked about on the card). */
  async function checkDiaryDeletions(jobUUID, token) {
    const jobs = repo.familyJobUUIDs(jobUUID);
    const linked = repo.diaryLinked(jobs).filter((i) => i.sm8_attachment_uuid && !i.sm8_missing);
    if (!linked.length || !token) return;
    const live = new Set((await diaryApi.listJobFiles(jobs, token)).filter((f) => f.active).map((f) => f.uuid));
    for (const inv of linked) if (!live.has(inv.sm8_attachment_uuid)) repo.setDiary(inv.id, { sm8_missing: 1 });
  }

  const redirectUri = () => `${config.publicUrl}/servicem8/oauth/callback`;
  const sm8Notes = new Map(); // job -> why ServiceM8 info is missing (shown on the card)
  const htmlPage = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <body style="margin:0;background:#f4f7f6;font:15px/1.5 'Segoe UI',Arial,sans-serif;color:#17312b;display:flex;min-height:100vh;align-items:center;justify-content:center">
    <div style="background:#fff;border:1px solid #e3ece9;border-radius:18px;padding:28px 32px;max-width:460px;box-shadow:0 6px 18px rgba(16,40,34,.08)">${body}</div></body>`;

  // ---------- ServiceM8 ----------

  // Installing the add-on: ServiceM8 sends the user here; we ask ServiceM8 for approval.
  app.get('/servicem8/activate', (req, res) => {
    if (!config.servicem8AppId) {
      return res.status(500).type('html').send(htmlPage('Job Costs', '<h2>Almost there</h2><p>Set <b>SERVICEM8_APP_ID</b> (and <b>SERVICEM8_APP_SECRET</b>) in Render, then try again.</p>'));
    }
    res.redirect(approvalUrl(0));
  });

  // Permissions to ask for, best first. If ServiceM8 rejects one, the next (smaller) set is tried.
  const BASE_SCOPES = 'read_jobs read_customers read_job_materials';
  const scopeSets = () => [...new Set([config.servicem8Scopes, `${BASE_SCOPES} read_attachments manage_attachments read_job_notes publish_job_notes`,
    `${BASE_SCOPES} manage_attachments publish_job_notes`, `${BASE_SCOPES} manage_attachments`, BASE_SCOPES].map((x) => x.trim().replace(/\s+/g, ' ')))];
  function approvalUrl(attempt) {
    const state = jwt.sign({ purpose: 'sm8-oauth', attempt }, config.sessionSecret, { expiresIn: '15m' });
    return oauth.authorizeUrl({ appId: config.servicem8AppId, redirectUri: redirectUri(), scope: scopeSets()[attempt], state });
  }

  // ServiceM8 sends the user back here after they approve.
  app.get('/servicem8/oauth/callback', async (req, res) => {
    let st;
    try {
      st = jwt.verify(String(req.query.state || ''), config.sessionSecret);
      if (st.purpose !== 'sm8-oauth') throw new Error('bad state');
    } catch {
      return res.status(400).type('html').send(htmlPage('Job Costs', '<h2>That link has expired</h2><p>Please install / activate the add-on again from ServiceM8.</p>'));
    }
    const attempt = Number(st.attempt) || 0;
    if (/scope/i.test(`${req.query.error || ''} ${req.query.error_description || ''}`) && attempt + 1 < scopeSets().length) {
      console.log(`ServiceM8 rejected permissions "${scopeSets()[attempt]}"; trying "${scopeSets()[attempt + 1]}"`);
      return res.redirect(approvalUrl(attempt + 1));
    }
    if (req.query.error || !req.query.code) {
      return res.status(400).type('html').send(htmlPage('Job Costs', `<h2>Not connected</h2><p>ServiceM8 said: ${String(req.query.error_description || req.query.error || 'no approval code').replace(/</g, '&lt;')}</p>`));
    }
    try {
      const tokens = await oauth.exchangeCode({ appId: config.servicem8AppId, appSecret: config.servicem8AppSecret, code: String(req.query.code), redirectUri: redirectUri() });
      console.log(`ServiceM8 approved permissions: ${scopeSets()[attempt]}`);
      const diaryOk = /attachments/.test(scopeSets()[attempt]);
      const acc = await oauth.fetchAccount(tokens.accessToken);
      if (acc) {
        repo.saveTokens(acc.accountUUID, tokens);
        await syncJobs(acc.accountUUID, tokens.accessToken, { force: true }).catch(() => {});
      } else {
        // Couldn't tell which account: keep it until the first Job Costs click says.
        repo.savePendingTokens(tokens);
      }
      res.type('html').send(htmlPage('Job Costs connected', `<div style="font-size:40px">✅</div><h2 style="margin:6px 0">Job Costs is connected</h2>
        <p>${acc && acc.name ? `Connected to <b>${String(acc.name).replace(/</g, '&lt;')}</b>. ` : ''}Open any job in ServiceM8 and click <b>Job Costs</b>.</p>${diaryOk ? '' : '<p>Note: ServiceM8 didn\u2019t allow access to the job diary, so invoices won\u2019t be copied there.</p>'}<p style="color:#6b8a82">You can close this page.</p>`));
    } catch (e) {
      console.error(`ServiceM8 connect failed: ${e.message}`);
      res.status(502).type('html').send(htmlPage('Job Costs', `<h2>Couldn't connect to ServiceM8</h2><p>${String(e.message).replace(/</g, '&lt;')}</p><p>Check SERVICEM8_APP_ID and SERVICEM8_APP_SECRET in Render, then try again.</p>`));
    }
  });

  app.get('/manifest.json', (req, res) => {
    res.json({
      name: 'Job Costs',
      version: '1.0',
      iconURL: `${config.publicUrl}/icon.png`,
      supportURL: config.publicUrl,
      actions: [{ name: 'Job Costs', type: 'online', entity: 'job', iconURL: `${config.publicUrl}/icon.png`, event: 'job_costs_open' }],
    });
  });

  // ServiceM8 calls this when someone clicks "Job Costs" on a job card.
  app.post('/servicem8/addon', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    // ServiceM8 expects JSON: { eventResponse: "<html to show in the window>" }.
    const reply = (html) => res.set('Cache-Control', 'no-store').json({ eventResponse: html });
    let event;
    try {
      event = verifyEvent(req.body, config.servicem8AppSecret);
    } catch (e) {
      console.error(`ServiceM8 click rejected: ${e.message}`);
      return reply(`<div style="font-family:sans-serif;padding:16px"><b>Could not open Job Costs</b><p>${String(e.message).replace(/</g, '&lt;')}</p>
        <p>Check SERVICEM8_APP_SECRET in Render matches the add-on's App Secret.</p></div>`);
    }
    const claimed = repo.claimPendingTokens(event.accountUUID);
    let token = await accessTokenFor(event.accountUUID, event.accessToken);
    let info = await fetchJobImpl(event.jobUUID, token);
    // Saved access not working (e.g. revoked)? Try the pass that came with the click.
    if ((!info || info.linesError) && event.accessToken && event.accessToken !== token) {
      const alt = await fetchJobImpl(event.jobUUID, event.accessToken);
      if (alt && (!info || !alt.linesError)) { info = alt; token = event.accessToken; }
    }
    let job = repo.ensureJob({ jobUUID: event.jobUUID, accountUUID: event.accountUUID, ...(withStockFlag(info) || {}) });
    // A split part (#207974A) opens its main job (#207974): one Job Costs for the whole job.
    let partNote = null;
    const main = mainJobNumber(job.job_number);
    if (main) {
      let mainUUID = repo.findJobByNumber(job.account_uuid, main);
      if (!mainUUID) mainUUID = await findJobByNumberImpl(main, token);
      if (mainUUID) {
        const partUUID = job.job_uuid;
        const mainInfo = await fetchJobImpl(mainUUID, token);
        if (mainInfo) info = mainInfo;
        job = repo.ensureJob({ jobUUID: mainUUID, accountUUID: event.accountUUID, ...(withStockFlag(mainInfo) || { jobNumber: main }) });
        // Anything added on the split part itself (e.g. before parts were linked) belongs to the main job.
        repo.mergeJobInto(partUUID, mainUUID);
      } else {
        partNote = `This looks like part of job #${main}, but that job couldn\u2019t be found in ServiceM8, so it\u2019s shown on its own.`;
      }
    }
    repo.ensureAccount(job.account_uuid);
    if (event.accessToken) eventTokens.set(job.account_uuid ?? null, event.accessToken);
    // Remember what ServiceM8 said, so the window can explain a missing price.
    sm8Notes.set(job.job_uuid, partNote || (!token ? 'Job Costs isn\u2019t approved in ServiceM8 yet: open the add-on\u2019s install link and approve it.'
      : (info && info.linesError) || (!info ? 'Couldn\u2019t read this job from ServiceM8.' : null)));
    // Sync jobs in the background; wait at most a moment so the card opens quickly.
    const sync = Promise.all([
      syncJobs(job.account_uuid, token, { force: claimed }).catch(() => {}),
      checkDiaryDeletions(job.job_uuid, token).catch((e) => console.error(`Diary check failed: ${e.message}`)),
    ]);
    kickDiary();
    await Promise.race([sync, new Promise((r) => setTimeout(r, 1500))]);
    // The window shows our page (from our own address, so everything on it works),
    // and asks ServiceM8 to make the window big enough.
    const url = `${config.publicUrl}/card?t=${encodeURIComponent(sessionToken(job.job_uuid))}`;
    reply(`<script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>
<script>try { SMClient.init().resizeWindow(1320, 860); } catch (e) {}</script>
<iframe src="${url}" title="Job Costs" style="position:fixed;top:0;left:0;width:100%;height:100%;border:0" allow="clipboard-write"></iframe>`);
  });

  // The Job Costs window itself (opened inside ServiceM8's window, using the click's session).
  app.get('/card', (req, res) => {
    const job = jobFromToken(req.query.t);
    if (!job) return res.status(401).type('html').send('<p style="font-family:sans-serif">Session expired. Close this window and click Job Costs again.</p>');
    renderCard(res, job, { embedded: false });
  });

  // Reports and Inbox pages (opened from the card, using the card's session).
  for (const name of ['report', 'inbox']) {
    app.get(`/${name}`, (req, res) => {
      if (!jobFromToken(req.query.t)) {
        return res.status(401).type('html').send('<p style="font-family:sans-serif">Session expired. Open Job Costs from a job in ServiceM8 and try again.</p>');
      }
      const boot = { token: String(req.query.t), reasons: MISTAKE_REASONS, categories: CATEGORIES };
      res.set('Cache-Control', 'no-store').type('html').send(inject(PAGES[name], boot));
    });
  }

  // Local testing without ServiceM8.
  app.get('/dev/job/:jobUUID', (req, res) => {
    if (!config.devMode) return res.status(404).send('Not found');
    const job = repo.ensureJob({ jobUUID: req.params.jobUUID, jobNumber: req.query.number || null, jobTitle: req.query.title || null,
      quoteAmount: req.query.quote ? Number(req.query.quote) : null });
    repo.ensureAccount(job.account_uuid);
    renderCard(res, job, { embedded: false });
  });

  // ---------- Card API ----------
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(requireSession);
  // After any change, the diary copier takes a look (it only acts on invoices flagged for it).
  api.use((req, res, next) => { if (req.method !== 'GET') res.on('finish', kickDiary); next(); });

  api.get('/job', (req, res) => {
    const summary = repo.getJobSummary(req.job.job_uuid);
    const acc = repo.ensureAccount(req.account);
    res.json({ ...summary, splitParts: repo.splitParts(req.account, req.job.job_number), sm8Note: sm8Notes.get(req.job.job_uuid) || null,
      diaryNote: diaryErrors.get(req.account) || null,
      inboxAddress: inboxAddress(acc.inbox_code, config), inboxCount: repo.inboxCount(req.account),
      jobs: repo.listJobs(req.account).filter((j) => j.job_uuid !== req.job.job_uuid) });
  });

  api.patch('/job', (req, res) => {
    const { quote_amount, is_stock } = req.body || {};
    // "This is a stock order job" switch: true / false, or null for automatic.
    if (is_stock !== undefined) {
      if (is_stock !== null && typeof is_stock !== 'boolean') return res.status(400).json({ error: 'is_stock must be true, false or null' });
      repo.setStockManual(req.job.job_uuid, is_stock);
      if (quote_amount === undefined) return res.json({ ok: true });
    }
    if (quote_amount === null || quote_amount === '') repo.setQuote(req.job.job_uuid, null);
    else {
      const q = money(quote_amount);
      if (!isFinite(q) || q < 0) return res.status(400).json({ error: 'Quoted price must be a number' });
      repo.setQuote(req.job.job_uuid, q);
    }
    res.json({ ok: true });
  });

  // Everything not assigned to a job yet (whole invoices, and what's left on lines).
  api.get('/unassigned', (req, res) => {
    res.json(repo.getUnassigned(req.account, req.job.job_uuid));
  });

  /**
   * Add costs to this job:
   *   { invoice_id, category?, mistake_reason? }              -> everything still left on that invoice
   *   { item_id, quantity | amount, category?, mistake_reason? } -> part of one line, added to what this job has
   */
  api.post('/assign', (req, res) => {
    const b = req.body || {};
    const c = parseCategory(b.category);
    const m = parseReason(b.mistake_reason);
    if (c.error || m.error) return res.status(400).json({ error: c.error || m.error });
    const fields = { ...(c.skip ? {} : { category: c.category }), ...(m.skip ? {} : { mistake_reason: m.reason }) };
    if (b.invoice_id != null) {
      const inv = accountInvoice(req, res, b.invoice_id);
      if (!inv) return;
      if (inv.status !== 'ready') return res.status(400).json({ error: 'Wait until the invoice has been read' });
      repo.assignWhole(inv.id, req.job.job_uuid, fields);
      return res.json({ ok: true, invoice_id: inv.id });
    }
    const item = accountItem(req, res, b.item_id);
    if (!item) return;
    const extra = fractionFrom(item, b);
    if (extra == null || !isFinite(extra) || extra <= 0) return res.status(400).json({ error: 'Enter how much to add' });
    try {
      repo.addShare(item.id, req.job.job_uuid, extra, fields);
    } catch (e) {
      if (e.status !== 400) throw e;
      const mine = repo.getShare(item.id, req.job.job_uuid)?.fraction || 0;
      return res.status(400).json({ error: `${e.message} (${leftText(item, Math.max(0, e.left - mine))})` });
    }
    res.json({ ok: true, invoice_id: item.invoice_id });
  });

  // Change how much of a line this job has. { quantity } or { amount }; 0 takes it off the job.
  api.put('/items/:id/share', (req, res) => {
    const item = accountItem(req, res);
    if (!item) return;
    const fraction = fractionFrom(item, req.body);
    if (fraction == null || !isFinite(fraction)) return res.status(400).json({ error: 'Enter a quantity or an amount' });
    try {
      repo.setShare(item.id, req.job.job_uuid, fraction);
    } catch (e) {
      if (e.status !== 400) throw e;
      return res.status(400).json({ error: `${e.message} (${leftText(item, e.left)})` });
    }
    res.json({ ok: true });
  });

  // Type / screw-up of this job's share of a line; description / amount of the line itself.
  api.patch('/items/:id', (req, res) => {
    const item = accountItem(req, res);
    if (!item) return;
    const { description, line_total, category, mistake_reason } = req.body || {};
    const c = parseCategory(category);
    const m = parseReason(mistake_reason);
    if (c.error || m.error) return res.status(400).json({ error: c.error || m.error });
    const lt = line_total === undefined || line_total === '' ? undefined : Number(line_total);
    if (lt !== undefined && !isFinite(lt)) return res.status(400).json({ error: 'Amount must be a number' });
    if (!c.skip || !m.skip) {
      if (!repo.getShare(item.id, req.job.job_uuid)) return res.status(400).json({ error: 'This line is not on this job' });
      repo.setShareFields(item.id, req.job.job_uuid, { ...(c.skip ? {} : { category: c.category }), ...(m.skip ? {} : { mistake_reason: m.reason }) });
    }
    if (description !== undefined || lt !== undefined) repo.updateItem(item.id, { description, line_total: lt });
    res.json({ ok: true });
  });

  api.patch('/invoices/:id', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    const { paid, supplier, invoice_number, total, mistake_reason, category } = req.body || {};
    const m = parseReason(mistake_reason);
    const c = parseCategory(category);
    if (m.error || c.error) return res.status(400).json({ error: m.error || c.error });
    const t = total === undefined || total === '' ? undefined : Number(total);
    if (t !== undefined && !isFinite(t)) return res.status(400).json({ error: 'Total must be a number' });
    if (typeof paid === 'boolean') repo.setInvoicePaid(inv.id, paid);
    // Type and screw-up apply to this job's share of the invoice.
    if (!m.skip) repo.setInvoiceShareFields(inv.id, req.job.job_uuid, { mistake_reason: m.reason });
    if (!c.skip) {
      repo.setInvoiceShareFields(inv.id, req.job.job_uuid, { category: c.category });
      repo.setInvoiceCategory(inv.id, c.category);
    }
    if (supplier !== undefined || invoice_number !== undefined || t !== undefined) repo.updateInvoice(inv.id, { supplier, invoice_number, total: t });
    res.json({ ok: true });
  });

  // Take an invoice off this job (it goes back to "not assigned yet"),
  // or with ?completely=1 delete it, if no other job has part of it.
  // ?diary=1 also removes its file and note from the ServiceM8 job diary.
  api.delete('/invoices/:id', async (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (req.query.completely) {
      const others = repo.jobsOnInvoice(inv.id).filter((j) => j.job_uuid !== req.job.job_uuid);
      if (others.length) return res.status(409).json({ error: `Other jobs have part of this invoice (${jobList(others)}). Take it off those jobs first.` });
    }
    let diaryWarning = null;
    if (req.query.diary && (inv.sm8_attachment_uuid || inv.sm8_note_uuid)) {
      try {
        const token = await diaryToken(req.account);
        if (!token) throw new Error('401');
        const gone = (e) => /\b404\b/.test(e.message); // already deleted there: fine
        if (inv.sm8_attachment_uuid && !inv.sm8_missing) await diaryApi.removeJobFile(inv.sm8_attachment_uuid, token).catch((e) => { if (!gone(e)) throw e; });
        if (inv.sm8_note_uuid) await diaryApi.removeJobNote(inv.sm8_note_uuid, token).catch((e) => { if (!gone(e)) throw e; });
        repo.setDiary(inv.id, { sm8_attachment_uuid: null, sm8_note_uuid: null, sm8_job_uuid: null, sm8_link: null, sm8_missing: 0, diary_pending: 0 });
      } catch (e) {
        diaryWarning = `Removed from Job Costs, but not from the ServiceM8 diary: ${diaryProblem(e)}`;
      }
    }
    if (req.query.completely) {
      repo.deleteInvoice(inv.id);
      return res.json({ ok: true, deleted: true, diaryWarning });
    }
    repo.removeFromJob(inv.id, req.job.job_uuid);
    if (inv.stock_job_uuid === req.job.job_uuid) repo.unlinkStock(inv.id);
    // An upload that was never read can't be "unassigned" – it's simply removed.
    if (inv.status !== 'ready' && inv.origin_job_uuid === req.job.job_uuid) repo.deleteInvoice(inv.id);
    res.json({ ok: true, diaryWarning });
  });

  // Deleted in the ServiceM8 diary, but keep it in Job Costs: forget the link.
  api.post('/invoices/:id/diary-keep', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    repo.setDiary(inv.id, { sm8_attachment_uuid: null, sm8_note_uuid: null, sm8_job_uuid: null, sm8_link: null, sm8_missing: 0, diary_pending: 0 });
    res.json({ ok: true });
  });

  // PDFs and photos in this job's ServiceM8 diary (and its split parts'), to add as invoices.
  const diaryCache = new Map(); // job -> { at, files } (so previews don't ask ServiceM8 every time)
  async function diaryFiles(req, { cached = false } = {}) {
    const hit = diaryCache.get(req.job.job_uuid);
    const token = await diaryToken(req.account);
    if (cached && hit && token && Date.now() - hit.at < 5 * 60000) return { token, files: hit.files };
    if (!token) { const e = new Error('Job Costs isn\u2019t approved in ServiceM8 yet: open the add-on\u2019s install link and approve it.'); e.status = 400; throw e; }
    const files = (await diaryApi.listJobFiles(repo.familyJobUUIDs(req.job.job_uuid), token))
      .filter((f) => f.active && isSupported(f.name + (/\.[a-z0-9]+$/i.test(f.name) ? '' : f.file_type), guessMime(f.name + (/\.[a-z0-9]+$/i.test(f.name) ? '' : f.file_type))));
    diaryCache.set(req.job.job_uuid, { at: Date.now(), files });
    return { token, files };
  }

  /**
   * Your own paperwork in the diary (ServiceM8 quotes / invoices / work orders for this job) and
   * quotes are hidden by default: they aren't supplier costs.
   */
  function diaryKind(f, jobNumbers) {
    const text = `${f.name} ${f.source}`;
    const docWord = /\b(invoice|quote|quotation|work\s*order|proposal|job\s*sheet)\b/i.test(text);
    const mentionsJob = jobNumbers.some((n) => n && new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(f.name));
    if ((docWord && mentionsJob) || /\b(invoice|quote|proposal|work\s*order)\b/i.test(f.source)) return 'own';
    if (/\bquot(e|ation)\b/i.test(f.name)) return 'quote';
    return 'file';
  }
  const fileExt = (f) => (/\.[a-z0-9]+$/i.test(f.name) ? f.name.match(/\.[a-z0-9]+$/i)[0] : (f.file_type || '')).toLowerCase();
  api.get('/diary', async (req, res) => {
    let r;
    try { r = await diaryFiles(req); } catch (e) { return res.status(e.status || 502).json({ error: e.status ? e.message : diaryProblem(e) }); }
    const jobs = new Map(repo.familyJobUUIDs(req.job.job_uuid).map((u) => [u, repo.getJob(u)?.job_number || null]));
    const numbers = [...new Set([...jobs.values()].filter(Boolean).map((n) => String(n).match(/^\d+/)?.[0]).filter(Boolean))];
    res.json({
      files: r.files.map((f) => {
        const inv = repo.invoiceByAttachment(f.uuid);
        const ext = fileExt(f);
        return { uuid: f.uuid, name: f.name, date: f.date, job_number: jobs.get(f.job_uuid), invoice_id: inv ? inv.id : null, pushed: inv?.sm8_link === 'pushed',
          kind: inv?.sm8_link === 'pushed' ? 'file' : diaryKind(f, numbers), is_photo: /^\.(jpe?g|png|gif|webp)$/.test(ext), is_pdf: ext === '.pdf' };
      }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
    });
  });
  // Look at a diary file before adding it (photos show as thumbnails, PDFs in the viewer).
  api.get('/diary/:uuid/file', async (req, res) => {
    let r;
    try { r = await diaryFiles(req, { cached: true }); } catch (e) { return res.status(e.status || 502).json({ error: e.status ? e.message : diaryProblem(e) }); }
    const f = r.files.find((x) => x.uuid === req.params.uuid);
    if (!f) return res.status(404).json({ error: 'That file isn\u2019t in this job\u2019s diary' });
    try {
      const file = await diaryApi.downloadJobFile(f.uuid, r.token);
      const byName = guessMime(f.name + (/\.[a-z0-9]+$/i.test(f.name) ? '' : f.file_type), '');
      const type = byName !== 'application/octet-stream' ? byName : (file.contentType || byName);
      res.set('Cache-Control', 'private, max-age=600').type(type).send(file.buffer);
    } catch (e) {
      res.status(502).json({ error: diaryProblem(e) });
    }
  });
  api.post('/diary/:uuid/import', async (req, res) => {
    const existing = repo.invoiceByAttachment(req.params.uuid);
    if (existing && (existing.account_uuid ?? null) === req.account) return res.json({ id: existing.id, already: true });
    let r;
    try { r = await diaryFiles(req); } catch (e) { return res.status(e.status || 502).json({ error: e.status ? e.message : diaryProblem(e) }); }
    const f = r.files.find((x) => x.uuid === req.params.uuid);
    if (!f) return res.status(404).json({ error: 'That file isn\u2019t in this job\u2019s diary' });
    let file;
    try { file = await diaryApi.downloadJobFile(f.uuid, r.token); } catch (e) { return res.status(502).json({ error: diaryProblem(e) }); }
    const name = /\.[a-z0-9]+$/i.test(f.name) ? f.name : f.name + (f.file_type || '');
    const inv = addInvoiceFile({ accountUUID: req.account, originJobUUID: req.job.job_uuid, source: 'diary', name, contentType: file.contentType, buffer: file.buffer });
    repo.setDiary(inv.id, { sm8_attachment_uuid: f.uuid, sm8_job_uuid: f.job_uuid, sm8_link: 'pulled' });
    res.status(201).json({ id: inv.id });
  });

  api.get('/invoices/:id/file', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (!inv.file_path) return res.status(404).json({ error: 'No file' });
    res.type(inv.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${safeName(inv.file_name)}"`);
    res.sendFile(path.join(repo.filesDir, inv.file_path));
  });

  // Upload on a job: read, then put on this job.
  api.post('/invoices', upload.array('files', 30), (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });
    const created = files.map((f) => addInvoiceFile({
      accountUUID: req.account, originJobUUID: req.job.job_uuid, source: 'upload', name: f.originalname, contentType: f.mimetype, buffer: f.buffer,
    }));
    res.status(201).json({ created: created.map((i) => i.id) });
  });

  // An invoice typed in by hand (e.g. the paper copy was lost); it goes on this job.
  // Lines are optional; whatever they don't cover shows as "Other items (not listed)".
  api.post('/invoices/manual', (req, res) => {
    const b = req.body || {};
    const supplier = String(b.supplier || '').trim().slice(0, 200);
    if (!supplier) return res.status(400).json({ error: 'Supplier is required' });
    const date = String(b.invoice_date || '');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    const c = parseCategory(b.category || 'materials');
    const mk = parseReason(b.mistake_reason);
    if (c.error || mk.error) return res.status(400).json({ error: c.error || mk.error });

    const lines = [];
    for (const l of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
      const description = String(l?.description || '').trim().slice(0, 500);
      const amount = money(l?.amount);
      if (!description && amount == null) continue; // empty row
      if (!description) return res.status(400).json({ error: 'Each line needs a description' });
      if (amount == null || !isFinite(amount)) return res.status(400).json({ error: `Enter an amount for "${description}"` });
      lines.push({ description, category: c.category, line_total: amount });
    }
    const listed = lines.reduce((sum, l) => sum + l.line_total, 0);
    let total = money(b.total);
    if (total != null && !isFinite(total)) return res.status(400).json({ error: 'Total must be a number' });
    if (total == null) total = listed;
    if (!lines.length && !total) return res.status(400).json({ error: 'Enter the total or at least one line' });
    if (listed - total > 0.005) return res.status(400).json({ error: 'The lines add up to more than the total' });
    if (total - listed > 0.005) lines.push({ description: lines.length ? 'Other items (not listed)' : `Invoice from ${supplier}`, category: c.category, line_total: Math.round((total - listed) * 100) / 100 });

    const gst = b.includes_gst === false ? 0 : Math.round(total / 11 * 100) / 100;
    const inv = repo.createInvoice({ accountUUID: req.account, originJobUUID: req.job.job_uuid, source: 'manual' });
    repo.saveExtraction(inv.id, {
      document_type: 'manual', supplier_name: supplier, invoice_number: String(b.invoice_number || '').trim().slice(0, 100) || null,
      invoice_date: date || null, currency: 'AUD', subtotal: Math.round((total - gst) * 100) / 100, tax: gst, total,
      notes: 'Added by hand – no invoice file.', items: lines,
    });
    repo.setInvoiceCategory(inv.id, c.category);
    repo.assignWhole(inv.id, req.job.job_uuid, { category: c.category, ...(mk.skip ? {} : { mistake_reason: mk.reason }) });
    if (b.paid === true) repo.setInvoicePaid(inv.id, true);
    res.status(201).json({ id: inv.id });
  });

  // Found the paper invoice for one that was added by hand: attach it and read it.
  api.post('/invoices/:id/file', upload.single('file'), (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (inv.file_path) return res.status(400).json({ error: 'This invoice already has a file' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mimeType = guessMime(req.file.originalname, req.file.mimetype);
    if (!isSupported(req.file.originalname, mimeType)) return res.status(400).json({ error: 'Unsupported file type. Use a PDF or a photo (JPG/PNG).' });
    repo.attachFile(inv.id, { fileName: req.file.originalname, mimeType, filePath: saveFile(folderFor(req.account), req.file.originalname, req.file.buffer) });
    processor.enqueue(inv.id);
    res.json({ ok: true });
  });

  api.post('/invoices/:id/reanalyze', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (!inv.file_path) return res.status(400).json({ error: 'This invoice was added by hand, so there is no file to read' });
    if (!isSupported(inv.file_name, inv.mime_type)) return res.status(400).json({ error: 'Unsupported file type' });
    processor.enqueue(inv.id);
    res.json({ ok: true });
  });

  // One-click suggestions shown on a job card.
  api.post('/suggestions/:id/accept', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    repo.assignWhole(inv.id, req.job.job_uuid, { category: inv.category });
    res.json({ ok: true });
  });
  api.post('/suggestions/:id/dismiss', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    repo.dismissSuggestion(inv.id);
    res.json({ ok: true });
  });

  // ---------- Inbox (all invoices not assigned yet, for the whole business) ----------
  api.get('/inbox', (req, res) => {
    const acc = repo.ensureAccount(req.account);
    res.json({ ...repo.getUnassigned(req.account), jobs: repo.listJobs(req.account), inboxAddress: inboxAddress(acc.inbox_code, config) });
  });
  api.post('/inbox/:id/assign', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    const job = repo.getJob(String(req.body?.job_uuid || ''));
    if (!job || (job.account_uuid ?? null) !== req.account) return res.status(400).json({ error: 'Choose a job' });
    const c = parseCategory(req.body?.category);
    if (c.error) return res.status(400).json({ error: c.error });
    if (inv.status !== 'ready') return res.status(400).json({ error: 'Wait until the invoice has been read' });
    repo.assignWhole(inv.id, job.job_uuid, { category: c.category || inv.category });
    res.json({ ok: true });
  });
  api.post('/inbox/:id/stock', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    repo.keepAsStock(inv.id);
    res.json({ ok: true });
  });
  api.delete('/inbox/:id', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    const jobs = repo.jobsOnInvoice(inv.id);
    if (jobs.length) return res.status(409).json({ error: `Part of this invoice is on ${jobList(jobs)}. Take it off those jobs first.` });
    repo.deleteInvoice(inv.id);
    res.json({ ok: true });
  });

  // Outlook connection status (shown on the card and the Inbox).
  api.get('/outlook', (req, res) => {
    const o = repo.getOutlook(req.account);
    res.json({ available: !!(config.msClientId && config.msClientSecret), connected: !!(o && o.refresh_token),
      email: o?.email || null, lastCheck: o?.last_check || null, error: o?.error || null });
  });
  api.delete('/outlook', (req, res) => { repo.removeOutlook(req.account); res.json({ ok: true }); });

  // Reports across all jobs of the business.
  api.get('/report', (req, res) => {
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    res.json(repo.getReport(req.account, { from: date(req.query.from), to: date(req.query.to) }));
  });

  app.use('/api', api);

  // Opened in a browser by mistake: explain instead of "Cannot GET".
  app.get('/inbound/email', (req, res) => {
    res.type('text').send('This is the address Postmark sends invoice emails to. Paste it (with ?key=...) into Postmark\'s inbound webhook setting - it is not a page to open in a browser.');
  });

  // ---------- Incoming email (Postmark webhook, or the mailbox the app checks) ----------

  /**
   * File an email's invoices for the business it was sent to. The address's code says
   * which business; with no code (a mailbox the app checks), it's the only business.
   */
  function processMail(mail, { fallbackToOnlyAccount = false, accountUUID, source = 'email' } = {}) {
    let accounts = accountUUID !== undefined ? [{ accountUUID }] : [...new Map(codesFromAddresses(mail.recipients || []).map((c) => repo.accountByInboxCode(c)).filter(Boolean)
      .map((a) => [a.accountUUID ?? '', a])).values()];
    if (!accounts.length && fallbackToOnlyAccount) {
      const only = repo.defaultAccount();
      if (only) accounts = [only];
    }
    if (!accounts.length) return { matched: 0, created: 0 };

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
    for (const acc of accounts) {
      for (const f of files) {
        addInvoiceFile({
          accountUUID: acc.accountUUID, source, name: f.name, contentType: f.contentType, buffer: f.buffer,
          emailFrom: mail.from, emailSubject: mail.subject, emailText: body,
        });
        created++;
      }
    }
    return { matched: accounts.length, created };
  }
  app.locals.processMail = processMail;

  // ---------- Outlook (Microsoft 365) ----------
  const msApp = () => ({ clientId: config.msClientId, clientSecret: config.msClientSecret, tenant: config.msTenantId });
  const outlookRedirect = () => `${config.publicUrl}/outlook/callback`;
  let outlookRunning = null; // one check at a time, so an email is never picked up twice
  app.locals.checkOutlook = () => {
    if (!outlookRunning) {
      outlookRunning = outlook.checkOutlook({
        repo, config, api: outlookApi,
        onMail: (mail, account) => processMail(mail, { accountUUID: account || null, source: 'outlook' }),
      }).finally(() => { outlookRunning = null; });
    }
    return outlookRunning;
  };

  // "Connect Outlook" (opened from the card): sign in to Microsoft and allow reading mail.
  app.get('/outlook/connect', (req, res) => {
    const job = jobFromToken(req.query.t);
    if (!job) return res.status(401).type('html').send(htmlPage('Job Costs', '<h2>Session expired</h2><p>Open Job Costs from a job in ServiceM8 and try again.</p>'));
    if (!config.msClientId || !config.msClientSecret) {
      return res.status(500).type('html').send(htmlPage('Job Costs', '<h2>Almost there</h2><p>Set <b>MS_CLIENT_ID</b>, <b>MS_CLIENT_SECRET</b> and <b>MS_TENANT_ID</b> in Render (see the README), then try again.</p>'));
    }
    const state = jwt.sign({ purpose: 'outlook', account: job.account_uuid ?? null }, config.sessionSecret, { expiresIn: '15m' });
    res.redirect(outlookApi.authorizeUrl({ clientId: config.msClientId, tenant: config.msTenantId, redirectUri: outlookRedirect(), state }));
  });
  app.get('/outlook/callback', async (req, res) => {
    let st;
    try {
      st = jwt.verify(String(req.query.state || ''), config.sessionSecret);
      if (st.purpose !== 'outlook') throw new Error('bad state');
    } catch {
      return res.status(400).type('html').send(htmlPage('Job Costs', '<h2>That link has expired</h2><p>Click <b>Connect Outlook</b> in Job Costs again.</p>'));
    }
    if (req.query.error || !req.query.code) {
      return res.status(400).type('html').send(htmlPage('Job Costs', `<h2>Outlook not connected</h2><p>Microsoft said: ${String(req.query.error_description || req.query.error || 'no approval code').replace(/</g, '&lt;')}</p>`));
    }
    try {
      const tokens = await outlookApi.exchangeCode(msApp(), { code: String(req.query.code), redirectUri: outlookRedirect() });
      const me = await outlookApi.fetchMe(tokens.accessToken);
      repo.removeOutlook(st.account);
      repo.saveOutlook(st.account, { ...tokens, email: me.email, name: me.name, connectedAt: new Date().toISOString() });
      app.locals.checkOutlook().catch(() => {});
      res.type('html').send(htmlPage('Outlook connected', `<div style="font-size:40px">✅</div><h2 style="margin:6px 0">Outlook is connected</h2>
        <p>Job Costs now checks <b>${String(me.email || 'your inbox').replace(/</g, '&lt;')}</b> every couple of minutes, keeps the invoices and ignores everything else. It only reads – it never changes or deletes your emails.</p>
        <p>New invoices show up in the Job Costs <b>Inbox</b> with a suggested job (or stock), waiting for your OK.</p><p style="color:#6b8a82">You can close this page.</p>`));
    } catch (e) {
      console.error(`Outlook connect failed: ${e.message}`);
      res.status(502).type('html').send(htmlPage('Job Costs', `<h2>Couldn't connect Outlook</h2><p>${String(e.message).replace(/</g, '&lt;')}</p><p>Check MS_CLIENT_ID, MS_CLIENT_SECRET and MS_TENANT_ID in Render, then try again.</p>`));
    }
  });

  // Postmark (or SendGrid / Mailgun) webhook.
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
      const r = processMail(parseInboundEmail(req));
      res.json({ ok: true, ...r });
    });

  // PDF.js, for drawing invoice PDFs in the preview (browsers won't show PDFs inside ServiceM8's window).
  app.use('/vendor/pdfjs', express.static(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build'), {
    index: false, maxAge: '7d',
    setHeaders: (res, file) => { if (file.endsWith('.mjs')) res.type('text/javascript'); },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.get('/', (req, res) => res.type('text').send('Job Costs add-on for ServiceM8 is running.'));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files must be under ${MAX_FILE_MB} MB` : err.message });
    }
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
