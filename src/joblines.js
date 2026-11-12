/**
 * The job's line items in ServiceM8 (what the job is sold with: door, motor, posts, flashing…) against
 * the costs on the job in Job Costs: which lines already have a cost, and which have none yet (those can be
 * pulled from a stock invoice).
 *
 * Lines and costs are compared by kind of thing: words that mean the same (motor / opener / operator) are one
 * kind. A cost counts as one kind (its main one), so "Opener for roller door" covers a motor, not a door;
 * a job line can need several kinds ("Sectional door supply and install with motor" needs a door and a motor).
 */

// Kinds of things, most specific first (a "post cover" isn't a "post").
const KINDS = [
  ['post cover', /post\s*covers?|cover\s*(for\s*)?posts?/],
  ['motor', /\b(motor|motors|opener|openers|operator|gdo|automation|automate[ds]?)\b/],
  ['remote', /\b(remotes?|transmitters?|handsets?|fobs?)\b/],
  ['keypad', /\b(keypads?|wireless\s*keypad)\b/],
  ['sensor', /\b(sensors?|safety\s*beams?|photo\s*(eyes?|beams?|electric))\b/],
  ['battery', /\b(battery|batteries|battery\s*back\s*up|backup\s*battery)\b/],
  ['flashing', /\b(flashings?|head(er)?\s*flash)/],
  ['post', /\b(posts?|uprights?|jambs?)\b/],
  ['track', /\b(tracks?|rails?)\b/],
  ['spring', /\bsprings?\b/],
  ['lintel', /\b(lintels?|header\s*beams?|steel\s*beams?)\b/],
  ['seal', /\b(seals?|weather\s*strips?|brush(es)?)\b/],
  ['door', /\b(doors?|roller|sectional|panel\s*lift|tilt|curtain|panels?)\b/],
];
// Lines that aren't things (no cost to look for).
const NOT_A_THING = /labou?r|install(ation)?\b|fitting\b|fit\s*off|delivery|freight|travel|call\s*out|callout|removal|remove|disposal|dispose|discount|deposit|partial\s*invoice|service\s*fee|admin|surcharge|warranty|inspection|quote/i;

const kindsOf = (text) => {
  const t = ` ${String(text || '').toLowerCase()} `;
  const out = [];
  let rest = t;
  for (const [kind, re] of KINDS) if (re.test(rest)) { out.push(kind); if (kind === 'post cover') rest = rest.replace(re, ' '); }
  return out;
};
/** A cost's main kind: the most specific one it mentions. */
const mainKind = (text) => kindsOf(text)[0] || null;

/**
 * lines: ServiceM8 job lines [{ uuid, name, qty, price }]
 * costs: [{ key, description, kind?, invoice: { id, supplier, invoice_number }, stock }]
 * flags: Set of line uuids marked "no cost needed"
 * → [{ uuid, name, qty, price, kinds, status: 'covered' | 'missing' | 'not_needed', covered_by: [...] }]
 */
function matchLines(lines, costs, flags = new Set()) {
  const byKind = new Map();
  for (const c of costs) {
    const k = c.kind || mainKind(c.description);
    if (!k) continue;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(c);
  }
  const out = [];
  for (const l of lines || []) {
    const name = String(l.name || '').trim();
    if (!name || NOT_A_THING.test(name) && !kindsOf(name.replace(NOT_A_THING, ' ')).length) continue;
    const kinds = kindsOf(name.replace(/supply\s*(and|&)\s*install(ation)?/i, ' '));
    if (!kinds.length) continue; // e.g. "Misc" – nothing to match it with
    const covered = kinds.every((k) => byKind.has(k));
    const coveredBy = [...new Map(kinds.flatMap((k) => byKind.get(k) || []).map((c) => [c.key, c])).values()];
    out.push({ uuid: l.uuid, name, qty: l.qty ?? null, price: l.price ?? null, kinds,
      status: flags.has(l.uuid) ? 'not_needed' : covered ? 'covered' : 'missing',
      missing_kinds: kinds.filter((k) => !byKind.has(k)), covered_by: coveredBy });
  }
  return out;
}

module.exports = { matchLines, kindsOf, mainKind, KINDS };
