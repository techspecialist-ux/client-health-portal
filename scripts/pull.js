#!/usr/bin/env node
/**
 * Pulls live health data for each client sub-account and writes data.json.
 * Runs on a schedule in GitHub Actions; tokens live in repo secrets and never
 * reach the browser.
 *
 * IMPORTANT: GoHighLevel agency-level Private Integration tokens only carry
 * agency scopes (locations, companies, users, snapshots, phone numbers...).
 * Contacts, opportunities and conversations are SUB-ACCOUNT scopes, so each
 * client needs its own Private Integration token created inside that
 * sub-account. One token per client, each seeing only that client.
 *
 * Config — a single secret, GHL_LOCATIONS, holding JSON:
 *   [
 *     {"name":"Culpepper Law Group","locationId":"33rJwYfcs4dKRJjbAAk7","token":"pit-..."},
 *     {"name":"Montalvo Law Firm PA","locationId":"TsjfPbla0EbAz3E47PtN","token":"pit-..."}
 *   ]
 */
const API = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const CONV_SAMPLE = parseInt(process.env.CONV_SAMPLE || "120", 10);

let LOCATIONS;
try {
  LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS || "[]");
} catch (e) {
  console.error("GHL_LOCATIONS is not valid JSON:", e.message);
  process.exit(1);
}
if (!Array.isArray(LOCATIONS) || !LOCATIONS.length){
  console.error("GHL_LOCATIONS is empty. Add one entry per client: {name, locationId, token}");
  process.exit(1);
}
for (const l of LOCATIONS){
  if (!l.locationId || !l.token){
    console.error(`Entry "${l.name||"(unnamed)"}" is missing locationId or token`);
    process.exit(1);
  }
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function api(path, { token, params, method="GET", form } = {}, tries=3){
  const url = new URL(API + path);
  if (params) for (const [k,v] of Object.entries(params)) if (v!=null) url.searchParams.set(k,v);
  const headers = { Authorization:"Bearer "+token, Version:VERSION, Accept:"application/json" };
  const opts = { method, headers };
  if (form){ headers["Content-Type"]="application/x-www-form-urlencoded"; opts.body=new URLSearchParams(form).toString(); }
  for (let i=0;i<tries;i++){
    const res = await fetch(url, opts);
    if (res.status === 429 || res.status >= 500){ await sleep(1200*(i+1)); continue; }
    const text = await res.text();
    let json=null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok){
      let m = (json && (json.message||json.error)) || res.statusText;
      if (Array.isArray(m)) m = m.join("; ");
      const e = new Error(m); e.status = res.status; throw e;
    }
    return json;
  }
  throw new Error("giving up after retries");
}

async function pool(items, limit, fn){
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, async () => {
    while (i < items.length){
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch(e){ out[idx] = { __error: e.message }; }
    }
  }));
  return out;
}

const fmtDate = d => `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}-${d.getFullYear()}`;
const RX_EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

/* SMS / call statuses that mean the message did not get through */
const SMS_BAD  = new Set(["failed","undelivered","rejected","error"]);
const CALL_BAD = new Set(["failed","busy","no-answer","canceled","cancelled"]);

async function analyseConversations(locId, tk, now){
  const out = {
    smsSent:0, smsFailed:0, callTotal:0, callFailed:0, callAnswered:0,
    callDurations:[], responseMins:[], sampled:0, emailSent:0, oldest:null
  };
  let convos = [];
  try {
    const r = await api("/conversations/search", { token:tk, params:{
      locationId:locId, limit:Math.min(CONV_SAMPLE,100), status:"all",
      sortBy:"last_message_date", sort:"desc" } });
    convos = r?.conversations || [];
  } catch(e){ out.error = e.message; return out; }

  const recent = convos.filter(c => c.lastMessageDate && (now - c.lastMessageDate)/864e5 <= 45);
  out.sampled = recent.length;

  await pool(recent, 5, async (c) => {
    let msgs = [];
    try {
      const m = await api(`/conversations/${c.id}/messages`, { token:tk,
        params:{ limit:40, type:"TYPE_SMS,TYPE_CALL,TYPE_EMAIL" } });
      msgs = m?.messages?.messages || [];
    } catch { return; }

    const asc = msgs.slice().sort((a,b)=> new Date(a.dateAdded) - new Date(b.dateAdded));
    for (const m of asc){
      const t = m.messageType, st = String(m.status||"").toLowerCase();
      if (t === "TYPE_SMS" && m.direction === "outbound"){
        out.smsSent++; if (SMS_BAD.has(st)) out.smsFailed++;
      } else if (t === "TYPE_CALL"){
        out.callTotal++;
        const cs = String(m.meta?.call?.status || st || "").toLowerCase();
        const dur = Number(m.meta?.call?.duration || 0);
        if (CALL_BAD.has(cs)) out.callFailed++;
        else if (cs === "completed"){ out.callAnswered++; out.callDurations.push(dur); }
      } else if (t === "TYPE_EMAIL" && m.direction === "outbound"){
        out.emailSent++;
      }
    }
    // speed to lead: first inbound -> next outbound
    const firstIn = asc.find(m => m.direction === "inbound");
    if (firstIn){
      const reply = asc.find(m => m.direction === "outbound" && new Date(m.dateAdded) > new Date(firstIn.dateAdded));
      if (reply){
        const mins = (new Date(reply.dateAdded) - new Date(firstIn.dateAdded)) / 60000;
        if (mins >= 0 && mins < 60*24*14) out.responseMins.push(mins);
      }
    }
  });
  return out;
}

