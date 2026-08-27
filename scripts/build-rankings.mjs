// scripts/build-rankings.mjs
//
// Blends free public sources into data/rankings.json and scores offense + IDP
// to THIS LEAGUE's exact rules from Sleeper's raw stat projections.
// Runs in GitHub Actions (cron + manual). No secrets required. Node 20+.
//
// Ranking logic:
//   offense / D-ST / K : market consensus value (FFC ADP + FantasyCalc)
//   offense proj_pts   : computed to league scoring (drives VOR)
//   IDP                : ranked by league-scored projected points (no ADP exists)

import { writeFileSync, mkdirSync } from "node:fs";

const SEASON  = Number(process.env.SEASON  || new Date().getFullYear());
const SCORING = (process.env.SCORING || "ppr").toLowerCase();
const TEAMS   = Number(process.env.TEAMS   || 12);
const NUM_QBS = Number(process.env.NUM_QBS || 1);
const PPR = SCORING === "standard" ? 0 : SCORING === "half-ppr" ? 0.5 : 1;

// ---------- LEAGUE SCORING (Yukon End Zone Experts) ----------
const SC_OFF = {
  pass_yd:0.04, pass_td:4, pass_int:-2, pass_2pt:2,
  rush_yd:0.1, rush_td:6, rush_2pt:2,
  rec:1, rec_yd:0.1, rec_td:6, rec_2pt:2, fum_lost:-2,
};
// IDP big-play weights (tackles handled separately for the solo/assist split)
const SC_IDP = {
  idp_sack:4, idp_int:5, idp_fum_rec:4, idp_ff:4, idp_safe:2, idp_blk_kick:2, idp_pass_def:1.5,
};
const TKL_SOLO = 1.5, TKL_AST = 0.75;
const SOLO_SPLIT = 0.62;   // fallback ratio, used only if solo/assist aren't projected separately

// candidate Sleeper stat-field names (projections endpoint is undocumented — tolerate variants)
const KEYS = {
  pass_yd:["pass_yd"], pass_td:["pass_td"], pass_int:["pass_int"], pass_2pt:["pass_2pt"],
  rush_yd:["rush_yd"], rush_td:["rush_td"], rush_2pt:["rush_2pt"],
  rec:["rec"], rec_yd:["rec_yd"], rec_td:["rec_td"], rec_2pt:["rec_2pt"], fum_lost:["fum_lost"],
  idp_sack:["idp_sack"], idp_int:["idp_int"], idp_fum_rec:["idp_fum_rec","idp_fumble_rec"],
  idp_ff:["idp_ff"], idp_safe:["idp_safe","idp_sfty"], idp_blk_kick:["idp_blk_kick"],
  idp_pass_def:["idp_pass_def","idp_pass_defended","idp_pd"],
  idp_tkl_solo:["idp_tkl_solo","idp_solo_tkl"], idp_tkl_ast:["idp_tkl_ast","idp_ast_tkl"],
  idp_tkl:["idp_tkl","idp_tackle"],
};
const val  = (s,c)=>{ for (const k of (KEYS[c]||[c])) if (typeof s[k]==="number") return s[k]; return 0; };
const has  = (s,c)=> (KEYS[c]||[c]).some(k=>typeof s[k]==="number");

