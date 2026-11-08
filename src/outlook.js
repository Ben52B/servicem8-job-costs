/**
 * Outlook (Microsoft 365) listener: reads the business's Outlook inbox through Microsoft Graph
 * with read-only access (Mail.Read), every couple of minutes. It never changes, moves or
 * deletes emails. Emails are remembered by their ID so each is looked at once.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access User.Read Mail.Read';
const FIRST_LOOK_BACK_DAYS = 3;

const loginBase = (tenant) => `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'organizations')}/oauth2/v2.0`;

function authorizeUrl({ clientId, tenant, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: SCOPES, state, prompt: 'select_account',
  });
  return `${loginBase(tenant)}/authorize?${q}`;
}

async function tokenRequest({ clientId, clientSecret, tenant }, fields) {
  const res = await fetch(`${loginBase(tenant)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: SCOPES, ...fields }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Microsoft said ${res.status}: ${data.error_description || data.error || 'no access token'}`.slice(0, 300));
  return { accessToken: data.access_token, refreshToken: data.refresh_token || fields.refresh_token || null, expiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString() };
}
const exchangeCode = (app, { code, redirectUri }) => tokenRequest(app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
const refreshTokens = (app, refreshToken) => tokenRequest(app, { grant_type: 'refresh_token', refresh_token: refreshToken });

async function graph(path, accessToken) {
  const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', Prefer: 'outlook.body-content-type="text"' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Outlook said ${res.status}${t ? ': ' + t : ''}`);
  }
  return res.json();
}

async function fetchMe(accessToken) {
  const me = await graph('/me?$select=mail,userPrincipalName,displayName', accessToken);
  return { email: me.mail || me.userPrincipalName || null, name: me.displayName || null };
}

/** New inbox emails received since `since` (oldest first). */
/**
 * New emails received since `since`, in EVERY folder (the Inbox, its subfolders and any other folder),
 * so an email filed away before the next check is still found. One query, only the new emails.
 */
async function listMessages(accessToken, since) {
  const q = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $orderby: 'receivedDateTime desc',
    $top: '50',
    $select: 'id,internetMessageId,subject,from,receivedDateTime,hasAttachments,body,toRecipients,parentFolderId',
  });
  let url = `/me/messages?${q}`;
  const out = [];
  for (let page = 0; url && page < 10; page++) {
    const data = await graph(url, accessToken);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.reverse();
}

