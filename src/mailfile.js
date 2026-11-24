/**
 * After paying an invoice: its email is marked as read and moved to the business's paid folder, into the
 * supplier's own folder under it ("Paid / Jacksyl"). The supplier's folder is made if it isn't there yet.
 * Works with Outlook (Microsoft Graph, needs the read-and-write approval) and with IMAP mailboxes (Gmail etc.).
 * Emails are never deleted.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** A supplier name for comparing with folder names: "Jacksyl Pty Ltd" ~ "JACKSYL". */
const nameKey = (s) => String(s || '').toLowerCase().replace(/\b(pty|ltd|limited|p\/l|the|australia|aust|group|co|inc)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, '');
function sameName(folder, supplier) {
  const a = nameKey(folder); const b = nameKey(supplier);
  if (!a || !b) return false;
  return a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));
}
/** The folder name for a new supplier folder: the supplier without "Pty Ltd". */
const folderName = (supplier) => String(supplier || 'Other').replace(/\b(pty\.?|ltd\.?|limited|p\/l)\b/gi, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Other';

// ---------- Outlook ----------
async function graph(token, method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const e = new Error(`Outlook said ${res.status}${t ? ': ' + t : ''}`); e.status = res.status; throw e;
  }
  return res.status === 204 ? null : res.json();
}
const outlookApi = {
  async findMessage(token, { messageId, subject, from }) {
    if (messageId) {
      const r = await graph(token, 'GET', `/me/messages?$filter=${encodeURIComponent(`internetMessageId eq '${String(messageId).replace(/'/g, "''")}'`)}&$select=id,subject&$top=1`);
      if (r.value && r.value[0]) return r.value[0].id;
    }
    if (subject) {
      const r = await graph(token, 'GET', `/me/messages?$search=${encodeURIComponent(`"${String(subject).replace(/"/g, '')}"`)}&$select=id,subject,from&$top=10`);
      const addr = (String(from || '').match(/<([^>]+)>/) || [null, from])[1];
      const hit = (r.value || []).find((m) => m.subject === subject && (!addr || String(m.from?.emailAddress?.address || '').toLowerCase() === String(addr).toLowerCase()));
      if (hit) return hit.id;
    }
    return null;
  },
  async folders(token, parentId) {
    const r = await graph(token, 'GET', parentId ? `/me/mailFolders/${parentId}/childFolders?$top=200` : '/me/mailFolders?$top=200');
    return (r.value || []).map((f) => ({ id: f.id, name: f.displayName }));
  },
  async createFolder(token, parentId, name) {
    const f = await graph(token, 'POST', parentId ? `/me/mailFolders/${parentId}/childFolders` : '/me/mailFolders', { displayName: name });
    return { id: f.id, name: f.displayName };
  },
  async markRead(token, id) { await graph(token, 'PATCH', `/me/messages/${id}`, { isRead: true }); },
  async move(token, id, folderId) { await graph(token, 'POST', `/me/messages/${id}/move`, { destinationId: folderId }); },
};

/** Outlook: returns { status: 'done' | 'not_found', folder } */
async function fileInOutlook(token, { messageId, subject, from, root = 'Paid', supplier }, api = outlookApi) {
  const id = await api.findMessage(token, { messageId, subject, from });
  if (!id) return { status: 'not_found' };
  // the paid folder, wherever it is (looked for 4 levels deep, top level first); never made – it must be the business's own
  let paid = null; let level = [{ id: null, name: '' }];
  for (let depth = 0; depth < 4 && !paid && level.length; depth++) {
    const next = [];
    for (const parent of level.slice(0, 60)) {
      const kids = await api.folders(token, parent.id);
      paid = kids.find((f) => f.name.trim().toLowerCase() === root.trim().toLowerCase());
      if (paid) { paid = { ...paid, path: parent.name ? `${parent.name} / ${paid.name}` : paid.name }; break; }
      next.push(...kids.map((k) => ({ ...k, name: parent.name ? `${parent.name} / ${k.name}` : k.name })));
    }
    level = next;
  }
  if (!paid) return { status: 'no_folder', folder: `No folder called "${root}" in Outlook – make it (or change the name in Settings → Paying suppliers)` };
  const subs = await api.folders(token, paid.id);
  const dest = subs.find((f) => sameName(f.name, supplier)) || await api.createFolder(token, paid.id, folderName(supplier));
  await api.markRead(token, id);
  await api.move(token, id, dest.id);
  return { status: 'done', folder: `${paid.path} / ${dest.name}` };
}

// ---------- IMAP (Gmail and others) ----------
/** IMAP: the client is an ImapFlow (not connected yet). Returns { status, folder }. */
async function fileInImap(client, { messageId, subject, from, root = 'Paid', supplier }) {
  await client.connect();
  try {
    const boxes = await client.list();
    const leaf = (b) => String(b.name || b.path.split(b.delimiter || '/').pop());
    let paid = boxes.find((b) => leaf(b).toLowerCase() === root.toLowerCase() && !/^\[gmail\]/i.test(b.path));
    if (!paid) return { status: 'no_folder', folder: `No folder called "${root}" in the mailbox – make it (or change the name in Settings → Paying suppliers)` };
    const d = paid.delimiter || '/';
    const subs = boxes.filter((b) => b.path.startsWith(paid.path + d) && !b.path.slice(paid.path.length + 1).includes(d));
    let dest = subs.find((b) => sameName(leaf(b), supplier));
    if (!dest) { const p = `${paid.path}${d}${folderName(supplier)}`; await client.mailboxCreate(p); dest = { path: p, name: folderName(supplier) }; }
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids = messageId ? await client.search({ header: { 'message-id': messageId } }, { uid: true }) : [];
      if ((!uids || !uids.length) && subject) {
        const addr = (String(from || '').match(/<([^>]+)>/) || [null, from])[1];
        uids = await client.search({ subject, ...(addr ? { from: addr } : {}) }, { uid: true });
      }
      if (!uids || !uids.length) return { status: 'not_found' };
      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      await client.messageMove(uids, dest.path, { uid: true });
    } finally { lock.release(); }
    return { status: 'done', folder: `${leaf(paid)} / ${leaf(dest)}` };
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { fileInOutlook, fileInImap, outlookApi, sameName, folderName };
