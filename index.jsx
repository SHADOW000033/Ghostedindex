import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   SUPABASE CONFIG
   Replace these two values with your actual Supabase project credentials.
   Get them from: https://supabase.com/dashboard → Settings → API
───────────────────────────────────────────────────────────────────────────── */
const SUPABASE_URL  = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRwdXdjZGVodXVhb21ucXRtZHdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNjYyMTgsImV4cCI6MjA5MDk0MjIxOH0.i_5EBLlrAthIoucFMgWxnWyiYZeiooBgDuU30yTBcV4";

/* ── Minimal Supabase REST client (no SDK dependency) ── */
const supa = {
  async from(table) {
    return {
      _table: table,
      _filters: [],
      _order: null,
      _limit: null,
      _single: false,

      select(cols = "*") { this._cols = cols; return this; },
      eq(col, val)        { this._filters.push(`${col}=eq.${encodeURIComponent(val)}`); return this; },
      ilike(col, val)     { this._filters.push(`${col}=ilike.${encodeURIComponent(val)}`); return this; },
      order(col, opts={}) { this._order = `${col}${opts.ascending===false?".desc":""}`; return this; },
      limit(n)            { this._limit = n; return this; },
      single()            { this._single = true; return this; },

      async _url(method) {
        let url = `${SUPABASE_URL}/rest/v1/${this._table}`;
        const params = [];
        if (this._cols)   params.push(`select=${this._cols}`);
        if (this._order)  params.push(`order=${this._order}`);
        if (this._limit)  params.push(`limit=${this._limit}`);
        this._filters.forEach(f => params.push(f));
        if (params.length) url += "?" + params.join("&");
        return url;
      },

      async execute() {
        const url = await this._url();
        const res = await fetch(url, {
          headers: {
            apikey: SUPABASE_ANON,
            Authorization: `Bearer ${SUPABASE_ANON}`,
            "Content-Type": "application/json",
            Prefer: this._single ? "return=representation" : "",
          },
        });
        if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return { data: this._single ? data[0] || null : data, error: null };
      },

      async insert(payload) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${this._table}`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_ANON,
            Authorization: `Bearer ${SUPABASE_ANON}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Supabase insert error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return { data, error: null };
      },

      async update(payload) {
        const url = await this._url();
        const res = await fetch(url, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_ANON,
            Authorization: `Bearer ${SUPABASE_ANON}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Supabase update error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return { data, error: null };
      },

      async upsert(payload, opts={}) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${this._table}`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_ANON,
            Authorization: `Bearer ${SUPABASE_ANON}`,
            "Content-Type": "application/json",
            Prefer: `resolution=${opts.onConflict ? "merge-duplicates" : "merge-duplicates"},return=representation`,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Supabase upsert error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return { data, error: null };
      },
    };
  },

  /* Convenience RPC call for computed functions */
  async rpc(fn, params={}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${SUPABASE_ANON}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`Supabase RPC error ${res.status}: ${await res.text()}`);
    return { data: await res.json(), error: null };
  },
};

/* ── Simple rate limiter (client-side, 3 submissions per hour per session) ── */
const rateLimiter = {
  key: "gai_submit_times",
  canSubmit() {
    try {
      const times = JSON.parse(localStorage.getItem(this.key)||"[]");
      const hour = Date.now() - 3600_000;
      const recent = times.filter(t => t > hour);
      return recent.length < 3;
    } catch { return true; }
  },
  record() {
    try {
      const times = JSON.parse(localStorage.getItem(this.key)||"[]");
      const hour = Date.now() - 3600_000;
      const recent = times.filter(t => t > hour);
      recent.push(Date.now());
      localStorage.setItem(this.key, JSON.stringify(recent));
    } catch {}
  },
};

/* ── Input sanitiser ── */
const sanitize = s => String(s||"").trim().replace(/<[^>]*>/g,"").slice(0, 500);

/* ─────────────────────────────────────────────────────────────────────────────
   REAL DATABASE LAYER
   All app data flows through this object.
   Swap SUPABASE_URL + SUPABASE_ANON above to go live.
───────────────────────────────────────────────────────────────────────────── */
const db = {

  /* Fetch all companies with computed ghost_rate from reports */
  async getCompanies(sortBy = "ghost_rate") {
    const client = await supa.from("companies");
    const { data, error } = await client
      .select("id,name,total_reports,avg_response_days,created_at")
      .order(
        sortBy === "ghost_rate"  ? "ghost_rate"    :
        sortBy === "reports"     ? "total_reports" : "name",
        { ascending: sortBy === "name" }
      )
      .execute();
    if (error) throw error;
    return (data || []).map(c => ({
      ...c,
      ghost_rate: c.ghost_rate ?? 0,
      history: c.history ?? null,
    }));
  },

  /* Search companies by name (case-insensitive) */
  async search(q) {
    const client = await supa.from("companies");
    const { data, error } = await client
      .select("id,name,ghost_rate,total_reports,avg_response_days,history")
      .ilike("name", `%${sanitize(q)}%`)
      .limit(6)
      .execute();
    if (error) throw error;
    return data || [];
  },

  /* Get single company by id */
  async getCompany(id) {
    const client = await supa.from("companies");
    const { data, error } = await client
      .select("id,name,ghost_rate,total_reports,avg_response_days,history,created_at")
      .eq("id", id)
      .single()
      .execute();
    if (error) throw error;
    return data;
  },

  /* Get all reports for a company, most recent first */
  async getReports(companyId) {
    const client = await supa.from("reports");
    const { data, error } = await client
      .select("id,role,responded,days_waited,stage,created_at,votes")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50)
      .execute();
    if (error) throw error;
    return (data || []).map(r => ({ ...r, votes: r.votes ?? 0 }));
  },

  /* Submit a new report — creates company if it doesn't exist */
  async submit({ companyName, role, responded, daysWaited, stage, method, ghostType, followUps, comment }) {
    /* Rate limiting */
    if (!rateLimiter.canSubmit()) {
      throw new Error("You've submitted 3 reports this hour. Please wait before submitting again.");
    }

    const name    = sanitize(companyName);
    const roleSan = sanitize(role);
    const stageSan= sanitize(stage||"");
    const cmtSan  = sanitize(comment||"");

    if (!name)    throw new Error("Company name is required.");
    if (!roleSan) throw new Error("Role is required.");

    /* Find or create company */
    const searchClient = await supa.from("companies");
    const { data: found } = await searchClient
      .select("id")
      .ilike("name", name)
      .limit(1)
      .execute();

    let companyId;

    if (found && found.length > 0) {
      companyId = found[0].id;
    } else {
      /* Create new company — stats will be recomputed by trigger or next fetch */
      const createClient = await supa.from("companies");
      const { data: created } = await createClient.insert({
        name,
        ghost_rate: responded ? 0 : 100,
        total_reports: 1,
        avg_response_days: (responded && daysWaited > 0) ? daysWaited : null,
      });
      companyId = created[0]?.id;
    }

    if (!companyId) throw new Error("Could not find or create company.");

    /* Duplicate check: same company + role in last 24h from this session */
    const sessionKey = `gai_sub_${companyId}_${roleSan.slice(0,20).toLowerCase()}`;
    const lastSub = localStorage.getItem(sessionKey);
    if (lastSub && Date.now() - Number(lastSub) < 86_400_000) {
      throw new Error("You've already submitted a report for this role at this company today.");
    }

    /* Insert report */
    const insertClient = await supa.from("reports");
    await insertClient.insert({
      company_id:   companyId,
      role:         roleSan,
      responded:    Boolean(responded),
      days_waited:  daysWaited > 0 ? Number(daysWaited) : null,
      stage:        stageSan || null,
      method:       sanitize(method||"") || null,
      ghost_type:   sanitize(ghostType||"") || null,
      follow_ups:   sanitize(followUps||"") || null,
      comment:      cmtSan || null,
    });

    /* Record rate limit + session duplicate guard */
    rateLimiter.record();
    localStorage.setItem(sessionKey, String(Date.now()));

    /* Recompute ghost_rate + total_reports for this company */
    await this._recomputeStats(companyId);
  },

  /* Recompute and save company stats from all its reports */
  async _recomputeStats(companyId) {
    const repsClient = await supa.from("reports");
    const { data: reps } = await repsClient
      .select("responded,days_waited")
      .eq("company_id", companyId)
      .execute();

    if (!reps || reps.length === 0) return;

    const total     = reps.length;
    const ghosted   = reps.filter(r => !r.responded).length;
    const ghostRate = Math.round((ghosted / total) * 100);
    const responded = reps.filter(r => r.responded && r.days_waited > 0);
    const avgWait   = responded.length
      ? responded.reduce((a, r) => a + r.days_waited, 0) / responded.length
      : null;

    const upClient = await supa.from("companies");
    await upClient
      .eq("id", companyId)
      .update({
        ghost_rate:         ghostRate,
        total_reports:      total,
        avg_response_days:  avgWait ? parseFloat(avgWait.toFixed(1)) : null,
      });
  },

  /* Upvote / downvote a report */
  async vote(reportId, delta) {
    /* We do this via a raw RPC to avoid race conditions */
    await supa.rpc("increment_report_votes", { report_id: reportId, delta });
  },
};

/* ─── ROLE CATEGORIES ────────────────────────────────────────────────────── */
const ROLE_CATEGORIES = {
  "Engineering": ["Engineer","Developer","SWE","SDE","Backend","Frontend","Infrastructure","TPM"],
  "Design":      ["Designer","UX","UI","Product Design","Creative"],
  "Product":     ["Product Manager","PM","APM","GPM"],
  "Data":        ["Data Scientist","Data Analyst","Analytics","ML","AI"],
  "Other":       [],
};
const getRoleCategory = role => {
  for (const [cat, keys] of Object.entries(ROLE_CATEGORIES)) {
    if (cat === "Other") continue;
    if (keys.some(k => role.toLowerCase().includes(k.toLowerCase()))) return cat;
  }
  return "Other";
};

/* ─── HELPERS ───────────────────────────────────────────────────────────────── */
const rateColor  = r => r <= 30 ? "#16a34a" : r <= 60 ? "#d97706" : "#dc2626";
const rateBg     = r => r <= 30 ? "#f0fdf4" : r <= 60 ? "#fffbeb" : "#fef2f2";
const rateBorder = r => r <= 30 ? "#bbf7d0" : r <= 60 ? "#fde68a" : "#fecaca";
const rateLabel  = r => r <= 30 ? "Responsive" : r <= 60 ? "Mixed reviews" : "Low response rate";
const fmt        = s => new Date(s).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});

