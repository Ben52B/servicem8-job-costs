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
      // Total of the job's billing lines (the quote / invoice amount) in ServiceM8.
      quoteAmount: Number(job.total_invoice_amount) > 0 ? Number(job.total_invoice_amount) : null,
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
      quoteAmount: Number(j.total_invoice_amount) > 0 ? Number(j.total_invoice_amount) : null,
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
async function fetchAccount(accessToken) {
  const res = await fetch(`${API_BASE}/vendor.json`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const v = [].concat(await res.json())[0];
  return v && v.uuid ? { accountUUID: v.uuid, name: v.name || null } : null;
}

module.exports = {
  verifyEvent, fetchJob, fetchActiveJobs, looksLikeStockJob, extractToken,
  authorizeUrl, exchangeCode, refreshAccessToken, fetchAccount,
};
