/**
 * Statement check: Claude reads a supplier statement, then reviews every invoice on it
 * against the supplier's price list, the business's own rules and the ServiceM8 job.
 */
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { fileToBlock } = require('./analyzer');

const StatementSchema = z.object({
  supplier_name: z.string().nullable().describe('The business that sent the statement.'),
  account_number: z.string().nullable(),
  statement_date: z.string().nullable().describe('YYYY-MM-DD'),
  total_due: z.number().nullable(),
  lines: z.array(z.object({
    date: z.string().nullable().describe('YYYY-MM-DD. Australian statements use day/month/year.'),
    reference: z.string().describe('The invoice / credit number exactly as printed, e.g. "S667642".'),
    type: z.enum(['invoice', 'credit', 'payment', 'other']),
    amount: z.number().describe('Amount including GST, as printed. Credits and payments negative.'),
  })).describe('Every transaction line, once (statements often repeat the lines on a tear-off remittance slip: list them only once).'),
});

const ReviewSchema = z.object({
  summary: z.string().describe('The bottom line in 1–3 sentences: is the statement OK to pay, and what needs doing first.'),
  price_list_notes: z.string().nullable().describe('Anything about the price list itself, e.g. it looks out of date (most prices x% higher), or items not on it.'),
  invoices: z.array(z.object({
    reference: z.string().describe('The invoice number exactly as on the statement.'),
    verdict: z.enum(['ok', 'check', 'problem', 'missing']).describe('ok = matches; check = worth a look; problem = wrong / needs action before paying; missing = no invoice to check.'),
    headline: z.string().describe('One short line, e.g. "AA roller 2100×4840 Monument – $1,226 as quoted".'),
    price: z.string().describe('Price check against the price list and the rules, with the figures. Say "no price list" if none fits.'),
    job: z.string().describe('Check against the ServiceM8 job: right job, size, colour, type, quoted price, job status.'),
    rules_applied: z.array(z.string()).describe('The rules (quoted briefly) that affected this invoice. Empty if none.'),
    difference_ex_gst: z.number().nullable().describe('Invoiced minus expected, ex GST (positive = charged more than expected). null if unknown.'),
  })),
  actions: z.array(z.string()).describe('What to do before paying, most important first. Empty if nothing.'),
});

const REVIEW_PROMPT = `You check a supplier's monthly statement for a garage door installation business before it's paid.
For every invoice on the statement you get the invoice itself (the PDF where available, plus the lines already read from it),
the ServiceM8 job(s) it was assigned to (client, address, status and the job notes, which usually hold a "NEW DOOR CALCULATIONS"
section with height H, width W, door type/colour and the door price quoted), the supplier's price list(s), and the business's rules.

How to check:
- RULES COME FIRST. The business's rules are agreements with suppliers (e.g. "job 207xxx: supplier bills 1 door only",
  "job 207xxx: 20% off the price list"). Apply every rule that fits, and say which rules you used for each invoice.
- Price: find the matching price in the price list. Door prices are grids by size band (height rows × width columns, in mm),
  series (A / AA / B rollers; Essential / Native / Platinum sectionals) and finish/colour range; parts and extras have their own
  tables and discounts. Read invoice sizes as HEIGHT x WIDTH (e.g. 2100X4840 = 2100 high, 4840 wide). Compare ex GST.
- If most items are higher than the list by about the same percentage, the price list is probably older than the invoices
  (a yearly price rise): say so once in price_list_notes, judge each item against the list plus that rise, and don't flag
  each one as a problem.
- Job: check the invoice's order/reference number is the job, and that size, colour and type match the job notes and the
  quoted door price. Flag jobs that are Unsuccessful or point elsewhere (e.g. "invoiced through job 206594"),
  missing measurements, a different size, or costs not in the quote.
- A job with "suggested": true is the job number printed on the invoice; the invoice is still waiting in the Inbox to be
  approved onto it. Check against that job, and add "approve it onto job N in the Inbox" to the actions.
- ServiceM8 badges on the job: a "Paid Supplier" (or "partly paid") badge means the office already marked the supplier as
  paid for that job. If the invoice is on the statement as still owing, flag it (verdict at least "check"): possible double
  payment, or the badge is wrong. Say so in the job check and add it to the actions.
- MONEY: "money_checks" was worked out in code. Use its totals exactly as given; never add amounts up yourself.
  Any amount mismatch or invoice that doesn't add up is at least "check", and goes in the actions.
- Invoices marked as not found in Job Costs: verdict "missing".
- Be specific and short. Always write job numbers as "job 207651" and use invoice numbers exactly as printed (e.g. S667642),
  so they can be turned into links. Amounts in AUD; say ex or inc GST.`;

const InvoiceReviewSchema = z.object({
  verdict: z.enum(['ok', 'check', 'problem', 'no_match']).describe('ok = priced as the list (and rules) say; check = worth a look; problem = charged more than it should be; no_match = nothing on this invoice is on the price list.'),
  headline: z.string().describe('One short line, e.g. "All 2 lines match the price list" or "Door $41 above the list".'),
  lines: z.array(z.object({
    description: z.string(),
    invoiced_ex_gst: z.number().nullable(),
    expected_ex_gst: z.number().nullable().describe('What the price list (and any rule) says it should cost, ex GST. null if not on the list.'),
    note: z.string().describe('Which price-list entry / size band / rule you used, or why it differs.'),
  })),
  difference_ex_gst: z.number().nullable().describe('Total invoiced minus total expected, ex GST, for the lines you could price. Positive = charged more.'),
  rules_applied: z.array(z.string()),
});