async function listAttachments(accessToken, messageId) {
  const data = await graph(`/me/messages/${encodeURIComponent(messageId)}/attachments`, accessToken);
  const out = [];
  for (const a of data.value || []) {
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue; // skip attached emails / links
    let buffer = a.contentBytes ? Buffer.from(a.contentBytes, 'base64') : null;
    if (!buffer) {
      const res = await fetch(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}/$value`, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) continue;
      buffer = Buffer.from(await res.arrayBuffer());
    }
    out.push({ name: a.name || 'attachment', contentType: a.contentType || '', buffer, inline: !!a.isInline });
  }
  return out;
}

/** Every mail folder, with its full path ("Inbox / Need to pay / Gliderol"), a few levels deep. */
async function listFolders(accessToken) {
  const out = [];
  async function walk(url, prefix, depth) {
    for (let page = 0; url && page < 5; page++) {
      const data = await graph(url, accessToken);
      for (const f of data.value || []) {
        const p = prefix ? `${prefix} / ${f.displayName}` : f.displayName;
        out.push({ id: f.id, path: p, count: f.totalItemCount ?? null });
        if (f.childFolderCount && depth < 4) await walk(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?$top=100&$select=id,displayName,childFolderCount,totalItemCount`, p, depth + 1);
      }
      url = data['@odata.nextLink'] || null;
    }
  }
  await walk('/me/mailFolders?$top=100&$select=id,displayName,childFolderCount,totalItemCount', '', 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Emails in a folder received between two dates (oldest first). */
async function listFolderMessages(accessToken, folderId, from, to) {
  const q = new URLSearchParams({
    ...(from && to ? { $filter: `receivedDateTime ge ${from.toISOString()} and receivedDateTime lt ${to.toISOString()}` } : {}),
    $orderby: 'receivedDateTime desc',
    $top: '50',
    $select: 'id,internetMessageId,subject,from,receivedDateTime,hasAttachments,body',
  });
  let url = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${q}`;
  const out = [];
  for (let page = 0; url && page < 20; page++) {
    const data = await graph(url, accessToken);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.reverse();
}

/** The folders directly inside one folder (or the top level), for browsing. */
async function childFolders(accessToken, parentId) {
  const sel = '$top=100&$select=id,displayName,childFolderCount,totalItemCount';
  let url = parentId ? `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders?${sel}` : `/me/mailFolders?${sel}`;
  const out = [];
  for (let page = 0; url && page < 5; page++) {
    const data = await graph(url, accessToken);
    for (const f of data.value || []) out.push({ id: f.id, name: f.displayName, childCount: f.childFolderCount || 0, count: f.totalItemCount ?? null });
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/** One page of a folder's emails, newest first. `pageUrl` continues from the previous page. */
async function folderPage(accessToken, folderId, pageUrl) {
  // Only follow "next page" links that point back at Microsoft Graph.
  const url = pageUrl && String(pageUrl).startsWith(`${GRAPH}/`) ? pageUrl
    : `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${new URLSearchParams({ $orderby: 'receivedDateTime desc', $top: '40',
      $select: 'id,internetMessageId,subject,from,receivedDateTime,hasAttachments' })}`;
  const data = await graph(url, accessToken);
  return {
    messages: (data.value || []).map((m) => ({ id: m.id, internetMessageId: m.internetMessageId || null, subject: m.subject || '(no subject)',
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '', received: m.receivedDateTime, hasAttachments: !!m.hasAttachments })),
    next: data['@odata.nextLink'] || null,
  };
}

async function getMessage(accessToken, id) {
  return graph(`/me/messages/${encodeURIComponent(id)}?$select=id,internetMessageId,subject,from,receivedDateTime,hasAttachments,body`, accessToken);
}

/** Folders the automatic check leaves alone: Sent, Deleted, Drafts, Junk, Outbox. */
async function skippedFolderIds(accessToken) {
  const ids = [];
  for (const name of ['sentitems', 'deleteditems', 'drafts', 'junkemail', 'outbox']) {
    try { ids.push((await graph(`/me/mailFolders/${name}?$select=id`, accessToken)).id); } catch { /* not every mailbox has every folder */ }
  }
  return ids;
}

const graphApi = { skippedFolderIds, authorizeUrl, exchangeCode, refreshTokens, fetchMe, listMessages, listAttachments, listFolders, listFolderMessages, childFolders, folderPage, getMessage };

/** Is this email worth reading? Attachments (PDF / real photos), or a body that talks about an invoice. */
const INVOICE_WORDS = /\b(tax\s*invoice|invoice|inv\s*#?\d|receipt|bill|statement of account|remittance|payment due|amount due)\b/i;
function pickFiles(mail) {
  const pdfs = mail.attachments.filter((a) => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.name));
  if (pdfs.length) return pdfs;
  return mail.attachments.filter((a) => /^image\/(jpe?g|png|webp|gif)/i.test(a.contentType) && !a.inline && a.buffer.length >= 30 * 1024);
}

/**
 * One pass over every connected Outlook: new emails go to onMail(mail, accountUUID).
 * Emails without a PDF/photo are only passed on if the subject or text mentions an invoice.
 */
/** A working access token for this Outlook connection (refreshed when due). */
async function tokenFor(conn, { repo, config, api = graphApi }) {
  if (conn.access_token && Date.parse(conn.expires_at) - Date.now() > 120000) return conn.access_token;
  const fresh = await api.refreshTokens({ clientId: config.msClientId, clientSecret: config.msClientSecret, tenant: config.msTenantId }, conn.refresh_token);
  repo.saveOutlook(conn.account_key, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt });
  return fresh.accessToken;
}

/** Turn a Graph message into the email Job Costs reads: its PDFs / photos, or its text if it talks about an invoice. */
async function toMail(api, token, m) {
  const text = m.body?.content || '';
  const attachments = m.hasAttachments ? await api.listAttachments(token, m.id) : [];
  const from = m.from?.emailAddress ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address || ''}>`.trim() : '';
  const mail = { messageId: m.internetMessageId || null, from, subject: m.subject || '', text, html: '', recipients: [], attachments };
  const files = pickFiles(mail);
  const worthReading = files.length > 0 || (INVOICE_WORDS.test(`${mail.subject}\n${text.slice(0, 3000)}`) && text.trim().length > 80);
  return { mail: { ...mail, attachments: files }, worthReading };
}

/**
 * Import every invoice email in one folder between two dates (e.g. "Need to pay / Gliderol", October).
 * Emails already brought in by this import are skipped; everything goes to the Job Costs Inbox.
 */
async function importFolder({ repo, config, api = graphApi, accountKey, folderId, from, to, onMail }) {
  const conn = repo.getOutlook(accountKey);
  if (!conn || !conn.refresh_token) throw new Error('Outlook isn\u2019t connected');
  const token = await tokenFor(conn, { repo, config, api });
  return importList({ repo, api, token, accountKey, onMail, messages: await api.listFolderMessages(token, folderId, from, to) });
}

/** Import chosen emails (by id) and whole folders (every email in them). */
async function importChosen({ repo, config, api = graphApi, accountKey, messageIds = [], folderIds = [], onMail, again = false }) {
  const conn = repo.getOutlook(accountKey);
  if (!conn || !conn.refresh_token) throw new Error('Outlook isn\u2019t connected');
  const token = await tokenFor(conn, { repo, config, api });
  const messages = [];
  for (const f of folderIds) messages.push(...await api.listFolderMessages(token, f, null, null));
  const have = new Set(messages.map((m) => m.id));
  const picked = new Set();
  for (const id of messageIds) {
    if (!have.has(id)) { const m = await api.getMessage(token, id); messages.push(m); have.add(id); }
    picked.add(id);
  }
  // emails ticked one by one can be brought in again on purpose ("again"); whole folders never repeat
  return importList({ repo, api, token, accountKey, onMail, messages, force: again ? picked : null });
}

/** Has this email been imported already? (by its id) */
const importKey = (m) => `import:${m.internetMessageId || m.id}`;

async function importList({ repo, api, token, accountKey, onMail, messages, force = null }) {
  const result = { emails: messages.length, imported: 0, files: 0, skipped: 0, notInvoices: 0 };
  for (const m of messages) {
    const key = importKey(m);
    if (repo.isMailProcessed(key) && !(force && force.has(m.id))) { result.skipped++; continue; }
    const { mail, worthReading } = await toMail(api, token, m);
    if (worthReading) {
      const r = await onMail(mail, accountKey || null);
      result.imported++;
      result.files += (r && r.created) || 0;
    } else {
      result.notInvoices++;
    }
    repo.markMailProcessed(key);
  }
  return result;
}

const skipCache = new Map(); // account -> { ids, at }

async function checkOutlook({ repo, config, api = graphApi, onMail, log = console }) {
  const app = { clientId: config.msClientId, clientSecret: config.msClientSecret, tenant: config.msTenantId };
  let handled = 0;
  for (const conn of repo.listOutlookConnections()) {
    try {
      let token = conn.access_token;
      if (!token || Date.parse(conn.expires_at) - Date.now() < 120000) {
        const fresh = await api.refreshTokens(app, conn.refresh_token);
        repo.saveOutlook(conn.account_key, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt });
        token = fresh.accessToken;
      }
      // Look a little before the newest email seen (emails can arrive late); IDs stop repeats.
      const newest = conn.last_received ? Date.parse(conn.last_received) - 6 * 3600000 : Date.parse(conn.connected_at) - FIRST_LOOK_BACK_DAYS * 86400000;
      const messages = await api.listMessages(token, new Date(newest));
      // Sent, Deleted, Drafts, Junk and Outbox are skipped (looked up once a day per mailbox)
      const cached = skipCache.get(conn.account_key);
      const skip = cached && Date.now() - cached.at < 86400000 ? cached.ids
        : (api.skippedFolderIds ? await api.skippedFolderIds(token).catch(() => []) : []);
      if (!cached || cached.ids !== skip) skipCache.set(conn.account_key, { ids: skip, at: Date.now() });
      let last = conn.last_received;
      for (const m of messages) {
        const key = `ms:${m.id}`;
        const idKey = m.internetMessageId ? `id:${m.internetMessageId}` : null;
        // seen before (here, or brought in with "Import from Outlook"), or in a folder that's skipped
        if (repo.isMailProcessed(key) || (idKey && repo.isMailProcessed(idKey)) || repo.isMailProcessed(importKey(m))) continue;
        if (m.parentFolderId && skip.includes(m.parentFolderId)) { repo.markMailProcessed(key); continue; }
        try {
          const text = m.body?.content || '';
          const attachments = m.hasAttachments ? await api.listAttachments(token, m.id) : [];
          const from = m.from?.emailAddress ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address || ''}>`.trim() : '';
          const mail = { messageId: m.internetMessageId || null, from, subject: m.subject || '', text, html: '', recipients: [], attachments };
          const files = pickFiles(mail);
          const mentionsInvoice = INVOICE_WORDS.test(`${mail.subject}\n${text.slice(0, 3000)}`);
          if (files.length || (mentionsInvoice && text.trim().length > 80)) {
            await onMail({ ...mail, attachments: files }, conn.account_key || null);
            repo.markMailProcessed(importKey(m)); // shows as "✓ imported" in Import from Outlook
            handled++;
          }
        } catch (e) {
          log.error(`Outlook: couldn't handle "${m.subject}": ${e.message}`);
        }
        repo.markMailProcessed(key);
        if (idKey) repo.markMailProcessed(idKey);
        if (!last || m.receivedDateTime > last) last = m.receivedDateTime;
      }
      repo.saveOutlook(conn.account_key, { lastReceived: last, lastCheck: new Date().toISOString(), error: null });
    } catch (e) {
      log.error(`Outlook check failed for ${conn.email}: ${e.message}`);
      repo.saveOutlook(conn.account_key, { lastCheck: new Date().toISOString(), error: e.message.slice(0, 300) });
    }
  }
  return handled;
}

