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
      repo.saveExtraction(id, result);
    } catch (e) {
      log.error(`Invoice ${id}: ${e.message}`);
      repo.setInvoiceError(id, friendlyError(e));
    }
  }

  return {
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
}

function friendlyError(e) {
  const status = e && e.status;
  if (status === 401) return 'Invoice reading is not set up (check ANTHROPIC_API_KEY).';
  if (status === 429 || status === 529 || status >= 500) return 'Invoice reader is busy right now. Click "Read again" in a minute.';
  return e.message || 'Could not read this invoice.';
}

module.exports = { createProcessor };
