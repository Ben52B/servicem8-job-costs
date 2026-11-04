require('dotenv').config();
const path = require('path');

const bool = (v) => String(v || '').toLowerCase() === 'true';
const list = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

const config = {
  port: Number(process.env.PORT || 3000),
  // On Render, RENDER_EXTERNAL_URL is set automatically to the app's https address.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  sessionSecret: process.env.SESSION_SECRET || '',
  servicem8AppSecret: process.env.SERVICEM8_APP_SECRET || '',
  servicem8AppId: (process.env.SERVICEM8_APP_ID || '').trim(),
  // What the add-on may read in ServiceM8 (asked for once, when it's installed).
  servicem8Scopes: (process.env.SERVICEM8_SCOPES || 'read_jobs read_customers read_job_materials manage_attachments').trim(),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  claudeEffort: process.env.CLAUDE_EFFORT || 'medium',
  inboundBaseAddress: (process.env.INBOUND_BASE_ADDRESS || '').trim().toLowerCase(),
  inboundDomain: (process.env.INBOUND_DOMAIN || '').trim().toLowerCase(),
  inboundSecret: process.env.INBOUND_SECRET || '',
  // Free email-in: a normal mailbox the app checks over IMAP (your own domain, or Gmail).
  imapHost: (process.env.IMAP_HOST || 'imap.gmail.com').trim(),
  imapPort: Number(process.env.IMAP_PORT || 993),
  imapUser: (process.env.IMAP_USER || '').trim(),
  imapPassword: process.env.IMAP_PASSWORD || '',
  imapPollSeconds: Number(process.env.IMAP_POLL_SECONDS || 120),
  // The address suppliers send to (defaults to the mailbox login).
  imapAddress: (process.env.INVOICE_EMAIL || process.env.IMAP_USER || '').trim().toLowerCase(),
  devMode: bool(process.env.DEV_MODE),
  // Stock orders are opened as their own ServiceM8 job. A job counts as a stock order job
  // when its client name or category name contains one of these (comma separated, any case).
  // Each job also has a switch to correct it either way.
  stockJobClients: list(process.env.STOCK_JOB_CLIENTS ?? 'Door Image'),
  stockJobCategories: list(process.env.STOCK_JOB_CATEGORIES ?? 'Internal'),
};

module.exports = config;
