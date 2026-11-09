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
const { duplicateMessage } = require('./processor');
const { exportEverything } = require('./export');
const mailbox = require('./mailbox');
const { MISTAKE_REASONS, REASON_CODES } = require('./mistakes');
const { mainJobNumber } = require('./db');

const MAX_FILE_MB = 25;
const page = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
const PAGES = { card: page('card.html'), report: page('report.html'), inbox: page('inbox.html'), bills: page('bills.html'), checks: page('checks.html'), summary: page('summary.html'), prices: page('prices.html'), stock: page('stock.html'), home: page('home.html'), settings: page('settings.html'), welcome: page('welcome.html') };

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
  findJobByNumberImpl = sm8.findJobByNumber, diaryApi = sm8, outlookApi = outlook.graphApi, checker = null, imapClient = mailbox.makeClient }) {
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
  // Opened from the Add-ons menu / the app's More tab: the business, no job.
  const accountToken = (accountUUID) => jwt.sign({ accountUUID: accountUUID ?? '', scope: 'account' }, config.sessionSecret, { expiresIn: '12h' });
  const inject = (html, boot) => html.replace('/*__BOOT__*/null', JSON.stringify(boot).replace(/</g, '\\u003c'));

  function renderCard(res, job, { embedded, select = null, back = null }) {
    const boot = { token: sessionToken(job.job_uuid), embedded, categories: CATEGORIES, reasons: MISTAKE_REASONS, select, back };
    const html = inject(PAGES.card, boot)
      .replace('<!--__SM8_SDK__-->', embedded ? '<script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>' : '');
    res.set('Cache-Control', 'no-store').type('html').send(html);
  }

  const jobFromToken = (token) => {
    try { const p = jwt.verify(String(token || ''), config.sessionSecret); return p.jobUUID ? repo.getJob(p.jobUUID) || null : null; } catch { return null; }
  };
  /** Who a token is for: { job, account } from a job's button, { job: null, account } from the menu. */
  const sessionFrom = (token) => {
    let p;
    try { p = jwt.verify(String(token || ''), config.sessionSecret); } catch { return null; }
    if (p.jobUUID) { const job = repo.getJob(p.jobUUID); return job ? { job, account: job.account_uuid ?? null } : null; }
    if (p.scope === 'account' && repo.db.prepare('SELECT 1 FROM accounts WHERE account_key = ?').get(p.accountUUID ?? '')) {
      return { job: null, account: p.accountUUID === '' ? null : p.accountUUID };
    }
    return null;
  };
  // Things that only make sense on one job (the menu's business-wide pages don't use them).
  const needsJob = (method, p) => p === '/job' || /^\/(unassigned|assign$|items\/|diary|suggestions\/|invoices\/manual|invoices\/?$)/.test(p)
    || (/^\/invoices\/\d+$/.test(p) && method !== 'GET') || /^\/invoices\/\d+\/diary-keep/.test(p);

  // Card API auth: short-lived token handed to the card when ServiceM8 opened it.
  function requireSession(req, res, next) {
    const header = req.get('authorization') || '';
    const sess = sessionFrom(header.startsWith('Bearer ') ? header.slice(7) : req.query.t);
    if (!sess) return res.status(401).json({ error: 'Session expired. Close and reopen Job Costs from ServiceM8.' });
    if (!sess.job && needsJob(req.method, req.path)) return res.status(400).json({ error: 'Open Job Costs from a job to do this.' });
    const job = sess.job;
    // Keep the window working while it's open: a fresh token once the one in use is over an hour old.
    try {
      const { iat } = jwt.decode(header.startsWith('Bearer ') ? header.slice(7) : String(req.query.t || '')) || {};
      if (iat && Date.now() / 1000 - iat > 3600) res.set('X-Session-Token', job ? sessionToken(job.job_uuid) : accountToken(sess.account));
    } catch { /* keep the old one */ }
    req.job = job;
    req.account = sess.account;
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
  // Starting settings for a new business (each business changes them in ⚙ Settings)
  if (config.defaultTimezone) repo.settingDefaults.timezone = config.defaultTimezone;
  if (config.stockJobClients && config.stockJobClients.length) repo.settingDefaults.stock_clients = config.stockJobClients;
  if (config.stockJobCategories && config.stockJobCategories.length) repo.settingDefaults.stock_categories = config.stockJobCategories;
  /** A business's settings, in the shape the older code expects. */
  const settingsFor = (accountUUID) => repo.getSettings(accountUUID);
  const stockWords = (accountUUID) => { const st = settingsFor(accountUUID); return { stockJobClients: st.stock_clients || [], stockJobCategories: st.stock_categories || [] }; };
  const hoursOf = (accountUUID) => { const st = settingsFor(accountUUID);
    return { outlookTimezone: st.timezone, outlookDays: st.check_days, outlookFromHour: Number(st.check_from), outlookToHour: Number(st.check_to), outlookPollSeconds: config.outlookPollSeconds }; };
  const withStockFlag = (info, accountUUID) => (info && (info.clientName || info.categoryName)
    ? { ...info, stockAuto: looksLikeStockJob(info, stockWords(accountUUID)) } : info);

  // Keep a list of the business's active jobs, so emailed invoices can be matched to them.
  async function syncJobs(accountUUID, accessToken, { force = false } = {}) {
    if (!accessToken || (!force && repo.jobsSyncedRecently(accountUUID, 10))) return;
    const jobs = await fetchActiveJobsImpl(accessToken);
    if (jobs.length) repo.saveSyncedJobs(accountUUID, jobs.map((j) => withStockFlag(j, accountUUID)));
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
  const diaryProblem = (e) => (/\b429\b/.test(e.message) ? 'ServiceM8 is busy right now (too many requests). Job Costs will try again in a minute.'
    : /\b(401|403)\b/.test(e.message)
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
          await summaryPass();
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
        diaryRetryAt.set(inv.id, Date.now() + (/\b429\b/.test(e.message) ? 60000 : 5 * 60000));
      }
    }
  }
  /** The summary note for a job's diary (plain text; ServiceM8 shows it as written). */
  function summaryText(jobUUID, accountUUID) {
    const sm = repo.getJobSummary(jobUUID);
    const t = sm.totals || {};
    const tz = settingsFor(accountUUID).timezone || 'UTC';
    const m = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const when = new Date().toLocaleString('en-AU', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const bills = (sm.invoices || []).filter((i) => i.status === 'ready' && !i.duplicate_of);
    const lines = [`Job Costs summary (updated ${when})`,
      `Costs: ${m(t.total)} ex GST from ${t.invoiceCount || 0} bill${t.invoiceCount === 1 ? '' : 's'}`,
      `Paid: ${m(t.paid)} · Still to pay: ${m(t.outstanding)}`];
    if (t.quote != null) lines.push(`Quoted: ${m(t.quote)} ex GST · Profit so far: ${m(t.margin)} (${t.marginPct}%)`);
    if (t.mistakes > 0.004) lines.push(`Screw-ups: ${m(t.mistakes)}`);
    const flagged = repo.checkFlagsFor(accountUUID, bills.map((i) => i.id)).size;
    if (flagged) lines.push(`⚠ ${flagged} bill${flagged === 1 ? '' : 's'} flagged by a statement check`);
    return { text: lines.join('\n').slice(0, 1000), empty: !bills.length && t.quote == null };
  }
  async function summaryPass() {
    for (const row of repo.dirtySummaries()) {
      const acc = row.account_uuid ?? null;
      if (!row.known) { repo.clearSummaryDirty(row.job_uuid); continue; } // job not in Job Costs
      if (!settingsFor(acc).diary_summary || repo.isStockJob(row.job_uuid)) { repo.clearSummaryDirty(row.job_uuid); continue; }
      const { text, empty } = summaryText(row.job_uuid, acc);
      const same = row.text && row.text.split('\n').slice(1).join('\n') === text.split('\n').slice(1).join('\n'); // only the time differs
      if (same || (empty && !row.note_uuid)) { repo.clearSummaryDirty(row.job_uuid); continue; }
      if ((diaryRetryAt.get('s:' + row.job_uuid) || 0) > Date.now()) continue;
      const token = await diaryToken(acc);
      if (!token) continue;
      try {
        let uuid = row.note_uuid;
        if (uuid) {
          try { await diaryApi.updateJobNote(uuid, { text }, token); } catch (e) {
            if (/\b429\b/.test(e.message)) throw e;
            // can't change it (deleted in ServiceM8, or not allowed): replace it
            await diaryApi.removeJobNote(uuid, token).catch(() => {});
            uuid = null;
          }
        }
        if (!uuid) uuid = await diaryApi.addJobNote({ jobUUID: row.job_uuid, text }, token);
        repo.saveSummaryNote(row.job_uuid, uuid, text);
        repo.clearSummaryDirty(row.job_uuid);
        diaryRetryAt.delete('s:' + row.job_uuid);
      } catch (e) {
        console.error(`Diary summary for job ${row.job_uuid} failed: ${e.message}`);
        diaryErrors.set(acc, diaryProblem(e));
        diaryRetryAt.set('s:' + row.job_uuid, Date.now() + (/\b429\b/.test(e.message) ? 60000 : 5 * 60000));
      }
    }
  }
  app.locals.summaryPass = summaryPass;
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

  /** A job by its number: one Job Costs knows, or else looked up in ServiceM8 (and remembered). */
  async function jobByNumber(accountUUID, number) {
    const known = repo.findJobByNumber(accountUUID, number);
    if (known) return repo.getJob(known);
    const token = await accessTokenFor(accountUUID, eventTokens.get(accountUUID ?? null));
    if (!token) return null;
    const uuid = await findJobByNumberImpl(String(number), token);
    if (!uuid) return null;
    const info = await fetchJobImpl(uuid, token);
    return repo.ensureJob({ jobUUID: uuid, accountUUID, ...(withStockFlag(info, accountUUID) || {}), jobNumber: (info && info.jobNumber) || String(number) });
  }
  // Invoices with a job number Job Costs hasn't seen (e.g. completed jobs): look them up.
  // A statement read in the Inbox (uploaded or from Outlook) is filed under Statement check, ready to run.
  processor.onStatement = app.locals.onStatement = (inv, read) => {
    const name = inv.file_name || 'Statement.pdf';
    const rel = saveFile(path.join(folderFor(inv.account_uuid), 'statements'), name, fs.readFileSync(path.join(repo.filesDir, inv.file_path)));
    const c = repo.createCheck(inv.account_uuid ?? null, { fileName: name, filePath: rel, mimeType: inv.mime_type });
    repo.updateCheck(c.id, { status: 'waiting', supplier: read.supplier_name || null, statement_date: read.invoice_date || null });
    return c;
  };
  // ---------- price check of each invoice as it arrives ----------
  let priceQueue = Promise.resolve(); // one at a time
  function priceCheck(invoiceId, { priceListId = null, auto = false, note = null } = {}) {
    const inv = repo.getInvoice(invoiceId);
    if (!inv || inv.status !== 'ready' || !checker) return { started: false };
    const pl = priceListId ? repo.getPriceList(inv.account_uuid ?? null, priceListId) : repo.priceListFor(inv.account_uuid ?? null, inv.supplier);
    if (!pl) { if (!inv.price_check_status) repo.setPriceCheck(inv.id, { status: 'none' }); return { started: false }; }
    if (auto && inv.price_check_status === 'done') return { started: false }; // already checked; "Check again" redoes it
    repo.setPriceCheck(inv.id, { status: 'checking' });
    priceQueue = priceQueue.then(() => runPriceCheck(inv.id, pl, note)).catch(() => {});
    return { started: true, price_list: pl.supplier };
  }
  async function runPriceCheck(invoiceId, pl, note = null) {
    const inv = repo.getInvoice(invoiceId);
    if (!inv) return;
    try {
      const c = (n) => Math.round((Number(n) || 0) * 100);
      const money_checks = {
        adds_up: inv.subtotal == null || inv.tax == null || inv.total == null ? null : Math.abs(c(inv.subtotal) + c(inv.tax) - c(inv.total)) <= 2,
        subtotal_ex_gst: inv.subtotal, gst: inv.tax, total_inc_gst: inv.total,
      };
      // the job it's on (or suggested for), with the notes from ServiceM8 where we can get them
      const jobUUID = (repo.jobsOnInvoice(inv.id)[0] || {}).job_uuid || inv.origin_job_uuid || inv.suggested_job_uuid || null;
      let job = null;
      if (jobUUID) {
        const local = repo.getJob(jobUUID) || {};
        const token = await accessTokenFor(inv.account_uuid ?? null, eventTokens.get(inv.account_uuid ?? null)).catch(() => null);
        const info = token ? await fetchJobImpl(jobUUID, token).catch(() => null) : null;
        job = { job_number: local.job_number, client: local.client_name, address: local.job_title, quoted_price_ex_gst: local.quote_amount ?? null, notes: (info && info.description) || null };
      }
      const rulesUsed = repo.rulesFor(inv.account_uuid ?? null, [inv.invoice_number], inv.supplier || '');
      const result = await checker.reviewInvoice({
        business: settingsFor(inv.account_uuid ?? null).business_type,
        invoice: { supplier: inv.supplier, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, subtotal_ex_gst: inv.subtotal, gst: inv.tax, total_inc_gst: inv.total,
          references: (() => { try { return JSON.parse(inv.refs || '[]'); } catch { return []; } })(), lines: repo.itemsOf(inv.id).map(({ paid, ...x }) => x) },
        rules: rulesUsed.map((r) => r.text),
        notes_for_this_check: note || null,
        job, money_checks,
      }, { priceList: pl, invoiceFile: inv.file_path && isSupported(inv.file_name, inv.mime_type) ? { file_path: inv.file_path, file_name: inv.file_name, mime_type: inv.mime_type } : null });
      recordUsage(inv.account_uuid ?? null, 'price_check', result && result.usage);
      repo.setPriceCheck(inv.id, { status: 'done', result: { ...result, money_checks, note: note || null, price_list: { id: pl.id, supplier: pl.supplier, name: pl.name }, checked_at: new Date().toISOString() } });
      repo.markRulesUsed(rulesUsed, `price check of invoice ${inv.invoice_number || inv.id}`);
    } catch (e) {
      console.error(`Price check of invoice ${invoiceId}: ${e.message}`);
      if (e && e.usage) recordUsage(repo.getInvoice(invoiceId)?.account_uuid ?? null, 'price_check', e.usage);
      repo.setPriceCheck(invoiceId, { status: 'error', result: { error: /credit balance/i.test(e.message || '') ? 'Your Claude API account is out of credit.' : e.message } });
    }
  }
  processor.afterRead = app.locals.priceCheck = (id, opts) => priceCheck(id, { auto: true, ...(opts || {}) });
  // Count each Claude request per business, with an estimate of what it cost (USD).
  const recordUsage = app.locals.recordUsage = (accountUUID, kind, u) => {
    const pr = config.claudePrices || { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
    const t = { input: (u && u.input_tokens) || 0, output: (u && u.output_tokens) || 0, cacheWrite: (u && u.cache_creation_input_tokens) || 0, cacheRead: (u && u.cache_read_input_tokens) || 0 };
    const cost = (t.input * pr.input + t.output * pr.output + t.cacheWrite * pr.cacheWrite + t.cacheRead * pr.cacheRead) / 1e6;
    try { repo.addUsage(accountUUID, kind, { ...t, cost }); } catch (e) { console.error(`Usage not counted: ${e.message}`); }
  };
  processor.onUsage = recordUsage;

  processor.lookupJobs = app.locals.lookupJobs = async (invoiceId) => {
    const inv = repo.getInvoice(invoiceId);
    let found = false;
    for (const n of repo.jobNumbersOn(invoiceId)) {
      if (repo.findJobByNumber(inv.account_uuid, n)) continue;
      if (await jobByNumber(inv.account_uuid, n).catch(() => null)) found = true;
    }
    return found;
  };

  /** Read the statement (once), find each invoice and its jobs, then have Claude review it all. */
  const stopRequested = new Set(); // checks asked to stop (they stop at the next step)
  async function runCheck(accountUUID, id) {
    const now = () => new Date().toISOString();
    stopRequested.delete(id);
    const stillWanted = () => {
      const cur = repo.db.prepare('SELECT status FROM statement_checks WHERE id = ?').get(id);
      if (stopRequested.has(id) || !cur || !['reading', 'checking'].includes(cur.status)) { const e = new Error('stopped'); e.stopped = true; throw e; }
    };
    const progress = (text) => { stillWanted(); repo.updateCheck(id, { progress: text, progress_at: now() }); };
    try {
      let c = repo.getCheck(accountUUID, id);
      repo.updateCheck(id, { started_at: now() });
      let statement = c.statement;
      if (!statement) {
        repo.updateCheck(id, { status: 'reading' });
        progress('Reading the statement…');
        statement = await checker.readStatement({ filePath: path.join(repo.filesDir, c.file_path), fileName: c.file_name, mimeType: c.mime_type });
        recordUsage(accountUUID, 'statement_read', statement && statement.usage);
        repo.updateCheck(id, { statement, supplier: statement.supplier_name || null, statement_date: statement.statement_date || null });
      }
      repo.updateCheck(id, { status: 'checking' });
      c = repo.getCheck(accountUUID, id);
      const inRange = (d) => (!c.date_from || (d && d >= c.date_from)) && (!c.date_to || (d && d <= c.date_to));
      const seen = new Set();
      const lines = (statement.lines || []).filter((l) => ['invoice', 'credit'].includes(l.type) && inRange(l.date))
        .filter((l) => { const k = `${l.reference}|${l.type}|${Number(l.amount).toFixed(2)}`; return !seen.has(k) && seen.add(k); });
      // Invoices on the statement that aren't in Job Costs yet: look for their emails in Outlook and import them.
      const missing = lines.filter((l) => l.type === 'invoice' && !repo.findInvoiceByNumber(accountUUID, l.reference, statement.supplier_name)).map((l) => l.reference);
      if (missing.length && repo.getOutlook(accountUUID)) {
        progress(`Looking for ${missing.length} invoice${missing.length === 1 ? '' : 's'} in Outlook…`);
        try {
          const r = await outlook.findAndImport({ repo, config, api: outlookApi, accountKey: accountUUID, references: missing,
            onMail: (mail, account) => processMail(mail, { accountUUID: account || null, source: 'outlook' }),
            onProgress: (k, n) => progress(`Looking for invoices in Outlook (${k}/${n})…`) });
          if (r.found.length) {
            progress(`Reading ${r.found.length} invoice${r.found.length === 1 ? '' : 's'} found in Outlook…`);
            let timer;
            await Promise.race([processor.idle(), new Promise((res) => { timer = setTimeout(res, 4 * 60 * 1000); })]);
            clearTimeout(timer);
          }
          c.found_in_outlook = r.found;
        } catch (e) { console.error(`Statement check ${id}: Outlook search failed: ${e.message}`); }
      }
      const token = await accessTokenFor(accountUUID, eventTokens.get(accountUUID ?? null));
      const jobInfo = new Map();
      const jobsTotal = new Set(lines.flatMap((l) => { const i = repo.findInvoiceByNumber(accountUUID, l.reference, statement.supplier_name); return i ? repo.jobsOnInvoice(i.id).map((j) => j.job_uuid) : []; })).size;
      const matched = [];
      const forClaude = [];
      const invoiceFiles = [];
      for (const l of lines) {
        const inv = repo.findInvoiceByNumber(accountUUID, l.reference, statement.supplier_name);
        const jobs = [];
        if (inv) {
          // the jobs it's on; one that's still waiting in the Inbox: the job suggested for it
          let onJobs = repo.jobsOnInvoice(inv.id).map((j) => ({ ...j, suggested: false }));
          if (!onJobs.length && inv.suggested_job_uuid) onJobs = [{ job_uuid: inv.suggested_job_uuid, job_number: (repo.getJob(inv.suggested_job_uuid) || {}).job_number, suggested: true }];
          for (const j of onJobs) {
            if (!jobInfo.has(j.job_uuid)) {
              progress(`Getting job ${jobInfo.size + 1}${jobsTotal ? ' of ' + jobsTotal : ''} from ServiceM8…`);
              const info = token ? await fetchJobImpl(j.job_uuid, token).catch(() => null) : null;
              const local = repo.getJob(j.job_uuid) || {};
              jobInfo.set(j.job_uuid, {
                job_number: local.job_number || j.job_number, client: (info && info.clientName) || local.client_name || null,
                address: (info && (info.address || info.jobTitle)) || local.job_title || null, status: (info && info.status) || local.sm8_status || null,
                quoted_price_ex_gst: local.quote_amount ?? null, notes: (info && info.description) || null,
                servicem8_badges: (info && info.badges) || [],
              });
            }
            jobs.push({ job_uuid: j.job_uuid, job_number: jobInfo.get(j.job_uuid).job_number, badges: jobInfo.get(j.job_uuid).servicem8_badges, suggested: j.suggested });
          }
          if (inv.file_path && invoiceFiles.length < 40 && isSupported(inv.file_name, inv.mime_type)) {
            invoiceFiles.push({ reference: l.reference, file_path: inv.file_path, file_name: inv.file_name, mime_type: inv.mime_type });
          }
        }
        matched.push({ reference: l.reference, date: l.date, amount: l.amount, type: l.type, from_outlook: (c.found_in_outlook || []).includes(l.reference),
          invoice: inv ? { id: inv.id, supplier: inv.supplier, invoice_number: inv.invoice_number, total: inv.total, paid: repo.itemsOf(inv.id).every((x) => x.paid) } : null, jobs });
        forClaude.push({
          reference: l.reference, date: l.date, amount_inc_gst: l.amount, type: l.type,
          invoice: inv ? { found_in_job_costs: true, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, total_inc_gst: inv.total, gst: inv.tax,
            references_on_invoice: (() => { try { return JSON.parse(inv.refs || '[]'); } catch { return []; } })(), lines: repo.itemsOf(inv.id).map(({ paid, ...x }) => x),
            in_stock: !!inv.kept_as_stock } : { found_in_job_costs: false },
          jobs: jobs.map((j) => jobInfo.get(j.job_uuid)),
        });
      }
      const reconcile = reconcileMoney(statement, matched, lines, { from: c.date_from, to: c.date_to, supplier: statement.supplier_name, accountUUID });
      const sup = String(statement.supplier_name || '').toLowerCase();
      const allLists = repo.listPriceLists(accountUUID);
      const word = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const fits = allLists.filter((p) => word(p.supplier).some((w) => sup.includes(w)));
      const priceLists = (fits.length ? fits : allLists).slice(0, 4);
      const rulesUsed = repo.rulesFor(accountUUID, lines.map((l) => l.reference), statement.supplier_name || '');
      progress(`Claude is checking ${lines.length} line${lines.length === 1 ? '' : 's'} against the price list, your rules and the jobs… (usually 1–4 minutes)`);
      const result = await checker.review({
        business: settingsFor(accountUUID).business_type,
        statement: { supplier: statement.supplier_name, account_number: statement.account_number, statement_date: statement.statement_date, total_due: statement.total_due,
          checking_only: c.date_from || c.date_to ? `invoices dated ${c.date_from || 'any'} to ${c.date_to || 'any'}` : 'all invoices on the statement' },
        rules: rulesUsed.map((r) => r.text),
        notes_for_this_check: c.instructions || null,
        price_lists: priceLists.map((p) => `${p.supplier}: ${p.name || 'price list'} (uploaded ${String(p.created_at).slice(0, 10)})`),
        lines: forClaude,
        // Worked out in code: use these totals as they are (don't add them up again).
        money_checks: reconcile,
      }, { priceLists, invoiceFiles, onProgress: (text) => progress(text) });
      recordUsage(accountUUID, 'statement_check', result && result.usage);
      stillWanted();
      repo.updateCheck(id, { status: 'done', matched, result, reconcile, error: null, progress: null, attempts: 0, finished_at: new Date().toISOString() });
      repo.markRulesUsed(rulesUsed, `statement check of ${statement.supplier_name || 'a statement'}${statement.statement_date ? ' ' + statement.statement_date : ''}`);
    } catch (e) {
      // stopped (the Claude request is cancelled too): leave it as "not run yet", not as an error
      const cur = repo.db.prepare('SELECT status FROM statement_checks WHERE id = ?').get(id);
      if (e.stopped || (cur && cur.status === 'waiting')) { stopRequested.delete(id); if (cur && cur.status !== 'error') repo.updateCheck(id, { status: 'waiting', progress: null, error: null }); return; }
      console.error(`Statement check ${id}: ${e.message}`);
      const msg = /credit balance/i.test(e.message || '') ? 'Your Claude API account is out of credit. Add credit at console.anthropic.com, then click Run again.'
        : e.status === 429 || e.status >= 500 ? 'Claude is busy right now. Click Run again in a minute.' : e.message || 'The check failed.';
      repo.updateCheck(id, { status: 'error', error: msg, progress: null, finished_at: new Date().toISOString() });
    }
  }
  app.locals.runCheck = runCheck;

  /**
   * Plain arithmetic, no AI: do the statement's lines add up to its printed total, does each
   * statement amount match the invoice in Job Costs, and does each invoice add up to its own total.
   * All in cents, so there's no rounding drift.
   */
  function reconcileMoney(statement, matched, checkedLines, { from = null, to = null, supplier = null, accountUUID = null } = {}) {
    const c = (n) => Math.round((Number(n) || 0) * 100);
    const $ = (cents) => cents / 100;
    const all = (statement.lines || []);
    const seenAll = new Set();
    const unique = all.filter((l) => { const k = `${l.reference}|${l.type}|${c(l.amount)}`; return !seenAll.has(k) && seenAll.add(k); });
    const owing = unique.filter((l) => l.type !== 'payment').reduce((s, l) => s + c(l.amount), 0);
    const withPayments = unique.reduce((s, l) => s + c(l.amount), 0);
    const total = statement.total_due == null ? null : c(statement.total_due);
    const statementAddsUp = total == null ? null : Math.abs(owing - total) <= 1 || Math.abs(withPayments - total) <= 1;
    const amountMismatches = [];
    const invoiceMath = [];
    for (const m of matched) {
      if (!m.invoice) continue;
      const inv = repo.getInvoice(m.invoice.id);
      if (!inv) continue;
      // a credit with the invoice's number isn't the invoice: only invoice lines are compared
      if (m.type !== 'credit' && inv.total != null && Math.abs(c(inv.total) - c(m.amount)) > 1) {
        amountMismatches.push({ reference: m.reference, on_statement: $(c(m.amount)), in_job_costs: $(c(inv.total)), difference: $(c(m.amount) - c(inv.total)) });
      }
      if (m.type !== 'credit' && inv.subtotal != null && inv.tax != null && inv.total != null && Math.abs(c(inv.subtotal) + c(inv.tax) - c(inv.total)) > 2) {
        invoiceMath.push({ reference: m.reference, subtotal: $(c(inv.subtotal)), gst: $(c(inv.tax)), total: $(c(inv.total)), difference: $(c(inv.total) - c(inv.subtotal) - c(inv.tax)) });
      }
    }
    const checked = checkedLines.reduce((s, l) => s + c(l.amount), 0);
    // The rest of the statement (only when a date range was chosen): earlier months, quickly – no price or job check.
    const outside = (from || to) ? unique.filter((l) => l.type !== 'payment' && !((!from || (l.date && l.date >= from)) && (!to || (l.date && l.date <= to)))) : [];
    const earlierLines = outside.filter((l) => !from || !l.date || l.date < from);
    const laterLines = outside.filter((l) => !earlierLines.includes(l));
    const earlier = earlierLines.map((l) => {
      const inv = l.type === 'invoice' ? repo.findInvoiceByNumber(accountUUID, l.reference, supplier) : null;
      const items = inv ? repo.itemsOf(inv.id) : [];
      return { reference: l.reference, date: l.date, amount: $(c(l.amount)), type: l.type, invoice_id: inv ? inv.id : null,
        in_job_costs: !!inv, paid: !!inv && items.length > 0 && items.every((x) => x.paid) };
    });
    const sum = (arr) => $(arr.reduce((s, l) => s + c(l.amount), 0));
    const rest = (from || to) ? {
      earlier_count: earlierLines.length, earlier_total: sum(earlierLines),
      later_count: laterLines.length, later_total: sum(laterLines),
      payments_total: sum(unique.filter((l) => l.type === 'payment')),
      // you marked these paid, but the supplier still lists them as owing
      paid_but_listed: earlier.filter((l) => l.paid && l.type === 'invoice'),
      earlier_unpaid: earlier.filter((l) => !l.paid && l.type === 'invoice'),
      earlier_credits: earlier.filter((l) => l.type === 'credit'),
    } : null;
    return {
      period: from || to ? { from, to } : null,
      rest,
      statement_total: total == null ? null : $(total),
      statement_lines_total: $(owing),
      statement_adds_up: statementAddsUp,
      checked_count: checkedLines.length,
      checked_total_inc_gst: $(checked),
      not_in_job_costs: matched.filter((m) => !m.invoice).map((m) => m.reference),
      amount_mismatches: amountMismatches,
      invoice_math: invoiceMath,
      ok: statementAddsUp !== false && !amountMismatches.length && !invoiceMath.length,
    };
  }
  const appStarted = Date.now();
  // Checks interrupted by a restart: run them again, but not forever (a check that keeps getting cut short stops).
  if (checker) setTimeout(() => {
    for (const c of repo.db.prepare("SELECT id, account_key, attempts, progress_at, started_at FROM statement_checks WHERE status IN ('reading', 'checking')").all()) {
      if (Date.parse(c.progress_at || c.started_at || 0) >= appStarted) continue; // started by this app, not cut short
      if ((c.attempts || 0) >= 2) {
        repo.updateCheck(c.id, { status: 'error', progress: null, attempts: 0, finished_at: new Date().toISOString(),
          error: 'The app restarted 3 times while this check was running, so it was stopped. Try a shorter date range, or send the Render logs from that time.' });
        console.error(`Statement check ${c.id}: stopped after 3 restarts`);
        continue;
      }
      repo.updateCheck(c.id, { attempts: (c.attempts || 0) + 1 });
      console.log(`Statement check ${c.id}: carrying on after a restart (attempt ${(c.attempts || 0) + 2})`);
      runCheck(c.account_key || null, c.id).catch(() => {});
    }
  }, 3000).unref?.();

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
      ...(config.supportEmail ? { supportEmail: config.supportEmail } : {}),
      actions: [
        { name: 'Job Costs', type: 'online', entity: 'job', iconURL: `${config.publicUrl}/icon.png`, event: 'job_costs_open' },
        { name: 'Job Costs', type: 'app', entity: 'job', iconURL: `${config.publicUrl}/icon.png`, event: 'job_costs_open' }, // the iPhone / iPad app
      ],
      menuItems: [
        { name: 'Job Costs', type: 'addon', iconURL: `${config.publicUrl}/icon.png`, event: 'job_costs_menu' }, // the Add-ons menu
        { name: 'Job Costs', type: 'app', iconURL: `${config.publicUrl}/icon.png`, event: 'job_costs_menu' }, // the app's More tab
      ],
    });
  });

  // The window ServiceM8 shows: our page in a frame, sized to fit (the app shows it full screen).
  const windowHtml = (url) => `<script src="https://platform.servicem8.com/sdk/1.0/sdk.js"></script>
<script>
var sm8 = null;
try { sm8 = SMClient.init(); } catch (e) {}
function fit(size) {
  try {
    // Leave room for the browser's tabs, address bar and ServiceM8's top bar.
    var aw = (screen.availWidth || 1320), ah = (screen.availHeight || 860);
    if (size === 'full') sm8.resizeWindow(Math.max(700, Math.min(1320, aw - 100)), Math.max(480, Math.min(820, ah - 260)));
    else sm8.resizeWindow(Math.min(500, aw - 40), Math.max(420, Math.min(680, ah - 260)));
  } catch (e) {}
}
fit('compact');
window.addEventListener('message', function (e) {
  if (e.origin === ${JSON.stringify(new URL(config.publicUrl).origin)} && e.data && e.data.jobcosts === 'size') fit(e.data.size);
});
</script>
<iframe src="${url}" style="position:fixed;top:0;left:0;width:100%;height:100%;border:0" allow="clipboard-write"></iframe>`;

  // ServiceM8 calls this when someone clicks "Job Costs" on a job card.
  app.post('/servicem8/addon', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    // ServiceM8 expects JSON: { eventResponse: "<html to show in the window>" }.
    const reply = (html) => res.set('Cache-Control', 'no-store').json({ eventResponse: html });
    let event;
    try {
      event = verifyEvent(req.body, config.servicem8AppSecret);
    } catch (e) {
      console.error(`ServiceM8 click rejected: ${e.message} (body ${String(req.body || '').length} chars, type ${req.get('content-type') || '-'})`);
      return reply(`<div style="font-family:sans-serif;padding:16px"><b>Could not open Job Costs</b><p>${String(e.message).replace(/</g, '&lt;')}</p>
        <p>Check SERVICEM8_APP_SECRET in Render matches the add-on's App Secret.</p></div>`);
    }
    if (!event.jobUUID) {
      // From the Add-ons menu / the app's More tab: the Job Costs home page for the whole business.
      repo.ensureAccount(event.accountUUID);
      if (event.accessToken) eventTokens.set(event.accountUUID ?? null, event.accessToken);
      const claimed = repo.claimPendingTokens(event.accountUUID);
      accessTokenFor(event.accountUUID, event.accessToken).then((token) => syncJobs(event.accountUUID, token, { force: claimed })).catch(() => {});
      console.log('Job Costs opened from the menu');
      return reply(windowHtml(`${config.publicUrl}/home?t=${encodeURIComponent(accountToken(event.accountUUID))}`));
    }
    // ServiceM8 only waits a few seconds for an answer. Get the job's details from ServiceM8 if that's
    // quick; otherwise open the window straight away and finish in the background.
    let job = null;
    const t0 = Date.now();
    try {
      const work = prepareClick(event);
      work.catch((e) => console.error(`Job Costs click (background): ${e.message}`))
        .finally(() => { for (const [k, v] of sm8Notes) if (v === LOADING) sm8Notes.delete(k); });
      job = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), config.clickTimeoutMs || 3000))]);
    } catch (e) {
      console.error(`Job Costs click: ${e.message}`);
    }
    console.log(`Job Costs click: job ${event.jobUUID} answered in ${Date.now() - t0} ms${job ? '' : ' (details still loading)'}`);
    if (!job) {
      job = repo.ensureJob({ jobUUID: event.jobUUID, accountUUID: event.accountUUID });
      const main = mainJobNumber(job.job_number);
      const mainUUID = main && repo.findJobByNumber(job.account_uuid, main);
      if (mainUUID) job = repo.getJob(mainUUID);
      if (!sm8Notes.get(job.job_uuid)) sm8Notes.set(job.job_uuid, LOADING);
    }
    // The window shows our page (from our own address, so everything on it works),
    // and asks ServiceM8 to make the window big enough.
    // Opens on the compact summary; "Open full Job Costs" inside it asks for the big window.
    const url = `${config.publicUrl}/summary?t=${encodeURIComponent(sessionToken(job.job_uuid))}`;
    reply(windowHtml(url));
  });

  const LOADING = '__loading__'; // details still coming from ServiceM8 (the card checks again shortly)

  /** Everything a click needs from ServiceM8: the job, its price, split parts, the job list. Returns the job to show. */
  async function prepareClick(event) {
    const claimed = repo.claimPendingTokens(event.accountUUID);
    let token = await accessTokenFor(event.accountUUID, event.accessToken);
    let info = await fetchJobImpl(event.jobUUID, token);
    // Saved access not working (e.g. revoked)? Try the pass that came with the click.
    if ((!info || info.linesError) && event.accessToken && event.accessToken !== token) {
      const alt = await fetchJobImpl(event.jobUUID, event.accessToken);
      if (alt && (!info || !alt.linesError)) { info = alt; token = event.accessToken; }
    }
    let job = repo.ensureJob({ jobUUID: event.jobUUID, accountUUID: event.accountUUID, ...(withStockFlag(info, event.accountUUID) || {}) });
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
        job = repo.ensureJob({ jobUUID: mainUUID, accountUUID: event.accountUUID, ...(withStockFlag(mainInfo, event.accountUUID) || { jobNumber: main }) });
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
      : (info && info.linesError) || (!info ? `Couldn\u2019t read this job from ServiceM8${fetchJobImpl.lastError ? ` (${fetchJobImpl.lastError})` : ''}. Close Job Costs and open it again to retry.` : null)));
    // Sync jobs in the background; wait at most a moment so the card opens quickly.
    const sync = Promise.all([
      syncJobs(job.account_uuid, token, { force: claimed }).catch(() => {}),
      checkDiaryDeletions(job.job_uuid, token).catch((e) => console.error(`Diary check failed: ${e.message}`)),
    ]);
    kickDiary();
    await Promise.race([sync, new Promise((r) => setTimeout(r, 1500))]);
    return job;
  }

  // The Job Costs window itself (opened inside ServiceM8's window, using the click's session).
  app.get('/card', (req, res) => {
    const job = jobFromToken(req.query.t);
    if (!job) return res.status(401).type('html').send('<p style="font-family:sans-serif">Session expired. Close this window and click Job Costs again.</p>');
    // ?inv=12 opens with that invoice selected; ?back=check:5 shows a link back to that statement check
    const back = /^check:\d+$/.test(String(req.query.back || '')) ? String(req.query.back) : null;
    renderCard(res, job, { embedded: false, select: Number(req.query.inv) || null, back });
  });

  // Reports and Inbox pages (opened from the card, using the card's session).
  for (const name of ['report', 'inbox', 'bills', 'checks', 'summary', 'prices', 'stock', 'home', 'settings', 'welcome']) {
    app.get(`/${name}`, (req, res) => {
      const sess = sessionFrom(req.query.t);
      if (!sess) {
        return res.status(401).type('html').send('<p style="font-family:sans-serif">Session expired. Open Job Costs from ServiceM8 and try again.</p>');
      }
      // home: opened from the menu, so "Back" goes to the Job Costs home page instead of a job
      const boot = { token: String(req.query.t), reasons: MISTAKE_REASONS, categories: CATEGORIES, home: !sess.job };
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

  // Invoices that came in before their supplier's price list (or before price checks existed) get checked now.
  const PRICE_CHECK_BATCH = 30;
  function priceCheckUnchecked(account, invoices) {
    let n = 0;
    for (const inv of invoices) {
      if (n >= PRICE_CHECK_BATCH) break;
      if (inv.status !== 'ready' || inv.duplicate_of || (inv.price_check_status && inv.price_check_status !== 'none')) continue;
      if (!repo.priceListFor(account, inv.supplier)) continue;
      if (priceCheck(inv.id, { auto: true }).started) { inv.price_check_status = 'checking'; n++; } // the card shows "Checking…" and polls
    }
    return n;
  }
  api.get('/ping', (req, res) => res.json({ ok: true }));
  /** A business that hasn't set up yet (and has no invoices) gets the welcome page offered. */
  const needsWelcome = (accountUUID) => !settingsFor(accountUUID).onboarded
    && !repo.db.prepare('SELECT 1 FROM invoices WHERE account_uuid IS ? LIMIT 1').get(accountUUID);
  // ---------- A business's own mailbox (Gmail or any IMAP mailbox) ----------
  // The password is kept encrypted with a key made from SESSION_SECRET.
  const imapKey = () => crypto.createHash('sha256').update(`${config.sessionSecret}:imap`).digest();
  const seal = (text) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', imapKey(), iv);
    const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.'); };
  const unseal = (sealed) => { const [iv, tag, data] = String(sealed).split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', imapKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString('utf8'); };
  const imapRunning = new Set();
  async function checkOneMailbox(conn) {
    const acc = conn.account_key === '' ? null : conn.account_key;
    if (imapRunning.has(conn.account_key)) return 0;
    imapRunning.add(conn.account_key);
    try {
      const client = imapClient({ host: conn.host, port: conn.port, user: conn.email, password: unseal(conn.password_enc) });
      // the first look goes back 3 days before connecting; after that, two weeks of already-seen emails are skipped
      const since = new Date(Math.max(Date.parse(conn.connected_at) - 3 * 86400000, Date.now() - 14 * 86400000));
      const n = await mailbox.checkMailbox(client, { repo, keyPrefix: `imap:${conn.account_key}:`, since,
        onMail: (mail) => processMail(mail, { accountUUID: acc, source: 'mailbox' }) });
      repo.setImapStatus(acc, { error: null });
      return n;
    } catch (e) {
      console.error(`Mailbox ${conn.email}: ${e.message}`);
      repo.setImapStatus(acc, { error: /auth|password|credential|login/i.test(e.message) ? 'The mailbox password stopped working – connect it again in ⚙ Settings.' : e.message });
      return 0;
    } finally { imapRunning.delete(conn.account_key); }
  }
  /** Check every connected mailbox; { scheduled: true } only those in their business's checking hours. */
  app.locals.checkMailboxes = async ({ scheduled = false } = {}) => {
    let n = 0;
    for (const conn of repo.listImap()) {
      if (scheduled && !outlook.inCheckingHours(hoursOf(conn.account_key === '' ? null : conn.account_key))) continue;
      n += await checkOneMailbox(conn);
    }
    return n;
  };
  api.post('/imap', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '').replace(/\s+/g, ''); // app passwords are shown in groups of 4
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Type the mailbox\u2019s email address' });
    if (!password) return res.status(400).json({ error: 'Type the mailbox\u2019s (app) password' });
    const host = String(req.body?.host || '').trim().toLowerCase() || mailbox.imapHostFor(email);
    if (!host) return res.status(400).json({ error: 'Type the incoming mail (IMAP) server, e.g. mail.yourdomain.com.au', needHost: true });
    const port = Number(req.body?.port) || 993;
    try { await mailbox.testMailbox({ host, port, user: email, password }, imapClient); } catch (e) { return res.status(400).json({ error: e.message }); }
    repo.saveImap(req.account, { email, host, port, passwordEnc: seal(password) });
    checkOneMailbox(repo.getImap(req.account)).catch(() => {});
    res.json({ ok: true, email, host });
  });
  api.delete('/imap', (req, res) => { repo.removeImap(req.account); res.json({ ok: true }); });
  api.post('/imap/check', async (req, res) => {
    const conn = repo.getImap(req.account);
    if (!conn) return res.status(400).json({ error: 'No mailbox connected' });
    const found = await checkOneMailbox(conn);
    const after = repo.getImap(req.account);
    if (after && after.error) return res.status(502).json({ error: after.error });
    res.json({ ok: true, found });
  });

  // ---------- Settings of the business ----------
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  api.get('/settings', (req, res) => {
    const o = repo.getOutlook(req.account);
    const month = repo.listUsage(req.account, 1).find((m) => m.month === new Date().toISOString().slice(0, 7));
    const used = Object.fromEntries(Object.entries(month ? month.kinds : {}).map(([k, v]) => [k, v.count]));
    const im = repo.getImap(req.account);
    const accRow = repo.ensureAccount(req.account);
    res.json({ settings: settingsFor(req.account), days: DAYS, used, inboxAddress: inboxAddress(accRow.inbox_code, config),
      priceLists: repo.listPriceLists(req.account).map((p) => ({ id: p.id, supplier: p.supplier, name: p.name })),
      imap: im ? { email: im.email, host: im.host, error: im.error, last_check: im.last_check } : null,
      outlook: { available: !!(config.msClientId && config.msClientSecret), connected: !!(o && o.refresh_token), email: o ? o.email : null, error: o ? o.error : null } });
  });
  api.put('/settings', (req, res) => {
    const b = req.body || {};
    const words = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    const ch = {};
    if (b.business_name !== undefined) ch.business_name = String(b.business_name).trim().slice(0, 120);
    if (b.business_type !== undefined) ch.business_type = String(b.business_type).trim().slice(0, 120) || repo.settingDefaults.business_type;
    if (b.stock_clients !== undefined) ch.stock_clients = words(b.stock_clients);
    if (b.stock_categories !== undefined) ch.stock_categories = words(b.stock_categories);
    if (b.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-AU', { timeZone: String(b.timezone) }); ch.timezone = String(b.timezone); } catch { return res.status(400).json({ error: 'Unknown time zone' }); }
    }
    if (b.check_days !== undefined) ch.check_days = (Array.isArray(b.check_days) ? b.check_days : []).map(String).filter((d) => DAYS.includes(d));
    for (const k of ['check_from', 'check_to']) if (b[k] !== undefined) {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < 0 || n > 24) return res.status(400).json({ error: 'Hours are 0 to 24' });
      ch[k] = n;
    }
    if ((ch.check_from ?? settingsFor(req.account).check_from) >= (ch.check_to ?? settingsFor(req.account).check_to)) return res.status(400).json({ error: 'The checking hours end before they start' });
    if (b.diary_summary !== undefined) ch.diary_summary = !!b.diary_summary;
    if (b.onboarded !== undefined) ch.onboarded = !!b.onboarded;
    const wasOn = settingsFor(req.account).diary_summary;
    const saved = repo.saveSettings(req.account, ch);
    if (saved.diary_summary && !wasOn) { repo.markSummaryDirty(repo.jobsWithCosts(req.account)); kickDiary(); }
    // new stock words: sort the business's jobs again
    if (ch.stock_clients || ch.stock_categories) {
      const w = stockWords(req.account);
      const upd = repo.db.prepare('UPDATE jobs SET stock_auto = ? WHERE job_uuid = ?');
      for (const j of repo.db.prepare('SELECT job_uuid, client_name, category_name FROM jobs WHERE account_uuid IS ?').all(req.account)) {
        upd.run(looksLikeStockJob({ clientName: j.client_name, categoryName: j.category_name }, w) ? 1 : 0, j.job_uuid);
      }
    }
    res.json({ ok: true, settings: saved });
  });
  // Job Costs home (from the menu / the app's More tab): what needs doing across the business.
  api.get('/home', (req, res) => {
    const bills = repo.listBills(req.account);
    const unpaid = bills.filter((b) => b.payment_state !== 'paid');
    const flags = repo.checkFlagsFor(req.account, unpaid.map((b) => b.id));
    res.json({ welcome: needsWelcome(req.account), inboxCount: repo.inboxCount(req.account), unpaidCount: unpaid.length,
      toPay: Math.round(unpaid.reduce((a, b) => a + (Number(b.total) || 0), 0) * 100) / 100,
      duplicates: unpaid.filter((b) => b.twin).length, flagged: flags.size, stockLeft: repo.listStock(req.account).leftTotal,
      statementsWaiting: repo.listChecks(req.account).filter((c) => c.status === 'waiting').length,
      jobs: repo.listJobs(req.account).slice(0, 300).map((j) => ({ job_uuid: j.job_uuid, job_number: j.job_number, job_title: j.job_title })) });
  });
  api.get('/jobs/find', async (req, res) => {
    const n = String(req.query.number || '').trim().replace(/^#/, '');
    if (!n) return res.status(400).json({ error: 'Type a job number' });
    const job = await jobByNumber(req.account, n).catch(() => null);
    if (!job || (job.account_uuid ?? null) !== req.account) return res.status(404).json({ error: `Job #${n} wasn\u2019t found in ServiceM8` });
    res.json({ token: sessionToken(job.job_uuid), job_number: job.job_number });
  }); // open windows check in, so their session stays fresh
  api.get('/job', (req, res) => {
    const summary = repo.getJobSummary(req.job.job_uuid);
    if (checker) priceCheckUnchecked(req.account, summary.invoices || []);
    // what the statement checks found on this job's invoices (until marked resolved)
    const flags = repo.checkFlagsFor(req.account, (summary.invoices || []).map((i) => i.id));
    for (const i of summary.invoices || []) i.check_flag = flags.get(i.id) || null;
    const ruleTexts = new Set(repo.listRules(req.account).map((r) => r.text));
    for (const i of summary.invoices || []) if (i.price_check && i.price_check.suggested_rule) i.price_check.rule_saved = ruleTexts.has(i.price_check.suggested_rule);
    const acc = repo.ensureAccount(req.account);
    const note = sm8Notes.get(req.job.job_uuid) || null;
    res.json({ ...summary, welcome: needsWelcome(req.account), splitParts: repo.splitParts(req.account, req.job.job_number), sm8Note: note === LOADING ? null : note, sm8Loading: note === LOADING,
      diaryNote: diaryErrors.get(req.account) || null,
      priceLists: repo.listPriceLists(req.account).map((p) => ({ id: p.id, supplier: p.supplier, name: p.name })),
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
  // A new copy of a bill that's already in Job Costs can't go on a job (it could get paid twice).
  const twinBlocks = (res, inv) => {
    if (inv.kept_as_stock || repo.jobsOnInvoice(inv.id).length) return false;
    const t = repo.twinOf(inv);
    if (!t) return false;
    res.status(409).json({ error: duplicateMessage(t), duplicate: t });
    return true;
  };
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
      if (twinBlocks(res, inv)) return;
      const untouched = !repo.jobsOnInvoice(inv.id).length && !inv.kept_as_stock;
      repo.assignWhole(inv.id, req.job.job_uuid, fields);
      if (untouched) repo.markApproved(inv.id, repo.isStockJob(req.job.job_uuid) ? null : req.job.job_uuid);
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
    if (paid === true && !req.body.force) {
      const t = repo.twinOf(inv);
      if (t && t.paid) return res.status(409).json({ error: `Not marked paid: ${duplicateMessage(t).replace(/^Duplicate – not added\. /, '')}`.replace(/ Delete this copy\.$/, ' Delete this copy instead of paying it again.'), duplicate: t });
    }
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
    const diaryWarning = req.query.diary ? await removeFromDiary(inv, req.account) : null;
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

  /** Take an invoice's file and note out of the ServiceM8 diary. Returns a warning if that failed. */
  async function removeFromDiary(inv, accountUUID) {
    if (!inv.sm8_attachment_uuid && !inv.sm8_note_uuid) return null;
    try {
      const token = await diaryToken(accountUUID);
      if (!token) throw new Error('401');
      const gone = (e) => /\b404\b/.test(e.message); // already deleted there: fine
      if (inv.sm8_attachment_uuid && !inv.sm8_missing) await diaryApi.removeJobFile(inv.sm8_attachment_uuid, token).catch((e) => { if (!gone(e)) throw e; });
      if (inv.sm8_note_uuid) await diaryApi.removeJobNote(inv.sm8_note_uuid, token).catch((e) => { if (!gone(e)) throw e; });
      repo.setDiary(inv.id, { sm8_attachment_uuid: null, sm8_note_uuid: null, sm8_job_uuid: null, sm8_link: null, sm8_missing: 0, diary_pending: 0 });
      return null;
    } catch (e) {
      return `Removed from Job Costs, but not from the ServiceM8 diary: ${diaryProblem(e)}`;
    }
  }

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

  // Check this invoice's prices now (optionally against a chosen price list).
  api.post('/invoices/:id/price-check', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (!checker) return res.status(500).json({ error: 'Price checks aren\u2019t set up on the server (ANTHROPIC_API_KEY).' });
    if (inv.status !== 'ready') return res.status(400).json({ error: 'Wait until the invoice has been read' });
    const r = priceCheck(inv.id, { priceListId: req.body?.price_list_id ? Number(req.body.price_list_id) : null, note: String(req.body?.note || '').trim().slice(0, 2000) || null });
    if (!r.started) return res.status(400).json({ error: 'There\u2019s no price list for this supplier. Choose one, or upload it in 🔎 Statement check → Price lists.' });
    res.json({ ok: true, price_list: r.price_list });
  });

  api.get('/invoices/:id/file', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (!inv.file_path) return res.status(404).json({ error: 'No file' });
    // An invoice that was only the text of an email: show it as a readable page with working links.
    if (req.query.view === 'html' && /^text\//.test(inv.mime_type || '')) {
      const text = fs.readFileSync(path.join(repo.filesDir, inv.file_path), 'utf8');
      const escHtml = (x) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const body = escHtml(text)
        .replace(/&lt;(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)&gt;/g, (m, u) => ` <a href="${u}" target="_blank" rel="noopener noreferrer">🔗 link</a>`)
        .replace(/(^|\s)(https?:\/\/\S{60,})/g, (m, sp, u) => `${sp}<a href="${u}" target="_blank" rel="noopener noreferrer">🔗 link</a>`)
        .replace(/\n{3,}/g, '\n\n');
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;font:13.5px/1.55 'Segoe UI',Arial,sans-serif;color:#17312b">
        <div style="padding:14px 18px;background:#f4f7f6;border-bottom:1px solid #e3ece9;font-size:12px;color:#6b8a82">📧 This invoice came as the text of an email (no PDF attached).${inv.email_from ? ' From ' + escHtml(inv.email_from) : ''}</div>
        <div style="padding:16px 18px;white-space:pre-wrap;word-break:break-word">${body}</div></body>`);
    }
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
    if (twinBlocks(res, inv)) return;
    repo.assignWhole(inv.id, req.job.job_uuid, { category: inv.category });
    repo.markApproved(inv.id, repo.isStockJob(req.job.job_uuid) ? null : req.job.job_uuid);
    if (req.body?.paid === true) repo.setInvoicePaid(inv.id, true);
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
    for (const i of repo.db.prepare(`SELECT id FROM invoices WHERE account_uuid IS ? AND status = 'ready' AND suggested_job_uuid IS NULL AND kept_as_stock = 0
        AND approved_at IS NULL AND NOT EXISTS (SELECT 1 FROM allocations JOIN items ON items.id = allocations.item_id WHERE items.invoice_id = invoices.id) LIMIT 100`).all(req.account)) {
      repo.suggestJob(i.id);
    }
    res.json({ ...repo.getUnassigned(req.account), jobs: repo.listJobs(req.account), inboxAddress: inboxAddress(acc.inbox_code, config),
      recent: repo.listRecentlyApproved(req.account), outlookHours: outlook.scheduleText(hoursOf(req.account)),
      statementsWaiting: repo.listChecks(req.account).filter((c) => c.status === 'waiting').length });
  });
  api.post('/inbox/:id/assign', async (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    // { job_uuid } from the list, or { job_number } typed in (looked up in ServiceM8 if needed)
    let job = req.body?.job_uuid ? repo.getJob(String(req.body.job_uuid)) : null;
    const typed = String(req.body?.job_number || '').trim().replace(/^#/, '');
    if (!job && typed) {
      job = await jobByNumber(req.account, typed).catch(() => null);
      if (!job) return res.status(404).json({ error: `Job #${typed} wasn\u2019t found in ServiceM8` });
    }
    if (!job || (job.account_uuid ?? null) !== req.account) return res.status(400).json({ error: 'Choose a job' });
    const c = parseCategory(req.body?.category);
    if (c.error) return res.status(400).json({ error: c.error });
    if (inv.status !== 'ready') return res.status(400).json({ error: 'Wait until the invoice has been read' });
    if (twinBlocks(res, inv)) return;
    repo.assignWhole(inv.id, job.job_uuid, { category: c.category || inv.category });
    repo.markApproved(inv.id, job.is_stock ? null : job.job_uuid);
    if (req.body?.paid === true) repo.setInvoicePaid(inv.id, true);
    res.json({ ok: true, job_number: job.job_number });
  });
  // Upload invoices straight into the Inbox (read, then a job is suggested for each).
  api.post('/inbox/upload', upload.array('files', 30), (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });
    const created = files.map((f) => addInvoiceFile({ accountUUID: req.account, source: 'upload', name: f.originalname, contentType: f.mimetype, buffer: f.buffer }));
    res.status(201).json({ created: created.map((i) => i.id) });
  });
  api.post('/inbox/:id/stock', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    repo.keepAsStock(inv.id);
    repo.markApproved(inv.id, null);
    if (req.body?.paid === true) repo.setInvoicePaid(inv.id, true);
    res.json({ ok: true });
  });
  // Approved by mistake: back to the Inbox (and out of the ServiceM8 diary if it was copied there).
  api.post('/inbox/:id/undo', async (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (!inv.approved_at) return res.status(400).json({ error: 'This invoice wasn\u2019t approved from the Inbox' });
    const diaryWarning = inv.sm8_link === 'pushed' ? await removeFromDiary(inv, req.account) : null;
    repo.undoApproval(inv.id);
    repo.suggestJob(inv.id);
    res.json({ ok: true, diaryWarning });
  });
  // Put a whole invoice somewhere else: another job, or stock (fixing a mistake). Not for invoices shared between jobs.
  api.post('/inbox/:id/move', async (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    if (inv.status !== 'ready') return res.status(400).json({ error: 'Wait until the invoice has been read' });
    const on = repo.jobsOnInvoice(inv.id);
    const from = on.length ? repo.wholeJobOf(inv.id) : null;
    if (on.length && !from) return res.status(400).json({ error: 'This invoice is shared between jobs (or part of it is used) – change it on each job\u2019s card' });
    let job = null;
    if (!req.body?.to_stock) {
      const typed = String(req.body?.job_number || '').trim().replace(/^#/, '');
      if (!typed) return res.status(400).json({ error: 'Type a job number' });
      job = await jobByNumber(req.account, typed).catch(() => null);
      if (!job || (job.account_uuid ?? null) !== req.account) return res.status(404).json({ error: `Job #${typed} wasn\u2019t found in ServiceM8` });
      if (from === job.job_uuid || (job.is_stock && inv.stock_job_uuid === job.job_uuid)) return res.json({ ok: true, job_number: job.job_number, unchanged: true });
    }
    // out of the old job's diary if Job Costs copied it there
    const diaryWarning = from && inv.sm8_link === 'pushed' ? await removeFromDiary(inv, req.account).catch((e) => e.message) : null;
    try { repo.moveWhole(inv.id, from, job ? job.job_uuid : null); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    res.json({ ok: true, job_number: job ? job.job_number : null, to_stock: !job || !!job.is_stock, diaryWarning });
  });
  // Open another job's Job Costs (e.g. to check a possible duplicate there).
  api.get('/jobs/:uuid/open', (req, res) => {
    const job = repo.getJob(String(req.params.uuid));
    if (!job || (job.account_uuid ?? null) !== req.account) return res.status(404).json({ error: 'Job not found' });
    res.json({ token: sessionToken(job.job_uuid), job_number: job.job_number });
  });
  api.delete('/inbox/:id', (req, res) => {
    const inv = accountInvoice(req, res);
    if (!inv) return;
    const jobs = repo.jobsOnInvoice(inv.id);
    if (jobs.length) return res.status(409).json({ error: `Part of this invoice is on ${jobList(jobs)}. Take it off those jobs first.` });
    repo.deleteInvoice(inv.id);
    res.json({ ok: true });
  });

  api.get('/inbox-count', (req, res) => res.json({ count: repo.inboxCount(req.account) }));

  // Outlook connection status (shown on the card and the Inbox).
  api.get('/outlook', (req, res) => {
    const o = repo.getOutlook(req.account);
    res.json({ available: !!(config.msClientId && config.msClientSecret), connected: !!(o && o.refresh_token), hours: outlook.scheduleText(hoursOf(req.account)),
      email: o?.email || null, lastCheck: o?.last_check || null, error: o?.error || null });
  });
  api.delete('/outlook', (req, res) => { repo.removeOutlook(req.account); res.json({ ok: true }); });
  /** Midnight at the start of a day (YYYY-MM-DD) in the business's time zone (daylight saving included). */
  function zonedMidnight(day, tz = config.outlookTimezone || 'Australia/Melbourne') {
    for (const off of [10, 11, 9, 9.5, 10.5, 8, 0]) {
      const sign = off >= 0 ? '+' : '-';
      const hh = String(Math.floor(Math.abs(off))).padStart(2, '0'), mm = Math.abs(off) % 1 ? '30' : '00';
      const t = new Date(`${day}T00:00:00${sign}${hh}:${mm}`);
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(t).map((x) => [x.type, x.value]));
      if (`${p.year}-${p.month}-${p.day}` === day && Number(p.hour) === 0) return t;
    }
    return new Date(`${day}T00:00:00Z`);
  }
  const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  // Import a whole Outlook folder for a date range (e.g. "Need to pay / Gliderol", October).
  api.get('/outlook/folders', async (req, res) => {
    const conn = repo.getOutlook(req.account);
    if (!conn) return res.status(400).json({ error: 'Outlook isn\u2019t connected yet' });
    try {
      const token = await outlook.tokenFor(conn, { repo, config, api: outlookApi });
      res.json({ folders: await outlookApi.listFolders(token) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  // Browse Outlook: the folders inside a folder, and a page of its emails (marked if already imported).
  api.get('/outlook/browse', async (req, res) => {
    const conn = repo.getOutlook(req.account);
    if (!conn) return res.status(400).json({ error: 'Outlook isn\u2019t connected yet' });
    try {
      const token = await outlook.tokenFor(conn, { repo, config, api: outlookApi });
      const folder = req.query.folder ? String(req.query.folder) : null;
      const [folders, page] = await Promise.all([
        req.query.page ? Promise.resolve(null) : outlookApi.childFolders(token, folder),
        folder ? outlookApi.folderPage(token, folder, req.query.page ? String(req.query.page) : null) : Promise.resolve({ messages: [], next: null }),
      ]);
      res.json({ folders, next: page.next, messages: page.messages.map((m) => {
        const st = repo.importStatus(req.account, outlook.importKey(m), m.subject);
        return { ...m, status: st.state, why: st.why || null, imported: st.state === 'imported' };
      }) });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  // Import what was ticked: { message_ids: [...], folder_ids: [...] }
  api.post('/outlook/import-chosen', async (req, res) => {
    const ids = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 300) : []);
    const messageIds = ids(req.body?.message_ids), folderIds = ids(req.body?.folder_ids).slice(0, 20);
    if (!messageIds.length && !folderIds.length) return res.status(400).json({ error: 'Tick the emails or folders to import' });
    try {
      res.json(await outlook.importChosen({ repo, config, api: outlookApi, accountKey: req.account, messageIds, folderIds, again: req.body?.again === true,
        onMail: (mail, account) => processMail(mail, { accountUUID: account || null, source: 'outlook' }) }));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  api.post('/outlook/import', async (req, res) => {
    const b = req.body || {};
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const from = day(b.from), to = day(b.to);
    if (!b.folder_id || !from || !to) return res.status(400).json({ error: 'Choose a folder and the dates' });
    if (to < from) return res.status(400).json({ error: 'The end date is before the start date' });
    try {
      const r = await outlook.importFolder({
        repo, config, api: outlookApi, accountKey: req.account, folderId: String(b.folder_id),
        // whole days in the business's time zone: from midnight on the first day to midnight after the last
        from: zonedMidnight(from), to: zonedMidnight(nextDay(to)),
        onMail: (mail, account) => processMail(mail, { accountUUID: account || null, source: 'outlook' }),
      });
      res.json(r);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  // "Check now": look in Outlook straight away (any day, any time).
  api.post('/outlook/check', async (req, res) => {
    if (!repo.getOutlook(req.account)) return res.status(400).json({ error: 'Outlook isn\u2019t connected yet' });
    try {
      const found = await app.locals.checkOutlook();
      const o = repo.getOutlook(req.account);
      if (o?.error) return res.status(502).json({ error: o.error });
      res.json({ ok: true, found });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Bills: every invoice of the business, to find them and mark several paid at once.
  api.get('/bills', (req, res) => res.json({ bills: repo.listBills(req.account) }));
  // "Export everything": one zip (spreadsheets + the original files) for the business's own records.
  api.get('/export', async (req, res) => {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: settingsFor(req.account).timezone || 'UTC' });
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="Job Costs export ${day}.zip"`, 'Cache-Control': 'no-store' });
    let closed = false;
    res.on('close', () => { closed = true; });
    const write = (buf) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Download cancelled'));
      if (res.write(buf)) return resolve();
      const done = () => { res.off('close', gone); resolve(); };
      const gone = () => { res.off('drain', done); reject(new Error('Download cancelled')); };
      res.once('drain', done); res.once('close', gone);
    });
    try {
      const r = await exportEverything(repo, req.account, write);
      res.end();
      console.log(`Export: ${r.invoices} invoices, ${r.jobs} jobs`);
    } catch (e) {
      console.error(`Export: ${e.message}`);
      res.destroy();
    }
  });
  api.get('/stock', (req, res) => res.json({ ...repo.listStock(req.account), jobs: repo.listJobs(req.account) }));
  api.post('/bills/paid', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : [];
    if (!ids.length || typeof req.body?.paid !== 'boolean') return res.status(400).json({ error: 'Choose invoices first' });
    let n = 0; const skipped = []; // copies of a bill that's already paid
    for (const id of ids) {
      const inv = repo.getInvoice(id);
      if (!inv || (inv.account_uuid ?? null) !== req.account) continue;
      if (req.body.paid) { const t = repo.twinOf(inv); if (t && t.paid) { skipped.push({ id, invoice_number: inv.invoice_number, twin: t }); continue; } }
      repo.setInvoicePaid(id, req.body.paid);
      n++;
    }
    res.json({ ok: true, updated: n, skipped });
  });

  // ---------- Statement check: price lists, rules, checks ----------
  const pdfOrPhoto = (f) => isSupported(f.originalname, guessMime(f.originalname, f.mimetype));
  api.get('/checks', (req, res) => res.json({
    checks: repo.listChecks(req.account), rules: repo.listRules(req.account),
    priceLists: repo.listPriceLists(req.account).map((p) => ({ id: p.id, supplier: p.supplier, name: p.name, created_at: p.created_at, mime_type: p.mime_type })),
    available: !!checker,
  }));
  // The Prices & rules page: price lists (with how many invoices were checked against each) and the rules.
  api.get('/prices', (req, res) => {
    const counts = new Map(repo.db.prepare(`SELECT json_extract(price_check, '$.price_list.id') AS pl, COUNT(*) AS n,
        SUM(CASE WHEN json_extract(price_check, '$.verdict') IN ('problem', 'check') THEN 1 ELSE 0 END) AS flagged
      FROM invoices WHERE account_uuid IS ? AND price_check_status = 'done' GROUP BY pl`).all(req.account).map((r) => [Number(r.pl), r]));
    res.json({
      available: !!checker,
      priceLists: repo.listPriceLists(req.account).map((p) => ({ id: p.id, supplier: p.supplier, name: p.name, created_at: p.created_at, mime_type: p.mime_type,
        checked: (counts.get(p.id) || {}).n || 0, flagged: (counts.get(p.id) || {}).flagged || 0 })),
      rules: repo.listRules(req.account),
    });
  });
  api.post('/rules', (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Write the rule first' });
    res.status(201).json(repo.addRule(req.account, text, { kind: req.body?.kind === 'once' ? 'once' : 'always', target: req.body?.target || null,
      supplier: req.body?.supplier || null }));
  });
  api.patch('/rules/:id', (req, res) => {
    const b = req.body || {};
    const text = b.text === undefined ? undefined : String(b.text).trim().slice(0, 2000);
    if (text === '') return res.status(400).json({ error: 'A rule can\u2019t be empty' });
    const r = repo.updateRule(req.account, req.params.id, { text, active: typeof b.active === 'boolean' ? b.active : undefined });
    return r ? res.json(r) : res.status(404).json({ error: 'Not found' });
  });
  api.delete('/rules/:id', (req, res) => (repo.deleteRule(req.account, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));

  api.post('/price-lists', upload.single('file'), (req, res) => {
    const supplier = String(req.body?.supplier || '').trim().slice(0, 120);
    if (!supplier) return res.status(400).json({ error: 'Which supplier is this price list for?' });
    if (!req.file || !pdfOrPhoto(req.file)) return res.status(400).json({ error: 'Choose the price list (PDF or photo)' });
    const p = repo.addPriceList(req.account, { supplier, name: req.file.originalname, mimeType: guessMime(req.file.originalname, req.file.mimetype),
      filePath: saveFile(path.join(folderFor(req.account), 'price-lists'), req.file.originalname, req.file.buffer) });
    // check this supplier's unpaid invoices that haven't been checked yet (newest first)
    let queued = 0;
    if (checker) {
      const unchecked = repo.db.prepare(`SELECT * FROM invoices WHERE account_uuid IS ? AND status = 'ready' AND (price_check_status IS NULL OR price_check_status = 'none')
          AND EXISTS (SELECT 1 FROM items WHERE items.invoice_id = invoices.id AND items.paid = 0) ORDER BY COALESCE(invoice_date, created_at) DESC LIMIT 200`).all(req.account)
        .filter((i) => { const pl = repo.priceListFor(req.account, i.supplier); return pl && pl.id === p.id; });
      queued = priceCheckUnchecked(req.account, unchecked);
    }
    res.status(201).json({ id: p.id, queued });
  });
  api.get('/price-lists/:id/file', (req, res) => {
    const p = repo.getPriceList(req.account, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.type(p.mime_type || 'application/pdf').set('Content-Disposition', `inline; filename="${safeName(p.name)}"`).sendFile(path.join(repo.filesDir, p.file_path));
  });
  api.delete('/price-lists/:id', (req, res) => (repo.deletePriceList(req.account, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));

  // Start a check: upload the statement (optionally only invoices dated from / to, and notes for this check).
  api.post('/checks', upload.single('statement'), (req, res) => {
    if (!checker) return res.status(500).json({ error: 'Statement checks aren\u2019t set up on the server (ANTHROPIC_API_KEY).' });
    if (!req.file || !pdfOrPhoto(req.file)) return res.status(400).json({ error: 'Choose the statement (PDF or photo)' });
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const c = repo.createCheck(req.account, {
      fileName: req.file.originalname, mimeType: guessMime(req.file.originalname, req.file.mimetype),
      filePath: saveFile(path.join(folderFor(req.account), 'statements'), req.file.originalname, req.file.buffer),
      dateFrom: day(req.body?.date_from), dateTo: day(req.body?.date_to), instructions: String(req.body?.instructions || '').trim().slice(0, 4000) || null,
    });
    runCheck(req.account, c.id).catch(() => {});
    res.status(201).json({ id: c.id });
  });
  api.get('/checks/:id', (req, res) => {
    const c = repo.getCheck(req.account, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    // Job numbers known to Job Costs, so any job mentioned in the report can be a link.
    const jobs = Object.fromEntries(repo.listJobs(req.account).map((j) => [String(j.job_number), j.job_uuid]));
    // a pattern the check suggested as a rule: already saved?
    if (c.result && c.result.suggested_rule) c.result.rule_saved = repo.listRules(req.account).some((r) => r.text === c.result.suggested_rule);
    // Paid can change after the check ran: show it as it is now.
    for (const m of c.matched || []) if (m.invoice) m.invoice.paid = repo.itemsOf(m.invoice.id).every((x) => x.paid) && repo.itemsOf(m.invoice.id).length > 0;
    res.json({ ...c, file_path: undefined, jobs, server_now: new Date().toISOString() });
  });
  api.get('/checks/:id/file', (req, res) => {
    const c = repo.getCheck(req.account, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.type(c.mime_type || 'application/pdf').sendFile(path.join(repo.filesDir, c.file_path));
  });
  // Run again (e.g. after adding a rule or a newer price list). The statement isn't read again.
  api.post('/checks/:id/rerun', (req, res) => {
    const c = repo.getCheck(req.account, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const lastMove = Date.parse(c.progress_at || c.started_at || c.created_at) || 0;
    if (['reading', 'checking'].includes(c.status) && Date.now() - lastMove < 12 * 60 * 1000) return res.status(409).json({ error: 'This check is still running' });
    const b = req.body || {};
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const set = {};
    if (b.date_from !== undefined) set.date_from = day(b.date_from);
    if (b.date_to !== undefined) set.date_to = day(b.date_to);
    if (b.instructions !== undefined) set.instructions = String(b.instructions || '').trim().slice(0, 4000) || null;
    if (!checker) return res.status(500).json({ error: 'Statement checks aren\u2019t set up on the server (ANTHROPIC_API_KEY).' });
    repo.updateCheck(c.id, { ...set, status: c.statement ? 'checking' : 'reading', error: null, attempts: 0 });
    runCheck(req.account, c.id).catch(() => {});
    res.json({ ok: true });
  });
  // Stop a running check: it goes back to "not run yet" and keeps its statement.
  api.post('/checks/:id/stop', (req, res) => {
    const c = repo.getCheck(req.account, req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!['reading', 'checking'].includes(c.status)) return res.json({ ok: true });
    stopRequested.add(c.id);
    // saved straight away, so it holds even if the app restarts; the running work notices at its next step
    repo.updateCheck(c.id, { status: 'waiting', progress: null, attempts: 0 });
    res.json({ ok: true });
  });
  api.delete('/checks/:id', (req, res) => (repo.deleteCheck(req.account, req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));
  // Mark the invoices of a check paid: { references: [...] } (or all the ones found in Job Costs).
  api.post('/checks/:id/resolve', (req, res) => {
    const ref = String(req.body?.reference || '');
    const ok = repo.resolveCheckFlag(req.account, req.params.id, ref, { resolved: req.body?.resolved !== false, note: String(req.body?.note || '').trim().slice(0, 500) || null });
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  });
  api.post('/checks/:id/mark-paid', (req, res) => {
    const c = repo.getCheck(req.account, req.params.id);
    if (!c || !c.matched) return res.status(404).json({ error: 'Not found' });
    const want = Array.isArray(req.body?.references) ? new Set(req.body.references.map(String)) : null;
    let n = 0;
    const done = new Set();
    for (const m of c.matched) {
      if (!m.invoice || m.type === 'credit' || done.has(m.invoice.id) || (want && !want.has(String(m.reference)))) continue;
      done.add(m.invoice.id);
      const inv = repo.getInvoice(m.invoice.id);
      if (!inv || (inv.account_uuid ?? null) !== req.account) continue;
      const t = repo.twinOf(inv); if (t && t.paid) continue; // a copy of a bill that's already paid
      repo.setInvoicePaid(inv.id, true);
      n++;
    }
    res.json({ ok: true, updated: n });
  });

  // Reports across all jobs of the business.
  api.get('/report', (req, res) => {
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    res.json(repo.getReport(req.account, { from: date(req.query.from), to: date(req.query.to) }));
  });

  app.use('/api', api);

  // For the add-on's owner only (ADMIN_KEY): what each business used and roughly cost, to set prices and limits.
  app.get('/admin/usage', (req, res) => {
    if (!config.adminKey || String(req.query.key || '') !== config.adminKey) return res.status(404).type('text').send('Not found');
    const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const kinds = ['invoice_read', 'price_check', 'statement_read', 'statement_check'];
    const rows = [];
    for (const a of repo.db.prepare('SELECT account_key FROM accounts ORDER BY account_key').all()) {
      const acc = a.account_key === '' ? null : a.account_key;
      const st = repo.getSettings(acc);
      for (const m of repo.listUsage(acc, 3)) {
        rows.push(`<tr><td>${esc(st.business_name || a.account_key || '(test)')}</td><td>${esc(m.month)}</td>${kinds.map((k) => `<td style="text-align:right">${(m.kinds[k] || {}).count || 0}</td>`).join('')}
          <td style="text-align:right"><b>$${m.cost.toFixed(2)}</b></td><td style="text-align:right">${(m.kinds.invoice_read || {}).count ? '$' + (((m.kinds.invoice_read || {}).cost || 0) / m.kinds.invoice_read.count).toFixed(3) : ''}</td></tr>`);
      }
    }
    res.set('Cache-Control', 'no-store').type('html').send(htmlPage('Job Costs usage', `<h2 style="margin-top:0">Usage by business</h2>
      <p style="color:#6b8a82">Claude requests per month and the estimated cost in USD (from the token counts and CLAUDE_PRICE_* rates).</p>
      <table style="border-collapse:collapse;font-size:13px" cellpadding="6"><tr style="text-align:left"><th>Business</th><th>Month</th><th>Invoices read</th><th>Price checks</th><th>Statements read</th><th>Statement checks</th><th>Est. cost</th><th>Per invoice read</th></tr>
      ${rows.join('') || '<tr><td colspan="8">Nothing yet.</td></tr>'}</table>`).replace('max-width:460px', 'max-width:980px'));
  });

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
    const ids = [];
    for (const acc of accounts) {
      for (const f of files) {
        const inv = addInvoiceFile({
          accountUUID: acc.accountUUID, source, name: f.name, contentType: f.contentType, buffer: f.buffer,
          emailFrom: mail.from, emailSubject: mail.subject, emailText: body,
        });
        ids.push(inv.id);
        created++;
      }
    }
    return { matched: accounts.length, created, ids };
  }
  app.locals.processMail = processMail;

  // ---------- Outlook (Microsoft 365) ----------
  const msApp = () => ({ clientId: config.msClientId, clientSecret: config.msClientSecret, tenant: config.msTenantId });
  const outlookRedirect = () => `${config.publicUrl}/outlook/callback`;
  let outlookRunning = null; // one check at a time, so an email is never picked up twice
  // { scheduled: true }: the automatic check, only for businesses in their checking hours ("Check now" checks any time)
  app.locals.checkOutlook = ({ scheduled = false } = {}) => {
    if (!outlookRunning) {
      outlookRunning = outlook.checkOutlook({
        repo, config, api: outlookApi, only: scheduled ? (acc) => outlook.inCheckingHours(hoursOf(acc === '' ? null : acc)) : null,
        onMail: (mail, account) => processMail(mail, { accountUUID: account || null, source: 'outlook' }),
      }).finally(() => { outlookRunning = null; });
    }
    return outlookRunning;
  };

  // "Connect Outlook" (opened from the card): sign in to Microsoft and allow reading mail.
  app.get('/outlook/connect', (req, res) => {
    const sess = sessionFrom(req.query.t);
    if (!sess) return res.status(401).type('html').send(htmlPage('Job Costs', '<h2>Session expired</h2><p>Open Job Costs from ServiceM8 and try again.</p>'));
    const job = sess.job || { account_uuid: sess.account };
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
