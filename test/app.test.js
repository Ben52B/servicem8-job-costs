const { test, before, after } = require('node:test');
let uniqN = 0; const uniq = () => ' #' + (++uniqN); // every test file is different (the same file twice is a duplicate)
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
// Each file read is its own bill (its own invoice number); "copy-of-X" is the same bill as X again.
const firstRead = fakeAnalyzer.analyzeFile.bind(fakeAnalyzer);
const numberOf = new Map(); let readN = 0;
fakeAnalyzer.analyzeFile = async (f) => {
  // "amended-copy-of-X": same number as X, different amount (not the same bill)
  const [, amended, copyOf] = f.fileName.match(/^(amended-)?copy-of-(.+)/) || [];
  const r = await firstRead({ ...f, fileName: copyOf || f.fileName });
  if (!r || !r.invoice_number || /^S\d/.test(r.invoice_number)) return r;
  const n = copyOf ? numberOf.get(copyOf) : r.invoice_number + (++readN > 1 ? '-' + readN : '');
  numberOf.set(f.fileName, n);
  return { ...r, invoice_number: n, ...(amended ? { total: r.total + 110, subtotal: (r.subtotal || 0) + 100, tax: (r.tax || 0) + 10 } : {}) };
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
  async downloadJobFile(uuid) { diary.calls.push('download:' + uuid); return { buffer: Buffer.from('%PDF-1.4 diary ' + uuid), contentType: 'application/pdf' }; },
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
  for (const n of names) fd.append('files', new Blob(['%PDF-1.4 fake' + uniq()], { type: 'application/pdf' }), n);
  const r = await api(token, '/invoices', { method: 'POST', body: fd });
  await processor.idle();
  return (await r.json()).created;
}
async function email(token, { subject = 'Invoice', file = 'invoice.pdf', text = 'Please see attached' } = {}) {
  const { inboxAddress: addr } = await summary(token);
  const r = await fetch(`${base}/inbound/email?key=mailkey`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ From: 'accounts@supplier.com.au', To: addr, ToFull: [{ Email: addr }], Subject: subject, TextBody: text,
      Attachments: [{ Name: file, ContentType: 'application/pdf', Content: Buffer.from('%PDF-1.4' + uniq()).toString('base64') }] }),
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
  fd.append('file', new Blob(['%PDF-1.4' + uniq()], { type: 'application/pdf' }), 'door.pdf');
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
  fd2.append('file', new Blob(['%PDF-1.4' + uniq()], { type: 'application/pdf' }), 'notinvoice.pdf');
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
  assert.match(note.text, /Door Supplies Pty Ltd invoice #INV-100[-0-9]* added – \$3,000\.00 ex GST/);
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
  fd.append('file', new Blob(['%PDF-1.4' + uniq()], { type: 'application/pdf' }), 'receipt.pdf');
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

    // The same bill emailed again (same supplier, number and amount): not kept, so it can't be paid twice
    inbox.push({ id: 'm6', internetMessageId: '<m6@x>', subject: 'Copy of invoice 208777', from: { emailAddress: { address: 'acc@door.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('copy-of-invoice.pdf')] });
    let r6 = await fetch(`${b3}/api/outlook/check`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.equal(r6.found, 1, 'Check now works');
    await processor.idle();
    let ib = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    assert.ok(!ib.invoices.some((i) => i.supplier === 'Door Supplies Pty Ltd'), 'the exact copy is dropped');
    assert.ok(repo.db.prepare("SELECT 1 FROM mail_imports WHERE outcome = 'duplicate'").get(), 'the email shows as "already in Job Costs" in the Outlook list');
    // Same number but a different amount (e.g. an amended invoice): kept, flagged, with the job the first one is on
    inbox.push({ id: 'm6b', internetMessageId: '<m6b@x>', subject: 'Amended invoice 208777', from: { emailAddress: { address: 'acc@door.com' } }, receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { content: '' }, files: [pdf('amended-copy-of-invoice.pdf')] });
    await app3.locals.checkOutlook();
    await processor.idle();
    ib = await fetch(`${b3}/api/inbox`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
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
  fd.append('files', new Blob(['%PDF-1.4 a' + uniq()], { type: 'application/pdf' }), 'Tax_Invoice_S667778_ref207835.pdf');
  fd.append('files', new Blob(['%PDF-1.4 b' + uniq()], { type: 'application/pdf' }), 'Tax_Invoice_S668018_ref999999.pdf');
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
    const fd = new FormData(); fd.append('supplier', 'Gliderol'); fd.append('file', new Blob(['%PDF-1.4 list' + uniq()], { type: 'application/pdf' }), 'Gliderol 2026.pdf');
    assert.equal((await call(t, '/price-lists', { method: 'POST', body: fd })).status, 201);
    assert.equal((await call(t, '/rules', { method: 'POST', json: { text: 'Job 209500: Gliderol bills 1 door only' } })).status, 201);
    const off = await call(t, '/rules', { method: 'POST', json: { text: 'old rule' } }).then((x) => x.json());
    await call(t, `/rules/${off.id}`, { method: 'PATCH', json: { active: false } });
    // another business sees none of it
    const other = await openCard('job-a', 'acc-1');
    const theirs = await call(other, '/checks').then((x) => x.json());
    assert.equal(theirs.priceLists.length, 0);
    assert.equal(theirs.rules.length, 0);

    const sf = new FormData(); sf.append('statement', new Blob(['%PDF-1.4 st' + uniq()], { type: 'application/pdf' }), 'Statement.pdf'); sf.append('date_from', '2026-09-01');
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
    // the rest of the statement: August, only checked for paid / not paid
    assert.deepEqual(c.reconcile.period, { from: '2026-09-01', to: null });
    assert.equal(c.reconcile.rest.earlier_count, 1);
    assert.equal(c.reconcile.rest.earlier_total, 21.56);
    assert.equal(c.reconcile.rest.later_count, 0);
    assert.equal(c.reconcile.rest.payments_total, -500);
    assert.equal(Math.round(c.reconcile.checked_total_inc_gst * 100) + Math.round(c.reconcile.rest.earlier_total * 100), Math.round(c.reconcile.statement_lines_total * 100), 'period + earlier = the whole statement');
    assert.deepEqual(c.reconcile.rest.earlier_unpaid.map((l) => [l.reference, l.in_job_costs]), [['S600000', false]]);
    assert.equal(c.reconcile.rest.paid_but_listed.length, 0);
    const past = (await call(t, '/checks').then((x) => x.json())).checks.find((x) => x.id === id);
    assert.equal(past.period_total, 1889.6);
    assert.equal(past.period_count, 3);
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
    // one-time rules: one for this invoice, one for another
    const once1 = await call(t, '/rules', { method: 'POST', json: { text: 'S700777: agreed $41 extra for a rush order', kind: 'once', target: 'S700777' } }).then((x) => x.json());
    const once2 = await call(t, '/rules', { method: 'POST', json: { text: 'S999999: free delivery', kind: 'once', target: 'S999999' } }).then((x) => x.json());
    const ifd = new FormData(); ifd.append('files', new Blob(['%PDF-1.4 inv' + uniq()], { type: 'application/pdf' }), 'Tax_Invoice_S700777_ref209500.pdf');
    await call(t, '/inbox/upload', { method: 'POST', body: ifd });
    await processor.idle();
    let pcInv;
    for (let i = 0; i < 50; i++) { pcInv = repo.db.prepare("SELECT * FROM invoices WHERE invoice_number = 'S700777'").get(); if (pcInv && pcInv.price_check_status === 'done') break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(pcInv.price_check_status, 'done', 'checked automatically: Gliderol has a price list');
    assert.equal(seen.invFiles.priceList.supplier, 'Gliderol');
    assert.equal(seen.inv.money_checks.adds_up, true, '1226 + 122.60 = 1348.60');
    assert.deepEqual(seen.inv.rules, ['Job 209500: Gliderol bills 1 door only', 'S700777: agreed $41 extra for a rush order'], 'the always rule + the one-time rule for this invoice only');
    const r1 = repo.listRules('acc-chk').find((r) => r.id === once1.id);
    assert.ok(r1.used_at && !r1.active, 'a one-time rule switches itself off once used');
    assert.match(r1.used_on, /S700777/);
    assert.ok(!repo.listRules('acc-chk').find((r) => r.id === once2.id).used_at, 'the one for another invoice waits');
    // ticking a used one-time rule back on makes it ready again
    await call(t, `/rules/${once1.id}`, { method: 'PATCH', json: { active: true } });
    assert.equal(repo.rulesFor('acc-chk', ['S700777']).some((r) => r.id === once1.id), true);
    await call(t, `/rules/${once1.id}`, { method: 'PATCH', json: { active: false } });
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
    const s700001 = repo.db.prepare("SELECT price_check_status FROM invoices WHERE invoice_number = 'S700001'").get();
    assert.equal(s700001.price_check_status, 'done', 'uploaded before its price list: checked once the list was there (when the card opened)');
    assert.deepEqual([prices.priceLists[0].checked, prices.priceLists[0].flagged], [3, 3], 'the Prices page counts the invoices checked against each list');

    // A statement dropped into the Inbox goes to Statement check, "not run yet", instead of disappearing
    processor.onStatement = app5.locals.onStatement; // joe test apps share this processor
    const sfd = new FormData(); sfd.append('files', new Blob(['%PDF-1.4 statement' + uniq()], { type: 'application/pdf' }), 'Gliderol Statement October.pdf');
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

    // Stop keeps the statement; deleting the check frees the email in Import from Outlook
    repo.updateCheck(w.id, { status: 'checking', progress_at: new Date(Date.now() - 5 * 60000).toISOString() });
    assert.equal((await call(t, `/checks/${w.id}/stop`, { method: 'POST' })).status, 200);
    const stopped = await call(t, `/checks/${w.id}`).then((x) => x.json());
    assert.equal(stopped.status, 'waiting', 'stopped: back to not run yet');
    // a stop is saved straight away: work still in progress gives up at its next step
    repo.updateCheck(w.id, { status: 'checking', progress_at: new Date().toISOString() });
    await call(t, `/checks/${w.id}/stop`, { method: 'POST' });
    assert.equal((await call(t, `/checks/${w.id}`).then((x) => x.json())).status, 'waiting', 'even while it was running a moment ago');
    assert.ok(stopped.file_name, 'the statement is still there');
    repo.recordImport('import:<stmt@x>', [987654]);
    repo.setImportOutcome(987654, 'statement', w.id);
    assert.equal(repo.importStatus('acc-chk', 'import:<stmt@x>').state, 'statement');
    assert.equal((await call(t, `/checks/${w.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(repo.importStatus('acc-chk', 'import:<stmt@x>').state, 'deleted', 'its check is gone, so the email can be imported again');
  } finally {
    srv.close();
  }
});

test('statement check: an invoice that isn\u2019t in Job Costs yet is found in Outlook, imported and checked; progress is shown', async () => {
  const pdfFile = (name) => ({ name, contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 ' + name), inline: false });
  const mail = { id: 'sx', internetMessageId: '<sx@x>', subject: 'Tax Invoice S799999', bodyPreview: 'Invoice S799999 attached', from: { emailAddress: { address: 'ar@gliderol.com.au' } },
    receivedDateTime: '2026-09-22T01:00:00Z', hasAttachments: true, body: { content: '' }, parentFolderId: 'f-gl', files: [pdfFile('Tax_Invoice_S799999_ref209500.pdf')] };
  const searched = [];
  const fakeGraph = {
    refreshTokens: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    searchMessages: async (tok, text) => { searched.push(text); return text === 'S799999' ? [mail] : []; },
    skippedFolderIds: async () => ['f-sent'],
    listAttachments: async () => mail.files,
  };
  const progressSeen = [];
  let review = null;
  const fakeChecker = {
    async readStatement() { return { supplier_name: 'Gliderol International Pty Ltd', statement_date: '2026-09-30', total_due: 589.6, lines: [{ date: '2026-09-22', reference: 'S799999', type: 'invoice', amount: 589.6 }] }; },
    async review(data) {
      review = data;
      return { summary: 'ok', price_list_notes: null, actions: [], invoices: [{ reference: 'S799999', verdict: 'ok', headline: '', price: '', job: '', rules_applied: [], difference_ex_gst: 0 }] };
    },
  };
  const app6 = createApp({ config, repo, processor, fetchJobImpl: async (u) => ({ ...JOBS[u], description: 'notes' }), fetchActiveJobsImpl, findJobByNumberImpl,
    diaryApi: fakeDiary, outlookApi: fakeGraph, checker: fakeChecker });
  processor.lookupJobs = app6.locals.lookupJobs; processor.onStatement = app6.locals.onStatement; processor.afterRead = null;
  const srv = await new Promise((r) => { const x = app6.listen(0, () => r(x)); });
  const b6 = `http://127.0.0.1:${srv.address().port}`;
  try {
    const t = await openCard('chk-job', 'acc-chk');
    repo.saveOutlook('acc-chk', { email: 'accounts@x', accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600e3).toISOString(), connectedAt: new Date().toISOString() });
    const sf = new FormData(); sf.append('statement', new Blob(['%PDF-1.4 st' + uniq()], { type: 'application/pdf' }), 'Statement.pdf');
    const { id } = await fetch(`${b6}/api/checks`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: sf }).then((x) => x.json());
    let c;
    for (let i = 0; i < 200; i++) {
      c = await fetch(`${b6}/api/checks/${id}`, { headers: { Authorization: `Bearer ${t}` } }).then((x) => x.json());
      if (c.progress) progressSeen.push(c.progress);
      if (c.status === 'done' || c.status === 'error') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(c.status, 'done', c.error);
    assert.deepEqual(searched, ['S799999']);
    assert.ok(c.matched[0].invoice, 'found in Outlook and imported');
    assert.equal(c.matched[0].from_outlook, true);
    assert.equal(c.matched[0].jobs[0].job_number, '209500');
    assert.equal(c.matched[0].jobs[0].suggested, true, 'checked against the job printed on it, still to be approved');
    assert.equal(review.lines[0].invoice.found_in_job_costs, true);
    assert.ok(c.started_at);
    assert.equal(c.progress, null, 'progress cleared when done');
  } finally {
    repo.removeOutlook('acc-chk');
    srv.close();
  }
});

test('a statement check cut short by restarts carries on, but stops after the third time instead of looping', async () => {
  await new Promise((r) => setTimeout(r, 3300)); // let the other test apps' own restart timers fire first
  const c1 = repo.createCheck('acc-loop', { fileName: 's.pdf', filePath: 'none.pdf' });
  const c2 = repo.createCheck('acc-loop', { fileName: 's2.pdf', filePath: 'none.pdf' });
  repo.updateCheck(c1.id, { status: 'checking', attempts: 2 });
  repo.updateCheck(c2.id, { status: 'checking', attempts: 0 });
  let ran = 0;
  createApp({ config, repo, processor, checker: { readStatement: async () => { ran++; throw new Error('boom'); }, review: async () => ({}) } }); // starting the app = a restart
  await new Promise((r) => setTimeout(r, 3300));
  const a1 = repo.getCheck('acc-loop', c1.id);
  assert.equal(a1.status, 'error');
  assert.match(a1.error, /restarted 3 times/);
  const a2 = repo.getCheck('acc-loop', c2.id);
  assert.equal(a2.attempts, 1, 'the other one carries on, counted');
  assert.equal(a2.status, 'error', 'it ran again (and here failed reading)');
  assert.match(a2.error, /boom/);
});

test('the same bill twice: a new copy is blocked; an unpaid copy of a paid bill is flagged and can’t be paid again', async () => {
  JOBS['dup-job'] = { jobNumber: '208118', jobTitle: '5 Dup St' };
  JOBS['dup-job2'] = { jobNumber: '208119', jobTitle: '6 Dup St' };
  const t = await openCard('dup-job', 'acc-dup');
  const t2 = await openCard('dup-job2', 'acc-dup');

  // The first copy goes on the job and is paid
  await upload(t, 'fine-tuned.pdf');
  const first = (await summary(t)).invoices[0];
  assert.equal(first.status, 'ready');
  assert.equal((await api(t, `/invoices/${first.id}`, { method: 'PATCH', json: { paid: true } })).status, 200);
  // The same bill uploaded again on another job: kept out of the costs, with where the first one is
  await upload(t2, 'copy-of-fine-tuned.pdf');
  let s2 = await summary(t2);
  assert.equal(s2.invoices.length, 1, 'shown on the card it was uploaded on, so it can be deleted');
  assert.equal(s2.invoices[0].status, 'error');
  assert.match(s2.invoices[0].error, /^Duplicate – not added\. .*already in Job Costs on job #208118, already PAID .*same supplier, invoice number and amount/);
  assert.equal(s2.totals.total, 0, 'not counted');
  // The identical file again: blocked before it's even read
  const same = () => { const fd = new FormData(); fd.append('files', new Blob(['%PDF-1.4 the very same file'], { type: 'application/pdf' }), 'scan.pdf'); return fd; };
  await api(t, '/invoices', { method: 'POST', body: same() }); await processor.idle();
  await api(t2, '/invoices', { method: 'POST', body: same() }); await processor.idle();
  s2 = await summary(t2);
  const blocked = s2.invoices.find((i) => i.file_name === 'scan.pdf');
  assert.match(blocked.error, /on job #208118.*\(the same file\)/);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM items WHERE invoice_id = ?').get(blocked.id).n, 0, 'not read: no lines');

  // Copies that got in before this check: the paid one counts, the unpaid one is flagged
  const add = (supplier, number, paid) => {
    const inv = repo.createInvoice({ accountUUID: 'acc-dup', source: 'upload' });
    repo.saveExtraction(inv.id, { supplier_name: supplier, invoice_number: number, total: 3500, tax: 318.18, subtotal: 3181.82, items: [{ description: 'Electrical work', category: 'subcontractor', line_total: 3181.82 }] });
    repo.assignWhole(inv.id, 'dup-job', { category: 'subcontractor' });
    if (paid) repo.setInvoicePaid(inv.id, true);
    return inv.id;
  };
  const unpaidId = add('Fine Tuned Electrical', '4650', false);
  const paidId = add('Fine Tuned Electrical Pty Ltd', 'INV-004650', true); // name and number written differently
  const s = await summary(t);
  const unpaid = s.invoices.find((i) => i.id === unpaidId);
  const paidCopy = s.invoices.find((i) => i.id === paidId);
  assert.equal(unpaid.duplicate_of, paidId, 'the unpaid copy is the duplicate');
  assert.equal(unpaid.twin.paid, true);
  assert.equal(paidCopy.duplicate_of, null, 'the paid copy counts');
  assert.equal(Math.round(s.invoices.filter((i) => !i.duplicate_of && i.status === 'ready').reduce((a, i) => a + i.job_total, 0) * 100),
    Math.round((s.totals.total) * 100), 'the bill is counted once');
  // It can't be marked paid again, by itself or in bulk
  const r = await api(t, `/invoices/${unpaidId}`, { method: 'PATCH', json: { paid: true } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /already PAID/);
  const bills = await json(t, '/bills');
  assert.equal((bills.bills || bills).find((b) => b.id === unpaidId).twin.id, paidId, 'the Bills page warns');
  const bulk = await post(t, '/bills/paid', { ids: [unpaidId], paid: true }).then((x) => x.json());
  assert.deepEqual([bulk.updated, bulk.skipped.length], [0, 1]);
  assert.equal(repo.twinOf(repo.getInvoice(unpaidId)).paid, true);
  assert.equal(repo.getInvoice(unpaidId) && repo.db.prepare('SELECT SUM(paid) AS p FROM items WHERE invoice_id = ?').get(unpaidId).p, 0, 'still unpaid');
  // a different amount is a different bill
  const other = add('Fine Tuned Electrical', '4651', false);
  assert.equal(repo.twinOf(repo.getInvoice(other)), null);
});

test('statement check flags show on the job card until marked resolved', async () => {
  JOBS['flag-job'] = { jobNumber: '208264', jobTitle: '8 Flag St' };
  const t = await openCard('flag-job', 'acc-flag');
  const inv = repo.createInvoice({ accountUUID: 'acc-flag', source: 'upload' });
  repo.saveExtraction(inv.id, { supplier_name: 'Gliderol International Pty Ltd', invoice_number: 'S678034', total: 294, tax: 26.73, subtotal: 267.27, items: [{ description: 'Super Closer', category: 'materials', line_total: 267.27 }] });
  repo.assignWhole(inv.id, 'flag-job', { category: 'materials' });
  const done = (verdict, extra = {}) => {
    const c = repo.createCheck('acc-flag', { fileName: 's.pdf', filePath: 's.pdf' });
    repo.updateCheck(c.id, { status: 'done', supplier: 'Gliderol International Pty Ltd', statement_date: '2026-10-31', finished_at: new Date().toISOString(),
      matched: [{ reference: 'S678034', type: 'invoice', amount: 294, invoice: { id: inv.id, paid: false }, jobs: [] }],
      result: { invoices: [{ reference: 'S678034', verdict, headline: 'Super Closer $84 above the list', difference_ex_gst: 84 }] }, reconcile: { amount_mismatches: [] }, ...extra });
    return c.id;
  };
  const checkId = done('problem');
  let s = await summary(t);
  let f = s.invoices.find((i) => i.id === inv.id).check_flag;
  assert.equal(f.verdict, 'problem');
  assert.equal(f.check_id, checkId);
  assert.match(f.headline, /Super Closer/);
  assert.equal(f.difference_ex_gst, 84);
  // another business never sees it
  const other = await openCard('job-a', 'acc-1');
  assert.equal((await post(other, `/checks/${checkId}/resolve`, { reference: 'S678034' })).status, 404);
  // sorted out with the supplier: gone from the card, kept on the check
  assert.equal((await post(t, `/checks/${checkId}/resolve`, { reference: 'S678034', note: 'credit note coming' })).status, 200);
  s = await summary(t);
  assert.equal(s.invoices.find((i) => i.id === inv.id).check_flag, null);
  assert.equal(repo.getCheck('acc-flag', checkId).resolved.S678034.note, 'credit note coming');
  // a later check decides: OK clears, a new problem shows again
  done('problem');
  assert.ok((await summary(t)).invoices.find((i) => i.id === inv.id).check_flag);
  done('ok');
  assert.equal((await summary(t)).invoices.find((i) => i.id === inv.id).check_flag, null);
  // the amounts not matching is always a problem
  done('ok', { reconcile: { amount_mismatches: [{ reference: 'S678034', on_statement: 300, in_job_costs: 294, difference: 6 }] } });
  f = (await summary(t)).invoices.find((i) => i.id === inv.id).check_flag;
  assert.deepEqual([f.verdict, f.amount_mismatch.on_statement], ['problem', 300]);
});

test('sent to stock by mistake: move the whole invoice onto its job from the Inbox', async () => {
  JOBS['mv-job'] = { jobNumber: '208400', jobTitle: '3 Move St' };
  const t = await openCard('mv-job', 'acc-mv');
  const inv = repo.createInvoice({ accountUUID: 'acc-mv', source: 'upload' });
  repo.saveExtraction(inv.id, { supplier_name: 'Merlin', invoice_number: 'M-400', total: 1100, tax: 100, subtotal: 1000, items: [{ description: 'Motor', quantity: 5, line_total: 1000, category: 'materials' }] });
  assert.equal((await post(t, `/inbox/${inv.id}/stock`)).status, 200);
  let ib = await json(t, '/inbox');
  assert.ok(ib.invoices.find((i) => i.id === inv.id).kept_as_stock, 'in Stock & leftovers');
  const r = await post(t, `/inbox/${inv.id}/assign`, { job_number: '208400' });
  assert.equal(r.status, 200);
  const s = await summary(t);
  assert.ok(s.invoices.some((i) => i.id === inv.id && i.whole), 'a cost on the job');
  assert.equal(repo.getInvoice(inv.id).kept_as_stock, 0, 'not stock any more');
  ib = await json(t, '/inbox');
  assert.ok(!ib.invoices.some((i) => i.id === inv.id), 'gone from Stock & leftovers');
});

test('wrong job: ✎ Change moves a whole invoice to another job or to stock (Inbox and Bills)', async () => {
  JOBS['mv2-a'] = { jobNumber: '208410', jobTitle: '1 First St' };
  JOBS['mv2-b'] = { jobNumber: '208411', jobTitle: '2 Second St' };
  JOBS['mv2-s'] = { jobNumber: '208412', jobTitle: 'Stock order' };
  const ta = await openCard('mv2-a', 'acc-mv2');
  const tb = await openCard('mv2-b', 'acc-mv2');
  const ts = await openCard('mv2-s', 'acc-mv2');
  await api(ts, '/job', { method: 'PATCH', json: { is_stock: true } });
  const inv = repo.createInvoice({ accountUUID: 'acc-mv2', source: 'upload' });
  repo.saveExtraction(inv.id, { supplier_name: 'Merlin', invoice_number: 'M-410', total: 1100, tax: 100, subtotal: 1000, items: [{ description: 'Motor', quantity: 5, line_total: 1000, category: 'materials' }] });
  // sent to a job marked as a stock order: it's in stock, and the Inbox says so
  assert.equal((await post(ta, `/inbox/${inv.id}/assign`, { job_number: '208412' })).status, 200);
  let ib = await json(ta, '/inbox');
  let rec = ib.recent.find((r) => r.id === inv.id);
  assert.deepEqual([rec.to_stock, rec.stock_job_number, rec.movable], [true, '208412', true]);
  // ✎ Change → job 208410: a cost on that job, out of stock
  let r = await post(ta, `/inbox/${inv.id}/move`, { job_number: '208410' }).then((x) => x.json());
  assert.deepEqual([r.ok, r.job_number, r.to_stock], [true, '208410', false]);
  assert.ok((await summary(ta)).invoices.some((i) => i.id === inv.id && i.whole));
  assert.equal(repo.getInvoice(inv.id).kept_as_stock, 0);
  ib = await json(ta, '/inbox');
  rec = ib.recent.find((x) => x.id === inv.id);
  assert.deepEqual([rec.to_stock, rec.job_number], [false, '208410'], 'Recently approved shows where it went');
  // wrong job again → 208411: off the first job, onto the second
  r = await post(ta, `/inbox/${inv.id}/move`, { job_number: '208411' }).then((x) => x.json());
  assert.equal(r.job_number, '208411');
  assert.ok(!(await summary(ta)).invoices.some((i) => i.id === inv.id));
  assert.ok((await summary(tb)).invoices.some((i) => i.id === inv.id && i.whole));
  const bill = (await json(ta, '/bills')).bills.find((b) => b.id === inv.id);
  assert.deepEqual([bill.jobs.map((j) => j.job_number), bill.movable], [['208411'], true], 'Bills shows the job, with ✎');
  // → stock
  r = await post(ta, `/inbox/${inv.id}/move`, { to_stock: true }).then((x) => x.json());
  assert.equal(r.to_stock, true);
  assert.ok(!(await summary(tb)).invoices.some((i) => i.id === inv.id));
  assert.equal(repo.getInvoice(inv.id).kept_as_stock, 1);
  // a typo'd job number changes nothing
  assert.equal((await post(ta, `/inbox/${inv.id}/move`, { job_number: '999999' })).status, 404);
  assert.equal(repo.getInvoice(inv.id).kept_as_stock, 1);
  // shared between two jobs: change it on the cards instead
  const item = repo.db.prepare('SELECT id FROM items WHERE invoice_id = ?').get(inv.id).id;
  assert.equal((await api(ta, `/items/${item}/share`, { method: 'PUT', json: { quantity: 2 } })).status, 200);
  assert.equal((await api(tb, `/items/${item}/share`, { method: 'PUT', json: { quantity: 1 } })).status, 200);
  const shared = await post(ta, `/inbox/${inv.id}/move`, { job_number: '208411' });
  assert.equal(shared.status, 400);
  assert.match((await shared.json()).error, /shared between jobs/);
});

test('Stock page: what is in stock, what is left, and stock used up recently', async () => {
  JOBS['st-job'] = { jobNumber: '208420', jobTitle: '4 Stock St' };
  const t = await openCard('st-job', 'acc-st');
  const mk = (num, qty) => { const inv = repo.createInvoice({ accountUUID: 'acc-st', source: 'upload' });
    repo.saveExtraction(inv.id, { supplier_name: 'Merlin', invoice_number: num, invoice_date: new Date().toISOString().slice(0, 10), total: 1100, tax: 100, subtotal: 1000, items: [{ description: 'Merlin opener', quantity: qty, line_total: 1000, category: 'materials' }] });
    return inv.id; };
  const whole = mk('M-500', 10); await post(t, `/inbox/${whole}/stock`);
  const part = mk('M-501', 10); await post(t, `/inbox/${part}/stock`);
  const gone = mk('M-502', 2); await post(t, `/inbox/${gone}/stock`);
  const item = (id) => repo.db.prepare('SELECT id FROM items WHERE invoice_id = ?').get(id).id;
  assert.equal((await api(t, `/items/${item(part)}/share`, { method: 'PUT', json: { quantity: 4 } })).status, 200);
  assert.equal((await api(t, `/items/${item(gone)}/share`, { method: 'PUT', json: { quantity: 2 } })).status, 200);
  const s = await json(t, '/stock');
  assert.deepEqual(s.stock.map((i) => i.id).sort(), [whole, part].sort(), 'in stock: the untouched one and the part-used one');
  assert.equal(s.stock.find((i) => i.id === part).lines[0].trace.left_quantity, 6, '4 of 10 used');
  assert.equal(s.leftTotal, 1600, '$1,000 + $600 left (ex GST)');
  assert.deepEqual(s.usedUp.map((i) => [i.id, i.jobs.map((j) => j.job_number)]), [[gone, ['208420']]], 'used up, and where it went');
  assert.equal((await fetch(`${base}/stock?t=${encodeURIComponent(t)}`)).status, 200);
  // ✎ Move to a job (on the Stock page): the untouched one becomes the job's cost
  assert.equal((await post(t, `/inbox/${whole}/move`, { job_number: '208420' })).status, 200);
  assert.ok(!(await json(t, '/stock')).stock.some((i) => i.id === whole));
});

test('no job number on the invoice: the customer name suggests the job (surname or whole name; not first names or your own name)', async () => {
  const A = 'acc-name';
  repo.ensureAccount(A);
  const job = (uuid, num, client, status = 'Work Order') => repo.ensureJob({ jobUUID: uuid, accountUUID: A, jobNumber: num, jobTitle: num + ' site', clientName: client, status });
  job('n-1', '208501', 'Todd Gardiner');
  job('n-2', '208502', 'Leading Edge Garage Doors');
  job('n-3', '208503', 'Michael Smith');
  job('n-4', '208504', 'Michael Jones');
  // your own business on several internal jobs: its name never matches
  job('n-5', '208505', 'Alpha Garage Doors'); job('n-6', '208506', 'Alpha Garage Doors'); job('n-7', '208507', 'Alpha Garage Doors');
  job('n-8', '208508', 'Sam Burton', 'Completed');
  const read = (fields) => {
    const inv = repo.createInvoice({ accountUUID: A, source: 'upload' });
    repo.saveExtraction(inv.id, { supplier_name: 'GDA', invoice_number: 'G-' + inv.id, total: 110, tax: 10, subtotal: 100, references: [], items: [{ description: 'Remote', line_total: 100, category: 'materials' }], ...fields });
    return repo.getJob(repo.suggestJob(inv.id) || '') || null;
  };
  assert.equal(read({ customer_name: 'T. Gardiner' }).job_number, '208501', 'surname');
  assert.match(repo.db.prepare('SELECT suggestion_reason FROM invoices ORDER BY id DESC LIMIT 1').get().suggestion_reason, /Gardiner/);
  assert.equal(read({ customer_name: 'Leading Edge' }).job_number, '208502', 'the whole company name');
  assert.equal(read({ references: ['Leading Edge GD'] }).job_number, '208502', 'in the references');
  assert.equal(read({ customer_name: 'Michael' }), null, 'a first name alone');
  assert.equal(read({ references: ['Alpha GD order'] }), null, 'your own business name');
  assert.equal(read({ customer_name: 'Burton' }), null, 'only open jobs');
  assert.equal(read({ customer_name: 'Smith' }).job_number, '208503');
  job('n-9', '208509', 'Jane Smith');
  assert.equal(read({ customer_name: 'Smith' }), null, 'two open jobs for a Smith: no guess');
  // a job number still wins
  assert.equal(read({ customer_name: 'Gardiner', references: ['PO 208502'] }).job_number, '208502');
});

test('sessions stay alive while the window is in use: a fresh token once the old one is over an hour old', async () => {
  const t = await openCard('job-a');
  const fresh = await api(t, '/ping');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('x-session-token'), null, 'a new token is used as is');
  const now = Math.floor(Date.now() / 1000);
  const old = jwt.sign({ jobUUID: 'job-a', iat: now - 2 * 3600, exp: now + 10 * 3600 }, 'session-secret');
  const r = await api(old, '/ping');
  assert.equal(r.status, 200);
  const nt = r.headers.get('x-session-token');
  assert.ok(nt, 'two hours old: a fresh one comes back');
  assert.equal(jwt.decode(nt).jobUUID, 'job-a');
  assert.ok(jwt.decode(nt).exp - now >= 11 * 3600, 'good for another 12 hours');
  assert.equal((await api(nt, '/job')).status, 200);
  const expired = jwt.sign({ jobUUID: 'job-a', iat: now - 13 * 3600, exp: now - 3600 }, 'session-secret');
  assert.equal((await api(expired, '/ping')).status, 401, 'an expired one still needs Job Costs opened again');
});

test('standing price changes are rules for one supplier; a pattern a check spots can be saved as one', async () => {
  JOBS['rule-job'] = { jobNumber: '208600', jobTitle: '6 Rule St' };
  const t = await openCard('rule-job', 'acc-rule');
  // "Gliderol: price list + 3%" from the Price change form: only for Gliderol
  const r = await post(t, '/rules', { text: 'Gliderol: expect the price list + 3% (2026 rise) – not confirmed by Gliderol yet', kind: 'always', supplier: 'Gliderol' });
  assert.equal(r.status, 201);
  await post(t, '/rules', { text: 'All suppliers: freight over $100 needs a look', kind: 'always' });
  const texts = (sup) => repo.rulesFor('acc-rule', [], sup).map((x) => x.text);
  assert.equal(texts('Gliderol International Pty Ltd').length, 2, 'Gliderol gets its rule and the general one');
  assert.deepEqual(texts('Taurean Door Systems'), ['All suppliers: freight over $100 needs a look'], 'other suppliers only the general one');
  assert.equal(texts(undefined).length, 2, 'no supplier given: everything (as before)');
  assert.equal((await json(t, '/prices')).rules.find((x) => x.supplier === 'Gliderol').kind, 'always');
  // a price check suggested a rule: the card knows once it's saved
  const inv = repo.createInvoice({ accountUUID: 'acc-rule', source: 'upload' });
  repo.saveExtraction(inv.id, { supplier_name: 'Taurean Door Systems', invoice_number: 'T-1', total: 110, tax: 10, subtotal: 100, items: [{ description: 'Door', line_total: 100, category: 'materials' }] });
  repo.assignWhole(inv.id, 'rule-job', {});
  repo.setPriceCheck(inv.id, { status: 'done', result: { verdict: 'check', headline: 'About 5% above the list', lines: [], suggested_rule: 'Taurean: expect the price list + 5%' } });
  const card = () => json(t, '/job').then((s) => s.invoices.find((i) => i.id === inv.id).price_check);
  assert.equal((await card()).rule_saved, false);
  await post(t, '/rules', { text: 'Taurean: expect the price list + 5%', kind: 'always', supplier: 'Taurean' });
  assert.equal((await card()).rule_saved, true);
  assert.deepEqual(texts('Taurean Door Systems'), ['All suppliers: freight over $100 needs a look', 'Taurean: expect the price list + 5%']);
});

test('Export everything: one zip with every invoice (paid or not, which job), lines, jobs, rules and the original files', async () => {
  JOBS['ex-job'] = { jobNumber: '208700', jobTitle: '7 Export St', quoteAmount: 5000 };
  JOBS['ex-job2'] = { jobNumber: '208701', jobTitle: '8 Export St' };
  const t = await openCard('ex-job', 'acc-ex');
  const t2 = await openCard('ex-job2', 'acc-ex');
  const [aId] = await upload(t, 'ex-door.pdf'); const a = { id: aId };
  await api(t, `/invoices/${a.id}`, { method: 'PATCH', json: { paid: true } });
  const m = repo.createInvoice({ accountUUID: 'acc-ex', source: 'upload' });
  repo.saveExtraction(m.id, { supplier_name: 'Merlin, "Motors"', invoice_number: 'M-700', total: 1100, tax: 100, subtotal: 1000, items: [{ description: 'Opener', quantity: 10, line_total: 1000, category: 'materials' }] });
  repo.keepAsStock(m.id);
  const item = repo.db.prepare('SELECT id FROM items WHERE invoice_id = ?').get(m.id).id;
  assert.equal((await api(t2, `/items/${item}/share`, { method: 'PUT', json: { quantity: 3 } })).status, 200);
  await post(t, '/rules', { text: 'Gliderol: expect the price list + 3%', kind: 'always', supplier: 'Gliderol' });

  const res = await fetch(`${base}/api/export?t=${encodeURIComponent(t)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="Job Costs export \d{4}-\d{2}-\d{2}\.zip"/);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  // read it back: every entry's checksum must match
  const files = {};
  const zlib = require('zlib');
  const eocd = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zipBuf.readUInt16LE(eocd + 10);
  let p = zipBuf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zipBuf.readUInt16LE(p + 10), crc = zipBuf.readUInt32LE(p + 16), size = zipBuf.readUInt32LE(p + 20);
    const nameLen = zipBuf.readUInt16LE(p + 28), extra = zipBuf.readUInt16LE(p + 30), comment = zipBuf.readUInt16LE(p + 32), off = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lh = off + 30 + zipBuf.readUInt16LE(off + 26) + zipBuf.readUInt16LE(off + 28);
    const body = zipBuf.slice(lh, lh + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(zlib.crc32(data) >>> 0, crc, name);
    files[name] = data;
    p += 46 + nameLen + extra + comment;
  }
  const names = Object.keys(files);
  for (const n of ['Invoices.csv', 'Invoice lines.csv', 'Jobs.csv', 'Rules.csv', 'Price lists.csv', 'Statement checks.csv', 'READ ME.txt']) assert.ok(names.includes(n), n);
  const invCsv = files['Invoices.csv'].toString('utf8');
  assert.ok(invCsv.startsWith('﻿'), 'opens in Excel with the right characters');
  const door = invCsv.split('\r\n').find((l) => l.includes('Door Supplies Pty Ltd'));
  assert.match(door, /,3000,300,3300,Yes,\d{4}-\d{2}-\d{2},#208700 \(100%\),/, 'amounts, paid, paid date, job');
  const merlin = invCsv.split('\r\n').find((l) => l.includes('M-700'));
  assert.match(merlin, /^\d+,"Merlin, ""Motors""",M-700,/, 'commas and quotes in names are kept');
  assert.match(merlin, /,No,,#208701 \(30%\),Yes,/, 'unpaid, 30% on a job, stock');
  const lines = files['Invoice lines.csv'].toString('utf8');
  assert.match(lines, /Opener,10,,1000,materials,No,#208701,3,300,/);
  assert.match(lines, /Opener,10,,1000,materials,No,,,,,7 /, '7 left in stock');
  assert.match(files['Jobs.csv'].toString('utf8'), /\r\n208700,,7 Export St,[^,]*,,5000,3000,3000,0,2000,40,0,1\r\n/, 'quote, costs, paid, to pay, profit, margin');
  assert.match(files['Rules.csv'].toString('utf8'), /Gliderol: expect the price list \+ 3%,Yes,always,Gliderol/);
  assert.ok(names.some((n) => /^invoices\/Door Supplies Pty Ltd – INV-100[-0-9]* – job 208700\.pdf$/.test(n)), names.join(' | '));
  // another business gets only its own
  const other = await openCard('job-a', 'acc-1');
  const theirs = Buffer.from(await (await fetch(`${base}/api/export?t=${encodeURIComponent(other)}`)).arrayBuffer());
  assert.ok(!theirs.includes(Buffer.from('M-700')) && !theirs.includes(Buffer.from('208700')));
  assert.equal((await fetch(`${base}/api/export`)).status, 401);
});

test('the iPhone app and the Add-ons menu: a job button in the app, and Job Costs home from the menu', async () => {
  const m = await fetch(`${base}/manifest.json`).then((r) => r.json());
  assert.deepEqual(m.actions.map((a) => [a.type, a.entity, a.event]), [['online', 'job', 'job_costs_open'], ['app', 'job', 'job_costs_open']],
    'the picking list is its own add-on now');
  assert.deepEqual(m.menuItems.map((x) => [x.type, x.event]), [['addon', 'job_costs_menu'], ['app', 'job_costs_menu']]);
  await openCard('job-a', 'acc-1'); // the business is known
  // from the menu: no job in the event
  const ev = jwt.sign({ eventName: 'job_costs_menu', eventArgs: {}, auth: { accountUUID: 'acc-1', accessToken: 'x' } }, SECRET);
  const { eventResponse } = await fetch(`${base}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev }).then((r) => r.json());
  const src = eventResponse.match(/<iframe src="([^"]+)"/)[1];
  assert.ok(src.startsWith('http://test/home?t='), src);
  const t = decodeURIComponent(src.split('t=')[1]);
  const page = await fetch(`${base}/home?t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  assert.equal(JSON.parse((await page.text()).match(/const BOOT = (\{.*?\});\n/)[1]).home, true);
  const h = await json(t, '/home');
  for (const k of ['inboxCount', 'toPay', 'unpaidCount', 'stockLeft', 'flagged', 'duplicates']) assert.ok(k in h, k);
  // business-wide pages work; things that need a job say so
  assert.equal((await api(t, '/inbox')).status, 200);
  assert.equal((await api(t, '/bills')).status, 200);
  assert.equal((await api(t, '/stock')).status, 200);
  const nojob = await api(t, '/job');
  assert.equal(nojob.status, 400);
  assert.match((await nojob.json()).error, /Open Job Costs from a job/);
  assert.equal((await api(t, '/invoices/1', { method: 'DELETE' })).status, 400);
  const inbox = await fetch(`${base}/inbox?t=${encodeURIComponent(t)}`);
  assert.equal(JSON.parse((await inbox.text()).match(/const BOOT = (\{.*?\});\n/)[1]).home, true, '"Back" goes to the home page');
  // open a job by its number
  const r = await json(t, '/jobs/find?number=208101');
  assert.equal(jwt.decode(r.token).jobUUID, 'job-a');
  assert.equal((await api(t, '/jobs/find?number=999999')).status, 404);
  assert.equal((await fetch(`${base}/card?t=${encodeURIComponent(r.token)}`)).status, 200);
  // a business token from another business's menu sees only its own
  const ev2 = jwt.sign({ eventName: 'job_costs_menu', eventArgs: {}, auth: { accountUUID: 'acc-other', accessToken: 'x' } }, SECRET);
  const src2 = (await fetch(`${base}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev2 }).then((x) => x.json())).eventResponse.match(/<iframe src="([^"]+)"/)[1];
  const t2 = decodeURIComponent(src2.split('t=')[1]);
  const other = await json(t2, '/bills');
  assert.deepEqual(other.bills, [], 'no bills of the first business');
  assert.equal((await json(t2, '/home')).unpaidCount, 0);
});

test('settings per business: your own setup is kept; stock words, email hours and the business type', async () => {
  // a business that was already using Job Costs keeps how it worked (Door Image / Internal, Melbourne, Mon–Fri 6–6)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-settings-'));
  const old = openDb(dir);
  old.ensureAccount('acc-old');
  old.db.exec('DROP TABLE account_settings');
  old.db.close();
  const again = openDb(dir);
  const st = again.getSettings('acc-old');
  assert.deepEqual([st.stock_clients, st.stock_categories, st.timezone, st.check_from, st.check_to, st.business_type],
    [['door image'], ['internal'], 'Australia/Melbourne', 6, 18, 'garage door installation business']);
  again.ensureAccount('acc-new');
  assert.equal(again.getSettings('acc-new').business_type, 'trades business', 'a new business starts neutral');
  again.db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // the Settings page
  JOBS['set-job'] = { jobNumber: '208800', jobTitle: '8 Set St', clientName: 'Our Warehouse', categoryName: 'Supply' };
  const t = await openCard('set-job', 'acc-set');
  assert.equal(repo.getJob('set-job').is_stock, false);
  assert.equal((await fetch(`${base}/settings?t=${encodeURIComponent(t)}`)).status, 200);
  const g = await json(t, '/settings');
  assert.equal(g.settings.diary_summary, false, 'the diary summary is off until switched on');
  const put = (body) => api(t, '/settings', { method: 'PUT', json: body });
  assert.equal((await put({ check_from: 18, check_to: 6 })).status, 400, 'hours the wrong way round');
  assert.equal((await put({ timezone: 'Mars/Base' })).status, 400);
  const r = await put({ business_name: 'Smith Doors', business_type: 'roller door business', stock_clients: 'Our Warehouse, Stock', check_days: ['sat', 'xyz'],
    check_from: 7, check_to: 15, timezone: 'Australia/Perth' }).then((x) => x.json());
  assert.deepEqual([r.settings.stock_clients, r.settings.check_days, r.settings.timezone], [['our warehouse', 'stock'], ['sat'], 'Australia/Perth']);
  assert.equal(repo.getJob('set-job').is_stock, true, 'jobs are sorted again with the new words');
  // automatic email checks only in each business's hours
  const { inCheckingHours } = require('../src/outlook');
  const sat10perth = new Date('2026-11-14T02:00:00Z'); // Saturday 10am in Perth
  const mon10perth = new Date('2026-11-16T02:00:00Z');
  const hours = { outlookTimezone: 'Australia/Perth', outlookDays: ['sat'], outlookFromHour: 7, outlookToHour: 15 };
  assert.equal(inCheckingHours(hours, sat10perth), true);
  assert.equal(inCheckingHours(hours, mon10perth), false);
  assert.match((await json(t, '/inbox')).outlookHours, /Sat 7am–3pm/);
});

test('diary summary: one note per job in ServiceM8, kept up to date, only when switched on', async () => {
  JOBS['sum-job'] = { jobNumber: '208900', jobTitle: '9 Summary St', quoteAmount: 5000, status: 'Work Order' };
  const t = await openCard('sum-job', 'acc-sum');
  const updates = [];
  fakeDiary.updateJobNote = async (uuid, { text }) => {
    updates.push(uuid);
    if (fakeDiary.refuseUpdate) throw new Error('ServiceM8 said 403');
    const n = diary.notes.find((x) => x.uuid === uuid); n.text = text; return uuid;
  };
  const mine = () => diary.notes.filter((n) => n.job_uuid === 'sum-job');
  const [id] = await upload(t, 'sum-door.pdf'); // $3,000 ex GST
  await app.locals.summaryPass();
  assert.equal(mine().length, 0, 'off by default: nothing in the diary');
  // switched on: the job gets its summary
  assert.equal((await api(t, '/settings', { method: 'PUT', json: { diary_summary: true } })).status, 200);
  await app.locals.summaryPass();
  assert.equal(mine().length, 1);
  const text = mine()[0].text;
  assert.match(text, /^Job Costs summary \(updated .+\)\nCosts: \$3,000\.00 ex GST from 1 bill\nPaid: \$0\.00 · Still to pay: \$3,000\.00\nQuoted: \$5,000\.00 ex GST · Profit so far: \$2,000\.00 \(40%\)$/, text);
  // marked paid: the same note is changed, not a new one
  await api(t, `/invoices/${id}`, { method: 'PATCH', json: { paid: true } });
  await app.locals.summaryPass();
  assert.equal(mine().length, 1);
  assert.match(mine()[0].text, /Paid: \$3,000\.00 · Still to pay: \$0\.00/);
  assert.equal(updates.length, 1);
  // nothing changed: ServiceM8 isn't touched
  repo.markSummaryDirty(['sum-job']);
  await app.locals.summaryPass();
  assert.equal(updates.length, 1, 'only the time would differ: left alone');
  // the note can't be changed (e.g. deleted in ServiceM8): a fresh one replaces it
  fakeDiary.refuseUpdate = true;
  await api(t, '/job', { method: 'PATCH', json: { quote_amount: 6000 } });
  await app.locals.summaryPass();
  assert.equal(mine().length, 1);
  assert.match(mine()[0].text, /Quoted: \$6,000\.00 ex GST · Profit so far: \$3,000\.00 \(50%\)/);
  fakeDiary.refuseUpdate = false;
  // switched off: no more changes
  await api(t, '/settings', { method: 'PUT', json: { diary_summary: false } });
  await api(t, `/invoices/${id}`, { method: 'PATCH', json: { paid: false } });
  await app.locals.summaryPass();
  assert.match(mine()[0].text, /Still to pay: \$0\.00/);
});

test('usage per business: each Claude request is counted, with tokens and an estimated cost', async () => {
  JOBS['use-job'] = { jobNumber: '208950', jobTitle: '5 Use St' };
  const t = await openCard('use-job', 'acc-use');
  await upload(t, 'use-a.pdf', 'use-b.pdf');
  assert.equal(repo.usageCount('acc-use', 'invoice_read'), 2, 'every invoice read is counted');
  assert.equal(repo.usageCount('acc-1', 'invoice_read') >= 0, true);
  // the cost of a request, from its tokens: 10,000 in × $4 + 2,000 out × $20 + 100,000 cache reads × $0.20 (per million)
  app.locals.recordUsage('acc-use', 'statement_check', { input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 });
  const [m] = repo.listUsage('acc-use');
  assert.equal(m.kinds.statement_check.count, 1);
  assert.equal(m.kinds.statement_check.cost, 0.1, '0.04 + 0.04 + 0.02');
  assert.equal(m.kinds.statement_check.cache_read_tokens, 100000);
  const s = await json(t, '/settings');
  assert.deepEqual([s.used.invoice_read, s.used.statement_check], [2, 1], 'the business sees its counts (not the cost)');
  assert.ok(!('cost' in s.used));
  // the owner's page needs the key
  assert.equal((await fetch(`${base}/admin/usage`)).status, 404);
  assert.equal((await fetch(`${base}/admin/usage?key=wrong`)).status, 404);
});

test('connect Gmail (or any mailbox) in Settings: checked for invoices, password kept encrypted; the welcome page for new businesses', async () => {
  // a pretend mail server with one invoice email
  const raw = ['From: Supplier <acc@supplier.com>', 'To: me@gmail.com', 'Subject: Invoice 5512', 'Message-ID: <m5512@x>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain', '', 'Please find attached.', '--b1',
    'Content-Type: application/pdf; name="mailbox-invoice.pdf"', 'Content-Disposition: attachment; filename="mailbox-invoice.pdf"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('%PDF-1.4 mailbox invoice').toString('base64'), '--b1--', ''].join('\r\n');
  const logins = [];
  const fakeImap = (conn) => ({
    mailbox: { uidValidity: 7 },
    async connect() { logins.push(conn); if (conn.password !== 'abcdefghijklmnop') throw new Error('Invalid credentials (Failure)'); },
    async logout() {}, async getMailboxLock() { return { release() {} }; },
    async search() { return [41]; }, async fetchOne() { return { source: Buffer.from(raw) }; },
  });
  const appM = createApp({ config, repo, processor, fetchJobImpl, fetchActiveJobsImpl, findJobByNumberImpl, diaryApi: fakeDiary, imapClient: fakeImap });
  const srvM = await new Promise((r) => { const x = appM.listen(0, () => r(x)); });
  const bM = `http://127.0.0.1:${srvM.address().port}`;
  const call = (t, p, o = {}) => fetch(`${bM}/api${p}`, { ...o, headers: { Authorization: `Bearer ${t}`, ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  try {
    JOBS['mb-job'] = { jobNumber: '208960', jobTitle: '6 Mail St' };
    const t = await openCard('mb-job', 'acc-mb');
    // a new business, nothing in it yet: the welcome page is offered
    assert.equal((await call(t, '/home').then((x) => x.json())).welcome, true);
    assert.equal((await fetch(`${bM}/welcome?t=${encodeURIComponent(t)}`)).status, 200);
    let r = await call(t, '/imap', { method: 'POST', json: { email: 'me@gmail.com', password: 'wrong' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /app password/);
    r = await call(t, '/imap', { method: 'POST', json: { email: 'accounts@smithdoors.com.au', password: 'x' } });
    assert.equal(r.status, 400, 'own domain: asks for the mail server');
    assert.equal((await r.json()).needHost, true);
    r = await call(t, '/imap', { method: 'POST', json: { email: 'me@gmail.com', password: 'abcd efgh ijkl mnop' } });
    assert.equal(r.status, 200, 'spaces in the app password are fine');
    assert.equal(logins[logins.length - 1].host, 'imap.gmail.com');
    const stored = repo.getImap('acc-mb');
    assert.ok(!stored.password_enc.includes('abcdefghijklmnop'), 'the password is stored encrypted');
    await new Promise((res) => setTimeout(res, 50)); await processor.idle();
    const mine = () => repo.db.prepare("SELECT * FROM invoices WHERE account_uuid = 'acc-mb' AND source = 'mailbox'").all();
    assert.equal(mine().length, 1, 'the invoice email came in');
    assert.equal(mine()[0].status, 'ready');
    // Check now: nothing twice
    const c = await call(t, '/imap/check', { method: 'POST' }).then((x) => x.json());
    assert.equal(c.found, 0);
    assert.equal(mine().length, 1);
    const st = await call(t, '/settings').then((x) => x.json());
    assert.equal(st.imap.email, 'me@gmail.com');
    assert.ok(!JSON.stringify(st).includes('password_enc'));
    // has an invoice now: no welcome page
    assert.equal((await call(t, '/home').then((x) => x.json())).welcome, false);
    assert.equal((await call(t, '/imap', { method: 'DELETE' })).status, 200);
    assert.equal(repo.getImap('acc-mb'), null);
    // finishing the welcome page
    JOBS['mb-job2'] = { jobNumber: '208961', jobTitle: '7 Mail St' };
    const t2 = await openCard('mb-job2', 'acc-mb2');
    await call(t2, '/settings', { method: 'PUT', json: { onboarded: true } });
    assert.equal((await call(t2, '/job').then((x) => x.json())).welcome, false);
  } finally { srvM.close(); }
});

test('deleting from the Inbox: "ignore it if it comes in again" drops the same bill next time; uploads by hand still come in', async () => {
  JOBS['ign-job'] = { jobNumber: '209200', jobTitle: '2 Ignore St' };
  const t = await openCard('ign-job', 'acc-ign');
  const inboxIds = async () => (await json(t, '/inbox')).invoices.map((i) => i.id);
  assert.equal((await json(t, '/inbox')).askIgnore, true, 'asks by default');
  await email(t, { subject: 'Invoice', file: 'ign-door.pdf' });
  const first = latestInvoice();
  assert.ok((await inboxIds()).includes(first.id));
  // deleted, and ignored from now on
  const del = await api(t, `/inbox/${first.id}?ignore=1`, { method: 'DELETE' }).then((x) => x.json());
  assert.equal(del.ignored, true);
  const ign = (await json(t, '/ignored')).ignored;
  assert.equal(ign.length, 1);
  assert.match(ign[0].label, /^Door Supplies Pty Ltd #INV-100/);
  // the same bill emailed again: not kept
  const before = repo.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE account_uuid = 'acc-ign'").get().n;
  await email(t, { subject: 'Invoice again', file: 'copy-of-ign-door.pdf' });
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE account_uuid = 'acc-ign'").get().n, before, 'dropped quietly');
  // another business isn't affected
  JOBS['ign-job2'] = { jobNumber: '209201', jobTitle: '3 Ignore St' };
  const t2 = await openCard('ign-job2', 'acc-ign2');
  assert.deepEqual((await json(t2, '/ignored')).ignored, []);
  // uploaded by hand: you want it, so it comes in
  const fd = new FormData(); fd.append('files', new Blob(['%PDF-1.4 by hand' + uniq()], { type: 'application/pdf' }), 'copy-of-ign-door.pdf');
  await api(t, '/inbox/upload', { method: 'POST', body: fd }); await processor.idle();
  const byHand = latestInvoice();
  assert.equal(byHand.status, 'ready');
  assert.ok((await inboxIds()).includes(byHand.id));
  await api(t, `/inbox/${byHand.id}`, { method: 'DELETE' }); // deleted without ignoring: nothing more ignored
  assert.equal((await json(t, '/ignored')).ignored.length, 1);
  // stop ignoring: it comes in again
  assert.equal((await api(t, `/ignored/${ign[0].id}`, { method: 'DELETE' })).status, 200);
  await email(t, { subject: 'Invoice once more', file: 'copy-of-ign-door.pdf' });
  assert.ok((await inboxIds()).includes(latestInvoice().id));
  assert.equal((await api(t2, `/ignored/${ign[0].id}`, { method: 'DELETE' })).status, 404);
  // "don't ask me again"
  await api(t, '/settings', { method: 'PUT', json: { ask_ignore_on_delete: false } });
  assert.equal((await json(t, '/inbox')).askIgnore, false);
  assert.equal((await json(t, '/settings')).settings.ask_ignore_on_delete, false);
});

test('ServiceM8 job lines: each line shows the cost that covers it; a line without one is pulled from a stock invoice you choose', async () => {
  const jl = require('../src/joblines');
  // matching by kind of thing
  assert.deepEqual(jl.kindsOf('Sectional door supply & install with Merlin motor'), ['motor', 'door']);
  assert.deepEqual(jl.kindsOf('Post covers x2'), ['post cover']);
  assert.equal(jl.mainKind('Bolt 800N opener for roller door'), 'motor', 'an opener for a door is a motor, not a door');
  const m = jl.matchLines([{ uuid: 'a', name: 'Sectional door supply & install with motor' }], [{ key: '1', description: 'Insulated sectional door 2300x4830' }]);
  assert.deepEqual([m[0].status, m[0].missing_kinds], ['missing', ['motor']], 'a line needs every kind it names');

  JOBS['jl-job'] = { jobNumber: '209300', jobTitle: '3 Lines St', lines: [
    { uuid: 'l1', name: 'Sectional door supply & install', qty: 1, price: 3000 },
    { uuid: 'l2', name: 'Merlin MR850 motor', qty: 1, price: 650 },
    { uuid: 'l3', name: 'Posts', qty: 2, price: 90 },
    { uuid: 'l4', name: 'Post covers', qty: 2, price: 40 },
    { uuid: 'l5', name: 'Labour', qty: 4, price: 95 },
    { uuid: 'l6', name: 'Header flashing', qty: 1, price: 95 }] };
  const t = await openCard('jl-job', 'acc-jl');
  const mk = (sup, num, items) => { const inv = repo.createInvoice({ accountUUID: 'acc-jl', source: 'upload' });
    const sub = items.reduce((a, i) => a + i.line_total, 0);
    repo.saveExtraction(inv.id, { supplier_name: sup, invoice_number: num, subtotal: sub, tax: Math.round(sub * 10) / 100, total: Math.round(sub * 110) / 100, items: items.map((i) => ({ category: 'materials', ...i })) });
    return inv.id; };
  repo.assignWhole(mk('Summit Door Supplies', 'SD-1', [{ description: 'Insulated Sectional Door 2300x4830', quantity: 1, line_total: 2800 }, { description: 'Head flashing 5m', quantity: 1, line_total: 60 }]), 'jl-job', {});
  const opener = mk('Bolt Openers Co', 'BO-1', [{ description: 'Bolt 800N opener', quantity: 10, line_total: 3100 }]); repo.keepAsStock(opener);
  const posts = mk('Coastal Steel', 'CS-1', [{ description: 'Galv posts 100x100 2.4m', quantity: 20, line_total: 900 }]); repo.keepAsStock(posts);
  let s = await json(t, '/job');
  const st = () => Object.fromEntries(s.jobLines.map((l) => [l.uuid, l.status]));
  assert.deepEqual(st(), { l1: 'covered', l2: 'missing', l3: 'missing', l4: 'missing', l6: 'covered' }, 'labour isn’t a thing to cost');
  assert.equal(s.jobLines.find((l) => l.uuid === 'l6').covered_by[0].invoice.invoice_number, 'SD-1');
  // pull the motor from stock: the matching stock comes first
  const opts = (await json(t, '/joblines/stock?kinds=motor')).options;
  assert.deepEqual([opts[0].description, opts[0].match, opts[0].left_quantity, opts[0].unit_cost], ['Bolt 800N opener', true, 10, 310]);
  assert.equal((await post(t, '/joblines/pull', { item_id: opts[0].item_id, qty: 11 })).status, 400, 'only 10 left');
  assert.equal((await post(t, '/joblines/pull', { item_id: opts[0].item_id, qty: 1 })).status, 200);
  s = await json(t, '/job');
  assert.equal(st().l2, 'covered');
  assert.equal(s.jobLines.find((l) => l.uuid === 'l2').covered_by[0].stock, true);
  assert.equal(Math.round(s.totals.total * 100), Math.round((2800 + 60 + 310) * 100), 'its cost is on the job: 1 of 10 openers = $310');
  assert.equal(repo.listStock('acc-jl').stock.find((i) => i.id === opener).lines[0].trace.left_quantity, 9, '9 left in stock');
  // posts: 2 of them
  const p2 = (await json(t, '/joblines/stock?kinds=post')).options.find((o) => o.match);
  await post(t, '/joblines/pull', { item_id: p2.item_id, qty: 2 });
  s = await json(t, '/job');
  assert.equal(st().l3, 'covered');
  assert.equal(st().l4, 'missing', 'posts don’t cover post covers');
  // the customer supplies the post covers: no cost needed (and back)
  await post(t, '/joblines/l4/not-needed', { not_needed: true });
  s = await json(t, '/job');
  assert.equal(st().l4, 'not_needed');
  await post(t, '/joblines/l4/not-needed', { not_needed: false });
  assert.equal(Object.fromEntries((await json(t, '/job')).jobLines.map((l) => [l.uuid, l.status])).l4, 'missing');
  // another business can't pull this business's stock
  JOBS['jl-job2'] = { jobNumber: '209301', jobTitle: '4 Lines St' };
  const t2 = await openCard('jl-job2', 'acc-jl2');
  assert.equal((await post(t2, '/joblines/pull', { item_id: opts[0].item_id, qty: 1 })).status, 404);
  assert.deepEqual((await json(t2, '/joblines/stock')).options, []);
  assert.equal((await json(t2, '/job')).jobLines, null, 'no lines known for that job');
});

test('pick list: built from the job’s invoices, stock and notes, with kits; ticking, adding, the diary note; kits per business', async () => {
  const pl = require('../src/picklist');
  // the job notes: only items with a price count; delivery, labour and the total don't
  const notes = `$3172+GST from fine tuned....\n\nNEW DOOR CALCULATIONS (PLEASE REMOVE ITEMS THAT ARE NOT REQUIRED)\n\nSupplier:ECO insulated \nDoor Type/Colour/Finish:Panel TBA\nH2300\nW4830\n` +
    `Door - $3375+5%+3543.75\nMotor - $650\nPosts - $180\nPost Covers - $\nLabor - $400\nDelivery/Gliderol roller door Steel Wrapping - $75 (A series)/ $134 (AA/B Series)\nFlashing - $95\nTotal - $5000`;
  assert.deepEqual(pl.itemsFromNotes(notes).map((x) => x.label), ['Door', 'Motor', 'Posts', 'Flashing']);
  assert.deepEqual(pl.parsePart('2 x Tracks'), { name: 'Tracks', qty: 2 });
  assert.deepEqual(pl.parsePart('Low headroom kit (if needed)'), { name: 'Low headroom kit (if needed)', optional: true });
  assert.equal(pl.matchKit(pl.DEFAULT_KITS, 'Merlin opener for roller door').name, 'Motor', 'more specific kits are tried first');

  JOBS['pick-job'] = { jobNumber: '209100', jobTitle: '9 Pick St', description: notes };
  const t = await openCard('pick-job', 'acc-pick');
  assert.match(repo.getJob('pick-job').notes, /NEW DOOR CALCULATIONS/, 'the job notes are kept for the pick list');
  // a garage door business gets the starting kits
  await api(t, '/settings', { method: 'PUT', json: { business_type: 'garage door installation business' } });
  // the door is invoiced (with delivery, which isn't picked up); a motor comes from stock
  const door = repo.createInvoice({ accountUUID: 'acc-pick', source: 'upload' });
  repo.saveExtraction(door.id, { supplier_name: 'Summit Door Supplies', invoice_number: 'SD-1', total: 3412, tax: 310.18, subtotal: 3101.82, items: [
    { description: 'Eco Insulated Sectional Door 2300x4830', quantity: 1, line_total: 3001.82, category: 'materials' },
    { description: 'Delivery', line_total: 100, category: 'freight' }] });
  repo.assignWhole(door.id, 'pick-job', {});
  const stock = repo.createInvoice({ accountUUID: 'acc-pick', source: 'upload' });
  repo.saveExtraction(stock.id, { supplier_name: 'Bolt Openers Co', invoice_number: 'BO-9', total: 1100, tax: 100, subtotal: 1000, items: [{ description: 'Bolt 800N opener', quantity: 5, line_total: 1000, category: 'materials' }] });
  repo.keepAsStock(stock.id);
  repo.addShare(repo.db.prepare('SELECT id FROM items WHERE invoice_id = ?').get(stock.id).id, 'pick-job', 0.2, {});
  let p = await json(t, '/picklist');
  const byTitle = Object.fromEntries(p.groups.map((g) => [g.title, g]));
  assert.deepEqual(Object.keys(byTitle), ['Summit Door Supplies', 'Our stock', 'Not on an invoice yet']);
  const d = byTitle['Summit Door Supplies'].items;
  assert.deepEqual(d.map((i) => [i.name, i.kit]), [['Eco Insulated Sectional Door 2300x4830', 'Sectional door']], 'delivery isn’t picked up');
  assert.deepEqual(d[0].parts.map((x) => x.name), ['Door panels', 'Tracks', 'Springs', 'Bar (shaft)', 'Hardware box', 'Back support bar', 'Low headroom kit']);
  assert.equal(d[0].parts[6].optional, true);
  const motor = byTitle['Our stock'].items[0];
  assert.deepEqual([motor.qty, motor.kit, motor.parts.length], [1, 'Motor', 2], '1 of the 5 openers, from stock');
  assert.deepEqual(byTitle['Not on an invoice yet'].items.map((i) => i.name), ['Posts', 'Flashing'], 'door and motor are covered by the invoices');
  assert.deepEqual(p.progress, { picked: 0, total: 6 + 2 + 2 }, 'required parts + items without parts');
  // tick a part, an item, then everything
  let r = await post(t, '/picklist/tick', { key: d[0].parts[0].key, picked: true }).then((x) => x.json());
  assert.equal(r.progress.picked, 1);
  assert.equal((await post(t, '/picklist/tick', { key: 'bad key!' })).status, 400);
  await post(t, '/picklist/all', { picked: true });
  p = await json(t, '/picklist');
  assert.deepEqual(p.progress, { picked: 10, total: 10 });
  assert.equal(p.groups[0].items[0].picked, true);
  assert.equal(p.groups[0].items[0].parts[6].picked, false, 'optional parts aren’t ticked by "everything"');
  // something extra, added by hand
  assert.equal((await post(t, '/picklist/extra', { name: '' })).status, 400);
  const { id: xid } = await post(t, '/picklist/extra', { name: 'Concrete bags', qty: 3 }).then((x) => x.json());
  p = await json(t, '/picklist');
  assert.deepEqual(p.groups.find((g) => g.kind === 'manual').items.map((i) => [i.name, i.qty]), [['Concrete bags', 3]]);
  assert.deepEqual(p.progress, { picked: 10, total: 11 });
  // the diary note says what's missing
  const before = diary.notes.length;
  const dn = await post(t, '/picklist/diary').then((x) => x.json());
  assert.match(dn.text, /^Pick list: 10 of 11 picked up\. Still to get: Concrete bags$/);
  assert.equal(diary.notes.length, before + 1);
  assert.equal((await api(t, `/picklist/extra/${xid}`, { method: 'DELETE' })).status, 200);
  // ticks survive the list being rebuilt (e.g. after an invoice is read again)
  assert.equal((await json(t, '/picklist')).progress.picked, 10);
  // kits: the business's own, editable
  const k = await json(t, '/kits');
  assert.deepEqual(k.kits.map((x) => x.name), ['Motor', 'Sectional door', 'Roller door']);
  assert.equal((await post(t, '/kits', { name: 'Gate', match_words: '' })).status, 400);
  await post(t, '/kits', { id: k.kits[0].id, name: 'Motor', match_words: 'motor, opener', parts: 'Motor\n2 x Remotes\nTrack (chain or belt)' });
  p = await json(t, '/picklist');
  assert.deepEqual(p.groups.find((g) => g.title === 'Our stock').items[0].parts.map((x) => [x.name, x.qty || 1]), [['Motor', 1], ['Remotes', 2], ['Track (chain or belt)', 1]]);
  // another kind of business starts with no kits; another business never sees these
  JOBS['pick-job2'] = { jobNumber: '209101', jobTitle: '1 Other St' };
  const t2 = await openCard('pick-job2', 'acc-pick2');
  assert.deepEqual((await json(t2, '/kits')).kits, []);
  assert.equal((await api(t2, `/kits/${k.kits[1].id}`, { method: 'DELETE' })).status, 404);
  // the "Pick list" button in ServiceM8 opens it
  const ev = jwt.sign({ eventName: 'pick_list_open', eventArgs: { jobUUID: 'pick-job' }, auth: { accountUUID: 'acc-pick', accessToken: 'x' } }, SECRET);
  const { eventResponse } = await fetch(`${base}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev }).then((x) => x.json());
  assert.match(eventResponse, /<iframe src="http:\/\/test\/picklist\?t=/);
  assert.equal((await fetch(`${base}/picklist?t=${encodeURIComponent(t)}`)).status, 200);
  // from the menu (no job) it asks for a job
  const evm = jwt.sign({ eventName: 'job_costs_menu', eventArgs: {}, auth: { accountUUID: 'acc-pick', accessToken: 'x' } }, SECRET);
  const tm = decodeURIComponent((await fetch(`${base}/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: evm }).then((x) => x.json())).eventResponse.match(/<iframe src="[^"]*\?t=([^"]+)"/)[1]);
  assert.equal((await api(tm, '/picklist')).status, 400);
});

test('Picking List Creator: its own ServiceM8 add-on; works from the job’s ServiceM8 lines without Job Costs; links to Job Costs only when both', async () => {
  const appP = createApp({ config: { ...config, pickAppId: 'pick-id', pickAppSecret: 'pick-secret' }, repo, processor, fetchJobImpl, fetchActiveJobsImpl, findJobByNumberImpl, diaryApi: fakeDiary });
  const srvP = await new Promise((r) => { const x = appP.listen(0, () => r(x)); });
  const bP = `http://127.0.0.1:${srvP.address().port}`;
  const call = (t, p, o = {}) => fetch(`${bP}/api${p}`, { ...o, headers: { Authorization: `Bearer ${t}`, ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  try {
    const m = await fetch(`${bP}/pick/manifest.json`).then((r) => r.json());
    assert.equal(m.name, 'Picking List Creator');
    assert.deepEqual(m.actions.map((a) => [a.type, a.event]), [['online', 'pick_list_open'], ['app', 'pick_list_open']]);
    // installing it asks ServiceM8 for its own approval
    const act = await fetch(`${bP}/pick/servicem8/activate`, { redirect: 'manual' });
    assert.equal(act.status, 302);
    assert.match(act.headers.get('location'), /client_id=pick-id/);
    assert.match(act.headers.get('location'), /redirect_uri=http%3A%2F%2Ftest%2Fpick%2Fservicem8%2Foauth%2Fcallback/);
    // a business with only the picking list clicks it on a job
    JOBS['pk-job'] = { jobNumber: '209400', jobTitle: '4 Pick St', description: 'NEW DOOR CALCULATIONS\nDoor - $3000\nPosts - $180\nRemotes - $90', lines: [
      { uuid: 'pl1', name: 'Sectional door supply & install', qty: 1 }, { uuid: 'pl2', name: 'Merlin MR850 motor', qty: 1 },
      { uuid: 'pl3', name: 'Posts', qty: 2 }, { uuid: 'pl4', name: 'Labour', qty: 4 }] };
    const ev = (secret) => jwt.sign({ eventName: 'pick_list_open', eventArgs: { jobUUID: 'pk-job' }, auth: { accountUUID: 'acc-pk', accessToken: 'x' } }, secret);
    const bad = await fetch(`${bP}/pick/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev('wrong') }).then((r) => r.json());
    assert.match(bad.eventResponse, /Could not open Picking List Creator/);
    const { eventResponse } = await fetch(`${bP}/pick/servicem8/addon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev('pick-secret') }).then((r) => r.json());
    const src = eventResponse.match(/<iframe src="([^"]+)"/)[1];
    assert.ok(src.startsWith('http://test/picklist?t='));
    const t = decodeURIComponent(src.split('t=')[1]);
    assert.equal(repo.getSettings('acc-pk').pick_enabled, true);
    const p = await call(t, '/picklist').then((r) => r.json());
    assert.equal(p.jobCosts, false, 'no Job Costs: no link back to it');
    const onJob = p.groups.find((g) => g.kind === 'job');
    assert.deepEqual(onJob.items.map((i) => i.name), ['Sectional door supply & install', 'Merlin MR850 motor', 'Posts'], 'from the job’s lines (labour left out)');
    assert.deepEqual(p.groups.find((g) => g.kind === 'notes').items.map((i) => i.name), ['Remotes'], 'notes add only what the lines don’t have');
    // ticking works the same
    await call(t, '/picklist/tick', { method: 'POST', json: { key: onJob.items[2].key, picked: true } });
    assert.equal((await call(t, '/picklist').then((r) => r.json())).progress.picked, 1);
    // Job Costs shows its picking list link only for businesses that have the picking list
    assert.equal((await call(t, '/job').then((r) => r.json())).pickList, true);
    JOBS['pk-job2'] = { jobNumber: '209401', jobTitle: '5 Pick St' };
    const tj = await openCard('pk-job2', 'acc-jc-only');
    assert.equal((await json(tj, '/job')).pickList, false);
    // and the picking list links back to Job Costs when the business has it
    await upload(tj, 'pk-door.pdf');
    const pj = await json(tj, '/picklist');
    assert.equal(pj.jobCosts, true);
  } finally { srvP.close(); }
});

test('the card, report and inbox page scripts have no syntax errors', () => {
  for (const file of ['card.html', 'report.html', 'inbox.html', 'bills.html', 'checks.html', 'summary.html', 'prices.html', 'stock.html', 'home.html', 'settings.html', 'welcome.html', 'picklist.html', 'kits.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const js = html.split('<script>')[1].split('</script>')[0].replace('/*__BOOT__*/null', '{}');
    assert.doesNotThrow(() => new Function(js), file);
  }
});