// ---------- normalisation ----------
const SUFFIXES = new Set(["jr","sr","ii","iii","iv","v"]);
const normName = (s="") => s.toLowerCase().replace(/\./g," ").replace(/'/g,"").replace(/-/g," ")
  .split(/\s+/).filter(w=>w && !SUFFIXES.has(w)).join(" ").trim();
const normPos = (p="") => { p=p.toUpperCase().trim();
  if (["DEF","D/ST","DST"].includes(p)) return "DST"; if (p==="PK") return "K"; return p; };
const OFF = new Set(["QB","RB","WR","TE","K"]);
const IDP = new Set(["DL","DE","DT","LB","DB","CB","S","EDGE","NT"]);
const OFF_SCORED = new Set(["QB","RB","WR","TE"]);

const NFL = {
  cardinals:"ARI",arizona:"ARI",falcons:"ATL",atlanta:"ATL",ravens:"BAL",baltimore:"BAL",
  bills:"BUF",buffalo:"BUF",panthers:"CAR",carolina:"CAR",bears:"CHI",chicago:"CHI",
  bengals:"CIN",cincinnati:"CIN",browns:"CLE",cleveland:"CLE",cowboys:"DAL",dallas:"DAL",
  broncos:"DEN",denver:"DEN",lions:"DET",detroit:"DET",packers:"GB","green bay":"GB",
  texans:"HOU",houston:"HOU",colts:"IND",indianapolis:"IND",jaguars:"JAX",jacksonville:"JAX",
  chiefs:"KC","kansas city":"KC",raiders:"LV","las vegas":"LV",oakland:"LV",
  chargers:"LAC","los angeles chargers":"LAC",rams:"LAR","los angeles rams":"LAR",
  dolphins:"MIA",miami:"MIA",vikings:"MIN",minnesota:"MIN",patriots:"NE","new england":"NE",
  saints:"NO","new orleans":"NO","new york giants":"NYG",giants:"NYG",
  "new york jets":"NYJ",jets:"NYJ",eagles:"PHI",philadelphia:"PHI",steelers:"PIT",pittsburgh:"PIT",
  "49ers":"SF","san francisco":"SF",niners:"SF",seahawks:"SEA",seattle:"SEA",
  buccaneers:"TB","tampa bay":"TB",bucs:"TB",titans:"TEN",tennessee:"TEN",
  commanders:"WAS",washington:"WAS",
};
function dstAbbrev(name){ const n=normName(name); if (NFL[n]) return NFL[n];
  for (const k in NFL) if (n.includes(k)) return NFL[k]; return null; }

async function getJSON(url,opts){ const r=await fetch(url,opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

// ---------------- Sleeper master ----------------
async function sleeperMaster(){
  const data = await getJSON("https://api.sleeper.app/v1/players/nfl");
  const players=[], byName=new Map(), bySleeper=new Map(), byTeamDST=new Map();
  for (const [sid,pl] of Object.entries(data)){
    const raw = normPos((pl.fantasy_positions?.[0]) || pl.position || "");
    let pos,dpos=null,idp=false;
    if (raw==="DST") pos="DST";
    else if (OFF.has(raw)) pos=raw;
    else if (IDP.has(raw)){ pos="DP"; dpos=raw; idp=true; }
    else continue;
    const name = pos==="DST" ? `${pl.team||sid} DST`
      : (pl.full_name || `${pl.first_name||""} ${pl.last_name||""}`.trim());
    if (!name) continue;
    const p={ sleeper_id:sid, espn_id: pl.espn_id?String(pl.espn_id):null,
      name,pos,dpos,idp, team:pl.team||"",
      search_rank:(typeof pl.search_rank==="number")?pl.search_rank:null,
      injStatus:pl.injury_status||null, status:pl.status||null,
      ranks:{}, adp:{}, projStats:null, proj_pts:null };
    players.push(p); bySleeper.set(sid,p);
    if (pos==="DST") byTeamDST.set((pl.team||sid).toUpperCase(),p);
    else byName.set(`${normName(name)}|${pos==="DP"?dpos:pos}`,p);
  }
  return { players, byName, bySleeper, byTeamDST };
}

// ---------------- FFC ADP ----------------
async function ffcADP(idx){
  const fmt = SCORING==="standard"?"standard":SCORING==="half-ppr"?"half-ppr":"ppr";
  const teams = [8,10,12,14].includes(TEAMS)?TEAMS:12;
  try{
    const j = await getJSON(`https://fantasyfootballcalculator.com/api/v1/adp/${fmt}?teams=${teams}&year=${SEASON}`);
    let dst=0;
    (j.players||[]).forEach((pl,i)=>{
      const pos=normPos(pl.position); let p;
      if (pos==="DST"){ p=idx.byTeamDST.get(dstAbbrev(pl.name)||(pl.team||"").toUpperCase()); if(p) dst++; }
      else p=idx.byName.get(`${normName(pl.name)}|${pos}`);
      if(!p) return; p.ranks.ffc=i+1; p.adp.ffc=pl.adp;
    });
    console.log(`[ffc] ${(j.players||[]).length} rows (${fmt}, ${teams}-team), DST matched: ${dst}`);
  }catch(e){ console.error("[ffc]",e.message); }
}

// ---------------- FantasyCalc ----------------
async function fantasyCalc(idx){
  try{
    const rows = await getJSON(`https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=${NUM_QBS}&numTeams=${TEAMS}&ppr=${PPR}`);
    let n=0,dst=0;
    for (const row of rows){
      const pl=row.player||{}; const pos=normPos(pl.position);
      let p = pl.sleeperId ? idx.bySleeper.get(String(pl.sleeperId)) : null;
      if (!p && pos==="DST"){ p=idx.byTeamDST.get(dstAbbrev(pl.name)||""); if(p) dst++; }
      if (!p) p=idx.byName.get(`${normName(pl.name)}|${pos}`);
      if (!p) continue; p.ranks.fcalc=row.overallRank; n++;
    }
    console.log(`[fantasycalc] matched ${n}/${rows.length} (DST: ${dst})`);
  }catch(e){ console.error("[fantasycalc]",e.message); }
}

// ---------------- Sleeper projections (raw stat lines) ----------------
async function sleeperProj(idx){
  const base = `https://api.sleeper.app/projections/nfl/${SEASON}?season_type=regular`;
  const groups = [["QB","RB","WR","TE","K","DEF"], ["DL","LB","DB","DE","DT","CB","S"]];
  for (const g of groups){
    const url = base + g.map(p=>`&position[]=${p}`).join("");
    try{
      const data = await getJSON(url);
      if (!Array.isArray(data)){ console.error("[proj] unexpected shape for",g[0]); continue; }
      let n=0;
      for (const row of data){
        const p = idx.bySleeper.get(String(row.player_id));
        if (p && row.stats){ p.projStats = row.stats; n++; }
      }
      console.log(`[proj] ${n} stat lines for [${g.join(",")}]`);
    }catch(e){ console.error(`[proj] group ${g[0]} failed —`, e.message); }
  }
}

// ---------------- league scoring ----------------
function scoreLeague(players){
  let idpN=0, splitN=0, offRaw=0, offFb=0;
  let soloSeen=false, astSeen=false, combSeen=false;
  const idpKeys=new Set();
  for (const p of players){
    const s=p.projStats; if(!s) continue;
    if (p.idp){
      const av = (typeof s.adp_idp_1qb==="number") ? s.adp_idp_1qb
               : (typeof s.adp_idp==="number") ? s.adp_idp : null;
      if (av!=null && av>0) p.idpAdp = av;
      for (const k of Object.keys(s)) if(/idp|tkl|sack|int|ff|fum|pass_def|safe|blk/i.test(k)) idpKeys.add(k);
      if (has(s,"idp_tkl_solo")) soloSeen=true;
      if (has(s,"idp_tkl_ast"))  astSeen=true;
      if (has(s,"idp_tkl"))      combSeen=true;
      let pts=0;
      for (const [k,w] of Object.entries(SC_IDP)) pts += val(s,k)*w;
      if (has(s,"idp_tkl_solo") || has(s,"idp_tkl_ast")){
        pts += val(s,"idp_tkl_solo")*TKL_SOLO + val(s,"idp_tkl_ast")*TKL_AST;
      } else if (has(s,"idp_tkl")){
        pts += val(s,"idp_tkl") * (SOLO_SPLIT*TKL_SOLO + (1-SOLO_SPLIT)*TKL_AST);
        splitN++;
      }
      if (pts>0){ p.proj_pts=Number(pts.toFixed(1)); idpN++; }
    } else if (OFF_SCORED.has(p.pos)){
      let pts=0, raw=false;
      for (const [k,w] of Object.entries(SC_OFF)){ const v=val(s,k); if(v) raw=true; pts+=v*w; }
      if (pts<=0 && typeof s.pts_ppr==="number") pts=s.pts_ppr;   // fallback if raw lines absent
      if (pts>0){ p.proj_pts=Number(pts.toFixed(1)); if(raw) offRaw++; else offFb++; }
    }
    // K / DST: consensus ranking — no league scoring
  }
  console.log(`[score] offense: raw-scored ${offRaw}, pts_ppr-fallback ${offFb}`);
  console.log(`[score] IDP scored: ${idpN}${splitN?`, tackle-split estimated for ${splitN}`:``}`);
  console.log(`[score] tackle fields present — solo:${soloSeen} assist:${astSeen} combined:${combSeen}`);
  console.log(`[score] IDP stat keys: ${[...idpKeys].slice(0,40).join(", ")||"(none)"}`);
}

// ---------------- blend (offense/DST/K market value) ----------------
const median = a=>{ const s=[...a].sort((x,y)=>x-y); const m=s.length>>1;
  return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const mad = a=>{ if(a.length<2) return 0; const m=median(a); return median(a.map(v=>Math.abs(v-m))); };

function blend(players){
  const ranked = players.filter(p=>Object.keys(p.ranks).length);
  const maxRank = Math.max(300, ...ranked.map(p=>Math.max(...Object.values(p.ranks))));
  for (const p of players){
    const sv={};
    for (const [src,rk] of Object.entries(p.ranks)) if(rk) sv[src]=Math.max(0,(maxRank-rk)/maxRank*100);
    const vals=Object.values(sv);
    if (!vals.length){ p.value=0; p.spread=0; p.outliers=[]; continue; }
    const med=median(vals), md=mad(vals); let outliers=[];
    if (md>0 && vals.length>=3){
      outliers=Object.entries(sv).filter(([,v])=>Math.abs(v-med)>3*md).map(([s])=>s);
      const robust=Object.entries(sv).filter(([s])=>!outliers.includes(s)).map(([,v])=>v);
      p.value=robust.length?median(robust):med;
    } else p.value=med;
    p.spread=md; p.outliers=outliers;
  }
}

// IDP ranked by league-scored projection (search_rank only as last resort)
function rankIDP(players){
  const idps=players.filter(p=>p.idp); if(!idps.length) return;
  const withProj=idps.filter(p=>p.proj_pts!=null);
  const useProj = withProj.length > 30;   // 459 scored defenders is plenty; the pool has thousands of irrelevant ones
  idps.sort((a,b)=> useProj ? (b.proj_pts||0)-(a.proj_pts||0)
                            : (a.search_rank??1e9)-(b.search_rank??1e9));
  idps.forEach((p,i)=>{ p.value=Math.max(1, 50 - i*0.5); p.idpRank=i+1; });
  console.log(`[idp] ranked ${idps.length} defenders by ${useProj?"league projection":"prominence (no IDP projections)"}`);
}

// Tiers = the N largest relative drop-offs within a position become tier breaks.
// This is scale-free and never collapses to one tier on smooth projection curves.
function assignTiers(arr, metric, N){
  if (!arr.length) return;
  const gaps=[];
  for (let i=1;i<arr.length;i++){ gaps.push({i, g: metric(arr[i-1]) - metric(arr[i])}); }
  const cuts=new Set(gaps.sort((a,b)=>b.g-a.g).slice(0, Math.max(0,N-1)).map(x=>x.i));
  let tier=1;
  arr.forEach((p,i)=>{ if (cuts.has(i)) tier++; p.tier=tier; });
}
function tiers(players){
  const N=10;   // target tiers per position — a Phase-3 tuning knob
  const byPos={}; players.forEach(p=>(byPos[p.pos]??=[]).push(p));
  for (const pos in byPos){
    const scored=byPos[pos].filter(p=>p.proj_pts!=null).sort((a,b)=>b.proj_pts-a.proj_pts);
    assignTiers(scored, p=>p.proj_pts, N);                       // offense + IDP by league points
    const rest=byPos[pos].filter(p=>p.proj_pts==null && p.value>0).sort((a,b)=>b.value-a.value);
    assignTiers(rest, p=>p.value, N);                           // DST + K by consensus value
  }
}

async function main(){
  const idx = await sleeperMaster();
  console.log(`[sleeper] ${idx.players.length} players (incl. IDP + DST)`);
  await Promise.all([ffcADP(idx), fantasyCalc(idx)]);
  await sleeperProj(idx);
  scoreLeague(idx.players);
  blend(idx.players);
  rankIDP(idx.players);
  tiers(idx.players);

  const shape = p => ({
    name:p.name, pos:p.pos, team:p.team, sleeper_id:p.sleeper_id, espn_id:p.espn_id,
    value:Number(p.value.toFixed(1)), spread:Number((p.spread||0).toFixed(1)),
    proj_pts:p.proj_pts, tier:p.tier||null, adp:p.adp.ffc ?? p.idpAdp ?? null,
    sources:Object.keys(p.ranks), outliers:p.outliers||[],
    ...(p.idp?{idp:true,dpos:p.dpos}:{}),
    ...(p.injStatus?{inj_status:p.injStatus}:{}),
    ...(p.status&&p.status!=="Active"?{status:p.status}:{}),
  });

  const off = idx.players.filter(p=>!p.idp && p.value>0).sort((a,b)=>b.value-a.value).slice(0,360);
  const idp = idx.players.filter(p=>p.idp && p.value>0).sort((a,b)=>a.idpRank-b.idpRank).slice(0,60);
  const out = [...off, ...idp].map(shape);

  const nDST=out.filter(p=>p.pos==="DST").length, nIDP=out.filter(p=>p.idp).length;
  const nProj=out.filter(p=>p.proj_pts!=null).length, nInj=out.filter(p=>p.inj_status||p.status).length;
  console.log(`output: ${out.length} — DST:${nDST} IDP:${nIDP} scored:${nProj} injuries:${nInj}`);

  mkdirSync("data",{recursive:true});
  writeFileSync("data/rankings.json", JSON.stringify({
    generatedAt:new Date().toISOString(), season:SEASON, scoring:SCORING, teams:TEAMS,
    numQbs:NUM_QBS, count:out.length, players:out,
  }));
  console.log("wrote data/rankings.json");
}
main().catch(e=>{ console.error(e); process.exit(1); });
