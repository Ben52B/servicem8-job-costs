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
  const out = [];
  for (const status of ['Work Order', 'Quote']) {
    try {
      const filter = encodeURIComponent(`status eq '${status}'`);
      const res = await fetch(`${API_BASE}/job.json?%24filter=${filter}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      for (const j of await res.json()) {
        if (!j.uuid || String(j.active) === '0') continue;
        out.push({
          jobUUID: j.uuid,
          jobNumber: j.generated_job_id ? String(j.generated_job_id) : null,
          jobTitle: (j.job_address || j.job_description || '').split('\n')[0].slice(0, 200) || null,
          quoteAmount: Number(j.total_invoice_amount) > 0 ? Number(j.total_invoice_amount) : null,
          status,
        });
      }
    } catch { /* ignore */ }
  }
  return out;
}

module.exports = { verifyEvent, fetchJob, fetchActiveJobs, extractToken };
