const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');

const CATEGORIES = ['materials', 'subcontractor', 'labour', 'equipment_hire', 'freight', 'fees', 'other'];

const InvoiceSchema = z.object({
  is_financial_document: z.boolean().describe('False if this is not an invoice, receipt, bill, credit note or similar.'),
  document_type: z.enum(['invoice', 'tax_invoice', 'receipt', 'credit_note', 'quote', 'statement', 'other']),
  supplier_name: z.string().nullable().describe('The business that issued the document (the seller), not the customer.'),
  supplier_abn: z.string().nullable().describe('Supplier ABN / tax number if shown.'),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable().describe('YYYY-MM-DD'),
  due_date: z.string().nullable().describe('YYYY-MM-DD'),
  currency: z.string().nullable().describe('ISO code, e.g. AUD'),
  subtotal: z.number().nullable().describe('Total before tax.'),
  tax: z.number().nullable().describe('GST / VAT / sales tax amount.'),
  total: z.number().nullable().describe('Final amount payable including tax. Negative for credit notes.'),
  payment_status: z.enum(['paid', 'unpaid', 'unknown']).describe('"paid" only if the document clearly shows it was paid in full (receipt, PAID stamp, balance due 0).'),
  items: z.array(z.object({
    description: z.string().describe('Short, clear description of what was bought, e.g. "Sectional garage door 4.8m x 2.1m Monument".'),
    category: z.enum(CATEGORIES),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    unit_price: z.number().nullable(),
    line_total: z.number().describe('Line amount exactly as printed on the document.'),
  })),
  notes: z.string().nullable().describe('Anything the business owner should notice, e.g. "Deposit only - balance to follow", or unreadable parts.'),
});

const SYSTEM_PROMPT = `You read supplier invoices for a trades business (for example garage door installers) so they can track what each job costs.

Extract the document's details exactly as printed. Rules:
- The supplier is the business that issued the document, not the customer it is addressed to.
- List every charged line, including freight, delivery, fees and discounts (discounts as negative amounts). Skip zero-value and heading lines.
- Category guide: physical goods (doors, motors, posts, covers, fixings) = materials; work done by another business = subcontractor; your own staff time = labour; hired tools/machines = equipment_hire; delivery/shipping = freight; card surcharges, admin or disposal fees = fees.
- Use null when a value is not shown. Never invent numbers.
- Dates as YYYY-MM-DD. Australian documents use day/month/year.
- Credit notes: make total and line amounts negative.
- If the file contains several invoices, extract the first one and say so in notes.`;

const SUPPORTED_MIME = {
  'application/pdf': 'document',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
};

function guessMime(fileName, mime) {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  if (SUPPORTED_MIME[m] || m.startsWith('text/')) return m;
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', html: 'text/html', htm: 'text/html' }[ext] || m || 'application/octet-stream';
}

function isSupported(fileName, mime) {
  const m = guessMime(fileName, mime);
  return !!SUPPORTED_MIME[m] || m.startsWith('text/');
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Build the content block for one file. */
function fileToBlock(filePath, fileName, mime) {
  const m = guessMime(fileName, mime);
  const data = fs.readFileSync(filePath);
  if (SUPPORTED_MIME[m] === 'document') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } };
  }
  if (SUPPORTED_MIME[m] === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: m, data: data.toString('base64') } };
  }
  if (m.startsWith('text/')) {
    const text = m === 'text/html' ? htmlToText(data.toString('utf8')) : data.toString('utf8');
    return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text } };
  }
  throw new Error(`Unsupported file type (${m}). Send a PDF or a photo (JPG/PNG).`);
}

function createAnalyzer({ apiKey, model, effort }) {
  const client = new Anthropic(apiKey ? { apiKey } : {});

  /**
   * Read one invoice file and return the structured details.
   * context: optional { emailSubject, emailFrom } to help identify the supplier.
   */
  async function analyzeFile({ filePath, fileName, mimeType, context = {} }) {
    const block = fileToBlock(filePath, fileName, mimeType);
    const hints = [
      fileName ? `File name: ${fileName}` : null,
      context.emailFrom ? `Emailed by: ${context.emailFrom}` : null,
      context.emailSubject ? `Email subject: ${context.emailSubject}` : null,
    ].filter(Boolean).join('\n');

    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      // If the main model ever declines, the API retries on a suitable fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: betaZodOutputFormat(InvoiceSchema) },
      messages: [{
        role: 'user',
        content: [block, { type: 'text', text: `${hints ? hints + '\n\n' : ''}Extract this document's details.` }],
      }],
    });

    if (response.stop_reason === 'refusal') throw new Error('The document could not be read (declined by the model).');
    if (response.stop_reason === 'max_tokens') throw new Error('The document is too long to read in one go.');
    const out = response.parsed_output;
    if (!out) throw new Error('Could not read the invoice details.');
    if (!out.is_financial_document) throw new Error('This does not look like an invoice or receipt.');
    return out;
  }

  return { analyzeFile };
}

module.exports = { createAnalyzer, isSupported, guessMime, htmlToText, InvoiceSchema, CATEGORIES };
