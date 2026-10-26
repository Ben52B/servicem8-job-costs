const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const { openDb, allocateCosts } = require('../src/db');
const { createProcessor } = require('../src/processor');
const { createApp } = require('../src/app');
const { codesFromAddresses, inboxAddress } = require('../src/inbound');

const SECRET = 'sm8-app-secret';
const config = {
  publicUrl: 'http://test', sessionSecret: 'session-secret', servicem8AppSecret: SECRET,
  inboundBaseAddress: 'abc123@inbound.postmarkapp.com', inboundDomain: '', inboundSecret: 'mailkey', devMode: false,
};

// Fake reader: answers based on the file name so tests are deterministic.
const fakeAnalyzer = {
  calls: [],
  async analyzeFile({ fileName, context }) {
    this.calls.push({ fileName, context });
    if (/notinvoice/.test(fileName)) throw new Error('This does not look like an invoice or receipt.');
    if (/receipt/.test(fileName)) {
      return { is_financial_document: true, document_type: 'receipt', supplier_name: 'Bunnings', invoice_number: 'R-1', total: 55, tax: 5, payment_status: 'paid',
        items: [{ description: 'Dynabolts', category: 'materials', line_total: 50 }] };
    }
    return {
      is_financial_document: true, document_type: 'tax_invoice', supplier_name: 'Door Supplies Pty Ltd', supplier_abn: null,
      invoice_number: 'INV-100', invoice_date: '2026-10-01', due_date: '2026-10-31', currency: 'AUD',
      subtotal: 3000, tax: 300, total: 3300, payment_status: 'unpaid', notes: null,
      items: [
        { description: 'Sectional door', category: 'materials', quantity: 1, unit: 'ea', unit_price: 2000, line_total: 2000 },
        { description: 'Motor', category: 'materials', quantity: 1, unit: 'ea', unit_price: 900, line_total: 900 },
        { description: 'Delivery', category: 'freight', quantity: null, unit: null, unit_price: null, line_total: 100 },
      ],
    };
  },
};