/* ─── BOOKMARKS HOOK ─────────────────────────────────────────────────────────── */
function useBookmarks() {
  const [bookmarks, setBookmarks] = useState(() => {
    try { return JSON.parse(localStorage.getItem("gai_bookmarks")||"[]"); } catch { return []; }
  });
  const toggle = useCallback(company => {
    setBookmarks(prev => {
      const exists = prev.some(c=>c.id===company.id);
      const next = exists ? prev.filter(c=>c.id!==company.id) : [...prev, company];
      try { localStorage.setItem("gai_bookmarks", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const isBookmarked = useCallback(id => bookmarks.some(c=>c.id===id), [bookmarks]);
  return [bookmarks, toggle, isBookmarked];
}

/* ─── ICONS ─────────────────────────────────────────────────────────────────── */
const Ico = {
  Ghost: ({s=18,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 1 8 8v10l-3-2-2 2-2-2-2 2-2-2-3 2V10a8 8 0 0 1 8-8z"/>
    </svg>
  ),
  Search: ({s=16,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
  ),
  Left: ({s=15,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5m7-7-7 7 7 7"/>
    </svg>
  ),
  Right: ({s=13,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14m-7-7 7 7-7 7"/>
    </svg>
  ),
  Check: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  X: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  Plus: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  Clock: ({s=13,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  TrendUp: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  Shield: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  Star: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  Users: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  Flame: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
    </svg>
  ),
  Share: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
  ),
  Copy: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  ),
  History: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
    </svg>
  ),
  Compare: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 8 4 12 8 16"/><polyline points="16 8 20 12 16 16"/>
    </svg>
  ),
  Bookmark: ({s=14,c="currentColor",filled=false})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill={filled?c:"none"} stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  ArrowUp: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
    </svg>
  ),
  ArrowDown: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
    </svg>
  ),
  Minus: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round">
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  Eye: ({s=14,c="currentColor"})=>(
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ),
};

/* ─── CSS ────────────────────────────────────────────────────────────────────── */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=Epilogue:wght@300;400;500;600;700;800&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}

:root{
  /* Warm parchment palette — feels editorial, not clinical */
  --paper:   #f5f3ed;
  --paper2:  #ece9e0;
  --paper3:  #e1dcd1;
  --paper4:  #cfc9bb;
  --white:   #fdfcf8;
  --ink:     #0e0d14;
  --ink2:    #262432;
  --ink3:    #5a5768;
  --ink4:    #8e8aa0;
  --ink5:    #bfbccf;
  --ink6:    #dddaec;
  /* Deep indigo-blacks for dark surfaces */
  --dark:    #100f18;
  --dark2:   #191724;
  --dark3:   #231f31;
  --dark4:   #302c42;
  --green:   #15803d;
  --greenL:  #22c55e;
  --amber:   #b45309;
  --amberL:  #f59e0b;
  --red:     #b91c1c;
  --redL:    #ef4444;
  --r:9px; --rsm:5px; --rlg:15px; --rxl:18px;
  --ease:.15s cubic-bezier(.4,0,.2,1);
  --easel:.28s cubic-bezier(.4,0,.2,1);
  --fd:'Lora',Georgia,serif;
  --fb:'Epilogue',system-ui,sans-serif;
  --sh-sm:0 1px 2px rgba(14,13,20,.07),0 2px 6px rgba(14,13,20,.04);
  --sh-md:0 2px 5px rgba(14,13,20,.07),0 6px 18px rgba(14,13,20,.07);
  --sh-lg:0 4px 10px rgba(14,13,20,.08),0 14px 36px rgba(14,13,20,.1);
  --sh-xl:0 6px 24px rgba(14,13,20,.09),0 28px 64px rgba(14,13,20,.12);
}

body{
  background:var(--paper);color:var(--ink);
  font-family:var(--fb);min-height:100vh;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
::selection{background:var(--ink);color:var(--paper)}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:var(--paper)}
::-webkit-scrollbar-thumb{background:var(--paper3);border-radius:2px}

/* ── NAV ── */
.nav{
  position:fixed;top:0;left:0;right:0;z-index:200;
  height:54px;padding:0 40px;
  display:flex;align-items:center;justify-content:space-between;
  background:rgba(245,243,237,.95);
  backdrop-filter:blur(32px) saturate(2.2);
  -webkit-backdrop-filter:blur(32px) saturate(2.2);
  border-bottom:1px solid var(--ink6);
}
.nav-logo{display:flex;align-items:center;gap:9px;cursor:pointer}
.nav-logo-mark{
  width:26px;height:26px;border-radius:6px;
  background:var(--dark);
  display:flex;align-items:center;justify-content:center;
}
.nav-name{
  font-family:var(--fd);font-weight:700;font-size:.88rem;
  color:var(--ink);letter-spacing:-.03em;
}
.nav-right{display:flex;align-items:center;gap:1px}
.nav-link{
  padding:5px 11px;border-radius:100px;
  font-family:var(--fb);font-size:.74rem;font-weight:500;
  cursor:pointer;transition:var(--ease);border:none;
  background:transparent;color:var(--ink4);
}
.nav-link:hover{color:var(--ink);background:var(--paper2)}
.nav-link.active{color:var(--ink2)}
.nav-compare-btn{
  display:flex;align-items:center;gap:5px;
  padding:5px 11px;border-radius:100px;
  font-family:var(--fb);font-size:.74rem;font-weight:500;
  cursor:pointer;transition:var(--ease);
  border:none;background:transparent;color:var(--ink4);
}
.nav-compare-btn:hover{color:var(--ink);background:var(--paper2)}
.nav-compare-btn.active{color:var(--ink2)}
.nav-divider{width:1px;height:14px;background:var(--ink6);margin:0 7px;flex-shrink:0}
.nav-cta{
  display:flex;align-items:center;gap:5px;
  padding:6px 15px;border-radius:100px;
  background:var(--ink);color:var(--paper);
  font-family:var(--fb);font-size:.74rem;font-weight:600;
  cursor:pointer;border:none;transition:var(--ease);
}
.nav-cta:hover{background:var(--dark3);transform:translateY(-1px)}
.nav-cta:active{transform:none}

.page{padding-top:54px;min-height:100vh}

/* ── HERO ── */
.hero{
  max-width:1160px;margin:0 auto;padding:64px 44px 0;
  position:relative;
}
.hero::before{
  content:'';position:absolute;inset:0;
  background-image:radial-gradient(circle,var(--paper3) 1px,transparent 1px);
  background-size:24px 24px;
  mask-image:radial-gradient(ellipse 70% 60% at 50% 40%,black 10%,transparent 100%);
  -webkit-mask-image:radial-gradient(ellipse 70% 60% at 50% 40%,black 10%,transparent 100%);
  pointer-events:none;z-index:0;opacity:.4;
}
.hero-top{
  position:relative;z-index:1;
  display:flex;align-items:flex-start;justify-content:space-between;
  gap:52px;padding-bottom:52px;
  border-bottom:1px solid var(--ink6);
}
.hero-left{flex:1;max-width:540px}
.hero-eyebrow{
  display:inline-flex;align-items:center;gap:9px;
  font-family:var(--fb);font-size:.62rem;font-weight:600;
  color:var(--ink5);letter-spacing:.2em;text-transform:uppercase;
  margin-bottom:22px;animation:up .45s ease both;
}
.hero-eyebrow-line{width:18px;height:1px;background:var(--ink5)}
.hero-eyebrow-dot{width:2px;height:2px;border-radius:50%;background:var(--ink5)}
.hero-h1{
  font-family:var(--fd);
  font-size:clamp(2.5rem,4.6vw,4.4rem);
  font-weight:700;letter-spacing:-.05em;line-height:1.02;
  color:var(--ink);margin-bottom:18px;
  animation:up .45s .06s ease both;
}
.hero-h1 em{
  font-style:italic;font-weight:500;
  background:linear-gradient(135deg,var(--ink2) 0%,var(--ink4) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.hero-desc{
  font-size:.9rem;color:var(--ink4);line-height:1.84;
  margin-bottom:26px;font-weight:400;
  animation:up .45s .12s ease both;
}
.hero-search-row{animation:up .45s .18s ease both}
.hero-live-strip{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px;animation:up .45s .22s ease both}
.hero-stat-pill{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 12px;border-radius:100px;
  background:var(--white);border:1px solid var(--ink6);
  box-shadow:var(--sh-sm);font-size:.73rem;
}
.hero-stat-pill-val{font-family:var(--fd);font-weight:700;color:var(--ink);letter-spacing:-.02em}
.hero-stat-pill-lbl{color:var(--ink4);font-weight:400}
.hero-stat-pill-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}

/* search */
.search-wrap{position:relative;max-width:100%}
.search-bar{
  display:flex;align-items:center;
  background:var(--white);border:1px solid var(--ink5);
  border-radius:var(--rxl);padding:4px 4px 4px 18px;
  transition:var(--ease);box-shadow:var(--sh-sm);
}
.search-bar:focus-within{border-color:var(--ink);box-shadow:var(--sh-md),0 0 0 3px rgba(14,13,20,.05)}
.search-inp{
  flex:1;border:none;outline:none;background:transparent;
  font-family:var(--fb);font-size:.87rem;color:var(--ink);
  padding:9px 10px;
}
.search-inp::placeholder{color:var(--ink5)}
.search-btn{
  padding:10px 20px;border-radius:var(--rlg);border:none;
  background:var(--dark);color:var(--paper);
  font-family:var(--fb);font-size:.75rem;font-weight:600;
  cursor:pointer;transition:var(--ease);
  display:flex;align-items:center;gap:6px;
}
.search-btn:hover{background:var(--dark3)}
.search-drop{
  position:absolute;top:calc(100%+7px);left:0;right:0;z-index:100;
  background:var(--white);border:1px solid var(--ink5);
  border-radius:var(--rxl);overflow:hidden;
  box-shadow:var(--sh-xl);animation:up .1s ease both;
}
.sdrop-item{
  display:flex;align-items:center;gap:12px;
  padding:12px 18px;cursor:pointer;transition:var(--ease);
  border-bottom:1px solid var(--ink6);
}
.sdrop-item:last-child{border-bottom:none}
.sdrop-item:hover{background:var(--paper)}
.sdi-av{
  width:32px;height:32px;border-radius:8px;flex-shrink:0;
  background:var(--dark);color:var(--paper);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:700;font-size:.7rem;
}
.sdi-name{font-family:var(--fd);font-weight:600;font-size:.85rem;flex:1;letter-spacing:-.015em}
.sdi-highlight{color:var(--ink);font-weight:800}
.sdi-rate{font-size:.76rem;font-weight:700}
.sdi-arr{color:var(--ink6);transition:var(--ease)}
.sdrop-item:hover .sdi-arr{color:var(--ink4);transform:translateX(3px)}
.sdrop-empty{padding:18px;text-align:center;color:var(--ink4);font-size:.8rem}
.sdrop-empty span{color:var(--ink);font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}

/* ── HERO STAT CARD ── */
.hero-right{flex-shrink:0;width:288px;padding-top:4px;animation:up .45s .26s ease both}
.hsc{
  background:var(--dark);border-radius:18px;
  overflow:hidden;position:relative;
  box-shadow:var(--sh-xl);
}
.hsc::before{
  content:'';position:absolute;inset:0;
  background-image:
    linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
  background-size:26px 26px;pointer-events:none;z-index:0;
}
.hsc::after{
  content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);
  width:180px;height:80px;
  background:radial-gradient(ellipse,rgba(220,38,38,.1),transparent 70%);
  pointer-events:none;z-index:0;
}
.hsc-body{position:relative;z-index:1;padding:20px 20px 0}
.hsc-top-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.hsc-tag{
  display:inline-flex;align-items:center;gap:6px;
  padding:3px 9px;border-radius:100px;
  background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.07);
  font-family:var(--fb);font-size:.58rem;font-weight:600;
  color:rgba(255,255,255,.35);letter-spacing:.1em;text-transform:uppercase;
}
.hsc-tag-dot{width:5px;height:5px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444;animation:blink 2s ease infinite}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.2;transform:scale(.7)}}
.hsc-co-row{
  display:flex;align-items:center;gap:10px;
  padding:11px 0;
  border-top:1px solid rgba(255,255,255,.045);
  border-bottom:1px solid rgba(255,255,255,.045);
}
.hsc-av{
  width:32px;height:32px;border-radius:8px;flex-shrink:0;
  background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:700;font-size:.72rem;color:rgba(255,255,255,.65);
}
.hsc-co-name{font-family:var(--fd);font-size:.82rem;font-weight:600;color:rgba(255,255,255,.86);letter-spacing:-.02em}
.hsc-co-sub{font-size:.6rem;color:rgba(255,255,255,.24);margin-top:2px}
.hsc-rate-row{padding:13px 0 0}
.hsc-rate-pct{
  font-family:var(--fd);font-size:4.4rem;font-weight:700;
  letter-spacing:-.08em;line-height:1;color:#fff;
}
.hsc-rate-pct span{font-size:1.8rem;opacity:.25;font-weight:400;letter-spacing:-.04em}
.hsc-rate-label{font-size:.58rem;color:rgba(255,255,255,.2);letter-spacing:.14em;text-transform:uppercase;margin-top:5px}
.hsc-bar{height:1px;background:rgba(255,255,255,.08);overflow:hidden;margin:13px 0 0}
.hsc-bar-fill{height:100%;background:linear-gradient(90deg,#b91c1c,#ef4444);transition:width 1.4s ease}
.hsc-footer{display:flex;border-top:1px solid rgba(255,255,255,.045)}
.hsc-ft-cell{flex:1;padding:12px 14px;border-right:1px solid rgba(255,255,255,.045)}
.hsc-ft-cell:last-child{border-right:none}
.hsc-ft-val{font-family:var(--fd);font-size:.95rem;font-weight:600;color:rgba(255,255,255,.82);letter-spacing:-.03em;margin-bottom:2px}
.hsc-ft-lbl{font-size:.52rem;color:rgba(255,255,255,.2);text-transform:uppercase;letter-spacing:.13em}

/* ── METRICS BAND ── */
.metrics-band{
  background:var(--dark);padding:26px 44px;display:flex;
  border-bottom:1px solid rgba(255,255,255,.04);
}
.met{flex:1;padding:0 28px;border-right:1px solid rgba(255,255,255,.06);text-align:center}
.met:first-child{padding-left:0;text-align:left}
.met:last-child{border-right:none;text-align:right}
.met-val{font-family:var(--fd);font-size:1.85rem;font-weight:700;letter-spacing:-.06em;color:#fff;margin-bottom:3px}
.met-lbl{font-size:.59rem;color:rgba(255,255,255,.24);text-transform:uppercase;letter-spacing:.17em;font-weight:500}

/* ── SECTIONS ── */
.sec{max-width:1160px;margin:0 auto;padding:56px 44px}
.sec-hd{
  display:flex;align-items:flex-end;justify-content:space-between;
  margin-bottom:26px;padding-bottom:14px;
  border-bottom:1px solid var(--ink6);gap:16px;
}
.sec-hd-left{}
.sec-eyebrow{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.18em;margin-bottom:5px}
.sec-title{font-family:var(--fd);font-size:1.35rem;font-weight:700;letter-spacing:-.04em;line-height:1.15}
.sec-title em{font-style:italic;font-weight:500;color:var(--ink4)}
.sec-link{
  font-size:.72rem;font-weight:600;color:var(--ink4);
  cursor:pointer;display:flex;align-items:center;gap:4px;
  background:none;border:none;font-family:var(--fb);
  transition:var(--ease);padding:0;white-space:nowrap;
}
.sec-link:hover{color:var(--ink)}

/* ── TOP LIST ── */
.top-list{display:flex;flex-direction:column}
.top-row{
  display:flex;align-items:center;gap:14px;
  padding:14px 10px;border-radius:var(--rlg);
  cursor:pointer;transition:var(--easel);
  border:1px solid transparent;margin:0 -10px;
}
.top-row:hover{background:var(--white);border-color:var(--ink6);box-shadow:var(--sh-sm)}
.top-row+.top-row{border-top:1px solid var(--ink6);border-radius:0}
.top-row:hover+.top-row{border-top-color:transparent}
.top-row:hover{border-radius:var(--rlg)!important}
.top-rank{font-family:var(--fd);font-size:.82rem;font-weight:700;color:var(--ink6);width:22px;text-align:center;flex-shrink:0}
.top-rank.r1{color:var(--ink2);font-size:.94rem}
.top-rank.r2{color:var(--ink4)}
.top-rank.r3{color:var(--ink5)}
.top-av{
  width:36px;height:36px;border-radius:9px;flex-shrink:0;
  background:var(--dark);color:var(--paper);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:700;font-size:.72rem;
}
.top-info{flex:1;min-width:0}
.top-name{font-family:var(--fd);font-size:.88rem;font-weight:700;letter-spacing:-.02em;margin-bottom:1px}
.top-sub{font-size:.65rem;color:var(--ink5)}
.top-bar-wrap{width:140px;flex-shrink:0}
.top-bar-track{height:2px;background:var(--paper3);border-radius:1px;overflow:hidden;margin-bottom:4px}
.top-bar-fill{height:100%;border-radius:1px;transition:width 1s ease}
.top-bar-pct{font-size:.65rem;color:var(--ink4);text-align:right;font-weight:700}
.top-badge{flex-shrink:0;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.top-action{color:var(--ink6);flex-shrink:0;transition:var(--ease);width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.top-row:hover .top-action{color:var(--ink4);background:var(--paper2)}

/* ── SAFE CARDS ── */
.safe-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.safe-card{
  background:var(--white);border:1px solid var(--ink6);
  border-radius:var(--rxl);padding:20px;
  cursor:pointer;transition:var(--easel);
  display:flex;flex-direction:column;gap:12px;
}
.safe-card::before{display:none}
.safe-card:hover{box-shadow:var(--sh-lg);transform:translateY(-2px);border-color:var(--ink5)}
.safe-card-top{display:flex;align-items:center;justify-content:space-between}
.safe-av{
  width:34px;height:34px;border-radius:8px;
  background:var(--dark);color:var(--paper);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:700;font-size:.72rem;
}
.safe-badge{padding:2px 9px;border-radius:100px;font-size:.6rem;font-weight:700;background:rgba(21,128,61,.07);color:var(--green);border:1px solid rgba(21,128,61,.14)}
.safe-name{font-family:var(--fd);font-size:.92rem;font-weight:700;letter-spacing:-.02em;margin-bottom:1px}
.safe-sub{font-size:.65rem;color:var(--ink5)}
.safe-rate{font-family:var(--fd);font-size:1.7rem;font-weight:700;letter-spacing:-.06em;color:var(--green);line-height:1}
.safe-rate span{font-size:.88rem;opacity:.4;font-weight:400}
.safe-track{height:2px;background:var(--paper3);border-radius:1px;overflow:hidden}
.safe-fill{height:100%;border-radius:1px;background:var(--greenL);transition:width 1.1s ease}

/* ── HOW IT WORKS ── */
.how-band{background:var(--dark);padding:56px 44px;position:relative;overflow:hidden}
.how-band::before{
  content:'';position:absolute;inset:0;pointer-events:none;
  background-image:repeating-linear-gradient(-45deg,rgba(255,255,255,.009) 0px,rgba(255,255,255,.009) 1px,transparent 1px,transparent 56px);
}
.how-inner{max-width:1160px;margin:0 auto;position:relative;z-index:1}
.how-hd{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:38px;gap:24px}
.how-eyebrow{font-size:.59rem;font-weight:600;color:rgba(255,255,255,.18);text-transform:uppercase;letter-spacing:.2em;margin-bottom:7px}
.how-title{font-family:var(--fd);font-size:1.75rem;font-weight:700;letter-spacing:-.05em;color:#fff;line-height:1.1}
.how-title em{font-style:italic;font-weight:500;color:rgba(255,255,255,.26)}
.how-hd-note{font-size:.74rem;color:rgba(255,255,255,.18);max-width:180px;line-height:1.65;text-align:right;font-weight:300}
.how-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:rgba(255,255,255,.045)}
.how-step{padding:26px 24px;background:var(--dark);transition:var(--easel)}
.how-step:hover{background:var(--dark2)}
.how-step-num{font-family:var(--fd);font-size:2.4rem;font-weight:700;letter-spacing:-.08em;line-height:1;color:rgba(255,255,255,.04);margin-bottom:14px}
.how-step-icon{width:32px;height:32px;border-radius:7px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.how-step-title{font-family:var(--fd);font-size:.9rem;font-weight:700;color:#fff;margin-bottom:7px;letter-spacing:-.02em}
.how-step-desc{font-size:.77rem;color:rgba(255,255,255,.25);line-height:1.78;font-weight:300}

/* ── SKELETON ── */
.sk{background:linear-gradient(90deg,var(--paper2) 25%,var(--paper3) 50%,var(--paper2) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:7px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.empty{padding:72px 24px;text-align:center}
.empty-t{font-family:var(--fd);font-size:1rem;font-weight:700;color:var(--ink2);margin-bottom:6px}
.empty-s{font-size:.8rem;color:var(--ink4)}

/* ── CTA BAND ── */
.cta-band{max-width:1160px;margin:0 auto 64px;padding:0 44px}
.cta-inner{
  background:var(--dark);border-radius:var(--rxl);
  padding:48px 52px;display:flex;align-items:center;justify-content:space-between;gap:36px;
  position:relative;overflow:hidden;box-shadow:var(--sh-xl);
}
.cta-inner::before{content:'';position:absolute;right:-60px;top:-60px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.03),transparent 70%);pointer-events:none}
.cta-eyebrow{font-size:.59rem;font-weight:600;color:rgba(255,255,255,.25);text-transform:uppercase;letter-spacing:.16em;margin-bottom:8px}
.cta-title{font-family:var(--fd);font-size:1.75rem;font-weight:700;letter-spacing:-.05em;line-height:1.12;margin-bottom:8px;color:#fff}
.cta-title em{font-style:italic;font-weight:500;color:rgba(255,255,255,.35)}
.cta-sub{font-size:.82rem;color:rgba(255,255,255,.33);line-height:1.72;font-weight:300;max-width:360px}
.cta-btn{
  flex-shrink:0;display:flex;align-items:center;gap:7px;
  padding:13px 28px;border-radius:100px;
  background:var(--paper);color:var(--dark);
  font-family:var(--fd);font-size:.86rem;font-weight:700;
  cursor:pointer;border:none;transition:var(--easel);
  white-space:nowrap;letter-spacing:-.02em;
}
.cta-btn:hover{background:var(--white);transform:translateY(-2px);box-shadow:var(--sh-lg)}

/* ── BACK BTN ── */
.back-btn{
  display:inline-flex;align-items:center;gap:7px;
  font-family:var(--fb);font-size:.75rem;font-weight:500;color:var(--ink4);
  background:none;border:1px solid var(--ink6);cursor:pointer;
  padding:7px 14px 7px 10px;border-radius:100px;
  transition:var(--ease);
}
.back-btn:hover{color:var(--ink);border-color:var(--ink5);background:var(--white)}

/* ── COMPANY PAGE ── */
.cop-wrap{max-width:940px;margin:0 auto;padding:0 44px 80px}
.cop-topbar{padding:28px 0 20px;display:flex;align-items:center;justify-content:space-between}
.cop-hero{
  position:relative;overflow:hidden;
  background:var(--white);border:1px solid var(--ink6);
  border-radius:20px;margin-bottom:12px;
  box-shadow:var(--sh-md);
}
.cop-hero-glow{position:absolute;inset:0;pointer-events:none}
.cop-hero-grid{
  position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(var(--ink6) 1px,transparent 1px),linear-gradient(90deg,var(--ink6) 1px,transparent 1px);
  background-size:28px 28px;
  mask-image:linear-gradient(135deg,transparent 50%,rgba(0,0,0,.2) 100%);
  -webkit-mask-image:linear-gradient(135deg,transparent 50%,rgba(0,0,0,.2) 100%);
}
.cop-hero-inner{
  position:relative;z-index:1;
  display:flex;align-items:center;justify-content:space-between;
  gap:28px;padding:28px 32px;flex-wrap:wrap;
}
.cop-hero-left{display:flex;align-items:center;gap:18px}
.cop-av{
  width:54px;height:54px;border-radius:14px;flex-shrink:0;
  background:var(--dark);color:var(--paper);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--fd);font-weight:700;font-size:1.05rem;
  box-shadow:var(--sh-md);
}
.cop-eyebrow{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.15em;margin-bottom:6px}
.cop-name{font-family:var(--fd);font-size:1.75rem;font-weight:700;letter-spacing:-.045em;line-height:1.1;margin-bottom:11px}
.cop-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cop-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:100px;font-size:.67rem;font-weight:700;letter-spacing:.02em;white-space:nowrap}
.cop-chip-neutral{background:var(--paper2);color:var(--ink4);border:1px solid var(--ink6)}
.cop-hero-right{text-align:right;flex-shrink:0}
.cop-rate-num{font-family:var(--fd);font-size:3.4rem;font-weight:700;letter-spacing:-.08em;line-height:1}
.cop-rate-pct{font-size:1.5rem;opacity:.35;font-weight:400}
.cop-rate-lbl{font-size:.59rem;color:var(--ink5);text-transform:uppercase;letter-spacing:.13em;margin-top:5px}
.cop-rate-bar-wrap{height:2px;background:var(--paper3);border-radius:1px;width:120px;margin:8px 0 0 auto;position:relative}
.cop-rate-bar-fill{height:100%;border-radius:1px;position:absolute;top:0;left:0;transition:width 1.1s ease}
.cop-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:12px}
.cop-stat{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);padding:16px 18px;box-shadow:var(--sh-sm)}
.cop-stat-icon{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;margin-bottom:10px}
.cop-stat-val{font-family:var(--fd);font-size:1.55rem;font-weight:700;letter-spacing:-.05em;line-height:1;margin-bottom:3px}
.cop-stat-lbl{font-size:.59rem;color:var(--ink5);text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.cop-breakdown{display:grid;grid-template-columns:1fr 1.7fr;gap:10px;margin-bottom:12px}
.cop-donut-card,.cop-ratio-card{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);padding:22px 24px;box-shadow:var(--sh-sm)}
.cop-card-title{font-family:var(--fd);font-size:.85rem;font-weight:700;letter-spacing:-.02em;color:var(--ink2);margin-bottom:16px}
.cop-donut-inner{display:flex;align-items:center;gap:20px}
.cop-legend{display:flex;flex-direction:column;gap:9px;flex:1}
.cop-legend-row{display:flex;align-items:center;gap:8px;font-size:.75rem}
.cop-legend-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.cop-legend-label{flex:1;color:var(--ink4)}
.cop-legend-val{font-weight:700;font-family:var(--fd);letter-spacing:-.02em}
.cop-legend-total .cop-legend-val{color:var(--ink2)}
.cop-ratio-big{display:flex;align-items:baseline;gap:8px;margin-bottom:16px}
.cop-ratio-big span:first-child{font-family:var(--fd);font-size:2rem;font-weight:700;letter-spacing:-.06em}
.cop-ratio-big-sub{font-size:.77rem;color:var(--ink4);padding-bottom:3px}
.cop-ratio-bar-wrap{margin-bottom:18px}
.cop-ratio-labels{display:flex;justify-content:space-between;font-size:.7rem;font-weight:600;margin-bottom:7px;gap:8px;flex-wrap:wrap}
.cop-ratio-track{height:5px;background:var(--paper3);border-radius:3px;overflow:hidden}
.cop-ratio-fill{height:100%;background:var(--greenL);border-radius:3px;transition:width 1.1s ease}
.cop-verdict-block{border:1px solid;border-radius:var(--r);padding:12px 14px}
.cop-verdict-chip{font-size:.67rem;font-weight:700;letter-spacing:.03em;margin-bottom:5px}
.cop-verdict-text{font-size:.75rem;color:var(--ink3);line-height:1.68;font-weight:300}
.cop-reports{background:var(--white);border:1px solid var(--ink6);border-radius:18px;overflow:hidden;box-shadow:var(--sh-sm)}
.cop-reports-head{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--ink6);background:var(--paper)}
.cop-reports-sub{font-size:.63rem;color:var(--ink5);font-weight:500;margin-top:2px;letter-spacing:.03em}
.cop-rep-row{display:flex;align-items:center;border-bottom:1px solid var(--ink6);transition:var(--ease);overflow:hidden}
.cop-rep-row:last-of-type{border-bottom:none}
.cop-rep-row:hover{background:var(--paper)}
.cop-rep-stripe{width:3px;align-self:stretch;flex-shrink:0}
.cop-rep-body{flex:1;padding:13px 16px}
.cop-rep-role{font-size:.83rem;font-weight:600;letter-spacing:-.01em;margin-bottom:3px}
.cop-rep-meta{display:flex;align-items:center;gap:5px;font-size:.67rem;color:var(--ink4);flex-wrap:wrap}
.cop-rep-sep{color:var(--ink6)}
.cop-rep-stage{font-size:.67rem;color:var(--ink4);font-style:italic}
.cop-rep-badge{display:flex;align-items:center;gap:4px;padding:3px 10px;border-radius:100px;font-size:.63rem;font-weight:700;letter-spacing:.02em;margin-right:16px;white-space:nowrap;flex-shrink:0}
.cop-rep-yes{background:rgba(21,128,61,.07);color:var(--green)}
.cop-rep-no{background:rgba(185,28,28,.07);color:var(--red)}
.cop-reports-empty{padding:48px 24px;text-align:center}
.cop-empty-icon{width:42px;height:42px;border-radius:50%;background:var(--paper2);border:1px solid var(--ink6);margin:0 auto 12px;display:flex;align-items:center;justify-content:center}
.cop-empty-t{font-family:var(--fd);font-size:.88rem;font-weight:700;color:var(--ink3);margin-bottom:4px}
.cop-empty-s{font-size:.75rem;color:var(--ink5)}
.cop-reports-footer{padding:11px 22px;font-size:.65rem;color:var(--ink5);border-top:1px solid var(--ink6);background:var(--paper);font-style:italic}
.cop-share-btn{display:flex;align-items:center;gap:6px;padding:6px 13px;border-radius:100px;border:1px solid var(--ink6);background:var(--white);color:var(--ink4);font-family:var(--fb);font-size:.72rem;font-weight:600;cursor:pointer;transition:var(--ease)}
.cop-share-btn:hover{border-color:var(--ink5);color:var(--ink2)}

/* ── VOTING ── */
.cop-rep-votes{display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px 12px;border-right:1px solid var(--ink6);flex-shrink:0}
.vote-btn{width:22px;height:22px;border-radius:5px;border:none;background:transparent;cursor:pointer;transition:var(--ease);display:flex;align-items:center;justify-content:center;color:var(--ink5)}
.vote-btn:hover{background:var(--paper2);color:var(--ink3)}
.vote-btn.voted-up{color:var(--green);background:rgba(21,128,61,.08)}
.vote-btn.voted-dn{color:var(--red);background:rgba(185,28,28,.08)}
.vote-count{font-size:.63rem;font-weight:700;color:var(--ink4);line-height:1;min-width:14px;text-align:center}

/* ── STAGES ── */
.stages-card{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);overflow:hidden;box-shadow:var(--sh-sm)}
.stages-head{padding:14px 20px 12px;border-bottom:1px solid var(--ink6);background:var(--paper);display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.stages-title{font-family:var(--fd);font-size:.85rem;font-weight:700;letter-spacing:-.02em}
.stages-sub{font-size:.63rem;color:var(--ink5)}
.stages-list{padding:4px 0}
.stage-row{display:flex;align-items:center;gap:10px;padding:8px 20px;transition:var(--ease)}
.stage-row:hover{background:var(--paper)}
.stage-label{font-size:.72rem;font-weight:500;color:var(--ink3);width:120px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stage-bar-wrap{flex:1}
.stage-bar-track{height:5px;background:var(--paper3);border-radius:2px;overflow:hidden}
.stage-bar-fill{height:100%;border-radius:2px;transition:width .9s ease}
.stage-pct{font-family:var(--fd);font-size:.77rem;font-weight:700;letter-spacing:-.02em;width:32px;text-align:right;flex-shrink:0}
.stage-count{font-size:.62rem;color:var(--ink5);width:52px;text-align:right;flex-shrink:0}

/* ── HISTORY ── */
.history-card{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);overflow:hidden;box-shadow:var(--sh-sm)}
.history-head{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 12px;border-bottom:1px solid var(--ink6);background:var(--paper)}
.history-title{font-family:var(--fd);font-size:.85rem;font-weight:700;letter-spacing:-.02em}
.history-chart{display:flex;align-items:flex-end;gap:5px;height:48px;padding:12px 20px 4px}
.history-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
.history-bar{width:100%;border-radius:2px 2px 0 0;min-height:3px}
.history-bar-lbl{font-size:.55rem;color:var(--ink5);text-align:center}

/* ── SPARKLINE TREND ── */
.sparkline-trend{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:100px;font-size:.62rem;font-weight:700;white-space:nowrap}
.spark-up{background:rgba(185,28,28,.07);color:var(--red);border:1px solid rgba(185,28,28,.14)}
.spark-down{background:rgba(21,128,61,.07);color:var(--green);border:1px solid rgba(21,128,61,.14)}
.spark-flat{background:var(--paper2);color:var(--ink4);border:1px solid var(--ink6)}

/* ── ROLE FILTER ── */
.role-filter-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--ink6);background:var(--paper)}
.role-filter-label{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.14em;flex-shrink:0}
.role-chip{padding:3px 10px;border-radius:100px;font-family:var(--fb);font-size:.68rem;font-weight:500;border:1px solid var(--ink6);background:transparent;color:var(--ink4);cursor:pointer;transition:var(--ease)}
.role-chip:hover{border-color:var(--ink4);color:var(--ink2)}
.role-chip.on{background:var(--dark);color:var(--paper);border-color:var(--dark)}

/* ── SUBMIT PAGE ── */
.sub-page{max-width:640px;margin:0 auto;padding:48px 44px 80px}
.sub-head-area{margin-bottom:24px}
.sub-eyebrow{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.16em;margin-bottom:11px}
.sub-h1{font-family:var(--fd);font-size:2.4rem;font-weight:700;letter-spacing:-.05em;line-height:1.06;margin-bottom:10px}
.sub-desc{font-size:.85rem;color:var(--ink4);line-height:1.78;font-weight:300}
.form-card{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rxl);padding:32px;box-shadow:var(--sh-md)}
.fg{margin-bottom:20px}
.fl{display:block;font-size:.62rem;font-weight:700;color:var(--ink5);text-transform:uppercase;letter-spacing:.14em;margin-bottom:7px}
.fi{width:100%;padding:11px 14px;background:var(--paper);border:1.5px solid var(--ink5);border-radius:var(--r);font-family:var(--fb);font-size:.86rem;color:var(--ink);outline:none;transition:var(--ease)}
.fi::placeholder{color:var(--ink5)}
.fi:focus{border-color:var(--ink);background:var(--white);box-shadow:0 0 0 3px rgba(14,13,20,.05)}
.fi.e{border-color:var(--redL)}
.ferr{font-size:.66rem;color:var(--red);margin-top:5px;font-weight:600}
.tog-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.tog{padding:16px 12px;border-radius:var(--rlg);border:1.5px solid var(--ink5);background:var(--paper);font-family:var(--fb);font-size:.82rem;font-weight:500;cursor:pointer;color:var(--ink4);transition:var(--easel);display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center}
.tog:hover:not(.ty):not(.tn){border-color:var(--ink);color:var(--ink);background:var(--white)}
.tog-icon{width:32px;height:32px;border-radius:50%;background:var(--paper2);display:flex;align-items:center;justify-content:center;transition:var(--ease)}
.ty{background:rgba(21,128,61,.04);border-color:rgba(21,128,61,.26);color:var(--green)}
.ty .tog-icon{background:rgba(21,128,61,.08)}
.tn{background:rgba(185,28,28,.04);border-color:rgba(185,28,28,.26);color:var(--red)}
.tn .tog-icon{background:rgba(185,28,28,.08)}
.sub-btn{width:100%;padding:13px;margin-top:6px;border:none;border-radius:var(--r);background:var(--dark);color:var(--paper);font-family:var(--fd);font-size:.9rem;font-weight:700;cursor:pointer;transition:var(--easel);letter-spacing:-.02em;display:flex;align-items:center;justify-content:center;gap:7px}
.sub-btn:hover:not(:disabled){background:var(--dark3);transform:translateY(-1px)}
.sub-btn:disabled{opacity:.3;cursor:not-allowed}
.suc{padding:52px 32px;text-align:center}
.suc-ring{width:58px;height:58px;border-radius:50%;margin:0 auto 20px;background:rgba(21,128,61,.06);border:1px solid rgba(21,128,61,.16);display:flex;align-items:center;justify-content:center;animation:pop .5s ease}
.suc-h{font-family:var(--fd);font-size:1.5rem;font-weight:700;letter-spacing:-.04em;margin-bottom:7px}
.suc-p{color:var(--ink4);font-size:.83rem;line-height:1.75;margin-bottom:28px;font-weight:300}
.suc-btns{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.btn-ol{padding:9px 20px;border-radius:100px;border:1px solid var(--ink5);background:transparent;color:var(--ink3);font-family:var(--fb);font-size:.78rem;font-weight:500;cursor:pointer;transition:var(--ease)}
.btn-ol:hover{border-color:var(--ink);color:var(--ink)}
.btn-dk{padding:9px 20px;border-radius:100px;border:none;background:var(--dark);color:var(--paper);font-family:var(--fb);font-size:.78rem;font-weight:600;cursor:pointer;transition:var(--ease)}
.btn-dk:hover{background:var(--dark3);transform:translateY(-1px)}

/* step tracker */
.step-track{display:flex;align-items:center;margin-bottom:28px;position:relative}
.step-line{position:absolute;left:20px;right:20px;top:13px;height:1px;background:var(--ink6);z-index:0}
.step-line-fill{height:100%;background:var(--ink);transition:width .4s var(--easel)}
.step-node{display:flex;flex-direction:column;align-items:center;gap:7px;flex:1;position:relative;z-index:1}
.step-dot{width:26px;height:26px;border-radius:50%;background:var(--paper2);border:1.5px solid var(--ink5);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-size:.68rem;font-weight:700;color:var(--ink4);transition:var(--ease)}
.step-active .step-dot{background:var(--dark);border-color:var(--dark);color:var(--paper)}
.step-done .step-dot{background:var(--green);border-color:var(--green);color:#fff}
.step-lbl{font-size:.62rem;font-weight:600;color:var(--ink4);text-transform:uppercase;letter-spacing:.08em}
.step-active .step-lbl{color:var(--ink2)}
.step-done .step-lbl{color:var(--green)}
.form-section-title{font-family:var(--fd);font-size:.97rem;font-weight:700;letter-spacing:-.02em;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--ink6);display:flex;align-items:center;gap:8px}
.form-optional{font-family:var(--fb);font-size:.63rem;font-weight:500;color:var(--ink4);letter-spacing:.02em;background:var(--paper2);padding:2px 8px;border-radius:100px;font-style:normal}
.option-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:7px}
.opt-grid-2{grid-template-columns:repeat(2,1fr)}
.opt-btn{display:flex;align-items:center;gap:7px;padding:10px 13px;border-radius:var(--r);border:1px solid var(--ink5);background:var(--paper);font-family:var(--fb);font-size:.78rem;font-weight:500;color:var(--ink3);cursor:pointer;transition:var(--ease);text-align:left}
.opt-btn:hover:not(.opt-on){border-color:var(--ink3);color:var(--ink);background:var(--white)}
.opt-on{background:var(--dark);color:var(--paper);border-color:var(--dark)}
.opt-on:hover{background:var(--dark2);border-color:var(--dark2)}
.fi-ta{resize:vertical;min-height:92px;line-height:1.65}
.fi-char-count{text-align:right;font-size:.63rem;color:var(--ink5);margin-top:4px}
.sub-summary{background:var(--paper2);border:1px solid var(--ink6);border-radius:var(--r);padding:14px 18px;margin-bottom:18px}
.sub-summary-title{font-size:.62rem;font-weight:700;color:var(--ink5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}
.sub-summary-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--ink6);font-size:.78rem}
.sub-summary-row:last-child{border-bottom:none;padding-bottom:0}
.sub-summary-row span{color:var(--ink3)}
.sub-summary-row strong{font-weight:600;color:var(--ink);font-family:var(--fd);letter-spacing:-.01em}

