/**
 * Free email-in: the app checks a normal mailbox (your own domain's invoices@ address,
 * or a Gmail account) every couple of minutes over IMAP, and reads new invoice emails.
 * It never changes the mailbox: emails are remembered by their ID, not marked as read.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const LOOK_BACK_DAYS = 14;

/** Turn a raw email into { from, subject, text, html, recipients, attachments[] }. */
async function parseRawEmail(raw) {
  const m = await simpleParser(raw);
  const addrs = (field) => (field ? [].concat(field).flatMap((f) => f.value || []).map((v) => String(v.address || '').toLowerCase()).filter(Boolean) : []);
  const delivered = [].concat(m.headers.get('delivered-to') || [], m.headers.get('x-original-to') || [])
    .flatMap((h) => (typeof h === 'string' ? [h] : addrs(h))).map((a) => String(a).toLowerCase());
  return {
    messageId: m.messageId || null,
    from: m.from?.text || '',
    subject: m.subject || '',
    text: m.text || '',
    html: typeof m.html === 'string' ? m.html : '',
    recipients: [...addrs(m.to), ...addrs(m.cc), ...delivered],
    attachments: (m.attachments || []).filter((a) => a.contentDisposition !== 'inline' || !String(a.contentType).startsWith('image/') || a.size > 20 * 1024)
      .map((a) => ({ name: a.filename || 'attachment', contentType: a.contentType || '', buffer: a.content })),
  };
}

/**
 * One pass over the mailbox: every email from the last two weeks that hasn't been
 * handled yet is passed to onMail, then remembered.
 */
async function checkMailbox(client, { repo, onMail, log = console }) {
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  let handled = 0;
  try {
    const since = new Date(Date.now() - LOOK_BACK_DAYS * 86400000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    const validity = String(client.mailbox?.uidValidity ?? '');
    for (const uid of uids) {
      const key = `${validity}:${uid}`;
      if (repo.isMailProcessed(key)) continue;
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      try {
        const mail = await parseRawEmail(msg.source);
        if (mail.messageId && repo.isMailProcessed(`id:${mail.messageId}`)) { repo.markMailProcessed(key); continue; }
        await onMail(mail);
        if (mail.messageId) repo.markMailProcessed(`id:${mail.messageId}`);
        handled++;
      } catch (e) {
        log.error(`Couldn't handle email ${key}: ${e.message}`);
      }
      repo.markMailProcessed(key);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return handled;
}

function startMailboxPoller({ config, repo, onMail, log = console, createClient }) {
  const make = createClient || (() => new ImapFlow({
    host: config.imapHost, port: config.imapPort, secure: config.imapPort === 993,
    auth: { user: config.imapUser, pass: config.imapPassword }, logger: false,
  }));
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const n = await checkMailbox(make(), { repo, onMail, log });
      if (n) log.log(`Mailbox: ${n} new email${n === 1 ? '' : 's'}`);
    } catch (e) {
      log.error(`Mailbox check failed (${config.imapUser} at ${config.imapHost}): ${e.message}`);
    } finally {
      busy = false;
    }
  }
  tick();
  const timer = setInterval(tick, Math.max(30, config.imapPollSeconds) * 1000);
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { parseRawEmail, checkMailbox, startMailboxPoller };
