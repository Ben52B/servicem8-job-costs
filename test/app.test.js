const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');

const { openDb, allocateCosts, invoiceCategory, addressKey } = require('../src/db');
const { createProcessor } = require('../src/processor');
const { createApp } = require('../src/app');
const { codesFromAddresses, inboxAddress } = require('../src/inbound');

const SECRET = 'sm8-app-secret';
const config = {
  stockJobClients: ['door image'], stockJobCategories: ['internal'],
  publicUrl: 'http://test', sessionSecret: 'session-secret', servicem8AppSecret: SECRET,
  inboundBaseAddress: 'abc123@inbound.postmarkapp.com', inboundDomain: '', inboundSecret: 'mailkey', devMode: false,
};

const DOOR = {
  is_financial_document: true, document_type: 'tax_invoice', supplier_name: 'Door Supplies Pty Ltd', supplier_abn: null,
  invoice_number: 'INV-100', invoice_date: '2026-10-01', due_date: '2026-10-31', currency: 'AUD',
  subtotal: 3000, tax: 300, total: 3300, payment_status: 'unpaid', notes: null, references: [], site_address: null,
  items: [
    { description: 'Sectional door', category: 'materials', quantity: 1, unit: 'ea', unit_price: 2000, line_total: 2000 },
    { description: 'Motor', category: 'materials', quantity: 1, unit: 'ea', unit_price: 900, line_total: 900 },
    { description: 'Delivery', category: 'freight', quantity: null, unit: null, unit_price: null, line_total: 100 },
  ],
};

// Fake reader: answers based on the file name so tests are deterministic.
const fakeAnalyzer = {
  async analyzeFile({ fileName }) {
    if (/notinvoice/.test(fileName)) throw new Error('This does not look like an invoice or receipt.');
    if (/receipt/.test(fileName)) {
      return { is_financial_document: true, document_type: 'receipt', supplier_name: 'Bunnings', invoice_number: 'R-1', total: 55, tax: 5, payment_status: 'paid',
        references: [], items: [{ description: 'Dynabolts', category: 'materials', line_total: 50 }] };
    }
    if (/motors/.test(fileName)) {
      return { is_financial_document: true, supplier_name: 'Merlin', invoice_number: 'M-1', total: 3410, tax: 310, payment_status: 'unpaid', references: ['Stock order'],
        items: [{ description: 'Merlin opener', category: 'materials', quantity: 10, unit: 'ea', line_total: 3000 }, { description: 'Delivery', category: 'freight', line_total: 100 }] };
    }
    if (/posts-ref/.test(fileName)) {
      return { ...DOOR, supplier_name: 'Moorabbin Steel', invoice_number: 'ORD-9', total: 198, references: ['Alpha GD 208102'],
        items: [{ description: 'Posts', category: 'materials', line_total: 180 }] };
    }
    if (/site-addr/.test(fileName)) {
      return { ...DOOR, supplier_name: 'AB Installs', invoice_number: 'AB-7', total: 715, site_address: '2A Evans St, Fairfield VIC 3078',
        items: [{ description: 'Install', category: 'subcontractor', line_total: 650 }] };
    }
    return DOOR;
  },
};

// ServiceM8 stand-ins: every job opened gets its own job number.
const JOBS = {
  'job-a': { jobNumber: '208101', jobTitle: '12 Smith St, Penrith' },
  'job-b': { jobNumber: '208102', jobTitle: '7 Bell St, Coburg' },
  'job-c': { jobNumber: '208103', jobTitle: '2A Evans St, Fairfield' },
  'stock-job': { jobNumber: '208150', jobTitle: 'Stock – motors', clientName: 'Door Image Pty Ltd', categoryName: 'Internal' },
  'internal-job': { jobNumber: '208151', jobTitle: 'Workshop', clientName: 'Someone', categoryName: 'Internal' },
  'normal-job': { jobNumber: '208152', jobTitle: '9 Oak St', clientName: 'Jane Citizen', categoryName: 'New Door Installation' },
};
let jobCounter = 300000;
const fetchJobImpl = async (uuid) => ({ ...(JOBS[uuid] || { jobNumber: String(jobCounter++), jobTitle: `${uuid} Rd` }), quoteAmount: 5000, status: 'Work Order' });
const fetchActiveJobsImpl = async () => [{ jobUUID: 'never-opened', jobNumber: '208999', jobTitle: '5 Pine Rd, Coburg', status: 'Work Order' }];

