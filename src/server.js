const config = require('./config');
const { openDb } = require('./db');
const { createAnalyzer } = require('./analyzer');
const { createProcessor } = require('./processor');
const { createApp } = require('./app');

if (!config.sessionSecret) {
  console.error('SESSION_SECRET must be set (see .env.example).');
  process.exit(1);
}

const repo = openDb(config.dataDir);
const analyzer = createAnalyzer({ model: config.claudeModel, effort: config.claudeEffort });
const processor = createProcessor({ repo, analyzer });
const app = createApp({ config, repo, processor });

processor.resumeStuck();
app.listen(config.port, () => {
  console.log(`Job Costs listening on :${config.port}`);
  console.log(`ServiceM8 callback URL: ${config.publicUrl}/servicem8/addon`);
  console.log(`Inbound email webhook:  ${config.publicUrl}/inbound/email?key=<INBOUND_SECRET>`);
  if (config.devMode) console.log(`Dev card: http://localhost:${config.port}/dev/job/test-job-1`);
});
