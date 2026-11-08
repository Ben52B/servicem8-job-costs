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
    if (/Tax_Invoice_S/.test(fileName)) {
      const ref = fileName.match(/ref(\d+(?:-\d)?)/)[1];
      return { ...DOOR, supplier_name: 'Gliderol International Pty Ltd', invoice_number: fileName.match(/S\d+/)[0], references: [ref], subtotal: 1226, total: 1348.6, tax: 122.6,
        items: [{ description: 'AA roller door 2100x4840', category: 'materials', line_total: 1226 }] };
    }
    if (/quote/.test(fileName)) return { ...DOOR, document_type: 'quote', invoice_number: 'Q-1' };
    if (/statement/i.test(fileName)) return { ...DOOR, document_type: 'statement', supplier_name: 'Gliderol International Pty Ltd', invoice_number: null };
    if (/remittance/.test(fileName)) return { ...DOOR, document_type: 'remittance', invoice_number: 'R-9' };
    if (/receipt/.test(fileName)) {
      return { is_financial_document: true, document_type: 'receipt', supplier_name: 'Bunnings', invoice_number: 'R-1', total: 55, tax: 5, payment_status: 'paid',
        references: [], items: [{ description: 'Dynabolts', category: 'materials', line_total: 50 }] };
    }
    if (/motors/.test(fileName)) {
      return { is_financial_document: true, supplier_name: 'Merlin', invoice_number: 'M-1', total: 3410, tax: 310, payment_status: 'unpaid', references: ['Stock order'], purchase_kind: 'stock',
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
  'job-207974': { jobNumber: '207974', jobTitle: '4 Gate Rd, Brighton', quoteAmount: 18450 },
  'job-207974A': { jobNumber: '207974A', jobTitle: '4 Gate Rd, Brighton', quoteAmount: 9225 },
  'job-207974B': { jobNumber: '207974 B', jobTitle: '4 Gate Rd, Brighton', quoteAmount: 0 },
  'job-555B': { jobNumber: '555B', jobTitle: 'Orphan part' },
  'ol-job-b': { jobNumber: '208777', jobTitle: '3 Lake Rd, Kew' },
  'done-job': { jobNumber: '207835', jobTitle: '2/92 Chute St, Mordialloc' },
  'other-job': { jobNumber: '206594', jobTitle: '6 Debbie Court' },
};
let jobCounter = 300000;
const fetchJobImpl = async (uuid) => ({ quoteAmount: 5000, ...(JOBS[uuid] || { jobNumber: String(jobCounter++), jobTitle: `${uuid} Rd` }), status: 'Work Order' });
const findJobByNumberImpl = async (num) => Object.keys(JOBS).find((u) => JOBS[u].jobNumber === num) || null;
const fetchActiveJobsImpl = async () => [{ jobUUID: 'never-opened', jobNumber: '208999', jobTitle: '5 Pine Rd, Coburg', status: 'Work Order' }];

// A pretend ServiceM8 job diary.
const diary = { files: [], notes: [], calls: [] };
let diaryN = 0;
const fakeDiary = {
  async listJobFiles(jobUUIDs) { diary.calls.push('list'); return diary.files.filter((f) => jobUUIDs.includes(f.job_uuid)); },
  async downloadJobFile(uuid) { diary.calls.push('download:' + uuid); return { buffer: Buffer.from('%PDF-1.4 diary'), contentType: 'application/pdf' }; },
  async addJobFile({ jobUUID, name }) { const uuid = 'att-' + ++diaryN; diary.files.push({ uuid, job_uuid: jobUUID, name, file_type: '.pdf', active: true }); return uuid; },
  async addJobNote({ jobUUID, text }) { const uuid = 'note-' + ++diaryN; diary.notes.push({ uuid, job_uuid: jobUUID, text }); return uuid; },
  async removeJobFile(uuid) { diary.calls.push('rmfile:' + uuid); diary.files = diary.files.filter((f) => f.uuid !== uuid); },
  async removeJobNote(uuid) { diary.calls.push('rmnote:' + uuid); diary.notes = diary.notes.filter((n) => n.uuid !== uuid); },
};

let server, base, repo, processor, dataDir, app;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcosts-'));
  repo = openDb(dataDir);
  processor = createProcessor({ repo, analyzer: fakeAnalyzer, log: { error() {} } });
  app = createApp({ config, repo, processor, fetchJobImpl, fetchActiveJobsImpl, findJobByNumberImpl, diaryApi: fakeDiary });
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
  assert.ok(src.startsWith('http://test/summary?t='), 'opens on the compact summary');
  const t = decodeURIComponent(src.split('t=')[1]);
  assert.equal((await fetch(`${base}/summary?t=${encodeURIComponent(t)}`)).status, 200);
  const page = await fetch(`${base}/card?t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  const boot = JSON.parse((await page.text()).match(/const BOOT = (\{.*?\});\n/)[1]);
  // Same job (the two tokens can differ if they were made a second apart)
  assert.equal(jwt.decode(boot.token).jobUUID, jwt.decode(t).jobUUID);
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
  assert.equal(inv.job_total, 3000, 'ex GST: $3,300 invoice with $300 GST');
  assert.equal(inv.whole, true);
  assert.deepEqual(s.byCategory.map((c) => c.name), ['materials'], 'delivery counts with the goods');
  assert.equal(s.totals.quote, 5000);
  assert.equal(s.totals.margin, 2000);

  await api(token, `/invoices/${id}`, { method: 'PATCH', json: { paid: true } });
  s = await summary(token);
  assert.equal(s.totals.outstanding, 0);

  await api(token, `/invoices/${id}`, { method: 'PATCH', json: { category: 'subcontractor' } });
  s = await summary(token);
  assert.deepEqual(s.byCategory.map((c) => [c.name, c.total]), [['subcontractor', 3000]]);

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
  assert.deepEqual([r.ok, r.matched, r.created], [true, 1, 1]);
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
  assert.equal(motor.unit_cost, 300, 'ex GST');

  // Job A takes 1 motor (as materials, a screw-up) and the delivery; B takes 2; C takes 3
  assert.equal((await post(a, '/assign', { item_id: motor.item_id, quantity: 1, category: 'materials', mistake_reason: 'wrong_size' })).status, 200);
  assert.equal((await post(a, '/assign', { item_id: delivery.item_id, amount: 100 })).status, 200);
  assert.equal((await post(b, '/assign', { item_id: motor.item_id, quantity: 2 })).status, 200);
  assert.equal((await post(c, '/assign', { item_id: motor.item_id, quantity: 3 })).status, 200);
  const over = await post(b, '/assign', { item_id: motor.item_id, quantity: 5 });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /4 left/);

  // Trace: where the other motors went, seen from any job
  const sB = await summary(b);
  const line = sB.invoices.find((i) => i.id === inv.id).items[0];
  assert.equal(line.cost, 600);
  assert.equal(line.trace.left_quantity, 4);
  assert.deepEqual(line.trace.jobs.map((j) => [j.job_number, j.quantity, j.this_job]), [['208101', 1, false], ['208102', 2, true], ['208103', 3, false]]);
  assert.deepEqual(sB.invoices.find((i) => i.id === inv.id).other_lines.map((o) => o.description), ['Delivery']);

  // Screw-up and type belong to each job's share
  const sA = await summary(a);
  assert.equal(sA.invoices.find((i) => i.id === inv.id).job_total, 400);
  assert.equal(sA.totals.mistakes >= 300, true);
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
  assert.deepEqual(inv.items.map((l) => [l.description, l.cost]), [['Gate 3.6m', 600], ['Other items (not listed)', 300]], 'ex GST');
  assert.equal(inv.source, 'manual');

  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'door.pdf');
  assert.equal((await api(t, `/invoices/${id}/file`, { method: 'POST', body: fd })).status, 200);
  await processor.idle();
  inv = (await summary(t)).invoices.find((i) => i.id === id);
  assert.equal(inv.supplier, 'Door Supplies Pty Ltd');
  assert.equal(inv.job_total, 3000, 'the whole real invoice is on the job');
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
  assert.equal(inv2.job_total, 454.55, 'typed $500 incl. GST');
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
  assert.equal(s.totals.bought, 3100);
  assert.equal(s.totals.left, 3100);
  assert.equal(repo.getInvoice(inv.id).stock_job_uuid, 'stock-job');

  // A real job takes 1 motor; the stock order shows it was used, and isn't a cost anywhere else
  const un = await json(real, '/unassigned');
  const entry = un.invoices.find((i) => i.id === inv.id);
  assert.equal(entry.stock_job.job_number, '208150');
  const motor = entry.lines.find((l) => l.quantity === 10);
  await post(real, '/assign', { item_id: motor.item_id, quantity: 1 });
  s = await summary(stock);
  assert.equal(s.totals.used, 300);
  assert.equal(s.totals.jobs, 1);
  assert.equal((await summary(real)).totals.total, 300);
  assert.equal((await post(stock, '/assign', { item_id: motor.item_id, quantity: 1 })).status, 400, 'a stock order job takes no costs');
  const rep = await json(real, '/report');
  assert.ok(!rep.jobs.some((j) => j.job_uuid === 'stock-job'), 'stock order jobs are not in profit reports');

  // The switch: turning a normal job with costs into a stock order job moves its invoices into stock
  const sw = await openCard('switch-job');
  await upload(sw, 'door.pdf');
  const door = latestInvoice();
  assert.equal((await summary(sw)).totals.total, 3000);
  await api(sw, '/job', { method: 'PATCH', json: { is_stock: true } });
  s = await summary(sw);
  assert.equal(s.stock, true);
  assert.equal(s.totals.left, 3000);
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
    // ServiceM8 rejects a permission: a smaller set is asked for instead
    const retry = await fetch(`${b2}/servicem8/oauth/callback?error=invalid_scope&error_description=${encodeURIComponent('An unsupported scope was requested')}&state=${state}`, { redirect: 'manual' });
    assert.equal(retry.status, 302);
    const loc2 = new URL(retry.headers.get('location'));
    assert.notEqual(loc2.searchParams.get('scope'), loc.searchParams.get('scope'));
    assert.match(loc2.searchParams.get('scope'), /^read_jobs read_customers read_job_materials/);
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

    // Re-installing (e.g. to add a permission): the new approval replaces the old one,
    // and it's used even when the click brings its own pass
    fakeOauth.exchangeCode = async () => ({ accessToken: 'tok-new', refreshToken: 'ref-new', expiresIn: 3600 });
    const act3 = new URL((await fetch(`${b2}/servicem8/activate`, { redirect: 'manual' })).headers.get('location'));
    await fetch(`${b2}/servicem8/oauth/callback?code=x&state=${act3.searchParams.get('state')}`);
    const ev3 = jwt.sign({ eventName: 'job_costs_open', eventArgs: { jobUUID: 'new-acc-job' }, auth: { accountUUID: 'acc-new', accessToken: 'click-pass' } }, SECRET);
    calls.tokens.length = 0;
    await fetch(`${b2}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev3 });
    assert.equal(repo.getTokens('acc-new').accessToken, 'tok-new');
    assert.equal(calls.tokens[0], 'tok-new', 'saved approval used first');
  } finally {
    srv.close();
  }
});