/* ── BOOKMARKS BAR ── */
.bookmarks-bar{background:var(--dark);border-bottom:1px solid rgba(255,255,255,.05);padding:10px 0}
.bookmarks-inner{max-width:1160px;margin:0 auto;padding:0 44px;display:flex;align-items:center;gap:12px}
.bookmarks-label{font-size:.59rem;font-weight:600;color:rgba(255,255,255,.28);text-transform:uppercase;letter-spacing:.14em;white-space:nowrap;display:flex;align-items:center;gap:5px;flex-shrink:0}
.bookmarks-chips{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;flex:1}
.bookmarks-chips::-webkit-scrollbar{display:none}
.bookmark-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 7px;border-radius:100px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);cursor:pointer;transition:var(--ease);flex-shrink:0}
.bookmark-chip:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.18)}
.bookmark-chip-av{width:20px;height:20px;border-radius:5px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.52rem;color:rgba(255,255,255,.7);flex-shrink:0}
.bookmark-chip-name{font-family:var(--fd);font-size:.72rem;font-weight:600;color:rgba(255,255,255,.78);white-space:nowrap}
.bookmark-chip-rate{font-size:.63rem;font-weight:700;white-space:nowrap}
.bookmarks-manage{font-size:.66rem;font-weight:500;color:rgba(255,255,255,.25);background:none;border:none;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:var(--ease)}
.bookmarks-manage:hover{color:rgba(255,255,255,.55)}

/* ── RECENTLY VIEWED ── */
.recent-bar{background:var(--paper2);border-bottom:1px solid var(--ink6);padding:9px 0}
.recent-inner{max-width:1160px;margin:0 auto;padding:0 44px;display:flex;align-items:center;gap:12px}
.recent-label{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.14em;white-space:nowrap;display:flex;align-items:center;gap:5px;flex-shrink:0}
.recent-chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
.recent-chips::-webkit-scrollbar{display:none}
.recent-chip{display:inline-flex;align-items:center;gap:7px;padding:4px 11px 4px 6px;border-radius:100px;background:var(--white);border:1px solid var(--ink6);cursor:pointer;transition:var(--ease);flex-shrink:0}
.recent-chip:hover{border-color:var(--ink5)}
.recent-chip-av{width:18px;height:18px;border-radius:4px;background:var(--dark);color:var(--paper);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.5rem;flex-shrink:0}
.recent-chip-name{font-family:var(--fd);font-size:.72rem;font-weight:600;white-space:nowrap}
.recent-chip-rate{font-size:.63rem;font-weight:700;white-space:nowrap}

/* ── HERO LIVE STRIP ── */
.hero-live-strip{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px}
.hero-stat-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:100px;background:var(--white);border:1px solid var(--ink6);box-shadow:var(--sh-sm);font-size:.7rem}
.hero-stat-pill-val{font-family:var(--fd);font-weight:700;color:var(--ink);letter-spacing:-.02em}
.hero-stat-pill-lbl{color:var(--ink4);font-weight:400}
.hero-stat-pill-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}

