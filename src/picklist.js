/**
 * Picking list (what the installer collects for a job).
 *
 * Every line we know about the job – the invoices on it, its lines in ServiceM8, the priced lines of its notes – is read
 * for the THINGS it names: a sectional door, a motor, safety beams, a smart hub, remotes, posts… A line naming several
 * ("Merlin motor with 2 remotes and safety beams") gives several items; the same thing named in several places
 * (the invoice, the job line and the notes) is one item. Each item gets the boxes that fit it:
 *   - a sectional (or tilt) door: panels, tracks, springs, bar, hardware box, back support bar (+ low headroom kit if asked for)
 *   - a motor: the motor box, and for a sectional/tilt door its track – chain or belt (from the words, the model, or asked)
 *   - beams, a smart hub, remotes, a keypad, posts…: one box each
 * Anything not recognised is one box under its own name. Ticks are kept per job under stable keys.
 */

// A business can also add its own items (match words → parts): they're tried before the built-in ones.

// The built-in items, in the order they're looked for. Once a thing is found its words are taken out of the line,
// so "post covers" isn't also "posts" and a "header beam" isn't also safety beams.
const ITEMS = [
  { type: 'post_cover', name: 'Post covers', re: /\bpost\s*(covers?|cladding|caps?)\b/ },
  { type: 'lintel', name: 'Lintel', re: /\blintels?\b|\b(header|steel)\s*beams?\b/ },
  { type: 'low_headroom', name: 'Low headroom kit', re: /\blow[\s-]*head[\s-]*room(\s*kit)?\b/ },
  { type: 'smart_hub', name: 'Smart hub', re: /\bsmart\s*(hub|phone\s*(control|module)|control|connect|module)\b|\bwi-?fi\s*(hub|module|bridge|connect(ivity)?)?\b|\bmyq\b|\bhub\b/ },
  { type: 'sensor', name: 'Safety beams', re: /\b(safety|sensor|photo(\s*electric)?|p\.?\s?e\.?|infra-?red|ir)\s*beams?\b|\bphoto\s*eyes?\b|\b(safety\s*)?sensors?\b|\bbeams?\b/ },
  { type: 'keypad', name: 'Keypad', re: /\b(wireless\s*)?key\s*pads?\b/ },
  { type: 'wall_button', name: 'Wall button', re: /\bwall\s*(buttons?|controls?|switch(es)?|stations?)\b|\bpush\s*buttons?\b/ },
  { type: 'remote', name: 'Remotes', re: /\b(extra\s*)?(remotes?|transmitters?|handsets?|fobs?)\b/ },
  { type: 'battery', name: 'Battery backup', re: /\bbattery(\s*back[\s-]*up)?\b|\bbatteries\b|\bups\b/ },
  { type: 'motor', name: 'Motor', re: /\b(motors?|openers?|operators?|automation|drive\s*unit|(belt|chain)\s*drive)\b/ },
  { type: 'flashing', name: 'Flashing', re: /\bflashings?\b/ },
  { type: 'post', name: 'Posts', re: /\bposts?\b|\bjambs?\b/ },
  { type: 'seal', name: 'Seals', re: /\b(weather|bottom|side|top|brush|rubber)?\s*seals?\b/ },
  { type: 'spring', name: 'Springs', re: /\bsprings?\b/ },
  { type: 'sectional', name: 'Sectional door', door: true, re: /\bsectional\b|\bpanel[\s-]*lift\b|\binsulated\s*(garage\s*)?door\b|\bpanel\s*door\b/ },
  { type: 'tilt', name: 'Tilt door', door: true, re: /\btilt(\s*(a\s*)?door)?\b/ },
  { type: 'roller', name: 'Roller door', door: true, re: /\broller(\s*(door|shutter))?\b|\broll[\s-]*a[\s-]*door\b/ },
  { type: 'door', name: 'Door', door: true, re: /\bdoors?\b/ },
];
const BY_TYPE = Object.fromEntries(ITEMS.map((i) => [i.type, i]));
// A motor brand on its own ("Merlin MR850") is a motor – but not when the line names something else ("Merlin remote").
const MOTOR_BRAND = /\b(merlin|chamberlain|liftmaster|controlladoor|ata|axess|grifco|centurion|somfy|boss|glidermatic|dace|sommer|elsema)\b/;
// Door wording that is a door kind: what tells which door a motor is for, when the door isn't on the job's lines.
const DOOR_KIND = [['sectional', /\bsectional\b|\bpanel[\s-]*lift\b|\binsulated\b|\bpanel\b/], ['tilt', /\btilt\b/], ['roller', /\broller\b|\broll[\s-]*a[\s-]*door\b/]];

