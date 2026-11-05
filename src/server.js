const config = require('./config');
const { openDb } = require('./db');
const { createAnalyzer } = require('./analyzer');
const { createProcessor } = require('./processor');
const { createApp } = require('./app');
const { startMailboxPoller } = require('./mailbox');

if (!config.sessionSecret) {
  console.error('SESSION_SECRET must be set (see .env.example).');
  process.exit(1);
}

const repo = openDb(config.dataDir);
const analyzer = createAnalyzer({ model: config.claudeModel, effort: config.claudeEffort });
const processor = createProcessor({ repo, analyzer });
const app = createApp({ config, repo, processor });

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
  const tick = () => app.locals.checkOutlook().then((n) => { if (n) console.log(`Outlook: ${n} new email${n === 1 ? '' : 's'} with possible invoices`); })
    .catch((e) => console.error(`Outlook check failed: ${e.message}`));
  const { inCheckingHours } = require('./outlook');
  // Only in working hours (Mon–Fri 6am–6pm by default); "Check now" in the app works any time.
  const maybeTick = () => { if (inCheckingHours(config)) tick(); };
  setTimeout(maybeTick, 5000);
  setInterval(maybeTick, Math.max(60, config.outlookPollSeconds) * 1000);
}
app.listen(config.port, () => {
  console.log(`Job Costs listening on :${config.port}`);
  console.log(`ServiceM8 callback URL: ${config.publicUrl}/servicem8/addon`);
  console.log(`Inbound email webhook:  ${config.publicUrl}/inbound/email?key=<INBOUND_SECRET>`);
  if (config.devMode) console.log(`Dev card: http://localhost:${config.port}/dev/job/test-job-1`);
});
