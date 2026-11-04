const jwt = require('jsonwebtoken');
const querystring = require('querystring');

const API_BASE = 'https://api.servicem8.com/api_1.0';

/**
 * ServiceM8 POSTs a JWT (signed with the add-on's App Secret, HS256) when a user
 * clicks the add-on's button on a job card. Accept a raw JWT body, or a form /
 * JSON body that carries the token in a field.
 */
function extractToken(body) {
  if (!body) return null;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'object') {
    return body.jwt || body.token || body.data || Object.keys(body).find((k) => k.split('.').length === 3) || null;
  }
  const raw = String(body).trim();
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw)) return raw;
  if (raw.startsWith('{')) {
    try { return extractToken(JSON.parse(raw)); } catch { /* fall through */ }
  }
  const form = querystring.parse(raw);
  return extractToken(form);
}

function verifyEvent(body, appSecret) {
  const token = extractToken(body);
  if (!token) throw new Error('No ServiceM8 token in request');
  if (!appSecret) throw new Error('SERVICEM8_APP_SECRET is not set');
  const event = jwt.verify(token, appSecret, { algorithms: ['HS256'] });
  const jobUUID = event?.eventArgs?.jobUUID;
  if (!jobUUID) throw new Error('This add-on must be opened from a job');
  return {
    eventName: String(event.eventName || '').toLowerCase(),
    jobUUID,
    accountUUID: event?.auth?.accountUUID || null,
    staffUUID: event?.auth?.staffUUID || null,
    accessToken: event?.auth?.accessToken || null,
  };
}

/** Look up the job number / address so the card can show which job it is. Best effort. */
// Names of clients (companies) and job categories, cached for a while.
const nameCache = new Map();
async function lookupName(kind, uuid, accessToken) {
  if (!uuid || !accessToken) return null;
  const key = `${kind}:${uuid}`;
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.at < 3600000) return hit.name;
  try {
    const res = await fetch(`${API_BASE}/${kind}/${encodeURIComponent(uuid)}.json`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const name = (await res.json()).name || null;
    nameCache.set(key, { name, at: Date.now() });
    return name;
  } catch {
    return null;
  }
}

async function jobNames(job, accessToken) {
  const [clientName, categoryName] = await Promise.all([
    lookupName('company', job.company_uuid, accessToken),
    lookupName('category', job.category_uuid, accessToken),
  ]);
  return { clientName, categoryName };
}

/**
 * The job's full price, ex GST: every billing line on the job except "Partial invoice"
 * lines (those move part of the job to a split job like #207974A and would otherwise
 * make the job look smaller than it is). null if the lines can't be read.
 */
function fullPriceFromLines(lines) {
  let sum = 0;
  let any = false;
  for (const l of lines || []) {
    if (String(l.active) === '0') continue;
    if (/partial\s*invoice/i.test(`${l.name || ''} ${l.item_number || ''}`)) continue;
    const qty = Number(l.quantity);
    const price = Number(l.price);
    if (!isFinite(qty) || !isFinite(price)) continue;
    sum += qty * price;
    any = true;
  }
  return any ? Math.round(sum * 100) / 100 : null;
}

async function fetchJobLines(jobUUID, accessToken) {
  try {
    const filter = encodeURIComponent(`job_uuid eq '${jobUUID}'`);
    const res = await fetch(`${API_BASE}/jobmaterial.json?%24filter=${filter}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const why = `${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}`;
      console.error(`ServiceM8 job lines: ${why}`);
      return { error: `ServiceM8 wouldn't share the job's lines (${why})` };
    }
    return await res.json();
  } catch (e) {
    console.error(`ServiceM8 job lines failed: ${e.message}`);
    return { error: `Couldn't reach ServiceM8 for the job's lines (${e.message})` };
  }
}

/** Find a job by its number (e.g. the main job #207974 of a split job #207974A). */
async function findJobByNumber(jobNumber, accessToken) {
  if (!accessToken || !jobNumber) return null;
  try {
    const filter = encodeURIComponent(`generated_job_id eq '${String(jobNumber).replace(/'/g, '')}'`);
    const res = await fetch(`${API_BASE}/job.json?%24filter=${filter}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const j = [].concat(await res.json()).find((x) => x && x.uuid && String(x.active) !== '0');
    return j ? j.uuid : null;
  } catch {
    return null;
  }
}

async function fetchJob(jobUUID, accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${API_BASE}/job/${encodeURIComponent(jobUUID)}.json`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const job = await res.json();
    return {
      ...(await jobNames(job, accessToken)),
      jobNumber: job.generated_job_id ? String(job.generated_job_id) : null,
      jobTitle: (job.job_address || job.job_description || '').split('\n')[0].slice(0, 200) || null,
      // Full job price ex GST from its lines (not counting "Partial invoice" lines).
      ...(await (async () => {
        const lines = await fetchJobLines(jobUUID, accessToken);
        if (lines && lines.error) return { quoteAmount: null, linesError: lines.error };
        return { quoteAmount: fullPriceFromLines(lines), linesError: null };
      })()),
      status: job.status || null,
    };
  } catch {
    return null;
  }
}

/**
 * Active jobs (quotes and work orders) so emailed invoices can be matched to them.
 * Best effort: returns [] if ServiceM8 can't be reached.
 */
