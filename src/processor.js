const path = require('path');

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
    try {
      const result = await analyzer.analyzeFile({
        filePath: path.join(repo.filesDir, inv.file_path),
        fileName: inv.file_name,
        mimeType: inv.mime_type,
        context: { emailFrom: inv.email_from, emailSubject: inv.email_subject },
      });
      // A supplier statement (from anywhere): it goes to Statement check, ready to run, not into the costs.
      if (result.document_type === 'statement' && api.onStatement) {
        try { api.onStatement(inv, result); } catch (e) { log.error(`Statement ${id}: ${e.message}`); return repo.setInvoiceError(id, 'This is a statement. Upload it in 🔎 Statement check.'); }
        repo.setImportOutcome?.(id, 'statement');
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

function friendlyError(e) {
  const status = e && e.status;
  if (status === 401) return 'Invoice reading is not set up (check ANTHROPIC_API_KEY).';
  if (/credit balance/i.test(e.message || '')) return 'Your Claude API account is out of credit. Add credit at console.anthropic.com (Billing), then click "Read again".';
  if (status === 429 || status === 529 || status >= 500) return 'Invoice reader is busy right now. Click "Read again" in a minute.';
  return e.message || 'Could not read this invoice.';
}

module.exports = { createProcessor };
