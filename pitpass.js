// 🎟️ HOPE PIT PASS part of Hope Studio. Chat requests a CARD (car / route / challenge) → the streamer (or a mod)
// adds it from the phone → queue + live turn timer + result show on stream (overlay.html).
// Rules: open to EVERYONE (never "follow to request"), 1 request per person, max 5 queued, 2-min turns,
// no paid priority, no music. Saved to pit.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FILE = path.join(__dirname, 'pit.json');
const DEFAULT_CARDS = [
  ['car', 'Chat picks my car', 'I drive whatever car the requester names next.'],
  ['car', 'Slowest car in the garage', 'One race / one cruise in my slowest car.'],
  ['car', 'Dream build speedrun', 'Build the requester\'s dream car in under 3 minutes.'],
  ['car', 'Color swap', 'The requester picks my car\'s color + wheels.'],
  ['route', 'GPS by chat', 'Every turn = the requester\'s call (left / right / straight).'],
  ['route', 'Scenic route home', 'No highways. Back roads only to the next marker.'],
  ['route', 'Mystery drop', 'Requester picks a spot on the map, I drive there.'],
  ['route', 'Longest way round', 'Go to the finish the longest possible way.'],
  ['challenge', 'Cockpit cam only', 'Next race / 2 min in cockpit view.'],
  ['challenge', 'No minimap', 'Hide the minimap, find my way by eye.'],
  ['challenge', 'Drift king', 'Hold a drift as long as I can: best of 3.'],
  ['challenge', 'Last-place start', 'Start from the back and win it.'],
  ['challenge', 'Top speed run', 'Max speed on a straight. Beat the last record.'],
  ['challenge', 'Clean lap', 'One full lap/route with zero crashes.'],
  ['challenge', 'Traffic rules', 'Stop at lights, use lanes, no speeding for 2 min.'],
  ['challenge', 'Photo shoot', 'Best photo-mode shot of the current car. Chat rates it.'],
  ['challenge', 'Reverse gear', 'Drive 30 seconds in reverse without crashing.'],
  ['challenge', 'One-word commentary', 'Narrate the next 2 min one word at a time.'],
  ['challenge', 'Pit stop', 'Change the whole build in 60 seconds.'],
  ['challenge', 'Twin call', 'Hope picks: I do what my AI twin calls (labeled AI).'],
].map(([kind, title, rule]) => ({ id: crypto.randomBytes(3).toString('hex'), kind, title, rule }));
let db = { cards: DEFAULT_CARDS, queue: [], active: null, history: [], turnSec: 120, max: 5, open: true };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const save = () => { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 1)); fs.renameSync(t, FILE); };
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n).trim();
const id = () => crypto.randomBytes(4).toString('hex');
const norm = (s) => s.toLowerCase().replace(/^@/, '').trim();
let flash = null; // {text, kind, at}
function view() {
  const counts = {};
  for (const h of db.history) counts[h.viewer] = (counts[h.viewer] || 0) + 1;
  const regulars = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([viewer, n]) => ({ viewer, n }));
  const per = {};
  for (const h of db.history) { const p = per[h.viewer] = per[h.viewer] || { viewer: h.viewer, n: 0, done: 0, last: 0 }; p.n++; if (h.result === 'done') p.done++; p.last = Math.max(p.last, h.at); }
  const weekAgo = Date.now() - 7 * 864e5;
  const top = Object.values(per).sort((a, b) => b.n - a.n || b.done - a.done).slice(0, 10);
  const week = Object.values(db.history.filter((h) => h.at >= weekAgo).reduce((m, h) => { (m[h.viewer] = m[h.viewer] || { viewer: h.viewer, n: 0 }).n++; return m; }, {})).sort((a, b) => b.n - a.n).slice(0, 5);
  const cardCount = Object.values(db.history.reduce((m, h) => { (m[h.title] = m[h.title] || { title: h.title, n: 0, done: 0 }).n++; if (h.result === 'done') m[h.title].done++; return m; }, {})).sort((a, b) => b.n - a.n).slice(0, 8);
  const season = { total: db.history.length, done: db.history.filter((h) => h.result === 'done').length, top, week, cards: cardCount };
  return { pit: { cards: db.cards, queue: db.queue, active: db.active, history: db.history.slice(-15).reverse(), turnSec: db.turnSec, max: db.max, open: db.open, regulars, flash, season } };
}
function handle(m) {
  let err = '';
  switch (m.a) {
    case 'pit:request': {
      const viewer = str(m.viewer, 30).replace(/^@/, '');
      const card = db.cards.find((c) => c.id === m.card);
      const custom = str(m.custom, 80);
      if (!viewer) { err = 'Type the viewer\'s name.'; break; }
      if (!card && !custom) { err = 'Pick a card.'; break; }
      if (!db.open) { err = 'Pit Pass is closed. Open it first.'; break; }
      if (db.queue.length >= db.max) { err = `Queue is full (${db.max}). Finish a turn first.`; break; }
      const busy = [...db.queue, db.active].filter(Boolean).some((q) => norm(q.viewer) === norm(viewer));
      if (busy) { err = `${viewer} already has a request in. One at a time.`; break; }
      db.queue.push({ id: id(), viewer, title: card ? card.title : custom, rule: card ? card.rule : '', kind: card ? card.kind : 'custom', at: Date.now() });
      break;
    }
    case 'pit:start': {
      if (db.active) { err = 'Finish the current turn first.'; break; }
      const i = m.id ? db.queue.findIndex((q) => q.id === m.id) : 0;
      if (i < 0 || !db.queue.length) { err = 'Queue is empty.'; break; }
      db.active = { ...db.queue.splice(i, 1)[0], started: Date.now(), ends: Date.now() + db.turnSec * 1000 };
      break;
    }
    case 'pit:extend': if (db.active) db.active.ends += 30000; break;
    case 'pit:verdict': {
      if (!db.active) break;
      const result = ['done', 'failed', 'skipped'].includes(m.v) ? m.v : 'skipped';
      db.history.push({ viewer: db.active.viewer, title: db.active.title, result, at: Date.now() });
      db.history = db.history.slice(-300);
      flash = { text: result === 'done' ? `✅ ${db.active.title}: DONE for ${db.active.viewer}!` : result === 'failed' ? `❌ ${db.active.title}: failed. Run it back?` : `⏭ Skipped`, kind: result, at: Date.now() };
      db.active = null; setTimeout(() => { flash = null; }, 6000);
      break;
    }
    case 'pit:shoutout': {
      const v = str(m.viewer, 30); const n = db.history.filter((h) => h.viewer === v).length;
      if (!v || !n) { err = 'No Pit Pass history for that viewer yet.'; break; }
      flash = { text: `🏆 Shout-out: ${v}, ${n} Pit Pass${n > 1 ? 'es' : ''}! Real one.`, kind: 'shout', at: Date.now() }; setTimeout(() => { flash = null; }, 6000);
      break;
    }
    case 'pit:remove': db.queue = db.queue.filter((q) => q.id !== m.id); break;
    case 'pit:up': { const i = db.queue.findIndex((q) => q.id === m.id); if (i > 0) [db.queue[i - 1], db.queue[i]] = [db.queue[i], db.queue[i - 1]]; break; }
    case 'pit:open': db.open = !!m.v; break;
    case 'pit:settings': db.turnSec = Math.min(600, Math.max(30, Number(m.turnSec) || 120)); db.max = Math.min(10, Math.max(1, Number(m.max) || 5)); break;
    case 'pit:addcard': { const t = str(m.title, 40); if (t && db.cards.length < 40) db.cards.push({ id: id(), kind: ['car', 'route', 'challenge'].includes(m.kind) ? m.kind : 'challenge', title: t, rule: str(m.rule, 100) }); break; }
    case 'pit:delcard': db.cards = db.cards.filter((c) => c.id !== m.id); break;
    case 'pit:resetcards': db.cards = DEFAULT_CARDS; break;
    default: return { ok: false };
  }
  if (!err) save();
  return { ok: true, err };
}
module.exports = { handle, view };