async function fetchActiveJobs(accessToken) {
  if (!accessToken) return [];
  const raw = [];
  for (const status of ['Work Order', 'Quote']) {
    try {
      const filter = encodeURIComponent(`status eq '${status}'`);
      const res = await fetch(`${API_BASE}/job.json?%24filter=${filter}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      for (const j of await res.json()) if (j.uuid && String(j.active) !== '0') raw.push({ ...j, status });
    } catch { /* ignore */ }
  }
  // Look up client and category names (a few at a time; cached).
  const out = [];
  for (let i = 0; i < raw.length; i += 8) {
    const batch = raw.slice(i, i + 8);
    const names = await Promise.all(batch.map((j) => jobNames(j, accessToken)));
    batch.forEach((j, k) => out.push({
      jobUUID: j.uuid,
      jobNumber: j.generated_job_id ? String(j.generated_job_id) : null,
      jobTitle: (j.job_address || j.job_description || '').split('\n')[0].slice(0, 200) || null,
      status: j.status,
      ...names[k],
    }));
  }
  return out;
}

/** Is this a stock order job, by its client or category name? */
function looksLikeStockJob({ clientName, categoryName }, { stockJobClients = [], stockJobCategories = [] } = {}) {
  const has = (name, words) => !!name && words.some((w) => String(name).toLowerCase().includes(w));
  return has(clientName, stockJobClients) || has(categoryName, stockJobCategories);
}

// ---------- OAuth: the one-off approval when the add-on is installed ----------
const OAUTH_BASE = 'https://go.servicem8.com/oauth';

function authorizeUrl({ appId, redirectUri, scope, state }) {
  const q = new URLSearchParams({ response_type: 'code', client_id: appId, scope, redirect_uri: redirectUri, state });
  return `${OAUTH_BASE}/authorize?${q}`;
}

async function tokenRequest(fields) {
  const res = await fetch(`${OAUTH_BASE}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(body.error_description || body.error || `ServiceM8 said ${res.status}`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token || null, expiresIn: Number(body.expires_in) || 3600 };
}

const exchangeCode = ({ appId, appSecret, code, redirectUri }) =>
  tokenRequest({ grant_type: 'authorization_code', client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri });
const refreshAccessToken = ({ appId, appSecret, refreshToken }) =>
  tokenRequest({ grant_type: 'refresh_token', client_id: appId, client_secret: appSecret, refresh_token: refreshToken });

/** Which ServiceM8 account a token belongs to. */
// Best effort: may need a permission the add-on doesn't have. If it can't tell, the
// approval is linked to the account the first time someone clicks Job Costs instead.
async function fetchAccount(accessToken) {
  try {
    const res = await fetch(`${API_BASE}/vendor.json`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`ServiceM8 account lookup: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return null;
    }
    const v = [].concat(await res.json())[0];
    return v && v.uuid ? { accountUUID: v.uuid, name: v.name || null } : null;
  } catch (e) {
    console.error(`ServiceM8 account lookup failed: ${e.message}`);
    return null;
  }
}

// ---------- Job diary: attachments and notes ----------

async function sm8(method, path, accessToken, { json, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`ServiceM8 said ${res.status}${text ? ': ' + text : ''}`);
  }
  if (raw) return res;
  const t = await res.text();
  return { uuid: res.headers.get('x-record-uuid'), data: t ? (() => { try { return JSON.parse(t); } catch { return t; } })() : null };
}

/** PDFs and photos attached to these jobs (the job's diary files). */
async function listJobFiles(jobUUIDs, accessToken) {
  const out = [];
  for (const jobUUID of jobUUIDs) {
    const filter = encodeURIComponent(`related_object_uuid eq '${jobUUID}'`);
    const { data } = await sm8('GET', `attachment.json?%24filter=${filter}`, accessToken);
    for (const a of [].concat(data || [])) {
      out.push({
        uuid: a.uuid, job_uuid: jobUUID, name: a.attachment_name || 'File', file_type: a.file_type || '',
        active: String(a.active) !== '0', date: a.timestamp || a.edit_date || null, source: a.attachment_source || '',
      });
    }
  }
  return out;
}

async function downloadJobFile(attachmentUUID, accessToken) {
  const res = await sm8('GET', `Attachment/${encodeURIComponent(attachmentUUID)}.file`, accessToken, { raw: true, headers: { Accept: '*/*' } });
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

/** Attach a file to a job (it shows in the job's diary). Returns the attachment's uuid. */
async function addJobFile({ jobUUID, name, buffer, contentType }, accessToken) {
  const ext = (String(name).match(/\.[a-z0-9]{2,5}$/i) || ['.pdf'])[0].toLowerCase();
  const created = await sm8('POST', 'attachment.json', accessToken, {
    json: { related_object: 'job', related_object_uuid: jobUUID, attachment_name: name, file_type: ext, active: 1 },
  });
  if (!created.uuid) throw new Error('ServiceM8 didn\u2019t return the new attachment');
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), name);
  try {
    await sm8('POST', `Attachment/${created.uuid}.file`, accessToken, { body: fd });
  } catch (e) {
    if (!/said 4\d\d/.test(e.message) || /said 40[13]/.test(e.message)) throw e;
    // Some accounts want the file itself as the body rather than a form.
    await sm8('POST', `Attachment/${created.uuid}.file`, accessToken, { body: buffer, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
  }
  return created.uuid;
}

async function addJobNote({ jobUUID, text }, accessToken) {
  const created = await sm8('POST', 'note.json', accessToken, { json: { related_object: 'job', related_object_uuid: jobUUID, note: text, active: 1 } });
  return created.uuid || null;
}

const removeJobFile = (uuid, accessToken) => sm8('DELETE', `attachment/${encodeURIComponent(uuid)}.json`, accessToken);
const removeJobNote = (uuid, accessToken) => sm8('DELETE', `note/${encodeURIComponent(uuid)}.json`, accessToken);

module.exports = {
  verifyEvent, fetchJob, fetchActiveJobs, looksLikeStockJob, extractToken, fullPriceFromLines, findJobByNumber,
  authorizeUrl, exchangeCode, refreshAccessToken, fetchAccount,
  listJobFiles, downloadJobFile, addJobFile, addJobNote, removeJobFile, removeJobNote,
};
