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
    initStudio();
    if (/\/app\/m\//.test(path)) meeting();
    else if (/\/app\/r$/.test(path)) reel();
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

  /* ================= THE STUDIO — the three-mode footprint (specs/21 P0) ======
     publicrecord ships as a reader; specs/21 lets that reader become an editor.
     The whole studio is built HERE, by script, and never baked — so a page with
     this file removed is exactly the specs/20 paper. "Paper mode" is not a
     feature that hides the studio; it is the honest floor the studio is added on
     top of. Three modes, the reader's to choose:

       preview — the default. A compact, quiet card: you can see that you can
                 edit, without the cockpit. The resident's reading is undisturbed.
       studio  — the editor. A full left sidebar, and the one place
                 publicrecord's volume goes up (the ratified accents, §6.1). The
                 paper becomes the canvas beside it.
       paper   — the studio recedes to a single tab; just the quiet reader. Never
                 louder than specs/20, because it *is* specs/20.

     The choice is localStorage and nothing else — no account, no cookie, no
     server ever learns which mode a reader prefers, the same rule the town
     scope keeps. JavaScript off, or a screen too narrow to hold both, and the
     reader gets paper: the studio is enhancement, and enhancement that cannot
     land leaves the reading whole. */

  const MODE_KEY = "cz-studio-mode";
  const RAIL_KEY = "cz-studio-rail";     // the sidebar collapsed to a rail
  const MODES = ["preview", "studio", "paper"];
  const readMode = () => { try {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.includes(m) ? m : "preview";
  } catch { return "preview"; } };
  const writeMode = m => { try { localStorage.setItem(MODE_KEY, m); }
    catch { /* private mode: the choice holds for this visit */ } };
  const readRail = () => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } };
  const writeRail = v => { try {
    v ? localStorage.setItem(RAIL_KEY, "1") : localStorage.removeItem(RAIL_KEY);
  } catch { /* private mode */ } };

  /* The mode class rides on <html>, set as early as this file can act (during
     the initial synchronous run, before DOMContentLoaded) so a preview/studio
     reader pays the smallest possible flash of un-shifted paper. The class is
     the ONLY hook the stylesheet needs: the studio accents live under
     html.cz-m-studio and simply do not exist in any other mode, so nothing loud
     can leak into the paper. */
  function markMode(m) {
    const el = document.documentElement;
    MODES.forEach(x => el.classList.toggle("cz-m-" + x, x === m));
    el.classList.toggle("cz-rail", m === "studio" && readRail());
  }

  const modeBtn = (m, label, title) =>
    `<button type="button" class="cz-mode" data-mode="${m}" title="${esc(title)}" aria-pressed="false">${esc(label)}</button>`;
  /* Three presentations, one <aside>, chosen by the mode class on <html>:
     · paper   — a quiet edge tab (◐ studio), so the reader who hid the studio
                 can bring it back; it blocks nothing.
     · preview — a compact, non-blocking pill in the corner: an invitation to
                 edit + the reel count, and a way to dismiss to paper. Never a
                 card floating over the reading (the resident's page stays fully
                 clickable, on the phone and the desktop both).
     · studio  — the full sidebar, with the mode control, the collapse handle,
                 and the reel + paper panels. */
  function studioMarkup() {
    const modes = `<div class="cz-modes" role="group" aria-label="how much studio to show">`
      + modeBtn("preview", "preview", "a compact preview")
      + modeBtn("studio", "studio", "the full editor")
      + modeBtn("paper", "paper", "just the paper — the quiet reader")
      + `</div>`;
    return `<button type="button" class="cz-tab" title="open the studio">◐ studio</button>
      <div class="cz-pill">
        <button type="button" class="cz-enter">✎ Enter the studio →</button>
        <a class="cz-pill-reel" hidden></a>
        <button type="button" class="cz-hide" title="just the paper"
                aria-label="hide the studio — just the paper">✕</button>
      </div>
      <div class="cz-panel">
        <div class="cz-head">
          <span class="cz-brand">✎ the studio</span>
          ${modes}
          <button type="button" class="cz-rail-btn" title="collapse the studio"
                  aria-label="collapse the studio">‹</button>
        </div>
        <div class="cz-full">
          <section class="cz-block">
            <span class="cz-tag">your reel</span>
            <div class="cz-reelbody"></div>
          </section>
          <section class="cz-block">
            <span class="cz-tag">your paper</span>
            <p class="cz-hint">Assemble stories, reels, charts and notes into
              your own front page — arrange it, title it, share it as your
              paper. Arriving next.</p>
          </section>
          <p class="cz-cov">no account · no server · this stays in your browser</p>
        </div>
      </div>`;
  }

  let STUDIO = null;
  function initStudio() {
    if (STUDIO) return;
    const aside = document.createElement("aside");
    aside.className = "cz-studio";
    aside.id = "cz-studio";
    aside.setAttribute("aria-label", "the studio — edit your own paper");
    aside.innerHTML = studioMarkup();
    // FIRST child of <body>, not last: position:fixed makes its DOM order purely
    // reading/tab order, and in studio mode the sidebar sits visually first (on
    // the left) — so a keyboard reaches its controls before the transcript, not
    // after the footer. In preview/paper it is a single corner button, a
    // skip-link-like first stop that costs nothing.
    document.body.insertBefore(aside, document.body.firstChild);
    STUDIO = aside;
    wireStudio();
    updateModeButtons();
    refreshReelSummary();
    // another tab that ticks a moment (or clears the reel) writes the shared key;
    // reflect it here without a reload. When THIS page is also composing, the
    // tray and ticks must move together with the summary, or the two disagree.
    window.addEventListener("storage", e => {
      if (e && e.key !== REEL_KEY && e.key !== null) return;
      if (CREEL) { CREEL.clips = readReel(REEL_KEY); buildTray(); paintTicks(); }
      refreshReelSummary();
    });
  }

  function wireStudio() {
    if (!STUDIO) return;
    $$(".cz-mode", STUDIO).forEach(b => b.onclick = () => setMode(b.dataset.mode));
    // the explicit "enter" always opens the full sidebar, even for a reader whose
    // last studio visit left it collapsed to a rail
    const enter = $(".cz-enter", STUDIO);
    if (enter) enter.onclick = () => { writeRail(false); setMode("studio"); };
    const hide = $(".cz-hide", STUDIO); if (hide) hide.onclick = () => setMode("paper");
    const tab = $(".cz-tab", STUDIO); if (tab) tab.onclick = () => setMode("preview");
    const rail = $(".cz-rail-btn", STUDIO); if (rail) rail.onclick = () => toggleRail();
    STUDIO.addEventListener("click", e => {
      const b = e.target.closest("[data-cz]"); if (!b) return;
      const act = b.dataset.cz;
      if (act === "reelcopy") { const c = readReel(REEL_KEY);
        if (c.length) copyText(reelShareURL(c), "share link copied"); }
      else if (act === "reelclear") clearReel();
    });
  }

  function setMode(m) {
    if (!MODES.includes(m)) m = "preview";
    writeMode(m); markMode(m); updateModeButtons();
    // keyboard focus must not fall to <body> when the control the reader was on
    // is display:none'd by the switch — land it on a control the new mode shows.
    focusModeControl(m);
    // moving into paper is the reader's exit from the studio; moving out restores
    // it. Nothing here touches the paper's own DOM — the shift is a class on
    // <html>, and paper mode carries none of it.
    toast(m === "studio" ? "in the studio — edit your paper"
        : m === "paper" ? "paper — just the record"
        : "preview — the studio is a tap away");
  }
  function focusModeControl(m) {
    if (!STUDIO) return;
    const el = m === "paper" ? $(".cz-tab", STUDIO)
      : m === "preview" ? $(".cz-enter", STUDIO)
      : ($('.cz-mode[data-mode="studio"]', STUDIO));
    if (el && typeof el.focus === "function") el.focus();
  }
  function toggleRail() {
    const v = !readRail(); writeRail(v);
    document.documentElement.classList.toggle("cz-rail", readMode() === "studio" && v);
    updateModeButtons();
  }
  function updateModeButtons() {
    const m = readMode();
    $$(".cz-mode", STUDIO || document).forEach(b =>
      b.setAttribute("aria-pressed", b.dataset.mode === m ? "true" : "false"));
    // the collapse handle's glyph AND its label track the stored state, so a
    // page that loads with the sidebar already collapsed reads "expand", not the
    // stale "collapse" baked into the markup
    const b = $(".cz-rail-btn", STUDIO);
    if (b) { const railed = readRail(); b.textContent = railed ? "›" : "‹";
      b.title = railed ? "expand the studio" : "collapse the studio";
      b.setAttribute("aria-label", b.title); }
  }

  /* The one make-loop that exists, surfaced (not rebuilt): the global reel the
     composer fills as you tick moments across meetings. The studio reads the
     same `cz-reel` key the meeting page writes, and shows it as a count on the
     preview pill and a panel in studio — a play link, a share link, a clear. */
  function refreshReelSummary() {
    if (!STUDIO) return;
    const clips = readReel(REEL_KEY);
    const n = clips.length;
    const body = $(".cz-reelbody", STUDIO), mini = $(".cz-pill-reel", STUDIO);
    if (!n) {
      if (body) body.innerHTML = `<p class="cz-hint">No clips yet. Open a
        meeting, tick its moments, and they gather here as a reel — across
        meetings if you like.</p>`;
      if (mini) { mini.hidden = true; mini.removeAttribute("href"); mini.textContent = ""; }
      return;
    }
    const url = reelShareURL(clips), meets = reelPids(clips).length;
    const span = meets > 1 ? ` · ${meets} meetings` : "";
    if (body) body.innerHTML =
        `<p class="cz-reeln"><b>${n}</b> clip${n > 1 ? "s" : ""} · ${hms(reelRuntime(clips))}${span}</p>`
      + `<div class="cz-reelacts">`
      +   `<a class="btn primary" href="${esc(url)}">▶ play the reel</a>`
      +   `<button type="button" class="btn" data-cz="reelcopy">⧉ share link</button>`
      +   `<button type="button" class="btn" data-cz="reelclear">clear</button></div>`
      + `<p class="cz-hint">The reel lives in this browser and its link — no
         account, no server.</p>`;
    if (mini) { mini.hidden = false; mini.href = url;
      mini.textContent = `▶ ${n} clip${n > 1 ? "s" : ""} · ${hms(reelRuntime(clips))}`; }
  }
  function clearReel() {
    try { localStorage.setItem(REEL_KEY, "[]"); } catch { /* private mode */ }
    if (CREEL) { CREEL.clips = []; buildTray(); paintTicks(); }
    refreshReelSummary(); toast("reel cleared");
  }

  // set the mode class as early as this file can act — during its initial
  // synchronous run, before DOMContentLoaded. This script is the last thing in
  // <body>, so a studio reader may still see one reflow as the paper shifts; a
  // render-blocking head script could erase it, at a cost to every page's first
  // paint, and P0 judges the one-time shift not worth that.
  markMode(readMode());

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
    getJSON(`${BASE}/meetings/${pid}.json`).then(m => {
      if (!m) return;
      hydrateMeeting(m);
      wireComposer(m);   // the reel composer (specs/20 §6, P1)
    });
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
      // a cross-meeting switch requested before the player was ready (a cite
      // tapped during the load gap) loads now, ahead of any stashed same-tape seek
      if (REELPLAY && REELPLAY.pending) {
        const pv = REELPLAY.pending; REELPLAY.pending = null; REELPLAY.settling = true;
        if (typeof setTimeout === "function")
          setTimeout(() => { if (REELPLAY) REELPLAY.settling = false; }, 500);
        ytSend("cmd", "loadVideoById", [{ videoId: pv.vid, startSeconds: pv.start }]);
      } else if (YT.pending != null) { const p = YT.pending; YT.pending = null; ytSeek(p); }
    }
    if (d.info && typeof d.info.currentTime === "number") {
      YT.time = d.info.currentTime;
      followAlong(YT.time); strip(YT.time); tick(YT.time);
      reelAdvance(YT.time);   // the /app/r viewer, if this page is one
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

  /* ================= THE REEL — compose here, play at /app/r ==============
     Highlighter's composing half, moved into the browser (specs/20 §6, P1).
     The rule that governed P0 governs this too: reading and composing live in
     the web; only rendering media stays at the desk, and the page says so.
     Every byte of a reel lives in two places and no third — this browser's
     localStorage while you build it, and the share link once you send it. No
     account, no server call on this path — the covenant, and a test that
     proves it. Cross-meeting reels are R3; the model is per-meeting, shaped
     so a second meeting's moments slot in without a redesign. */

  const REEL_V = "1";                 // the DEFAULT schema — a single-meeting link
  const REEL_VS = ["1", "2"];         // schemas the viewer reads: v1 (one meeting), v2 (across meetings)
  const MIN_CLIP = 1.0;               // a clip shorter than this can't be seen
  const r1 = n => Math.round((+n || 0) * 10) / 10;   // times to 0.1s
  const REEL_KEY = "cz-reel";         // one tray, spanning meetings (specs/20 §7.9 P2-B)

  /* a clip is {start, end} plus the moment it was cut from (t, kind, quote) and,
     once a reel spans meetings, the meeting it came from (pid, video_id, mtitle,
     body, town, date) — the metadata rides along so the tray, the cite sheet and
     the viewer never re-fetch what the reader already saw. */
  const clipLen = c => Math.max(0, r1(c.end) - r1(c.start));
  const reelRuntime = clips => r1(clips.reduce((s, c) => s + clipLen(c), 0));

  /* the share link. One meeting → the v1 form, byte-identical to every link and
     kit page already in the wild: /app/r?v=1&m=<pid>&c=<start>-<end>,… . More
     than one → v2, each clip prefixed with its own meeting:
     /app/r?v=2&c=<pid>:<start>-<end>,… . Times are positive so a bare `-` splits
     them; a YouTube id carries no `:`, so the first `:` splits the meeting off. */
  const encodeClips = clips => clips.map(c => r1(c.start) + "-" + r1(c.end)).join(",");
  const encodeClipsX = clips => clips.map(c =>
    `${encodeURIComponent(c.pid)}:${r1(c.start)}-${r1(c.end)}`).join(",");
  function shareURL(pid, clips) {
    return `${location.origin}${BASE}/r?v=${REEL_V}`
      + `&m=${encodeURIComponent(pid)}&c=${encodeClips(clips)}`;
  }
  /* the composer's link builder: v1 while the reel is one meeting (so nothing
     about an existing link changes), v2 the moment it spans two. */
  function reelShareURL(clips) {
    const pids = [...new Set(clips.map(c => c.pid).filter(Boolean))];
    if (pids.length <= 1)
      return shareURL(pids[0] || (clips[0] && clips[0].pid) || "", clips);
    return `${location.origin}${BASE}/r?v=2&c=${encodeClipsX(clips)}`;
  }
  const reelPids = clips => [...new Set(clips.map(c => c.pid).filter(Boolean))];
  /* decode a share link's query into {v, pid, clips:[{pid,start,end}]}. Pure and
     total: a malformed clip is dropped, never thrown — a link that lost a
     character in an email degrades to fewer clips, not a crash. A v1 clip
     inherits the single `m=`; a v2 clip carries its own `<pid>:` prefix. */
  function decodeReel(search) {
    const p = new URLSearchParams(search || "");
    const m = (p.get("m") || "").trim();
    const clips = [];
    for (const part of (p.get("c") || "").split(",")) {
      let pid = m, range = part;
      const colon = part.indexOf(":");
      if (colon > 0) { pid = decodeURIComponent(part.slice(0, colon)).trim(); range = part.slice(colon + 1); }
      const seg = range.split("-");
      if (seg.length !== 2) continue;
      const start = parseFloat(seg[0]), end = parseFloat(seg[1]);
      if (!isFinite(start) || !isFinite(end) || end <= start) continue;
      clips.push({ pid, start: r1(start), end: r1(end) });
    }
    return { v: p.get("v") || "", pid: (clips[0] && clips[0].pid) || m, clips };
  }

  /* the cite sheet — one receipt per clip: quote, speaker (when the page knew
     it), body · town · date, and a deep link. The single-line shape copyCite
     writes, extended to a sequence. */
  function citeSheet(meta, clips) {
    const pids = [...new Set(clips.map(c => c.pid).filter(Boolean))];
    const head = (pids.length > 1
        ? `A reel of ${clips.length} moments across ${pids.length} meetings`
        : `${meta.title} — a reel of ${clips.length} moment`
          + (clips.length === 1 ? "" : "s"))
      + ` (${hms(reelRuntime(clips))})`;
    const blocks = clips.map((c, i) => {
      // per-clip meeting when the reel spans meetings; else the one meta passed
      const pid = c.pid || meta.pid;
      const where = [c.body || meta.body, c.town || meta.town,
                     c.date || meta.date].filter(Boolean).join(" · ");
      // deep-link to the anchor (a real transcript #t), not the padded clip start
      const link = `${location.origin}${BASE}/m/${pid}#t${Math.floor(c.t != null ? c.t : c.start)}`;
      const lines = [`${i + 1}. ${hms(c.start)} — ${c.kind || "moment"}`];
      // name each clip's meeting once the reel crosses more than one
      if (c.mtitle && c.mtitle !== meta.title) lines.push(`— from ${c.mtitle}`);
      if (c.quote) lines.push(`“${c.quote}”`);
      if (c.speaker) lines.push(`— ${String(c.speaker).replace(/:$/, "")}`);
      if (where) lines.push(where);
      lines.push(link);
      return lines.join("\n");
    });
    return [head, ...blocks].join("\n\n");
  }

  /* the reel.json the desk Highlighter opens to render — the one desk-bound
     step. Its clips map straight onto highlighter/reel.py's render_reel:
     ranges=[{start,end}], cards=[{label:quote, t:start}], title. */
  function reelJSON(meta, clips) {
    return {
      schema: "publicrecord.reel/1",
      title: `${meta.title} — reel`,
      made_with: "publicrecord.studio",
      note: "Rendering the video needs the desk — open this in Highlighter "
        + "(control-z), point it at the meeting's local media, and cut.",
      meeting: { pid: meta.pid, video_id: meta.video_id || "",
                 url: meta.url || "", title: meta.title || "",
                 town: meta.town || "", body: meta.body || "",
                 date: meta.date || "" },
      runtime: reelRuntime(clips),
      share: shareURL(meta.pid, clips),
      clips: clips.map(c => ({ start: r1(c.start), end: r1(c.end),
                               kind: c.kind || "moment", quote: c.quote || "",
                               source_t: c.t == null ? r1(c.start) : r1(c.t) })),
    };
  }
  function downloadReel(meta, clips) {
    const blob = new Blob([JSON.stringify(reelJSON(meta, clips), null, 2)],
                          { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${meta.pid || "reel"}.reel.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast("reel.json downloaded — open it at the desk to render");
  }
  function copyText(txt, msg) {
    navigator.clipboard.writeText(txt).then(
      () => toast(msg),
      () => toast("couldn’t copy — your browser blocked the clipboard"));
  }

  /* --- P1a: the composer, on the meeting page --- */
  let CREEL = null;   // {pid, meta, moments, clips, segs}

  function wireComposer(m) {
    if (!(m.moments && m.moments.length)) return;
    const meta = { pid: m.pid, title: m.title || "", town: m.town || "",
                   body: m.body || "", date: m.date || "",
                   video_id: m.video_id || "", url: m.url || "",
                   duration: +m.duration || 0 };
    // the transcript's segment starts, for trimming a clip to segment bounds
    const segs = $$("#transcript .seg").map(s => +s.dataset.t)
      .filter(t => isFinite(t)).sort((a, b) => a - b);
    CREEL = { pid: m.pid, meta, moments: m.moments, clips: loadReel(), segs };
    wireTicks();
    buildTray();
    paintTicks();
    // loadReel() may have just migrated legacy per-meeting drafts into the global
    // reel; the studio summary was painted before this meeting hydrated, so bring
    // it in line with what the tray now holds.
    refreshReelSummary();
  }
  // a clip's storage key, independent of the meeting on screen (unlike clipId,
  // which reads CREEL): a clip already carries its own pid.
  const clipKey = c => (c.pid || "") + "@" + (c.kind || "moment") + "@" + r1(c.t);
  /* the tray is one reel across meetings (specs/20 §7.9 P2-B): a single global
     key, each clip tagged with the meeting it came from. Every pre-P2-B
     per-meeting draft (`cz-reel-<pid>`) is folded into the global reel once —
     tagged, deduped — and removed, so nothing is lost, orphaned, or resurrected
     after a later clear. */
  function loadReel() {
    const clips = readReel(REEL_KEY);
    try {
      const olds = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("cz-reel-") === 0) olds.push(k);
      }
      if (olds.length) {
        const seen = new Set(clips.map(clipKey));
        for (const k of olds) {
          const pid = k.slice("cz-reel-".length);
          for (const c of readReel(k)) {
            const tagged = { ...c, pid };
            if (!seen.has(clipKey(tagged))) { clips.push(tagged); seen.add(clipKey(tagged)); }
          }
          localStorage.removeItem(k);
        }
        localStorage.setItem(REEL_KEY, JSON.stringify(clips));
      }
    } catch { /* storage disabled — the global reel still works for this visit */ }
    return clips;
  }
  function readReel(key) { try {
    const a = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(a)
      ? a.filter(c => c && isFinite(c.start) && isFinite(c.end)) : [];
  } catch { return []; } }
  const saveReel = () => { try {
    localStorage.setItem(REEL_KEY, JSON.stringify(CREEL.clips));
  } catch { /* private mode: the tray still works for this visit */ }
    refreshReelSummary();   // keep the studio's reel count live as you tick
  };

  function wireTicks() {
    $$(".mo-card").forEach(card => {
      const a = card.querySelector(".moment"); if (!a) return;
      card.dataset.t = r1(+a.dataset.t);
      const b = document.createElement("button");
      b.type = "button"; b.className = "mo-tick";
      b.addEventListener("click", ev => {
        ev.preventDefault(); ev.stopPropagation(); toggleClip(a);
      });
      card.appendChild(b);
    });
  }
  function momentOf(a) {
    // t is the anchor (the panel seek + the clip's identity); [start,end] is the
    // padded clip window the bake computed — the reel plays the whole sentence
    const t = r1(+a.dataset.t);
    return { t, start: r1(+a.dataset.start || t),
             end: r1(+a.dataset.end || (t + 12)),
             kind: a.dataset.kind || "moment", quote: a.dataset.quote || "" };
  }
  // a clip's identity is (meeting, kind, time) — the bake's own moment dedup key
  // (kind, int(t) in web/bake.py) plus the meeting, so a reel can hold the same
  // kind+second from two meetings, and a tick here toggles only its own clip. A
  // moment read off this page carries no pid, so it stands for this meeting.
  const clipId = c => (c.pid || CREEL.pid) + "@" + (c.kind || "moment") + "@" + r1(c.t);
  const inReel = mo => CREEL.clips.findIndex(c => clipId(c) === clipId(mo));
  function toggleClip(a) {
    const mo = momentOf(a), i = inReel(mo);
    if (i >= 0) CREEL.clips.splice(i, 1);
    else CREEL.clips.push({ ...mo, pid: CREEL.pid, video_id: CREEL.meta.video_id,
                            mtitle: CREEL.meta.title, body: CREEL.meta.body,
                            town: CREEL.meta.town, date: CREEL.meta.date,
                            duration: CREEL.meta.duration || 0 });
    saveReel(); buildTray(); paintTicks();
    toast(i >= 0 ? "removed from the reel" : "added to the reel");
  }
  function paintTicks() {
    $$(".mo-card").forEach(card => {
      const a = card.querySelector(".moment"); if (!a) return;
      const inr = inReel(momentOf(a)) >= 0;
      card.classList.toggle("in-reel", inr);
      const b = card.querySelector(".mo-tick");
      if (b) { b.setAttribute("aria-pressed", inr ? "true" : "false");
        b.title = inr ? "in the reel — click to remove" : "add to the reel";
        b.textContent = inr ? "✓ in reel" : "＋ reel"; }
    });
  }

  function buildTray() {
    let tray = $("#reeltray");
    if (!CREEL.clips.length) { if (tray) tray.remove(); return; }
    if (!tray) {
      tray = document.createElement("section");
      tray.className = "card reeltray"; tray.id = "reeltray";
      (($(".moments")) || $(".meeting")).after(tray);
    }
    const clips = CREEL.clips;
    const multi = reelPids(clips).length > 1;
    const rows = clips.map((c, i) => {
      const other = c.pid && c.pid !== CREEL.pid;   // a clip from another meeting than the one on screen
      return `<div class="rt-clip${other ? " rt-other" : ""}" data-i="${i}">
        <div class="rt-ord">${i + 1}</div>
        <div class="rt-main">
          ${(multi || other) ? `<div class="rt-from">${esc(c.mtitle || c.pid || "another meeting")}</div>` : ""}
          <div class="rt-quote">${esc((c.quote || "").slice(0, 120)) || "(moment)"}</div>
          <div class="rt-times"><span class="rt-kind">${esc(c.kind || "moment")}</span>
            <span class="rt-range"><span class="ts">${hms(c.start)}</span>–<span class="ts">${hms(c.end)}</span> · ${hms(clipLen(c))}</span></div>
          <div class="rt-trim" role="group" aria-label="trim clip ${i + 1}">
            <span class="rt-tl">in</span>
            <button class="rt-b" type="button" data-act="s-" aria-label="start earlier">◀</button>
            <button class="rt-b" type="button" data-act="s+" aria-label="start later">▶</button>
            <span class="rt-tl">out</span>
            <button class="rt-b" type="button" data-act="e-" aria-label="end earlier">◀</button>
            <button class="rt-b" type="button" data-act="e+" aria-label="end later">▶</button>
          </div>
        </div>
        <div class="rt-move">
          <button class="rt-b" type="button" data-act="up" aria-label="move earlier"${i === 0 ? " disabled" : ""}>↑</button>
          <button class="rt-b" type="button" data-act="down" aria-label="move later"${i === clips.length - 1 ? " disabled" : ""}>↓</button>
          <button class="rt-b rt-x" type="button" data-act="rm" aria-label="remove">✕</button>
        </div></div>`;
    }).join("");
    const url = reelShareURL(clips);
    const span = multi ? ` · ${reelPids(clips).length} meetings` : "";
    tray.innerHTML = `<div class="rt-head">
        <span class="tag">your reel — ${clips.length} clip${clips.length > 1 ? "s" : ""} · ${hms(reelRuntime(clips))} total${span}</span>
        <button class="btn rt-clear" type="button">clear</button></div>
      <div class="rt-clips">${rows}</div>
      <div class="rt-out">
        <label class="rt-share"><span class="rt-tl">share link</span>
          <input class="rt-url" readonly value="${esc(url)}"></label>
        <div class="rt-btns">
          <button class="btn primary" type="button" data-out="link">⧉ Copy share link</button>
          <button class="btn" type="button" data-out="cite">⧉ Copy cite sheet</button>
          ${multi ? "" : '<button class="btn" type="button" data-out="json">⬇ reel.json</button>'}</div></div>
      <p class="hint">The reel lives in this link and this browser — no account,
        no server. Play it back in <a href="${esc(url)}">the viewer</a>.
        ${multi
          ? "<b>This reel spans meetings</b> — it plays and cites here; rendering one video across meetings is a desk step still to come."
          : "<b>Rendering the video needs the desk</b> — the reel.json opens in Highlighter."}</p>`;
    wireTray();
  }
  function wireTray() {
    const tray = $("#reeltray"); if (!tray) return;
    $(".rt-clear", tray).onclick = () => {
      CREEL.clips = []; saveReel(); buildTray(); paintTicks(); toast("reel cleared");
    };
    $$(".rt-clip", tray).forEach(rowEl => {
      const i = +rowEl.dataset.i;
      $$(".rt-b", rowEl).forEach(b => b.onclick = () => clipAct(i, b.dataset.act));
    });
    $$("[data-out]", tray).forEach(b => b.onclick = () => output(b.dataset.out));
    const url = $(".rt-url", tray); if (url) url.onclick = () => url.select();
  }
  function clipAct(i, act) {
    const clips = CREEL.clips, c = clips[i]; if (!c) return;
    // trimming snaps to transcript segment bounds, which are only on the page for
    // THIS meeting; a clip from another meeting nudges by two seconds instead.
    const own = !c.pid || c.pid === CREEL.pid;
    const dur = own ? (CREEL.meta.duration || 1e9) : (c.duration || 1e9);
    if (act === "rm") clips.splice(i, 1);
    else if (act === "up" && i > 0) clips.splice(i - 1, 0, clips.splice(i, 1)[0]);
    else if (act === "down" && i < clips.length - 1) clips.splice(i + 1, 0, clips.splice(i, 1)[0]);
    else if (act[0] === "s") c.start = r1(Math.max(0, Math.min(trimTo(c.start, act[1], dur, own), c.end - MIN_CLIP)));
    else if (act[0] === "e") c.end = r1(Math.min(dur, Math.max(trimTo(c.end, act[1], dur, own), c.start + MIN_CLIP)));
    saveReel(); buildTray(); paintTicks();
  }
  /* trim to segment bounds: step a clip edge to the next/previous transcript
     segment boundary (the seg starts already on the page); with no transcript
     to snap to — no page segs, or a clip from another meeting — nudge two seconds. */
  function trimTo(t, dir, dur, own) {
    const segs = own ? CREEL.segs : null;
    if (segs && segs.length) {
      if (dir === "+") { const nx = segs.find(s => s > t + 0.05);
        return nx == null ? Math.min(dur, t + 2) : nx; }
      const pv = segs.filter(s => s < t - 0.05).pop();
      return pv == null ? Math.max(0, t - 2) : pv;
    }
    return dir === "+" ? Math.min(dur, t + 2) : Math.max(0, t - 2);
  }
  /* the meeting a single-meeting reel belongs to: this page's when its clips are
     from here, else reconstructed from what a clip carries (a reel built on
     another meeting, viewed from this one). */
  function reelMeta(clips) {
    if (clips.every(c => !c.pid || c.pid === CREEL.pid)) return CREEL.meta;
    const c = clips[0] || {};
    return { pid: c.pid || "", title: c.mtitle || "", town: c.town || "",
             body: c.body || "", date: c.date || "", video_id: c.video_id || "",
             url: c.url || "", duration: 0 };
  }
  function output(kind) {
    const clips = CREEL.clips; if (!clips.length) return;
    if (kind === "link") copyText(reelShareURL(clips), "share link copied");
    else if (kind === "cite") {
      // the transcript on the page only knows this meeting's speakers; enrich a
      // clip's speaker only when it is from here (a cross-meeting clip keeps its own)
      const withSpk = clips.map(c => (!c.pid || c.pid === CREEL.pid)
        ? { ...c, speaker: speakerAt(c.start) } : c);
      copyText(citeSheet(reelMeta(clips), withSpk), "cite sheet copied — receipts for every clip");
    } else if (kind === "json") downloadReel(reelMeta(clips), clips);
  }
  /* the speaker at a time, read from the transcript already on the page — the
     same walk copyCite does for a single selection */
  function speakerAt(t) {
    let spk = "";
    for (const r of $$("#transcript .seg")) {
      if (+r.dataset.t > t + 0.05) break;
      const s = r.querySelector(".spk"); if (s) spk = s.textContent || spk;
    }
    return spk;
  }

  /* --- P1b: the /app/r viewer --- */
  let REELPLAY = null;

  async function reel() {
    const stage = $("#reelstage"), cites = $("#reelcites");
    if (!stage) return;
    const gone = "The meeting this reel was cut from isn’t in this pressing of "
      + "the record. It may have been curated away, or pressed under a different id.";
    const st = decodeReel(location.search);
    if (st.v && !REEL_VS.includes(st.v)) return reelMessage(cites,
      "This reel was shared from a newer version of the record. Update, or open "
      + "the meeting it came from to read the moments in place.");
    if (!st.clips.length) return reelMessage(cites,
      `This link doesn’t carry a reel. Open <a href="${BASE}/">the record</a> to `
      + "read a meeting, then tick its moments into a reel.");
    // a reel can span meetings (specs/20 §7.9 P2-B): fetch each one it touches,
    // once, and enrich every clip from ITS OWN meeting's moments plane.
    const pids = reelPids(st.clips);
    const got = await Promise.all(pids.map(async pid =>
      [pid, await getJSON(`${BASE}/meetings/${encodeURIComponent(pid)}.json`)]));
    const mby = {}; for (const [pid, m] of got) if (m) mby[pid] = m;
    const clips = st.clips.map(c => {
      const m = mby[c.pid]; if (!m) return null;   // a clip whose meeting is gone drops out
      const mo = nearestMoment(m.moments || [], c.start);
      return { pid: c.pid, start: c.start, end: c.end,
               t: mo ? r1(mo.t) : c.start, kind: mo ? mo.kind : "moment",
               quote: mo ? mo.quote : "", video_id: m.video_id || "",
               mtitle: m.title || "", body: m.body || "", town: m.town || "",
               date: m.date || "" };
    }).filter(Boolean);
    if (!clips.length) return reelMessage(cites, gone);
    const nmeet = reelPids(clips).length;
    const first = mby[clips[0].pid];
    document.title = (nmeet > 1 ? `A reel across ${nmeet} meetings`
                                : `${first.title || "A reel"} — a reel`)
      + ` · publicrecord.studio`;
    buildViewer(stage, cites, clips, mby, nmeet > 1);
  }
  function nearestMoment(moments, t) {
    // a shared clip's start is the moment's padded window start, so match the
    // whole [start,end] window (not just the anchor) before falling to nearest
    let best = null, bd = 1e9;
    for (const mo of moments) {
      const a = r1(mo.start != null ? mo.start : mo.t), b = r1(mo.end || mo.t);
      const d = (t >= a - 0.5 && t <= b + 0.5) ? 0 : Math.abs(r1(mo.t) - t);
      if (d < bd) { bd = d; best = mo; }
    }
    return best;
  }
  function buildViewer(stage, cites, clips, mby, multi) {
    const first = mby[clips[0].pid] || {};
    // the facade shows the first clip that actually HAS a tape — a leading
    // audio-only meeting must not blank the player for the clips that can play
    const firstPlayable = clips.find(c => c.video_id) || clips[0];
    const v0 = firstPlayable.video_id || "";
    const thumb = (mby[firstPlayable.pid] || {}).thumb || "";
    if (v0) {
      stage.innerHTML =
        `<div class="player facade" data-video="${esc(v0)}">`
        + (thumb ? `<img src="${esc(thumb)}" alt="" class="pfacade-img">` : "")
        + `<button class="playbtn" type="button" aria-label="Play the reel">▶</button>`
        + `<span class="phint">tap to play the reel · ${clips.length} clip${clips.length > 1 ? "s" : ""} · ${hms(reelRuntime(clips))} · nothing plays until you do</span></div>`
        + `<p class="reel-now" id="reelnow" hidden></p>`;
      $(".player.facade", stage).addEventListener("click", () => startReel(clips));
      window.addEventListener("message", onYT, false);
    } else {
      stage.innerHTML = '<div class="player local"><p class="phint">this '
        + 'meeting’s tape lives at the station — the reel below is its citations.'
        + '</p></div>';
    }
    REELPLAY = { clips, i: 0, active: false, armed: false, vid: v0, now: $("#reelnow") };
    const nmeet = reelPids(clips).length;
    const head = `<div class="sectionhead"><span class="kicker">the reel — `
      + `${clips.length} moment${clips.length > 1 ? "s" : ""} `
      + (multi ? `across ${nmeet} meetings`
               : `from <a href="${BASE}/m/${esc(first.pid || clips[0].pid)}">${esc(first.title || "")}</a>`)
      + `, in order · ${hms(reelRuntime(clips))}</span></div>`;
    // each cite deep-links its OWN meeting; a cross-meeting reel names it too
    const rows = clips.map((c, i) => `<a class="reelcite" data-i="${i}" href="${BASE}/m/${esc(c.pid)}#t${Math.floor(c.t != null ? c.t : c.start)}">
        <span class="rc-ord">${i + 1}</span>
        <span class="rc-body">${multi ? `<span class="rc-from">${esc(c.mtitle || c.pid)}</span>` : ""}<span class="rc-quote">${esc(c.quote || "(moment)")}</span>
          <span class="rc-meta"><span class="rt-kind">${esc(c.kind)}</span>
            <span class="ts">${hms(c.start)}</span>–<span class="ts">${hms(c.end)}</span></span>
        </span></a>`).join("");
    // a single-meeting reel keeps its meta (for reel.json + the cite head + the
    // open-meeting link); a cross-meeting one has no single meeting to open.
    const vmeta = multi ? { pid: "", title: "", town: "", body: "", date: "" }
      : { pid: first.pid || clips[0].pid, title: first.title || "",
          town: first.town || "", body: first.body || "", date: first.date || "",
          video_id: v0, url: first.url || "", duration: +first.duration || 0 };
    const where = multi ? "" : [vmeta.body, vmeta.town, vmeta.date].filter(Boolean).join(" · ");
    cites.innerHTML = head + `<div class="reelcitelist">${rows}</div>`
      + (where ? `<p class="rc-where">${esc(where)}</p>` : "")
      + `<div class="rt-btns">
          <button class="btn" type="button" data-rv="cite">⧉ Copy cite sheet</button>
          ${multi ? "" : '<button class="btn" type="button" data-rv="json">⬇ reel.json</button>'}
          ${multi ? "" : `<a class="btn" href="${BASE}/m/${esc(vmeta.pid)}">open the meeting →</a>`}</div>
        <p class="hint">This reel lives in the link you followed — no account, no
          server kept it. ${multi
            ? "<b>This reel spans meetings</b> — it plays and cites here; rendering one video across meetings is a desk step still to come."
            : "<b>Rendering it as a video needs the desk</b> — the reel.json opens in Highlighter."}</p>`;
    $$("[data-rv]", cites).forEach(b => b.onclick = () =>
      b.dataset.rv === "cite" ? copyText(citeSheet(vmeta, clips), "cite sheet copied")
                              : downloadReel(vmeta, clips));
    // clicking a cite while the reel plays jumps to that clip (switching the tape
    // when the clip is from another meeting); a tape-less clip just follows its
    // deep link, and so does any click when the reel isn't playing
    $$(".reelcite", cites).forEach(a => a.addEventListener("click", ev => {
      const i = +a.dataset.i, c = REELPLAY.clips[i];
      if (!REELPLAY.active || !c.video_id) return;
      ev.preventDefault();
      REELPLAY.i = i; REELPLAY.armed = false;
      reelSeek(c); reelShow();
    }));
  }
  function startReel(clips) {
    // begin at the first clip that has a tape — a reel that opens on an
    // audio-only meeting still plays its later, playable clips
    let i = 0; while (i < clips.length && !clips[i].video_id) i++;
    if (i >= clips.length) return;
    REELPLAY.i = i; REELPLAY.active = true; REELPLAY.armed = false;
    REELPLAY.vid = clips[i].video_id;
    const f = $(".player.facade");
    if (f) loadTape(f.dataset.video, clips[i].start); else ytSeek(clips[i].start);
    reelShow();
  }
  /* seek within the current tape, or — when the clip is from another meeting —
     load THAT meeting's tape at the clip start. Never fall back to the tape
     already loaded: a clip must play its own meeting's footage or none. */
  function reelSeek(c) {
    const vid = c.video_id;
    if (!vid) return;                          // a tape-less clip is read, not played
    if (vid === REELPLAY.vid) { ytSeek(c.start); return; }
    // a cross-meeting clip: load its tape. The swapped-out video keeps posting
    // stale times for a beat — they belong to another timeline and could arm or
    // skip the new clip — so settle briefly, then let the armed gate re-arm.
    REELPLAY.vid = vid;
    if (typeof YT !== "undefined" && YT.win && YT.ready) {
      REELPLAY.settling = true;
      if (typeof setTimeout === "function")
        setTimeout(() => { if (REELPLAY) REELPLAY.settling = false; }, 500);
      ytSend("cmd", "loadVideoById", [{ videoId: vid, startSeconds: c.start }]);
    } else {
      REELPLAY.pending = { vid, start: c.start };   // player not up yet → apply on onReady
    }
  }
  /* the seek engine, clip to clip. Clips play in reel order, not chronological,
     so after a clip ends the next start may be *earlier* in the tape — the
     `armed` gate waits for the seek to land near the new clip's start before it
     watches that clip's end, so a stale time report can't skip a clip. While a
     cross-meeting tape switch settles, reports are ignored entirely. */
  function reelAdvance(t) {
    if (!REELPLAY || !REELPLAY.active || REELPLAY.settling) return;
    const c = REELPLAY.clips[REELPLAY.i]; if (!c) return;
    if (!REELPLAY.armed) {
      // arm only on a report that lands inside the clip and BEFORE its end
      // threshold — so a stale time at/after the end (two of which can arrive
      // while a backward seek buffers) can neither arm nor, on the next tick,
      // skip a short clip entirely
      if (t >= c.start - 0.75 && t < c.end - 0.12) REELPLAY.armed = true;
      return;
    }
    if (t >= c.end - 0.12) {
      REELPLAY.armed = false;
      // the next clip that actually has a tape (a cite-only clip is read, not played)
      let n = REELPLAY.i + 1;
      while (n < REELPLAY.clips.length && !REELPLAY.clips[n].video_id) n++;
      if (n < REELPLAY.clips.length) {
        REELPLAY.i = n; reelSeek(REELPLAY.clips[n]); reelShow();
      } else {
        REELPLAY.active = false; ytSend("cmd", "pauseVideo", []); reelShow(true);
      }
    }
  }
  function reelShow(done) {
    if (!REELPLAY) return;
    const now = REELPLAY.now, c = REELPLAY.clips[REELPLAY.i];
    // when the reel spans meetings, name each clip's meeting as it plays
    const from = (c && c.mtitle && reelPids(REELPLAY.clips).length > 1)
      ? ` <span class="rn-from">${esc(c.mtitle)}</span>` : "";
    if (now) {
      now.hidden = false;
      now.innerHTML = (done || !c)
        ? `<b>reel complete</b> — ${REELPLAY.clips.length} clip${REELPLAY.clips.length > 1 ? "s" : ""} played`
        : `<span class="rn-ord">clip ${REELPLAY.i + 1} of ${REELPLAY.clips.length}</span>`
          + `<span class="ts">${hms(c.start)}</span> `
          + `<span class="rn-quote">${esc(c.quote || c.kind || "")}</span>${from}`;
    }
    $$(".reelcite").forEach((a, i) =>
      a.classList.toggle("on", REELPLAY.active && i === REELPLAY.i));
  }
  function reelMessage(el, html) {
    if (el) el.innerHTML = `<p class="hint">${html}</p>`;
    const stage = $("#reelstage"); if (stage) stage.innerHTML = "";
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
    // position lives in the stylesheet (.cz-toast), not inline, so studio mode
    // can re-centre it over the shifted paper — an inline left:50% would beat the
    // rule. Only visibility is toggled here.
    if (!toEl) { toEl = document.createElement("div"); toEl.className = "cz-toast";
      document.body.appendChild(toEl); }
    toEl.textContent = msg; toEl.classList.add("on");
    clearTimeout(toEl._t); toEl._t = setTimeout(() => toEl.classList.remove("on"), 2600);
  }
})();
