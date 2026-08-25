// scripts/build-rankings.mjs
//
// Blends free public sources into data/rankings.json.
// Runs in GitHub Actions (cron + manual "Run workflow"). No secrets required —
// none of these sources need authentication.
//
// Sources: Sleeper (player master + IDs), FantasyFootballCalculator (ADP),
//          FantasyCalc (values), Sleeper projections (optional, undocumented).
//
// Node 20+ (has global fetch). No npm install needed.

import { writeFileSync, mkdirSync } from "node:fs";

const SEASON  = Number(process.env.SEASON  || new Date().getFullYear());
const SCORING = (process.env.SCORING || "ppr").toLowerCase();   // ppr | half-ppr | standard
const TEAMS   = Number(process.env.TEAMS   || 12);
const NUM_QBS = Number(process.env.NUM_QBS || 1);
const PPR = SCORING === "standard" ? 0 : SCORING === "half-ppr" ? 0.5 : 1;

// ---------- name / position normalisation (the cross-source glue) ----------
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const normName = (s = "") =>
  s.toLowerCase().replace(/\./g, " ").replace(/'/g, "").replace(/-/g, " ")
   .split(/\s+/).filter(w => w && !SUFFIXES.has(w)).join(" ").trim();
const normPos = (p = "") => {
  p = p.toUpperCase().trim();
  if (["DEF", "D/ST", "DST"].includes(p)) return "DST";
  if (p === "PK") return "K";
  return p;
};
const POSSET = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---------------- Sleeper master: join backbone ----------------
async function sleeperMaster() {
  const data = await getJSON("https://api.sleeper.app/v1/players/nfl");
  const players = [], byName = new Map(), bySleeper = new Map();
  for (const [sid, pl] of Object.entries(data)) {
    const pos = normPos((pl.fantasy_positions?.[0]) || pl.position || "");
    if (!POSSET.has(pos)) continue;
    const name = pos === "DST"
      ? `${pl.team || sid} DST`
      : (pl.full_name || `${pl.first_name || ""} ${pl.last_name || ""}`.trim());
    if (!name) continue;
    const p = {
      sleeper_id: sid,
      espn_id: pl.espn_id ? String(pl.espn_id) : null,
      name, pos, team: pl.team || "",
      ranks: {}, adp: {}, proj: {},
    };
    players.push(p);
    bySleeper.set(sid, p);
    byName.set(`${normName(name)}|${pos}`, p);
  }
  return { players, byName, bySleeper };
}

// ---------------- FantasyFootballCalculator ADP ----------------
async function ffcADP(idx) {
  const fmt = SCORING === "standard" ? "standard" : SCORING === "half-ppr" ? "half-ppr" : "ppr";
  const teams = [8, 10, 12, 14].includes(TEAMS) ? TEAMS : 12;
  try {
    const j = await getJSON(`https://fantasyfootballcalculator.com/api/v1/adp/${fmt}?teams=${teams}&year=${SEASON}`);
    (j.players || []).forEach((pl, i) => {
      const p = idx.byName.get(`${normName(pl.name)}|${normPos(pl.position)}`);
      if (!p) return;
      p.ranks.ffc = i + 1;
      p.adp.ffc = pl.adp;
    });
    console.log(`[ffc] ${(j.players || []).length} ADP rows (${fmt}, ${teams}-team)`);
  } catch (e) { console.error("[ffc]", e.message); }
}

// ---------------- FantasyCalc values (carries sleeperId) ----------------
async function fantasyCalc(idx) {
  try {
    const rows = await getJSON(
      `https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=${NUM_QBS}&numTeams=${TEAMS}&ppr=${PPR}`);
    let n = 0;
    for (const row of rows) {
      const pl = row.player || {};
      let p = pl.sleeperId ? idx.bySleeper.get(String(pl.sleeperId)) : null;
      if (!p) p = idx.byName.get(`${normName(pl.name)}|${normPos(pl.position)}`);
      if (!p) continue;
      p.ranks.fcalc = row.overallRank;
      n++;
    }
    console.log(`[fantasycalc] matched ${n}/${rows.length}`);
  } catch (e) { console.error("[fantasycalc]", e.message); }
}

// ---------------- Sleeper projections (undocumented, optional) ----------------
async function sleeperProj(idx) {
  const url = `https://api.sleeper.app/projections/nfl/${SEASON}?season_type=regular` +
    `&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF`;
  try {
    const data = await getJSON(url);
    if (!Array.isArray(data)) { console.error("[proj] unexpected shape — skipping"); return; }
    let n = 0;
    for (const row of data) {
      const p = idx.bySleeper.get(String(row.player_id));
      if (!p) continue;
      const s = row.stats || {};
      const pts = PPR >= 1 ? s.pts_ppr : PPR === 0.5 ? s.pts_half_ppr : s.pts_std;
      if (pts) { p.proj.sleeper = Number(pts); n++; }
    }
    console.log(`[proj] ${n} projections`);
  } catch (e) { console.error("[proj] skipped —", e.message); }
}

// ---------------- blend + tiers ----------------
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = a => { if (a.length < 2) return 0; const m = median(a);
  return median(a.map(v => Math.abs(v - m))); };

function blend(players) {
  const ranked = players.filter(p => Object.keys(p.ranks).length);
  const maxRank = Math.max(300, ...ranked.map(p => Math.max(...Object.values(p.ranks))));
  for (const p of players) {
    const sv = {};
    for (const [src, rk] of Object.entries(p.ranks))
      if (rk) sv[src] = Math.max(0, (maxRank - rk) / maxRank * 100);
    const vals = Object.values(sv);
    if (!vals.length) { p.value = 0; p.spread = 0; p.outliers = []; continue; }
    const med = median(vals), md = mad(vals);
    let outliers = [];
    if (md > 0 && vals.length >= 3) {
      // drop any source > 3 MADs from the median, then re-median (outlier guard)
      outliers = Object.entries(sv).filter(([, v]) => Math.abs(v - med) > 3 * md).map(([s]) => s);
      const robust = Object.entries(sv).filter(([s]) => !outliers.includes(s)).map(([, v]) => v);
      p.value = robust.length ? median(robust) : med;
    } else p.value = med;
    p.spread = md;
    p.outliers = outliers;
    const projs = Object.values(p.proj);
    p.proj_pts = projs.length ? Number((projs.reduce((a, b) => a + b, 0) / projs.length).toFixed(1)) : null;
  }
}

function tiers(players) {
  const byPos = {};
  players.forEach(p => (byPos[p.pos] ??= []).push(p));
  for (const pos in byPos) {
    const arr = byPos[pos].filter(p => p.value > 0).sort((a, b) => b.value - a.value);
    let tier = 1;
    for (let i = 0; i < arr.length; i++) {
      if (i > 0 && arr[i - 1].value - arr[i].value > 6) tier++;   // 6-pt gap = new tier
      arr[i].tier = tier;
    }
  }
}

async function main() {
  const idx = await sleeperMaster();
  console.log(`[sleeper] ${idx.players.length} fantasy players`);
  await Promise.all([ffcADP(idx), fantasyCalc(idx)]);
  await sleeperProj(idx);
  blend(idx.players);
  tiers(idx.players);

  const out = idx.players
    .filter(p => p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 400)
    .map(p => ({
      name: p.name, pos: p.pos, team: p.team,
      sleeper_id: p.sleeper_id, espn_id: p.espn_id,
      value: Number(p.value.toFixed(1)),
      spread: Number(p.spread.toFixed(1)),
      proj_pts: p.proj_pts, tier: p.tier || null,
      adp: p.adp.ffc ?? null,
      sources: Object.keys(p.ranks),
      outliers: p.outliers,
    }));

  mkdirSync("data", { recursive: true });
  writeFileSync("data/rankings.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    season: SEASON, scoring: SCORING, teams: TEAMS, numQbs: NUM_QBS,
    count: out.length, players: out,
  }));
  console.log(`wrote data/rankings.json (${out.length} players)`);
}

main().catch(e => { console.error(e); process.exit(1); });
