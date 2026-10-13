// Usage: node web/tools/grade_margins_report.mjs <dir of grade_margins.mjs .jsonl shards>
// Prints the margin percentiles, counts per seat-game over thresholds, unranked shares and timing (docs/FINDINGS.md, "Move grades").
import { readFileSync, readdirSync } from "node:fs";
const D = process.argv[2];
const L = readdirSync(D).filter(f=>/^p\d\.jsonl$/.test(f)).flatMap(f=>readFileSync(D+"/"+f,"utf8").trim().split("\n").map(x=>JSON.parse(x)));
const games = L.filter(r=>r.game!==undefined), dec = L.filter(r=>r.g!==undefined);
const q=(v,p)=>{v=[...v].sort((a,b)=>a-b);return v.length?v[Math.min(v.length-1,Math.floor(p*v.length))]:NaN};
const P=[.5,.75,.9,.95,.99,.999];
const f=x=>x.toFixed(4);
const ms=dec.map(r=>r.ms); console.log("games",games.length,"unfinished",games.filter(g=>!g.done).length,"decisions",dec.length);
console.log("ms med/p90/p99/max",f(q(ms,.5)),f(q(ms,.9)),f(q(ms,.99)),f(Math.max(...ms)));
const BOTS=["heuristic","jsrobot","random","vnet"];
const CATS=[...new Set(dec.map(r=>r.cat))];
for (const b of BOTS){ const d=dec.filter(r=>r.bot==b);
 for (const c of ["ALL",...CATS]){ const x=d.filter(r=>c=="ALL"||r.cat==c); const m=x.filter(r=>r.margin!==null).map(r=>r.margin);
  if(!x.length)continue;
  console.log(b.padEnd(9),c.padEnd(9),"n",String(x.length).padStart(6),"unr%",(100*(x.length-m.length)/x.length).toFixed(1).padStart(5),"pct",P.map(p=>f(q(m,p))).join(" "),"zero%",(100*m.filter(v=>v===0).length/m.length).toFixed(1),"<.005%",(100*m.filter(v=>v<.005).length/m.length).toFixed(1)); } }
const seatGames={}; BOTS.forEach(b=>seatGames[b]=games.length);
console.log("per seat-game count margin>=T"); const T=[.005,.01,.02,.03,.05,.08,.1,.15,.2];
console.log("T       ",BOTS.join(" "));
for(const t of T) console.log(String(t).padEnd(7),BOTS.map(b=>(dec.filter(r=>r.bot==b&&r.margin!==null&&r.margin>=t).length/games.length).toFixed(2).padStart(9)).join(" "));
console.log("decisions per seat-game",BOTS.map(b=>(dec.filter(r=>r.bot==b).length/games.length).toFixed(1)).join(" "));
// predictive: per seat-game sum margin, win rate by tercile
const win={}; games.forEach(g=>win[g.game]=g.winner);
const sg={}; for(const r of dec){ if(r.margin===null)continue; const k=r.g+"_"+r.seat; (sg[k]??={g:r.g,seat:r.seat,bot:r.bot,sum:0,c05:0}); sg[k].sum+=r.margin; if(r.margin>=.05)sg[k].c05++; }
for(const b of BOTS){ const a=Object.values(sg).filter(s=>s.bot==b).sort((x,y)=>x.sum-y.sum); const n=a.length;
 for (const key of ["sum","c05"]){ const s=[...a].sort((x,y)=>x[key]-y[key]); const out=[0,1,2].map(i=>{const t=s.slice(Math.floor(i*n/3),Math.floor((i+1)*n/3)); return (100*t.filter(x=>win[x.g]==x.seat).length/t.length).toFixed(0)+"%@"+(t.reduce((p,x)=>p+x[key],0)/t.length).toFixed(2);});
  console.log(b,key,"win by tercile (low->high) [mean key]",out.join(" ")); } }
// ending mid-game vs opening: mean margin end/roll
