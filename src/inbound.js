/**
 * Inbound email support. Each job has a short code; mail sent to an address that
 * contains the code is filed against that job:
 *   - plus addressing:  anything+<code>@inbound.postmarkapp.com  (no domain needed)
 *   - own domain:       job-<code>@<INBOUND_DOMAIN>
 * Works with Postmark (JSON webhook), SendGrid Inbound Parse and Mailgun routes (multipart).
 */

function inboxAddress(code, { inboundBaseAddress, inboundDomain }) {
  if (inboundBaseAddress && inboundBaseAddress.includes('@')) {
    const [local, domain] = inboundBaseAddress.split('@');
    return `${local.split('+')[0]}+${code}@${domain}`;
  }
  if (inboundDomain) return `job-${code}@${inboundDomain}`;
  return null;
}

/** Pull every email address out of a header-ish string or array. */
function addressesIn(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(addressesIn);
  if (typeof value === 'object') return addressesIn(value.Email || value.email || value.address || '');
  return (String(value).match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map((a) => a.toLowerCase());
}

/** Find the job codes in a list of recipient addresses. */
function codesFromAddresses(addresses) {
  const codes = new Set();
  for (const addr of addresses) {
    const local = addr.split('@')[0];
    const plus = local.match(/\+([a-z0-9]{4,20})$/);
    if (plus) codes.add(plus[1]);
    const job = local.match(/^job-([a-z0-9]{4,20})$/);
    if (job) codes.add(job[1]);
  }
  return [...codes];
}

/**
 * Normalise a webhook request into { from, subject, text, html, recipients, attachments[] }
 * where attachments are { name, contentType, buffer }.
 */
function parseInboundEmail(req) {
  const b = req.body || {};
  // Postmark: JSON body with PascalCase keys
  if (b.FromFull || b.Attachments || b.MailboxHash !== undefined || b.OriginalRecipient) {
    const recipients = [
      ...addressesIn(b.ToFull || b.To),
      ...addressesIn(b.CcFull || b.Cc),
      ...addressesIn(b.BccFull || b.Bcc),
      ...addressesIn(b.OriginalRecipient),
    ];
    if (b.MailboxHash && recipients.length) recipients.push(`x+${String(b.MailboxHash).toLowerCase()}@mailboxhash`);
    return {
      from: b.From || b.FromFull?.Email || '',
      subject: b.Subject || '',
      text: b.TextBody || '',
      html: b.HtmlBody || '',
      recipients,
      attachments: (b.Attachments || []).map((a) => ({
        name: a.Name || 'attachment',
        contentType: a.ContentType || '',
        buffer: Buffer.from(a.Content || '', 'base64'),
      })),
    };
  }
  // SendGrid Inbound Parse / Mailgun: multipart form fields + files (via multer.any())
  let envelopeTo = [];
  if (b.envelope) {
    try { envelopeTo = addressesIn(JSON.parse(b.envelope).to); } catch { /* ignore */ }
  }
  const recipients = [
    ...envelopeTo,
    ...addressesIn(b.to || b.To),
    ...addressesIn(b.cc || b.Cc),
    ...addressesIn(b.recipient),
  ];
  return {
    from: b.from || b.sender || b.From || '',
    subject: b.subject || b.Subject || '',
    text: b.text || b['body-plain'] || b['stripped-text'] || '',
    html: b.html || b['body-html'] || '',
    recipients,
    attachments: (req.files || []).map((f) => ({
      name: f.originalname || f.fieldname || 'attachment',
      contentType: f.mimetype || '',
      buffer: f.buffer,
    })),
  };
}

module.exports = { inboxAddress, addressesIn, codesFromAddresses, parseInboundEmail };