const INVOICE_PROMPT = `You check one supplier or subcontractor invoice against their price list, for a garage door installation business.
- RULES COME FIRST: apply every rule of the business that fits this invoice (agreed discounts, "bill 1 door only", etc.) and list them.
- Price lists differ: some show list prices with a discount to apply, some show net prices; door prices are grids by size band
  (height × width) and range/colour; installers may price per door, per hour or per extra. Read the price list's own notes.
  Read invoice door sizes as HEIGHT x WIDTH. Compare ex GST.
- Freight/delivery, packaging and extras count too, if the price list has them.
- If most lines are higher by the same percentage, the price list is probably older than the invoice: say so in the headline.
- "money_checks" was worked out in code. Use its figures as given; never add amounts up yourself.
- Be specific and short. Write job numbers as "job 207651".`;

function createChecker({ apiKey, model = 'claude-opus-5-5', effort = 'high', filesDir }) {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  const common = { model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

  async function readStatement({ filePath, fileName, mimeType }) {
    const response = await client.beta.messages.parse({
      ...common,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: betaZodOutputFormat(StatementSchema) },
      messages: [{ role: 'user', content: [fileToBlock(filePath, fileName, mimeType), { type: 'text', text: 'Read this supplier statement.' }] }],
    });
    if (response.stop_reason === 'refusal') throw new Error('The statement could not be read (declined by the model).');
    if (!response.parsed_output) throw new Error('Could not read the statement.');
    return response.parsed_output;
  }

  /**
   * data: { statement, lines: [{ reference, date, amount, invoice: {...} | null, jobs: [...] }], rules: [text], instructions }
   * files: { priceLists: [{ supplier, name, file_path, mime_type }], invoices: [{ reference, file_path, file_name, mime_type }] }
   */
  async function review(data, { priceLists = [], invoiceFiles = [] } = {}) {
    const content = [];
    for (const p of priceLists) {
      content.push({ type: 'text', text: `PRICE LIST – ${p.supplier}${p.name ? ` (${p.name})` : ''}:` });
      content.push(fileToBlock(path.join(filesDir, p.file_path), p.name || 'price-list.pdf', p.mime_type));
    }
    for (const f of invoiceFiles) {
      content.push({ type: 'text', text: `INVOICE ${f.reference} (the supplier's document):` });
      content.push(fileToBlock(path.join(filesDir, f.file_path), f.file_name, f.mime_type));
    }
    content.push({ type: 'text', text: `THE CHECK (JSON):\n${JSON.stringify(data, null, 1)}\n\nReview every invoice line on the statement (one entry per reference).` });
    const stream = client.beta.messages.stream({
      ...common,
      max_tokens: 64000,
      system: REVIEW_PROMPT,
      output_config: { effort, format: betaZodOutputFormat(ReviewSchema) },
      messages: [{ role: 'user', content }],
    }, { timeout: 9 * 60 * 1000, maxRetries: 1 }); // never hangs: at most ~18 minutes, then it says so
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('The check could not be done (declined by the model).');
    if (message.stop_reason === 'max_tokens') throw new Error('The statement is too long to check in one go. Narrow the dates and try again.');
    if (!message.parsed_output) throw new Error('The check came back incomplete. Try again.');
    return message.parsed_output;
  }

  /**
   * One invoice against its price list, as it arrives. data: { invoice, rules, job, money_checks }.
   * The price list goes first and is cached, so a batch of invoices from one supplier reuses it.
   */
  async function reviewInvoice(data, { priceList, invoiceFile }) {
    const plBlock = fileToBlock(path.join(filesDir, priceList.file_path), priceList.name || 'price-list.pdf', priceList.mime_type);
    const content = [
      { type: 'text', text: `PRICE LIST – ${priceList.supplier}${priceList.name ? ` (${priceList.name})` : ''}:` },
      { ...plBlock, cache_control: { type: 'ephemeral' } },
    ];
    if (invoiceFile) {
      content.push({ type: 'text', text: 'THE INVOICE (the supplier\u2019s document):' });
      content.push(fileToBlock(path.join(filesDir, invoiceFile.file_path), invoiceFile.file_name, invoiceFile.mime_type));
    }
    content.push({ type: 'text', text: `THE CHECK (JSON):\n${JSON.stringify(data, null, 1)}\n\nCheck every charged line of this invoice against the price list.` });
    const stream = client.beta.messages.stream({
      ...common,
      max_tokens: 32000,
      system: INVOICE_PROMPT,
      output_config: { effort: 'medium', format: betaZodOutputFormat(InvoiceReviewSchema) },
      messages: [{ role: 'user', content }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('The price check could not be done (declined by the model).');
    if (!message.parsed_output) throw new Error('The price check came back incomplete.');
    return message.parsed_output;
  }

  return { readStatement, review, reviewInvoice };
}

module.exports = { createChecker, StatementSchema, ReviewSchema };