let server, base, repo, processor, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcosts-'));
  repo = openDb(dataDir);
  processor = createProcessor({ repo, analyzer: fakeAnalyzer, log: { error() {} } });
  const app = createApp({ config, repo, processor, fetchJobImpl, fetchActiveJobsImpl });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function openCard(jobUUID, accountUUID = 'acc-1') {
  const token = jwt.sign({ eventName: 'job_costs_open', eventArgs: { jobUUID }, auth: { accountUUID, accessToken: 'x' } }, SECRET);
  const res = await fetch(`${base}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token });
  assert.equal(res.status, 200);
  // ServiceM8 gets JSON with the window's HTML: the SDK, and our page in a frame
  const { eventResponse } = await res.json();
  assert.ok(eventResponse.includes('platform.servicem8.com/sdk'));
  const src = eventResponse.match(/<iframe src="([^"]+)"/)[1];
  assert.ok(src.startsWith('http://test/card?t='));
  const t = decodeURIComponent(src.split('t=')[1]);
  const page = await fetch(`${base}/card?t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  const boot = JSON.parse((await page.text()).match(/const BOOT = (\{.*?\});\n/)[1]);
  assert.equal(boot.token, t);
  return boot.token;
}

const api = (token, p, opts = {}) => fetch(`${base}/api${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.json ? { 'Content-Type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
const json = (token, p, opts) => api(token, p, opts).then((r) => r.json());
const summary = (token) => json(token, '/job');
const post = (token, p, body) => api(token, p, { method: 'POST', json: body || {} });
async function upload(token, ...names) {
  const fd = new FormData();
  for (const n of names) fd.append('files', new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), n);
  const r = await api(token, '/invoices', { method: 'POST', body: fd });
  await processor.idle();
  return (await r.json()).created;
}
async function email(token, { subject = 'Invoice', file = 'invoice.pdf', text = 'Please see attached' } = {}) {
  const { inboxAddress: addr } = await summary(token);
  const r = await fetch(`${base}/inbound/email?key=mailkey`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ From: 'accounts@supplier.com.au', To: addr, ToFull: [{ Email: addr }], Subject: subject, TextBody: text,
      Attachments: [{ Name: file, ContentType: 'application/pdf', Content: Buffer.from('%PDF-1.4').toString('base64') }] }),
  }).then((x) => x.json());
  await processor.idle();
  return r;
}
const latestInvoice = () => repo.db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 1').get();

// ---------------------------------------------------------------------------

test('helpers: costs add up, one type per invoice, address matching, email address format', () => {
  const costs = allocateCosts([{ line_total: 10 }, { line_total: 20 }, { line_total: 3.33 }], 36.67);
  assert.equal(Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100, 36.67);
  assert.equal(invoiceCategory([{ category: 'materials', line_total: 900 }, { category: 'freight', line_total: 120 }]), 'materials');
  assert.equal(invoiceCategory([{ category: 'freight', line_total: 80 }]), 'freight');
  assert.deepEqual(addressKey('2A Evans St, Fairfield'), { number: '2a', street: 'evans' });
  assert.equal(inboxAddress('k3x9m2pq', config), 'abc123+k3x9m2pq@inbound.postmarkapp.com');
  assert.equal(inboxAddress('k3x9m2pq', { inboundDomain: 'in.example.com' }), 'invoices-k3x9m2pq@in.example.com');
  assert.deepEqual(codesFromAddresses(['abc123+k3x9m2pq@inbound.postmarkapp.com', 'invoices-zz7788aa@in.example.com']), ['k3x9m2pq', 'zz7788aa']);
});

test('ServiceM8 callback rejects a bad signature; opening a card syncs active jobs', async () => {
  const bad = jwt.sign({ eventArgs: { jobUUID: 'j' } }, 'wrong-secret');
  const badRes = await (await fetch(`${base}/servicem8/addon`, { method: 'POST', body: bad })).json();
  assert.match(badRes.eventResponse, /Could not open Job Costs/, 'the reason shows in the ServiceM8 window');
  assert.equal((await fetch(`${base}/card?t=bad`)).status, 401);
  await openCard('job-a');
  assert.equal(repo.getJob('never-opened').job_number, '208999', 'job list fetched from ServiceM8');
});

test('upload on a job: read, put on that job, paid, type, take off, delete', async () => {
  const token = await openCard('job-a');
  const [id] = await upload(token, 'door.pdf');
  let s = await summary(token);
  const inv = s.invoices.find((i) => i.id === id);
  assert.equal(inv.job_total, 3300);
  assert.equal(inv.whole, true);
  assert.deepEqual(s.byCategory.map((c) => c.name), ['materials'], 'delivery counts with the goods');
  assert.equal(s.totals.quote, 5000);
  assert.equal(s.totals.margin, 1700);

  await api(token, `/invoices/${id}`, { method: 'PATCH', json: { paid: true } });
  s = await summary(token);
  assert.equal(s.totals.outstanding, 0);

  await api(token, `/invoices/${id}`, { method: 'PATCH', json: { category: 'subcontractor' } });
  s = await summary(token);
  assert.deepEqual(s.byCategory.map((c) => [c.name, c.total]), [['subcontractor', 3300]]);

  // Take it off the job: it's back in "not assigned yet" for the business
  await api(token, `/invoices/${id}`, { method: 'DELETE' });
  assert.ok(!(await summary(token)).invoices.some((i) => i.id === id));
  const un = await json(token, '/unassigned');
  assert.ok(un.invoices.some((i) => i.id === id && i.untouched));
  // Delete it completely
  assert.equal((await api(token, `/invoices/${id}?completely=1`, { method: 'DELETE' })).status, 200);
  assert.equal(repo.getInvoice(id), undefined);
});

test('one email address: invoices land in the inbox with a suggested job; one click adds it', async () => {
  const a = await openCard('job-a');
  const b = await openCard('job-b');
  const sA = await summary(a);
  assert.equal(sA.inboxAddress, (await summary(b)).inboxAddress, 'same address for every job of the business');

  // Job number in the subject
  const r = await email(a, { subject: 'RE: New door order Alpha GD 208101', file: 'door-email.pdf' });
  assert.deepEqual(r, { ok: true, matched: 1, created: 1 });
  const inv = latestInvoice();
  assert.equal(inv.origin_job_uuid, null);
  let s = await summary(a);
  assert.ok(!s.invoices.some((i) => i.id === inv.id), 'not on the job until approved');
  assert.equal(s.suggestions[0].id, inv.id);
  assert.match(s.suggestions[0].reason, /208101.*email subject/);
  assert.ok(s.inboxCount >= 1);
  assert.equal((await post(a, `/suggestions/${inv.id}/accept`)).status, 200);
  s = await summary(a);
  assert.ok(s.invoices.some((i) => i.id === inv.id && i.whole));
  assert.equal(s.suggestions.length, 0);

  // Job number in the invoice's own reference
  await email(a, { subject: 'Your invoice', file: 'posts-ref.pdf' });
  const posts = latestInvoice();
  assert.equal(posts.suggested_job_uuid, 'job-b');
  assert.match(posts.suggestion_reason, /invoice reference/);
  // "Not this job": stays in the inbox, not suggested for job-b again
  await post(b, `/suggestions/${posts.id}/dismiss`);
  assert.equal(repo.getInvoice(posts.id).suggested_job_uuid, null);
  const inbox = await json(b, '/inbox');
  assert.ok(inbox.invoices.some((i) => i.id === posts.id && i.untouched && !i.suggestion));
  // Assign from the inbox to any job
  assert.equal((await post(b, `/inbox/${posts.id}/assign`, { job_uuid: 'job-b' })).status, 200);
  assert.ok((await summary(b)).invoices.some((i) => i.id === posts.id));

  // Site address match (job-c is 2A Evans St)
  const c = await openCard('job-c');
  await email(c, { subject: 'Invoice', file: 'site-addr.pdf' });
  assert.equal(latestInvoice().suggested_job_uuid, 'job-c');
  assert.match(latestInvoice().suggestion_reason, /Site address/);

  // A job synced from ServiceM8 that was never opened in Job Costs can be suggested too
  await email(a, { subject: 'Order for job 208999', file: 'door-x.pdf' });
  assert.equal(latestInvoice().suggested_job_uuid, 'never-opened');

  // No job number anywhere: no suggestion; keep as stock removes it from "needs a job"
  await email(a, { subject: 'Statement', file: 'door-y.pdf' });
  const none = latestInvoice();
  assert.equal(none.suggested_job_uuid, null);
  const before = (await summary(a)).inboxCount;
  await post(a, `/inbox/${none.id}/stock`);
  assert.equal((await summary(a)).inboxCount, before - 1);

  // Unknown address / wrong key
  const unknown = await fetch(`${base}/inbound/email?key=mailkey`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ To: 'abc123+nosuchcode@inbound.postmarkapp.com', Attachments: [] }) }).then((x) => x.json());
  assert.equal(unknown.matched, 0);
  assert.equal((await fetch(`${base}/inbound/email?key=nope`, { method: 'POST' })).status, 403);
});

test('Add costs: 10 motors shared between jobs, with where each one went', async () => {
  const a = await openCard('job-a');
  const b = await openCard('job-b');
  const c = await openCard('job-c');
  await email(a, { subject: 'Stock order', file: 'motors.pdf' });
  const inv = latestInvoice();
  await post(a, `/inbox/${inv.id}/stock`);
  const un = await json(a, '/unassigned');
  const entry = un.invoices.find((i) => i.id === inv.id);
  const motor = entry.lines.find((l) => l.description === 'Merlin opener');
  const delivery = entry.lines.find((l) => l.description === 'Delivery');
  assert.equal(motor.unit_cost, 330);

  // Job A takes 1 motor (as materials, a screw-up) and the delivery; B takes 2; C takes 3
  assert.equal((await post(a, '/assign', { item_id: motor.item_id, quantity: 1, category: 'materials', mistake_reason: 'wrong_size' })).status, 200);
  assert.equal((await post(a, '/assign', { item_id: delivery.item_id, amount: 110 })).status, 200);
  assert.equal((await post(b, '/assign', { item_id: motor.item_id, quantity: 2 })).status, 200);
  assert.equal((await post(c, '/assign', { item_id: motor.item_id, quantity: 3 })).status, 200);
  const over = await post(b, '/assign', { item_id: motor.item_id, quantity: 5 });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /4 left/);

  // Trace: where the other motors went, seen from any job
  const sB = await summary(b);
  const line = sB.invoices.find((i) => i.id === inv.id).items[0];
  assert.equal(line.cost, 660);
  assert.equal(line.trace.left_quantity, 4);
  assert.deepEqual(line.trace.jobs.map((j) => [j.job_number, j.quantity, j.this_job]), [['208101', 1, false], ['208102', 2, true], ['208103', 3, false]]);
  assert.deepEqual(sB.invoices.find((i) => i.id === inv.id).other_lines.map((o) => o.description), ['Delivery']);

  // Screw-up and type belong to each job's share
  const sA = await summary(a);
  assert.equal(sA.invoices.find((i) => i.id === inv.id).job_total, 440);
  assert.equal(sA.totals.mistakes >= 330, true);
  assert.equal(sB.invoices.find((i) => i.id === inv.id).mistake_state, 'none');

  // Change a share directly, give back, and paid is one tick for the whole bill
  assert.equal((await api(b, `/items/${motor.item_id}/share`, { method: 'PUT', json: { quantity: 1 } })).status, 200);
  assert.equal((await json(c, '/unassigned')).invoices.find((i) => i.id === inv.id).lines[0].trace.left_quantity, 5);
  await api(a, `/invoices/${inv.id}`, { method: 'PATCH', json: { paid: true } });
  assert.equal((await summary(c)).invoices.find((i) => i.id === inv.id).payment_state, 'paid');
  const del = await api(a, `/invoices/${inv.id}?completely=1`, { method: 'DELETE' });
  assert.equal(del.status, 409, 'cannot delete while other jobs use it');

  // Whole invoice from "not assigned yet", with type and screw-up chosen when adding
  await email(a, { subject: 'misc', file: 'receipt.pdf' });
  const rec = latestInvoice();
  await post(a, '/assign', { invoice_id: rec.id, category: 'equipment_hire', mistake_reason: 'rework' });
  const s = await summary(a);
  const r = s.invoices.find((i) => i.id === rec.id);
  assert.equal(r.category, 'equipment_hire');
  assert.equal(r.mistake_state, 'all');
  assert.equal(r.payment_state, 'paid', 'receipt was already paid');
});

test('reports: per-job shares add up; screw-ups by reason; other businesses never show', async () => {
  const a = await openCard('job-a');
  // Another business with a screw-up
  const other = await openCard('other-biz-job', 'acc-2');
  await upload(other, 'receipt.pdf');
  const oInv = latestInvoice();
  await api(other, `/invoices/${oInv.id}`, { method: 'PATCH', json: { mistake_reason: 'other' } });
  assert.equal((await api(a, `/invoices/${oInv.id}/file`)).status, 404, 'cannot see another business\'s invoice');
  assert.equal((await post(a, '/assign', { invoice_id: oInv.id })).status, 404);

  const rep = await json(a, '/report');
  assert.ok(!rep.jobs.some((j) => j.job_uuid === 'other-biz-job'));
  const jobsTotal = rep.jobs.reduce((s, j) => s + j.total, 0);
  assert.equal(Math.round(jobsTotal * 100) / 100, rep.totals.total);
  assert.ok(rep.byReason.some((r) => r.reason === 'wrong_size'));
  assert.ok(rep.totals.notAssigned > 0, 'motors left on the shelf');
  assert.equal((await fetch(`${base}/report?t=${a}`)).status, 200);
  assert.equal((await fetch(`${base}/inbox?t=${a}`)).status, 200);
  assert.equal((await fetch(`${base}/inbox?t=bad`)).status, 401);
});

test('typed-in invoice goes on the job; attaching the file later keeps job, paid, type and screw-up', async () => {
  const t = await openCard('job-manual');
  const bad = await post(t, '/invoices/manual', { supplier: 'X', total: 100, items: [{ description: 'Gate', amount: 150 }] });
  assert.equal(bad.status, 400);
  const r = await post(t, '/invoices/manual', { supplier: 'Door Supplies', total: 990, category: 'subcontractor', mistake_reason: 'wrong_colour', paid: true,
    items: [{ description: 'Gate 3.6m', amount: 660 }] });
  const { id } = await r.json();
  let inv = (await summary(t)).invoices.find((i) => i.id === id);
  assert.deepEqual(inv.items.map((l) => [l.description, l.cost]), [['Gate 3.6m', 660], ['Other items (not listed)', 330]]);
  assert.equal(inv.source, 'manual');

  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'door.pdf');
  assert.equal((await api(t, `/invoices/${id}/file`, { method: 'POST', body: fd })).status, 200);
  await processor.idle();
  inv = (await summary(t)).invoices.find((i) => i.id === id);
  assert.equal(inv.supplier, 'Door Supplies Pty Ltd');
  assert.equal(inv.job_total, 3300, 'the whole real invoice is on the job');
  assert.equal(inv.items.length, 3);
  assert.equal(inv.payment_state, 'paid');
  assert.equal(inv.category, 'subcontractor');
  assert.equal(inv.mistake_state, 'all');

  // A file that can't be read keeps the typed details counted
  const r2 = await (await post(t, '/invoices/manual', { supplier: 'Gate Co', total: 500 })).json();
  const fd2 = new FormData();
  fd2.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'notinvoice.pdf');
  await api(t, `/invoices/${r2.id}/file`, { method: 'POST', body: fd2 });
  await processor.idle();
  const inv2 = (await summary(t)).invoices.find((i) => i.id === r2.id);
  assert.equal(inv2.status, 'ready');
  assert.match(inv2.error, /does not look like an invoice/);
  assert.equal(inv2.job_total, 500);
});

test('quoted price comes from ServiceM8 and can be overridden', async () => {
  const t = await openCard('job-quote');
  assert.equal((await summary(t)).totals.quote, 5000);
  await api(t, '/job', { method: 'PATCH', json: { quote_amount: '$6,000' } });
  await openCard('job-quote');
  assert.equal((await summary(t)).totals.quote, 6000, 'typed price wins');
  await api(t, '/job', { method: 'PATCH', json: { quote_amount: null } });
  await openCard('job-quote');
  assert.equal((await summary(t)).totals.quote, 5000);
});

test('upgrading a database from the first version keeps every invoice on its job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcosts-v1-'));
  const db = new DatabaseSync(path.join(dir, 'jobcosts.sqlite'));
  db.exec(`
    CREATE TABLE jobs (job_uuid TEXT PRIMARY KEY, account_uuid TEXT, inbox_code TEXT NOT NULL UNIQUE, job_number TEXT, job_title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), quote_amount REAL, quote_source TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, job_uuid TEXT NOT NULL REFERENCES jobs(job_uuid), source TEXT NOT NULL,
      file_name TEXT, file_path TEXT, mime_type TEXT, email_from TEXT, email_subject TEXT, status TEXT NOT NULL DEFAULT 'processing', error TEXT,
      document_type TEXT, supplier TEXT, supplier_abn TEXT, invoice_number TEXT, invoice_date TEXT, due_date TEXT, currency TEXT, subtotal REAL,
      tax REAL, total REAL, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), split INTEGER NOT NULL DEFAULT 0,
      attached_later INTEGER NOT NULL DEFAULT 0, category TEXT, category_manual INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', quantity REAL, unit TEXT, unit_price REAL,
      line_total REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, paid_at TEXT, mistake_reason TEXT, mistake_at TEXT);
    CREATE TABLE allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, job_uuid TEXT NOT NULL,
      fraction REAL NOT NULL, mistake_reason TEXT, mistake_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (item_id, job_uuid));
    INSERT INTO jobs (job_uuid, account_uuid, inbox_code, job_number) VALUES ('j1', 'acc', 'code1', '100'), ('j2', 'acc', 'code2', '200');
    INSERT INTO invoices (id, job_uuid, source, status, supplier, total, category) VALUES (1, 'j1', 'upload', 'ready', 'Gates R Us', 1100, 'materials');
    INSERT INTO items (invoice_id, description, line_total, cost, mistake_reason) VALUES (1, 'Gate', 1000, 1000, 'wrong_size'), (1, 'Delivery', 100, 100, NULL);
    INSERT INTO invoices (id, job_uuid, source, status, supplier, total, category, split) VALUES (2, 'j1', 'upload', 'ready', 'Merlin', 3300, 'materials', 1);
    INSERT INTO items (id, invoice_id, description, quantity, line_total, cost) VALUES (10, 2, 'Motor', 10, 3300, 3300);
    INSERT INTO allocations (item_id, job_uuid, fraction) VALUES (10, 'j1', 0.1), (10, 'j2', 0.2);`);
  db.close();

  const r = openDb(dir);
  const s1 = r.getJobSummary('j1');
  const s2 = r.getJobSummary('j2');
  assert.equal(r.getInvoice(1).account_uuid, 'acc');
  assert.equal(s1.invoices.find((i) => i.id === 1).job_total, 1100);
  assert.equal(s1.totals.mistakes, 1000, 'screw-up tag kept');
  assert.equal(s1.invoices.find((i) => i.id === 2).job_total, 330);
  assert.equal(s2.invoices.find((i) => i.id === 2).job_total, 660);
  assert.equal(r.getUnassigned('acc').invoices.find((i) => i.id === 2).lines[0].trace.left_quantity, 7);
  r.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stock order jobs: invoices with their job number go into stock, and other jobs take from it', async () => {
  const stock = await openCard('stock-job');
  const real = await openCard('normal-job');
  assert.equal(repo.getJob('stock-job').is_stock, true, 'client Door Image');
  await openCard('internal-job');
  assert.equal(repo.getJob('internal-job').is_stock, true, 'category Internal');
  assert.equal(repo.getJob('normal-job').is_stock, false);

  // The stock order's invoice is suggested for the stock order job; confirming puts it in stock
  await email(stock, { subject: 'Order 208150 – 10 motors', file: 'motors.pdf' });
  const inv = latestInvoice();
  let s = await summary(stock);
  assert.equal(s.stock, true);
  assert.equal(s.suggestions[0].id, inv.id);
  await post(stock, `/suggestions/${inv.id}/accept`);
  s = await summary(stock);
  assert.equal(s.invoices[0].id, inv.id);
  assert.equal(s.totals.bought, 3410);
  assert.equal(s.totals.left, 3410);
  assert.equal(repo.getInvoice(inv.id).stock_job_uuid, 'stock-job');

  // A real job takes 1 motor; the stock order shows it was used, and isn't a cost anywhere else
  const un = await json(real, '/unassigned');
  const entry = un.invoices.find((i) => i.id === inv.id);
  assert.equal(entry.stock_job.job_number, '208150');
  const motor = entry.lines.find((l) => l.quantity === 10);
  await post(real, '/assign', { item_id: motor.item_id, quantity: 1 });
  s = await summary(stock);
  assert.equal(s.totals.used, 330);
  assert.equal(s.totals.jobs, 1);
  assert.equal((await summary(real)).totals.total, 330);
  assert.equal((await post(stock, '/assign', { item_id: motor.item_id, quantity: 1 })).status, 400, 'a stock order job takes no costs');
  const rep = await json(real, '/report');
  assert.ok(!rep.jobs.some((j) => j.job_uuid === 'stock-job'), 'stock order jobs are not in profit reports');

  // The switch: turning a normal job with costs into a stock order job moves its invoices into stock
  const sw = await openCard('switch-job');
  await upload(sw, 'door.pdf');
  const door = latestInvoice();
  assert.equal((await summary(sw)).totals.total, 3300);
  await api(sw, '/job', { method: 'PATCH', json: { is_stock: true } });
  s = await summary(sw);
  assert.equal(s.stock, true);
  assert.equal(s.totals.left, 3300);
  assert.equal(repo.getInvoice(door.id).stock_job_uuid, 'switch-job');
  await api(sw, '/job', { method: 'PATCH', json: { is_stock: false } });
  assert.equal((await summary(sw)).stock, undefined);
});

test('wrong suggestion: change the job, or send it to stock', async () => {
  const a = await openCard('job-a');
  await email(a, { subject: 'Re: order 208101', file: 'door-wrong.pdf' });
  const inv = latestInvoice();
  const s = await summary(a);
  assert.ok(s.suggestions.some((x) => x.id === inv.id));
  assert.ok(s.jobs.some((j) => j.job_uuid === 'job-b') && !s.jobs.some((j) => j.job_uuid === 'job-a'), 'list of other jobs to change to');
  // Change job: it goes on job-b, not job-a
  assert.equal((await post(a, `/inbox/${inv.id}/assign`, { job_uuid: 'job-b' })).status, 200);
  const b = await openCard('job-b');
  assert.ok((await summary(b)).invoices.some((i) => i.id === inv.id));
  assert.ok(!(await summary(a)).suggestions.some((x) => x.id === inv.id));
  // Send to stock
  await email(a, { subject: 'Re: order 208101 again', file: 'door-stock.pdf' });
  const inv2 = latestInvoice();
  await post(a, `/inbox/${inv2.id}/stock`);
  assert.ok(!(await summary(a)).suggestions.some((x) => x.id === inv2.id));
  assert.ok((await json(a, '/inbox')).invoices.some((i) => i.id === inv2.id && i.kept_as_stock));
});

test('free email-in: the app reads a normal mailbox (own domain or Gmail) without changing it', async () => {
  const { parseRawEmail, checkMailbox } = require('../src/mailbox');
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const raw = (id, subject) => Buffer.from([
    'From: Gliderol Accounts <accounts@gliderol.com.au>',
    'To: invoices@doorimage.com.au',
    `Subject: ${subject}`,
    `Message-ID: <${id}@gliderol.com.au>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find attached our invoice.',
    '--b1',
    'Content-Type: application/pdf; name="INV-100.pdf"',
    'Content-Disposition: attachment; filename="INV-100.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf,
    '--b1--',
    '',
  ].join('\r\n'));

  const mail = await parseRawEmail(raw('m1', 'Invoice for job 208101'));
  assert.equal(mail.subject, 'Invoice for job 208101');
  assert.deepEqual(mail.recipients, ['invoices@doorimage.com.au']);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, 'INV-100.pdf');

  // A fake mailbox with two emails, one of them a copy of the other (same Message-ID)
  const messages = { 11: raw('m1', 'Invoice for job 208101'), 12: raw('m1', 'Invoice for job 208101'), 13: raw('m2', 'Statement') };
  const fakeClient = () => ({
    mailbox: { uidValidity: 7 },
    async connect() {}, async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return Object.keys(messages).map(Number); },
    async fetchOne(uid) { return { source: messages[uid] }; },
  });
  const seen = [];
  const handled = await checkMailbox(fakeClient(), { repo, onMail: async (m) => seen.push(m.subject), log: { error() {} } });
  assert.equal(handled, 2, 'the duplicate copy is skipped');
  assert.deepEqual(seen, ['Invoice for job 208101', 'Statement']);
  assert.equal(await checkMailbox(fakeClient(), { repo, onMail: async () => { throw new Error('should not run again'); } }), 0, 'already read emails are not read twice');

  // An email with no code in the address goes to the one business using the app
  const a = await openCard('job-a');
  const before = repo.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const app = server.listeners('request')[0];
  const r = app.locals.processMail(mail, { fallbackToOnlyAccount: false });
  assert.equal(r.matched, 0, 'without the mailbox fallback an address with no code matches nothing');
  const other = await openCard('other-biz-job', 'acc-2');
  assert.ok(other);
  // Two businesses use this test server, so there is no single business to fall back to
  assert.equal(app.locals.processMail(mail, { fallbackToOnlyAccount: true }).matched, 0);
  repo.db.prepare("DELETE FROM accounts WHERE account_key = 'acc-2'").run();
  const r2 = app.locals.processMail(mail, { fallbackToOnlyAccount: true });
  assert.equal(r2.matched, 1);
  await processor.idle();
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, before + 1);
  const inv = latestInvoice();
  assert.equal(inv.account_uuid, 'acc-1');
  assert.equal(inv.suggested_job_uuid, 'job-a', 'job number in the subject is still suggested');
  assert.ok(a);
});