function startOutlookPoller({ repo, config, onMail, log = console, seconds = 120 }) {
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const n = await checkOutlook({ repo, config, onMail, log });
      if (n) log.log(`Outlook: ${n} new email${n === 1 ? '' : 's'} with possible invoices`);
    } finally {
      busy = false;
    }
  }
  tick();
  const timer = setInterval(tick, Math.max(60, seconds) * 1000);
  return { stop: () => clearInterval(timer), tick };
}

/** Is now within the automatic checking hours (e.g. Mon–Fri 6am–6pm Melbourne time)? */
function inCheckingHours(config, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: config.outlookTimezone || 'Australia/Melbourne', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const day = String(parts.weekday).toLowerCase().slice(0, 3);
  const hour = Number(parts.hour);
  const days = config.outlookDays || ['mon', 'tue', 'wed', 'thu', 'fri'];
  return days.includes(day) && hour >= (config.outlookFromHour ?? 6) && hour < (config.outlookToHour ?? 18);
}
function scheduleText(config) {
  const days = config.outlookDays || ['mon', 'tue', 'wed', 'thu', 'fri'];
  const d = days.join(',') === 'mon,tue,wed,thu,fri' ? 'Mon–Fri' : days.map((x) => x[0].toUpperCase() + x.slice(1)).join(', ');
  const h = (n) => (n === 0 ? '12am' : n < 12 ? `${n}am` : n === 12 ? '12pm' : `${n - 12}pm`);
  return `every ${Math.round(Math.max(60, config.outlookPollSeconds || 120) / 60)} min, ${d} ${h(config.outlookFromHour ?? 6)}–${h(config.outlookToHour ?? 18)}`;
}

module.exports = { graphApi, checkOutlook, importFolder, importChosen, importKey, tokenFor, startOutlookPoller, pickFiles, inCheckingHours, scheduleText, SCOPES };