// The boxes of each item (the rest are one box each).
const SECTIONAL_PARTS = [
  { slug: 'panels', name: 'Door panels' }, { slug: 'tracks', name: 'Tracks' }, { slug: 'springs', name: 'Springs' },
  { slug: 'bar', name: 'Bar (shaft)' }, { slug: 'hardware', name: 'Hardware box' }, { slug: 'support', name: 'Back support bar' }];
const PARTS = {
  sectional: SECTIONAL_PARTS,
  tilt: [{ slug: 'door', name: 'Door' }, { slug: 'tracks', name: 'Tracks / arms' }, { slug: 'springs', name: 'Springs' }, { slug: 'hardware', name: 'Hardware box' }],
  roller: [{ slug: 'door', name: 'Door (curtain)' }, { slug: 'tracks', name: 'Tracks', qty: 2 }, { slug: 'hardware', name: 'Hardware box / bag' }, { slug: 'brackets', name: 'Brackets', qty: 2 }],
};

// Invoice lines that are things to collect (not freight, labour, a subcontractor's work or fees).
const PICKABLE = new Set(['materials', 'other']);
// Invoice lines that read like charges, not goods.
const NOT_PICKED_UP = /^\s*(delivery|freight|postage|shipping|courier|cartage|surcharge|fuel levy|handling|card fee|rounding)\b/i;
// Job lines and note lines that aren't things to collect (unless they also name a thing, e.g. "Sectional door supply & install").
const NOT_MATERIAL = /labou?r|delivery|wrapping|total|travel|removal|disposal|install|call.?out|discount|deposit|gst|margin|service|fee\b|hours?\b|warranty|admin|freight|measure|quote|inspection|repair/i;
// Lines about taking the old one away: never picked up.
const TAKE_AWAY = /\b(remov(e|al|ing)|dispos(e|al)|take\s*away|old\s+(door|motor))\b/i;