test('the invoice address shown in the app', () => {
  assert.equal(inboxAddress('code1', { imapAddress: 'invoices@doorimage.com.au', imapPassword: 'x' }), 'invoices@doorimage.com.au');
  assert.equal(inboxAddress('code1', { inboundBaseAddress: 'abc@inbound.postmarkapp.com', imapAddress: 'invoices@doorimage.com.au', imapPassword: 'x' }), 'abc+code1@inbound.postmarkapp.com');
  assert.equal(inboxAddress('code1', {}), null);
});

test('installing the add-on: approval in ServiceM8 saves access, used when the button is clicked', async () => {
  const calls = { exchange: 0, refresh: 0, tokens: [] };
  const fakeOauth = {
    authorizeUrl: ({ appId, redirectUri, scope, state }) => `https://go.servicem8.com/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`,
    exchangeCode: async ({ code }) => { calls.exchange++; assert.equal(code, 'good-code'); return { accessToken: 'tok-1', refreshToken: 'ref-1', expiresIn: 60 }; },
    refreshAccessToken: async ({ refreshToken }) => { calls.refresh++; assert.equal(refreshToken, 'ref-1'); return { accessToken: 'tok-2', refreshToken: 'ref-2', expiresIn: 3600 }; },
    fetchAccount: async (token) => (token === 'tok-1' ? { accountUUID: 'acc-oauth', name: 'Door Image' } : null),
  };
  const cfg = { ...config, servicem8AppId: 'app-123', servicem8Scopes: 'read_jobs read_customers' };
  const app2 = createApp({ config: cfg, repo, processor, oauth: fakeOauth,
    fetchJobImpl: async (uuid, token) => { calls.tokens.push(token); return { jobNumber: '777001', jobTitle: '1 Test St' }; },
    fetchActiveJobsImpl: async (token) => { calls.tokens.push('sync:' + token); return []; } });
  const srv = await new Promise((r) => { const x = app2.listen(0, () => r(x)); });
  const b2 = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Activation sends you to ServiceM8 to approve
    const act = await fetch(`${b2}/servicem8/activate`, { redirect: 'manual' });
    assert.equal(act.status, 302);
    const loc = new URL(act.headers.get('location'));
    assert.equal(loc.searchParams.get('client_id'), 'app-123');
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://test/servicem8/oauth/callback');
    const state = loc.searchParams.get('state');

    assert.equal((await fetch(`${b2}/servicem8/oauth/callback?code=good-code&state=forged`)).status, 400);
    const cb = await fetch(`${b2}/servicem8/oauth/callback?code=good-code&state=${state}`);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Job Costs is connected/);
    assert.equal(repo.getTokens('acc-oauth').accessToken, 'tok-1');
    assert.ok(calls.tokens.includes('sync:tok-1'), 'job list fetched right away');

    // Button clicked without a token in the event: the saved one is used (refreshed when due)
    const ev = jwt.sign({ eventName: 'job_costs_open', eventArgs: { jobUUID: 'oauth-job' }, auth: { accountUUID: 'acc-oauth' } }, SECRET);
    const r = await fetch(`${b2}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev });
    assert.equal(r.status, 200);
    assert.equal(calls.refresh, 1, 'token close to expiry was refreshed');
    assert.ok(calls.tokens.includes('tok-2'));
    assert.equal(repo.getJob('oauth-job').job_number, '777001');

    // If ServiceM8 won't say which account it is, the approval waits for the first click
    fakeOauth.fetchAccount = async () => null;
    fakeOauth.exchangeCode = async () => ({ accessToken: 'tok-p', refreshToken: 'ref-p', expiresIn: 3600 });
    const act2 = new URL((await fetch(`${b2}/servicem8/activate`, { redirect: 'manual' })).headers.get('location'));
    const cb2 = await fetch(`${b2}/servicem8/oauth/callback?code=x&state=${act2.searchParams.get('state')}`);
    assert.equal(cb2.status, 200);
    assert.match(await cb2.text(), /Job Costs is connected/);
    assert.equal(repo.getTokens('acc-new'), null);
    const ev2 = jwt.sign({ eventName: 'job_costs_open', eventArgs: { jobUUID: 'new-acc-job' }, auth: { accountUUID: 'acc-new' } }, SECRET);
    assert.equal((await fetch(`${b2}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev2 })).status, 200);
    assert.equal(repo.getTokens('acc-new').accessToken, 'tok-p', 'first click claims the waiting approval');
    assert.ok(calls.tokens.includes('tok-p'));
    assert.ok(calls.tokens.includes('sync:tok-p'), 'job list fetched on that first click');
    assert.equal(repo.getTokens('__pending__'), null);
  } finally {
    srv.close();
  }
});

test('the card, report and inbox page scripts have no syntax errors', () => {
  for (const file of ['card.html', 'report.html', 'inbox.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const js = html.split('<script>')[1].split('</script>')[0].replace('/*__BOOT__*/null', '{}');
    assert.doesNotThrow(() => new Function(js), file);
  }
});
