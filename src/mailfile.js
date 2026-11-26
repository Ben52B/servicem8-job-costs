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
    return (r.value || []).map((f) => ({ id: f.id, name: f.displayName, children: f.childFolderCount || 0 }));
  },
  async createFolder(token, parentId, name) {
    const f = await graph(token, 'POST', parentId ? `/me/mailFolders/${parentId}/childFolders` : '/me/mailFolders', { displayName: name });
    return { id: f.id, name: f.displayName };
  },
  async markRead(token, id) { await graph(token, 'PATCH', `/me/messages/${id}`, { isRead: true }); },
  async move(token, id, folderId) { await graph(token, 'POST', `/me/messages/${id}/move`, { destinationId: folderId }); },
};

/**
 * Where an invoice's email goes in Outlook, without moving anything:
 * { status: 'found', dest: { id, path } } – the supplier's folder under Paid (or the folder chosen for this supplier)
 * { status: 'no_match', note } – no folder for the supplier under Paid: choose one (folders are never made)
 * { status: 'no_folder', note } – no Paid folder: choose one
 */
async function planOutlook(token, { root = 'Paid', supplier, folder = null }, api = outlookApi) {
  if (folder && folder.id) return { status: 'found', dest: { id: folder.id, path: folder.path || folder.name || 'the chosen folder' } };
  // the paid folder; never made – it must be the business's own.
  // "Inbox / Paid": that exact path. "Paid": inside the Inbox first, then the top level, then up to 4 levels deep.
  let paid = null; let level = [{ id: null, name: '' }];
  const parts = String(root).split(/\s*[\/\\>]\s*/).filter(Boolean);
  if (parts.length > 1) {
    let parent = { id: null, name: '' };
    for (const part of parts) {
      const hit = (await api.folders(token, parent.id)).find((f) => f.name.trim().toLowerCase() === part.toLowerCase());
      if (!hit) { parent = null; break; }
      parent = { id: hit.id, name: parent.name ? `${parent.name} / ${hit.name}` : hit.name };
    }
    if (!parent) return { status: 'no_folder', note: `No folder "${parts.join(' / ')}" in Outlook – choose where it goes` };
    paid = { id: parent.id, name: parts.at(-1), path: parent.name };
    level = [];
  } else {
    const top = await api.folders(token, null);
    const inbox = top.find((f) => f.name.toLowerCase() === 'inbox');
    if (inbox) {
      const hit = (await api.folders(token, inbox.id)).find((f) => f.name.trim().toLowerCase() === root.trim().toLowerCase());
      if (hit) { paid = { ...hit, path: `${inbox.name} / ${hit.name}` }; level = []; }
    }
  }
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
  if (!paid) return { status: 'no_folder', note: `No folder called "${root}" in Outlook – choose where it goes` };
  const subs = await api.folders(token, paid.id);
  const sub = subs.find((f) => sameName(f.name, supplier));
  if (sub) return { status: 'found', dest: { id: sub.id, path: `${paid.path} / ${sub.name}` } };
  const name = folderName(supplier);
  return { status: 'no_match', note: `No folder for ${name} in ${paid.path} – choose where it goes`, parentPath: paid.path };
}

/** Outlook: mark the email read and move it. Returns { status: 'done' | 'not_found' | 'no_folder', folder, folderId } */
async function fileInOutlook(token, { messageId, subject, from, root = 'Paid', supplier, folder = null }, api = outlookApi) {
  const id = await api.findMessage(token, { messageId, subject, from });
  if (!id) return { status: 'not_found' };
  const plan = await planOutlook(token, { root, supplier, folder }, api);
  // never makes a folder: without a match it waits for a folder to be chosen
  if (plan.status !== 'found') return { status: 'no_folder', folder: plan.note };
  const dest = plan.dest;
  await api.markRead(token, id);
  await api.move(token, id, dest.id);
  return { status: 'done', folder: dest.path, folderId: dest.id };
}

// ---------- IMAP (Gmail and others) ----------
/** IMAP: the client is an ImapFlow (not connected yet). Returns { status, folder }. */
async function fileInImap(client, { messageId, subject, from, root = 'Paid', supplier, folder = null }) {
  await client.connect();
  try {
    const boxes = await client.list();
    const leaf = (b) => String(b.name || b.path.split(b.delimiter || '/').pop());
    if (folder && folder.id) return await moveImap(client, { messageId, subject, from }, { path: folder.id }, folder.path || folder.id);
    let paid = boxes.find((b) => leaf(b).toLowerCase() === root.toLowerCase() && !/^\[gmail\]/i.test(b.path));
    if (!paid) return { status: 'no_folder', folder: `No folder called "${root}" in the mailbox – make it (or change the name in Settings → Paying suppliers)` };
    const d = paid.delimiter || '/';
    const subs = boxes.filter((b) => b.path.startsWith(paid.path + d) && !b.path.slice(paid.path.length + 1).includes(d));
    let dest = subs.find((b) => sameName(leaf(b), supplier));
    if (!dest) return { status: 'no_folder', folder: `No folder for ${folderName(supplier)} in ${leaf(paid)} – choose where it goes` }; // never makes a folder
    return await moveImap(client, { messageId, subject, from }, dest, `${leaf(paid)} / ${leaf(dest)}`);
  } finally {
    await client.logout().catch(() => {});
  }
}
async function moveImap(client, { messageId, subject, from }, dest, label) {
  {
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
    return { status: 'done', folder: label, folderId: dest.path };
  }
}
/** IMAP folders for choosing one: [{ id: path, name, path }] */
async function listImapFolders(client) {
  await client.connect();
  try { return (await client.list()).filter((b) => !(b.flags && b.flags.has && b.flags.has('\\Noselect'))).map((b) => ({ id: b.path, name: b.path.split(b.delimiter || '/').join(' / '), children: 0 })); }
  finally { await client.logout().catch(() => {}); }
}

module.exports = { fileInOutlook, planOutlook, fileInImap, listImapFolders, outlookApi, sameName, folderName };
