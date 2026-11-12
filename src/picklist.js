/**
 * Pick list (what the installer collects for a job), built from what Job Costs already knows:
 * - the invoices on the job (what was bought, how many, from which supplier – or from our stock)
 * - the job notes ("NEW DOOR CALCULATIONS": Door - $..., Motor - $..., Posts - $...), for what isn't invoiced yet
 * - items added by hand
 * Kits break an item into its parts (e.g. a sectional door = panels, tracks, springs, bar, hardware box…).
 * Ticks are kept per job under stable keys, so the list can be rebuilt any time without losing them.
 */

// Starting kits for a garage door business (each business can change them).
const DEFAULT_KITS = [
  { name: 'Motor', match_words: ['motor', 'opener', 'operator'], parts: [{ name: 'Motor' }, { name: 'Track (chain or belt)' }] },
  { name: 'Sectional door', match_words: ['sectional', 'panel', 'insulated', 'tilt'], parts: [
    { name: 'Door panels' }, { name: 'Tracks' }, { name: 'Springs' }, { name: 'Bar (shaft)' }, { name: 'Hardware box' },
    { name: 'Back support bar' }, { name: 'Low headroom kit', optional: true }] },
  { name: 'Roller door', match_words: ['roller'], parts: [{ name: 'Door' }, { name: 'Tracks', qty: 2 }, { name: 'Hardware box / bag' }, { name: 'Brackets', qty: 2 }] },
];

// Invoice lines that are things to collect (not freight, labour, a subcontractor's work or fees).
const PICKABLE = new Set(['materials', 'other']);
// Job-note lines that aren't things to collect.
// Invoice lines that read like charges, not goods.
const NOT_PICKED_UP = /^\s*(delivery|freight|postage|shipping|courier|cartage|surcharge|fuel levy|handling|card fee|rounding)\b/i;
const NOT_MATERIAL = /labou?r|delivery|wrapping|total|travel|removal|disposal|install|call.?out|discount|deposit|gst|margin/i;