test('split jobs (#207974, #207974A…) are one job; the price is the full job without "Partial invoice" lines', async () => {
  const { fullPriceFromLines } = require('../src/servicem8');
  const { mainJobNumber } = require('../src/db');
  // The lines from job #207974 in ServiceM8
  assert.equal(fullPriceFromLines([
    { name: 'Supply and install new pedestrian gate', quantity: '1', price: '2650' }, { name: 'Sliding Gate', quantity: '1', price: '14250' },
    { name: 'Electrical work', quantity: '1', price: '0' }, { name: 'Electric strike', quantity: '1', price: '1850' },
    { name: 'Discount', quantity: '-1', price: '300' }, { name: 'Partial invoice #207974A', quantity: '-1', price: '9225' },
    { name: 'Partial invoice #207974B', quantity: '-1', price: '0' }, { name: 'Old line', quantity: '1', price: '999', active: '0' },
  ]), 18450);
  assert.equal(mainJobNumber('207974A'), '207974');
  assert.equal(mainJobNumber('207974'), null);

  // Clicking Job Costs on #207974A opens #207974 (main job is found in ServiceM8 first time)
  const t = await openCard('job-207974A');
  const s = await summary(t);
  assert.equal(s.job.job_uuid, 'job-207974');
  assert.equal(s.totals.quote, 18450, 'the full job price, not the split part');
  assert.deepEqual(s.splitParts, ['207974A']);
  assert.ok(!s.jobs.some((j) => j.job_number === '207974A'), 'split parts are not offered as separate jobs');

  // Costs that were put on a split part itself (before parts were linked) move to the main job
  const rec = repo.createInvoice({ accountUUID: 'acc-1', source: 'upload' });
  repo.saveExtraction(rec.id, { supplier_name: 'Old Part Supplier', total: 110, tax: 10, items: [{ description: 'Thing', category: 'materials', line_total: 100 }] });
  repo.ensureJob({ jobUUID: 'job-207974B', accountUUID: 'acc-1', jobNumber: '207974 B' });
  repo.assignWhole(rec.id, 'job-207974B');
  const tb = await openCard('job-207974B');
  const sb = await summary(tb);
  assert.equal(sb.job.job_uuid, 'job-207974', '"207974 B" (with a space) is recognised as part B');
  assert.ok(sb.invoices.some((i) => i.id === rec.id), 'part B\'s costs moved to the main job');
  assert.equal(repo.getJobSummary('job-207974B').invoices.length, 0);

  // A part whose main job can't be found opens on its own, with a note saying so
  const to = await openCard('job-555B');
  const so = await summary(to);
  assert.equal(so.job.job_uuid, 'job-555B');
  assert.match(so.sm8Note, /part of job #555/);

  // An invoice mentioning the split part is suggested for the main job
  await email(t, { subject: 'Gate motor for job 207974A', file: 'door-207974.pdf' });
  assert.equal(latestInvoice().suggested_job_uuid, 'job-207974');
});

test('ServiceM8 job diary: whole invoices are copied with a note, shared ones aren\u2019t; pull from the diary; ask on removal', async () => {
  const tA = await openCard('diary-a', 'acc-diary');
  const tB = await openCard('diary-b', 'acc-diary');

  // An upload that's all on job A: copied to A's diary, with a note
  const [up] = await upload(tA, 'invoice.pdf');
  await app.locals.syncDiary();
  let inv = repo.getInvoice(up);
  assert.equal(inv.sm8_link, 'pushed');
  assert.equal(inv.sm8_job_uuid, 'diary-a');
  assert.ok(diary.files.some((f) => f.uuid === inv.sm8_attachment_uuid && f.job_uuid === 'diary-a'));
  const note = diary.notes.find((n) => n.uuid === inv.sm8_note_uuid);
  assert.match(note.text, /Door Supplies Pty Ltd invoice #INV-100 added – \$3,000\.00 ex GST/);
  assert.equal((await summary(tA)).invoices.find((i) => i.id === up).in_diary, true);
  // Nothing more happens on the next run (no copies twice)
  const before = diary.files.length + diary.notes.length;
  await app.locals.syncDiary();
  assert.equal(diary.files.length + diary.notes.length, before);

  // A shared invoice (10 motors over two jobs) stays in Job Costs only
  const r = await email(tA, { file: 'motors.pdf', subject: 'Stock order' });
  const motors = repo.getInvoice(r.created?.[0] ?? latestInvoice().id);
  const motor = repo.db.prepare("SELECT id FROM items WHERE invoice_id = ? AND description = 'Merlin opener'").get(motors.id);
  assert.equal((await post(tA, '/assign', { item_id: motor.id, quantity: 1 })).status, 200);
  assert.equal((await post(tB, '/assign', { item_id: motor.id, quantity: 2 })).status, 200);
  await app.locals.syncDiary();
  assert.equal(repo.getInvoice(motors.id).sm8_attachment_uuid, null);
  assert.equal(repo.getInvoice(motors.id).sm8_note_uuid, null);

  // A typed-in invoice gets a note only; its file goes up when it's attached later
  const man = await post(tB, '/invoices/manual', { supplier: 'Bunnings', total: 110 }).then((x) => x.json());
  await app.locals.syncDiary();
  inv = repo.getInvoice(man.id);
  assert.ok(inv.sm8_note_uuid);
  assert.equal(inv.sm8_attachment_uuid, null);
  assert.match(diary.notes.find((n) => n.uuid === inv.sm8_note_uuid).text, /typed in, no file/);
  const fd = new FormData();
  fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'receipt.pdf');
  await api(tB, `/invoices/${man.id}/file`, { method: 'POST', body: fd });
  await processor.idle();
  await app.locals.syncDiary();
  const inv2 = repo.getInvoice(man.id);
  assert.ok(inv2.sm8_attachment_uuid);
  assert.equal(inv2.sm8_note_uuid, inv.sm8_note_uuid, 'no second note');

  // Pull a file from the job diary (one someone attached in ServiceM8)
  diary.files.push({ uuid: 'att-photo', job_uuid: 'diary-a', name: 'Supplier invoice.pdf', file_type: '.pdf', active: true });
  diary.files.push({ uuid: 'att-doc', job_uuid: 'diary-a', name: 'Notes.docx', file_type: '.docx', active: true });
  const num = repo.getJob('diary-a').job_number;
  diary.files.push({ uuid: 'att-own', job_uuid: 'diary-a', name: `Partial Invoice #${num}B`, file_type: '.pdf', active: true });
  diary.files.push({ uuid: 'att-q', job_uuid: 'diary-a', name: 'Kopper Electrical Quote 4453.pdf', file_type: '.pdf', active: true });
  diary.files.push({ uuid: 'att-cam', job_uuid: 'diary-a', name: '20261011_231611.jpg', file_type: '.jpg', active: true });
  let list = (await json(tA, '/diary')).files;
  assert.ok(!list.some((f) => f.uuid === 'att-doc'), 'only PDFs and photos');
  assert.equal(list.find((f) => f.uuid === 'att-own').kind, 'own', 'your own ServiceM8 invoice is hidden');
  assert.equal(list.find((f) => f.uuid === 'att-q').kind, 'quote');
  assert.equal(list.find((f) => f.uuid === 'att-photo').kind, 'file');
  assert.equal(list.find((f) => f.uuid === 'att-cam').is_photo, true);
  const prev = await api(tA, '/diary/att-cam/file');
  assert.equal(prev.status, 200);
  assert.match(prev.headers.get('content-type'), /image\/jpeg/);
  assert.equal(list.find((f) => f.uuid === 'att-photo').invoice_id, null);
  assert.ok(list.find((f) => f.uuid === repo.getInvoice(up).sm8_attachment_uuid).invoice_id, 'one copied there shows as added');
  const imp = await post(tA, '/diary/att-photo/import').then((x) => x.json());
  await processor.idle();
  assert.ok(imp.id);
  assert.equal(repo.getInvoice(imp.id).sm8_link, 'pulled');
  assert.ok((await summary(tA)).invoices.some((i) => i.id === imp.id), 'it goes on the job');
  assert.equal((await post(tA, '/diary/att-photo/import').then((x) => x.json())).already, true);
  const notes = diary.notes.length;
  await app.locals.syncDiary();
  assert.equal(diary.notes.length, notes, 'a file from the diary is not copied back');
  list = (await json(tA, '/diary')).files;
  assert.equal(list.find((f) => f.uuid === 'att-photo').invoice_id, imp.id);

  // Deleted in the diary: noticed when the card opens, and you're asked
  diary.files = diary.files.filter((f) => f.uuid !== 'att-photo');
  await openCard('diary-a', 'acc-diary');
  let s = await summary(tA);
  assert.equal(s.invoices.find((i) => i.id === imp.id).diary_missing, true);
  assert.equal((await post(tA, `/invoices/${imp.id}/diary-keep`)).status, 200);
  s = await summary(tA);
  assert.equal(s.invoices.find((i) => i.id === imp.id).diary_missing, false);
  assert.equal(s.invoices.find((i) => i.id === imp.id).in_diary, false);

  // Removing in Job Costs can also remove it from the diary
  const fileUUID = repo.getInvoice(up).sm8_attachment_uuid;
  const noteUUID = repo.getInvoice(up).sm8_note_uuid;
  const del = await api(tA, `/invoices/${up}?completely=1&diary=1`, { method: 'DELETE' }).then((x) => x.json());
  assert.equal(del.deleted, true);
  assert.equal(del.diaryWarning, null);
  assert.ok(diary.calls.includes('rmfile:' + fileUUID) && diary.calls.includes('rmnote:' + noteUUID));
  // ...or leave it there
  const kept = repo.getInvoice(man.id).sm8_attachment_uuid;
  await api(tB, `/invoices/${man.id}?completely=1`, { method: 'DELETE' });
  assert.ok(diary.files.some((f) => f.uuid === kept));
});

test('Outlook: connect once, invoices from the inbox wait in the Inbox with a suggested job or stock; other emails are ignored', async () => {
  const pdf = (name) => ({ name, contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 ' + name), inline: false });
  const inbox = [
    { id: 'm1', internetMessageId: '<m1@x>', subject: 'Tax invoice for 208777', from: { emailAddress: { name: 'Door Supplies', address: 'acc@door.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: 'Please find attached' }, files: [pdf('invoice.pdf')] },
    { id: 'm2', internetMessageId: '<m2@x>', subject: 'Team BBQ Friday', from: { emailAddress: { address: 'boss@x.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: false, body: { content: 'Bring a salad. '.repeat(10) }, files: [] },
    { id: 'm3', internetMessageId: '<m3@x>', subject: 'Brochure', from: { emailAddress: { address: 'news@x.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: 'New range' }, files: [pdf('notinvoice.pdf')] },
    { id: 'm4', internetMessageId: '<m4@x>', subject: 'Your order', from: { emailAddress: { address: 'sales@merlin.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('motors.pdf')] },
    { id: 'm5', internetMessageId: '<m5@x>', subject: 'Quote 55', from: { emailAddress: { address: 'sales@x.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('quote.pdf')] },
  ];
  const calls = { list: 0 };
  const fakeGraph = {
    authorizeUrl: ({ clientId, redirectUri, state }) => `https://login.microsoftonline.com/t/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    exchangeCode: async (appCfg, { code }) => { assert.equal(code, 'ms-code'); assert.equal(appCfg.clientSecret, 'ms-secret'); return { accessToken: 'ms-at', refreshToken: 'ms-rt', expiresAt: new Date(Date.now() + 3600e3).toISOString() }; },
    refreshTokens: async () => ({ accessToken: 'ms-at2', refreshToken: 'ms-rt2', expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    fetchMe: async () => ({ email: 'accounts@doorimage.com.au', name: 'Accounts' }),
    listMessages: async (token) => { assert.ok(token.startsWith('ms-at')); calls.list++; return inbox; },
    skippedFolderIds: async () => ['f-sent', 'f-deleted'],
    listAttachments: async (token, id) => [...inbox, ...folderMail, ...taMail].find((m) => m.id === id).files,
    listFolders: async () => [{ id: 'f-inbox', path: 'Inbox' }, { id: 'f-gl', path: 'Inbox / Need to pay / Gliderol', count: 2 }],
    listFolderMessages: async (token, folderId, from, to) => { calls.folder = { folderId, from, to }; return folderId === 'f-gl' ? folderMail : folderId === 'f-ta' ? taMail : []; },
    childFolders: async (token, parent) => (parent === 'f-pay' ? [{ id: 'f-gl', name: 'Gliderol', childCount: 0, count: 2 }, { id: 'f-ta', name: 'Taurean', childCount: 0, count: 1 }]
      : parent ? [] : [{ id: 'f-inbox', name: 'Inbox', childCount: 0, count: 5 }, { id: 'f-pay', name: 'Need to pay', childCount: 2, count: 0 }]),
    folderPage: async (token, folderId) => ({ messages: (folderId === 'f-gl' ? folderMail : folderId === 'f-ta' ? taMail : []).map((m) => ({ id: m.id, internetMessageId: m.internetMessageId, subject: m.subject, from: '', received: m.receivedDateTime, hasAttachments: m.hasAttachments })), next: null }),
    getMessage: async (token, id) => [...folderMail, ...taMail].find((m) => m.id === id),
  };
  const taMail = [
    { id: 't1', internetMessageId: '<t1@x>', subject: 'Invoice 115003777', from: { emailAddress: { address: 'ar@taurean.com.au' } }, receivedDateTime: '2026-10-08T01:00:00Z', hasAttachments: true, body: { content: '' }, files: [pdf('Tax_Invoice_S690001_ref208777.pdf')] },
  ];
  const folderMail = [
    { id: 'g1', internetMessageId: '<g1@x>', subject: 'Tax Invoice S680001', from: { emailAddress: { address: 'ar@gliderol.com.au' } }, receivedDateTime: '2026-10-03T01:00:00Z', hasAttachments: true, body: { content: '' }, files: [pdf('Tax_Invoice_S680001_ref208777.pdf')] },
    { id: 'g2', internetMessageId: '<g2@x>', subject: 'Thanks for your order', from: { emailAddress: { address: 'ar@gliderol.com.au' } }, receivedDateTime: '2026-10-05T01:00:00Z', hasAttachments: false, body: { content: 'See you soon' }, files: [] },
  ];
  const cfg = { ...config, msClientId: 'ms-client', msClientSecret: 'ms-secret', msTenantId: 'tenant-1' };
  const app3 = createApp({ config: cfg, repo, processor, fetchJobImpl, fetchActiveJobsImpl, findJobByNumberImpl, diaryApi: fakeDiary, outlookApi: fakeGraph });
  const srv = await new Promise((r) => { const x = app3.listen(0, () => r(x)); });
  const b3 = `http://127.0.0.1:${srv.address().port}`;
  try {
    await openCard('ol-job', 'acc-ol');
    const t = await openCard('ol-job-b', 'acc-ol'); // job #208777
    // Not connected yet: the card offers the button
    let st = await fetch(`${b3}/api/outlook`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.deepEqual([st.available, st.connected], [true, false]);
    // Connect: Microsoft sign-in, then back
    const go = await fetch(`${b3}/outlook/connect?t=${encodeURIComponent(t)}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    const loc = new URL(go.headers.get('location'));
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://test/outlook/callback');
    assert.equal((await fetch(`${b3}/outlook/callback?code=ms-code&state=forged`)).status, 400);
    const cb = await fetch(`${b3}/outlook/callback?code=ms-code&state=${loc.searchParams.get('state')}`);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Outlook is connected/);
    await app3.locals.checkOutlook();
    await processor.idle();

    const mine = () => repo.db.prepare("SELECT * FROM invoices WHERE account_uuid = 'acc-ol' AND source = 'outlook'").all();
    const kept = mine();
    assert.deepEqual(kept.map((i) => i.file_name).sort(), ['invoice.pdf', 'motors.pdf'], 'BBQ email, brochure and quote are not kept');
    const unassigned = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    const door = unassigned.invoices.find((i) => i.supplier === 'Door Supplies Pty Ltd');
    assert.equal(door.suggestion.job_number, '208777', 'job number in the subject');
    assert.equal(door.looks_like_stock, false);
    const merlin = unassigned.invoices.find((i) => i.supplier === 'Merlin');
    assert.equal(merlin.suggestion, null);
    assert.equal(merlin.looks_like_stock, true, 'no job, reads like a restock order');
    // Nothing goes on a job until approved
    assert.equal((await summary(t)).invoices.length, 0);
    assert.equal((await post(t, `/suggestions/${door.id}/accept`)).status, 200);
    assert.equal((await summary(t)).invoices.length, 1);

    // The same bill again (number written differently): flagged, with the job the first one is on
    inbox.push({ id: 'm6', internetMessageId: '<m6@x>', subject: 'Copy of invoice 208777', from: { emailAddress: { address: 'acc@door.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('invoice.pdf')] });
    let r6 = await fetch(`${b3}/api/outlook/check`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.equal(r6.found, 1, 'Check now works');
    await processor.idle();
    let ib = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    const copy = ib.invoices.find((i) => i.supplier === 'Door Supplies Pty Ltd');
    assert.equal(copy.possible_duplicate.reason, 'same supplier and invoice number');
    assert.deepEqual(copy.possible_duplicate.jobs.map((j) => j.job_number), ['208777']);
    // Approved by mistake: it's listed under "Recently approved" and can be undone
    assert.equal((await post(t, `/inbox/${copy.id}/assign`, { job_uuid: 'ol-job-b' })).status, 200);
    ib = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.ok(ib.recent.some((x) => x.id === copy.id && x.job_number === '208777' && x.possible_duplicate));
    assert.equal((await summary(t)).invoices.length, 2);
    assert.equal((await post(t, `/inbox/${copy.id}/undo`)).status, 200);
    assert.equal((await summary(t)).invoices.length, 1);
    ib = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.ok(ib.invoices.some((x) => x.id === copy.id), 'back in the Inbox');
    assert.ok(!ib.recent.some((x) => x.id === copy.id));
    // Go straight to a job from the Inbox
    const op = await fetch(`${b3}/api/jobs/ol-job-b/open`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.equal(jwt.decode(op.token).jobUUID, 'ol-job-b');
    assert.equal((await fetch(`${b3}/api/jobs/job-a/open`, { headers: { Authorization: `Bearer ${t}` } })).status, 404, 'another business\u2019s job');
    // Remittances from Outlook are dropped
    inbox.push({ id: 'm7', internetMessageId: '<m7@x>', subject: 'Remittance advice 208777', from: { emailAddress: { address: 'x@y.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('remittance.pdf')] });
    await app3.locals.checkOutlook();
    await processor.idle();
    assert.ok(!mine().some((i) => i.file_name === 'remittance.pdf'));

    // Import a whole folder for October
    const fl = await fetch(`${b3}/api/outlook/folders`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.ok(fl.folders.some((f) => f.path === 'Inbox / Need to pay / Gliderol'));
    const imp = () => fetch(`${b3}/api/outlook/import`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: 'f-gl', from: '2026-10-01', to: '2026-10-31' }) }).then((r) => r.json());
    const r1 = await imp();
    assert.deepEqual([r1.emails, r1.imported, r1.files, r1.notInvoices], [2, 1, 1, 1]);
    assert.equal(calls.folder.from.toISOString(), '2026-09-30T14:00:00.000Z', 'from midnight 1 Oct, Melbourne (before daylight saving)');
    assert.equal(calls.folder.to.toISOString(), '2026-10-31T13:00:00.000Z', 'to midnight after 31 Oct, Melbourne (daylight saving)');
    await processor.idle();
    ib = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    const gl = ib.invoices.find((i) => i.invoice_number === 'S680001');
    assert.equal(gl.suggestion.job_number, '208777', 'job number on the invoice');
    const r2 = await imp();
    assert.equal(r2.skipped, 2, 'importing again brings nothing in twice');
    assert.equal(r2.imported, 0);
    // Browse like Outlook: top level, then into "Need to pay", then a folder's emails (already imported ones marked)
    const get = (q) => fetch(`${b3}/api/outlook/browse${q}`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.deepEqual((await get('')).folders.map((f) => f.name), ['Inbox', 'Need to pay']);
    assert.deepEqual((await get('?folder=f-pay')).folders.map((f) => f.name), ['Gliderol', 'Taurean']);
    const glList = await get('?folder=f-gl');
    assert.deepEqual(glList.messages.map((m) => [m.status, m.why]), [['imported', null], ['skipped', 'nothing']], 'only an email with an invoice in Job Costs counts as imported');
    // an email whose invoice was deleted in Job Costs isn't "imported" any more
    const glInv = repo.db.prepare("SELECT id FROM invoices WHERE invoice_number = 'S680001'").get();
    repo.deleteInvoice(glInv.id);
    assert.equal((await get('?folder=f-gl')).messages[0].status, 'deleted');
    const taList = await get('?folder=f-ta');
    assert.equal(taList.messages[0].imported, false);
    // Tick one email + a whole folder: the already-imported folder brings nothing new
    const ch = await fetch(`${b3}/api/outlook/import-chosen`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ['t1'], folder_ids: ['f-gl'] }) }).then((r) => r.json());
    assert.deepEqual([ch.emails, ch.imported, ch.skipped], [3, 1, 2]);
    await processor.idle();
    assert.equal((await get('?folder=f-ta')).messages[0].imported, true);

    // The automatic check looks in every folder: one filed in a subfolder is found, one in Sent Items isn't,
    // and one already brought in with Import from Outlook isn't brought in again
    inbox.push({ id: 'm8', internetMessageId: '<m8@x>', parentFolderId: 'f-paid', subject: 'Invoice for 208777', from: { emailAddress: { address: 'acc@door.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('Tax_Invoice_S690777_ref208777.pdf')] });
    inbox.push({ id: 'm9', internetMessageId: '<m9@x>', parentFolderId: 'f-sent', subject: 'Our invoice to the customer', from: { emailAddress: { address: 'accounts@doorimage.com.au' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('Tax_Invoice_S690888_ref208777.pdf')] });
    inbox.push({ ...taMail[0], parentFolderId: 'f-ta' });
    await app3.locals.checkOutlook();
    await processor.idle();
    const names = mine().map((i) => i.file_name);
    assert.ok(names.includes('Tax_Invoice_S690777_ref208777.pdf'), 'filed in a subfolder: found');
    assert.ok(!names.includes('Tax_Invoice_S690888_ref208777.pdf'), 'Sent Items: skipped');
    assert.equal(names.filter((n) => n === 'Tax_Invoice_S690001_ref208777.pdf').length, 1, 'imported by hand: not brought in twice');

    // Checking again doesn't add the same emails twice
    await app3.locals.checkOutlook();
    await processor.idle();
    assert.equal(mine().length, 5); // one was deleted above
    st = await fetch(`${b3}/api/outlook`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.equal(st.connected, true);
    assert.equal(st.email, 'accounts@doorimage.com.au');
    assert.equal(st.error, null);
  } finally {
    srv.close();
  }
});

test('Outlook is checked automatically only Mon–Fri 6am–6pm Melbourne time', () => {
  const { inCheckingHours, scheduleText } = require('../src/outlook');
  const cfg = { outlookTimezone: 'Australia/Melbourne', outlookDays: ['mon', 'tue', 'wed', 'thu', 'fri'], outlookFromHour: 6, outlookToHour: 18, outlookPollSeconds: 120 };
  // 2026-11-04 is a Wednesday; Melbourne is UTC+11 in November
  assert.equal(inCheckingHours(cfg, new Date('2026-11-03T22:30:00Z')), true, 'Wed 9:30am');
  assert.equal(inCheckingHours(cfg, new Date('2026-11-03T18:30:00Z')), false, 'Wed 5:30am');
  assert.equal(inCheckingHours(cfg, new Date('2026-11-04T07:30:00Z')), false, 'Wed 6:30pm');
  assert.equal(inCheckingHours(cfg, new Date('2026-11-07T00:00:00Z')), false, 'Saturday 11am');
  assert.equal(scheduleText(cfg), 'every 2 min, Mon–Fri 6am–6pm');
});

test('an invoice that is only the text of an email shows as a readable page', async () => {
  const t = await openCard('text-job', 'acc-text');
  const { inboxAddress: addr } = await summary(t);
  await fetch(`${base}/inbound/email?key=mailkey`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ From: 'Invoices@apps.myob.com', To: addr, ToFull: [{ Email: addr }], Subject: 'Invoice 00003379', Attachments: [],
      TextBody: 'INV-00003379 for $1,650.00\nView invoice <https://paydirect.myob.com/pay/abc?x=1&y=2>\nTotal amount (inc. tax) $1,650.00 ' + 'x'.repeat(40) }),
  });
  await processor.idle();
  const inv = latestInvoice();
  assert.match(inv.mime_type, /^text\//);
  const page = await fetch(`${base}/api/invoices/${inv.id}/file?t=${encodeURIComponent(t)}&view=html`);
  assert.match(page.headers.get('content-type'), /html/);
  const html = await page.text();
  assert.match(html, /came as the text of an email/);
  assert.match(html, /<a href="https:\/\/paydirect\.myob\.com\/pay\/abc\?x=1&amp;y=2"[^>]*>🔗 link<\/a>/);
  assert.ok(!html.includes('<https://'), 'raw link brackets are gone');
});

test('upload supplier invoices to the Inbox: the job number on each is found in ServiceM8, even for completed jobs', async () => {
  const t = await openCard('gl-home', 'acc-gl');
  processor.lookupJobs = app.locals.lookupJobs; // other test apps share this processor
  const fd = new FormData();
  fd.append('files', new Blob(['%PDF-1.4 a'], { type: 'application/pdf' }), 'Tax_Invoice_S667778_ref207835.pdf');
  fd.append('files', new Blob(['%PDF-1.4 b'], { type: 'application/pdf' }), 'Tax_Invoice_S668018_ref999999.pdf');
  const up = await api(t, '/inbox/upload', { method: 'POST', body: fd });
  assert.equal(up.status, 201);
  await processor.idle();
  await new Promise((r) => setTimeout(r, 50));
  const ib = await json(t, '/inbox');
  const a = ib.invoices.find((i) => i.invoice_number === 'S667778');
  assert.equal(a.suggestion.job_number, '207835', 'job never opened in Job Costs, found in ServiceM8');
  const b = ib.invoices.find((i) => i.invoice_number === 'S668018');
  assert.equal(b.suggestion, null, 'no such job');
  // Type the job number yourself
  assert.equal((await post(t, `/inbox/${b.id}/assign`, { job_number: '404040' })).status, 404);
  const r = await post(t, `/inbox/${b.id}/assign`, { job_number: '206594', paid: true }).then((x) => x.json());
  assert.equal(r.job_number, '206594');
  assert.ok(repo.itemsOf(b.id).every((x) => x.paid), 'the Paid tick marks it paid as it goes on the job');
  assert.equal((await post(t, `/suggestions/${a.id}/accept`)).status, 200);
  assert.ok(repo.itemsOf(a.id).every((x) => !x.paid), 'no tick: stays unpaid');
  assert.ok(repo.jobsOnInvoice(b.id).some((j) => j.job_number === '206594'));
});

test('a slow ServiceM8 never stops the window opening: details finish in the background', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const app4 = createApp({ config: { ...config, clickTimeoutMs: 200 }, repo, processor, diaryApi: fakeDiary, findJobByNumberImpl,
    fetchJobImpl: async () => { await slow; return { jobNumber: '209001', jobTitle: '1 Slow St', quoteAmount: 4000 }; },
    fetchActiveJobsImpl: async () => [] });
  const srv = await new Promise((r) => { const x = app4.listen(0, () => r(x)); });
  const b4 = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ev = jwt.sign({ eventName: 'job_costs_open', eventArgs: { jobUUID: 'slow-job' }, auth: { accountUUID: 'acc-slow', accessToken: 'x' } }, SECRET);
    const started = Date.now();
    const r = await fetch(`${b4}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev });
    assert.ok(Date.now() - started < 2000, 'answered quickly');
    const { eventResponse } = await r.json();
    const t = decodeURIComponent(eventResponse.match(/<iframe src="[^"]+t=([^"]+)"/)[1]);
    let s = await fetch(`${b4}/api/job`, { headers: { Authorization: `Bearer ${t}` } }).then((x) => x.json());
    assert.equal(s.sm8Loading, true, 'the card knows details are still coming');
    release();
    await new Promise((r2) => setTimeout(r2, 100));
    s = await fetch(`${b4}/api/job`, { headers: { Authorization: `Bearer ${t}` } }).then((x) => x.json());
    assert.equal(s.sm8Loading, false);
    assert.equal(s.job.job_number, '209001');
  } finally {
    srv.close();
  }
});

test('Bills: find invoices across jobs and mark several paid at once', async () => {
  const t = await openCard('gl-home', 'acc-gl');
  let { bills } = await json(t, '/bills');
  const gl = bills.filter((b) => /Gliderol/.test(b.supplier));
  assert.equal(gl.length, 2);
  assert.ok(gl.some((b) => b.jobs.some((j) => j.job_number === '206594')));
  assert.equal(gl.filter((b) => b.payment_state === 'unpaid').length, 1, 'one was marked paid when it was approved');
  assert.equal((await post(t, '/bills/paid', { ids: gl.map((b) => b.id), paid: true })).status, 200);
  ({ bills } = await json(t, '/bills'));
  assert.ok(bills.filter((b) => /Gliderol/.test(b.supplier)).every((b) => b.payment_state === 'paid' && b.paid_at));
  // another business's invoice can't be touched
  const other = repo.db.prepare("SELECT id FROM invoices WHERE account_uuid = 'acc-1' AND status = 'ready' LIMIT 1").get();
  const r = await post(t, '/bills/paid', { ids: [other.id], paid: true }).then((x) => x.json());
  assert.equal(r.updated, 0);
  assert.equal((await fetch(`${base}/bills?t=${encodeURIComponent(t)}`)).status, 200);
});

test('statement check: price lists and rules are kept per business; each statement line is matched to its invoice and job, then reviewed', async () => {
  const seen = {};
  const fakeChecker = {
    async readStatement() {
      return { supplier_name: 'Gliderol International Pty Ltd', statement_date: '2026-09-30', total_due: 1911.16, account_number: '122640',
        lines: [
          { date: '2026-08-20', reference: 'S600000', type: 'invoice', amount: 21.56 },
          { date: '2026-09-01', reference: 'S700001', type: 'invoice', amount: 1348.6 },
          { date: '2026-09-22', reference: 'S799999', type: 'invoice', amount: 589.6 },
          { date: '2026-09-01', reference: 'S700001', type: 'invoice', amount: 1348.6 }, // remittance slip repeat
          { date: '2026-09-05', reference: 'S700001', type: 'credit', amount: -48.6 }, // credit with the same document number
          { date: '2026-09-09', reference: 'EFT', type: 'payment', amount: -500 },
        ] };
    },
    async reviewInvoice(data, files) {
      seen.inv = data; seen.invFiles = files;
      return { verdict: 'problem', headline: 'Door $41 above the list', lines: [{ description: 'AA roller door 2100x4840', invoiced_ex_gst: 1226, expected_ex_gst: 1185, note: 'AA 1201-2100 × 4371-5100' }],
        difference_ex_gst: 41, rules_applied: [] };
    },
    async review(data, files) {
      seen.data = data; seen.files = files;
      return { summary: 'OK to pay except S799999. Check job 209500.', price_list_notes: null, actions: ['Ask Gliderol for S799999'],
        invoices: [
          { reference: 'S700001', verdict: 'ok', headline: 'AA roller as quoted', price: 'List $1,191 + 3%', job: 'Matches job 209500', rules_applied: ['1 door only'], difference_ex_gst: 0 },
          { reference: 'S799999', verdict: 'missing', headline: 'Not in Job Costs', price: '', job: '', rules_applied: [], difference_ex_gst: null },
        ] };
    },
  };
  JOBS['chk-job'] = { jobNumber: '209500', jobTitle: '1 Check St', clientName: 'Jo Client' };
  const app5 = createApp({ config, repo, processor, fetchJobImpl: async (u) => ({ ...JOBS[u], description: 'H 2100 W 4840 Door - $1226', status: 'Work Order', badges: ['Paid Supplier'] }),
    fetchActiveJobsImpl, findJobByNumberImpl, diaryApi: fakeDiary, checker: fakeChecker });
  const srv = await new Promise((r) => { const x = app5.listen(0, () => r(x)); });
  const b5 = `http://127.0.0.1:${srv.address().port}`;
  const call = (t, p, o = {}) => fetch(`${b5}/api${p}`, { ...o, headers: { Authorization: `Bearer ${t}`, ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  try {
    const t = await openCard('chk-job', 'acc-chk');
    repo.saveTokens('acc-chk', { accessToken: 'tok-chk', refreshToken: 'r', expiresIn: 3600 });
    // the invoice, uploaded on the job
    await upload(t, 'Tax_Invoice_S700001_ref209500.pdf');
    // a price list and a rule
    const fd = new FormData(); fd.append('supplier', 'Gliderol'); fd.append('file', new Blob(['%PDF-1.4 list'], { type: 'application/pdf' }), 'Gliderol 2026.pdf');
    assert.equal((await call(t, '/price-lists', { method: 'POST', body: fd })).status, 201);
    assert.equal((await call(t, '/rules', { method: 'POST', json: { text: 'Job 209500: Gliderol bills 1 door only' } })).status, 201);
    const off = await call(t, '/rules', { method: 'POST', json: { text: 'old rule' } }).then((x) => x.json());
    await call(t, `/rules/${off.id}`, { method: 'PATCH', json: { active: false } });
    // another business sees none of it
    const other = await openCard('job-a', 'acc-1');
    const theirs = await call(other, '/checks').then((x) => x.json());
    assert.equal(theirs.priceLists.length, 0);
    assert.equal(theirs.rules.length, 0);

    const sf = new FormData(); sf.append('statement', new Blob(['%PDF-1.4 st'], { type: 'application/pdf' }), 'Statement.pdf'); sf.append('date_from', '2026-09-01');
    const { id } = await call(t, '/checks', { method: 'POST', body: sf }).then((x) => x.json());
    let c;
    for (let i = 0; i < 50; i++) { c = await call(t, `/checks/${id}`).then((x) => x.json()); if (c.status === 'done' || c.status === 'error') break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(c.status, 'done', c.error);
    assert.deepEqual(c.matched.map((m) => m.reference), ['S700001', 'S799999', 'S700001'], 'August left out, repeat counted once, the credit kept');
    // money checks, in code: 21.56 + 1348.60 + 589.60 - 48.60 = 1911.16 (payments aren't owing)
    assert.equal(c.reconcile.statement_lines_total, 1911.16);
    assert.equal(c.reconcile.statement_adds_up, true);
    assert.equal(c.reconcile.checked_count, 3);
    assert.equal(c.reconcile.checked_total_inc_gst, 1889.6, '1348.60 + 589.60 - 48.60');
    assert.deepEqual(c.reconcile.not_in_job_costs, ['S799999']);
    assert.equal(seen.data.money_checks.checked_total_inc_gst, 1889.6, 'the review gets the totals worked out in code');
    assert.deepEqual(c.reconcile.amount_mismatches, [], 'the credit is not compared with the invoice');
    assert.equal(c.reconcile.ok, true);
    assert.equal(c.matched[0].jobs[0].job_number, '209500');
    assert.equal(c.matched[1].invoice, null);
    assert.deepEqual(seen.data.rules, ['Job 209500: Gliderol bills 1 door only'], 'only rules that are on');
    assert.equal(seen.data.lines[0].jobs[0].notes, 'H 2100 W 4840 Door - $1226');
    assert.deepEqual(seen.data.lines[0].jobs[0].servicem8_badges, ['Paid Supplier'], 'badges go into the check');
    assert.equal(seen.files.priceLists.length, 1);
    assert.equal(seen.files.invoiceFiles[0].reference, 'S700001');
    assert.equal(c.jobs['209500'], 'chk-job', 'job numbers in the report can be links');
    assert.equal(c.result.invoices[0].verdict, 'ok');
    // pay the OK ones
    const paid = await call(t, `/checks/${id}/mark-paid`, { method: 'POST', json: { references: ['S700001'] } }).then((x) => x.json());
    assert.equal(paid.updated, 1);
    c = await call(t, `/checks/${id}`).then((x) => x.json());
    assert.equal(c.matched[0].invoice.paid, true);
    // the job card opens on that invoice, with a way back to the check
    const page = await fetch(`${b5}/card?t=${encodeURIComponent(t)}&inv=${c.matched[0].invoice.id}&back=check:${id}`).then((x) => x.text());
    const boot = JSON.parse(page.match(/const BOOT = (\{.*?\});\n/)[1]);
    assert.equal(boot.select, c.matched[0].invoice.id);
    assert.equal(boot.back, `check:${id}`);
    assert.equal((await fetch(`${b5}/checks?t=${encodeURIComponent(t)}`)).status, 200);
    assert.equal((await fetch(`${b5}/prices?t=${encodeURIComponent(t)}`)).status, 200);

    // Each invoice is checked against its supplier's price list as it arrives
    processor.afterRead = app5.locals.priceCheck;
    const ifd = new FormData(); ifd.append('files', new Blob(['%PDF-1.4 inv'], { type: 'application/pdf' }), 'Tax_Invoice_S700777_ref209500.pdf');
    await call(t, '/inbox/upload', { method: 'POST', body: ifd });
    await processor.idle();
    let pcInv;
    for (let i = 0; i < 50; i++) { pcInv = repo.db.prepare("SELECT * FROM invoices WHERE invoice_number = 'S700777'").get(); if (pcInv && pcInv.price_check_status === 'done') break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(pcInv.price_check_status, 'done', 'checked automatically: Gliderol has a price list');
    assert.equal(seen.invFiles.priceList.supplier, 'Gliderol');
    assert.equal(seen.inv.money_checks.adds_up, true, '1226 + 122.60 = 1348.60');
    assert.deepEqual(seen.inv.rules, ['Job 209500: Gliderol bills 1 door only']);
    const ibx = await call(t, '/inbox').then((x) => x.json());
    const shown = ibx.invoices.find((i) => i.invoice_number === 'S700777');
    assert.equal(shown.price_check.verdict, 'problem');
    assert.equal(shown.price_check.difference_ex_gst, 41);
    // a supplier with no price list: nothing runs by itself; you can choose a price list
    const joe = repo.createInvoice({ accountUUID: 'acc-chk', source: 'upload' });
    repo.saveExtraction(joe.id, { supplier_name: 'Joe the Installer', invoice_number: 'J-1', total: 550, tax: 50, subtotal: 500, items: [{ description: 'Install 1 door', category: 'subcontractor', line_total: 500 }] });
    app5.locals.priceCheck(joe.id);
    assert.equal(repo.getInvoice(joe.id).price_check_status, 'none');
    const plId = (await call(t, '/checks').then((x) => x.json())).priceLists[0].id;
    assert.equal((await call(t, `/invoices/${joe.id}/price-check`, { method: 'POST', json: { price_list_id: plId } })).status, 200);
    for (let i = 0; i < 50 && repo.getInvoice(joe.id).price_check_status !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(repo.getInvoice(joe.id).price_check_status, 'done');
    const prices = await call(t, '/prices').then((x) => x.json());
    assert.deepEqual([prices.priceLists[0].checked, prices.priceLists[0].flagged], [2, 2], 'the Prices page counts the invoices checked against each list');

    // A statement dropped into the Inbox goes to Statement check, "not run yet", instead of disappearing
    processor.onStatement = app5.locals.onStatement; // joe test apps share this processor
    const sfd = new FormData(); sfd.append('files', new Blob(['%PDF-1.4 statement'], { type: 'application/pdf' }), 'Gliderol Statement October.pdf');
    assert.equal((await call(t, '/inbox/upload', { method: 'POST', body: sfd })).status, 201);
    await processor.idle();
    const home = await call(t, '/checks').then((x) => x.json());
    const waiting = home.checks.find((x) => x.status === 'waiting');
    assert.ok(waiting, 'filed under Statement check');
    assert.equal(waiting.supplier, 'Gliderol International Pty Ltd');
    assert.ok(!repo.db.prepare("SELECT 1 FROM invoices WHERE file_name = 'Gliderol Statement October.pdf'").get(), 'not left as an invoice');
    const inboxData = await call(t, '/inbox').then((x) => x.json());
    assert.equal(inboxData.statementsWaiting, 1, 'the Inbox says where it went');
    // run it, for October only
    assert.equal((await call(t, `/checks/${waiting.id}/rerun`, { method: 'POST', json: { date_from: '2026-09-01', date_to: '2026-09-30' } })).status, 200);
    let w;
    for (let i = 0; i < 50; i++) { w = await call(t, `/checks/${waiting.id}`).then((x) => x.json()); if (w.status === 'done' || w.status === 'error') break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(w.status, 'done', w.error);
    assert.equal(w.date_from, '2026-09-01');
  } finally {
    srv.close();
  }
});

test('the card, report and inbox page scripts have no syntax errors', () => {
  for (const file of ['card.html', 'report.html', 'inbox.html', 'bills.html', 'checks.html', 'summary.html', 'prices.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const js = html.split('<script>')[1].split('</script>')[0].replace('/*__BOOT__*/null', '{}');
    assert.doesNotThrow(() => new Function(js), file);
  }
});
