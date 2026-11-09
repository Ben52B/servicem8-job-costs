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
  servicem8Scopes: (process.env.SERVICEM8_SCOPES || 'read_jobs read_customers read_job_materials read_attachments manage_attachments read_job_notes publish_job_notes').trim(),
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
  // Outlook (Microsoft 365): an app registered in Microsoft Entra, so Job Costs can read the inbox (read-only).
  msClientId: (process.env.MS_CLIENT_ID || '').trim(),
  msClientSecret: process.env.MS_CLIENT_SECRET || '',
  msTenantId: (process.env.MS_TENANT_ID || 'organizations').trim(),
  outlookPollSeconds: Number(process.env.OUTLOOK_POLL_SECONDS || 120),
  // When Outlook is checked automatically (the "Check now" button works any time).
  outlookTimezone: (process.env.OUTLOOK_TIMEZONE || 'Australia/Melbourne').trim(),
  outlookDays: (process.env.OUTLOOK_DAYS || 'mon,tue,wed,thu,fri').toLowerCase().split(',').map((d) => d.trim().slice(0, 3)).filter(Boolean),
  outlookFromHour: Number(process.env.OUTLOOK_FROM_HOUR ?? 6),
  outlookToHour: Number(process.env.OUTLOOK_TO_HOUR ?? 18),
  devMode: bool(process.env.DEV_MODE),
  // Stock orders are opened as their own ServiceM8 job. A job counts as a stock order job
  // when its client name or category name contains one of these (comma separated, any case).
  // Each job also has a switch to correct it either way.
  supportEmail: process.env.SUPPORT_EMAIL || null,
  // (kept for older setups; each business now sets these in ⚙ Settings)
  stockJobClients: list(process.env.STOCK_JOB_CLIENTS ?? ''),
  stockJobCategories: list(process.env.STOCK_JOB_CATEGORIES ?? 'stock'),
  // time zone for new businesses until they choose one in ⚙ Settings
  defaultTimezone: (process.env.DEFAULT_TIMEZONE || process.env.OUTLOOK_TIMEZONE || '').trim() || null,
};

module.exports = config;
