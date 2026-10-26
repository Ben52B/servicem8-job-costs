// Read one invoice file with Claude and print what was extracted.
// Usage: ANTHROPIC_API_KEY=... node scripts/try-invoice.js path/to/invoice.pdf
const path = require('path');
const config = require('../src/config');
const { createAnalyzer } = require('../src/analyzer');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/try-invoice.js <invoice.pdf|jpg|png>'); process.exit(1); }
createAnalyzer({ model: config.claudeModel, effort: config.claudeEffort })
  .analyzeFile({ filePath: file, fileName: path.basename(file) })
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
