const config = require('./config');
const { openDb } = require('./db');
const { createAnalyzer } = require('./analyzer');
const { createProcessor } = require('./processor');
const { createApp } = require('./app');
const { startMailboxPoller } = require('./mailbox');

// An unexpected error somewhere must not take the whole app down (and restart running checks): log it and carry on.
process.on('unhandledRejection', (e) => console.error('Unhandled error (app kept running):', e && e.stack ? e.stack : e));
process.on('uncaughtException', (e) => console.error('Uncaught error (app kept running):', e && e.stack ? e.stack : e));

if (!config.sessionSecret) {
  console.error('SESSION_SECRET must be set (see .env.example).');
  process.exit(1);
}

const repo = openDb(config.dataDir);
const analyzer = createAnalyzer({ model: config.claudeModel, effort: config.claudeEffort });
const processor = createProcessor({ repo, analyzer });
const { createChecker } = require('./checker');
const checker = createChecker({ model: config.claudeModel, effort: 'high', filesDir: repo.filesDir });
const app = createApp({ config, repo, processor, checker });

processor.resumeStuck();
// Copy invoices that are wholly on one job to its ServiceM8 job diary.
app.locals.startDiaryWorker(30);

// Free email-in: check the invoice mailbox every couple of minutes.
if (config.imapUser && config.imapPassword) {
  startMailboxPoller({ config, repo, onMail: (mail) => app.locals.processMail(mail, { fallbackToOnlyAccount: true }) });
  console.log(`Checking mailbox ${config.imapUser} at ${config.imapHost} every ${config.imapPollSeconds}s`);
}
// Outlook (Microsoft 365) inbox, once it's connected from the card.
if (config.msClientId && config.msClientSecret) {
  const tick = () => app.locals.checkOutlook({ scheduled: true }).then((n) => { if (n) console.log(`Outlook: ${n} new email${n === 1 ? '' : 's'} with possible invoices`); })
    .catch((e) => console.error(`Outlook check failed: ${e.message}`));
  // Each business only in its own checking hours (Settings); "Check now" in the app works any time.
  const maybeTick = () => tick();
  setTimeout(maybeTick, 5000);
  setInterval(maybeTick, Math.max(60, config.outlookPollSeconds) * 1000);
}
// Mailboxes businesses connected themselves (Gmail / IMAP), each in its own checking hours.
setInterval(() => app.locals.checkMailboxes({ scheduled: true }).then((n) => { if (n) console.log(`Mailboxes: ${n} new email${n === 1 ? '' : 's'}`); })
  .catch((e) => console.error(`Mailbox check failed: ${e.message}`)), Math.max(60, config.imapPollSeconds || 120) * 1000);
app.listen(config.port, () => {
  console.log(`Job Costs listening on :${config.port}`);
  console.log(`ServiceM8 callback URL: ${config.publicUrl}/servicem8/addon`);
  console.log(`Inbound email webhook:  ${config.publicUrl}/inbound/email?key=<INBOUND_SECRET>`);
  if (config.devMode) console.log(`Dev card: http://localhost:${config.port}/dev/job/test-job-1`);
});