/* ── TRENDING ── */
.trending-band{background:var(--dark);border-top:1px solid rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.06);padding:38px 0 36px;overflow:hidden}
.trending-inner{max-width:1160px;margin:0 auto;padding:0 44px}
.trending-head{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.trending-icon-wrap{width:30px;height:30px;border-radius:8px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.18);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.trending-title{font-family:var(--fd);font-size:1rem;font-weight:700;color:#fff;letter-spacing:-.03em}
.trending-eyebrow{font-size:.62rem;color:rgba(255,255,255,.25);margin-top:1px}
.trend-marquee-outer{position:relative;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 60px,#000 calc(100% - 60px),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 60px,#000 calc(100% - 60px),transparent 100%)}
.trend-marquee-track{display:flex;gap:12px;width:max-content;animation:marquee 26s linear infinite}
.trend-marquee-paused{animation-play-state:paused}
@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
.trend-card{flex-shrink:0;width:196px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;cursor:pointer;transition:var(--easel)}
.trend-card:hover{background:rgba(255,255,255,.085);border-color:rgba(255,255,255,.16);transform:translateY(-2px);box-shadow:0 10px 28px rgba(0,0,0,.35)}
.trend-card-body{padding:16px 16px 14px}
.trend-card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.trend-rank-badge{padding:2px 8px;border-radius:100px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);font-family:var(--fd);font-size:.58rem;font-weight:700;color:rgba(255,255,255,.34);letter-spacing:.04em}
.trend-av{width:28px;height:28px;border-radius:7px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.65rem;color:rgba(255,255,255,.7)}
.trend-name{font-family:var(--fd);font-size:.84rem;font-weight:700;color:#fff;letter-spacing:-.02em;margin-bottom:1px}
.trend-reports{font-size:.62rem;color:rgba(255,255,255,.25);margin-bottom:12px}
.trend-rate-row{margin-bottom:12px}
.trend-rate-num{font-family:var(--fd);font-size:1.4rem;font-weight:700;color:#fff;letter-spacing:-.05em;line-height:1;margin-bottom:6px}
.trend-rate-num span{font-size:.82rem;opacity:.3;font-weight:400}
.trend-rate-bar-wrap{height:2px;background:rgba(255,255,255,.07);border-radius:1px;overflow:hidden}
.trend-rate-bar{height:100%;border-radius:1px;transition:width 1s ease}
.trend-card-footer{display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}
.trend-new{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:100px;font-size:.58rem;font-weight:700;background:rgba(251,191,36,.09);color:#fbbf24;border:1px solid rgba(251,191,36,.16)}
.trend-view{display:flex;align-items:center;gap:3px;font-size:.65rem;font-weight:600;color:rgba(255,255,255,.24);transition:var(--ease)}
.trend-card:hover .trend-view{color:rgba(255,255,255,.65)}

/* ── EXPLORER SECTION ── */
.explorer-shell{background:#100f18;border-top:1px solid rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.06);padding:68px 0 76px}
.explorer-inner{max-width:1160px;margin:0 auto;padding:0 44px}
.expl-head{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid rgba(255,255,255,.07);gap:16px;flex-wrap:wrap}
.expl-eyebrow{font-size:.59rem;font-weight:600;color:rgba(255,255,255,.26);text-transform:uppercase;letter-spacing:.18em;margin-bottom:8px;display:flex;align-items:center;gap:7px}
.expl-eyebrow::before{content:'';display:block;width:16px;height:1px;background:rgba(255,255,255,.22)}
.expl-title{font-family:var(--fd);font-size:1.75rem;font-weight:700;letter-spacing:-.045em;line-height:1.1;color:#fff}
.expl-title em{font-style:italic;font-weight:500;color:rgba(255,255,255,.35)}
.expl-count{font-size:.75rem;font-weight:500;color:rgba(255,255,255,.26);white-space:nowrap;padding-bottom:3px}
.expl-controls{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.expl-search-wrap{flex:1;min-width:200px}
.expl-search-box{display:flex;align-items:center;gap:9px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);border-radius:var(--rlg);padding:10px 15px;transition:var(--ease)}
.expl-search-box:focus-within{background:rgba(255,255,255,.085);border-color:rgba(255,255,255,.2)}
.expl-search-inp{flex:1;border:none;outline:none;background:transparent;font-family:var(--fb);font-size:.84rem;color:rgba(255,255,255,.88)}
.expl-search-inp::placeholder{color:rgba(255,255,255,.26)}
.expl-clear{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:none;background:rgba(255,255,255,.09);cursor:pointer;transition:var(--ease);flex-shrink:0;color:rgba(255,255,255,.4)}
.expl-clear:hover{background:rgba(255,255,255,.16);color:#fff}
.expl-select-wrap{display:flex;align-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);border-radius:var(--rlg);padding:10px 15px;gap:8px;cursor:pointer;transition:var(--ease);min-width:196px}
.expl-select-wrap:focus-within{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.085)}
.expl-select{flex:1;border:none;outline:none;background:transparent;font-family:var(--fb);font-size:.82rem;color:rgba(255,255,255,.82);cursor:pointer;appearance:none;-webkit-appearance:none}
.expl-select option{background:var(--dark2);color:#fff}
.expl-chips{display:flex;align-items:center;gap:7px;margin-bottom:28px;flex-wrap:wrap}
.expl-chip{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:100px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);font-family:var(--fb);font-size:.72rem;font-weight:500;color:rgba(255,255,255,.45);cursor:pointer;transition:var(--ease)}
.expl-chip:hover{border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.82);background:rgba(255,255,255,.075)}
.expl-chip-on{background:rgba(255,255,255,.92);color:var(--dark);border-color:rgba(255,255,255,.92)}
.expl-chip-on:hover{background:#fff;border-color:#fff}
.expl-chip-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;border-radius:100px;padding:0 4px;font-size:.58rem;font-weight:700}
.expl-chip-on .expl-chip-count{background:rgba(14,13,20,.12);color:var(--dark)}
.expl-chip:not(.expl-chip-on) .expl-chip-count{background:rgba(255,255,255,.09);color:rgba(255,255,255,.45)}
.expl-range-pill{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:100px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);font-size:.72rem;color:rgba(255,255,255,.45);margin-left:auto}
.expl-range-label{font-weight:600;font-size:.63rem;color:rgba(255,255,255,.28);text-transform:uppercase;letter-spacing:.1em}
.expl-range{width:60px;height:2px;cursor:pointer;appearance:none;-webkit-appearance:none;background:rgba(255,255,255,.14);border-radius:1px;outline:none}
.expl-range::-webkit-slider-thumb{appearance:none;width:13px;height:13px;border-radius:50%;background:rgba(255,255,255,.85);cursor:pointer;border:2px solid var(--dark2)}
.expl-range-val{font-weight:700;color:rgba(255,255,255,.65);font-size:.72rem;min-width:26px;text-align:center}
.expl-range-sep{color:rgba(255,255,255,.2)}
.expl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:14px}
.expl-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:18px;overflow:hidden;cursor:pointer;transition:var(--easel);display:flex}
.expl-card:hover{background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.16);transform:translateY(-3px);box-shadow:0 18px 44px rgba(0,0,0,.38)}
.expl-card-stripe{width:3px;flex-shrink:0;transition:width var(--ease)}
.expl-card:hover .expl-card-stripe{width:4px}
.expl-card-body{flex:1;padding:18px 20px 16px}
.expl-card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.expl-card-av{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.78);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.7rem}
.expl-card-reports-pill{padding:2px 9px;border-radius:100px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);font-size:.59rem;font-weight:600;color:rgba(255,255,255,.32);letter-spacing:.03em}
.expl-card-name{font-family:var(--fd);font-size:.94rem;font-weight:700;letter-spacing:-.025em;color:#fff;margin-bottom:1px}
.expl-card-sub{font-size:.64rem;color:rgba(255,255,255,.24);margin-bottom:14px}
.expl-card-rate-wrap{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.expl-card-ring{position:relative;flex-shrink:0}
.expl-card-ring-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;letter-spacing:-.04em}
.expl-card-rate-info{}
.expl-card-rate-lbl{font-size:.58rem;color:rgba(255,255,255,.26);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
.expl-card-rate-num-lg{font-family:var(--fd);font-size:1.2rem;font-weight:700;letter-spacing:-.04em}
.expl-card-foot{padding-top:11px;border-top:1px solid rgba(255,255,255,.065);display:flex;align-items:center;justify-content:space-between}
.expl-card-meta{display:flex;align-items:center;gap:4px;font-size:.64rem;color:rgba(255,255,255,.26)}
.expl-card-link{display:flex;align-items:center;gap:4px;font-size:.66rem;font-weight:600;color:rgba(255,255,255,.22);transition:var(--ease)}
.expl-card:hover .expl-card-link{color:rgba(255,255,255,.65)}
.expl-empty{padding:72px 24px;text-align:center;grid-column:1/-1}
.expl-empty-icon{width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);margin:0 auto 16px;display:flex;align-items:center;justify-content:center}
.expl-empty-t{font-family:var(--fd);font-size:1rem;font-weight:700;color:rgba(255,255,255,.65);margin-bottom:6px;letter-spacing:-.02em}
.expl-empty-s{font-size:.78rem;color:rgba(255,255,255,.28);margin-bottom:20px}
.expl-reset{padding:8px 20px;border-radius:100px;border:1px solid rgba(255,255,255,.18);background:transparent;color:rgba(255,255,255,.55);font-family:var(--fb);font-size:.76rem;font-weight:600;cursor:pointer;transition:var(--ease)}
.expl-reset:hover{border-color:rgba(255,255,255,.36);color:#fff}

/* ── COMPARE PAGE ── */
.cmp-page{max-width:1000px;margin:0 auto;padding:44px 44px 80px}
.cmp-eyebrow{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.16em;margin-bottom:8px}
.cmp-title{font-family:var(--fd);font-size:2rem;font-weight:700;letter-spacing:-.05em;margin-bottom:6px}
.cmp-sub{font-size:.84rem;color:var(--ink4);line-height:1.68;margin-bottom:36px;font-weight:300}
.cmp-pickers{display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:start;margin-bottom:32px}
.cmp-picker{background:var(--white);border:1px solid var(--ink5);border-radius:var(--rlg);padding:16px 18px;box-shadow:var(--sh-sm)}
.cmp-picker-label{font-size:.62rem;font-weight:600;color:var(--ink4);text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}
.cmp-picker-search{position:relative}
.cmp-picker-inp{width:100%;padding:10px 13px;background:var(--paper);border:1px solid var(--ink5);border-radius:var(--r);font-family:var(--fb);font-size:.82rem;color:var(--ink);outline:none;transition:var(--ease)}
.cmp-picker-inp:focus{border-color:var(--ink);background:var(--white)}
.cmp-picker-drop{position:absolute;top:calc(100%+5px);left:0;right:0;z-index:50;background:var(--white);border:1px solid var(--ink5);border-radius:var(--r);overflow:hidden;box-shadow:var(--sh-lg)}
.cmp-drop-item{display:flex;align-items:center;gap:9px;padding:9px 13px;cursor:pointer;transition:var(--ease);border-bottom:1px solid var(--ink6);font-size:.8rem;font-weight:500}
.cmp-drop-item:last-child{border-bottom:none}
.cmp-drop-item:hover{background:var(--paper)}
.cmp-drop-av{width:26px;height:26px;border-radius:6px;flex-shrink:0;background:var(--dark);color:var(--paper);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.6rem}
.cmp-selected{display:flex;align-items:center;gap:9px}
.cmp-sel-av{width:34px;height:34px;border-radius:9px;flex-shrink:0;background:var(--dark);color:var(--paper);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.76rem}
.cmp-sel-name{font-family:var(--fd);font-size:.88rem;font-weight:700;flex:1;letter-spacing:-.02em}
.cmp-sel-rate{font-family:var(--fd);font-size:.82rem;font-weight:700}
.cmp-sel-clear{width:20px;height:20px;border-radius:50%;border:none;background:var(--paper3);cursor:pointer;transition:var(--ease);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cmp-sel-clear:hover{background:var(--ink5)}
.cmp-vs{display:flex;align-items:center;justify-content:center;padding-top:38px}
.cmp-vs-badge{width:32px;height:32px;border-radius:50%;background:var(--dark);color:var(--paper);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-size:.72rem;font-weight:700}
.cmp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.cmp-metric-card{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);padding:20px 22px;box-shadow:var(--sh-sm)}
.cmp-metric-label{font-size:.59rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:14px}
.cmp-metric-row{display:flex;gap:14px;align-items:center}
.cmp-metric-side{flex:1;text-align:center;padding:6px}
.cmp-metric-val{font-family:var(--fd);font-size:1.8rem;font-weight:700;letter-spacing:-.05em;line-height:1;margin-bottom:3px}
.cmp-metric-name{font-size:.66rem;color:var(--ink4);font-weight:500}
.cmp-metric-divider{width:1px;height:52px;background:var(--ink6);flex-shrink:0}
.cmp-bar-compare{margin-top:14px;display:flex;flex-direction:column;gap:8px}
.cmp-bar-row{display:flex;align-items:center;gap:8px}
.cmp-bar-name{font-size:.67rem;font-weight:600;color:var(--ink3);width:48px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmp-bar-track{flex:1;height:5px;background:var(--paper3);border-radius:2px;overflow:hidden}
.cmp-bar-fill{height:100%;border-radius:2px;transition:width 1.1s ease}
.cmp-bar-val{font-size:.67rem;font-weight:700;width:32px;text-align:right;flex-shrink:0}
.cmp-winner{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:100px;font-size:.6rem;font-weight:700;background:rgba(21,128,61,.07);color:var(--green);border:1px solid rgba(21,128,61,.14);margin-top:10px}
.cmp-empty{grid-column:1/-1;background:var(--paper2);border:1px dashed var(--ink5);border-radius:var(--rxl);padding:48px 24px;text-align:center}
.cmp-empty-icon{color:var(--ink5);margin:0 auto 12px;width:fit-content}
.cmp-empty-t{font-family:var(--fd);font-size:.92rem;font-weight:600;color:var(--ink3);margin-bottom:5px}
.cmp-empty-s{font-size:.78rem;color:var(--ink4)}

/* ── SHARE MODAL ── */
.share-overlay{position:fixed;inset:0;z-index:500;background:rgba(14,13,20,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn .18s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.share-modal{background:var(--white);border:1px solid var(--ink6);border-radius:20px;width:100%;max-width:400px;overflow:hidden;box-shadow:var(--sh-xl);animation:slideUp .22s ease}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.share-modal-head{padding:20px 22px 16px;border-bottom:1px solid var(--ink6);display:flex;align-items:center;justify-content:space-between}
.share-modal-title{font-family:var(--fd);font-size:.92rem;font-weight:700;letter-spacing:-.02em}
.share-close{width:26px;height:26px;border-radius:50%;border:1px solid var(--ink6);background:transparent;cursor:pointer;transition:var(--ease);display:flex;align-items:center;justify-content:center}
.share-close:hover{background:var(--paper2)}
.share-preview{margin:16px 20px;border-radius:var(--rlg);overflow:hidden;border:1px solid var(--ink6)}
.share-card-dark{background:var(--dark);padding:20px;position:relative;overflow:hidden}
.share-card-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:22px 22px;pointer-events:none}
.share-c-av{width:34px;height:34px;border-radius:9px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.76rem;color:rgba(255,255,255,.75);margin-bottom:10px;position:relative;z-index:1}
.share-c-name{font-family:var(--fd);font-size:.88rem;font-weight:700;color:#fff;margin-bottom:2px;position:relative;z-index:1}
.share-c-sub{font-size:.62rem;color:rgba(255,255,255,.28);margin-bottom:12px;position:relative;z-index:1}
.share-c-rate{font-family:var(--fd);font-size:2.5rem;font-weight:700;letter-spacing:-.07em;line-height:1;position:relative;z-index:1}
.share-c-rate span{font-size:1.2rem;opacity:.3;font-weight:400}
.share-c-lbl{font-size:.59rem;color:rgba(255,255,255,.26);text-transform:uppercase;letter-spacing:.12em;margin-top:3px;position:relative;z-index:1}
.share-card-foot{background:var(--paper);padding:8px 13px;display:flex;align-items:center;justify-content:space-between}
.share-brand{font-family:var(--fd);font-size:.66rem;font-weight:600;color:var(--ink3)}
.share-disclaimer{font-size:.55rem;color:var(--ink5)}
.share-actions{padding:0 20px 20px;display:flex;flex-direction:column;gap:9px}
.share-url-row{display:flex;gap:7px;background:var(--paper);border:1px solid var(--ink5);border-radius:var(--r);padding:9px 12px;align-items:center}
.share-url-text{flex:1;font-size:.72rem;color:var(--ink3);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.share-copy-btn{display:flex;align-items:center;gap:5px;padding:6px 13px;border-radius:var(--rsm);background:var(--dark);color:var(--paper);border:none;font-family:var(--fb);font-size:.72rem;font-weight:600;cursor:pointer;transition:var(--ease);flex-shrink:0}
.share-copy-btn:hover{background:var(--dark2)}
.share-copy-btn.copied{background:var(--green)}
.share-native-btn{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:10px;border-radius:var(--r);border:1px solid var(--ink5);background:transparent;color:var(--ink3);font-family:var(--fb);font-size:.78rem;font-weight:600;cursor:pointer;transition:var(--ease)}
.share-native-btn:hover{border-color:var(--ink);color:var(--ink)}

/* ── NAV COMPARE BTN ── */
.nav-compare-btn{display:flex;align-items:center;gap:5px;padding:5px 11px;border-radius:100px;font-family:var(--fb);font-size:.74rem;font-weight:500;cursor:pointer;transition:var(--ease);border:none;background:transparent;color:var(--ink4)}
.nav-compare-btn:hover{color:var(--ink);background:var(--paper2)}
.nav-compare-btn.active{color:var(--ink2)}

/* ── TOAST ── */
.toast{position:fixed;bottom:20px;right:20px;z-index:999;padding:11px 17px;background:var(--dark);color:var(--paper);border-radius:var(--r);font-size:.78rem;font-weight:500;box-shadow:var(--sh-xl);display:flex;align-items:center;gap:8px;animation:up .2s ease;border:1px solid rgba(255,255,255,.07)}

/* ── DISCLAIMER FOOTER ── */
.disc-footer{background:var(--paper2);border-top:1px solid var(--ink6);padding:24px 44px}
.disc-inner{max-width:1160px;margin:0 auto}
.disc-text{font-size:.65rem;color:var(--ink5);line-height:1.8}
.disc-text strong{color:var(--ink4);font-weight:600}

/* ── ANIMS ── */
@keyframes up{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}
@keyframes pop{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
.spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(245,243,237,.2);border-top-color:var(--paper);animation:sp .6s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}

/* ══ DET (old company page fallback) ══ */
.det{max-width:880px;margin:0 auto;padding:52px 44px 80px}
.det-head{margin-bottom:44px;padding-bottom:36px;border-bottom:1px solid var(--ink6)}
.det-eyebrow{display:flex;align-items:center;gap:10px;font-size:.62rem;font-weight:600;color:var(--ink5);text-transform:uppercase;letter-spacing:.14em;margin-bottom:18px}
.det-av{width:40px;height:40px;border-radius:10px;background:var(--dark);color:var(--paper);display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-weight:700;font-size:.88rem}
.det-name{font-family:var(--fd);font-size:clamp(2rem,4vw,3.4rem);font-weight:700;letter-spacing:-.05em;line-height:1.02;margin-bottom:18px}
.det-meta-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.det-rate{font-family:var(--fd);font-size:1.4rem;font-weight:700;display:flex;align-items:baseline;gap:3px;letter-spacing:-.04em}
.det-badge{padding:5px 13px;border-radius:100px;font-size:.67rem;font-weight:700;letter-spacing:.02em}
.det-reports{font-size:.77rem;color:var(--ink4);display:flex;align-items:center;gap:4px}
.det-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:24px}
.det-stat{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);padding:20px 22px}
.ds-val{font-family:var(--fd);font-size:1.9rem;font-weight:700;letter-spacing:-.05em;margin-bottom:4px;line-height:1}
.ds-lbl{font-size:.62rem;color:var(--ink5);text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.ratio-block{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rlg);padding:20px 22px;margin-bottom:24px}
.ratio-labels{display:flex;justify-content:space-between;font-size:.74rem;font-weight:600;margin-bottom:10px}
.ratio-track{height:5px;background:var(--paper3);border-radius:3px;overflow:hidden}
.ratio-fill{height:100%;background:var(--greenL);border-radius:3px;transition:width 1.1s ease}
.rep-block{background:var(--white);border:1px solid var(--ink6);border-radius:var(--rxl);overflow:hidden;box-shadow:var(--sh-sm)}
.rep-head{padding:16px 24px;border-bottom:1px solid var(--ink6);display:flex;align-items:center;justify-content:space-between;background:var(--paper)}
.rep-head-t{font-family:var(--fd);font-size:.9rem;font-weight:700;letter-spacing:-.02em}
.rep-row{display:flex;align-items:center;gap:14px;padding:13px 24px;border-bottom:1px solid var(--ink6);transition:var(--ease)}
.rep-row:last-child{border-bottom:none}
.rep-row:hover{background:var(--paper)}
.rr-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.rr-role{font-size:.83rem;font-weight:600;flex:1;letter-spacing:-.01em}
.rr-days{font-size:.7rem;color:var(--ink4);display:flex;align-items:center;gap:3px;white-space:nowrap}
.rr-badge{padding:3px 10px;border-radius:100px;font-size:.63rem;font-weight:700;white-space:nowrap;letter-spacing:.02em}
.rr-g{background:rgba(185,28,28,.07);color:var(--red)}
.rr-r{background:rgba(21,128,61,.07);color:var(--green)}
.rr-date{font-size:.66rem;color:var(--ink5);white-space:nowrap}

/* ══ RESPONSIVE ══ */
@media(max-width:1024px){
  .hero{padding:56px 32px 0}
  .hero-h1{font-size:clamp(2.3rem,4.5vw,3.6rem)}
  .hero-right{width:270px}
  .sec{padding:48px 32px}
  .metrics-band{padding:24px 32px}
  .how-band{padding:52px 32px}
  .cta-band{padding:0 32px}
  .explorer-shell{padding:52px 0}
  .explorer-inner{padding:0 32px}
  .expl-range-pill{display:none}
  .cop-wrap{padding:0 32px 68px}
  .sub-page{padding:44px 32px 72px}
  .bookmarks-inner,.recent-inner{padding:0 32px}
  .trending-inner{padding:0 32px}
}
@media(max-width:860px){
  .nav{padding:0 18px;height:52px}
  .nav-link{display:none}
  .page{padding-top:52px}
  .hero{padding:44px 18px 0}
  .hero-top{flex-direction:column;gap:28px;padding-bottom:40px}
  .hero-left{max-width:100%}
  .hero-right{width:100%}
  .hero-h1{font-size:clamp(2.2rem,6vw,3.2rem)}
  .hsc-rate-pct{font-size:3.6rem}
  .metrics-band{padding:20px 18px;flex-wrap:wrap}
  .met{flex:none;width:50%;border-right:none;border-bottom:1px solid rgba(255,255,255,.06);padding:13px 0;text-align:left!important}
  .met:nth-child(odd){padding-right:14px}
  .met:nth-child(even){padding-left:14px;border-left:1px solid rgba(255,255,255,.06)}
  .met:last-child{border-bottom:none;width:100%}
  .met-val{font-size:1.6rem}
  .sec{padding:38px 18px}
  .sec-hd{flex-wrap:wrap;gap:10px}
  .top-row{gap:10px}
  .top-bar-wrap{display:none}
  .safe-grid{grid-template-columns:repeat(2,1fr);gap:9px}
  .how-band{padding:44px 18px}
  .how-steps{grid-template-columns:1fr;gap:24px}
  .how-title{font-size:1.55rem}
  .cta-band{padding:0 18px}
  .cta-inner{flex-direction:column;gap:20px;padding:28px 22px;align-items:flex-start}
  .cta-title{font-size:1.4rem}
  .explorer-shell{padding:40px 0}
  .explorer-inner{padding:0 18px}
  .expl-head{flex-direction:column;align-items:flex-start;gap:7px}
  .expl-controls{flex-direction:column}
  .expl-select-wrap{min-width:0;width:100%}
  .expl-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
  .cop-wrap{padding:0 18px 52px}
  .cop-hero-inner{padding:22px 20px;gap:18px}
  .cop-hero-right{text-align:left}
  .cop-rate-bar-wrap{margin-left:0}
  .cop-stats{grid-template-columns:1fr 1fr;gap:8px}
  .cop-breakdown{grid-template-columns:1fr;gap:9px}
  .cop-name{font-size:1.5rem}
  .cop-rate-num{font-size:2.8rem}
  .sub-page{padding:26px 18px 56px}
  .form-card{padding:22px 18px}
  .bookmarks-inner,.recent-inner{padding:0 18px}
  .trending-inner{padding:0 18px}
  .trend-card{width:170px}
}
@media(max-width:560px){
  .nav-cta span{display:none}
  .hero{padding:36px 14px 0}
  .hero-h1{font-size:2.1rem;letter-spacing:-.03em}
  .hero-desc{font-size:.86rem}
  .hero-live-strip{display:none}
  .search-bar{padding:4px 4px 4px 13px}
  .search-btn{padding:9px 13px;font-size:.72rem}
  .hsc-body{padding:18px 18px 0}
  .hsc-rate-pct{font-size:3.2rem}
  .metrics-band{padding:16px 14px}
  .met{width:100%;border-left:none!important;padding:10px 0!important}
  .met-val{font-size:1.5rem}
  .sec{padding:32px 14px}
  .sec-title{font-size:1.2rem}
  .top-row{gap:8px;padding:12px 0}
  .top-av{width:32px;height:32px;border-radius:7px;font-size:.66rem}
  .top-badge{display:none}
  .safe-grid{grid-template-columns:1fr}
  .how-band{padding:38px 14px}
  .how-title{font-size:1.4rem}
  .cta-band{padding:0 14px}
  .cta-inner{padding:22px 18px;border-radius:var(--rlg)}
  .cta-title{font-size:1.25rem}
  .cta-btn{width:100%;justify-content:center;padding:12px 18px}
  .explorer-inner{padding:0 14px}
  .expl-grid{grid-template-columns:1fr}
  .expl-chips{gap:5px}
  .expl-chip{font-size:.68rem;padding:5px 11px}
  .cop-wrap{padding:0 14px 48px}
  .cop-hero-left{flex-direction:column;align-items:flex-start;gap:12px}
  .cop-stats{grid-template-columns:1fr 1fr}
  .cop-donut-inner{flex-direction:column;gap:14px}
  .sub-page{padding:20px 14px 48px}
  .form-card{padding:18px 14px}
  .step-lbl{display:none}
  .option-grid{grid-template-columns:1fr}
  .opt-grid-2{grid-template-columns:1fr}
  .bookmarks-inner,.recent-inner{padding:0 14px}
  .trending-inner{padding:0 14px}
  .trend-card{width:155px}
  .toast{left:14px;right:14px;bottom:14px}
  .disc-footer{padding:20px 14px}
}

`;

function inject() {
  // Force re-inject by using unique ID
  const existing = document.getElementById("gai6");
  if (existing) existing.remove();

  // Inject font as a proper <link> tag (not @import in JS string)
  if (!document.getElementById("gai6-font")) {
    const link = document.createElement("link");
    link.id = "gai6-font";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=Epilogue:wght@300;400;500;600;700;800&display=swap";
    document.head.appendChild(link);
  }

  const s = document.createElement("style");
  s.id = "gai6";
  // Strip @import line since font is loaded via <link>
  s.textContent = CSS.replace(/@import url\([^)]+\);/, "");
  document.head.appendChild(s);
}

/* ─── ANIMATED SVG RING ──────────────────────────────────────────────────────── */
function Ring({ pct, color, size=64, stroke=5 }) {
  const [dash, setDash] = useState(0);
  const R = (size/2) - stroke, circ = 2 * Math.PI * R;
  useEffect(() => {
    const t = setTimeout(() => setDash((pct / 100) * circ), 80);
    return () => clearTimeout(t);
  }, [pct, circ]);
  return (
    <div className="expl-card-ring" style={{width:size,height:size,flexShrink:0}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{transform:"rotate(-90deg)"}}>
        <circle cx={size/2} cy={size/2} r={R} fill="none" stroke="var(--paper3)" strokeWidth={stroke}/>
        <circle
          cx={size/2} cy={size/2} r={R} fill="none"
          stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ - dash}
          style={{transition:"stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)"}}
        />
      </svg>
      <div className="expl-card-ring-text" style={{color, fontSize: size > 80 ? "1.1rem" : ".9rem"}}>{pct}%</div>
    </div>
  );
}

/* ─── ANIMATED BAR FILL ─────────────────────────────────────────────────────── */
function Fill({ pct, color, className="cr-fill" }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(pct), 80); return () => clearTimeout(t); }, [pct]);
  return <div className={className} style={{ width:`${w}%`, background:color }} />;
}

/* ─── VOTES HOOK ─────────────────────────────────────────────────────────────── */
function useVotes() {
  const [voted, setVoted] = useState(() => {
    try { return JSON.parse(localStorage.getItem("gai_votes")||"{}"); } catch { return {}; }
  });
  const vote = useCallback((reportId, dir) => {
    setVoted(prev => {
      const current = prev[reportId];
      // toggle off if same direction
      const next = current === dir
        ? { ...prev, [reportId]: null }
        : { ...prev, [reportId]: dir };
      try { localStorage.setItem("gai_votes", JSON.stringify(next)); } catch {}
      // Compute delta and call real db
      const delta = (() => {
        let d = 0;
        if (current === "up")   d -= 1;
        if (current === "down") d += 1;
        if (!current || current !== dir) {
          if (dir === "up")   d += 1;
          if (dir === "down") d -= 1;
        }
        return d;
      })();
      if (delta !== 0) db.vote(reportId, delta).catch(()=>{});
      return next;
    });
  }, []);
  return [voted, vote];
}
function Sparkline({ history, color, width=60, height=28 }) {
  if (!history || history.length < 2) return null;
  const max = Math.max(...history), min = Math.min(...history);
  const range = max - min || 1;
  const step = width / (history.length - 1);
  const pts = history.map((v,i) => `${i*step},${height - ((v-min)/range)*height}`).join(" ");
  return (
    <svg width={width} height={height} style={{overflow:"visible",flexShrink:0}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".7"/>
    </svg>
  );
}

function SparkTrend({ history }) {
  if (!history || history.length < 2) return null;
  const delta = history[history.length-1] - history[0];
  if (Math.abs(delta) < 2) return (
    <span className="sparkline-trend spark-flat">
      <Ico.Minus s={9} c="currentColor"/> Stable
    </span>
  );
  if (delta > 0) return (
    <span className="sparkline-trend spark-up">
      <Ico.ArrowUp s={9} c="currentColor"/> +{delta}% worse
    </span>
  );
  return (
    <span className="sparkline-trend spark-down">
      <Ico.ArrowDown s={9} c="currentColor"/> {delta}% better
    </span>
  );
}

/* ─── BOOKMARKS BAR ─────────────────────────────────────────────────────────── */
function BookmarksBar({ bookmarks, go, onManage }) {
  if (!bookmarks.length) return null;
  return (
    <div className="bookmarks-bar" style={{position:"fixed",top:58,left:0,right:0,zIndex:149}}>
      <div className="bookmarks-inner">
        <div className="bookmarks-label">
          <Ico.Bookmark s={11} c="currentColor" filled/> Saved
        </div>
        <div className="bookmarks-chips">
          {bookmarks.map(c => (
            <div key={c.id} className="bookmark-chip" onClick={()=>go("company",c)}>
              <div className="bookmark-chip-av">{c.name.slice(0,2).toUpperCase()}</div>
              <div className="bookmark-chip-name">{c.name}</div>
              <div className="bookmark-chip-rate" style={{color:rateColor(c.ghost_rate)}}>{c.ghost_rate}%</div>
            </div>
          ))}
        </div>
        <button className="bookmarks-manage" onClick={onManage}>Manage</button>
      </div>
    </div>
  );
}

/* ─── EXPLORER COMPONENT ────────────────────────────────────────────────────── */
function Explorer({ cos, ld, go, initialFilter, onFilterUsed }) {
  const [query,   setQuery]  = useState("");
  const [sort,    setSort]   = useState("ghost_rate");
  const [filter,  setFilter] = useState("all");
  const [minRate, setMinRate] = useState(0);
  const [maxRate, setMaxRate] = useState(100);

  // Apply filter from parent when View all is clicked
  useEffect(() => {
    if (initialFilter) {
      setFilter(initialFilter);
      setQuery("");
      setMinRate(0);
      setMaxRate(100);
      onFilterUsed?.();
    }
  }, [initialFilter]);

  const FILTERS = [
    { key:"all",        label:"All",               fn: ()=>true },
    { key:"responsive", label:"Responsive",        fn: c=>c.ghost_rate<=30 },
    { key:"mixed",      label:"Mixed reviews",     fn: c=>c.ghost_rate>30&&c.ghost_rate<=60 },
    { key:"low",        label:"Low response rate", fn: c=>c.ghost_rate>60 },
  ];

  const results = cos
    .filter(c => {
      const matchQ = !query.trim() || c.name.toLowerCase().includes(query.toLowerCase());
      const matchF = FILTERS.find(f=>f.key===filter)?.fn(c) ?? true;
      const matchR = c.ghost_rate >= minRate && c.ghost_rate <= maxRate;
      return matchQ && matchF && matchR;
    })
    .sort((a,b) =>
      sort==="ghost_rate" ? b.ghost_rate-a.ghost_rate :
      sort==="reports"    ? b.total_reports-a.total_reports :
      sort==="wait"       ? (b.avg_response_days||0)-(a.avg_response_days||0) :
      a.name.localeCompare(b.name)
    );

  return (
    <div className="explorer-shell">
      <div className="explorer-inner">

        {/* header */}
        <div className="expl-head">
          <div>
            <div className="expl-eyebrow">Company explorer</div>
            <div className="expl-title">Find & filter <em>any company</em></div>
          </div>
          <div className="expl-count">
            {ld ? "—" : `${results.length} of ${cos.length}`} companies
          </div>
        </div>

        {/* controls row */}
        <div className="expl-controls">
          {/* search */}
          <div className="expl-search-wrap">
            <div className="expl-search-box">
              <Ico.Search s={14} c="var(--ink4)" />
              <input
                className="expl-search-inp"
                placeholder="Search companies…"
                value={query}
                onChange={e=>setQuery(e.target.value)}
              />
              {query && (
                <button className="expl-clear" onClick={()=>setQuery("")}>
                  <Ico.X s={12} c="var(--ink4)" />
                </button>
              )}
            </div>
          </div>

          {/* sort */}
          <div className="expl-select-wrap">
            <select
              className="expl-select"
              value={sort}
              onChange={e=>setSort(e.target.value)}
            >
              <option value="ghost_rate">Sort: Response rate</option>
              <option value="reports">Sort: Most reports</option>
              <option value="wait">Sort: Longest wait</option>
              <option value="name">Sort: A – Z</option>
            </select>
            <Ico.Right s={12} c="var(--ink4)" />
          </div>
        </div>

        {/* filter chips */}
        <div className="expl-chips">
          {FILTERS.map(f=>(
            <button
              key={f.key}
              className={`expl-chip${filter===f.key?" expl-chip-on":""}`}
              onClick={()=>setFilter(f.key)}
            >
              {f.label}
              {f.key!=="all" && (
                <span className="expl-chip-count">
                  {cos.filter(f.fn).length}
                </span>
              )}
            </button>
          ))}

          {/* rate range */}
          <div className="expl-range-pill">
            <span className="expl-range-label">Rate:</span>
            <input
              type="range" min="0" max="100" step="10"
              value={minRate}
              className="expl-range"
              onChange={e=>setMinRate(Number(e.target.value))}
            />
            <span className="expl-range-val">{minRate}%</span>
            <span className="expl-range-sep">–</span>
            <input
              type="range" min="0" max="100" step="10"
              value={maxRate}
              className="expl-range"
              onChange={e=>setMaxRate(Number(e.target.value))}
            />
            <span className="expl-range-val">{maxRate}%</span>
          </div>
        </div>

        {/* results */}
        {ld ? (
          <div className="expl-grid">
            {Array(6).fill(0).map((_,i)=>(
              <div key={i} style={{
                height:180,borderRadius:20,
                background:"rgba(255,255,255,.05)",
                border:"1px solid rgba(255,255,255,.08)"
              }} className="sk"/>
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="expl-empty">
            <div className="expl-empty-icon">
              <Ico.Search s={26} c="rgba(255,255,255,.4)" />
            </div>
            <div className="expl-empty-t">No companies match</div>
            <div className="expl-empty-s">Try adjusting your search or filters</div>
            <button className="expl-reset" onClick={()=>{setQuery("");setFilter("all");setMinRate(0);setMaxRate(100);}}>
              Reset filters
            </button>
          </div>
        ) : (
          <div className="expl-grid">
            {results.map(c => {
              const col = rateColor(c.ghost_rate);
              return (
                <div key={c.id} className="expl-card" onClick={()=>go("company",c)}>
                  <div className="expl-card-body">
                    {/* top row — no badge, just avatar and report count */}
                    <div className="expl-card-top">
                      <div className="expl-card-av">{c.name.slice(0,2).toUpperCase()}</div>
                      <div className="expl-card-reports-pill">{c.total_reports} reports</div>
                    </div>

                    <div className="expl-card-name">{c.name}</div>
                    <div className="expl-card-sub">{c.total_reports} self-reported submissions</div>

                    {/* ring + info */}
                    <div className="expl-card-rate-wrap">
                      <Ring pct={c.ghost_rate} color={col} />
                      <div className="expl-card-rate-info">
                        <div className="expl-card-rate-lbl">Reported rate</div>
                        <div className="expl-card-rate-num-lg" style={{color:col}}>{c.ghost_rate}%</div>
                      </div>
                    </div>

                    <div className="expl-card-foot">
                      <div className="expl-card-meta">
                        <Ico.Clock s={11} c="rgba(255,255,255,.3)" />
                        {c.avg_response_days ? `${c.avg_response_days.toFixed(1)}d avg wait` : "No wait data"}
                      </div>
                      <div className="expl-card-link">
                        View <Ico.Right s={11} c="currentColor"/>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── HOME PAGE ─────────────────────────────────────────────────────────────── */
function Home({ go, recent, topOffset=58 }) {
  const [cos,   setCos]  = useState([]);
  const [ld,    setLd]   = useState(true);
  const [q,     setQ]    = useState("");
  const [drops, setDr]   = useState([]);
  const [explFilter, setExplFilter] = useState(null);
  const ref = useRef(), timer = useRef(), explorerRef = useRef();

  useEffect(() => {
    setLd(true);
    db.getCompanies("ghost_rate").then(d => { setCos(d||[]); setLd(false); });
  }, []);

  const onQ = useCallback(v => {
    setQ(v); clearTimeout(timer.current);
    if (!v.trim()) { setDr([]); return; }
    timer.current = setTimeout(async () => setDr(await db.search(v)||[]), 250);
  }, []);

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setDr([]); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);

  const total  = cos.reduce((a,c) => a+c.total_reports, 0);
  const avgG   = cos.length ? Math.round(cos.reduce((a,c)=>a+c.ghost_rate,0)/cos.length) : 0;
  const worst  = [...cos].sort((a,b)=>b.ghost_rate-a.ghost_rate)[0];
  const safest = [...cos].sort((a,b)=>a.ghost_rate-b.ghost_rate).slice(0,3);
  const top5   = [...cos].sort((a,b)=>b.ghost_rate-a.ghost_rate).slice(0,5);

  return (
    <div className="page" style={{paddingTop:topOffset}}>

      {/* ── HERO ── */}
      <div className="hero">
        <div className="hero-top">
          <div className="hero-left">
            <div className="hero-eyebrow">
              <div className="hero-eyebrow-line" />
              <span>Hiring transparency tracker</span>
              <div className="hero-eyebrow-dot" />
            </div>
            <h1 className="hero-h1">
              See which companies<br />
              <em>respond to applicants</em>
            </h1>
            <p className="hero-desc">
              Self-reported experiences from job seekers, aggregated anonymously.
              All data reflects user submissions and is not verified by us.
            </p>

            {/* Live stat pills */}
            {!ld && (
              <div className="hero-live-strip">
                <div className="hero-stat-pill">
                  <div className="hero-stat-pill-dot" style={{background:"var(--green)"}}/>
                  <span className="hero-stat-pill-val">{safest[0]?.name}</span>
                  <span className="hero-stat-pill-lbl">most responsive</span>
                </div>
                <div className="hero-stat-pill">
                  <div className="hero-stat-pill-dot" style={{background:"var(--red)"}}/>
                  <span className="hero-stat-pill-val">{worst?.ghost_rate}%</span>
                  <span className="hero-stat-pill-lbl">highest rate</span>
                </div>
                <div className="hero-stat-pill">
                  <span className="hero-stat-pill-val">{total.toLocaleString()}</span>
                  <span className="hero-stat-pill-lbl">reports total</span>
                </div>
              </div>
            )}

            <div className="hero-search-row">
              <div className="search-wrap" ref={ref}>
                <div className="search-bar">
                  <Ico.Search s={15} c="var(--ink4)" />
                  <input
                    className="search-inp" style={{marginLeft:10}}
                    placeholder="Search any company…"
                    value={q}
                    onChange={e=>onQ(e.target.value)}
                  />
                  {q && (
                    <button style={{background:"none",border:"none",cursor:"pointer",padding:"0 8px",color:"var(--ink5)"}} onClick={()=>{setQ("");setDr([]);}}>
                      <Ico.X s={13} c="currentColor"/>
                    </button>
                  )}
                  <button className="search-btn"><Ico.Search s={13} c="var(--paper)" />Search</button>
                </div>
                {(drops.length > 0 || q.trim()) && (
                  <div className="search-drop">
                    {drops.length === 0
                      ? <div className="sdrop-empty">Nothing found — <span onClick={()=>go("submit")}>add the first report</span></div>
                      : drops.map(c => {
                          // Highlight matching chars
                          const idx = c.name.toLowerCase().indexOf(q.toLowerCase());
                          const before = c.name.slice(0, idx);
                          const match  = c.name.slice(idx, idx + q.length);
                          const after  = c.name.slice(idx + q.length);
                          const delta  = c.history ? c.history[c.history.length-1] - c.history[0] : 0;
                          return (
                            <div key={c.id} className="sdrop-item" onClick={()=>go("company",c)}>
                              <div className="sdi-av">{c.name.slice(0,2).toUpperCase()}</div>
                              <div className="sdi-name">
                                {idx>=0 ? <>{before}<span className="sdi-highlight">{match}</span>{after}</> : c.name}
                              </div>
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                {c.history && <Sparkline history={c.history} color={rateColor(c.ghost_rate)} width={36} height={18}/>}
                                <div className="sdi-rate" style={{color:rateColor(c.ghost_rate)}}>{c.ghost_rate}%</div>
                              </div>
                              <div className="sdi-arr"><Ico.Right s={13} c="currentColor"/></div>
                            </div>
                          );
                        })
                    }
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── REFINED HERO STAT CARD ── */}
          {worst && (
            <div className="hero-right">
              <div className="hsc">
                <div className="hsc-body">
                  <div className="hsc-top-row">
                    <div className="hsc-tag">
                      <div className="hsc-tag-dot" />
                      Highest reported rate
                    </div>
                    <Ico.TrendUp s={14} c="rgba(255,255,255,.25)" />
                  </div>

                  <div className="hsc-co-row">
                    <div className="hsc-av">{worst.name.slice(0,2).toUpperCase()}</div>
                    <div>
                      <div className="hsc-co-name">{worst.name}</div>
                      <div className="hsc-co-sub">{worst.total_reports} reports submitted</div>
                    </div>
                  </div>

                  <div className="hsc-rate-row">
                    <div className="hsc-rate-pct">{worst.ghost_rate}<span>%</span></div>
                    <div className="hsc-rate-label">reported no response (user-submitted)</div>
                  </div>

                  <div className="hsc-bar">
                    <Fill pct={worst.ghost_rate} color="linear-gradient(90deg,#dc2626,#f87171)" className="hsc-bar-fill" />
                  </div>
                </div>

                <div className="hsc-footer">
                  <div className="hsc-ft-cell">
                    <div className="hsc-ft-val">{worst.total_reports}</div>
                    <div className="hsc-ft-lbl">Reports</div>
                  </div>
                  <div className="hsc-ft-cell">
                    <div className="hsc-ft-val">{worst.avg_response_days ? `${worst.avg_response_days.toFixed(1)}d` : "—"}</div>
                    <div className="hsc-ft-lbl">Avg wait</div>
                  </div>
                  <div className="hsc-ft-cell">
                    <div className="hsc-ft-val">{rateLabel(worst.ghost_rate)}</div>
                    <div className="hsc-ft-lbl">Verdict</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── METRICS BAND ── */}
      <div className="metrics-band">
        <div className="met"><div className="met-val">{cos.length}</div><div className="met-lbl">Companies tracked</div></div>
        <div className="met"><div className="met-val">{total.toLocaleString()}</div><div className="met-lbl">Reports submitted</div></div>
        <div className="met"><div className="met-val">{avgG}%</div><div className="met-lbl">Avg reported rate</div></div>
      </div>

      {/* ── TRENDING ── */}
      <TrendingSection cos={cos} go={go} />

      {/* ── TOP 5 MOST GHOSTING ── */}
      <div className="sec">
        <div className="sec-hd">
          <div className="sec-hd-left">
            <div className="sec-eyebrow">Reported data</div>
            <div className="sec-title">Highest <em>non-response</em> rates</div>
          </div>
          <button className="sec-link" onClick={()=>{ setExplFilter("low"); explorerRef.current?.scrollIntoView({behavior:"smooth",block:"start"}); }}>
            View all <Ico.Right s={12} c="currentColor"/>
          </button>
        </div>

        {ld ? (
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {Array(5).fill(0).map((_,i)=>(
              <div key={i} style={{padding:"20px 0",borderBottom:"1px solid var(--ink5)"}}>
                <div className="sk" style={{height:20,width:"50%"}}/>
              </div>
            ))}
          </div>
        ) : (
          <div className="top-list">
            {top5.map((c,i)=>(
              <div key={c.id} className="top-row" onClick={()=>go("company",c)}>
                <div className={`top-rank ${i===0?"r1":i===1?"r2":i===2?"r3":""}`}>{i+1}</div>
                <div className="top-av">{c.name.slice(0,2).toUpperCase()}</div>
                <div className="top-info">
                  <div className="top-name">{c.name}</div>
                  <div className="top-sub">{c.total_reports} reports</div>
                </div>
                {c.history && <Sparkline history={c.history} color={rateColor(c.ghost_rate)} width={52} height={22}/>}
                <div className="top-bar-wrap">
                  <div className="top-bar-track">
                    <Fill pct={c.ghost_rate} color={rateColor(c.ghost_rate)} className="top-bar-fill" />
                  </div>
                  <div className="top-bar-pct">{c.ghost_rate}%</div>
                </div>
                <div className="top-badge" style={{background:rateBg(c.ghost_rate),color:rateColor(c.ghost_rate),border:`1px solid ${rateBorder(c.ghost_rate)}`}}>
                  {rateLabel(c.ghost_rate)}
                </div>
                <div className="top-action"><Ico.Right s={14} c="currentColor"/></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── SAFEST COMPANIES ── */}
      <div className="sec" style={{paddingTop:0}}>
        <div className="sec-hd">
          <div className="sec-hd-left">
            <div className="sec-eyebrow">Reported data</div>
            <div className="sec-title">Highest <em>response</em> rates</div>
          </div>
          <button className="sec-link" onClick={()=>{ setExplFilter("responsive"); explorerRef.current?.scrollIntoView({behavior:"smooth",block:"start"}); }}>
            View all <Ico.Right s={12} c="currentColor"/>
          </button>
        </div>

        {ld ? (
          <div className="safe-grid">
            {Array(3).fill(0).map((_,i)=>(
              <div key={i} className="sk" style={{height:140}}/>
            ))}
          </div>
        ) : (
          <div className="safe-grid">
            {safest.map(c=>(
              <div key={c.id} className="safe-card" onClick={()=>go("company",c)}>
                <div className="safe-card-top">
                  <div className="safe-av">{c.name.slice(0,2).toUpperCase()}</div>
                  <div className="safe-badge">High response rate</div>
                </div>
                <div>
                  <div className="safe-name">{c.name}</div>
                  <div className="safe-sub">{c.total_reports} reports · {c.avg_response_days ? `${c.avg_response_days.toFixed(1)}d avg response` : "No wait data"}</div>
                </div>
                <div className="safe-rate">{c.ghost_rate}<span>%</span></div>
                <div className="safe-track">
                  <Fill pct={c.ghost_rate} color={rateColor(c.ghost_rate)} className="safe-fill" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── HOW IT WORKS ── */}
      <div className="how-band">
        <div className="how-inner">
          <div className="how-hd">
            <div className="how-hd-left">
              <div className="how-eyebrow">How it works</div>
              <div className="how-title">Community data,<br /><em>shared anonymously</em></div>
            </div>
            <div className="how-hd-note">All figures are self-reported by users and aggregated anonymously. No account required.</div>
          </div>
          <div className="how-steps">
            <div className="how-step">
              <div className="how-step-num">01</div>
              <div className="how-step-icon">
                <Ico.Clock s={18} c="rgba(255,255,255,.5)" />
              </div>
              <div className="how-step-title">You apply for a role</div>
              <div className="how-step-desc">You submit an application, wait for a response, and want to share what happened — good or bad.</div>
            </div>
            <div className="how-step">
              <div className="how-step-num">02</div>
              <div className="how-step-icon">
                <Ico.Plus s={18} c="rgba(255,255,255,.5)" />
              </div>
              <div className="how-step-title">Submit your experience</div>
              <div className="how-step-desc">Anonymously report the company, role, whether they responded, and how long you waited. No account needed.</div>
            </div>
            <div className="how-step">
              <div className="how-step-num">03</div>
              <div className="how-step-icon">
                <Ico.TrendUp s={18} c="rgba(255,255,255,.5)" />
              </div>
              <div className="how-step-title">Data updates in real time</div>
              <div className="how-step-desc">Your submission updates the company's aggregated response rate. All figures are self-reported estimates, not guarantees.</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── EXPLORER ── */}
      <div ref={explorerRef}>
        <Explorer cos={cos} ld={ld} go={go} initialFilter={explFilter} onFilterUsed={()=>setExplFilter(null)} />
      </div>

      {/* ── CTA BAND ── */}
      <div className="cta-band">
        <div className="cta-inner">
          <div className="cta-left">
            <div className="cta-eyebrow">Contribute</div>
            <div className="cta-title">Had an experience<br /><em>worth sharing?</em></div>
            <p className="cta-sub">Reports are anonymous and take under a minute. All data is self-reported and used only to calculate aggregate response rates.</p>
          </div>
          <button className="cta-btn" onClick={()=>go("submit")}>
            <Ico.Plus s={15} c="var(--paper)" /> Submit a report
          </button>
        </div>
      </div>

      {/* ── DISCLAIMER FOOTER ── */}
      <div className="disc-footer">
        <div className="disc-inner">
          <p className="disc-text">
            <strong>Disclaimer:</strong> All data on this platform is self-reported by users and has not been independently verified. Figures represent aggregated survey responses and are not statements of fact about any company or organisation. This platform makes no claim that any company engages in any specific hiring practice. Company names are used solely for identification purposes. If you believe a report is inaccurate, please contact us.
          </p>
        </div>
      </div>

    </div>
  );
}

/* ─── COMPANY PAGE ──────────────────────────────────────────────────────────── */
function CoPage({ data, go, bookmarks, toggleBookmark, isBookmarked, voted={}, vote=()=>{} }) {
  const [co, setCo]         = useState(data);
  const [reps, setRp]       = useState([]);
  const [ld, setLd]         = useState(true);
  const [sharing, setSharing] = useState(false);
  const [roleFilter, setRoleFilter] = useState("All");

  useEffect(()=>{
    Promise.all([db.getCompany(data.id),db.getReports(data.id)]).then(([c,r])=>{
      if(c) setCo(c); setRp(r||[]); setLd(false);
    });
  },[data.id]);

  const col   = rateColor(co.ghost_rate);
  const bg    = rateBg(co.ghost_rate);
  const bord  = rateBorder(co.ghost_rate);
  const resp  = reps.filter(r=>r.responded).length;
  const gst   = reps.filter(r=>!r.responded).length;
  const rpct  = reps.length ? Math.round(resp/reps.length*100) : 0;
  const ini   = co.name.slice(0,2).toUpperCase();
  const bookmarked = isBookmarked?.(co.id);

  // Role filter
  const roleCategories = useMemo(()=>{
    const cats = new Set(reps.map(r=>getRoleCategory(r.role)));
    return ["All", ...Array.from(cats)];
  }, [reps]);
  const filteredReps = roleFilter==="All" ? reps : reps.filter(r=>getRoleCategory(r.role)===roleFilter);

  // History
  const histDelta = co.history && co.history.length >= 2
    ? co.history[co.history.length-1] - co.history[0] : 0;

  // Stages breakdown
  const STAGES_ORDER = ["Applied only","Phone screen","Technical round","Final round","Received offer"];
  const stagesData = useMemo(() => {
    const counts = {};
    STAGES_ORDER.forEach(s => { counts[s] = {total:0, ghosted:0}; });
    reps.forEach(r => {
      const s = r.stage || "Applied only";
      if (!counts[s]) counts[s] = {total:0, ghosted:0};
      counts[s].total++;
      if (!r.responded) counts[s].ghosted++;
    });
    return STAGES_ORDER.map(s => ({
      stage: s,
      total: counts[s]?.total || 0,
      ghosted: counts[s]?.ghosted || 0,
      rate: counts[s]?.total ? Math.round((counts[s].ghosted / counts[s].total) * 100) : null,
    })).filter(s => s.total > 0);
  }, [reps]);

  return (
    <div className="page">
      <div className="cop-wrap">

        {/* BACK */}
        <div className="cop-topbar" style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <button className="back-btn" onClick={()=>go("home")}>
            <Ico.Left s={14} c="currentColor"/> All companies
          </button>
          <div style={{display:"flex",gap:8}}>
            <button
              className="cop-share-btn"
              onClick={()=>toggleBookmark(co)}
              style={bookmarked?{borderColor:"var(--ink2)",color:"var(--ink2)",background:"var(--white)"}:{}}
            >
              <Ico.Bookmark s={13} c="currentColor" filled={bookmarked}/>
              {bookmarked ? "Saved" : "Save"}
            </button>
            <button className="cop-share-btn" onClick={()=>setSharing(true)}>
              <Ico.Share s={13} c="currentColor"/> Share
            </button>
          </div>
        </div>

        {sharing && <ShareModal company={co} onClose={()=>setSharing(false)}/>}

        {/* HERO BAND */}
        <div className="cop-hero">
          <div className="cop-hero-glow" style={{background:`radial-gradient(ellipse 70% 100% at 90% 50%, ${col}20, transparent)`}}/>
          <div className="cop-hero-grid"/>
          <div className="cop-hero-inner">
            <div className="cop-hero-left">
              <div className="cop-av">{ini}</div>
              <div>
                <div className="cop-eyebrow">Company report · Self-reported data</div>
                <div className="cop-name">{co.name}</div>
                <div className="cop-chips">
                  <div className="cop-chip" style={{background:bg,color:col,border:`1px solid ${bord}`}}>
                    {rateLabel(co.ghost_rate)}
                  </div>
                  <div className="cop-chip cop-chip-neutral">
                    <Ico.Users s={11} c="currentColor"/> {co.total_reports} reports
                  </div>
                  {co.avg_response_days && (
                    <div className="cop-chip cop-chip-neutral">
                      <Ico.Clock s={11} c="currentColor"/> {co.avg_response_days.toFixed(1)}d avg
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="cop-hero-right">
              <div className="cop-rate-num" style={{color:col}}>
                {co.ghost_rate}<span className="cop-rate-pct">%</span>
              </div>
              <div className="cop-rate-lbl">non-response rate</div>
              <div className="cop-rate-bar-wrap">
                <Fill pct={co.ghost_rate} color={col} className="cop-rate-bar-fill"/>
                <div className="cop-rate-bar-track"/>
              </div>
              {co.history && (
                <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}>
                  <Sparkline history={co.history} color={col} width={80} height={24}/>
                  <SparkTrend history={co.history}/>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* STAT CARDS */}
        <div className="cop-stats">
          {[
            { icon:<Ico.Users s={17} c="var(--ink3)"/>, bg:"var(--paper2)", val:co.total_reports, lbl:"Total reports", col:"var(--ink)" },
            { icon:<Ico.Ghost s={17} c="var(--red)"/>,  bg:"rgba(185,28,28,.07)", val:gst, lbl:"No response", col:"var(--red)" },
            { icon:<Ico.Check s={17} c="var(--green)"/>,bg:"rgba(21,128,61,.07)", val:resp, lbl:"Responded", col:"var(--green)" },
            { icon:<Ico.Clock s={17} c="var(--ink3)"/>, bg:"var(--paper2)", val:co.avg_response_days?`${co.avg_response_days.toFixed(1)}d`:"—", lbl:"Avg wait", col:"var(--ink)" },
          ].map((s,i)=>(
            <div key={i} className="cop-stat">
              <div className="cop-stat-icon" style={{background:s.bg}}>{s.icon}</div>
              <div className="cop-stat-val" style={{color:s.col}}>{s.val}</div>
              <div className="cop-stat-lbl">{s.lbl}</div>
            </div>
          ))}
        </div>

        {/* BREAKDOWN: donut + ratio */}
        <div className="cop-breakdown">
          <div className="cop-donut-card">
            <div className="cop-card-title">Response breakdown</div>
            <div className="cop-donut-inner">
              <Ring pct={co.ghost_rate} color={col} size={110} stroke={9}/>
              <div className="cop-legend">
                {[
                  {c:"var(--red)",  label:"No response", val:gst },
                  {c:"var(--green)",label:"Responded",    val:resp},
                ].map((l,i)=>(
                  <div key={i} className="cop-legend-row">
                    <div className="cop-legend-dot" style={{background:l.c}}/>
                    <span className="cop-legend-label">{l.label}</span>
                    <strong className="cop-legend-val" style={{color:l.c}}>{l.val}</strong>
                  </div>
                ))}
                <div className="cop-legend-row cop-legend-total">
                  <div className="cop-legend-dot" style={{background:"var(--ink5)"}}/>
                  <span className="cop-legend-label">Total</span>
                  <strong className="cop-legend-val">{co.total_reports}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="cop-ratio-card">
            <div className="cop-card-title">Response rate</div>
            <div className="cop-ratio-big">
              <span style={{color:"var(--green)"}}>{rpct}%</span>
              <span className="cop-ratio-big-sub">responded</span>
            </div>
            <div className="cop-ratio-bar-wrap">
              <div className="cop-ratio-labels">
                <span style={{color:"var(--green)",display:"flex",alignItems:"center",gap:4}}>
                  <Ico.Check s={10} c="currentColor"/> {resp} responded
                </span>
                <span style={{color:"var(--red)",display:"flex",alignItems:"center",gap:4}}>
                  {gst} no reply <Ico.X s={10} c="currentColor"/>
                </span>
              </div>
              <div className="cop-ratio-track">
                <div className="cop-ratio-fill" style={{width:`${rpct}%`}}/>
              </div>
            </div>
            <div className="cop-verdict-block" style={{borderColor:bord, background:bg}}>
              <div className="cop-verdict-chip" style={{color:col}}>{rateLabel(co.ghost_rate)}</div>
              <p className="cop-verdict-text">
                {co.ghost_rate > 60
                  ? "Based on submitted reports, the majority of applicants received no response."
                  : co.ghost_rate > 30
                  ? "Based on submitted reports, response rates appear mixed."
                  : "Based on submitted reports, this company has a relatively high response rate."}
              </p>
            </div>
          </div>
        </div>

        {/* HISTORY CHART */}
        {co.history && co.history.length >= 2 && (
          <div className="history-card" style={{marginBottom:14}}>
            <div className="history-head">
              <div className="history-title">Response rate trend</div>
              <SparkTrend history={co.history}/>
            </div>
            <div className="history-chart">
              {co.history.map((v,i) => {
                const maxH = Math.max(...co.history);
                const h = Math.max(4, (v / maxH) * 48);
                return (
                  <div key={i} className="history-bar-wrap">
                    <div
                      className="history-bar"
                      style={{
                        height:h,
                        background:i===co.history.length-1 ? col : "var(--paper3)",
                      }}
                    />
                    <div className="history-bar-lbl">
                      {["5w","4w","3w","2w","1w"][i] || ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* STAGES BREAKDOWN */}
        {stagesData.length > 0 && (
          <div className="stages-card" style={{marginBottom:14}}>
            <div className="stages-head">
              <div className="stages-title">Ghost rate by interview stage</div>
              <div className="stages-sub">Based on {reps.length} self-reported {reps.length===1?"submission":"submissions"}</div>
            </div>
            <div className="stages-list">
              {stagesData.map((s,i) => (
                <div key={s.stage} className="stage-row">
                  <div className="stage-label">{s.stage}</div>
                  <div className="stage-bar-wrap">
                    <div className="stage-bar-track">
                      <div
                        className="stage-bar-fill"
                        style={{
                          width:`${s.rate ?? 0}%`,
                          background: s.rate > 60 ? "var(--red)" : s.rate > 30 ? "var(--amber)" : "var(--green)",
                          transition:`width .9s ${i*0.1}s ease`
                        }}
                      />
                    </div>
                  </div>
                  <div className="stage-pct" style={{color: s.rate > 60 ? "var(--red)" : s.rate > 30 ? "var(--amber)" : "var(--green)"}}>
                    {s.rate !== null ? `${s.rate}%` : "—"}
                  </div>
                  <div className="stage-count">{s.total} {s.total===1?"report":"reports"}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="cop-reports">
          <div className="cop-reports-head">
            <div>
              <div className="cop-card-title" style={{marginBottom:3}}>Individual reports</div>
              <div className="cop-reports-sub">Anonymous · Self-reported · Unverified</div>
            </div>
            <button className="nav-cta" onClick={()=>go("submit",co)}>
              <Ico.Plus s={13} c="var(--paper)"/> Add report
            </button>
          </div>

          {/* Role filter */}
          {roleCategories.length > 1 && (
            <div className="role-filter-row">
              <span className="role-filter-label">Role</span>
              {roleCategories.map(cat=>(
                <button
                  key={cat}
                  className={`role-chip${roleFilter===cat?" on":""}`}
                  onClick={()=>setRoleFilter(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {ld ? (
            <div style={{padding:"20px 28px",display:"flex",flexDirection:"column",gap:10}}>
              {Array(4).fill(0).map((_,i)=>(
                <div key={i} className="sk" style={{height:58,borderRadius:10}}/>
              ))}
            </div>
          ) : filteredReps.length===0 ? (
            <div className="cop-reports-empty">
              <div className="cop-empty-icon"><Ico.Users s={22} c="var(--ink5)"/></div>
              <div className="cop-empty-t">{roleFilter==="All"?"No reports yet":"No reports for this role"}</div>
              <div className="cop-empty-s">{roleFilter==="All"?"Be the first to share your experience":"Try a different role filter"}</div>
            </div>
          ) : filteredReps.map(r=>(
            <div key={r.id} className="cop-rep-row">
              <div className="cop-rep-stripe" style={{background:r.responded?"var(--green)":"var(--red)"}}/>

              {/* Vote column */}
              <div className="cop-rep-votes">
                <button
                  className={`vote-btn vote-up${voted[r.id]==="up"?" voted-up":""}`}
                  onClick={e=>{e.stopPropagation();vote(r.id,"up");}}
                  title="Helpful"
                >
                  <Ico.ArrowUp s={11} c="currentColor"/>
                </button>
                <span className="vote-count">{r.votes||0}</span>
                <button
                  className={`vote-btn vote-dn${voted[r.id]==="down"?" voted-dn":""}`}
                  onClick={e=>{e.stopPropagation();vote(r.id,"down");}}
                  title="Not helpful"
                >
                  <Ico.ArrowDown s={11} c="currentColor"/>
                </button>
              </div>

              <div className="cop-rep-body">
                <div className="cop-rep-role">{r.role}</div>
                <div className="cop-rep-meta">
                  <Ico.Clock s={11} c="var(--ink5)"/>
                  <span>{r.days_waited} days waited</span>
                  <span className="cop-rep-sep">·</span>
                  <span>{fmt(r.created_at)}</span>
                  {r.stage && <>
                    <span className="cop-rep-sep">·</span>
                    <span className="cop-rep-stage">{r.stage}</span>
                  </>}
                </div>
              </div>
              <div className={`cop-rep-badge ${r.responded?"cop-rep-yes":"cop-rep-no"}`}>
                {r.responded
                  ? <><Ico.Check s={10} c="currentColor"/> Replied</>
                  : <><Ico.Ghost s={10} c="currentColor"/> No response</>
                }
              </div>
            </div>
          ))}

          {reps.length > 0 && (
            <div className="cop-reports-footer">
              All reports are anonymous and self-submitted. Data is not verified by Ghosted AI.
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

/* ─── SUBMIT PAGE ───────────────────────────────────────────────────────────── */
function SubPage({ prefill, go, toast }) {
  const BLANK = {
    company: prefill?.name||"",
    role: "",
    responded: null,
    days: "",
    stage: "",
    method: "",
    ghostType: "",
    followUps: "",
    comment: "",
  };
  const [f, setF]   = useState(BLANK);
  const [err, setE] = useState({});
  const [ld, setLd] = useState(false);
  const [ok, setOk] = useState(false);
  const [step, setStep] = useState(1); // 1 = basics, 2 = details, 3 = context

  const set = (key, val) => { setF(p=>({...p,[key]:val})); setE(p=>({...p,[key]:""})); };

  const validateStep1 = () => {
    const e={};
    if(!f.company.trim()) e.company="Required";
    if(!f.role.trim())    e.role="Required";
    if(f.responded===null)e.responded="Select one";
    if(!f.days||isNaN(f.days)||+f.days<0) e.days="Enter a valid number";
    if(+f.days>365) e.days="Max 365 days";
    return e;
  };
  const validateStep2 = () => {
    const e={};
    if(!f.stage)     e.stage="Select a stage";
    if(!f.method)    e.method="Select a method";
    if(!f.ghostType) e.ghostType="Select one";
    return e;
  };

  const nextStep = () => {
    if(step===1){ const e=validateStep1(); if(Object.keys(e).length){setE(e);return;} }
    if(step===2){ const e=validateStep2(); if(Object.keys(e).length){setE(e);return;} }
    setStep(s=>s+1);
  };

  const submit = async () => {
    setLd(true);
    try {
      await db.submit({companyName:f.company.trim(),role:f.role.trim(),responded:f.responded,daysWaited:+f.days});
      setOk(true);
    } catch { toast("Something went wrong. Try again.","error"); }
    finally { setLd(false); }
  };

  const STAGES   = ["Applied only","Phone screen","Technical round","Final round","Received offer"];
  const METHODS  = ["Company website","LinkedIn","Referral","Recruiter / headhunter","Job board"];
  const G_TYPES  = ["No reply at all","Rejected after I followed up","Ghosted mid-interview process","Offer withdrawn without explanation"];
  const FOLLOWUP = ["0 — never followed up","1 follow-up","2 follow-ups","3 or more follow-ups"];

  if(ok) return (
    <div className="page">
      <div className="sub-page">
        <div className="form-card">
          <div className="suc">
            <div className="suc-ring"><Ico.Check s={26} c="var(--green)"/></div>
            <div className="suc-h">Report received</div>
            <p className="suc-p">Your submission has been added to the aggregate data. Reports are anonymous and unverified — they reflect personal experiences only.</p>
            <div className="suc-btns">
              <button className="btn-ol" onClick={()=>go("home")}>Browse companies</button>
              <button className="btn-dk" onClick={()=>{setOk(false);setF(BLANK);setE({});setStep(1);}}>Submit another</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="sub-page">
        <button className="back-btn" onClick={()=>step>1?setStep(s=>s-1):go("home")}>
          <Ico.Left s={14} c="currentColor"/> {step>1?"Back":"Home"}
        </button>

        <div className="sub-head-area">
          <div className="sub-eyebrow">Share your experience</div>
          <div className="sub-h1">Submit a report</div>
          <p className="sub-desc">Anonymous and unverified. Reports represent personal experiences only — not confirmed facts about any company.</p>
        </div>

        {/* Step indicator */}
        <div className="step-track">
          {[1,2,3].map(n=>(
            <div key={n} className={`step-node${step===n?" step-active":step>n?" step-done":""}`}>
              <div className="step-dot">
                {step>n ? <Ico.Check s={11} c="#fff"/> : <span>{n}</span>}
              </div>
              <div className="step-lbl">
                {n===1?"Basics":n===2?"Details":"Context"}
              </div>
            </div>
          ))}
          <div className="step-line">
            <div className="step-line-fill" style={{width:`${((step-1)/2)*100}%`}}/>
          </div>
        </div>

        <div className="form-card">

          {/* ── STEP 1: BASICS ── */}
          {step===1 && <>
            <div className="form-section-title">Basic information</div>

            <div className="fg">
              <label className="fl">Company name</label>
              <input className={`fi${err.company?" e":""}`} placeholder="e.g. Meta, Stripe, Shopify…" value={f.company} onChange={e=>set("company",e.target.value)}/>
              {err.company && <div className="ferr">{err.company}</div>}
            </div>

            <div className="fg">
              <label className="fl">Role applied for</label>
              <input className={`fi${err.role?" e":""}`} placeholder="e.g. Senior Product Designer" value={f.role} onChange={e=>set("role",e.target.value)}/>
              {err.role && <div className="ferr">{err.role}</div>}
            </div>

            <div className="fg">
              <label className="fl">Did they respond?</label>
              <div className="tog-grid">
                <button className={`tog${f.responded===true?" ty":""}`} onClick={()=>set("responded",true)}>
                  <div className="tog-icon"><Ico.Check s={16} c={f.responded===true?"var(--green)":"var(--ink4)"}/></div>
                  Yes, they replied
                </button>
                <button className={`tog${f.responded===false?" tn":""}`} onClick={()=>set("responded",false)}>
                  <div className="tog-icon"><Ico.Ghost s={16} c={f.responded===false?"var(--red)":"var(--ink4)"}/></div>
                  No response
                </button>
              </div>
              {err.responded && <div className="ferr" style={{marginTop:6}}>{err.responded}</div>}
            </div>

            <div className="fg">
              <label className="fl">Days waited</label>
              <input className={`fi${err.days?" e":""}`} type="number" min="0" max="365" placeholder="How many days did you wait?" value={f.days} onChange={e=>set("days",e.target.value)}/>
              {err.days && <div className="ferr">{err.days}</div>}
            </div>

            <button className="sub-btn" onClick={nextStep}>
              Continue <Ico.Right s={15} c="var(--paper)"/>
            </button>
          </>}

          {/* ── STEP 2: DETAILS ── */}
          {step===2 && <>
            <div className="form-section-title">Application details</div>

            <div className="fg">
              <label className="fl">Interview stage reached</label>
              <div className="option-grid">
                {STAGES.map(s=>(
                  <button key={s} className={`opt-btn${f.stage===s?" opt-on":""}`} onClick={()=>set("stage",s)}>
                    {f.stage===s && <Ico.Check s={12} c="currentColor"/>}
                    {s}
                  </button>
                ))}
              </div>
              {err.stage && <div className="ferr">{err.stage}</div>}
            </div>

            <div className="fg">
              <label className="fl">How you applied</label>
              <div className="option-grid">
                {METHODS.map(m=>(
                  <button key={m} className={`opt-btn${f.method===m?" opt-on":""}`} onClick={()=>set("method",m)}>
                    {f.method===m && <Ico.Check s={12} c="currentColor"/>}
                    {m}
                  </button>
                ))}
              </div>
              {err.method && <div className="ferr">{err.method}</div>}
            </div>

            <div className="fg">
              <label className="fl">How did the ghosting happen?</label>
              <div className="option-grid">
                {G_TYPES.map(g=>(
                  <button key={g} className={`opt-btn${f.ghostType===g?" opt-on":""}`} onClick={()=>set("ghostType",g)}>
                    {f.ghostType===g && <Ico.Check s={12} c="currentColor"/>}
                    {g}
                  </button>
                ))}
              </div>
              {err.ghostType && <div className="ferr">{err.ghostType}</div>}
            </div>

            <button className="sub-btn" onClick={nextStep}>
              Continue <Ico.Right s={15} c="var(--paper)"/>
            </button>
          </>}

          {/* ── STEP 3: CONTEXT ── */}
          {step===3 && <>
            <div className="form-section-title">Final context <span className="form-optional">optional</span></div>

            <div className="fg">
              <label className="fl">Follow-ups sent before silence</label>
              <div className="option-grid opt-grid-2">
                {FOLLOWUP.map(fu=>(
                  <button key={fu} className={`opt-btn${f.followUps===fu?" opt-on":""}`} onClick={()=>set("followUps",fu)}>
                    {f.followUps===fu && <Ico.Check s={12} c="currentColor"/>}
                    {fu}
                  </button>
                ))}
              </div>
            </div>

            <div className="fg">
              <label className="fl">
                Your experience <span className="form-optional">optional · max 280 chars</span>
              </label>
              <textarea
                className="fi fi-ta"
                placeholder="Anything else worth sharing about the experience? (optional)"
                maxLength={280}
                rows={4}
                value={f.comment}
                onChange={e=>set("comment",e.target.value)}
              />
              <div className="fi-char-count">{f.comment.length}/280</div>
            </div>

            <div className="sub-summary">
              <div className="sub-summary-title">Submitting report for</div>
              <div className="sub-summary-row"><span>Company</span><strong>{f.company}</strong></div>
              <div className="sub-summary-row"><span>Role</span><strong>{f.role}</strong></div>
              <div className="sub-summary-row"><span>Response</span><strong style={{color:f.responded?"var(--green)":"var(--red)"}}>{f.responded?"Replied":"No response"}</strong></div>
              <div className="sub-summary-row"><span>Stage</span><strong>{f.stage}</strong></div>
            </div>

            <button className="sub-btn" onClick={submit} disabled={ld}>
              {ld ? <span className="spin"/> : <><Ico.Plus s={15} c="var(--paper)"/> Submit report</>}
            </button>
          </>}

        </div>
      </div>
    </div>
  );
}

/* ─── RECENTLY VIEWED HOOK ───────────────────────────────────────────────────── */
function useRecentlyViewed() {
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem("gai_recent")||"[]"); } catch { return []; }
  });
  const add = useCallback(company => {
    setRecent(prev => {
      const filtered = prev.filter(c=>c.id!==company.id);
      const next = [company, ...filtered].slice(0,6);
      try { localStorage.setItem("gai_recent", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  return [recent, add];
}

/* ─── SHARE MODAL ────────────────────────────────────────────────────────────── */
function ShareModal({ company, onClose }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}?company=${encodeURIComponent(company.name)}`;
  const col = rateColor(company.ghost_rate);

  const copy = () => {
    navigator.clipboard?.writeText(url).then(()=>{
      setCopied(true); setTimeout(()=>setCopied(false), 2000);
    }).catch(()=>{});
  };

  const share = () => {
    if (navigator.share) {
      navigator.share({ title:`${company.name} on Ghosted AI`, text:`${company.name} has a ${company.ghost_rate}% non-response rate based on self-reported data.`, url });
    } else copy();
  };

  return (
    <div className="share-overlay" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="share-modal">
        <div className="share-modal-head">
          <div className="share-modal-title">Share this company</div>
          <button className="share-close" onClick={onClose}><Ico.X s={13} c="var(--ink3)"/></button>
        </div>

        {/* Preview card */}
        <div className="share-preview">
          <div className="share-card-dark">
            <div className="share-card-grid"/>
            <div className="share-c-av">{company.name.slice(0,2).toUpperCase()}</div>
            <div className="share-c-name">{company.name}</div>
            <div className="share-c-sub">{company.total_reports} self-reported submissions</div>
            <div className="share-c-rate" style={{color:col}}>{company.ghost_rate}<span>%</span></div>
            <div className="share-c-lbl">reported non-response rate</div>
          </div>
          <div className="share-card-foot">
            <div className="share-brand">Ghosted AI</div>
            <div className="share-disclaimer">Self-reported · Unverified</div>
          </div>
        </div>

        <div className="share-actions">
          <div className="share-url-row">
            <div className="share-url-text">{url}</div>
            <button className={`share-copy-btn${copied?" copied":""}`} onClick={copy}>
              {copied ? <><Ico.Check s={12} c="currentColor"/>Copied!</> : <><Ico.Copy s={12} c="currentColor"/>Copy</>}
            </button>
          </div>
          {typeof navigator!=="undefined" && navigator.share && (
            <button className="share-native-btn" onClick={share}>
              <Ico.Share s={14} c="currentColor"/> Share via…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── TRENDING SECTION ───────────────────────────────────────────────────────── */
function TrendingSection({ cos, go }) {
  const trending = useMemo(() => {
    const day = new Date().getDate();
    return [...cos]
      .sort((a,b) => (b.total_reports*(1+((+a.id*day)%3)*0.1))-(a.total_reports*(1+((+b.id*day)%3)*0.1)))
      .slice(0, 8);
  }, [cos]);

  const [paused, setPaused] = useState(false);
  if (!trending.length) return null;

  // Duplicate items so the loop is seamless
  const items = [...trending, ...trending];

  const TrendCard = ({c, i}) => (
    <div className="trend-card" onClick={()=>go("company",c)}>
      <div className="trend-card-body">
        <div className="trend-card-header">
          <div className="trend-rank-badge">#{(i % trending.length)+1}</div>
          <div className="trend-av">{c.name.slice(0,2).toUpperCase()}</div>
        </div>
        <div className="trend-name">{c.name}</div>
        <div className="trend-reports">{c.total_reports} reports</div>
        <div className="trend-rate-row">
          <div className="trend-rate-num">{c.ghost_rate}<span>%</span></div>
          <div className="trend-rate-bar-wrap">
            <div className="trend-rate-bar" style={{width:`${c.ghost_rate}%`, background:"rgba(255,255,255,.25)"}}/>
          </div>
        </div>
        <div className="trend-card-footer">
          <div className="trend-new"><Ico.Flame s={9} c="#fbbf24"/> Active</div>
          <div className="trend-view">View <Ico.Right s={10} c="currentColor"/></div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="trending-band"
      onMouseEnter={()=>setPaused(true)}
      onMouseLeave={()=>setPaused(false)}
    >
      <div className="trending-inner">
        <div className="trending-head">
          <div className="trending-icon-wrap">
            <Ico.Flame s={15} c="#fbbf24"/>
          </div>
          <div>
            <div className="trending-title">Trending this week</div>
            <div className="trending-eyebrow">Most reported companies</div>
          </div>
        </div>
      </div>

      {/* Infinite marquee — no inner padding so it bleeds edge to edge */}
      <div className="trend-marquee-outer">
        <div className={`trend-marquee-track${paused?" trend-marquee-paused":""}`}>
          {items.map((c,i) => <TrendCard key={`${c.id}-${i}`} c={c} i={i}/>)}
        </div>
      </div>
    </div>
  );
}

/* ─── COMPARE PAGE ───────────────────────────────────────────────────────────── */
function ComparePage({ cos, go }) {
  const [a, setA] = useState(null);
  const [b, setB] = useState(null);
  const [qA, setQA] = useState("");
  const [qB, setQB] = useState("");
  const [dropA, setDropA] = useState(false);
  const [dropB, setDropB] = useState(false);
  const refA = useRef(), refB = useRef();

  const filter = q => cos.filter(c=>c.name.toLowerCase().includes(q.toLowerCase())).slice(0,6);

  useEffect(() => {
    const h = e => {
      if (refA.current && !refA.current.contains(e.target)) setDropA(false);
      if (refB.current && !refB.current.contains(e.target)) setDropB(false);
    };
    document.addEventListener("mousedown", h); return ()=>document.removeEventListener("mousedown", h);
  }, []);

  const Picker = ({val, q, setQ, drop, setDrop, refEl, label, onSelect, onClear}) => (
    <div className="cmp-picker">
      <div className="cmp-picker-label">{label}</div>
      {val ? (
        <div className="cmp-selected">
          <div className="cmp-sel-av">{val.name.slice(0,2).toUpperCase()}</div>
          <div className="cmp-sel-name">{val.name}</div>
          <div className="cmp-sel-rate" style={{color:rateColor(val.ghost_rate)}}>{val.ghost_rate}%</div>
          <button className="cmp-sel-clear" onClick={onClear}><Ico.X s={11} c="var(--ink3)"/></button>
        </div>
      ) : (
        <div className="cmp-picker-search" ref={refEl}>
          <input
            className="cmp-picker-inp"
            placeholder="Search a company…"
            value={q}
            onChange={e=>{setQ(e.target.value);setDrop(true)}}
            onFocus={()=>setDrop(true)}
          />
          {drop && q && (
            <div className="cmp-picker-drop">
              {filter(q).map(c=>(
                <div key={c.id} className="cmp-drop-item" onClick={()=>{onSelect(c);setQ("");setDrop(false)}}>
                  <div className="cmp-drop-av">{c.name.slice(0,2).toUpperCase()}</div>
                  <span style={{flex:1}}>{c.name}</span>
                  <span style={{color:rateColor(c.ghost_rate),fontWeight:700,fontSize:".8rem"}}>{c.ghost_rate}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const metrics = a && b ? [
    { label:"Non-response rate", aVal:`${a.ghost_rate}%`, bVal:`${b.ghost_rate}%`, aNum:a.ghost_rate, bNum:b.ghost_rate, lowerIsBetter:true },
    { label:"Total reports", aVal:a.total_reports, bVal:b.total_reports, aNum:a.total_reports, bNum:b.total_reports, lowerIsBetter:false },
    { label:"Avg wait time", aVal:a.avg_response_days?`${a.avg_response_days.toFixed(1)}d`:"—", bVal:b.avg_response_days?`${b.avg_response_days.toFixed(1)}d`:"—", aNum:a.avg_response_days||0, bNum:b.avg_response_days||0, lowerIsBetter:true },
  ] : [];

  return (
    <div className="page">
      <div className="cmp-page">
        <button className="back-btn" onClick={()=>go("home")}><Ico.Left s={14} c="currentColor"/> Back</button>
        <div className="cmp-eyebrow">Company comparison</div>
        <div className="cmp-title">Compare two companies</div>
        <p className="cmp-sub">Select two companies to see their reported data side by side. All figures are self-reported and unverified.</p>

        <div className="cmp-pickers">
          <Picker label="Company A" val={a} q={qA} setQ={setQA} drop={dropA} setDrop={setDropA} refEl={refA}
            onSelect={c=>{ if(c.id!==b?.id) setA(c); }} onClear={()=>setA(null)} />
          <div className="cmp-vs"><div className="cmp-vs-badge">VS</div></div>
          <Picker label="Company B" val={b} q={qB} setQ={setQB} drop={dropB} setDrop={setDropB} refEl={refB}
            onSelect={c=>{ if(c.id!==a?.id) setB(c); }} onClear={()=>setB(null)} />
        </div>

        {(!a || !b) ? (
          <div className="cmp-grid">
            <div className="cmp-empty">
              <div className="cmp-empty-icon"><Ico.Compare s={32} c="currentColor"/></div>
              <div className="cmp-empty-t">Select two companies above</div>
              <div className="cmp-empty-s">Pick a company on each side to start comparing</div>
            </div>
          </div>
        ) : (
          <div className="cmp-grid">
            {metrics.map((m,i) => {
              const aWins = m.lowerIsBetter ? m.aNum <= m.bNum : m.aNum >= m.bNum;
              const bWins = m.lowerIsBetter ? m.bNum < m.aNum : m.bNum > m.aNum;
              const max = Math.max(m.aNum, m.bNum) || 1;
              return (
                <div key={i} className="cmp-metric-card">
                  <div className="cmp-metric-label">{m.label}</div>
                  <div className="cmp-metric-row">
                    <div className="cmp-metric-side">
                      <div className="cmp-metric-val" style={{color:rateColor(a.ghost_rate)}}>{m.aVal}</div>
                      <div className="cmp-metric-name">{a.name}</div>
                      {aWins && !bWins && <div className="cmp-winner"><Ico.Check s={10} c="currentColor"/>Better</div>}
                    </div>
                    <div className="cmp-metric-divider"/>
                    <div className="cmp-metric-side">
                      <div className="cmp-metric-val" style={{color:rateColor(b.ghost_rate)}}>{m.bVal}</div>
                      <div className="cmp-metric-name">{b.name}</div>
                      {bWins && !aWins && <div className="cmp-winner"><Ico.Check s={10} c="currentColor"/>Better</div>}
                    </div>
                  </div>
                  <div className="cmp-bar-compare">
                    <div className="cmp-bar-row">
                      <div className="cmp-bar-name">{a.name.slice(0,8)}</div>
                      <div className="cmp-bar-track"><div className="cmp-bar-fill" style={{width:`${(m.aNum/max)*100}%`,background:rateColor(a.ghost_rate)}}/></div>
                      <div className="cmp-bar-val" style={{color:rateColor(a.ghost_rate)}}>{m.aVal}</div>
                    </div>
                    <div className="cmp-bar-row">
                      <div className="cmp-bar-name">{b.name.slice(0,8)}</div>
                      <div className="cmp-bar-track"><div className="cmp-bar-fill" style={{width:`${(m.bNum/max)*100}%`,background:rateColor(b.ghost_rate)}}/></div>
                      <div className="cmp-bar-val" style={{color:rateColor(b.ghost_rate)}}>{m.bVal}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Nav({ go, page }) {
  return (
    <nav className="nav">
      <div className="nav-logo" onClick={()=>go("home")}>
        <div className="nav-logo-mark"><Ico.Ghost s={14} c="#fafaf7"/></div>
        <span className="nav-name">Ghosted AI</span>
      </div>
      <div className="nav-right">
        <button className="nav-link" onClick={()=>go("home")}
          style={page==="home"?{color:"var(--ink)"}:{}}>Browse</button>
        <button
          className={`nav-compare-btn${page==="compare"?" active":""}`}
          onClick={()=>go("compare")}
        >
          <Ico.Compare s={12} c="currentColor"/> Compare
        </button>
        <div className="nav-divider"/>
        <button className="nav-cta" onClick={()=>go("submit")}>
          <Ico.Plus s={12} c="var(--paper)"/> Report
        </button>
      </div>
    </nav>
  );
}

/* ─── APP ───────────────────────────────────────────────────────────────────── */
export default function App() {
  useEffect(()=>{ inject(); },[]);
  const [page, setPg] = useState("home");
  const [data, setDt] = useState(null);
  const [ts,   setTs] = useState(null);
  const [recent, addRecent] = useRecentlyViewed();
  const [bookmarks, toggleBookmark, isBookmarked] = useBookmarks();
  const [voted, vote] = useVotes();
  const [cos, setCos] = useState([]);

  useEffect(()=>{ db.getCompanies("ghost_rate").then(d=>setCos(d||[])); },[]);

  const go = useCallback((p, d=null)=>{
    setPg(p); setDt(d);
    if (p==="company" && d) addRecent(d);
    window.scrollTo({top:0,behavior:"smooth"});
  },[addRecent]);

  const toast = useCallback((msg,type="success")=>{
    setTs({msg,type}); setTimeout(()=>setTs(null),3500);
  },[]);

  // Bookmarks bar — fixed below nav on home
  const showBookmarks = page==="home" && bookmarks.length > 0;
  const showRecent    = page==="home" && recent.length > 0;
  const topOffset     = 58 + (showBookmarks ? 46 : 0) + (showRecent ? 42 : 0);

  return (
    <>
      <Nav go={go} page={page}/>

      {/* Bookmarks bar */}
      {showBookmarks && (
        <div className="bookmarks-bar" style={{position:"fixed",top:58,left:0,right:0,zIndex:151}}>
          <div className="bookmarks-inner">
            <div className="bookmarks-label">
              <Ico.Bookmark s={11} c="currentColor" filled/> Saved
            </div>
            <div className="bookmarks-chips">
              {bookmarks.map(c=>(
                <div key={c.id} className="bookmark-chip" onClick={()=>go("company",c)}>
                  <div className="bookmark-chip-av">{c.name.slice(0,2).toUpperCase()}</div>
                  <div className="bookmark-chip-name">{c.name}</div>
                  <div className="bookmark-chip-rate" style={{color:rateColor(c.ghost_rate)}}>{c.ghost_rate}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Recently viewed bar */}
      {showRecent && (
        <div className="recent-bar" style={{position:"fixed",top:showBookmarks?104:58,left:0,right:0,zIndex:150}}>
          <div className="recent-inner">
            <div className="recent-label"><Ico.History s={11} c="currentColor"/> Recent</div>
            <div className="recent-chips">
              {recent.map(c=>(
                <div key={c.id} className="recent-chip" onClick={()=>go("company",c)}>
                  <div className="recent-chip-av">{c.name.slice(0,2).toUpperCase()}</div>
                  <div className="recent-chip-name">{c.name}</div>
                  <div className="recent-chip-rate" style={{color:rateColor(c.ghost_rate)}}>{c.ghost_rate}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {page==="home"    && <Home go={go} recent={recent} topOffset={topOffset}/>}
      {page==="company" && data && (
        <CoPage
          data={data} go={go}
          toggleBookmark={toggleBookmark}
          isBookmarked={isBookmarked}
          voted={voted} vote={vote}
        />
      )}
      {page==="submit"  && <SubPage prefill={data} go={go} toast={toast}/>}
      {page==="compare" && <ComparePage cos={cos} go={go}/>}
      {ts && (
        <div className="toast">
          {ts.type==="success" ? <Ico.Check s={14} c="var(--green)"/> : <Ico.X s={14} c="var(--red)"/>}
          {ts.msg}
        </div>
      )}
    </>
  );
}
