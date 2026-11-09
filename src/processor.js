const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Small in-process queue: reads invoices with Claude one or two at a time so a
 * big email with many attachments doesn't fire off dozens of requests at once.
 */
function createProcessor({ repo, analyzer, concurrency = 2, log = console }) {
  const queue = [];
  let running = 0;
  const idleWaiters = [];

  function pump() {
    while (running < concurrency && queue.length) {
      const id = queue.shift();
      running++;
      run(id).finally(() => {
        running--;
        pump();
        if (!running && !queue.length) idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }

  async function run(id) {
    const inv = repo.getInvoice(id);
    if (!inv) return;
    // The same bill already in Job Costs isn't added twice (and a second copy could get paid twice).
    // Only a copy that's new: "Read again" on an invoice already on a job or in stock leaves it where it is.
    const isNew = !inv.kept_as_stock && !(repo.jobsOnInvoice ? repo.jobsOnInvoice(id).length : 0);
    const blocked = (twin) => {
      if (!twin || !isNew) return false;
      if (inv.source === 'outlook') { // the same invoice emailed again: dropped quietly
        log.log?.(`Outlook: "${inv.file_name}" is already in Job Costs (invoice ${twin.id}), not kept`);
        repo.setImportOutcome?.(id, 'duplicate');
        repo.deleteInvoice(id);
      } else repo.blockDuplicate(id, duplicateMessage(twin));
      return true;
    };
    try {
      if (inv.file_path) {
        try {
          const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo.filesDir, inv.file_path))).digest('hex');
          repo.setFileHash(id, hash);
          if (blocked(repo.twinOf({ ...inv, file_hash: hash, supplier: null }))) return; // identical file: no need to read it
        } catch { /* file missing: the read below reports it */ }
      }
      const result = await analyzer.analyzeFile({
        filePath: path.join(repo.filesDir, inv.file_path),
        fileName: inv.file_name,
        mimeType: inv.mime_type,
        context: { emailFrom: inv.email_from, emailSubject: inv.email_subject },
      });
      // A supplier statement (from anywhere): it goes to Statement check, ready to run, not into the costs.
      if (result.document_type === 'statement' && api.onStatement) {
        let check;
        try { check = api.onStatement(inv, result); } catch (e) { log.error(`Statement ${id}: ${e.message}`); return repo.setInvoiceError(id, 'This is a statement. Upload it in 🔎 Statement check.'); }
        repo.setImportOutcome?.(id, 'statement', check && check.id);
        return repo.deleteInvoice(id);
      }
      // From the Outlook inbox: keep only real bills (quotes and other PDFs are dropped quietly).
      if (inv.source === 'outlook' && ['quote', 'statement', 'remittance'].includes(result.document_type)) {
        log.log?.(`Outlook: "${inv.file_name}" is a ${result.document_type}, not kept`);
        repo.setImportOutcome?.(id, result.document_type);
        return repo.deleteInvoice(id);
      }
      // A remittance (payment advice) is not a cost, wherever it came from.
      if (result.document_type === 'remittance') {
        return repo.setInvoiceError(id, 'This is a remittance (a payment advice), not a bill, so it isn\u2019t added as a cost. Delete it.');
      }
      repo.saveExtraction(id, result);
      if (blocked(repo.twinOf(repo.getInvoice(id)))) return;
      // Uploaded on a job: it goes on that job. Emailed: suggest a job for it.
      if (inv.origin_job_uuid) repo.assignToOrigin(id);
      else if (!repo.suggestJob(id) && api.lookupJobs) {
        // A job number on it that Job Costs hasn't seen yet (e.g. a completed job): ask ServiceM8.
        try { if (await api.lookupJobs(id)) repo.suggestJob(id); } catch (e) { log.error(`Job lookup for invoice ${id}: ${e.message}`); }
      }
      // Check its prices against the supplier's / subcontractor's price list (in the background).
      if (api.afterRead) Promise.resolve().then(() => api.afterRead(id)).catch((e) => log.error(`Price check ${id}: ${e.message}`));
    } catch (e) {
      if (inv.source === 'outlook' && /does not look like an invoice/i.test(e.message || '')) {
        log.log?.(`Outlook: "${inv.file_name}" is not an invoice, not kept`);
        repo.setImportOutcome?.(id, 'not_invoice');
        return repo.deleteInvoice(id);
      }
      log.error(`Invoice ${id}: ${e.message}`);
      repo.setInvoiceError(id, friendlyError(e));
    }
  }

  const api = {
    lookupJobs: null, // set by the app: (invoiceId) => found a job?
    onStatement: null, // set by the app: (invoice, what was read) => file it under Statement check
    afterRead: null, // set by the app: (invoiceId) => price check against a matching price list
    enqueue(id) {
      repo.setInvoiceProcessing(id);
      queue.push(id);
      pump();
    },
    resumeStuck() {
      for (const inv of repo.listStuckInvoices()) { queue.push(inv.id); }
      pump();
    },
    idle() {
      return running || queue.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve();
    },
  };
  return api;
}

function duplicateMessage(t) {
  const money = (n) => '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const where = t.jobs.length ? `on job ${t.jobs.map((j) => '#' + (j.job_number || '?')).join(', ')}` : t.in_stock ? 'in stock' : 'in the Inbox';
  const paid = t.paid ? `, already PAID${t.paid_at ? ' ' + new Date(t.paid_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Melbourne' }) : ''}` : '';
  return `Duplicate – not added. ${t.supplier || 'This'} invoice ${t.invoice_number || ''}${t.total != null ? ' (' + money(t.total) + ')' : ''} is already in Job Costs ${where}${paid} (${t.reason}). Delete this copy.`.replace(/\s+/g, ' ');
}

function friendlyError(e) {
  const status = e && e.status;
  if (status === 401) return 'Invoice reading is not set up (check ANTHROPIC_API_KEY).';
  if (/credit balance/i.test(e.message || '')) return 'Your Claude API account is out of credit. Add credit at console.anthropic.com (Billing), then click "Read again".';
  if (status === 429 || status === 529 || status >= 500) return 'Invoice reader is busy right now. Click "Read again" in a minute.';
  return e.message || 'Could not read this invoice.';
}

module.exports = { createProcessor, duplicateMessage };