async function fetchClient(entry){
  const id = entry.locationId, tk = entry.token;
  const now = new Date();
  const d30 = new Date(now-30*864e5), d60 = new Date(now-60*864e5);
  const g = (p, params) => api(p, { token:tk, params });

  const [head, open, won, lost, cur, prev, ctPage, pipes, meta] = await Promise.all([
    g("/contacts/", { locationId:id, limit:1 }).catch(()=>null),
    g("/opportunities/search", { location_id:id, status:"open", limit:100 }).catch(()=>null),
    g("/opportunities/search", { location_id:id, status:"won",  limit:100 }).catch(()=>null),
    g("/opportunities/search", { location_id:id, status:"lost", limit:100 }).catch(()=>null),
    g("/opportunities/search", { location_id:id, status:"all", date:fmtDate(d30), endDate:fmtDate(now), limit:1 }).catch(()=>null),
    g("/opportunities/search", { location_id:id, status:"all", date:fmtDate(d60), endDate:fmtDate(d30), limit:1 }).catch(()=>null),
    g("/contacts/", { locationId:id, limit:100 }).catch(()=>null),
    g("/opportunities/pipelines", { locationId:id }).catch(()=>null),
    g(`/locations/${id}`, {}).catch(()=>null),
  ]);
  if (!open && !head) throw new Error("no readable data — check token scopes");

  const conv = await analyseConversations(id, tk, now.getTime());

  const openOps = open?.opportunities || [], wonOps = won?.opportunities || [], lostOps = lost?.opportunities || [];
  const sample = [...openOps, ...wonOps, ...lostOps];
  const pipeNames = {}; (pipes?.pipelines||[]).forEach(p => pipeNames[p.id] = p.name);

  const srcOf = o => {
    const a = o.attributions || [], f = a.find(x=>x.isFirst) || a[0];
    if (f){
      const s = (f.utmSource||f.adSource||f.medium||"").toLowerCase(), sess = (f.utmSessionSource||"").toLowerCase();
      if (s.includes("facebook")||sess.includes("paid social")) return "Facebook / Meta Ads";
      if (s.includes("google")||s.includes("lsa")) return "Google / LSA";
      if (sess.includes("crm ui")||f.medium==="manual") return "Manual entry";
      if (sess.includes("form")) return "Web form";
      if (s) return s[0].toUpperCase()+s.slice(1);
    }
    return o.source || "Unattributed";
  };
  const sc={}; sample.forEach(o=>{ const k=srcOf(o); sc[k]=(sc[k]||0)+1; });
  const sources = Object.entries(sc).sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([n,v])=>[n, Math.round(v/(sample.length||1)*100)]);
  const pc={}; openOps.forEach(o=>{ const n=pipeNames[o.pipelineId]||"Other"; pc[n]=(pc[n]||0)+1; });

  const trend = new Array(30).fill(0);
  sample.forEach(o=>{ if(!o.createdAt) return;
    const d = Math.floor((now - new Date(o.createdAt))/864e5);
    if (d>=0 && d<30) trend[29-d]++; });

  const cts = ctPage?.contacts || [];
  const withE = cts.filter(c=>(c.email||"").trim());
  const goodE = withE.filter(c=>RX_EMAIL.test(c.email.trim()));
  const totalContacts = head?.meta?.total ?? null;
  const coverage = cts.length ? Math.round(withE.length/cts.length*100) : null;

  const wonVals = wonOps.map(o=>o.monetaryValue||0);
  const closeDays = wonOps.map(o => o.createdAt && o.lastStatusChangeAt
    ? Math.round((new Date(o.lastStatusChangeAt)-new Date(o.createdAt))/864e5) : null).filter(v=>v!=null && v>=0);

  const med = a => a.length ? a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)] : null;

  return {
    id, name: entry.name || meta?.location?.name || id, ghlName: meta?.location?.name || null, live:true,
    manager: meta?.location ? [meta.location.firstName, meta.location.lastName].filter(Boolean).join(" ") || "—" : "—",
    plan: meta?.location?.settings?.saasSettings?.saasMode ? "SaaS · "+meta.location.settings.saasSettings.saasMode : "—",
    onboarded: meta?.location?.dateAdded ? String(meta.location.dateAdded).slice(0,10) : "—",
    website: meta?.location?.website || null,
    totalContacts,
    leads:{ d30: cur?.meta?.total ?? 0, prev30: prev?.meta?.total ?? null, trend,
            trendPartial: trend.reduce((a,b)=>a+b,0) < (cur?.meta?.total ?? 0), sources, topCampaign:null },
    pipeline:{ open: open?.meta?.total ?? openOps.length,
      openValueSample: openOps.reduce((s,o)=>s+(o.monetaryValue||0),0), openSampleSize: openOps.length,
      won30: won?.meta?.total ?? wonOps.length, lost30: lost?.meta?.total ?? lostOps.length,
      wonValue: wonVals.reduce((a,b)=>a+b,0),
      avgDaysToClose: closeDays.length ? Math.round(closeDays.reduce((a,b)=>a+b,0)/closeDays.length) : null,
      stalled: openOps.filter(o=>o.lastStageChangeAt && (now-new Date(o.lastStageChangeAt))/864e5>30).length,
      stalledSampled:true,
      noValueCount: openOps.filter(o=>!(o.monetaryValue>0)).length, noValueSample: openOps.length,
      stages: Object.entries(pc).sort((a,b)=>b[1]-a[1]).slice(0,6) },
    speed:{ avgFirstResponseMin: med(conv.responseMins) != null ? Math.round(med(conv.responseMins)) : null,
            pctUnder5: conv.responseMins.length
              ? Math.round(conv.responseMins.filter(m=>m<=5).length/conv.responseMins.length*100) : null },
    appts:{ booked30:null, showed30:null },
    deliver:{ emailValidity: withE.length ? Math.round(goodE.length/withE.length*100) : null,
      emailCoverage: coverage, invalidEmails: withE.length-goodE.length,
      missingEmails: (totalContacts!=null && coverage!=null) ? Math.round(totalContacts*(100-coverage)/100) : null,
      bounceRate:null, smsOptOutRate:null, a2p:null, domainAuth:null },
    comms:{
      smsSent: conv.smsSent, smsFailed: conv.smsFailed,
      smsFailRate: conv.smsSent ? +(conv.smsFailed/conv.smsSent*100).toFixed(1) : null,
      callTotal: conv.callTotal, callFailed: conv.callFailed, callAnswered: conv.callAnswered,
      callFailRate: conv.callTotal ? +(conv.callFailed/conv.callTotal*100).toFixed(1) : null,
      avgCallSec: conv.callDurations.length
        ? Math.round(conv.callDurations.reduce((a,b)=>a+b,0)/conv.callDurations.length) : null,
      shortCalls: conv.callDurations.filter(d=>d>0 && d<15).length,
      emailSent: conv.emailSent, conversationsSampled: conv.sampled,
      error: conv.error || null
    },
    auto:{}
  };
}

(async () => {
  console.log(`Pulling ${LOCATIONS.length} client${LOCATIONS.length===1?"":"s"}`);

  const clients = await pool(LOCATIONS, 3, async (entry) => {
    try {
      const c = await fetchClient(entry);
      console.log(`  ok  ${c.name}  (${c.comms.conversationsSampled} conversations sampled)`);
      return c;
    } catch(e){
      console.log(`  ERR ${entry.name || entry.locationId}: ${e.message}`);
      return { id:entry.locationId, name:entry.name || entry.locationId, live:false, error:e.message,
               leads:{}, pipeline:{}, speed:{}, appts:{}, deliver:{}, comms:{}, auto:{} };
    }
  });

  const out = { synced:new Date().toISOString(), source:"api", clients };
  require("fs").writeFileSync("data.json", JSON.stringify(out, null, 1));
  const ok = clients.filter(c=>!c.error).length;
  console.log(`Wrote data.json — ${ok}/${clients.length} ok`);
  if (!ok) process.exit(1);
})();
