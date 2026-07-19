/* The reader — no-build vanilla JS. It HYDRATES the baked stub in place:
   the transcript, timeline, and dashboard are already real HTML (readable with
   this file removed); app.js adds the player facade, seek, Cite, live search,
   Add-a-meeting, and the caption strip. specs/16 §P0.2 / §8. */
(() => {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hms = t => { t = Math.max(0, +t || 0);
    const h = t / 3600 | 0, m = (t % 3600) / 60 | 0, s = t % 60 | 0, p = n => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`; };
  const BASE = "/app";
  const _cache = {};
  const getJSON = async u => (_cache[u] ||= fetch(u).then(r => r.ok ? r.json() : null).catch(() => null));

  /* ---- the Studio, if this pressing has one (specs/19 R1.6) ----------------
     Live-first, static-always. The API adds meaning-search to a record that
     already searches without it; it is never what makes the record readable.
     So everything below treats the API as an upgrade that may not arrive:
     one timed attempt, and the prebuilt index answers if it does not.

     The address rides a <meta> baked by web/emit.py, beside the connect-src
     that permits it. No tag means a desk edition, and every line here is
     dead code — which is the state this file shipped in for a month. */
  const API = ($('meta[name="record-api"]') || {}).content || "";
  /* Cloud Run scales to zero, so the first query of a quiet day pays for the
     cold start. Long enough to let that land, short enough that a reader with
     a dead API is reading static results before they wonder. There is no
     retry: a second attempt would double the wait to tell them the same
     thing, and the static index is right there. */
  const API_TIMEOUT_MS = 6000;
  let API_DOWN = false;      // one failure is enough; stop asking this page

  async function askStudio(path) {
    if (!API || API_DOWN) return null;
    const ctl = new AbortController();
    const bell = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const r = await fetch(API + path, { signal: ctl.signal,
                                          credentials: "omit" });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch (e) {
      API_DOWN = true;
      return null;
    } finally { clearTimeout(bell); }
  }

  /* The promise emit.py makes at press time — "search reads the record two
     ways at once" — cannot know whether the Studio will answer. When it does
     not, the page has to stop saying it. */
  function saySearchIsStatic(why) {
    const el = $("#search-note");
    if (el) el.textContent = why;
  }

  /* ---- canon(): the exact twin of web/canon.py (pinned by a golden table) ---- */
  const VIDEO_ID = /(?:v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})/;
  const BARE_ID = /^[\w-]{11}$/;
  const STRIP = /[?&](utm_[^=&]+|feature|si|list|index|t)=[^&]*/g;
  function videoId(s) { s = (s || "").trim();
    if (BARE_ID.test(s)) return s;
    const m = VIDEO_ID.exec(s); return m ? m[1] : null; }
  function canon(url) {
    let u = (url || "").trim(); if (!u) return "";
    const v = videoId(u); if (v) return "youtube:" + v;
    u = u.replace(/#.*$/, "").replace(STRIP, "").replace(/[/&?]+$/, "");
    return "url:" + u;
  }
  window.__czcanon = canon;   // test hook

  /* ---------------- router ---------------- */
  const path = location.pathname.replace(/\/index\.html$/, "").replace(/\/$/, "") || "/app";
  document.addEventListener("DOMContentLoaded", () => {
    initScope();
    if (/\/app\/m\//.test(path)) meeting();
    else if (/\/app\/s$/.test(path)) search();
    else if (/\/app\/add$/.test(path)) addMeeting();
    else if (/\/app\/i\//.test(path)) issue();
    else if (/\/app\/watching$/.test(path)) stillWatching();
    else if (/\/app\/officials$/.test(path)) officials();
    else if (path === "/app") home();
    registerSW();
    wireSlashFocus();
  });

  /* `/` focuses the search field from any page — the field on this page if
     there is one (front page, search page), otherwise a jump to search. */
  function wireSlashFocus() {
    document.addEventListener("keydown", e => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      e.preventDefault();
      const q = $('input[name="q"]');
      if (q) { q.focus(); q.select(); } else location.href = `${BASE}/s`;
    });
  }

  /* ================= SCOPE: the town, and the body ==================
     specs/17 §8. The reader picks a town once and every page obeys it; a
     `?town=` link overrides for the visit without touching the choice.

     Three rules hold this together, and all three are about not lying:

     · The choice is localStorage and nothing else. No cookie (it would ride
       every request and become a server-side fact about a reader), no
       account, no sync. It is a preference this browser keeps, and the
       covenant page already says so.

     · A `?town=` override is NEVER written to storage. A link is somebody
       else's opinion about where you should be looking; honouring it for one
       visit is hospitality, remembering it is presumption.

     · Untowned meetings are in every scope. A meeting whose town the record
       never learned belongs to no town, so filtering it out would erase it
       silently — the one outcome a record cannot have. It shows everywhere,
       and the scope line says how many there are.

     specs/17 §14 leaves one question open: the reader who arrives on a deep
     link from another town, and must never be trapped in the wrong scope.
     The answer here is a banner that names the town they landed in and the
     town they came from, with both exits one click away — and, on a meeting
     page, the same banner when the meeting itself sits outside their scope,
     because that is the trap without a query string. */

  const TOWN_KEY = "cz-town";           /* the reader's chosen town */
  let EDP = null;
  const edition = () => (EDP ||= getJSON(`${BASE}/towns.json`)
    .then(d => d || { towns: [], bodies: [], untowned: 0 }));
  const readTown = () => { try { return localStorage.getItem(TOWN_KEY) || ""; } catch { return ""; } };
  const writeTown = t => { try { t ? localStorage.setItem(TOWN_KEY, t) : localStorage.removeItem(TOWN_KEY); } catch { /* private mode: the visit still scopes */ } };
  const REDRAW = [];                    /* page hooks re-run on a scope change */
  let SCOPE = { town: "", body: "", from: "none", stored: "", lost: "" };

  /* Resolve the scope from the URL, storage, and what the edition holds.
     Pure over (edition, location, storage) so the banner logic can reason
     about *where* the scope came from, not merely what it is. */
  function resolve(ed) {
    const names = (ed.towns || []).map(t => t.town);
    const match = n => names.find(x => x.toLowerCase() === String(n).toLowerCase()) || "";
    const p = new URLSearchParams(location.search);
    const stored = readTown();
    const body = (p.get("body") || "").trim();
    // a stored town this pressing no longer carries is a fact worth saying out
    // loud rather than a scope worth silently ignoring
    const lost = stored && !match(stored) ? stored : "";
    if (p.has("town")) {
      const asked = (p.get("town") || "").trim();
      return { town: match(asked), body, from: asked ? "link" : "link-all",
               stored: match(stored), lost, asked };
    }
    if (stored && match(stored)) return { town: match(stored), body, from: "stored", stored: match(stored), lost };
    // a dropped choice must NOT fall through to the one-town auto-scope: on a
    // pressing that now carries only Boston, a reader who chose Brookline
    // would be silently moved into a different town while the banner told
    // them they were reading everything. Widen instead, and say why.
    if (lost) return { town: "", body, from: "lost", stored: "", lost };
    if (names.length === 1) return { town: names[0], body, from: "only", stored: "", lost };
    return { town: "", body, from: "none", stored: "", lost };
  }

  async function initScope() {
    const ed = await edition();
    SCOPE = resolve(ed);
    paintScope(ed);
    wireScope(ed);
    banner(ed);
  }

  /* The header bar: name the scope, mark the active town. */
  function paintScope(ed) {
    const now = $("#scopenow");
    if (now && (ed.towns || []).length > 1)
      now.textContent = SCOPE.town || "the whole record";
    $$(".scopetown").forEach(a => a.classList.toggle(
      "active", (a.dataset.town || "") === (SCOPE.town || "")));
  }

  /* Choosing a town is a click on a real link; we take it over so the choice
     persists and the page re-scopes without a round trip. The href stays live
     for the reader who has JavaScript off — it goes somewhere true. */
  function wireScope(ed) {
    $$(".scopetown").forEach(a => a.addEventListener("click", ev => {
      ev.preventDefault();
      chooseTown(ed, a.dataset.town || "");
    }));
  }

  function chooseTown(ed, town) {
    writeTown(town);
    // a stale ?town= would outrank the choice just made, so it goes
    const u = new URL(location.href);
    u.searchParams.delete("town");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    SCOPE = resolve(ed);
    paintScope(ed);
    banner(ed);
    REDRAW.forEach(fn => { try { fn(); } catch { /* one page's redraw is not the app's */ } });
    toast(town ? `scoped to ${town} — this browser remembers, nothing else does`
               : "showing the whole record");
  }

  /* The un-trapping. */
  function banner(ed) {
    const el = $("#scopebanner"); if (!el) return;
    const many = (ed.towns || []).length > 1;
    const art = $(".meeting");
    const here = art ? (art.dataset.town || "") : "";
    let msg = "", acts = [];
    if (SCOPE.lost) {
      msg = `You chose <b>${esc(SCOPE.lost)}</b>, and this edition does not carry
             it — you are reading the whole record.`;
      acts = [{ label: "clear that choice", town: "", primary: true }];
    } else if (SCOPE.from === "link" && SCOPE.stored && SCOPE.town !== SCOPE.stored) {
      msg = `You followed a link into <b>${esc(SCOPE.town)}</b>. Your town is
             <b>${esc(SCOPE.stored)}</b> — this visit only, unless you say otherwise.`;
      acts = [{ label: `back to ${SCOPE.stored}`, town: SCOPE.stored, primary: true, go: true },
              { label: `make ${SCOPE.town} my town`, town: SCOPE.town }];
    } else if (SCOPE.from === "link" && !SCOPE.stored && SCOPE.town && many) {
      msg = `A link scoped you to <b>${esc(SCOPE.town)}</b>. You have not chosen
             a town yet.`;
      acts = [{ label: `keep ${SCOPE.town}`, town: SCOPE.town, primary: true },
              { label: "show the whole record", town: "" }];
    } else if (here && SCOPE.town && here !== SCOPE.town) {
      msg = `This meeting is <b>${esc(here)}</b>'s. You are reading in
             <b>${esc(SCOPE.town)}</b>.`;
      acts = [{ label: `switch to ${here}`, town: here, primary: true },
              { label: `stay in ${SCOPE.town}`, dismiss: true }];
    } else if (SCOPE.from === "none" && many && !SCOPE.body) {
      // first visit, more than one town: an inline row, never a modal. The
      // record stays readable behind it and "not yet" is a real answer.
      msg = `This edition carries ${ed.towns.length} towns. Pick one and every
             page will scope to it — or read all of them.`;
      acts = ed.towns.map(t => ({ label: t.town, town: t.town }))
        .concat([{ label: "the whole record", town: "", dismiss: true }]);
    }
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.innerHTML = `<p class="scopemsg">${msg}</p><div class="scopeacts"></div>`;
    const row = $(".scopeacts", el);
    acts.forEach(a => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn" + (a.primary ? " primary" : "");
      b.textContent = a.label;
      b.onclick = () => {
        if (a.dismiss) { el.hidden = true; return; }
        // "back to my town" from a foreign meeting means leaving the meeting —
        // scoping in place would leave the reader staring at the same page
        if (a.go) { writeTown(a.town); location.href = `${BASE}/`; return; }
        chooseTown(ed, a.town);
      };
      row.appendChild(b);
    });
    el.hidden = false;
  }

  /* Does a meeting belong in the current scope? Untowned always does. */
  const inScope = (town, body) =>
    (!SCOPE.town || !town || town === SCOPE.town) &&
    (!SCOPE.body || (body || "") === SCOPE.body);

  /* ================= HOME (scope + body filter) ================= */
  async function home() {
    const ed = await edition();
    const strip = $("#bodyfilter"); if (!strip) return;
    const draw = () => { paintBodies(ed, strip); filterHome(ed); };
    REDRAW.push(draw);
    draw();
  }

  /* The chips: every body the scoped town actually posted, each with the count
     that makes the number checkable. Minted here rather than baked because
     they are stateful — and the sentence they replace stays in the markup for
     the reader who never runs this file. */
  function paintBodies(ed, strip) {
    const t = (ed.towns || []).find(x => x.town === SCOPE.town);
    const list = t ? t.bodies : (ed.bodies || []);
    if (!list.length) return;
    strip.innerHTML = "";
    const chip = (label, val, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bodychip" + (SCOPE.body === val ? " active" : "");
      b.textContent = label + (n == null ? "" : " ");
      if (n != null) { const s = document.createElement("span");
        s.className = "bn"; s.textContent = n; b.appendChild(s); }
      b.onclick = () => setBody(ed, SCOPE.body === val ? "" : val);
      strip.appendChild(b);
    };
    chip("every body", "", null);
    list.forEach(b => chip(b.body || "no body recorded", b.body, b.meetings));
    strip.hidden = false;
    const plain = $("#bodylist"); if (plain) plain.hidden = true;
  }

  function setBody(ed, val) {
    // the filter belongs in the URL so a filtered view is a shareable link,
    // and NOT in storage — a body is a question you asked once, not a home
    const u = new URL(location.href);
    val ? u.searchParams.set("body", val) : u.searchParams.delete("body");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    SCOPE = { ...SCOPE, body: val };
    paintBodies(ed, $("#bodyfilter"));
    filterHome(ed);
  }

  async function filterHome(ed) {
    let shown = 0, hidden = 0;
    // the lead story re-scopes with the briefs — it carries the same data-town
    $$(".mcard, .lead").forEach(c => {
      const ok = inScope(c.dataset.town || "", c.dataset.body || "");
      c.hidden = !ok; ok ? shown++ : hidden++;
    });
    // the rail must say when a scope has emptied it, or an empty column reads
    // as "the record has nothing" instead of "your filter has nothing"
    let none = $("#mcards-none");
    if (!shown && hidden) {
      if (!none) {
        none = document.createElement("p");
        none.id = "mcards-none"; none.className = "hint";
        const box = $(".mcards"); if (box) box.appendChild(none);
      }
      none.textContent = `Nothing on this rail in ${SCOPE.body || "this scope"}`
        + (SCOPE.town ? ` for ${SCOPE.town}` : "") + ". The record itself is unchanged.";
      none.hidden = false;
    } else if (none) none.hidden = true;
    line(ed);
    await recoverage();
  }

  /* The honest sentence under the stat band: what is scoped, and what is not.
     The band's own numbers are edition-wide (issues and threads are corpus
     objects, not town objects), so rather than quietly re-scoping some cells
     and not others, the page says which is which. */
  function line(ed) {
    const el = $("#scopeline"); if (!el) return;
    if (!SCOPE.town && !SCOPE.body) { el.hidden = true; return; }
    // on a one-town edition the town scope is not a choice the reader made and
    // excludes nothing — announcing it is the nag specs/17 rules out. A body
    // filter is still a real narrowing, so that one still speaks.
    if (SCOPE.from === "only" && !SCOPE.body) { el.hidden = true; return; }
    const bits = [];
    if (SCOPE.town) bits.push(SCOPE.town);
    if (SCOPE.body) bits.push(SCOPE.body);
    const extra = ed.untowned
      ? ` ${ed.untowned} meeting(s) carry no town and appear in every scope.` : "";
    el.textContent = `Scoped to ${bits.join(" · ")} — the coverage strip and the `
      + `rails below follow it. The counts above are the whole edition.${extra}`;
    el.hidden = false;
  }

  /* Redraw the coverage strip under the scope. The bake ships a per-(town,
     body) cell count per month for exactly this: a strip that kept its
     whole-record heights beside scoped cards would be a chart contradicting
     the list next to it. */
  async function recoverage() {
    const bars = $$(".covbar"); if (!bars.length) return;
    const st = await getJSON(`${BASE}/stats.json`); if (!st) return;
    const by = {}; (st.coverage || []).forEach(c => by[c.month] = c);
    const totals = bars.map(b => {
      const rec = by[b.dataset.month]; if (!rec) return 0;
      if (!SCOPE.town && !SCOPE.body) return rec.total;
      let n = 0;
      for (const [key, v] of Object.entries(rec.cells || {})) {
        const [tw, bd] = key.split("␟");
        if (inScope(tw, bd)) n += v;
      }
      return n;
    });
    const mx = Math.max(1, ...totals);
    bars.forEach((b, i) => {
      const n = totals[i], sp = b.querySelector("span");
      if (sp) sp.style.height = (n ? Math.max(6, Math.round(56 * n / mx)) : 2) + "px";
      b.title = `${b.dataset.month}: ${n} meeting(s)`
        + (SCOPE.town || SCOPE.body ? " in this scope" : "");
    });
  }

  /* ================= OFFICIALS (scope) ================= */
  async function officials() {
    const ed = await edition();
    const draw = () => {
      let shown = 0;
      $$(".offcard").forEach(c => {
        // an official's town is where their roll calls mostly sit; one with
        // no town at all is shown everywhere, same rule as an untowned meeting
        const t = c.dataset.town || "";
        const ok = !SCOPE.town || !t || t === SCOPE.town;
        c.hidden = !ok; if (ok) shown++;
      });
      let none = $("#off-none");
      if (!shown && SCOPE.town) {
        if (!none) { none = document.createElement("p"); none.id = "off-none";
          none.className = "hint"; ($(".offgrid") || document.body).appendChild(none); }
        none.textContent = `No roll calls from ${SCOPE.town} on this edition yet.`;
        none.hidden = false;
      } else if (none) none.hidden = true;
    };
    REDRAW.push(draw);
    draw();
  }

  /* ================= MEETING ================= */
  let YT = { win: null, loaded: false, ready: false, time: 0, pending: null };
  let MINIMAP = null, STICKY_NOW = null;
  function meeting() {
    const art = $(".meeting"); if (!art) return;
    const pid = art.dataset.pid;
    getJSON(`${BASE}/meetings/${pid}.json`).then(m => m && hydrateMeeting(m));
    wirePlayer();
    wireTranscriptSeek();
    wireMoments();
    wireCite(pid);
    stickyHeader();
    window.addEventListener("message", onYT, false);
    focusHash();
    window.addEventListener("hashchange", focusHash);
  }
  /* A moment card seeks the tape, like a transcript line — the href stays a
     real #t anchor for the reader with JavaScript off. */
  function wireMoments() {
    $$(".moment[data-t]").forEach(a => a.addEventListener("click", ev => {
      ev.preventDefault();
      const t = +a.dataset.t;
      const f = $(".player.facade");
      if (f) loadTape(f.dataset.video, t); else ytSeek(t);
      history.replaceState(null, "", "#t" + Math.floor(t));
    }));
  }
  /* The sticky mini-header: once the masthead has scrolled away, a slim bar
     keeps the title, the playing time, and Cite in reach. Built here, not
     baked, because it is pure enhancement — hidden with JavaScript off. */
  function stickyHeader() {
    const h1 = $(".meeting h1"); if (!h1) return;
    const mh = document.createElement("div");
    mh.className = "mini-header";
    mh.innerHTML = `<span class="mh-title">${esc(h1.textContent.trim())}</span>`
      + `<span class="mh-now" hidden></span>`
      + `<button class="btn" type="button">⧉ Cite</button>`;
    mh.querySelector("button").onclick = () => { const c = $(".cite-all"); if (c) c.click(); };
    document.body.appendChild(mh);
    STICKY_NOW = mh.querySelector(".mh-now");
    const mast = $(".masthead");
    const onScroll = () => mh.classList.toggle("on",
      mast ? mast.getBoundingClientRect().bottom < 4 : scrollY > 220);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  /* The minimap: the meeting at a glance — a vertical timeline with a mark at
     every scored moment and a line at the playhead. Click to jump. Drawn only
     when there is room and enough to show; decorative, so it is JS-only. */
  function buildMinimap(m) {
    const dur = +m.duration || 0;
    const moments = m.moments || [];
    if (!dur || moments.length < 3) return;
    const mm = document.createElement("div");
    mm.className = "minimap on";
    mm.title = "the meeting at a glance — click to jump";
    mm.setAttribute("aria-hidden", "true");
    const fill = document.createElement("div");
    fill.className = "mm-fill"; fill.style.top = "0"; fill.style.bottom = "0";
    mm.appendChild(fill);
    moments.forEach(mo => {
      const d = document.createElement("div");
      d.className = "mm-mark" + (mo.kind === "question" ? " q" : "");
      d.style.top = Math.max(0, Math.min(99, mo.t / dur * 100)) + "%";
      mm.appendChild(d);
    });
    const now = document.createElement("div");
    now.className = "mm-now"; now.hidden = true; mm.appendChild(now);
    mm.addEventListener("click", e => {
      const r = mm.getBoundingClientRect();
      const t = Math.max(0, Math.min(dur, (e.clientY - r.top) / r.height * dur));
      const f = $(".player.facade");
      if (f) loadTape(f.dataset.video, t); else ytSeek(t);
    });
    document.body.appendChild(mm);
    MINIMAP = { now, dur };
  }
  /* the playhead, reflected in the minimap and the sticky header */
  function tick(t) {
    if (MINIMAP && MINIMAP.dur) {
      MINIMAP.now.hidden = false;
      MINIMAP.now.style.top = Math.max(0, Math.min(100, t / MINIMAP.dur * 100)) + "%";
    }
    if (STICKY_NOW) { STICKY_NOW.hidden = false; STICKY_NOW.textContent = hms(t); }
  }
  function focusHash() {
    const m = location.hash.match(/^#t(\d+)$/); if (!m) return;
    const row = document.getElementById("t" + m[1]); if (!row) return;
    $$("#transcript .seg.hit").forEach(r => r.classList.remove("hit"));
    row.classList.add("hit");
    row.scrollIntoView({ block: "center" });
    // a landed moment primes the facade: the next consented tap starts here
    const f = $(".player.facade"); if (f) YT.pending = +row.dataset.t;
  }
  function wirePlayer() {
    const f = $(".player.facade"); if (!f) return;
    f.addEventListener("click", () => loadTape(f.dataset.video));
  }
  function loadTape(vid, seekTo) {
    const f = $(".player.facade");
    if (f && !YT.loaded) {
      const ifr = document.createElement("iframe");
      ifr.allow = "autoplay; encrypted-media; picture-in-picture";
      ifr.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?enablejsapi=1&autoplay=1&rel=0`;
      ifr.addEventListener("load", () => { YT.win = ifr.contentWindow; ytSend("listening"); });
      f.classList.remove("facade"); f.innerHTML = ""; f.appendChild(ifr);
      YT.loaded = true; YT.pending = seekTo != null ? seekTo : YT.pending;
    } else if (seekTo != null) ytSeek(seekTo);
  }
  function ytSend(kind, func, args) {
    if (!YT.win) return;
    const msg = kind === "listening"
      ? { event: "listening", id: "czweb", channel: "widget" }
      : { event: "command", func, args: args || [] };
    // pin the embed origin (the inbound handler already gates on it) — the
    // frame src is fixed at youtube-nocookie.com, so this never drops a message
    YT.win.postMessage(JSON.stringify(msg), "https://www.youtube-nocookie.com");
  }
  function ytSeek(t) {
    YT.time = t; strip(t);
    // command-ready only after onReady; a click during the load gap stashes
    // into pending instead of posting into the void (and being lost)
    if (YT.win && YT.ready) { ytSend("cmd", "seekTo", [t, true]); ytSend("cmd", "playVideo", []); }
    else YT.pending = t;
  }
  function onYT(e) {
    if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.event === "onReady" || d.event === "initialDelivery") {
      YT.ready = true; ytSend("listening");
      if (YT.pending != null) { const p = YT.pending; YT.pending = null; ytSeek(p); }
    }
    if (d.info && typeof d.info.currentTime === "number") {
      YT.time = d.info.currentTime;
      followAlong(YT.time); strip(YT.time); tick(YT.time);
    }
  }
  function wireTranscriptSeek() {
    const tr = $("#transcript"); if (!tr) return;
    tr.addEventListener("click", e => {
      const seg = e.target.closest(".seg"); if (!seg) return;
      if (e.target.closest("a.ts") || !e.target.closest("a")) {
        e.preventDefault();
        const t = +seg.dataset.t;
        const f = $(".player.facade");
        if (f) loadTape(f.dataset.video, t); else ytSeek(t);
        history.replaceState(null, "", "#t" + Math.floor(t));
      }
    });
  }
  let lastNow = -9;
  function followAlong(t) {
    if (Math.abs(t - lastNow) < 0.4) return; lastNow = t;
    const rows = $$("#transcript .seg"); let hit = -1;
    for (let i = 0; i < rows.length; i++) { if (+rows[i].dataset.t <= t + 0.05) hit = i; else break; }
    rows.forEach(r => r.classList.remove("now"));
    if (hit >= 0) rows[hit].classList.add("now");
  }
  function hydrateMeeting(m) {
    buildMinimap(m);
    // reading panel (the moments panel already carries decisions/votes/tension/
    // questions; add the recurring topics and the named entities)
    const an = m.analysis || {};
    const bits = [];
    if ((an.topics || []).length)
      bits.push(panel("recurring topics", an.topics.slice(0, 12).map(tp =>
        `<a class="bead" href="#t${Math.floor(tp.t||0)}" data-seek="${tp.t||0}">${esc(tp.topic)}</a>`).join(" ")));
    const ppl = [].concat(...["people", "places", "organizations"].map(k =>
      (an.entities?.[k] || []).map(e => ({ ...e, k }))));
    if (ppl.length)
      bits.push(panel("named in the meeting", ppl.slice(0, 18).map(e =>
        `<a class="bead" data-seek="${e.t||0}" href="#t${Math.floor(e.t||0)}">${esc(e.name)}</a>`).join(" ")));
    if (bits.length) {
      const wrap = document.createElement("div");
      wrap.innerHTML = bits.join("");
      $(".transcript").before(...wrap.childNodes);
      $$("[data-seek]").forEach(a => a.addEventListener("click", ev => {
        ev.preventDefault(); const t = +a.dataset.seek;
        const f = $(".player.facade"); f ? loadTape(f.dataset.video, t) : ytSeek(t);
      }));
    }
    // language menu → caption strip
    const sel = $("#langsel");
    if (sel) sel.addEventListener("change", () => setTrack(m.pid, sel.value));
  }
  const panel = (tag, inner) => `<section class="card"><span class="tag">${esc(tag)}</span><div class="beads" style="flex-direction:row;flex-wrap:wrap">${inner}</div></section>`;
  const row = (t, html) => `<a class="bead" data-seek="${t||0}" href="#t${Math.floor(t||0)}"><span class="ts">${hms(t)}</span> ${html}</a>`;

  /* caption strip (§P1.9): a synced line under the player */
  let CUES = null;
  function setTrack(pid, code) {
    let s = $(".captionstrip");
    if (code === "en" || !code) { CUES = null; if (s) s.remove(); return; }
    const url = code === "ad" ? `${BASE}/ad/${pid}.vtt` : `${BASE}/tracks/${pid}/${code}.vtt`;
    fetch(url).then(r => r.ok ? r.text() : "").then(txt => {
      CUES = parseVTT(txt);
      if (!s) { s = document.createElement("div"); s.className = "captionstrip"; $(".player").after(s); }
      s.lang = code === "simple" ? "en" : (code === "ad" ? "en" : code);
      strip(YT.time);
    });
  }
  function strip(t) {
    const s = $(".captionstrip"); if (!s || !CUES) return;
    const c = CUES.find(c => t >= c.a && t <= c.b);
    s.textContent = c ? c.text : "";
  }
  function parseVTT(txt) {
    const out = [];
    for (const block of txt.split(/\n\n+/)) {
      const m = block.match(/(\d+:\d+:\d+[.,]\d+)\s*-->\s*(\d+:\d+:\d+[.,]\d+)/);
      if (!m) continue;
      const text = block.split(/\n/).slice(block.split(/\n/).findIndex(l => l.includes("-->")) + 1).join(" ").trim();
      if (text) out.push({ a: t2s(m[1]), b: t2s(m[2]), text });
    }
    return out;
  }
  const t2s = s => { const p = s.replace(",", ".").split(":"); return +p[0]*3600 + +p[1]*60 + parseFloat(p[2]); };

  /* Cite (§P0.2): selection → quote + speaker + body + date + deep link */
  function wireCite(pid) {
    const bar = document.createElement("div"); bar.className = "citebar";
    bar.innerHTML = '<button type="button">⧉ Cite</button>'; document.body.appendChild(bar);
    document.addEventListener("mouseup", () => {
      const sel = document.getSelection(); const txt = (sel + "").trim();
      const anchor = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest(".seg");
      if (txt.length > 4 && anchor && $("#transcript").contains(anchor)) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        bar.style.left = Math.max(8, r.left + scrollX) + "px";
        bar.style.top = (r.top + scrollY - 34) + "px"; bar.style.display = "block";
        bar.firstChild.onclick = () => { copyCite(pid, txt, anchor); bar.style.display = "none"; };
      } else bar.style.display = "none";
    });
    const allBtn = $(".cite-all"); if (allBtn) allBtn.onclick = () => copyCite(pid, "", null);
  }
  function copyCite(pid, quote, seg) {
    const title = $(".meeting h1").textContent.trim();
    const meta = $(".mmeta").textContent.trim();
    const spk = seg ? (seg.querySelector(".spk")?.textContent || (function () {
      let p = seg; while (p && !p.querySelector(".spk")) p = p.previousElementSibling; return p?.querySelector(".spk")?.textContent || ""; })()) : "";
    const t = seg ? Math.floor(+seg.dataset.t) : 0;
    const link = `${location.origin}${BASE}/m/${pid}` + (seg ? `#t${t}` : "");
    const parts = [];
    if (quote) parts.push(`“${quote}”`);
    if (spk) parts.push(`— ${spk.replace(/:$/, "")}`);
    parts.push(`${title} (${meta})`);
    parts.push(link);
    navigator.clipboard.writeText(parts.join("\n")).then(() => toast("citation copied — receipts included"));
  }

  /* ================= SEARCH ================= */
  async function search() {
    // resolve the scope here rather than trusting initScope to have landed
    // first — both await the same fetch, and a search that silently ignored
    // the reader's town would be the worst of the two failures
    const ed = await edition();
    SCOPE = resolve(ed);
    const q = new URLSearchParams(location.search).get("q") || "";
    const inp = $("#q"); if (inp) inp.value = q;
    const tsel = $("#townsel"), bsel = $("#bodysel");
    if (tsel) tsel.value = SCOPE.town || "";
    if (bsel) bsel.value = SCOPE.body || "";
    // the filters rewrite the URL, so a scoped search is a link somebody can
    // send — and widening back to every town is always one select away
    const refilter = () => {
      const u = new URL(location.href);
      const t = tsel ? tsel.value : SCOPE.town, b = bsel ? bsel.value : SCOPE.body;
      t ? u.searchParams.set("town", t) : u.searchParams.delete("town");
      b ? u.searchParams.set("body", b) : u.searchParams.delete("body");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
      SCOPE = resolve(ed);
      const val = ($("#q") && $("#q").value.trim()) || "";
      if (val) runSearch(val);
    };
    if (tsel) tsel.addEventListener("change", refilter);
    if (bsel) bsel.addEventListener("change", refilter);
    REDRAW.push(() => { if (tsel) tsel.value = SCOPE.town || ""; refilter(); });
    if (q) runSearch(q);
    const form = $("#searchform");
    if (form) form.addEventListener("submit", e => {
      e.preventDefault(); const val = $("#q").value.trim();
      const u = new URL(`${location.origin}${BASE}/s`);
      if (val) u.searchParams.set("q", val);
      if (SCOPE.town) u.searchParams.set("town", SCOPE.town);
      if (SCOPE.body) u.searchParams.set("body", SCOPE.body);
      history.replaceState(null, "", u.pathname + u.search);
      runSearch(val);
    });
    // instant search: debounced, and never under three characters — a two-letter
    // query is mostly noise over a lot of postings. Enter (the submit above)
    // still works for a reader who prefers it.
    let deb;
    if (inp) inp.addEventListener("input", () => {
      clearTimeout(deb);
      const val = inp.value.trim();
      if (val.length < 3) { if (!val) { $("#results").innerHTML = ""; selReset(); } return; }
      deb = setTimeout(() => {
        const u = new URL(location.href);
        u.searchParams.set("q", val);
        history.replaceState(null, "", u.pathname + u.search);
        runSearch(val);
      }, 320);
    });
    // j / k (or the arrows) walk the hits; Enter opens the selected one
    document.addEventListener("keydown", e => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const res = $$(".sresult"); if (!res.length) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); selMove(res, 1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); selMove(res, -1); }
      else if (e.key === "Enter" && res[SEL]) location.href = res[SEL].href;
    });
  }
  let SEL = -1;
  function selReset() { SEL = -1; }
  function selMove(res, d) {
    res.forEach(r => r.classList.remove("sel"));
    SEL = Math.max(0, Math.min(res.length - 1, (SEL < 0 ? (d > 0 ? -1 : 0) : SEL) + d));
    const el = res[SEL]; if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
  }
  /* Live-first, static-always. The Studio is asked once; whatever it cannot
     do, the prebuilt index does. Note the order: the API call is awaited
     BEFORE the static planes are fetched, so a working Studio costs one
     request rather than one request plus a megabyte of index nobody reads. */
  async function runSearch(q) {
    const box = $("#results"); box.innerHTML = '<p class="hint">searching…</p>';
    const terms = (q.toLowerCase().match(/[a-z0-9]+/g) || []);
    if (!terms.length) { box.innerHTML = '<p class="hint">type a word or phrase</p>'; return; }
    if (API && !API_DOWN) {
      const live = await liveSearch(q, terms, box);
      if (live) return;
      // It did not answer. Say so where the page promised otherwise, then do
      // exactly what a desk edition does.
      saySearchIsStatic(
        "Meaning-search needs the Studio and it is not answering right now — "
        + "searching the words in your browser instead. Nothing else on this "
        + "page depends on it.");
    }
    return staticSearch(q, terms, box);
  }

  /* The Studio's answer, rendered with the provenance it reports per hit:
     `word` (the words you typed), `meaning` (what they mean), `both`, and
     `related` when only the lexical vector reached it. Returns false if the
     API did not answer, and the caller falls back — this function never
     renders an error, because an error is not what the reader gets. */
  async function liveSearch(q, terms, box) {
    const p = new URLSearchParams({ q, space: "neural", limit: "80" });
    if (SCOPE.town) p.set("town", SCOPE.town);
    if (SCOPE.body) p.set("body", SCOPE.body);
    const r = await askStudio(`/api/search?${p}`);
    if (!r || !Array.isArray(r.hits)) return false;

    // The server says which half actually answered, and it derives that from
    // the results rather than from its own configuration. If it dropped to
    // lexical, the note says why and the page prints it verbatim rather than
    // inventing a cheerier one.
    saySearchIsStatic(r.note || (r.space === "neural"
      ? "Search read the record two ways at once — the words you typed, and "
        + "what they mean. Nothing about you was sent with the query."
      : "Search read the words you typed. Nothing about you was sent with "
        + "the query."));

    const where = [SCOPE.town, SCOPE.body].filter(Boolean).join(" · ");
    if (!r.hits.length) {
      box.innerHTML = `<p class="hint">nothing in the record for “${esc(q)}”`
        + (where ? ` in ${esc(where)}` : "") + `.</p>`;
      return true;
    }
    box.innerHTML = `<p class="hint">${r.hits.length} moment${r.hits.length > 1 ? "s" : ""} `
      + (where ? `in ${esc(where)}` : "across the record")
      + ` · <span class="live">live</span></p>`
      + r.hits.map(h => {
        const bits = [h.title, h.body, SCOPE.town ? "" : h.town, h.date];
        return `<a class="sresult" href="${BASE}/m/${encodeURIComponent(h.meeting_id)}#t${Math.floor(h.t || 0)}">
          <span class="ts">${hms(h.t)}</span>${why(h.why)}${mark(h.text || "", terms)}
          <span class="smeta">${esc(bits.filter(Boolean).join(" · "))}${h.speaker ? " · " + esc(h.speaker) : ""}</span></a>`;
      }).join("");
    return true;
  }

  /* Why this hit is here. Four words, and the reader is owed the difference:
     a moment found by meaning alone is a different claim from one that
     literally says what was typed. */
  const WHY_SAYS = { word: "the words you typed", meaning: "what you meant",
                     both: "the words, and the meaning",
                     related: "a related word" };
  function why(w) {
    w = String(w || "");
    if (!WHY_SAYS[w]) return "";
    return `<span class="prov prov-${esc(w)}" title="${esc(WHY_SAYS[w])}">${esc(w)}</span>`;
  }

  async function staticSearch(q, terms, box) {
    const [meta, segs, shards] = await Promise.all([
      getJSON(`${BASE}/search/meta.json`), getJSON(`${BASE}/search/segs.json`),
      getJSON(`${BASE}/search/shards.json`)]);
    if (!meta || !segs) { box.innerHTML = '<p class="hint">the index didn\'t load</p>'; return; }
    // fetch each term's prefix shard, intersect postings
    const sets = await Promise.all(terms.map(async t => {
      const c = /^[a-z0-9]$/.test(t[0]) ? t[0] : "_";
      const sh = await getJSON(`${BASE}/search/t-${c}.json`);
      return new Set(sh && sh[t] ? sh[t] : []);
    }));
    let ids = [...(sets[0] || [])];
    for (let i = 1; i < sets.length; i++) ids = ids.filter(x => sets[i].has(x));
    // prefer exact-phrase segments on a multi-word query; else keep the AND hits
    // (hits stays a list of segIds so a peek can reach the ±1 neighbours)
    const phrase = q.trim().toLowerCase();
    let hits = ids.filter(id => segs[id]);
    if (terms.length > 1) {
      const exact = hits.filter(id => String(segs[id][3]).toLowerCase().includes(phrase));
      if (exact.length) hits = exact;
    }
    // scope BEFORE the cut, or the 80-hit ceiling would be spent on meetings
    // the reader has said they are not looking at — and a scoped search would
    // silently return fewer results than it found
    const total = hits.length;
    if (SCOPE.town || SCOPE.body)
      hits = hits.filter(id => {
        const m = meta[segs[id][0]] || {};
        return inScope(m.town || "", m.body || "");
      });
    const cut = hits.length;
    hits = hits.slice(0, 80);
    const where = [SCOPE.town, SCOPE.body].filter(Boolean).join(" · ");
    if (!hits.length) {
      // an empty scoped result is two different facts, and the reader is owed
      // whichever one is true: nothing anywhere, or nothing *here*
      box.innerHTML = where && total
        ? `<p class="hint">Nothing for “${esc(q)}” in ${esc(where)} — but
             ${total} moment(s) elsewhere on the record.
             <button class="btn" type="button" id="widen">search every town</button></p>`
        : `<p class="hint">nothing in the record for “${esc(q)}”. It holds ${meta.length} meeting(s).</p>`;
      const w = $("#widen");
      if (w) w.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.delete("town"); u.searchParams.delete("body");
        history.replaceState(null, "", u.pathname + u.search);
        const ts = $("#townsel"), bs = $("#bodysel");
        if (ts) ts.value = ""; if (bs) bs.value = "";
        SCOPE = { ...SCOPE, town: "", body: "" };
        runSearch(q);
      };
      return;
    }
    // untowned meetings ride along in every scope, so "18 in Brookline" would
    // be claiming a town for moments the record never learned one for — count
    // them out loud instead
    const noTown = SCOPE.town
      ? hits.filter(id => !((meta[segs[id][0]] || {}).town)).length : 0;
    box.innerHTML = `<p class="hint">${hits.length} moment${hits.length>1?"s":""} `
      + (where ? `in ${esc(where)}` : "across the record")
      + (noTown ? ` · ${noTown} from meeting(s) with no town recorded` : "")
      + (where && cut < total ? ` · ${total - cut} more elsewhere on the record` : "")
      + `</p>` +
      hits.map(id => {
        const [mi, t, spk, text] = segs[id];
        const m = meta[mi] || {};
        return `<a class="sresult" data-sid="${id}" href="${BASE}/m/${m.pid}#t${Math.floor(t)}">
          <span class="ts">${hms(t)}</span>${mark(text, terms)}
          <span class="smeta">${esc([m.title, m.body, SCOPE.town ? "" : m.town, m.date].filter(Boolean).join(" · "))}${spk ? " · " + esc(spk) : ""}</span>${peek(segs, id, mi)}</a>`;
      }).join("");
    selReset();
  }
  /* The peek: ±1 segment of context from the segs plane, already in hand
     because the static path loaded it. Shown on hover (CSS); it costs no
     request, so it never burdens the live path, which does not load segs. */
  function peek(segs, id, mi) {
    const ctx = [id - 1, id, id + 1].map(i => segs[i]).filter(s => s && s[0] === mi);
    if (ctx.length < 2) return "";
    return `<span class="peek">` + ctx.map(s => {
      const now = s === segs[id] ? " pk-now" : "";
      const who = s[2] ? `<b>${esc(s[2])}</b> ` : "";
      return `<span class="${now.trim()}">${who}${esc(String(s[3]).slice(0, 150))}</span>`;
    }).join("<br>") + `</span>`;
  }
  function mark(text, terms) {
    let t = esc(text);
    for (const term of terms) t = t.replace(new RegExp(`\\b(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
    return t;
  }

  /* ================= ADD A MEETING ================= */
  const STEWARD_EMAIL = "steve@brooklineinteractive.org";
  const INBOX_REPO = "amateurmenace/control-z";
  async function addMeeting() {
    const form = $("#addform"); if (!form) return;
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const raw = $("#addurl").value.trim();
      const out = $("#addresult"); const compose = $("#addcompose");
      const key = canon(raw);
      const urls = await getJSON(`${BASE}/urls.json`) || {};
      if (key && urls[key]) {
        out.innerHTML = `<div class="addhit"><b>Already on the record.</b>
          <a class="btn primary" href="${BASE}/m/${urls[key]}" style="margin-left:10px">Walk me there →</a></div>`;
        compose.hidden = true;
      } else {
        out.innerHTML = `<p class="hint">Not on the record yet. Compose a submission for the steward — a steward reviews; the record updates on the next pressing.</p>`;
        compose.hidden = false; compose.open = true;
        wireCompose(raw);
      }
    });
  }
  function wireCompose(url) {
    const payload = () => ({ url, town: $("#ctown").value.trim(),
      body: $("#cbody").value.trim(), date: $("#cdate").value.trim(),
      note: $("#cnote").value.trim() });
    const refresh = () => {
      const p = payload();
      const title = `Add to the record: ${p.body || "meeting"} ${p.date || ""}`.trim();
      const bodyMd = "```json\n" + JSON.stringify(p, null, 2) + "\n```\n\n" + (p.note || "");
      $("#c-github").href = `https://github.com/${INBOX_REPO}/issues/new?labels=corpus-inbox&title=${encodeURIComponent(title)}&body=${encodeURIComponent(bodyMd)}`;
      $("#c-mail").href = `mailto:${STEWARD_EMAIL}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(JSON.stringify(p, null, 2))}`;
    };
    ["ctown", "cbody", "cdate", "cnote"].forEach(id => $("#" + id).addEventListener("input", refresh));
    $("#c-copy").onclick = () => navigator.clipboard.writeText(JSON.stringify(payload(), null, 2)).then(() => toast("submission JSON copied"));
    refresh();
  }

  /* ================= ISSUE (follows) ================= */
  function issue() {
    const slug = path.split("/i/")[1];
    const followed = follows();
    const head = $(".issue h1"); if (!head) return;
    const btn = document.createElement("button");
    btn.className = "btn"; btn.type = "button";
    const draw = () => btn.textContent = follows().includes(slug) ? "★ following" : "☆ follow this issue";
    btn.onclick = () => {
      const f = follows(); const i = f.indexOf(slug);
      i >= 0 ? f.splice(i, 1) : f.push(slug);
      localStorage.setItem("cz-follows", JSON.stringify(f)); draw();
      toast(follows().includes(slug) ? "following — resurfacings show on the next pressing" : "unfollowed");
    };
    draw(); head.after(btn);
  }
  const follows = () => { try { return JSON.parse(localStorage.getItem("cz-follows") || "[]"); } catch { return []; } };
  const setFollows = f => localStorage.setItem("cz-follows", JSON.stringify([...new Set(f)]));

  /* ============ STILL WATCHING (§P1.8) ============ */
  async function stillWatching() {
    wireFollowIO();
    const box = $("#stilllist"); if (!box) return;
    const slugs = follows();
    if (!slugs.length) {
      box.innerHTML = `<p class="hint">You're not following any issues yet.
        Open <a href="${BASE}/">the record</a>, walk into an issue, and tap
        ☆ follow — the resurfacings will gather here.</p>`; return;
    }
    box.innerHTML = '<p class="hint">gathering your threads…</p>';
    const issues = (await Promise.all(slugs.map(s =>
      getJSON(`${BASE}/issues/${s}.json`)))).filter(Boolean);
    if (!issues.length) { box.innerHTML = '<p class="hint">your followed issues aren\'t in this pressing.</p>'; return; }
    // newest appearance first
    issues.sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
    box.innerHTML = issues.map(i => {
      const last = i.timeline[i.timeline.length - 1] || {};
      const beads = (last.beads || []).slice(0, 3).map(b =>
        `<a class="bead" href="${BASE}/m/${last.pid}#t${Math.floor(b.t)}">
          <span class="ts">${hms(b.t)}</span> ${esc((b.text||"").slice(0,90))}</a>`).join("");
      return `<section class="card watchcard">
        <div class="thead"><a class="ttitle" href="${BASE}/i/${i.slug}">${esc(i.name)}</a>
          <span class="lmeta">${i.n_meetings} meetings · last ${esc(i.last_seen||"—")}</span></div>
        <div class="wlast"><span class="tag">latest — ${esc(last.date||"undated")} · ${esc(last.body||last.title||"")}</span>
          <div class="beads">${beads || '<p class="hint">no beads</p>'}</div></div>
        <p class="feedlink"><a href="${BASE}/feeds/${i.slug}.xml">☉ follow by RSS</a>
          · <a href="${BASE}/i/${i.slug}">the long view →</a></p>
      </section>`;
    }).join("");
  }
  function wireFollowIO() {
    const ex = $("#follow-export");
    if (ex) ex.onclick = () => {
      const blob = new Blob([JSON.stringify(follows(), null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = "cz-follows.json"; a.click(); URL.revokeObjectURL(a.href);
      toast("follows exported");
    };
    const im = $("#follow-import");
    if (im) im.onchange = () => {
      const f = im.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const arr = JSON.parse(r.result);
          if (!Array.isArray(arr)) throw 0;
          setFollows([...follows(), ...arr.map(String)]);
          toast("follows imported"); stillWatching();
        } catch { toast("that file didn't read as a follows list"); }
      };
      r.readAsText(f);
    };
  }

  /* ============ service worker + update banner (§P1.10) ============ */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`${BASE}/sw.js`).then(reg => {
      // a fresh pressing installs a new worker while the old one still controls
      reg.addEventListener("updatefound", () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller)
            updateBanner();
        });
      });
    }).catch(() => {});
  }
  function updateBanner() {
    if ($("#czupdate")) return;
    const b = document.createElement("div"); b.id = "czupdate"; b.className = "updatebar";
    b.innerHTML = 'the record refreshed — <button type="button">reload for the new pressing</button>';
    b.querySelector("button").onclick = () => location.reload();
    document.body.appendChild(b);
  }

  /* ---- toast ---- */
  let toEl;
  function toast(msg) {
    if (!toEl) { toEl = document.createElement("div"); toEl.className = "citebar";
      toEl.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:none;background:var(--surface-inverse);color:var(--text-inverse);padding:8px 14px";
      document.body.appendChild(toEl); }
    toEl.textContent = msg; toEl.style.display = "block";
    clearTimeout(toEl._t); toEl._t = setTimeout(() => toEl.style.display = "none", 2600);
  }
})();