let server, base, repo, processor, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcosts-'));
  repo = openDb(dataDir);
  processor = createProcessor({ repo, analyzer: fakeAnalyzer, log: { error() {} } });
  const app = createApp({ config, repo, processor, fetchJobImpl: async () => ({ jobNumber: '1234', jobTitle: '12 Smith St' }) });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function openCard(jobUUID) {
  const token = jwt.sign({ eventName: 'job_costs_open', eventArgs: { jobUUID }, auth: { accountUUID: 'acc-1', accessToken: 'x' } }, SECRET);
  const res = await fetch(`${base}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token });
  assert.equal(res.status, 200);
  const html = await res.text();
  const boot = JSON.parse(html.match(/const BOOT = (\{.*?\});/)[1]);
  assert.ok(html.includes('platform.servicem8.com/sdk'));
  return boot.token;
}

const api = (token, p, opts = {}) => fetch(`${base}/api${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.json ? { 'Content-Type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });

test('allocateCosts spreads tax and keeps the exact total', () => {
  const costs = allocateCosts([{ line_total: 10 }, { line_total: 20 }, { line_total: 3.33 }], 36.67);
  assert.equal(Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100, 36.67);
  assert.deepEqual(allocateCosts([{ line_total: 5 }], null), [5]);
});

test('job email addresses round-trip to the job code', () => {
  assert.equal(inboxAddress('k3x9m2pq', config), 'abc123+k3x9m2pq@inbound.postmarkapp.com');
  assert.equal(inboxAddress('k3x9m2pq', { inboundDomain: 'in.example.com' }), 'job-k3x9m2pq@in.example.com');
  assert.deepEqual(codesFromAddresses(['abc123+k3x9m2pq@inbound.postmarkapp.com', 'job-zz7788aa@in.example.com', 'bob@x.com']), ['k3x9m2pq', 'zz7788aa']);
});

test('ServiceM8 callback rejects a bad signature', async () => {
  const bad = jwt.sign({ eventArgs: { jobUUID: 'j' } }, 'wrong-secret');
  const res = await fetch(`${base}/servicem8/addon`, { method: 'POST', body: bad });
  assert.equal(res.status, 401);
});

test('upload, read, mark paid, and totals', async () => {
  const token = await openCard('job-aaa');
  let job = await (await api(token, '/job')).json();
  assert.equal(job.job.job_number, '1234');
  assert.match(job.inboxAddress, /^abc123\+[a-z0-9]{8}@inbound\.postmarkapp\.com$/);

  const fd = new FormData();
  fd.append('files', new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), 'door-invoice.pdf');
  fd.append('files', new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), 'receipt.pdf');
  const up = await api(token, '/invoices', { method: 'POST', body: fd });
  assert.equal(up.status, 201);
  await processor.idle();

  job = await (await api(token, '/job')).json();
  assert.equal(job.totals.total, 3355);
  assert.equal(job.totals.paid, 55, 'receipt marked PAID is counted as paid');
  assert.equal(job.totals.outstanding, 3300);
  const inv = job.invoices.find((i) => i.supplier === 'Door Supplies Pty Ltd');
  assert.equal(inv.items.reduce((s, i) => s + i.cost, 0), 3300, 'line costs include GST');

  // Pay just the motor
  const motor = inv.items.find((i) => i.description === 'Motor');
  await api(token, `/items/${motor.id}`, { method: 'PATCH', json: { paid: true } });
  job = await (await api(token, '/job')).json();
  assert.equal(job.totals.paid, 55 + 990);
  assert.equal(job.invoices.find((i) => i.id === inv.id).payment_state, 'part');

  // Pay the whole invoice
  await api(token, `/invoices/${inv.id}`, { method: 'PATCH', json: { paid: true } });
  job = await (await api(token, '/job')).json();
  assert.equal(job.totals.outstanding, 0);
  assert.deepEqual(job.byCategory.map((c) => c.name).sort(), ['freight', 'materials']);

  // Fix an amount by hand: invoice total stays, costs re-spread
  await api(token, `/items/${motor.id}`, { method: 'PATCH', json: { line_total: '1000' } });
  job = await (await api(token, '/job')).json();
  assert.equal(job.totals.total, 3355);
});

test('another job cannot see this job\'s invoices', async () => {
  const tokenA = await openCard('job-aaa');
  const tokenB = await openCard('job-bbb');
  const jobA = await (await api(tokenA, '/job')).json();
  const id = jobA.invoices[0].id;
  assert.equal((await api(tokenB, `/invoices/${id}/file`)).status, 404);
  assert.equal((await api(tokenB, `/invoices/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/job`)).status, 401);
});

test('emailed invoices land on the right job; duplicates are not double counted', async () => {
  const token = await openCard('job-ccc');
  const { inboxAddress: addr } = await (await api(token, '/job')).json();
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const postmark = {
    From: 'accounts@doorsupplies.com.au', To: addr, ToFull: [{ Email: addr, MailboxHash: addr.split('+')[1].split('@')[0] }],
    Subject: 'Invoice INV-100', TextBody: 'Please see attached', HtmlBody: '',
    Attachments: [
      { Name: 'INV-100.pdf', ContentType: 'application/pdf', Content: pdf },
      { Name: 'logo.png', ContentType: 'image/png', Content: Buffer.alloc(500).toString('base64') },
    ],
  };
  assert.equal((await fetch(`${base}/inbound/email?key=wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(postmark) })).status, 403);
  const send = () => fetch(`${base}/inbound/email?key=mailkey`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(postmark) }).then((r) => r.json());
  const r1 = await send();
  assert.deepEqual(r1, { ok: true, matched: 1, created: 1 }, 'logo image is skipped when a PDF is attached');
  await send(); // supplier sends it twice
  await processor.idle();

  const job = await (await api(token, '/job')).json();
  assert.equal(job.invoices.length, 2);
  assert.equal(job.invoices.filter((i) => i.duplicate_of).length, 1);
  assert.equal(job.totals.total, 3300);
  assert.equal(job.invoices[0].email_from, 'accounts@doorsupplies.com.au');
  assert.equal(fakeAnalyzer.calls.at(-1).context.emailSubject, 'Invoice INV-100');

  const unknown = await fetch(`${base}/inbound/email?key=mailkey`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...postmark, To: 'abc123+nosuchjob@inbound.postmarkapp.com', ToFull: [], MailboxHash: 'nosuchjob' }) }).then((r) => r.json());
  assert.equal(unknown.matched, 0);
});

test('SendGrid-style multipart email and non-invoice files', async () => {
  const token = await openCard('job-ddd');
  const { inboxAddress: addr } = await (await api(token, '/job')).json();
  const fd = new FormData();
  fd.append('to', `Jobs <${addr}>`);
  fd.append('from', 'sub@installs.com.au');
  fd.append('subject', 'Install invoice');
  fd.append('attachment1', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'notinvoice.pdf');
  const r = await fetch(`${base}/inbound/email?key=mailkey`, { method: 'POST', body: fd }).then((x) => x.json());
  assert.equal(r.created, 1);
  await processor.idle();
  const job = await (await api(token, '/job')).json();
  assert.equal(job.invoices[0].status, 'error');
  assert.match(job.invoices[0].error, /does not look like an invoice/);
  assert.equal(job.totals.total, 0);
});
