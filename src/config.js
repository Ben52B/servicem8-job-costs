require('dotenv').config();
const path = require('path');

const bool = (v) => String(v || '').toLowerCase() === 'true';

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
};

module.exports = config;
