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
async function listMessages(accessToken, since) {
  const q = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $orderby: 'receivedDateTime desc',
    $top: '50',
    $select: 'id,internetMessageId,subject,from,receivedDateTime,hasAttachments,body,toRecipients',
  });
  let url = `/me/mailFolders/inbox/messages?${q}`;
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

const graphApi = { authorizeUrl, exchangeCode, refreshTokens, fetchMe, listMessages, listAttachments };

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
      let last = conn.last_received;
      for (const m of messages) {
        const key = `ms:${m.id}`;
        const idKey = m.internetMessageId ? `id:${m.internetMessageId}` : null;
        if (repo.isMailProcessed(key) || (idKey && repo.isMailProcessed(idKey))) continue;
        try {
          const text = m.body?.content || '';
          const attachments = m.hasAttachments ? await api.listAttachments(token, m.id) : [];
          const from = m.from?.emailAddress ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address || ''}>`.trim() : '';
          const mail = { messageId: m.internetMessageId || null, from, subject: m.subject || '', text, html: '', recipients: [], attachments };
          const files = pickFiles(mail);
          const mentionsInvoice = INVOICE_WORDS.test(`${mail.subject}\n${text.slice(0, 3000)}`);
          if (files.length || (mentionsInvoice && text.trim().length > 80)) {
            await onMail({ ...mail, attachments: files }, conn.account_key || null);
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

module.exports = { graphApi, checkOutlook, startOutlookPoller, pickFiles, inCheckingHours, scheduleText, SCOPES };
