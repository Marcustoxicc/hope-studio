// 🏁 CAR MEET SCOREBOARD part of Hope Studio. You run a Motorfest / GTA car meet from his phone;
// the leaderboard + "on stage" card + winner reveal show on stream as an OBS Browser Source (overlay.html). Saved to meets.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FILE = path.join(__dirname, 'meets.json');
const DEFAULT_CATS = [
  { key: 'look', name: 'Look / stance', weight: 1 },
  { key: 'livery', name: 'Livery / wrap', weight: 1 },
  { key: 'wheels', name: 'Wheels + fitment', weight: 1 },
  { key: 'theme', name: 'Fits the theme', weight: 1 },
  { key: 'chat', name: 'Chat vote', weight: 1 },
];
let db = { meets: [], activeId: null };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 1)); fs.renameSync(tmp, FILE); };
const id = () => crypto.randomBytes(4).toString('hex');
const str = (v, n = 60) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n).trim();
const score = (v) => { const n = Math.round(Number(v) * 10) / 10; return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : null; };
function active() { return db.meets.find((m) => m.id === db.activeId) || null; }
function total(meet, e) {
  let sum = 0, w = 0;
  for (const c of meet.cats) { const s = e.scores[c.key]; if (s !== null && s !== undefined) { sum += s * c.weight; w += c.weight; } }
  return w ? Math.round((sum / w) * 100) / 100 : null; // weighted average out of 10 over the categories scored so far
}
function hall() {
  const by = {};
  for (const m of db.meets) { if (!m.winner) continue; const k = m.winner.player; const p = by[k] = by[k] || { player: k, wins: 0, best: 0, cars: [] }; p.wins++; p.best = Math.max(p.best, m.winner.total || 0); if (m.winner.car && !p.cars.includes(m.winner.car)) p.cars.push(m.winner.car); }
  return { champs: Object.values(by).sort((a, b) => b.wins - a.wins || b.best - a.best).slice(0, 10), meets: db.meets.filter((m) => m.winner).length, on: !!db.hallOn };
}
function view() {
  const m = active();
  if (!m) return { hall: hall(), meet: null, history: db.meets.slice(-10).reverse().map((x) => ({ id: x.id, title: x.title, at: x.at, winner: x.winner || null })) };
  const entries = m.entries.map((e) => ({ ...e, total: total(m, e) }));
  const ranked = entries.filter((e) => e.total !== null).sort((a, b) => b.total - a.total);
  return { hall: hall(), meet: { ...m, entries, ranked }, history: db.meets.slice(-10).reverse().map((x) => ({ id: x.id, title: x.title, at: x.at, winner: x.winner || null })) };
}
function handle(m) {
  const cur = active();
  switch (m.a) {
    case 'meet:new': {
      const cats = Array.isArray(m.cats) && m.cats.length ? m.cats.slice(0, 8).map((c, i) => ({ key: 'c' + i, name: str(c.name, 30) || 'Category', weight: Math.min(3, Math.max(0.5, Number(c.weight) || 1)) })) : DEFAULT_CATS;
      const meet = { id: id(), title: str(m.title, 50) || 'Car Meet', theme: str(m.theme, 80), game: str(m.game, 30) || 'Motorfest', at: Date.now(), cats, entries: [], stage: null, reveal: false, winner: null, ended: false };
      db.meets.push(meet); db.meets = db.meets.slice(-50); db.activeId = meet.id; break;
    }
    case 'meet:open': if (db.meets.some((x) => x.id === m.id)) db.activeId = m.id; break;
    case 'meet:close': db.activeId = null; break;
    case 'meet:hall': db.hallOn = !!m.on; break;
    case 'meet:add': if (cur && cur.entries.length < 40) { const e = { id: id(), player: str(m.player, 30) || 'Player', car: str(m.car, 50), scores: {} }; cur.entries.push(e); cur.stage = e.id; } break;
    case 'meet:remove': if (cur) { cur.entries = cur.entries.filter((e) => e.id !== m.id); if (cur.stage === m.id) cur.stage = null; } break;
    case 'meet:stage': if (cur && (m.id === null || cur.entries.some((e) => e.id === m.id))) { cur.stage = m.id; cur.reveal = false; } break;
    case 'meet:score': if (cur) { const e = cur.entries.find((x) => x.id === m.id); const c = cur.cats.find((x) => x.key === m.cat); if (e && c) e.scores[c.key] = m.v === null ? null : score(m.v); } break;
    case 'meet:reveal': if (cur) { const v = view().meet; const w = v.ranked[0]; cur.reveal = !!m.on && !!w; cur.winner = w ? { player: w.player, car: w.car, total: w.total } : null; if (cur.reveal) cur.stage = null; } break;
    case 'meet:end': if (cur) { const v = view().meet; const w = v.ranked[0]; cur.winner = w ? { player: w.player, car: w.car, total: w.total } : null; cur.ended = true; cur.reveal = !!w; } break;
    default: return false;
  }
  save(); return true;
}
module.exports = { handle, view };
