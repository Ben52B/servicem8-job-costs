require('dotenv').config();
const path = require('path');

const bool = (v) => String(v || '').toLowerCase() === 'true';
const list = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  sessionSecret: process.env.SESSION_SECRET || '',
  servicem8AppSecret: process.env.SERVICEM8_APP_SECRET || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  claudeEffort: process.env.CLAUDE_EFFORT || 'medium',
  inboundBaseAddress: (process.env.INBOUND_BASE_ADDRESS || '').trim().toLowerCase(),
  inboundDomain: (process.env.INBOUND_DOMAIN || '').trim().toLowerCase(),
  inboundSecret: process.env.INBOUND_SECRET || '',
  devMode: bool(process.env.DEV_MODE),
  // Stock orders are opened as their own ServiceM8 job. A job counts as a stock order job
  // when its client name or category name contains one of these (comma separated, any case).
  // Each job also has a switch to correct it either way.
  stockJobClients: list(process.env.STOCK_JOB_CLIENTS ?? 'Door Image'),
  stockJobCategories: list(process.env.STOCK_JOB_CATEGORIES ?? 'Internal'),
};

module.exports = config;