const words = (t) => ` ${String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** The first kit with one of its words in the text (kits are tried in their order). */
function matchKit(kits, text) {
  const w = words(text);
  return kits.find((k) => (k.match_words || []).some((m) => m && w.includes(` ${String(m).toLowerCase().trim()}`))) || null;
}

/** "2 x Tracks", "Low headroom kit (if needed)" → { name, qty, optional } */
function parsePart(line) {
  let t = String(line || '').trim();
  if (!t) return null;
  let qty = null;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(.+)$/i) || t.match(/^(.+?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (m) { if (/^\d/.test(m[1])) { qty = Number(m[1]); t = m[2]; } else { qty = Number(m[2]); t = m[1]; } }
  const optional = /\(\s*(if|when|optional)\b[^)]*\)|\boptional\b/i.test(t);
  return { name: t.trim().slice(0, 80), ...(qty ? { qty } : {}), ...(optional ? { optional: true } : {}) };
}

/** Lines like "Door - $3375+5%" or "Posts - $180" in the job notes: the items that have a price. */
function itemsFromNotes(notes) {
  const out = [];
  const text = String(notes || '');
  const typeLine = (text.match(/(door\s*type[^\n]*|supplier[^\n]*)/gi) || []).join(' ');
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z][A-Za-z0-9 &()+.,'-]{1,40}?)\s*[-–:]\s*\$\s*(\d[\d,.]*)/);
    if (!m) continue;
    const label = m[1].trim();
    if (NOT_MATERIAL.test(label)) continue;
    out.push({ label, hint: /door/i.test(label) ? `${label} ${typeLine} ${text.slice(0, 300)}` : label });
  }
  return out;
}

/**
 * Build the pick list of a job. Returns { groups: [{ title, kind, items: [...] }], progress: { picked, total } }.
 * Each item: { key, name, qty, unit, where, source, invoice, parts: [{ key, name, qty, optional, picked }], picked }.
 */
function buildPickList({ summary, notes, kits, ticks, extra, jobLines = null }) {
  const { kindsOf, mainKind } = require('./joblines');
  const items = [];
  const kitCovered = new Set();
  const nameCovered = [];
  for (const inv of summary.invoices || []) {
    if (inv.status !== 'ready' || inv.duplicate_of) continue;
    const where = inv.kept_as_stock ? 'Our stock' : (inv.supplier || 'Supplier');
    for (const line of inv.items || []) {
      // the line's own type (as read from the invoice) and this job's type for it must both be things to collect
      if (!PICKABLE.has(line.item_category || 'materials') || !PICKABLE.has(line.category || inv.category || 'materials') || NOT_PICKED_UP.test(line.description || '')) continue;
      const kit = matchKit(kits, line.description);
      if (kit) kitCovered.add(kit.id ?? kit.name);
      nameCovered.push(words(line.description));
      items.push({
        key: `i:${line.id}`, name: line.description || 'Item', qty: line.share_quantity ?? line.quantity ?? null, unit: line.unit || null,
        where, source: 'invoice', invoice: { id: inv.id, number: inv.invoice_number, supplier: inv.supplier }, kit: kit ? kit.name : null,
        parts: kit ? kit.parts.map((p, n) => ({ key: `i:${line.id}:${n}`, ...p })) : [],
      });
    }
  }
  // from the job's lines in ServiceM8 (door, motor, posts…): what no invoice covers yet
  const invoiceKinds = new Set();
  for (const it of items) { const k = mainKind(it.name); if (k) invoiceKinds.add(k); }
  const lineKinds = new Set();
  for (const l of jobLines || []) {
    const name = String(l.name || '').trim();
    const kinds = kindsOf(name.replace(/supply\s*(and|&)\s*install(ation)?/i, ' '));
    if (!name || !kinds.length || (NOT_MATERIAL.test(name) && !kinds.length)) continue;
    kinds.forEach((k) => lineKinds.add(k));
    if (kinds.every((k) => invoiceKinds.has(k))) continue; // its invoice is on the list already
    const kit = matchKit(kits, name);
    if (kit) kitCovered.add(kit.id ?? kit.name);
    const key = `l:${String(l.uuid || slug(name)).replace(/[^\w-]/g, '')}`;
    items.push({ key, name, qty: l.qty ?? null, unit: null, where: 'On the job', source: 'job', kit: kit ? kit.name : null,
      parts: kit ? kit.parts.map((p, i) => ({ key: `${key}:${i}`, ...p })) : [] });
    nameCovered.push(words(name));
  }
  // from the job notes: what has a price but isn't on an invoice (or a job line) yet
  for (const n of itemsFromNotes(notes)) {
    const nk = kindsOf(n.label);
    if (nk.length && nk.every((k) => lineKinds.has(k) || invoiceKinds.has(k))) continue;
    const kit = matchKit(kits, n.hint);
    const w = words(n.label).trim().split(' ').filter((x) => x.length > 2).map((x) => x.replace(/s$/, ''));
    const covered = (kit && kitCovered.has(kit.id ?? kit.name)) || (w.length && nameCovered.some((d) => w.every((x) => d.includes(` ${x}`))));
    if (covered) continue;
    const key = `n:${slug(n.label)}`;
    items.push({ key, name: n.label, qty: null, unit: null, where: 'Not on an invoice yet', source: 'notes', kit: kit ? kit.name : null,
      parts: kit ? kit.parts.map((p, i) => ({ key: `${key}:${i}`, ...p })) : [] });
  }
  for (const x of extra || []) items.push({ key: `x:${x.id}`, id: x.id, name: x.name, qty: x.qty, unit: null, where: 'Added by hand', source: 'manual', parts: [] });

  // ticks, and what's left to pick
  let picked = 0; let total = 0;
  for (const it of items) {
    if (it.parts.length) {
      for (const p of it.parts) {
        p.picked = ticks.has(p.key);
        if (!p.optional) { total++; if (p.picked) picked++; }
      }
      const req = it.parts.filter((p) => !p.optional);
      it.picked = req.length ? req.every((p) => p.picked) : it.parts.every((p) => p.picked);
    } else {
      it.picked = ticks.has(it.key);
      total++; if (it.picked) picked++;
    }
  }
  // grouped by where to collect: suppliers first, then our stock, then not invoiced yet, then added by hand
  const order = (w) => (w === 'Our stock' ? 1 : w === 'On the job' ? 2 : w === 'Not on an invoice yet' ? 3 : w === 'Added by hand' ? 4 : 0);
  const groups = [];
  for (const it of items) {
    let g = groups.find((x) => x.title === it.where);
    if (!g) { g = { title: it.where, kind: ['supplier', 'stock', 'job', 'notes', 'manual'][order(it.where)], items: [] }; groups.push(g); }
    g.items.push(it);
  }
  groups.sort((a, b) => order(a.title) - order(b.title) || a.title.localeCompare(b.title));
  return { groups, progress: { picked, total } };
}

/** Every key that "Tick all" ticks (required parts, and items without parts). */
function allKeys(list) {
  const keys = [];
  for (const g of list.groups) for (const it of g.items) {
    if (it.parts.length) for (const p of it.parts) { if (!p.optional) keys.push(p.key); } else keys.push(it.key);
  }
  return keys;
}

module.exports = { DEFAULT_KITS, buildPickList, matchKit, parsePart, itemsFromNotes, allKeys };