const words = (t) => ` ${String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** "2 x Tracks", "Low headroom kit (if needed)" → { name, qty, optional } (for the business's own items). */
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
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z][A-Za-z0-9 &()+.,'/-]{1,40}?)\s*[-–:]\s*\$\s*(\d[\d,.]*)/);
    if (!m) continue;
    const label = m[1].trim();
    if (NOT_MATERIAL.test(label.replace(/supply\s*(and|&|\+)\s*(fit|install(ation)?)/i, ' '))) continue;
    out.push({ label });
  }
  return out;
}
/** The door wording of the notes ("Supplier: ECO insulated", "Door Type: Panel…") – which door it is. */
function doorWordsOfNotes(notes) {
  return (String(notes || '').match(/^\s*(door\s*type[^\n]*|supplier[^\n]*|door\s*-[^\n]*)$/gim) || []).join(' ');
}

/** The business's own item (kit) with one of its words in the text, if any. */
function matchKit(kits, text) {
  const w = words(text);
  return (kits || []).find((k) => (k.match_words || []).some((m) => m && w.includes(` ${String(m).toLowerCase().trim()}`))) || null;
}

/**
 * The things one line names: [{ type, qty, text, doorContext }].
 * "Merlin MR850 motor with 2 remotes" → motor (the line's qty), remotes (2).
 * "Merlin opener for roller door" → a motor (for a roller door), not a door.
 */
function thingsIn(text, lineQty, kits) {
  let t = String(text || '').toLowerCase()
    .replace(/supply\s*(and|&|\+)\s*(fit|install(ation)?)/g, ' ').replace(/\bb\s*&\s*d\b/g, 'bnd').replace(/\bcontroll?[\s-]*a[\s-]*door\b/g, 'controlladoor');
  const out = [];
  const segments = t.split(/\s*(?:\+|&|,|;|\/|\band\b|\bwith\b|\bplus\b|\bincl(?:uding|udes|\.)?\b|\binc\b)\s*/).filter((s) => s.trim());
  const many = segments.length > 1;
  for (const seg of segments) {
    const found = [];
    const kit = matchKit(kits, seg);
    let rest = ` ${seg} `;
    if (kit) found.push({ type: `k${kit.id}`, kit, at: 0 });
    else {
      for (const it of ITEMS) {
        if (it.type === 'door' && found.some((f) => BY_TYPE[f.type]?.door)) continue; // "sectional door" is one door
        const m = rest.match(it.re);
        if (!m) continue;
        found.push({ type: it.type, at: m.index });
        rest = rest.replace(new RegExp(it.re.source, 'g'), ' ');
      }
      if (!found.length && MOTOR_BRAND.test(seg)) found.push({ type: 'motor', at: 0 });
    }
    // a door named next to a motor ("opener for roller door") says which door the motor is for
    const motor = found.find((f) => f.type === 'motor');
    let doorContext = null;
    if (motor) {
      for (const f of found.filter((x) => BY_TYPE[x.type]?.door)) { doorContext = doorContext || (f.type !== 'door' ? f.type : null); }
      for (let i = found.length - 1; i >= 0; i--) if (BY_TYPE[found[i].type]?.door) found.splice(i, 1);
      motor.doorContext = doorContext;
    }
    for (const f of found) {
      // "2 remotes", "remotes x 2"
      const name = f.type.startsWith('k') ? null : BY_TYPE[f.type].re;
      let qty = null;
      if (name) {
        const near = seg.match(new RegExp(`(?:^|\\s)(\\d{1,2})\\s*(?:x\\s*)?(?:[a-z-]+\\s+){0,2}?(?:${name.source})`)) || seg.match(new RegExp(`(?:${name.source})\\s*(?:x|×)\\s*(\\d+)`));
        if (near) qty = Number(near[1] && /^\d+$/.test(near[1]) ? near[1] : near[near.length - 1]);
      }
      if (qty == null && (!many || found.length === 1 || f === found[0])) qty = lineQty ?? null;
      out.push({ type: f.type, kit: f.kit || null, qty, text: seg.trim(), doorContext: f.doorContext || null });
    }
  }
  return out;
}

/** The track of a motor: 'chain', 'belt', or null (not known yet). */
function driveOf(texts, settings = {}) {
  const all = texts.join(' ').toLowerCase();
  const belt = /\bbelt\b/.test(all); const chain = /\bchain\b/.test(all);
  if (belt !== chain) return belt ? 'belt' : 'chain';
  const has = (list) => (list || []).some((m) => m && words(all).includes(` ${String(m).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `));
  const b = has(settings.belt_models); const c = has(settings.chain_models);
  if (b !== c) return b ? 'belt' : 'chain';
  return null;
}
/** The model of a motor line ("Merlin MR850 motor" → "mr850"), to remember whether it's chain or belt. */
function modelOf(text) {
  const m = String(text || '').match(/\b([a-z]{1,4}[\s-]?\d{2,5}[a-z]{0,4}(?:[\s-]?(?:evo|plus|pro|ii|iii))?)\b/i);
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
}

/**
 * Build the picking list of a job.
 * Returns { groups: [{ title, kind, items }], progress: { picked, total }, doorKind, drive }.
 * Each item: { key, type, name, detail, qty, unit, where, source, invoice, parts: [{ key, name, qty, optional, picked, drive? }], picked }.
 */
function buildPickList({ summary, notes, kits = [], ticks, extra, jobLines = null, settings = {} }) {
  const SRC = { invoice: 0, job: 1, notes: 2 };
  const mentions = []; // { type, kit, qty, text, source, where, invoice, name, doorContext }
  const singles = []; // lines that name nothing we know: one box each
  for (const inv of summary.invoices || []) {
    if (inv.status !== 'ready' || inv.duplicate_of) continue;
    const where = inv.kept_as_stock ? 'Our stock' : (inv.supplier || 'Supplier');
    for (const line of inv.items || []) {
      // the line's own type (as read from the invoice) and this job's type for it must both be things to collect
      if (!PICKABLE.has(line.item_category || 'materials') || !PICKABLE.has(line.category || inv.category || 'materials') || NOT_PICKED_UP.test(line.description || '')) continue;
      const qty = line.share_quantity ?? line.quantity ?? null;
      const invoice = { id: inv.id, number: inv.invoice_number, supplier: inv.supplier };
      const found = TAKE_AWAY.test(line.description || '') ? [] : thingsIn(line.description, qty, kits);
      if (!found.length) { singles.push({ key: `i:${line.id}`, name: line.description || 'Item', qty, unit: line.unit || null, where, source: 'invoice', invoice }); continue; }
      for (const f of found) mentions.push({ ...f, source: 'invoice', where, invoice, name: line.description, unit: found.length === 1 ? line.unit || null : null });
    }
  }
  for (const l of jobLines || []) {
    const name = String(l.name || '').trim();
    if (!name || TAKE_AWAY.test(name)) continue;
    const found = thingsIn(name, l.qty ?? null, kits);
    if (!found.length) {
      if (NOT_MATERIAL.test(name)) continue;
      singles.push({ key: `l:${String(l.uuid || slug(name)).replace(/[^\w-]/g, '')}`, name, qty: l.qty ?? null, unit: null, where: 'On the job', source: 'job' });
      continue;
    }
    for (const f of found) mentions.push({ ...f, source: 'job', where: 'On the job', name });
  }
  const noteDoorWords = doorWordsOfNotes(notes);
  for (const n of itemsFromNotes(notes)) {
    const found = thingsIn(n.label, null, kits);
    if (!found.length) {
      // not a thing we know: one box, unless an invoice or job line already has those words
      const w = words(n.label).trim().split(' ').filter((x) => x.length > 2).map((x) => x.replace(/s$/, ''));
      const seen = [...singles.map((s) => words(s.name)), ...mentions.map((m) => words(m.name))];
      if (w.length && seen.some((d) => w.every((x) => d.includes(` ${x}`)))) continue;
      singles.push({ key: `n:${slug(n.label)}`, name: n.label, qty: null, unit: null, where: 'Not on an invoice yet', source: 'notes' });
      continue;
    }
    for (const f of found) mentions.push({ ...f, source: 'notes', where: 'Not on an invoice yet', name: n.label });
  }

  // Which door this job is: a door kind named anywhere, else what the motor line or the notes say.
  const kinds = ['sectional', 'tilt', 'roller'];
  let doorKind = kinds.find((k) => mentions.some((m) => m.type === k)) || mentions.map((m) => m.doorContext).find(Boolean) || null;
  if (!doorKind) for (const [k, re] of DOOR_KIND) if (re.test(noteDoorWords.toLowerCase())) { doorKind = k; break; }
  // a plain "Door" is that door
  for (const m of mentions) if (m.type === 'door' && doorKind) m.type = doorKind;

  // the same thing from several places is one item: the invoice says where to get it, else the job line, else the notes
  const byType = new Map();
  for (const m of mentions) { if (!byType.has(m.type)) byType.set(m.type, []); byType.get(m.type).push(m); }
  const lowHeadroom = byType.has('low_headroom');
  const choice = ticks.has('o:drive-belt') ? 'belt' : ticks.has('o:drive-chain') ? 'chain' : null;
  const items = [];
  let drive = null;
  for (const [type, ms] of byType) {
    if (type === 'low_headroom' && (byType.has('sectional'))) continue; // a part of the sectional door
    const best = Math.min(...ms.map((m) => SRC[m.source]));
    const use = ms.filter((m) => SRC[m.source] === best);
    const qs = use.map((m) => m.qty).filter((q) => q != null);
    const qty = qs.length ? qs.reduce((a, b) => a + b, 0) : null;
    const first = use[0];
    const kit = first.kit;
    const key = kit ? `t:k${kit.id}` : `t:${type}`;
    const def = BY_TYPE[type];
    const detail = [...new Set(use.map((m) => m.name).filter((n) => n && words(n).trim() !== words(def?.name || kit?.name).trim()))];
    let parts = [];
    if (kit) parts = (kit.parts || []).map((p, i) => ({ key: `${key}:${i}`, ...p }));
    else if (PARTS[type]) {
      parts = PARTS[type].map((p) => ({ key: `${key}:${p.slug}`, name: p.name, ...(p.qty ? { qty: p.qty } : {}) }));
      if (type === 'sectional' && lowHeadroom) parts.push({ key: `${key}:low-headroom`, name: 'Low headroom kit' });
    } else if (type === 'motor') {
      parts = [{ key: `${key}:box`, name: 'Motor box' }];
      if (doorKind !== 'roller') {
        drive = choice || driveOf(ms.map((m) => `${m.name} ${m.text}`), settings);
        parts.push({ key: `${key}:track`, name: drive ? `${drive === 'belt' ? 'Belt' : 'Chain'} track` : 'Track – chain or belt?', drive: drive || null, chooseDrive: true,
          ...(doorKind ? {} : { optional: true, note: 'not for a roller door' }) });
      }
    }
    items.push({ key, type, name: kit ? kit.name : def.name, detail: detail.join(' · ') || null, qty, unit: first.unit || null, where: first.where,
      source: first.source, invoice: first.invoice || null, kit: kit ? kit.name : null, parts, model: type === 'motor' ? modelOf(ms.map((m) => m.name).join(' ')) : undefined });
  }
  // the built-in order (doors, then the motor and its bits, then the rest), then what we don't know, then by hand
  const rank = (it) => { const i = ['sectional', 'tilt', 'roller', 'door', 'motor'].indexOf(it.type); return i >= 0 ? i : 10 + ITEMS.findIndex((x) => x.type === it.type); };
  items.sort((a, b) => rank(a) - rank(b));
  items.push(...singles.map((x) => ({ ...x, parts: [] })));
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
  // grouped by where to collect: suppliers first, then our stock, then on the job, then not invoiced yet, then added by hand
  const order = (w) => (w === 'Our stock' ? 1 : w === 'On the job' ? 2 : w === 'Not on an invoice yet' ? 3 : w === 'Added by hand' ? 4 : 0);
  const groups = [];
  for (const it of items) {
    let g = groups.find((x) => x.title === it.where);
    if (!g) { g = { title: it.where, kind: ['supplier', 'stock', 'job', 'notes', 'manual'][order(it.where)], items: [] }; groups.push(g); }
    g.items.push(it);
  }
  groups.sort((a, b) => order(a.title) - order(b.title) || a.title.localeCompare(b.title));
  return { groups, progress: { picked, total }, doorKind, drive };
}

/** Every key that "Tick all" ticks (required parts, and items without parts). */
function allKeys(list) {
  const keys = [];
  for (const g of list.groups) for (const it of g.items) {
    if (it.parts.length) for (const p of it.parts) { if (!p.optional) keys.push(p.key); } else keys.push(it.key);
  }
  return keys;
}

/** The built-in items and their boxes, for the settings page. */
function catalogue() {
  return ITEMS.filter((i) => i.type !== 'door').map((i) => ({ type: i.type, name: i.name,
    parts: i.type === 'motor' ? ['Motor box', 'Track – chain or belt (sectional / tilt doors)'] : (PARTS[i.type] || []).map((p) => `${p.qty ? p.qty + ' × ' : ''}${p.name}`)
      .concat(i.type === 'sectional' ? ['Low headroom kit (when the job asks for one)'] : []) }));
}

module.exports = { ITEMS, buildPickList, matchKit, parsePart, itemsFromNotes, thingsIn, driveOf, modelOf, allKeys, catalogue };
