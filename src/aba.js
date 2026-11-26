/**
 * Australian bank payment file (ABA / "Cemtex" direct entry), the file Westpac, ANZ and the other banks import
 * for paying several people at once. Each record is exactly 120 characters, lines end with CRLF.
 * The file only pays once it's uploaded to the bank and approved there (with the bank's own security).
 */

// Characters the banks accept (BECS character set); anything else becomes a space.
const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9 &'()*+,\-./\\]/g, ' ').replace(/\s+/g, ' ').trim();
const left = (s, n) => clean(s).slice(0, n).padEnd(n, ' ');
const rightZero = (n, len) => String(n).padStart(len, '0').slice(-len);
const rightSpace = (s, len) => String(s).slice(-len).padStart(len, ' ');

/** "033123", "033-123", "033 123" → "033-123", or null if it isn't 6 digits. */
function normBsb(bsb) {
  const d = String(bsb ?? '').replace(/\D/g, '');
  return d.length === 6 ? `${d.slice(0, 3)}-${d.slice(3)}` : null;
}
/** Account numbers: digits (and a dash some banks print) – 5 to 9 digits. */
function normAccount(acc) {
  const d = String(acc ?? '').replace(/[\s-]/g, '');
  return /^\d{5,9}$/.test(d) ? d : null;
}
/** Amount in dollars → whole cents (rounded to the cent). */
const toCents = (amount) => Math.round(Number(amount) * 100);

/**
 * The reference the supplier sees: the business's template, e.g. "INV {invoice} PO {job}", with the invoice number
 * exactly as printed (leading zeros kept). maxLength (the bank file's 18): spaces go first, then the job number,
 * never the invoice number's digits.
 */
function makeReference(template, { invoice = '', job = '' } = {}, maxLength = Infinity) {
  // several jobs (an invoice split between them): "208118/208163", or just the first when that's too long
  const jobs = String(job || '').trim().split(/[\/,\s]+/).filter(Boolean);
  if (jobs.length > 1) {
    const all = makeReference(template, { invoice, job: jobs.join('-') }, Infinity).replace(jobs.join('-'), jobs.join('/'));
    if (all.length <= maxLength) return all;
    return makeReference(template, { invoice, job: jobs[0] }, maxLength);
  }
  const inv = clean(invoice).replace(/^inv(oice)?[\s#:.\-]*/i, '').replace(/\s+/g, '');
  job = String(job || '').trim().split(/[\/,\s]+/)[0]; // on two jobs: the first
  const fill = (i) => clean(String(template || 'INV {invoice} PO {job}').replace(/\{invoice\}/gi, i).replace(/\{job\}/gi, clean(job).replace(/\s+/g, '')))
    .replace(/\bPO\s*$/i, '').replace(/\bINV\s*(?=PO\b|$)/i, '').trim();
  let r = fill(inv);
  if (r.length <= maxLength) return r;
  r = r.replace(/\b(INV|PO)\s+/gi, '$1');
  if (r.length <= maxLength) return r;
  // still too long: the job number goes (the invoice number is what the supplier matches the payment to)
  r = clean(String(template || 'INV {invoice}').replace(/\{invoice\}/gi, inv).replace(/\s*\bPO\s*\{job\}/gi, '').replace(/\{job\}/gi, '')).replace(/\b(INV)\s+/gi, '$1');
  return r.slice(0, maxLength);
}

/**
 * payer: { bank: 'WBC' | 'ANZ' | …, bsb, account, name (account name), apcaId (Direct Entry user ID), remitter (shown to the supplier),
 *          description, balance (add the debit line some banks want) }
 * lines: [{ bsb, account, name, amountCents, reference }]
 * date: Date of processing
 */
function buildAba({ payer, lines, date = new Date() }) {
  const pBsb = normBsb(payer.bsb); const pAcc = normAccount(payer.account);
  if (!pBsb || !pAcc) throw new Error('Your BSB and account number (in Settings → Paying suppliers) aren’t complete');
  if (!/^\d{6}$/.test(String(payer.apcaId || '').trim())) throw new Error('Your bank’s Direct Entry user ID (6 digits, in Settings → Paying suppliers) is missing');
  if (!lines.length) throw new Error('Nothing to pay');
  const dd = String(date.getDate()).padStart(2, '0'); const mm = String(date.getMonth() + 1).padStart(2, '0'); const yy = String(date.getFullYear()).slice(-2);
  const out = [];
  out.push(('0' + ' '.repeat(17) + '01' + left(payer.bank || 'WBC', 3) + ' '.repeat(7) + left(payer.name, 26) + rightZero(String(payer.apcaId).trim(), 6)
    + left(payer.description || 'CREDITORS', 12) + dd + mm + yy + ' '.repeat(40)));
  let credit = 0;
  const detail = (bsb, acc, code, cents, name, ref) => '1' + bsb + rightSpace(acc, 9) + ' ' + code + rightZero(cents, 10) + left(name, 32) + left(ref, 18)
    + pBsb + rightSpace(pAcc, 9) + left(payer.remitter || payer.name, 16) + '00000000';
  for (const l of lines) {
    const bsb = normBsb(l.bsb); const acc = normAccount(l.account);
    if (!bsb || !acc) throw new Error(`Bank details for ${l.name || 'a supplier'} aren’t complete`);
    if (!Number.isInteger(l.amountCents) || l.amountCents <= 0) throw new Error(`The amount for ${l.name || 'a supplier'} isn’t right`);
    credit += l.amountCents;
    out.push(detail(bsb, acc, '50', l.amountCents, l.name, l.reference));
  }
  let debit = 0;
  if (payer.balance) { debit = credit; out.push(detail(pBsb, pAcc, '13', credit, payer.name, payer.description || 'CREDITORS')); }
  const count = out.length - 1;
  out.push('7' + '999-999' + ' '.repeat(12) + rightZero(Math.abs(credit - debit), 10) + rightZero(credit, 10) + rightZero(debit, 10) + ' '.repeat(24) + rightZero(count, 6) + ' '.repeat(40));
  for (const r of out) if (r.length !== 120) throw new Error(`Bank file line is ${r.length} characters, not 120`);
  return out.join('\r\n') + '\r\n';
}

module.exports = { buildAba, makeReference, normBsb, normAccount, toCents, clean };
