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
  /* the desktop app — where a step "needs the desk", the reader hands it
     over (specs/28 §3.5); the twin of web/emit.py DESK_DMG, held equal */
  const DESK_DMG = "https://github.com/amateurmenace/control-z/releases/download/v2.1.0/civicmedia-studio-2.1.0-macos-arm64.dmg";
  const deskBtn = (label = "↓ the desktop app — render it") =>
    `<a class="btn deskdl" href="${DESK_DMG}" rel="noopener" title="Civic Media Studio for macOS (Apple silicon)">${esc(label)}</a>`;
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
    wireStoryTabs();   // the front page's stories, one at a time (specs/24, /25)
    hydrateTopicTicks();   // a topic story's chapters grow their cut ticks — on the front page and on the story's own page (specs/25)
    bsSpine(); bsScore(); bsYear(); bsRiver();   // the broadsheet re-lit: the spine's type-ahead, the score, the year, the river (specs/29)
    if (/\/app\/m\//.test(path)) { meeting(); wireFind(); }
    else if (/\/app\/r$/.test(path)) reel();
    else if (/\/app\/p$/.test(path)) paper();
    else if (/\/app\/s$/.test(path)) search();
    else if (/\/app\/add$/.test(path)) addMeeting();
    else if (/\/app\/i\//.test(path)) issue();
    else if (/\/app\/watching$/.test(path)) stillWatching();
    else if (/\/app\/officials$/.test(path)) officials();
    else if (path === "/app") home();
    registerSW();
    wireSlashFocus();
    wireKeys();   // ? — the keys sheet, on every page (specs/26 §2.5)
  });


  /* ================= FIND IN THIS MEETING (specs/26 §2.2) ==================
     Community Highlighter's search-within-a-video, in the paper: a find box
     over the transcript, minted here (a pressed box that did nothing with
     the script off would be the dishonesty the covenant is against). Whole-
     word, case-blind, over the rows already on the page; the matching rows
     stay, the rest fold away; a sparkline says where on the night the word
     fell; ▶ plays the mentions as a reel; ✂ puts them on the tray. The word
     cloud's words run it. Nothing leaves the browser. */
  let MPF = null;
  function wireFind() {
    const tr = $("#transcript"); if (!tr) return;
    const rows = $$("#transcript .seg"); if (!rows.length) return;
    // the press stamps the find box under the score (specs/29 board 4) —
    // a real form that searches the record without this file; with it the
    // transcript folds in place. An older stub without one gets it minted
    // directly over the lines it folds (specs/27 §2.4).
    let form = $("form.mp-find");
    if (!form) {
      form = document.createElement("form");
      form.className = "mp-find"; form.setAttribute("role", "search");
      form.innerHTML = `<input type="search" name="q" placeholder="find in this meeting — a word or phrase" aria-label="find in this meeting" autocomplete="off">
        <button class="btn" type="submit">find</button>
        <span class="mp-findn" aria-live="polite"></span>
        <div class="mp-found" hidden></div>`;
      tr.before(form);
    }
    const input = $("input", form);
    MPF = { rows, input, form, found: $(".mp-found", form), n: $(".mp-findn", form), q: "" };
    form.addEventListener("submit", e => { e.preventDefault(); mpFind(input.value); });
    let deb;
    input.addEventListener("input", () => {
      clearTimeout(deb);
      const v = input.value.trim();
      if (!v) { mpFind(""); return; }
      if (v.length < 3) return;
      deb = setTimeout(() => mpFind(v), 300);
    });
    input.addEventListener("keydown", e => { if (e.key === "Escape") { input.value = ""; mpFind(""); } });
    // a word of the cloud finds every line that says it (its href — the
    // first mention — stays the answer with the script off)
    const cloud = $(".mp-words svg");
    if (cloud) cloud.addEventListener("click", e => {
      const a = e.target.closest("a"); if (!a) return;
      // the word is the <text>'s own first text node — its <title> child
      // (the tooltip) is not the word (a pane catch)
      const tx = a.querySelector("text");
      const w = tx && tx.firstChild && tx.firstChild.nodeType === 3 ? tx.firstChild.nodeValue : "";
      if (!w.trim()) return;
      e.preventDefault(); input.value = w.trim(); mpFind(w.trim());
      // land on the answer — the count, the sparkline, the lines — not on the cloud
      form.scrollIntoView({ block: "start" });
    });
    // a link into the tape while the transcript is folded: the row it names
    // must show, or the jump lands on nothing
    window.addEventListener("hashchange", () => { if (tr.classList.contains("mp-finding")) mpReveal(); });
  }
  function mpReveal() {
    const m = /^#t(\d+)$/.exec(location.hash); if (!m) return;
    const at = rowAt(+m[1]);
    if (!at) return;
    const row = at.row;
    // reveal, then land: the page's own focusHash ran first, on a row that
    // was still folded away (a review catch)
    row.classList.add("mp-hit");
    row.scrollIntoView({ block: "center" });
  }
  function mpFind(q) {
    if (!MPF) return;
    const tr = $("#transcript"), { rows, found, n } = MPF;
    q = String(q || "").trim();
    MPF.q = q;
    if (!q) {
      tr.classList.remove("mp-finding");
      for (const r of rows) r.classList.remove("mp-hit");
      found.hidden = true; found.innerHTML = ""; n.textContent = "";
      return;
    }
    const pats = [phraseRe(q)];
    const hits = [];
    for (const r of rows) {
      const text = (r.querySelector(".sx") || r).textContent || "";
      const k = mentionsIn(text, "", pats);
      r.classList.toggle("mp-hit", k > 0);
      if (k > 0) hits.push({ t: +r.dataset.t || 0, text, mentions: k, row: r });
    }
    if (!hits.length) {
      // a miss keeps the transcript whole — folding everything away would
      // hide the way back (a review catch)
      tr.classList.remove("mp-finding");
      n.textContent = `nothing in this meeting says “${q}”`;
      found.hidden = true; found.innerHTML = "";
      return;
    }
    tr.classList.add("mp-finding");
    const total = hits.reduce((a, h) => a + h.mentions, 0);
    n.textContent = `${tpN(hits.length, "line")} · ${tpN(total, "mention")}`;
    // where it fell: 48 slices of the tape, each a seek
    const last = rows[rows.length - 1];
    const dur = Math.max(1, (CREEL && CREEL.meta && +CREEL.meta.duration) || 0, (+last.dataset.t || 0) + 5, ...hits.map(h => h.t + 1));
    const bins = new Array(TP_BINS).fill(0);
    for (const h of hits) bins[Math.min(TP_BINS - 1, Math.floor(TP_BINS * h.t / dur))]++;
    const mx = Math.max(1, ...bins);
    const bars = bins.map((c, i) => `<a class="fp-sbar" href="#t${Math.floor(dur * i / TP_BINS)}" title="${hms(dur * i / TP_BINS)}–${hms(dur * (i + 1) / TP_BINS)}: ${tpN(c, "line")}"><i style="height:${c ? 2 + Math.round(20 * c / mx) : 1}px"></i></a>`).join("");
    // the mentions as clips: each line and the twelve seconds after it —
    // the sentence, not the caption line — runs merged, never past the
    // tape: the tray's own rule for a hit, the search page's and the
    // supercut's (a line alone is four seconds; a reel of those is a jolt)
    const pid = ($(".meeting") || {}).dataset ? $(".meeting").dataset.pid : "";
    const clips = tpMerge(hits.map(h => ({ pid, t: h.t })), dur);
    MPF.clips = clips; MPF.hits = hits;
    const linked = clips.slice(0, REEL_LINK_CAP);
    const rt = linked.reduce((a, c) => a + (c.end - c.start), 0);
    found.hidden = false;
    found.innerHTML = `<div class="fp-sparks"><div class="fp-spark"><span class="fp-sterm">where it fell</span><span class="fp-sbars">${bars}</span><span class="fp-sn">${tpN(hits.length, "line")}</span></div></div>
      <div class="sq-acts">
        <a class="btn primary tp-play" href="${esc(reelShareURL(clips))}">▶ play ${linked.length < clips.length ? `the first ${linked.length} of ${tpN(clips.length, "clip")}` : `the ${tpN(clips.length, "clip")}`} as a reel · ${hms(rt)}</a>
        <button type="button" class="btn" data-mp="tray">✂ put them on my tray</button>
        <button type="button" class="btn" data-mp="clear">show the whole transcript</button>
      </div>
      <p class="hint">the lines that say “${esc(q)}” stay below, the rest fold away; every bar above opens the tape there · <a class="mp-jumplines" href="#transcript">the lines themselves ↓</a></p>`;
    $("[data-mp=tray]", found).onclick = () => mpTray();
    $("[data-mp=clear]", found).onclick = () => { MPF.input.value = ""; mpFind(""); MPF.input.focus(); };
    $$(".fp-sbar", found).forEach(a => a.addEventListener("click", ev => {
      ev.preventDefault(); const t = +a.getAttribute("href").slice(2);
      const f = $(".player.facade"); if (f) loadTape(f.dataset.video, t); else ytSeek(t);
    }));
  }
  async function mpTray() {
    if (!MPF || !MPF.clips || !MPF.clips.length) return;
    const pid = ($(".meeting") || {}).dataset ? $(".meeting").dataset.pid : "";
    // the meeting's own facts (the tape, its length, the day) — from the
    // composer once the plane has landed, else the same cached fetch, so a
    // press before it lands never stores a tapeless clip (a review catch)
    let meta = CREEL ? CREEL.meta : null;
    if (!meta) {
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(pid)}.json`) || {};
      meta = { video_id: m.video_id || "", title: m.title || "", body: m.body || "",
               town: m.town || "", date: m.date || "", duration: +m.duration || 0 };
    }
    const clips = MPF.clips.map(c => {
      const h = MPF.hits.find(h => h.t === c.start) || {};
      return { pid, start: r1(c.start), end: r1(c.end), t: r1(c.start), kind: "segment",
        quote: cut(String(h.text || "").trim(), 120), video_id: meta.video_id || "", mtitle: meta.title || "",
        body: meta.body || "", town: meta.town || "", date: meta.date || "", duration: +meta.duration || 0 };
    });
    const have = trayClips();
    const next = takeMerge("append", have, clips, true);
    const added = next.length - have.length;
    writeTray(next);
    toast(added ? `${tpN(added, "clip")} on your tray — ${next.length} in all` : "every one of these was on your tray already");
  }

  /* ================= THE KEYS — ? (specs/26 §2.5) ==========================
     One sheet, on every page, that says what the keyboard does here — the
     Highlighter's shortcuts overlay, in the paper. Script-built, opened by
     ?, closed by Esc or its button; a <dialog>, so focus and the backdrop
     are the browser's. It lists only keys this page answers. */
  function keysFor() {
    const p = path;   // the page's path as the router reads it (/app/s/ is the search page too)
    const rows = [["/", "search the record" + ($(".mp-find") ? " — here, find in this meeting" : "")], ["?", "this sheet"], ["Esc", "close it"]];
    if (/\/app\/s$/.test(p)) rows.push(["j · k", "walk the hits"], ["Enter", "open the tape at the hit"], ["c", "cut the hit under the cursor into your reel"]);
    if (/\/app\/m\//.test(p) && $("#transcript .seg")) rows.push(["c", "cut the transcript line under the cursor (Tab to its time, then c)"]);
    if ($(".mp-find")) rows.push(["Esc", "in the find box, show the whole transcript"]);
    if (/\/app\/r$/.test(p)) rows.push(["Space", "play or pause the reel"], ["← · →", "the previous or next clip"]);
    if ($("#bs-stamp")) rows.push(["← · →", "READ or EDIT, on the stamp"]);
    if ($("#bs-spine")) rows.push(["↑ · ↓", "walk the search’s suggestions"], ["Tab", "the next group of suggestions"], ["Enter", "open the suggestion"]);
    return rows;
  }
  function wireKeys() {
    if (typeof HTMLDialogElement === "undefined") return;   // no <dialog>: the keys still work, the sheet does not
    document.addEventListener("keydown", e => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target.isContentEditable)) return;
      e.preventDefault();
      let d = $(".kb-sheet");
      if (d && d.open) { d.close(); return; }   // ? again closes it (a review catch)
      if (!d) {
        d = document.createElement("dialog"); d.className = "kb-sheet";
        d.setAttribute("aria-label", "the keys");
        // a press on the backdrop closes it — the backdrop, not the sheet's own padding
        d.addEventListener("click", ev => {
          const r = d.getBoundingClientRect();
          if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) d.close();
        });
        document.body.appendChild(d);
      }
      d.innerHTML = `<span class="kicker">the keys — what the keyboard does on this page</span>
        <dl class="kb-list">${keysFor().map(([k, what]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(what)}</dd>`).join("")}</dl>
        <p class="hint">Every key is a shortcut for something a pointer can do; nothing here needs it.</p>
        <button type="button" class="btn kb-close">close</button>`;
      $(".kb-close", d).onclick = () => d.close();
      d.showModal();
    });
  }

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
  /* the mode THIS page is showing: the html class markMode painted (the one
     writer), falling back to storage. In a storage-blocked browser
     readMode() answers "preview" while the page visibly sits in the studio —
     the control's checked state and its arrows must speak about what the
     reader sees, not what a refused write left behind (a review catch). */
  const shownMode = () => MODES.find(m =>
    document.documentElement.classList.contains("cz-m-" + m)) || readMode();
  // the rail's painted truth, for the same reason — and doubly so: deriving
  // the NEXT rail state from storage in a blocked browser would pin the
  // toggle (collapse once, never expand), which is worse than dead
  const shownRail = () => document.documentElement.classList.contains("cz-rail");

  /* the mode control is a real radiogroup (P3): one choice of three, arrow
     keys move it, and only the checked radio sits in the tab order (roving
     tabindex) — so the whole control costs a keyboard one stop, not three.
     The buttons stay <button>s: Enter/Space keep their native press. */
  const modeBtn = (m, label, title) =>
    `<button type="button" class="cz-mode" data-mode="${m}" role="radio" title="${esc(title)}" aria-checked="false" tabindex="-1">${esc(label)}</button>`;
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
    const modes = `<div class="cz-modes" role="radiogroup" aria-label="how much studio to show">`
      + modeBtn("preview", "preview", "a compact preview")
      + modeBtn("studio", "studio", "the full editor")
      + modeBtn("paper", "paper", "just the paper — the quiet reader")
      + `</div>`;
    return `<button type="button" class="cz-tab" title="open the studio">◐ studio</button>
      <div class="cz-pill">
        <button type="button" class="cz-enter" title="open your paper in the studio">✎ Your paper — edit</button>
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
          <section class="cz-block cz-stagebox" id="cz-stagebox" hidden>
            <span class="cz-tag">preview</span>
            <div class="cz-stage" id="cz-stage"></div>
            <p class="cz-stagenow" id="cz-stagenow" role="status"></p>
            <div class="cz-stageacts">
              <button type="button" class="btn" data-cz="pvstop">■ stop</button>
              <a class="btn cz-stageopen" href="${BASE}/" target="_blank" rel="noopener">open the tape ↗</a>
            </div>
          </section>
          <section class="cz-block">
            <span class="cz-tag">your paper</span>
            <div class="cz-paperbody"></div>
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
    paintModeBar();   // the mode bar says which mode the page is in (specs/24)
    refreshReelSummary();
    refreshPaperSummary();   // paints the card affordances too (A2)
    // another tab that ticks a moment (or edits the paper, or clears either)
    // writes a shared key; reflect it here without a reload. When THIS page is
    // also composing, the tray and ticks must move together with the summary,
    // or the two disagree. A clear() fires with key === null and touches both.
    window.addEventListener("storage", e => {
      const k = e && e.key;
      if (k === REEL_KEY || k === null) {
        if (CREEL) { CREEL.clips = readReel(REEL_KEY); buildTray(); paintTicks(); }
        paintCutTicks();         // the cut ticks on THIS page track the other tab
        refreshReelSummary();
        refreshPaperSummary();   // the reel add-button's count rides the tray
      }
      if (k === PAPERS_KEY || k === PAPER_KEY || k === null) {
        retireShortOut();        // another tab changed the paper — the minted
                                 // link names the old one and must not repaint
        refreshPaperSummary();
        schedulePaperRender();   // /app/p reading its own draft repaints too
      }
    });
  }

  function wireStudio() {
    if (!STUDIO) return;
    $$(".cz-mode", STUDIO).forEach(b => b.onclick = () => setMode(b.dataset.mode));
    // the radiogroup contract: arrows move the choice (selection follows
    // focus, the radio idiom), Home/End jump to the poles. Picking a
    // non-studio mode hides this group — setMode's focus handling already
    // lands the keyboard on the control the new mode shows.
    const grp = $(".cz-modes", STUDIO);
    if (grp) grp.addEventListener("keydown", e => {
      // modified chords belong to the browser and to AT (Alt+Left is back) —
      // only the plain keys are the radiogroup's to take
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      const to = step
        ? MODES[(MODES.indexOf(shownMode()) + step + MODES.length) % MODES.length]
        : e.key === "Home" ? MODES[0]
        : e.key === "End" ? MODES[MODES.length - 1] : "";
      if (!to) return;
      e.preventDefault();
      setMode(to);
    });
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
      // the panel tray (specs/22 P0) — every per-clip act is a call into the
      // page-agnostic trayAct; nothing here touches a server. Its outputs
      // (specs/22 P1) are the meeting tray's, offered wherever the panel
      // stands: the cite sheet, and reel.json for a single-meeting reel.
      else if (act === "rtact") trayAct(+b.dataset.i, b.dataset.act);
      else if (act === "pvplay") pvPlay(readReel(REEL_KEY)[+b.dataset.i]);
      else if (act === "pquote") { const c = readReel(REEL_KEY)[+b.dataset.i];
        if (c) addQuoteRef(c.pid, c.t != null ? c.t : c.start, null, c.quote || ""); }
      else if (act === "pvstop") pvPause();
      else if (act === "reelcite") { const c = readReel(REEL_KEY);
        if (c.length) copyText(citeSheet(trayMeta(c), c), "cite sheet copied — receipts for every clip"); }
      else if (act === "reeljson") { const c = readReel(REEL_KEY);
        if (c.length && reelPids(c).length <= 1) downloadReel(trayMeta(c), c); }
      // your paper (P1) — every handler here is a call into the paper section;
      // painting and arranging stay pure localStorage, and the one server
      // touch a paper can have (the optional short link) happens only inside
      // paperShortLink, behind this explicit press and nowhere else.
      else if (act === "padd") addPageToPaper();
      else if (act === "preel") addReelToPaper();
      else if (act === "pnote") addNoteToPaper();
      else if (act === "pchart") addChartToPaper(b.dataset.chart, b.dataset.ref || "");
      else if (act === "pread") addReadingToPaper(b.dataset.ref || "");
      else if (act === "ptpl") applyPaperTemplate(b.dataset.tpl);
      else if (act === "pup" || act === "pdown" || act === "pdel")
        movePaperBlock(+b.dataset.i, act);
      else if (act === "plink") copyText(paperShareURL(readPaper()),
        "paper link copied — it carries the whole paper");
      else if (act === "pjson") downloadPaper(readPaper());
      else if (act === "pshort") paperShortLink();
      else if (act === "pclear") clearPaper();
      else if (act === "pnew") newPaper();
      else if (act === "pdelete") deletePaper();
    });
  }

  /* ---- the stamp (specs/29, after the mode bar of specs/24) — says
     plainly whether you are reading or editing. The press stamps READ · the
     record into every top bar; this turns it into a two-word radiogroup
     (READ in ink, EDIT in rust) painted from shownMode() — the painted
     truth, never storage — and says what EDIT means. Paper mode keeps the
     pressed stamp as it is. */
  let BS_STAMP_ORIGIN = false;   // the change came from the stamp: the keyboard stays there
  function paintModeBar() {
    const st = $("#bs-stamp"); if (!st) return;
    const m = shownMode(), edit = m === "studio";
    if (m === "paper") {
      // paper is just the record: the pressed stamp, untouched (un-wired if it was)
      if (st.dataset.wired) {
        st.innerHTML = st.dataset.pressed || "";
        delete st.dataset.wired; st.removeAttribute("role"); st.removeAttribute("aria-label");
      }
      st.dataset.mode = "read";
      return;
    }
    if (!st.dataset.wired) {
      st.dataset.pressed = st.dataset.pressed || st.innerHTML;
      st.dataset.wired = "1";
      st.setAttribute("role", "radiogroup"); st.setAttribute("aria-label", "reading or editing");
      st.innerHTML = `<button type="button" role="radio" data-czmode="preview" aria-checked="false" tabindex="-1">READ</button>`
        + `<span aria-hidden="true">·</span>`
        + `<button type="button" role="radio" data-czmode="studio" aria-checked="false" tabindex="-1">EDIT</button>`
        + `<span class="bs-stamp-say"></span>`;
    }
    // the listeners once, whatever paper mode does to the buttons (a skeptic's
    // catch: a paper round trip re-registered them and setMode ran N+1 times)
    if (!st.dataset.listen) {
      st.dataset.listen = "1";
      st.addEventListener("click", e => {
        const b = e.target.closest && e.target.closest("[data-czmode]");
        if (b && st.contains(b)) { BS_STAMP_ORIGIN = true; setMode(b.dataset.czmode); }
      });
      // arrow keys move the choice, as on the footprint control
      st.addEventListener("keydown", e => {
        const b = e.target.closest && e.target.closest("[data-czmode]"); if (!b) return;
        if (["ArrowLeft", "ArrowUp"].includes(e.key)) { e.preventDefault(); BS_STAMP_ORIGIN = true; setMode("preview"); }
        else if (["ArrowRight", "ArrowDown"].includes(e.key)) { e.preventDefault(); BS_STAMP_ORIGIN = true; setMode("studio"); }
      });
    }
    st.dataset.mode = edit ? "edit" : "read";
    const had = st.contains(document.activeElement);
    $$("[data-czmode]", st).forEach(b => {
      const on = (b.dataset.czmode === "studio") === edit;
      b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
    });
    const say = $(".bs-stamp-say", st);
    if (say) say.textContent = edit ? "your front page · nothing here changes the record" : "the record";
    if (had) { const on = $('[aria-checked="true"]', st); if (on) on.focus(); }
  }
  /* ---- the front page's two stories (specs/24) — one shows at a time.
     The page presses both; this turns the two tab links into a toggle,
     remembers the choice in this browser (and nowhere else), and says which
     story is showing (aria-current on the tab, hidden on the other story).
     With the script off both stories stand and the tabs are anchors. */
  const STORY_KEY = "cz-front-story";
  function wireStoryTabs() {
    const nav = $(".stab"); if (!nav) return;
    const tabs = $$(".stab-a", nav);
    // every story the strip names (specs/25 adds a topic story, first):
    // the strip is the truth, so a tab without its story is simply not a tab
    const stories = Object.create(null);   // no prototype: "#constructor" is not a story (a review catch)
    for (const t of tabs) { const k = t.dataset.story, el = k && $("#" + CSS.escape(k)); if (el) stories[k] = el; }
    const keys = Object.keys(stories);
    if (keys.length < 2) return;
    document.documentElement.classList.add("js");
    let want = keys[0];
    try { const s = localStorage.getItem(STORY_KEY); if (s && stories[s]) want = s; } catch { /* private mode */ }
    const h = location.hash.slice(1);
    if (h && stories[h]) want = h;
    // the toggle hides by its own class, on the story's make-wrapper when
    // the studio has wrapped it — never by `hidden`, which the town scope
    // paints on every card with a data-town and would show the latest
    // meeting's story again the moment the scope repainted (a live catch
    // at v2.1.16: both stories stood, stacked)
    const box = el => (el.parentElement && el.parentElement.classList.contains("cz-mkwrap"))
      ? el.parentElement : el;
    const show = (which, focus) => {
      for (const k of Object.keys(stories)) box(stories[k]).classList.toggle("fp-off", k !== which);
      tabs.forEach(t => t.setAttribute("aria-current", t.dataset.story === which ? "true" : "false"));
      try { localStorage.setItem(STORY_KEY, which); } catch { /* private mode */ }
      if (focus) { const h = $("h2", stories[which]); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); } }
    };
    show(want, false);
    nav.addEventListener("click", e => {
      const a = e.target.closest && e.target.closest(".stab-a");
      if (!a || !nav.contains(a) || !stories[a.dataset.story]) return;
      e.preventDefault(); show(a.dataset.story, true);
      if (history.replaceState) history.replaceState(null, "", "#" + a.dataset.story);
    });
  }
  function setMode(m) {
    const fromStamp = BS_STAMP_ORIGIN; BS_STAMP_ORIGIN = false;   // consumed first: a throw below cannot leave it stuck
    if (!MODES.includes(m)) m = "preview";
    if (m !== "studio") ED_RAILED = false;   // the editor page rails the sidebar again on the next EDIT (specs/29 board 8)
    if (m !== "studio") pvPause();   // a hidden stage must not keep playing
    writeMode(m); markMode(m); updateModeButtons(); paintModeBar();
    // the make-affordances on the record's cards follow the mode (never in
    // paper), and /app/p reading its own draft becomes — or stops being —
    // the editor (specs/23 A2/A3)
    paintMakeAffordances();
    // entering the studio can wait for the debounce; LEAVING it repaints at
    // once, or the editor's chrome stands on the page unstyled (its rules
    // live under html.cz-m-studio) until the timer fires (a review catch)
    if (m === "studio") schedulePaperRender(); else renderPaperNow();
    // keyboard focus must not fall to <body> when the control the reader was on
    // is display:none'd by the switch — land it on a control the new mode shows.
    // A change made on the stamp keeps the keyboard on the stamp (paintModeBar).
    if (!fromStamp) focusModeControl(m);
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
    // painted truth on both axes (the re-review's catch: the fold converted
    // two of the three studio-state readers and left this one lying) — the
    // stored preference is still written for the next load, when it can be
    const v = !shownRail(); writeRail(v);
    if (v) pvPause();   // the collapsed rail hides the stage — stop its tape
    document.documentElement.classList.toggle("cz-rail", shownMode() === "studio" && v);
    updateModeButtons();
  }
  function updateModeButtons() {
    const m = shownMode();
    // aria-checked + roving tabindex: the checked radio is the group's one
    // tab stop; the rest are arrow-reachable (updateModeButtons runs before
    // setMode hands focus over, so the stop exists by the time focus moves)
    $$(".cz-mode", STUDIO || document).forEach(b => {
      const on = b.dataset.mode === m;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    // the collapse handle's glyph AND its label track the stored state, so a
    // page that loads with the sidebar already collapsed reads "expand", not the
    // stale "collapse" baked into the markup
    const b = $(".cz-rail-btn", STUDIO);
    if (b) { const railed = shownRail(); b.textContent = railed ? "›" : "‹";
      b.title = railed ? "expand the studio" : "collapse the studio";
      b.setAttribute("aria-label", b.title); }
  }

  /* The one make-loop that exists, surfaced (not rebuilt): the global reel the
     composer fills as you tick moments across meetings. The studio reads the
     same `cz-reel` key the meeting page writes, and shows it as a count on the
     preview pill and a panel in studio — a play link, a share link, a clear. */
  /* the panel's reel block is the REAL tray now (specs/22 P0, §5.2): the
     clip list with per-clip trim / reorder / remove and a ▶ preview that
     opens the tape in a new tab (the settled §6.1 answer — the /app/r
     player-singleton is not touched). Page-agnostic: every act dispatches
     to trayAct against the stored reel; the meeting page's own tray
     repaints from the same write. Repaints preserve keyboard focus the
     paper panel's way. */
  function refreshReelSummary(focus) {
    if (!STUDIO) return;
    const clips = readReel(REEL_KEY);
    const n = clips.length;
    const body = $(".cz-reelbody", STUDIO), mini = $(".cz-pill-reel", STUDIO);
    if (!body) return;
    if (!n) {
      // the keyboard was on the last clip's control? land on the block's
      // own head (never <body>) — the emptied tray's one certain element
      const had = body.contains(document.activeElement)
        || (focus && focus.act);
      body.innerHTML = `<p class="cz-hint">No clips yet. Tick a moment or any
        transcript line on a meeting page, a search hit, or an issue’s bead —
        they gather here as a reel, across meetings if you like.</p>`;
      if (mini) { mini.hidden = true; mini.removeAttribute("href"); mini.textContent = ""; }
      if (had) { const tag = body.previousElementSibling; if (tag) { tag.tabIndex = -1; tag.focus(); } }
      return;
    }
    // the storage-event path repaints with no focus arg — if the keyboard
    // was on one of OUR controls, capture it before the innerHTML wipe
    if (!focus) {
      const ae = document.activeElement;
      if (ae && ae.dataset && ae.dataset.cz === "rtact")
        focus = { act: ae.dataset.act, i: +ae.dataset.i };
      else if (ae && ae.dataset && ae.dataset.cz === "pvplay")
        focus = { act: "pvplay", i: +ae.dataset.i };
    }
    const url = reelShareURL(clips), meets = reelPids(clips).length;
    const span = meets > 1 ? ` · ${meets} meetings` : "";
    const act = (a, i, label, glyph, dis) =>
      `<button type="button" class="cz-pact" data-cz="rtact" data-act="${a}"
        data-i="${i}" title="${esc(label)}" aria-label="${esc(label)}"${dis ? " disabled" : ""}>${glyph}</button>`;
    const rows = clips.map((c, i) => {
      const from = c.mtitle || c.pid || "";
      const label = (c.quote || "").trim() || `(${c.kind || "moment"})`;
      return `<div class="cz-rclip" data-i="${i}">
        <span class="cz-rord"${n > 1 ? ` data-grip title="drag to move this clip — or use ↑ ↓"` : ""}>${n > 1 ? '<span class="dg-grip" aria-hidden="true">⠿</span>' : ""}${i + 1}</span>
        <span class="cz-rmain">
          <span class="cz-rquote" tabindex="-1" title="${esc(label)}">${esc(label)}</span>
          <span class="cz-rmeta"><button type="button" class="cz-rquotebtn" data-cz="pquote" data-i="${i}"
              title="quote this clip’s line in your paper" aria-label="quote clip ${i + 1}’s line in your paper">❝ quote</button>
            ${esc(c.kind || "moment")}${meets > 1 && from ? ` · ${esc(from)}` : ""}
            · <span class="ts">${hms(c.start)}</span>–<span class="ts">${hms(c.end)}</span> · ${hms(clipLen(c))}</span>
          <span class="cz-rtrim" role="group" aria-label="trim clip ${i + 1} — the edges snap to the record’s own lines">
            <span class="cz-rtl">in</span>${act("s-", i, `clip ${i + 1}: start earlier`, "◀")}${act("s+", i, `clip ${i + 1}: start later`, "▶")}
            <span class="cz-rtl">out</span>${act("e-", i, `clip ${i + 1}: end earlier`, "◀")}${act("e+", i, `clip ${i + 1}: end later`, "▶")}
          </span>
        </span>
        <span class="cz-racts">
          <button type="button" class="cz-pact cz-rplay" data-cz="pvplay" data-i="${i}"
            data-pvkey="${esc(clipKey(c))}"${c.video_id ? "" : " disabled"}
            title="${c.video_id ? "preview here — the tape, in the studio" : "this meeting has no tape to preview"}"
            aria-label="${c.video_id ? `preview clip ${i + 1} here, in the studio` : `clip ${i + 1} has no tape to preview`}">▶</button>
          <a class="cz-pact cz-rprev" href="${BASE}/m/${esc(c.pid || "")}#t${Math.floor(c.start)}"
            target="_blank" rel="noopener"
            title="open the tape in a new tab"
            aria-label="open clip ${i + 1}’s tape in a new tab">↗</a>
          ${act("up", i, `move clip ${i + 1} up`, "↑", !i)}
          ${act("down", i, `move clip ${i + 1} down`, "↓", i === n - 1)}
          ${act("rm", i, `remove clip ${i + 1}`, "✕")}
        </span></div>`;
    }).join("");
    // the list keeps its scroll across a repaint — a move or a drop deep in a
    // long reel must not throw the panel back to its first clip
    const keepScroll = ($(".cz-rclips", body) || {}).scrollTop || 0;
    body.innerHTML =
        `<p class="cz-reeln"><b>${n}</b> clip${n > 1 ? "s" : ""} · ${hms(reelRuntime(clips))}${span}${n > REEL_LINK_CAP ? ` · a link plays the first ${REEL_LINK_CAP}` : ""}</p>`
      + `<div class="cz-rclips">${rows}</div>`
      + `<div class="cz-reelacts">`
      +   `<a class="btn primary" href="${esc(url)}">▶ play the reel</a>`
      +   `<button type="button" class="btn" data-cz="reelcopy">⧉ share link</button>`
      +   `<button type="button" class="btn" data-cz="preel">📰 file into your paper</button>`
      +   `<button type="button" class="btn" data-cz="reelcite">⧉ cite sheet</button>`
      +   (meets > 1 ? "" : `<button type="button" class="btn" data-cz="reeljson">⬇ reel.json</button>`)
      +   (meets > 1 ? "" : deskBtn("↓ the desktop app"))
      +   `<button type="button" class="btn" data-cz="reelclear">clear</button></div>`
      + `<p class="cz-hint">The reel lives in this browser and its link — no
         account, no server. Trims snap to the record’s own lines; filing it
         into your paper keeps a snapshot, and the tray keeps rolling.</p>`;
    const rl = $(".cz-rclips", body); if (rl && keepScroll) rl.scrollTop = keepScroll;
    wireDrag(rl, ".cz-rclip", (from, to, key) => trayMove(from, to, undefined, key));
    if (mini) { mini.hidden = false; mini.href = url;
      // the pill's link plays the first REEL_LINK_CAP: it says so, and times those
      mini.textContent = `▶ ${n > REEL_LINK_CAP ? `the first ${REEL_LINK_CAP} of ${n} clips` : `${n} clip${n > 1 ? "s" : ""}`}`
        + ` · ${hms(reelRuntime(clips.slice(0, REEL_LINK_CAP)))}`; }
    pvShow();   // the row being previewed keeps its mark across the repaint
    if (focus) {
      let t = focus.act === "row"
        ? $(`.cz-rclip[data-i="${focus.i}"] .cz-rquote`, body)
        : focus.act === "pvplay"
        ? $(`[data-cz="pvplay"][data-i="${focus.i}"]`, body)
        : $(`[data-cz="rtact"][data-act="${focus.act}"][data-i="${focus.i}"]`, body);
      // a move that landed on a pole: the arrow under the keyboard went
      // disabled — hand focus to the opposite arrow, NEVER the ✕ (the
      // paper panel's rule: a held key must not find delete armed)
      if (t && t.disabled) {
        // a ▶ gone disabled (its clip's meeting has no tape) hands focus to
        // its row's ↗ — never an arrow; an arrow at a pole, to the other
        t = focus.act === "pvplay"
          ? $(`.cz-rclip[data-i="${focus.i}"] .cz-rprev`, body)
          : $(`[data-cz="rtact"][data-act="${focus.act === "up" ? "down" : "up"}"][data-i="${focus.i}"]`, body);
      }
      if (!t || t.disabled) t = $(".cz-reelacts .btn", body);
      if (t) t.focus(focus.quiet ? { preventScroll: true } : undefined);
    }
  }
  function clearReel() {
    writeTray([]);   // one write, every surface repaints — ticks included
    toast("reel cleared");
  }

  /* Your paper, in the panel (specs/21 P1): the making surface. Title it, add
     the page you are reading as a story, add your reel, arrange the blocks,
     share the result. Painting is pure localStorage — the paper's model and
     codec live in their own section below, and the single server touch a
     paper can ever have (the optional short link, §6.2) is behind its button
     there, never on this paint path. */
  const chartRowLabel = b =>
      b.chart === "votes" ? "▤ votes over time"
    : b.chart === "topics" ? "▤ recurring topics"
    : b.chart === "reach" ? `▤ reach — ${b.name || b.slug}`
    : b.pid ? `▤ framing — ${b.title || b.pid}`
    : "▤ framing — the whole record";
  /* one name per block, shared by the panel's rows and the page editor's
     bars (A3) so the two surfaces never call a block two things */
  const n_blocks = n => `${n} block${n === 1 ? "" : "s"}`;
  const blockLabel = b => b.kind === "reel"
      ? `▶ a reel — ${b.clips.length} clip${b.clips.length > 1 ? "s" : ""} · ${hms(reelRuntime(b.clips))}`
    : b.kind === "note"
      ? `✎ a note${b.text.trim() ? " — " + b.text.trim().slice(0, 40) : ""}`
    : b.kind === "chart" ? chartRowLabel(b)
    : b.kind === "lead" ? `★ lead story — ${b.title || b.pid}`
    : b.kind === "week" ? `▦ this week${b.town ? " · " + b.town : ""}`
    : b.kind === "threads" ? `⟁ threads${b.town ? " · " + b.town : ""}`
    : b.kind === "strip" ? `▤ how they talked${b.town ? " · " + b.town : ""}`
    : b.kind === "names" ? `◎ ${b.who ? (b.name || b.who) : "who and where" + (b.town ? " · " + b.town : "")}`
    : b.kind === "search" ? "⌕ search box"
    : b.kind === "quote" ? `❝ ${(b.text || "").trim().slice(0, 40) || `a line at ${hms(b.t)}`}`
    : b.kind === "doc" ? `📄 ${b.dkind ? b.dkind + " — " : ""}${b.title || b.doc}`
    : b.kind === "digest" ? `⟳ what changed — ${b.name || b.slug} (${b.n})`
    : b.story === "issue" ? `◈ ${b.name || b.slug}`
    : `§ ${b.title || b.pid}`;
  const blockLabelL = b => blockLabel(b) + (b.layout ? ` · ${LAYOUT_LABEL[b.layout]}` : "");
  function refreshPaperSummary(focus) {
    if (!STUDIO) return;
    // every paper change repaints the ✓ on the record's cards (A2) — the
    // panel is the one hub every add, remove, arrange and clear passes through
    paintMakeAffordances();
    const el = $(".cz-paperbody", STUDIO); if (!el) return;
    const p = readPaper();
    const n = p.blocks.length;
    // the storage-event and composer paths repaint with no focus arg — if
    // the caret is in OUR title input or a note, capture it NOW, before the
    // innerHTML wipe below (after the wipe activeElement is <body> and this
    // branch can never fire — a review catch; the P1 title read shipped
    // dead the same way)
    if (!focus) {
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains("cz-ptitle"))
        focus = { act: "title", caret: ae.selectionStart };
      else if (ae && ae.classList && ae.classList.contains("cz-pnote"))
        focus = { act: "note", i: +ae.dataset.i, caret: ae.selectionStart };
    }
    const rows = p.blocks.map((b, i) => {
      const label = blockLabelL(b);
      return `<div class="cz-prow" data-i="${i}">
        <span class="cz-plabel" tabindex="-1" title="${esc(label)}">${esc(label)}</span>
        <span class="cz-pacts">
          <button type="button" class="cz-pact" data-cz="pup" data-i="${i}"
            title="move up" aria-label="move block ${i + 1} up"${i ? "" : " disabled"}>↑</button>
          <button type="button" class="cz-pact" data-cz="pdown" data-i="${i}"
            title="move down" aria-label="move block ${i + 1} down"${i < n - 1 ? "" : " disabled"}>↓</button>
          <button type="button" class="cz-pact" data-cz="pdel" data-i="${i}"
            title="remove from your paper" aria-label="remove block ${i + 1}">✕</button>
        </span></div>`
        // the note's words live in their own field under the row — typing
        // saves on every keystroke and repaints nothing (the title's rule)
        + (b.kind === "note"
          ? `<textarea class="cz-pnote" data-i="${i}" rows="3"
               maxlength="${PAPER_NOTE_MAX}"
               placeholder="your own words — why this matters"
               aria-label="note ${i + 1} — your own words">${esc(b.text)}</textarea>`
          : "");
    }).join("");
    const ref = pageStoryRef();
    const clips = readReel(REEL_KEY);
    /* the chart menu offers what THIS page can chart plus the record-wide
       three; it opens on demand so the panel stays quiet. */
    const chartBtn = (chart, refv, label) =>
      `<button type="button" class="btn" data-cz="pchart" data-chart="${chart}"
        ${refv ? `data-ref="${esc(refv)}"` : ""}>${esc(label)}</button>`;
    const chartMenu = `<details class="cz-chartadd">
        <summary>＋ a chart</summary>
        <div class="cz-chartmenu">
          ${ref && ref.story === "meeting"
            ? chartBtn("numbers", "m:" + ref.pid, "this meeting in numbers")
              + chartBtn("shape", ref.pid, "the shape of this meeting")
              + chartBtn("votes", ref.pid, "this meeting’s roll calls")
              + chartBtn("framing", ref.pid, "this meeting’s framing") : ""}
          ${ref && ref.story === "issue"
            ? chartBtn("numbers", "i:" + ref.slug, "this issue in numbers")
              + chartBtn("ledger", ref.slug, "every roll call along its way")
              + chartBtn("reach", ref.slug, "this issue’s reach") : ""}
          ${chartBtn("votes", "", "votes over time")}
          ${chartBtn("framing", "", "the record’s framing")}
          ${chartBtn("topics", "", "recurring topics")}
        </div></details>`;
    const adds =
        (ref ? `<button type="button" class="btn" data-cz="padd">＋ ${ref.story === "issue" ? "this issue" : "this meeting"}</button>` : "")
      + (clips.length ? `<button type="button" class="btn" data-cz="preel">＋ your reel (${clips.length} clip${clips.length > 1 ? "s" : ""})</button>` : "")
      + (ref ? `<button type="button" class="btn" data-cz="pread" data-ref="${esc(ref.story === "meeting" ? "m:" + ref.pid : "i:" + ref.slug)}">＋ the record’s reading</button>` : "")
      + `<button type="button" class="btn" data-cz="pnote">＋ a note</button>`
      + chartMenu;
    // an empty note is arranging surface, not traveling content — the share
    // row arms only when the PORTABLE paper is non-empty (a review catch:
    // an empty-note-only draft offered links that decode to "damaged")
    const live = paperHasLive(p);
    const share = live ? `<div class="cz-pshare">
        <a class="btn primary" href="${BASE}/p">📰 open your paper</a>
        <button type="button" class="btn" data-cz="plink">⧉ copy link</button>
        <button type="button" class="btn" data-cz="pjson">⬇ paper.json</button>
        ${API ? `<button type="button" class="btn" data-cz="pshort">⚡ short link</button>` : ""}
        <button type="button" class="btn" data-cz="pclear">clear</button>
      </div>` : "";
    // the last short link minted for THIS paper, shown as a real link — a
    // clipboard is a privilege some browsers withhold, a link on screen is not
    const shortOut = PAPER_SHORT && live
      ? `<p class="cz-pshort-out">short link:
           <a href="${esc(PAPER_SHORT)}">${esc(PAPER_SHORT.replace(location.origin, ""))}</a></p>`
      : "";
    /* templates (P3): pre-shaped papers, offered only while the WHOLE draft
       is empty (no title, no blocks) — a starting shape, never a thing that
       could sit beside real work. The apply re-checks emptiness at the
       click and confirms before replacing anything (another tab may have
       typed meanwhile). Client-side only: a template just writes the draft. */
    const tplBtn = (t, label) =>
      `<button type="button" class="btn" data-cz="ptpl" data-tpl="${t}">${esc(label)}</button>`;
    const tpls = (n || p.title) ? "" :
        `<div class="cz-tpls"><span class="cz-tplhead">or start from a template</span>`
      + (ref && ref.story === "issue" ? tplBtn("issue", "this issue, over time") : "")
      + (ref && ref.story === "meeting" ? tplBtn("meeting", "this meeting, covered") : "")
      + tplBtn("rolls", "the roll calls, watched")
      + `<a class="btn" href="${BASE}/p#edit">all eight templates →</a>`
      + `</div>`;
    /* the shelf (C1): which paper is open, a new one, and delete — the
       select appears once there is a choice; "＋ new" always */
    const sh = readPapers();
    const shelf = `<div class="cz-shelf">`
      + (sh.papers.length > 1
        ? `<label class="cz-shelflabel">open
             <select class="cz-shelfsel" data-cz="pshelf" aria-label="which of your papers is open">
             ${sh.papers.map(x => `<option value="${esc(x.id)}"${x.id === sh.active ? " selected" : ""}>${esc(x.title || "untitled")} · ${n_blocks(x.blocks.length)}</option>`).join("")}
             </select></label>`
        : `<span class="cz-shelflabel">one paper on your shelf</span>`)
      + `<button type="button" class="btn" data-cz="pnew" title="start another paper">＋ new</button>`
      + (sh.papers.length > 1 ? `<button type="button" class="btn" data-cz="pdelete" title="delete the open paper">delete</button>` : "")
      + `</div>`;
    el.innerHTML = shelf
      + `<input class="cz-ptitle" type="text" maxlength="200"
           placeholder="name your paper" aria-label="your paper’s title"
           value="${esc(p.title)}">`
      + rows
      + (n ? "" : `<p class="cz-hint">Your paper starts empty. Add the meeting
           or issue you’re reading, or your reel — arrange the blocks, title
           it, share it as your own front page.</p>`)
      + tpls
      + (adds ? `<div class="cz-padds">${adds}</div>` : "")
      + share + shortOut;
    // typing must not repaint the panel under the caret — the title saves on
    // every keystroke and repaints nothing here (the /app/p draft render
    // catches up on its own debounce). The one exception: crossing the
    // empty↔titled boundary changes which controls exist, so repaint once and
    // put the caret back exactly where it was.
    const ti = $(".cz-ptitle", el);
    if (ti) ti.oninput = () => {
      const d = readPaper();
      const had = paperHasLive(d);
      d.title = cut(ti.value, PAPER_TITLE_MAX);
      const has = paperHasLive(d);
      if (!savePaper(d)) return;   // storage blocked — a toast per keystroke would be noise
      retireShortOut();            // the painted link names the old title now
      schedulePaperRender();
      if (had !== has)
        refreshPaperSummary({ act: "title", caret: ti.selectionStart });
    };
    // a note saves the way the title does: every keystroke, no repaint under
    // the caret (the row's preview label catches up on the next repaint)
    $$(".cz-pnote", el).forEach(ta => ta.oninput = () => {
      const d = readPaper();
      const i = +ta.dataset.i;
      // a stale index (another tab just rearranged) must not write over a
      // different block — the storage event's repaint reconciles the panel
      if (!(d.blocks[i] && d.blocks[i].kind === "note")) return;
      const had = paperHasLive(d);
      d.blocks[i].text = noteText(ta.value);
      const has = paperHasLive(d);
      if (!savePaper(d)) return;
      retireShortOut();
      schedulePaperRender();
      // crossing the empty↔live boundary changes which share controls
      // exist — repaint once, caret restored (the title's rule)
      if (had !== has)
        refreshPaperSummary({ act: "note", i, caret: ta.selectionStart });
    });
    const shsel = $(".cz-shelfsel", el);
    if (shsel) shsel.onchange = () => switchPaper(shsel.value);
    if (focus) {
      let t = focus.act === "title" ? ti
        : focus.act === "pshelf" ? (shsel || ti)
        : focus.act === "note"
          ? $(`.cz-pnote[data-i="${focus.i}"]`, el)
        : focus.act === "row"
          ? $(`.cz-prow[data-i="${focus.i}"] .cz-plabel`, el)
        : $(`[data-cz="${focus.act}"]`
            + (focus.i != null ? `[data-i="${focus.i}"]` : ""), el);
      // NEVER fall back to the destructive ✕: a repeated keypress walking a
      // block to a pole must not find delete armed under it. The opposite
      // arrow is always enabled when a move just succeeded; a single-block
      // paper falls to the title.
      if (t && t.disabled) {
        const other = focus.act === "pup" ? "pdown" : "pup";
        t = $(`[data-cz="${other}"][data-i="${focus.i}"]`, el);
        if (t && t.disabled) t = ti;
      }
      if (t) { t.focus();
        if ((focus.act === "title" || focus.act === "note")
            && typeof focus.caret === "number"
            && t.setSelectionRange) t.setSelectionRange(focus.caret, focus.caret);
      }
    }
  }
  /* ---- "＋ your paper" on the record's own cards (specs/23 A2) -------------
     The making half was invisible: one corner pill carried it. Now every
     meeting and issue card the record presses (the front page's lead, briefs,
     long view and updates; an issue's timeline) grows a small affordance in
     preview and studio modes — press it and the story joins your paper
     without leaving the page; press again and it leaves. Script-added, never
     baked (the byte-clean guard proves it), and never painted in paper mode:
     the resident who hid the studio sees exactly the specs/20 paper.

     The cards are whole-card <a>s, and a button may not live inside a link
     (interactive content in interactive content — invalid, and a screen
     reader hears a muddle). So each card is wrapped ONCE in a flex row with
     the button beside it; the card itself, its classes and its data-town are
     untouched, so the scope filter keeps finding it (and hides the row with
     it). An issue page's timeline head is a centred stack of spans — the
     button joins it as one more line. The label is the painted truth ("＋ your
     paper" / "✓ in your paper"), never a stored guess. */
  const MK_SEL = 'a.mcard[href^="/app/m/"], a.lrow[href^="/app/i/"], '
               + 'a.rsrow[href^="/app/i/"], article.lead';
  function cardStoryRef(el) {
    const a = el.matches("a") ? el : el.querySelector("a.lead-hl");
    const href = a ? (a.getAttribute("href") || "") : "";
    let m = /^\/app\/m\/([\w-]+)$/.exec(href);
    if (m) return { story: "meeting", pid: m[1] };
    m = /^\/app\/i\/([\w-]+)$/.exec(href);
    if (m) return { story: "issue", slug: m[1] };
    return null;
  }
  const storyIndex = (p, ref) => p.blocks.findIndex(b => b.kind === "story"
    && (ref.story === "meeting"
      ? b.story === "meeting" && b.pid === ref.pid
      : b.story === "issue" && b.slug === ref.slug));
  function paintMakeAffordances() {
    // never in paper mode — the button is removed from the painted page, not
    // merely styled away, so what a control says and what the reader sees
    // cannot disagree (the CSS rule is belt to this brace)
    const hide = shownMode() === "paper";
    const p = readPaper();
    $$(MK_SEL).forEach(card => {
      // a rendered paper's own story cards are the editor's blocks (A3),
      // not the record's rails; the studio's panel is never a card
      if (card.closest("#paperbody") || card.closest(".cz-studio")) return;
      const ref = cardStoryRef(card); if (!ref) return;
      let wrap = card.parentElement;
      if (!(wrap && wrap.classList.contains("cz-mkwrap"))) {
        wrap = document.createElement("div");
        wrap.className = "cz-mkwrap" + (card.matches("article.lead") ? " cz-mkwrap-lead"
          : card.matches(".mcard") ? " cz-mkwrap-card" : "");
        card.replaceWith(wrap); wrap.appendChild(card);
        const b = document.createElement("button");
        b.type = "button"; b.className = "cz-mk";
        wrap.appendChild(b);
      }
      wrap.hidden = !!card.hidden;
      paintMk($(".cz-mk", wrap), ref, p, hide, card);
    });
    $$(".tnode .thead").forEach(head => {
      const a = $("a.ttitle", head); if (!a) return;
      const ref = cardStoryRef(a); if (!ref) return;
      let b = $(".cz-mk", head);
      if (!b) { b = document.createElement("button"); b.type = "button";
        b.className = "cz-mk"; head.appendChild(b); }
      paintMk(b, ref, p, hide, a);
    });
  }
  function paintMk(b, ref, p, hide, card) {
    if (!b) return;
    const on = storyIndex(p, ref) >= 0;
    const named = card.querySelector("b, h2") || card;
    const name = (named.textContent || "").trim().slice(0, 80) || ref.pid || ref.slug;
    b.hidden = hide;
    b.classList.toggle("cz-mk-on", on);
    b.textContent = on ? "✓ in your paper" : "＋ your paper";
    b.title = on ? "remove from your paper" : `add this ${ref.story} to your paper`;
    // the accessible name begins with the visible words (WCAG 2.5.3, label
    // in name — a voice user says what they see), then says what it does
    b.setAttribute("aria-label", on ? `in your paper — remove “${name}”`
                                    : `your paper — add “${name}”`);
    b.onclick = () => on ? removeStoryRef(ref) : addStoryRef(ref);
  }

  /* ---- THE PREVIEW STAGE (specs/22 §5.3(b) / P2 — specs/23 B2) ------------
     Hearing a clip before keeping it, without touching the page player.
     One small player in the studio drawer, built on the first ▶ (this press
     is the click-to-load consent), owned by the panel and living OUTSIDE
     every node the panel repaints. Its laws, written before its code:
       · SOURCE-GATED: the stage hears only messages from its own frame
         (e.source === PV.win), and the page player hears only its own
         (onYT gates on YT.win) — two engines, two dispatches, never one
         message feeding both.
       · ONE ENGINE SEEKS: starting the stage pauses the page player and any
         reel it was playing; starting the page player (loadTape, ytSeek,
         startReel) pauses the stage. Nothing ever seeks the other's frame.
       · ITS OWN GATE: the stage arms only on a report inside the clip and
         before its end, then pauses at the end — the /app/r armed gate,
         reproduced for one clip; a tape switch settles 500 ms.
       · ONE CLIP: the stage plays the clip it was asked for and stops.
         Playing a sequence is /app/r's job and stays there.
       · HIDDEN IS SILENT: leaving the studio or collapsing the rail pauses
         the stage; a frame nobody can see must not keep talking. */
  /* the reader's hand is in a frame when the frame holds the focus — a
     press inside a cross-origin player moves focus to its <iframe> */
  const inFrame = el => !!el && document.activeElement === el;
  /* the stage. `hold`: told to be silent and not yet SEEN silent (a paused
     or cued report) — a play the frame reports meanwhile with no reader's
     hand in it is its own autoplay landing late, and is silenced again (a
     pause sent before playback has begun is a no-op to the player).
     `state`: the frame's last reported playerState; `free`: the reader's
     own ▶ on the frame, playing the tape outside any clip */
  const PV = { win: null, el: null, ready: false, clip: null, armed: false, settling: false,
               ended: false, vid: "", pending: null, wired: false,
               playing: false, paused: false, free: false, stopped: false, blocked: false,
               hold: false, watch: 0, state: -2, t: 0, last: null };
  const PV_ORIGIN = "https://www.youtube-nocookie.com";
  function pvSend(func, args) {
    if (!PV.win) return;
    const msg = func === "listening"
      ? { event: "listening", id: "czstage", channel: "widget" }
      : { event: "command", func, args: args || [] };
    PV.win.postMessage(JSON.stringify(msg), PV_ORIGIN);
  }
  /* the one-engine rule, the page's half: whatever the page player was
     doing stops when the stage speaks */
  function pagePause() {
    if (typeof YT !== "undefined" && YT.loaded) {
      // the page is held silent until it is SEEN silent; a player still in
      // its load gap keeps the place it was asked for (onReady CUES it
      // there — a seek would play) and so does a stashed cross-meeting cite
      if (!YT.ready || ![0, 2, 5].includes(YT.state)) YT.hold = true;
      if (YT.win && YT.ready) ytSend("cmd", "pauseVideo", []);
    }
    if (typeof REELPLAY !== "undefined" && REELPLAY && REELPLAY.active) {
      REELPLAY.active = false; REELPLAY.armed = false;
      REELPLAY.paused = true; reelShow();
    }
  }
  /* …and the stage's half: idempotent, safe before the stage exists */
  function pvPause() {
    clearTimeout(PV.watch); PV.blocked = false;
    // a stop before the frame is ready cannot reach it yet — remember it,
    // and onReady cues the tape instead of letting it autoplay
    if (!PV.ready && (PV.win || PV.pending || PV.vid)) PV.stopped = true;
    if ((PV.win || PV.pending) && (!PV.ready || ![0, 2, 5].includes(PV.state))) PV.hold = true;
    if (PV.ready) pvSend("pauseVideo");
    const was = PV.free || PV.paused; PV.free = false; PV.paused = false;
    if (!PV.clip && !PV.pending) { PV.playing = false; if (was) pvShow(); return; }
    PV.last = PV.clip || PV.pending || PV.last;   // the tape the frame still shows
    PV.clip = null; PV.armed = false; PV.ended = false; PV.pending = null; PV.playing = false;
    pvShow();
  }
  /* a trim of the clip the stage is previewing reaches the stage: its end
     is the gate's end, its start the status line's */
  function pvRetrim(clips) {
    // the gate follows the new edges — of the clip previewing, of one still
    // loading, and of the clip a stop left behind (the frame's own ▶ resumes
    // that one; a stop before ready cues it). A clip that has PLAYED stays
    // played (its frame rests paused at the old end — ▶ hears the new cut), a
    // paused one stays paused: nothing here plays, seeks, or repaints a state
    // the frame is not in
    const edge = x => { if (!x) return x;
      const c = clips.find(y => clipKey(y) === clipKey(x));
      return c && (c.start !== x.start || c.end !== x.end) ? { ...x, start: c.start, end: c.end } : x; };
    const was = PV.clip, wasLast = PV.last;
    PV.clip = edge(PV.clip); PV.last = edge(PV.last); PV.pending = edge(PV.pending);
    // the status line and the open-the-tape link follow the clip a stop
    // left behind too (a review catch)
    if (PV.clip !== was || PV.last !== wasLast) pvShow();
  }
  function pvPlay(clip) {
    if (!clip) return;
    if (!clip.video_id) { toast("this clip’s meeting has no tape to preview here"); return; }
    const box = $("#cz-stagebox"); if (!box) return;
    // a stage nobody can see must not play: open the studio (a paper's ▶
    // in preview mode) and expand a collapsed rail (the phone's #edit door
    // lands there) before a frame makes a sound
    if (shownMode() !== "studio") { writeRail(false); setMode("studio"); }
    else if (shownRail()) toggleRail();
    pagePause();
    box.hidden = false;
    // the drawer scrolls: a stage below its fold is a sound with no frame
    if (typeof box.scrollIntoView === "function") box.scrollIntoView({ block: "nearest" });
    PV.stopped = false; PV.playing = false; clearTimeout(PV.watch);
    PV.blocked = false; PV.paused = false; PV.free = false; PV.hold = false;
    PV.clip = clip; PV.armed = false; PV.ended = false;
    // an autoplay the browser refused would read as "previewing" forever:
    // if no playing report lands, say so and hand the reader the frame's own
    // ▶ (the first playing report disarms this — pvStarted)
    PV.watch = setTimeout(() => {
      if (PV.clip && !PV.playing && !PV.paused && !PV.ended) { PV.blocked = true; pvShow(); }
    }, 6000);
    if (!PV.win && !PV.pending) {
      // first use: the frame is built now — this ▶ is the click-to-load
      const ifr = document.createElement("iframe");
      ifr.className = "cz-stagefr"; PV.el = ifr;
      ifr.allow = "autoplay; encrypted-media; picture-in-picture";
      ifr.title = "the preview — one clip of the tape, in the studio";
      ifr.src = `${PV_ORIGIN}/embed/${encodeURIComponent(clip.video_id)}`
        + `?enablejsapi=1&autoplay=1&rel=0&start=${Math.floor(clip.start)}`;
      ifr.addEventListener("load", () => { PV.win = ifr.contentWindow; pvSend("listening"); });
      const st = $("#cz-stage"); if (st) { st.innerHTML = ""; st.appendChild(ifr); }
      PV.vid = clip.video_id; PV.pending = clip;
      if (!PV.wired) { PV.wired = true; window.addEventListener("message", onPV, false); }
    } else if (!PV.ready) {
      PV.pending = clip;                 // the frame is still loading — apply on ready
    } else if (clip.video_id !== PV.vid) {
      // another meeting's tape: load it, and let the stale reports of the
      // swapped-out tape settle before the gate may arm
      PV.vid = clip.video_id; PV.settling = true;
      setTimeout(() => { PV.settling = false; }, 500);
      pvSend("loadVideoById", [{ videoId: clip.video_id, startSeconds: clip.start }]);
      PV.state = -1;   // a load in flight is not a seen silence (a review catch)
    } else {
      pvSend("seekTo", [clip.start, true]); pvSend("playVideo");
    }
    pvShow();
  }
  function onPV(e) {
    if (e.source !== PV.win) return;   // the stage hears only its own frame
    if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    // initialDelivery and onReady land together: the ready work runs ONCE
    if ((d.event === "onReady" || d.event === "initialDelivery") && !PV.ready) {
      PV.ready = true; pvSend("listening");
      if (PV.stopped || !PV.clip) {
        // stopped before it was ready: CUE the last clip's tape at its start
        // — a cue replaces the autoplay; a pause before playback is ignored
        PV.stopped = false; PV.pending = null;
        const at = PV.last || {};
        PV.vid = at.video_id || PV.vid;
        pvSend("cueVideoById", [{ videoId: PV.vid, startSeconds: Math.max(0, +at.start || 0) }]);
      } else if (PV.pending) {
        const c = PV.pending; PV.pending = null;
        if (c.video_id === PV.vid) { pvSend("seekTo", [c.start, true]); pvSend("playVideo"); }
        else pvPlay(c);
      }
    }
    const info = d.info && typeof d.info === "object" ? d.info : null;
    if (!info) return;
    if (typeof info.currentTime === "number") PV.t = info.currentTime;
    if (typeof info.playerState === "number" && info.playerState !== PV.state) {
      PV.state = info.playerState;
      if (PV.state === 0 || PV.state === 2 || PV.state === 5) PV.hold = false;   // seen silent
      pvState(PV.state, PV.t);
    }
    if (typeof info.currentTime === "number") {
      // a seek inside a tape already playing may never change the reported
      // state: time moving under a playing state is the preview playing
      // (never while a tape switch settles: the old tape's stale reports)
      if (PV.clip && !PV.playing && !PV.paused && !PV.ended && !PV.settling && PV.state === 1) { pvStarted(); pvShow(); }
      pvAdvance(info.currentTime);
    }
  }
  /* the stage frame's own reports, as transitions: the status line says
     what the frame is actually doing, and one engine plays at a time */
  function pvStarted() {
    clearTimeout(PV.watch);
    PV.playing = true; PV.paused = false; PV.blocked = false;
  }
  function pvState(s, t) {
    if (s === 1) {
      if (PV.clip && !PV.ended) {
        // the preview playing: its first report, a resume after the reader
        // paused the frame, or the reader's ▶ after a refused autoplay
        pvStarted(); pagePause(); pvShow(); return;
      }
      // held silent and not yet seen silent: a play with no reader's hand
      // in it is the frame's own autoplay landing late — silenced again
      if (!PV.free && PV.hold && !inFrame(PV.el)) { pvSend("pauseVideo"); return; }
      // the reader's own ▶ on the frame: the stage is the engine now
      PV.hold = false; pagePause();
      const c = PV.free ? null : (PV.clip || PV.last);
      if (c && t >= c.start - 0.75 && t < c.end - 0.12) {
        // inside the clip: the preview goes on, bounded by its gate — never
        // pre-armed; a report inside the clip arms it
        PV.clip = c; PV.ended = false; PV.armed = false; PV.free = false; pvStarted();
      } else if (!PV.free) {
        // outside it: the tape plays, the status says so, no clip is marked
        if (PV.clip) PV.last = PV.clip;
        PV.clip = null; PV.ended = false; PV.armed = false; PV.free = true;
        PV.playing = false; PV.paused = false; PV.blocked = false;
      }
      pvShow(); return;
    }
    if (s === 2) {
      // the reader paused the frame mid-preview (the gate's own stop has
      // already marked its clip played); a free play paused is a stop
      if (PV.clip && !PV.ended) { PV.playing = false; PV.paused = true; }
      PV.free = false; pvShow(); return;
    }
    if (s === 0) {
      // the tape's own end ends the preview, or the frame's free play
      if (PV.clip && !PV.ended) { PV.ended = true; PV.armed = false; }
      PV.playing = false; PV.paused = false; PV.free = false; pvShow();
    }
  }
  /* the stage's gate, pure over (state, time): "arm" once a report lands
     inside the clip and before its end; "stop" once armed and the end is
     reached; nothing while settling or when no clip stands */
  function pvStep(pv, t) {
    const c = pv.clip;
    if (!c || pv.settling || pv.ended) return null;
    if (!pv.armed) return (t >= c.start - 0.75 && t < c.end - 0.12) ? "arm" : null;
    return t >= c.end - 0.12 ? "stop" : null;
  }
  function pvAdvance(t) {
    const a = pvStep(PV, t);
    if (a === "arm") PV.armed = true;
    else if (a === "stop") { pvSend("pauseVideo"); PV.armed = false; PV.ended = true; PV.playing = false; PV.hold = true; pvShow(); }
  }
  function pvShow() {
    const now = $("#cz-stagenow"), open = $(".cz-stageopen");
    const c = PV.clip;
    const what = !c ? (PV.free ? "playing the tape — from the frame’s own ▶, with no clip’s bounds" : "stopped")
      : PV.ended ? "played"
      : PV.blocked ? "the tape hasn’t started — press ▶ on the frame to play it here"
      : PV.paused ? "paused on the frame — its ▶ goes on"
      : PV.playing ? "previewing" : "loading the tape…";
    const line = !c ? what : `${what} · ${hms(c.start)}–${hms(c.end)}`
        + (c.quote ? ` · “${cut(String(c.quote), 60)}”` : "")
        + (c.mtitle ? ` · ${c.mtitle}` : "");
    // a status region re-announces on every write — write only what changed
    if (now && now.textContent !== line) now.textContent = line;
    const shown = c || PV.last;   // after a stop the frame still shows the last tape
    if (open) { open.href = shown ? `${BASE}/m/${encodeURIComponent(shown.pid || "")}#t${Math.floor(shown.start)}` : `${BASE}/`;
      open.hidden = !shown; }
    const key = c ? clipKey(c) : "";
    $$("[data-pvkey]").forEach(b => { const on = !!c && b.dataset.pvkey === key;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
  }
  /* a paper's reel rows (and any other surface) ask the stage through one
     delegated press: the button carries the clip as data-* refs */
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-pvpid]");
    if (!b) return;
    e.preventDefault();
    const d = b.dataset;
    pvPlay({ pid: d.pvpid, video_id: d.pvvid || "", start: +d.pvstart || 0,
             end: +d.pvend || 0, t: +d.pvt || +d.pvstart || 0,
             kind: d.pvkind || "moment", quote: d.pvquote || "", mtitle: d.pvmtitle || "" });
  });

  /* which story the open page could contribute — /app/m/<pid> or /app/i/<slug>.
     Pure string work on the path already parsed at the top of the file. */
  function pageStoryRef() {
    let m = /\/app\/m\/([\w-]+)$/.exec(path);
    if (m) return { story: "meeting", pid: m[1] };
    m = /\/app\/i\/([\w-]+)$/.exec(path);
    if (m) return { story: "issue", slug: m[1] };
    return null;
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
  /* "the whole record" is an answer too (specs/27 §2.4): the first-visit
     question was asked again on every page, because the one answer that
     stores no town left no trace. Any choice — a town, or all of them —
     marks the question asked, in this browser and nowhere else. */
  const ASKED_KEY = "cz-town-asked";
  const readAsked = () => { try { return localStorage.getItem(ASKED_KEY) === "1"; } catch { return false; } };
  const writeAsked = () => { try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* private mode: asked again next page */ } };
  const writeTown = t => { writeAsked(); try { t ? localStorage.setItem(TOWN_KEY, t) : localStorage.removeItem(TOWN_KEY); } catch { /* private mode: the visit still scopes */ } };
  const REDRAW = [];                    /* page hooks re-run on a scope change */
  let SCOPE = { town: "", body: "", from: "none", stored: "", lost: "", pids: [] };

  /* Resolve the scope from the URL, storage, and what the edition holds.
     Pure over (edition, location, storage) so the banner logic can reason
     about *where* the scope came from, not merely what it is. specs/29: a
     front page's search box adds m=<pid>,<pid> — the page's own meetings;
     the search reads inside exactly those. Never stored, like ?town=. */
  function resolve(ed) {
    const p = new URLSearchParams(location.search);
    return { ...resolveTown(ed, p), pids: scopePids(p.get("m")) };
  }
  const scopePids = v => [...new Set(String(v || "").split(",").map(x => x.trim()).filter(x => /^[\w-]{1,128}$/.test(x)))].slice(0, 64);
  function resolveTown(ed, p) {
    const names = (ed.towns || []).map(t => t.town);
    const match = n => names.find(x => x.toLowerCase() === String(n).toLowerCase()) || "";
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
    return { town: "", body, from: readAsked() ? "all" : "none", stored: "", lost };
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
      msg = readAsked()
        ? `A link scoped you to <b>${esc(SCOPE.town)}</b>. You chose the whole record —
             this visit only, unless you say otherwise.`
        : `A link scoped you to <b>${esc(SCOPE.town)}</b>. You have not chosen
             a town yet.`;
      acts = readAsked()
        ? [{ label: "back to the whole record", town: "", primary: true },
           { label: `make ${SCOPE.town} my town`, town: SCOPE.town }]
        : [{ label: `keep ${SCOPE.town}`, town: SCOPE.town, primary: true },
           { label: "show the whole record", town: "" }];
    } else if (here && SCOPE.town && here !== SCOPE.town) {
      msg = `This meeting is <b>${esc(here)}</b>'s. You are reading in
             <b>${esc(SCOPE.town)}</b>.`;
      acts = [{ label: `switch to ${here}`, town: here, primary: true },
              { label: `stay in ${SCOPE.town}`, dismiss: true }];
    } else if (SCOPE.from === "none" && many && !SCOPE.body && ["/app", "/app/s", "/app/officials"].includes(path)) {
      // first visit, more than one town: an inline row, never a modal. The
      // record stays readable behind it and "not yet" is a real answer.
      // Asked where the scope shapes the page (the front page, the search);
      // a shared meeting or reel leads with what was shared (specs/27 §2.4).
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
        // a first-visit dismissal ("the whole record") is the reader's answer
        if (a.dismiss) { if (SCOPE.from === "none") { writeAsked(); SCOPE = { ...SCOPE, from: "all" }; } el.hidden = true; return; }
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
  const inPids = pid => !(SCOPE.pids && SCOPE.pids.length) || SCOPE.pids.includes(String(pid || ""));
  /* the scope, said: "the 3 meetings of a front page · Brookline · Select Board" */
  const scopeWords = () => [(SCOPE.pids && SCOPE.pids.length) ? `the ${tpN(SCOPE.pids.length, "meeting")} a front page cites` : "",
    SCOPE.town, SCOPE.body].filter(Boolean).join(" · ");

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
      // the make-affordance row a card may sit in (A2) hides with it, or an
      // orphaned "＋ your paper" would offer a story the scope just hid
      const w = c.parentElement;
      if (w && w.classList.contains("cz-mkwrap")) w.hidden = !ok;
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
  // `hold` and `state` mirror the stage's (see PV); `el` is the page's
  // <iframe>, `vid` the tape it holds (cued or playing)
  let YT = { win: null, el: null, vid: "", loaded: false, ready: false, time: 0, pending: null,
             hold: false, state: -2 };
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
    if (BS_FOLLOW) { try { BS_FOLLOW(t); } catch { /* the score is decoration here */ } }
    if (MINIMAP && MINIMAP.dur) {
      MINIMAP.now.hidden = false;
      MINIMAP.now.style.top = Math.max(0, Math.min(100, t / MINIMAP.dur * 100)) + "%";
    }
    if (STICKY_NOW) { STICKY_NOW.hidden = false; STICKY_NOW.textContent = hms(t); }
  }
  /* the transcript row a time names: its own line, else the line it falls
     inside — a receipt's range end, or a time a model wrote, rarely names a
     line's first second (specs/28 §2.2) */
  function rowAt(sec) {
    const exact = document.getElementById("t" + sec);
    if (exact) return { row: exact, exact: true };
    // a time past the tape's end names no line (a model's [264:28] on a
    // three-hour tape): the page says where its tape ends
    const art = $(".meeting"), end = art ? +art.dataset.end || 0 : 0;
    if (end && sec > end + 1) return null;
    let best = null;
    for (const r of $$("#transcript .seg")) { if (+r.dataset.t <= sec + 0.5) best = r; else break; }
    return best ? { row: best, exact: false } : null;
  }
  function focusHash() {
    const m = location.hash.match(/^#t(\d+)$/); if (!m) return;
    const at = rowAt(+m[1]); if (!at) return;
    const row = at.row;
    $$("#transcript .seg.hit").forEach(r => r.classList.remove("hit"));
    row.classList.add("hit");
    row.scrollIntoView({ block: "center" });
    // a landed moment primes the facade: the next consented tap starts here —
    // at the line's own start, or at the very second a receipt named
    const f = $(".player.facade"); if (f) YT.pending = at.exact ? +row.dataset.t : +m[1];
  }
  function wirePlayer() {
    const f = $(".player.facade"); if (!f) return;
    f.addEventListener("click", () => loadTape(f.dataset.video));
  }
  function loadTape(vid, seekTo) {
    pvPause();   // one engine seeks (specs/23 B2)
    const f = $(".player.facade");
    if (f && !YT.loaded) {
      const ifr = document.createElement("iframe");
      ifr.allow = "autoplay; encrypted-media; picture-in-picture";
      ifr.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?enablejsapi=1&autoplay=1&rel=0`;
      ifr.addEventListener("load", () => { YT.win = ifr.contentWindow; ytSend("listening"); });
      f.classList.remove("facade"); f.innerHTML = ""; f.appendChild(ifr);
      YT.loaded = true; YT.pending = seekTo != null ? seekTo : YT.pending;
      YT.el = ifr; YT.vid = vid; YT.hold = false;   // the reader asked for this tape
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
    pvPause();   // one engine seeks (specs/23 B2)
    YT.hold = false;
    YT.time = t; strip(t);
    // command-ready only after onReady; a click during the load gap stashes
    // into pending instead of posting into the void (and being lost)
    if (YT.win && YT.ready) { ytSend("cmd", "seekTo", [t, true]); ytSend("cmd", "playVideo", []); }
    else YT.pending = t;
  }
  function onYT(e) {
    // the page player hears only its own frame — the preview stage in the
    // studio has a frame of its own, and its time reports must never feed
    // this engine (specs/23 B2: source-gated dispatch)
    if (e.source !== YT.win) return;
    if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    // initialDelivery and onReady land together: the ready work runs ONCE —
    // a second run would fire a stashed seek onto a tape the first switched
    if ((d.event === "onReady" || d.event === "initialDelivery") && !YT.ready) {
      YT.ready = true; ytSend("listening");
      const pv = REELPLAY && REELPLAY.pending;
      if (REELPLAY) REELPLAY.pending = null;
      if (YT.hold) {
        // the stage spoke while this player was loading: it stays silent
        // until the reader asks it to play (one engine seeks — specs/23 B2),
        // CUED where it was asked to be — the place kept, the play dropped
        const vid = pv ? pv.vid : YT.vid, at = pv ? pv.start : YT.pending;
        YT.pending = null;
        if (vid) { YT.vid = vid; ytSend("cmd", "cueVideoById", [{ videoId: vid, startSeconds: +at || 0 }]); }
        else ytSend("cmd", "pauseVideo", []);
      } else if (pv) {
        // a cross-meeting switch requested before the player was ready (a
        // cite tapped during the load gap) loads now; a stashed same-tape
        // seek belonged to the tape it abandons
        YT.pending = null; YT.vid = pv.vid; REELPLAY.settling = true;
        if (typeof setTimeout === "function")
          setTimeout(() => { if (REELPLAY) REELPLAY.settling = false; }, 500);
        ytSend("cmd", "loadVideoById", [{ videoId: pv.vid, startSeconds: pv.start }]);
        YT.state = -1; YT.time = pv.start;   // the load's own first report is the new tape's
      } else if (YT.pending != null) { const p = YT.pending; YT.pending = null; ytSeek(p); }
    }
    if (d.info && typeof d.info.playerState === "number" && d.info.playerState !== YT.state) {
      YT.state = d.info.playerState;
      if (YT.state === 0 || YT.state === 2 || YT.state === 5) YT.hold = false;   // seen silent
      // a pause pressed in the frame itself, mid-clip: the transport says so
      // — controls describe the painted state, and the tape is the state
      if (YT.state === 2 && REELPLAY && REELPLAY.active && REELPLAY.armed && !REELPLAY.settling && !REELPLAY.paused) {
        REELPLAY.active = false; REELPLAY.userPaused = true; reelShow();
      }
      else if (YT.state === 1) {
        // held silent and not yet seen so: a play with no reader's hand in
        // it is an autoplay landing late — silenced again
        if (YT.hold && !inFrame(YT.el)) ytSend("cmd", "pauseVideo", []);
        else {
          // a play in the page's own frame: the page is the engine — the
          // stage yields, and a reel the stage paused goes on from its clip
          YT.hold = false;
          if (PV.clip || PV.free) pvPause();
          if (REELPLAY && (REELPLAY.paused || REELPLAY.userPaused)) {
            REELPLAY.paused = false; REELPLAY.userPaused = false; REELPLAY.active = true; REELPLAY.armed = false;
            // on from its clip: where the frame stands inside it; from its
            // start when the frame stands before it; on to the next clip when
            // the frame already stands at its end (the gate never saw it)
            // — never on a time from the tape a load is swapping out: while
            // the switch settles the reel simply resumes, and the gate
            // re-arms after the beat (reelAdvance's own rule; a review catch)
            const c = (REELPLAY.clips || [])[REELPLAY.i];
            const t = typeof d.info.currentTime === "number" ? d.info.currentTime : YT.time;
            if (c && !REELPLAY.settling && t >= c.end - 0.12) reelNext();
            else { if (c && !REELPLAY.settling && t < c.start - 0.75) reelSeek(c); reelShow(); }
          }
        }
      }
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
      // a row's cut tick is the reel's press, not a seek: ticking five rows
      // must not load the tape and jump five times (a pane catch)
      if (e.target.closest("[data-czcut]")) return;
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
      // above the transcript's own bar, so the bar, the find box and the
      // lines stay one block (specs/27 §2.4)
      ($(".tbar") || $(".transcript")).before(...wrap.childNodes);
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
     about an existing link changes), v2 the moment it spans two. A link holds
     at most REEL_LINK_CAP clips — the host refuses an address past ~8 KB
     (414, a dead page), so a longer tray's link plays its first 240, and the
     tray says so. The press's reel_url caps the same (web/topic.py). */
  const REEL_LINK_CAP = 240;
  function reelShareURL(clips) {
    clips = clips.slice(0, REEL_LINK_CAP);
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
      if (colon > 0) {
        // a malformed escape in a v2 pid drops the clip, never the reel
        try { pid = decodeURIComponent(part.slice(0, colon)).trim(); } catch { continue; }
        range = part.slice(colon + 1);
      }
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
      share: shareURL(meta.pid, clips.slice(0, REEL_LINK_CAP)),
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
    // no clipboard at all (plain-http hosts, some embeds) must not throw —
    // the callers' surfaces keep showing the link itself
    if (!(navigator.clipboard && navigator.clipboard.writeText)) {
      toast("couldn’t copy — this browser has no clipboard here"); return; }
    navigator.clipboard.writeText(txt).then(
      () => toast(msg),
      () => toast("couldn’t copy — your browser blocked the clipboard"));
  }

  /* --- P1a: the composer, on the meeting page --- */
  let CREEL = null;   // {pid, meta, moments, clips, segs}

  function wireComposer(m) {
    // P0 (specs/22): the composer stands on EVERY meeting page now, moments
    // or none — the transcript's own rows are cuttable, so a page with zero
    // scored moments still cuts (the gate used to skip everything here)
    const meta = { pid: m.pid, title: m.title || "", town: m.town || "",
                   body: m.body || "", date: m.date || "",
                   video_id: m.video_id || "", url: m.url || "",
                   duration: +m.duration || 0 };
    // the transcript's segment starts, for trimming a clip to segment bounds
    const segs = $$("#transcript .seg").map(s => +s.dataset.t)
      .filter(t => isFinite(t)).sort((a, b) => a - b);
    CREEL = { pid: m.pid, meta, moments: m.moments || [], clips: loadReel(), segs };
    wireTicks();
    wireSegTicks();   // every transcript row grows its quiet tick (specs/22 §5.1)
    buildTray();
    paintTicks();
    paintCutTicks();
    // loadReel() may have just migrated legacy per-meeting drafts into the global
    // reel; the studio summary was painted before this meeting hydrated, so bring
    // it in line with what the tray now holds — the paper panel's "＋ your reel"
    // count rides the same tray.
    refreshReelSummary();
    refreshPaperSummary();
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
  const saveReel = () => writeTray(CREEL.clips);

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
    saveReel();   // writeTray repaints every surface, this tray included
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

  /* ---- CUT FROM ANYWHERE (specs/22 P0, §5.1) -------------------------------
     Every place the record shows a timed unit grows the moment cards' quiet
     tick: transcript rows (kind "segment" — the row's own bounds), search
     hits (kind "hit"), issue beads (kind "bead"). All hydration — the
     pressed pages carry none of it, and JS-off stays the clean reading.
     Clip identity stays (pid, kind, t); the link grammar never carried kind
     and does not change. */
  async function toggleCut(b) {
    const kind = b.dataset.czcut;
    let clip = null;
    if (kind === "segment") {
      // the row holds everything: its own start, the next row's start as the
      // end (the segment's true bound), and the words as the quote
      const row = b.closest(".seg"); if (!row || !CREEL) return;
      const t = r1(+row.dataset.t);
      if (!isFinite(t)) return;
      const nx = (CREEL.segs || []).find(s => s > t + 0.05);
      let end = nx != null ? nx : t + 12;
      if (CREEL.meta.duration) end = Math.min(end, CREEL.meta.duration);
      if (end <= t) end = t + MIN_CLIP;
      const sx = row.querySelector(".sx");
      clip = { t, start: t, end: r1(end), kind: "segment",
               quote: cut((sx && sx.textContent || "").trim(), 120),
               pid: CREEL.pid, video_id: CREEL.meta.video_id,
               mtitle: CREEL.meta.title, body: CREEL.meta.body,
               town: CREEL.meta.town, date: CREEL.meta.date,
               duration: CREEL.meta.duration || 0 };
    } else {
      // search hits and issue beads stamp what they know at render; the end
      // starts at the composer's twelve-second window and trims to the
      // record's own bounds in the tray (§5.6). The meeting's own plane —
      // one cached fetch — supplies the facts the surface did not carry
      // (the tape, its length, the date), and the end never passes the
      // tape's end: a clip past it would stall the viewer on the last frame
      const d = b.dataset, t = r1(+d.t);
      if (!isFinite(t) || !d.pid) return;
      // a line already on the tray leaves NOW, before any fetch — so a
      // second press during the plane's round trip removes rather than
      // doubles, and the add below re-checks once the plane has answered
      const have = trayClips();
      const i0 = have.findIndex(c => cutKey(c) === cutKey({ pid: d.pid, t }));
      if (i0 >= 0) { have.splice(i0, 1); writeTray(have); toast("removed from the reel"); return; }
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(d.pid)}.json`) || {};
      const dur = +m.duration || 0;
      let end = r1(t + 12);
      if (dur) end = Math.min(end, dur);
      if (end <= t) end = t + MIN_CLIP;
      clip = { t, start: t, end: r1(end), kind,
               quote: cut(d.quote || "", 120),
               pid: d.pid, mtitle: m.title || d.mtitle || "",
               video_id: m.video_id || "", body: m.body || d.body || "",
               town: m.town || d.town || "", date: m.date || d.date || "",
               duration: dur };
    }
    // one line is one cut, whatever surface cut it: a transcript row
    // already on the tray as a search hit leaves, it does not double
    const clips = trayClips();
    const i = clips.findIndex(c => cutKey(c) === cutKey(clip));
    if (i >= 0) clips.splice(i, 1); else clips.push(clip);
    writeTray(clips);
    toast(i >= 0 ? "removed from the reel" : "added to the reel");
  }
  /* membership, painted on every cut tick at once — a Set of the tray's
     keys, then one lookup per button (a transcript holds thousands). */
  function paintCutTicks() {
    const btns = $$("[data-czcut]");
    if (!btns.length) return;
    const keys = new Set(trayClips().map(cutKey));
    for (const b of btns) {
      let key;
      if (b.dataset.czcut === "segment") {
        const row = b.closest(".seg"); if (!row || !CREEL) continue;
        key = cutKey({ pid: CREEL.pid, t: r1(+row.dataset.t) });
      } else {
        key = cutKey({ pid: b.dataset.pid, t: r1(+b.dataset.t) });
      }
      const inr = keys.has(key);
      b.classList.toggle("on", inr);
      b.setAttribute("aria-pressed", inr ? "true" : "false");
      b.title = inr ? "in the reel — press to remove" : "add to the reel";
      // the glyph is painted by the stylesheet from data-g, so a selection
      // dragged across rows never picks the ticks up into a citation; the
      // accessible name leads with the visible words (WCAG 2.5.3)
      const wordy = b.classList.contains("stick");
      b.dataset.g = wordy ? (inr ? "✓ in reel" : "＋ reel") : (inr ? "✓" : "＋");
      b.textContent = "";
      b.setAttribute("aria-label", wordy
        ? (inr ? "in reel — press to remove this moment" : "reel — add this moment")
        : (inr ? "in the reel — press to remove this line" : "add this line to the reel"));
    }
  }
  /* the transcript's rows, made cuttable — one small button each, quiet
     until the row is hovered or focused (CSS), always there to a reader of
     the accessibility tree. One fragment pass; a big tape is thousands of
     rows and this must not thrash layout per row. */
  function wireSegTicks() {
    const tr = $("#transcript");
    const rows = $$("#transcript .seg");
    if (!tr || !rows.length || $(".seg-tick")) return;
    for (const row of rows) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "seg-tick";
      b.dataset.czcut = "segment";
      // not a tab stop: a two-hour tape is thousands of rows, and the row's
      // own time link is already one — press c on it to cut the row. The
      // button stays in the accessibility tree for a screen reader's own
      // navigation, and a pointer reaches it as ever.
      b.tabIndex = -1;
      b.setAttribute("aria-label", "add this line to the reel");
      row.appendChild(b);
    }
    tr.classList.add("cz-cuttable");   // the rows make room for the ticks
    tr.addEventListener("keydown", e => {
      if (e.key !== "c" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const a = e.target.closest && e.target.closest("a.ts");
      const row = a && a.closest(".seg"); const b = row && row.querySelector(".seg-tick");
      if (!b) return;
      e.preventDefault(); toggleCut(b);
    });
  }
  /* an issue's beads, made cuttable — the bead is an anchor, so its tick is
     a SIBLING (interactive inside interactive is a keyboard trap). */
  function wireBeadTicks() {
    $$(".issue .bead").forEach(a => {
      const m = /\/m\/([\w-]+)#t(\d+)$/.exec(a.getAttribute("href") || "");
      if (!m) return;
      const node = a.closest(".tnode");
      const tt = node && node.querySelector(".ttitle");
      const b = document.createElement("button");
      b.type = "button"; b.className = "btick";
      b.dataset.czcut = "bead"; b.dataset.pid = m[1]; b.dataset.t = m[2];
      b.dataset.quote = (a.textContent || "").replace(/^\s*[\d:]+\s*/, "").trim().slice(0, 120);
      if (tt) b.dataset.mtitle = tt.textContent.trim();
      // what the timeline node already says about its meeting rides along
      const td = node && node.querySelector(".tdate");
      if (td) b.dataset.date = td.textContent.trim();
      if (tt) b.dataset.body = tt.textContent.trim();
      b.setAttribute("aria-label", "add this moment to the reel");
      a.after(b);
    });
    paintCutTicks();
  }
  // one delegated press for every tick, wherever a page grew one
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-czcut]");
    if (b) { e.preventDefault(); toggleCut(b); }
  });

  function buildTray(focus) {
    let tray = $("#reeltray");
    if (!CREEL.clips.length) {
      if (tray) {
        // the last clip left under the keyboard: land on the moments panel's
        // head (or the transcript), never on <body>
        const had = focus || tray.contains(document.activeElement);
        tray.remove();
        if (had) { const to = $(".moments .tag") || $("#transcript"); if (to) { to.tabIndex = -1; to.focus(); } }
      }
      return;
    }
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
        <div class="rt-ord"${clips.length > 1 ? ` data-grip title="drag to move this clip — or use ↑ ↓"` : ""}>${clips.length > 1 ? '<span class="dg-grip" aria-hidden="true">⠿</span>' : ""}${i + 1}</div>
        <div class="rt-main">
          ${(multi || other) ? `<div class="rt-from">${esc(c.mtitle || c.pid || "another meeting")}</div>` : ""}
          <div class="rt-quote" tabindex="-1">${esc((c.quote || "").slice(0, 120)) || "(moment)"}</div>
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
        <span class="tag">your reel — ${clips.length} clip${clips.length > 1 ? "s" : ""} · ${hms(reelRuntime(clips))} total${span}${clips.length > REEL_LINK_CAP ? ` · a link plays the first ${REEL_LINK_CAP}` : ""}</span>
        <button class="btn rt-clear" type="button">clear</button></div>
      <div class="rt-clips">${rows}</div>
      <div class="rt-out">
        <label class="rt-share"><span class="rt-tl">share link</span>
          <input class="rt-url" readonly value="${esc(url)}"></label>
        <div class="rt-btns">
          <button class="btn primary" type="button" data-out="link">⧉ Copy share link</button>
          <button class="btn" type="button" data-out="cite">⧉ Copy cite sheet</button>
          ${multi ? "" : '<button class="btn" type="button" data-out="json">⬇ reel.json</button>'}
          ${multi ? "" : deskBtn()}</div></div>
      <p class="hint">The reel lives in this link and this browser — no account,
        no server. Play it back in <a href="${esc(url)}">the viewer</a>.
        ${multi
          ? "<b>This reel spans meetings</b> — it plays and cites here; rendering one video across meetings is a desk step still to come."
          : "<b>Rendering the video needs the desk</b> — the reel.json opens in Highlighter, in the desktop app."}</p>`;
    wireTray();
    if (focus) {
      // the pole rule (the panel's): a move that landed on a pole disabled
      // the arrow under the keyboard — the opposite arrow takes it; a
      // removal lands on the next row's quote, never its ✕
      const row = $(`.rt-clip[data-i="${focus.i}"]`, tray);
      // "row" (a drop, a removal) lands on the row's quote — inert, as the
      // panel's is: its first button is ◀ start earlier, and a Space or an
      // Enter meant for the page would trim the clip unseen (a review catch)
      let t = row && (focus.act === "row" ? $(".rt-quote", row) : $(`.rt-b[data-act="${focus.act}"]`, row));
      if (t && t.disabled) { const other = focus.act === "up" ? "down" : focus.act === "down" ? "up" : "";
        t = other ? $(`.rt-b[data-act="${other}"]`, row) : $(".rt-b", row); }
      if (!t) t = $(".rt-clear", tray);
      if (t && typeof t.focus === "function") t.focus(focus.quiet ? { preventScroll: true } : undefined);
    }
  }
  function wireTray() {
    const tray = $("#reeltray"); if (!tray) return;
    $(".rt-clear", tray).onclick = () => { writeTray([]); toast("reel cleared"); };
    $$(".rt-clip", tray).forEach(rowEl => {
      const i = +rowEl.dataset.i;
      $$(".rt-b", rowEl).forEach(b => b.onclick = () => clipAct(i, b.dataset.act));
    });
    $$("[data-out]", tray).forEach(b => b.onclick = () => output(b.dataset.out));
    const url = $(".rt-url", tray); if (url) url.onclick = () => url.select();
    wireDrag($(".rt-clips", tray), ".rt-clip", (from, to, key) => trayMove(from, to, "tray", key));
  }
  function clipAct(i, act) {
    // the meeting tray and the panel tray are the same tray — one engine
    // (specs/22 §5.2); the composer's rows just address it by index, and
    // say they did so focus comes back to them
    trayAct(i, act, "tray");
  }
  /* one honest trim step, shared by both trays: snap to the record's own
     segment bounds when we hold them, else nudge two seconds (specs/22
     §5.6 — sub-segment trims are settled OUT; the units are the record's). */
  function stepEdge(t, dir, segs, dur) {
    if (segs && segs.length) {
      // bounds read off the pressed text are whole seconds while a page's
      // own are tenths — compare at the bounds' grain, or the first press
      // from 907.4 "snaps" to 907 (the same line) instead of the line before
      const q = segs.every(Number.isInteger) ? Math.floor(t) : t;
      if (dir === "+") { const nx = segs.find(s => s > q + 0.05);
        return nx == null ? Math.min(dur, t + 2) : nx; }
      const pv = segs.filter(s => s < q - 0.05).pop();
      return pv == null ? Math.max(0, t - 2) : pv;
    }
    return dir === "+" ? Math.min(dur, t + 2) : Math.max(0, t - 2);
  }
  /* segment bounds for ANY meeting, one fetch each: the pressed
     transcript.txt re-read as the record's own units (specs/22 §5.6 — no
     new plane; the file every meeting page already offers for download).
     A fetch that fails leaves [] and the trim falls to its honest nudge —
     said out loud, once per meeting, by the caller. */
  const SEGB = {};      // pid → sorted segment starts
  const SEGB_P = {};    // pid → the one in-flight fetch
  const SEGB_SAID = new Set();   // pids whose missing bounds were said out loud
  /* the pressed transcript's own timestamps, total: [M:SS] under an hour,
     [H:MM:SS] over (hms()'s two shapes); any line that isn't one is not a
     bound. A node twin executes this against both shapes and the garbage. */
  function parseSegTimes(tx) {
    const out = [];
    for (const line of String(tx || "").split("\n")) {
      const m = /^\[(\d+):(\d\d)(?::(\d\d))?\]/.exec(line);
      if (m) out.push(m[3] == null
        ? +m[1] * 60 + +m[2]
        : +m[1] * 3600 + +m[2] * 60 + +m[3]);
    }
    return out.sort((a, b) => a - b);
  }
  function segBounds(pid) {
    if (!pid) return Promise.resolve([]);
    if (SEGB[pid]) return Promise.resolve(SEGB[pid]);
    return SEGB_P[pid] ||= fetch(`${BASE}/m/${encodeURIComponent(pid)}/transcript.txt`)
      .then(r => r.ok ? r.text() : "")
      .catch(() => "")
      .then(tx => {
        const segs = parseSegTimes(tx);
        // a fetch that failed is forgotten, so the next trim asks again —
        // "no bounds" is a fact about the record, not about this request
        if (segs.length) SEGB[pid] = segs; else delete SEGB_P[pid];
        return segs;
      });
  }
  /* the tray, written once for every writer — the ticks, the meeting tray,
     the panel — and every painted surface reconciled from the one truth
     (other tabs reconcile through the storage event, as before). */
  function writeTray(clips, focus, origin) {
    try { localStorage.setItem(REEL_KEY, JSON.stringify(clips)); }
    catch { /* private mode: the tray still works for this visit */ }
    // focus follows the surface that pressed: the meeting tray's own
    // control, or the panel's — never the other one's
    if (CREEL) { CREEL.clips = clips; buildTray(origin === "tray" ? focus : null); paintTicks(); }
    paintCutTicks();
    pvRetrim(clips);         // the stage follows a trim of the clip it plays
    refreshReelSummary(origin === "tray" ? undefined : focus);
    refreshPaperSummary();   // the "＋ your reel" count rides the tray
  }
  /* the tray as this page holds it: the composer's own copy when the page
     composes (it mirrors every write, and stands even where storage is
     refused), the stored reel elsewhere. A copy — callers mutate it. */
  const trayClips = () => CREEL ? CREEL.clips.map(c => ({ ...c })) : readReel(REEL_KEY);
  /* a cut's identity for the ticks: the line, whatever surface cut it —
     a search hit and its transcript row are one line (kinds are labels) */
  const cutKey = c => (c.pid || "") + "@" + r1(c.t);
  /* every tray action, page-agnostic (specs/22 §5.2): index-addressed
     against the reel as it stands. Trims may await a bounds fetch — the
     reel is RE-READ after the await and the clip re-found by its identity,
     so a press that landed meanwhile is never overwritten. `origin` names
     the surface that pressed, so focus returns THERE (the meeting tray's
     own controls, or the panel's). */
  async function trayAct(i, act, origin) {
    let clips = trayClips();
    let c = clips[i]; if (!c) return;
    let focus = { act, i };
    if (act === "rm") {
      clips.splice(i, 1);
      // focus falls to the next ROW, never its ✕ — a held Enter must not
      // cascade deletes (the paper panel's rule)
      focus = clips.length ? { act: "row", i: Math.min(i, clips.length - 1) } : null;
    } else if (act === "up" && i > 0) {
      clips.splice(i - 1, 0, clips.splice(i, 1)[0]); focus = { act, i: i - 1 };
    } else if (act === "down" && i < clips.length - 1) {
      clips.splice(i + 1, 0, clips.splice(i, 1)[0]); focus = { act, i: i + 1 };
    } else if (act[0] === "s" || act[0] === "e") {
      const own = CREEL && (!c.pid || c.pid === CREEL.pid);
      const segs = own ? CREEL.segs : await segBounds(c.pid);
      if (!own && !(segs && segs.length) && !SEGB_SAID.has(c.pid || "")) {
        SEGB_SAID.add(c.pid || "");
        toast("that meeting’s transcript didn’t load — nudging by two seconds instead");
      }
      // the fetch awaited — re-read and re-find, another press may have landed
      clips = trayClips();
      const j = clips.findIndex(x => clipKey(x) === clipKey(c));
      c = clips[j]; if (!c) return;
      focus = { act, i: j };
      const dur = own ? (CREEL.meta.duration || 1e9) : (c.duration || 1e9);
      if (act[0] === "s") c.start = r1(Math.max(0, Math.min(stepEdge(c.start, act[1], segs, dur), c.end - MIN_CLIP)));
      else c.end = r1(Math.min(dur, Math.max(stepEdge(c.end, act[1], segs, dur), c.start + MIN_CLIP)));
    } else return;
    writeTray(clips, focus, origin);
  }
  /* a drag's drop (specs/27 §3.2): the clip the grip lifted — re-found by
     its identity, so a tray another tab rewrote mid-drag moves the right
     clip or none — lands at `to`; focus comes back to its row */
  function trayMove(from, to, origin, key) {
    const clips = trayClips();
    // the row the grip lifted, while it still holds that clip — else the
    // clip re-found by identity (a duplicate identity must not move its twin)
    const i = !key ? from : clipKey(clips[from] || {}) === key ? from : clips.findIndex(c => clipKey(c) === key);
    if (i < 0 || !clips[i]) return;
    const j = Math.max(0, Math.min(clips.length - 1, to));
    if (i === j) return;
    clips.splice(j, 0, clips.splice(i, 1)[0]);
    // quiet: a pointer's drop lands focus on the row without scrolling the page to it
    writeTray(clips, { act: "row", i: j, quiet: true }, origin);
    toast(`clip moved to ${j + 1} of ${clips.length}`);
  }
  /* drag to reorder (specs/27 §3.2) — the Highlighter's timeline, in the
     paper: press a row's grip, move, let go. Pointer events, so a finger
     drags as a mouse does; a line says where it will land; held near an
     edge, the list (or the page) scrolls; Esc puts it back. The ↑ ↓ buttons
     stand — they are the keyboard's way, and the grip says so. One engine
     for both trays; nothing leaves the browser. */
  /* where a drop lands: past every other row whose middle is above the
     pointer — the dragged row's new index in the list without it */
  const dgSlot = (y, rects) => rects.reduce((n, b) => n + (b.top + b.height / 2 < y ? 1 : 0), 0);
  let DG = false;   // one live drag, page-wide: a second finger is not a second drag
  function wireDrag(list, rowSel, onMove) {
    if (!list) return;
    list.addEventListener("pointerdown", e => {
      const grip = e.target.closest && e.target.closest("[data-grip]");
      // the primary button of the primary pointer only (a pen's barrel or
      // eraser, a second finger, a right button — none of them lift a clip)
      if (!grip || !list.contains(grip) || DG || e.isPrimary === false || e.button !== 0
          || (e.pointerType === "mouse" && e.ctrlKey)) return;   // a Mac's ctrl-click is its right button
      // a finger or a pen drags by the ⠿ alone — the rest of the number
      // scrolls the page, as a phone or a tablet expects (only the glyph says
      // touch-action:none; a pen pressed elsewhere would scroll, and the
      // browser would cancel the drag it started)
      if ((e.pointerType === "touch" || e.pointerType === "pen") && !(e.target.closest && e.target.closest(".dg-grip"))) return;
      const row = grip.closest(rowSel), rows = $$(rowSel, list), from = rows.indexOf(row);
      if (from < 0 || rows.length < 2) return;
      const clip = trayClips()[from], key = clip ? clipKey(clip) : "";
      const others = rows.filter(r => r !== row);
      // what scrolls when the pointer is held at an edge: the list when it
      // scrolls, else the nearest ancestor that does — and never the page
      // behind a fixed one (the studio's sidebar floats over the record).
      // Measured before the drag is taken: nothing that could throw runs
      // between DG = true and the listeners that end it
      const scroller = (() => {
        for (let n = list; n && n.nodeType === 1; n = n.parentElement) {
          const cs = getComputedStyle(n); if (!cs) continue;
          if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
          if (cs.position === "fixed") return "none";
        }
        return null;
      })();
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* the document listeners below hear it anyway */ }
      row.classList.add("dg-lift");
      const line = document.createElement("div"); line.className = "dg-line"; line.hidden = true;
      list.appendChild(line);
      const y0 = e.clientY;
      let to = from, lastY = y0, raf = 0, moved = false, over = false;
      const place = y => {
        const pos = dgSlot(y, others.map(r => r.getBoundingClientRect()));
        to = pos;
        const lr = list.getBoundingClientRect();
        const at = pos < others.length ? others[pos].getBoundingClientRect().top - 3
          : others[others.length - 1].getBoundingClientRect().bottom + 1;
        // never above the list's own top (a scroller clips a line at -3px),
        // never below its lowest row (past it, a list that did not scroll
        // grows a scrollbar mid-drag and its rows reflow)
        const floor = Math.max(row.getBoundingClientRect().bottom, others[others.length - 1].getBoundingClientRect().bottom) - 3;
        line.style.top = `${Math.max(0, Math.round(Math.min(at, floor) - lr.top + list.scrollTop))}px`;
        line.hidden = to === from;
      };
      // a repaint mid-drag (another tab's write, a trim landing) took the
      // rows away: the drag ends, and nothing drops onto the old geometry
      // — or hid them (the studio panel collapsed, its mode switched): every
      // row measures nothing, and a drop would land anywhere
      const gone = () => !row.isConnected || !list.isConnected || !list.getClientRects().length;
      const edge = () => {
        if (gone()) { done(null); return; }
        if (moved && scroller !== "none") {
          // the edges of what shows of it: a sidebar scrolled half off the
          // screen scrolls when the pointer is at the screen's edge
          const r = scroller ? scroller.getBoundingClientRect() : null;
          const top = r ? Math.max(0, r.top) : 0, bottom = r ? Math.min(innerHeight, r.bottom) : innerHeight;
          const d = lastY < top + 40 ? -10 : lastY > bottom - 40 ? 10 : 0;
          if (d) { if (scroller) scroller.scrollBy(0, d); else scrollBy(0, d); place(lastY); }
        }
        raf = requestAnimationFrame(edge);
      };
      const mine = ev => ev.pointerId === e.pointerId;
      const move = ev => {
        if (!mine(ev)) return;
        if (gone() || (ev.pointerType === "mouse" && ev.buttons === 0)) { done(null); return; }
        lastY = ev.clientY;
        if (!moved && Math.abs(lastY - y0) < 6) return;   // a press is not yet a drag
        moved = true; place(lastY);
      };
      const up = ev => { if (mine(ev)) done(ev); };
      const lost = ev => { if (mine(ev) && gone()) done(null); };
      // the same pointer pressing again, or a new gesture (a primary press),
      // means this drag's release was never seen: it is over. A second
      // finger (not primary) is ignored, and leaves the live drag alone
      const press = ev => { if (!ev || mine(ev) || ev.isPrimary !== false) done(null); };
      const onKey = ev => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(null); } };
      const done = ev => {
        if (over) return; over = true; DG = false;
        cancelAnimationFrame(raf);
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        document.removeEventListener("lostpointercapture", lost, true);
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", press, true);
        removeEventListener("blur", press);
        row.classList.remove("dg-lift"); line.remove();
        if (ev && ev.type === "pointerup" && moved && to !== from && !gone()) onMove(from, to, key);
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", up, true);
      document.addEventListener("lostpointercapture", lost, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", press, true);
      addEventListener("blur", press);
      DG = true;
      place(y0);
      raf = requestAnimationFrame(edge);
    });
  }
  /* the meeting a single-meeting reel belongs to: this page's when its clips are
     from here, else reconstructed from what a clip carries (a reel built on
     another meeting, viewed from this one). */
  function reelMeta(clips) {
    if (CREEL && clips.every(c => !c.pid || c.pid === CREEL.pid)) return CREEL.meta;
    const c = clips[0] || {};
    return { pid: c.pid || "", title: c.mtitle || "", town: c.town || "",
             body: c.body || "", date: c.date || "", video_id: c.video_id || "",
             url: c.url || "", duration: +c.duration || 0 };
  }
  const trayMeta = reelMeta;   // the panel tray's name for it — no page needed
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
      // a clip inside a scored moment's window is that moment; any other
      // cut is its own line — labelled by the tape's words at its start,
      // never by the nearest moment's (a review catch: anywhere-cuts read
      // as the wrong words with the wrong deep link)
      const mo = momentFor(m.moments || [], c.start, c.end);
      const dur = +m.duration || 0;
      const end = dur ? Math.min(c.end, dur) : c.end;   // never past the tape
      if (end <= c.start) return null;
      return { pid: c.pid, start: c.start, end,
               t: mo ? r1(mo.t) : c.start, kind: mo ? mo.kind : "cut",
               quote: mo ? mo.quote : "", video_id: m.video_id || "",
               mtitle: m.title || "", body: m.body || "", town: m.town || "",
               date: m.date || "", duration: dur };
    }).filter(Boolean);
    if (!clips.length) return reelMessage(cites, gone);
    // the words of every cut that is not a moment, from the tape itself
    await quoteCuts(clips);
    const nmeet = reelPids(clips).length;
    const first = mby[clips[0].pid];
    document.title = (nmeet > 1 ? `A reel across ${nmeet} meetings`
                                : `${first.title || "A reel"} — a reel`)
      + ` · publicrecord.studio`;
    buildViewer(stage, cites, clips, mby, nmeet > 1);
  }
  /* the moment a clip belongs to, or null: the clip's start must sit
     inside the moment's own window (its padded start to its end). No
     "nearest" — a cut from a transcript row two minutes from any moment
     is not that moment. */
  function momentFor(moments, start, end) {
    for (const mo of moments) {
      const a = r1(mo.start != null ? mo.start : mo.t), b = r1(mo.end || mo.t);
      if (start >= a - 0.5 && start <= b + 0.5) return mo;
    }
    return null;
  }
  async function quoteCuts(clips) {
    const need = [...new Set(clips.filter(c => !c.quote && c.pid).map(c => c.pid))];
    const got = {};
    await Promise.all(need.map(async pid => { got[pid] = await segLines(pid); }));
    for (const c of clips) if (!c.quote && got[c.pid]) c.quote = cut((lineAt(got[c.pid], c.start) || {}).text || "", 120);
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
    const thumb = (mby[firstPlayable.pid] || {}).still || (mby[firstPlayable.pid] || {}).thumb || "";
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
    // the transport (specs/25 §2.5): prev · play/pause · next, the clip
    // counter, and one segment per clip — the bar fills as the tape plays.
    // Built once the viewer's state stands (it reads and writes REELPLAY).
    if (v0) { stage.insertAdjacentHTML("beforeend", rpBar(clips)); wireReelBar(stage, clips); }
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
          <button class="btn primary" type="button" data-rv="mine">✂ make this reel yours</button>
          <button class="btn" type="button" data-rv="share">⧉ share the reel</button>
          <button class="btn" type="button" data-rv="cite">⧉ Copy cite sheet</button>
          ${multi ? "" : '<button class="btn" type="button" data-rv="json">⬇ reel.json</button>'}
          ${multi ? "" : deskBtn()}
          ${multi ? "" : `<a class="btn" href="${BASE}/m/${esc(vmeta.pid)}">open the meeting →</a>`}</div>
        <p class="rv-take" id="rvtake" hidden></p>
        <p class="hint">This reel lives in the link you followed — no account, no
          server kept it. <b>Make it yours</b> and its clips land on your own
          tray, to re-cut and re-share. ${multi
            // one meeting's reel: the page's own line says the desk renders it
            ? "<b>This reel spans meetings</b> — it plays and cites here; rendering one video across meetings is a desk step still to come."
            : ""}</p>`;
    // the clips a taken reel hands to the tray: ordinary clips — the same
    // identity (pid, kind, t), the same trim rules, the meeting's duration
    // for the trim's ceiling — nothing the record would not say itself
    // identity = the cut itself (its start), never the moment it sits in:
    // two cuts inside one moment must stay two clips on the tray, and a
    // trim must land on the one that was pressed (a review catch)
    const mine = () => clips.map(c => ({
      pid: c.pid, start: r1(c.start), end: r1(c.end),
      t: r1(c.start), kind: c.kind || "moment",
      quote: c.quote || "", video_id: c.video_id || "", mtitle: c.mtitle || "",
      body: c.body || "", town: c.town || "", date: c.date || "",
      duration: +((mby[c.pid] || {}).duration) || 0 }));
    $$("[data-rv]", cites).forEach(b => b.onclick = () =>
      b.dataset.rv === "cite" ? copyText(citeSheet(vmeta, clips), "cite sheet copied")
      : b.dataset.rv === "json" ? downloadReel(vmeta, clips)
      : b.dataset.rv === "share" ? rpShare()
      : takeReel(mine(), $("#rvtake", cites)));
    // clicking a cite while the reel plays jumps to that clip (switching the tape
    // when the clip is from another meeting); a tape-less clip just follows its
    // deep link, and so does any click when the reel isn't playing
    $$(".reelcite", cites).forEach(a => a.addEventListener("click", ev => {
      const i = +a.dataset.i, c = REELPLAY.clips[i];
      // a reel the stage paused — or the transport, or the frame's own
      // pause button — goes on from the clip pressed (a re-review catch: the
      // transport's pause turned every cite into an exit)
      if ((REELPLAY.paused || REELPLAY.userPaused) && c.video_id) {
        ev.preventDefault(); pvPause();
        REELPLAY.paused = false; REELPLAY.userPaused = false; REELPLAY.done = false;
        REELPLAY.active = true; REELPLAY.i = i; REELPLAY.armed = false;
        reelSeek(c); reelShow(); return;
      }
      if (!REELPLAY.active || !c.video_id) return;
      ev.preventDefault();
      REELPLAY.i = i; REELPLAY.armed = false;
      reelSeek(c); reelShow();
    }));
  }
  /* make this yours (specs/22 §5.4, settled §6.3): a shared reel becomes
     the reader's. Into an EMPTY tray it simply arrives. Into a tray that
     holds clips the choice is explicit and painted, never silent: append
     after what you have (clips already on the tray, by identity, are not
     doubled), or replace it — behind a confirm — or keep yours. Pure over
     (tray, clips, the reader's answer); the write is writeTray's, so every
     surface (the panel, the pill) repaints from the one truth. */
  function takeReel(clips, box) {
    if (!clips.length) return;
    const have = readReel(REEL_KEY);
    if (!have.length) {
      writeTray(clips);
      toast(`${clips.length} clip${clips.length > 1 ? "s" : ""} on your tray now — cut on from the studio`);
      if (box) { box.hidden = false;
        box.innerHTML = `these clips are on <b>your</b> tray now — open the studio to re-cut, or ${clips.length > 1 ? "add more" : "add more"} from any meeting`; }
      return;
    }
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<span class="rv-take-t">Your tray already holds <b>${have.length}</b> clip${have.length > 1 ? "s" : ""}.</span> `
      + `<button type="button" class="btn" data-take="append">append these after them</button> `
      + `<button type="button" class="btn" data-take="replace">replace them with this reel</button> `
      + `<button type="button" class="btn" data-take="keep">keep mine</button>`;
    $$("[data-take]", box).forEach(b => b.onclick = () => takeAnswer(b.dataset.take, clips, box));
    const first = $("[data-take]", box); if (first) first.focus();
  }
  /* the answer, applied — separated so a node twin can drive it without a
     DOM: returns what the tray was written with, or null for a refusal */
  function takeMerge(answer, have, clips, confirmed) {
    if (answer === "append") {
      // already held = the same identity (pid, kind, t) OR the same cut
      // (pid, start, end): a taken clip's kind and t are reconstructed from
      // the record's moments, so a reel appended twice must still not double
      const keys = new Set(have.map(clipKey));
      const cuts = new Set(have.map(c => `${c.pid || ""}@${r1(c.start)}-${r1(c.end)}`));
      return have.concat(clips.filter(c => !keys.has(clipKey(c))
        && !cuts.has(`${c.pid || ""}@${r1(c.start)}-${r1(c.end)}`)));
    }
    if (answer === "replace") return confirmed ? clips.slice() : null;
    return null;
  }
  function takeAnswer(answer, clips, box) {
    const have = readReel(REEL_KEY);
    const confirmed = answer !== "replace"
      || window.confirm(`Replace your ${have.length} clip${have.length > 1 ? "s" : ""} with this reel’s ${clips.length}? Your own cuts would be gone.`);
    const next = takeMerge(answer, have, clips, confirmed);
    // the button under the keyboard is about to go — the box itself takes
    // the focus and reads its answer (a review catch: three ways to <body>)
    const land = () => { if (box) { box.tabIndex = -1; box.focus(); } };
    if (!next) {
      if (box) { box.innerHTML = answer === "keep" ? "kept yours — this reel stays a link you can come back to"
                                                  : "kept yours"; }
      land(); toast("your tray is unchanged");
      return;
    }
    const added = next.length - (answer === "append" ? have.length : 0);
    writeTray(next);
    toast(answer === "append"
      ? `${added} clip${added === 1 ? "" : "s"} appended — ${next.length} on your tray now`
      : `your tray is this reel now — ${next.length} clip${next.length > 1 ? "s" : ""}`);
    if (box) box.innerHTML = `on <b>your</b> tray now — ${next.length} clip${next.length > 1 ? "s" : ""}; open the studio to re-cut`;
    land();
  }
  /* ---- the transport bar (specs/25 §2.5) — the Highlighter's reel player,
     in the paper: prev/play/next, "clip 3 of 9 · 0:31 / 1:36", a segmented
     bar (one segment per clip, sized by its length) that fills with the
     tape's own time reports, and the share row. Paints the reel as it
     stands — never a timer pretending to be the tape. */
  function rpBar(clips) {
    const total = reelRuntime(clips) || 1;
    const segs = clips.map((c, i) => `<button type="button" class="rp-seg" data-i="${i}" style="flex:${Math.max(1, clipLen(c))}"
      title="clip ${i + 1} · ${hms(c.start)} · ${esc(cut(c.quote || c.kind || "", 80))}" aria-label="go to clip ${i + 1} of ${clips.length}"><i></i></button>`).join("");
    return `<div class="rp-bar" role="group" aria-label="the reel’s transport">
        <button type="button" class="rp-btn" data-rp="prev" aria-label="previous clip" disabled>◀</button>
        <button type="button" class="rp-btn rp-play" data-rp="toggle" aria-label="play the reel">▶ play</button>
        <button type="button" class="rp-btn" data-rp="next" aria-label="next clip"${clips.length > 1 ? "" : " disabled"}>▶|</button>
        <span class="rp-count" id="rpcount" aria-live="off">${clips.length} clip${clips.length > 1 ? "s" : ""} · ${hms(total)}</span>
      </div>
      <div class="rp-prog" role="group" aria-label="where the reel stands, clip by clip">${segs}</div>`;
  }
  function wireReelBar(stage, clips) {
    $$("[data-rp]", stage).forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.rp;
      if (k === "toggle") rpToggle(clips);
      else rpStep(clips, k === "next" ? 1 : -1);
    }));
    $$(".rp-seg", stage).forEach(b => b.addEventListener("click", () => rpJump(clips, +b.dataset.i)));
    if (!REELPLAY.keys) {
      REELPLAY.keys = true;
      document.addEventListener("keydown", e => {
        // the keys are the page's, never a control's: a link, a summary,
        // a button or a field keeps its own Space and arrows; a held key
        // does not step or toggle again
        if (!REELPLAY || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        if (e.target && e.target.closest && e.target.closest("input, textarea, select, button, a, summary, [contenteditable]")) return;
        if (e.key === " ") { e.preventDefault(); rpToggle(REELPLAY.clips); }
        else if (e.key === "ArrowRight") { e.preventDefault(); rpStep(REELPLAY.clips, 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); rpStep(REELPLAY.clips, -1); }
      });
    }
  }
  /* play from the start, pause the tape, or go on from where it stands */
  function rpToggle(clips) {
    if (!REELPLAY) return;
    if (!REELPLAY.started) { startReel(clips); return; }
    if (REELPLAY.active) {
      REELPLAY.active = false; REELPLAY.userPaused = true;
      // a pause pressed while the tape is still loading: the autoplay that
      // lands later is held silent, and the reader's ▶ lets it go
      if (!YT.ready) YT.hold = true;
      ytSend("cmd", "pauseVideo", []); reelShow(); return;
    }
    if (REELPLAY.done) { rpJump(clips, clips.findIndex(c => c.video_id)); return; }
    pvPause(); YT.hold = false;   // one engine seeks (specs/23 B2): a resume is the page's play
    REELPLAY.userPaused = false; REELPLAY.paused = false; REELPLAY.active = true;
    ytSend("cmd", "playVideo", []); reelShow();
  }
  function rpStep(clips, d) {
    if (!REELPLAY) return;
    let i = (REELPLAY.started ? REELPLAY.i : -1) + d;
    while (i >= 0 && i < clips.length && !clips[i].video_id) i += d;
    if (i < 0 || i >= clips.length) return;
    rpJump(clips, i);
  }
  function rpJump(clips, i) {
    const c = clips[i]; if (!c || !c.video_id) return;
    if (!REELPLAY.started) { REELPLAY.startAt = i; startReel(clips); return; }
    pvPause();
    REELPLAY.done = false; REELPLAY.paused = false; REELPLAY.userPaused = false;
    REELPLAY.active = true; REELPLAY.i = i; REELPLAY.armed = false;
    reelSeek(c); reelShow();
  }
  /* the fill: how far into the reel the tape stands — the clips before
     this one, whole, plus the way into this one */
  function rpPaint(t) {
    if (!REELPLAY || !REELPLAY.started) return;
    const clips = REELPLAY.clips, i = REELPLAY.i, c = clips[i];
    const segs = $$(".rp-seg");
    let before = 0;
    segs.forEach((s, j) => {
      s.classList.toggle("done", j < i || (REELPLAY.done && j <= i));
      s.classList.toggle("on", j === i && !REELPLAY.done);
      const fill = $("i", s);
      if (fill) fill.style.width = j === i && !REELPLAY.done && c
        ? `${Math.round(100 * Math.max(0, Math.min(1, (t - c.start) / Math.max(0.1, clipLen(c)))))}%` : "0";
      if (j < i) before += clipLen(clips[j]);
    });
    const count = $("#rpcount");
    if (count && c) {
      const into = REELPLAY.done ? reelRuntime(clips) : before + Math.max(0, Math.min(clipLen(c), t - c.start));
      count.textContent = `clip ${i + 1} of ${clips.length} · ${hms(into)} / ${hms(reelRuntime(clips))}`;
    }
  }
  function rpState() {
    if (!REELPLAY) return;
    const play = $("[data-rp=toggle]"), prev = $("[data-rp=prev]"), next = $("[data-rp=next]");
    const playing = REELPLAY.active && !REELPLAY.paused;
    if (play) {
      play.textContent = playing ? "❚❚ pause" : REELPLAY.done ? "↺ replay" : REELPLAY.started ? "▶ go on" : "▶ play";
      play.setAttribute("aria-label", playing ? "pause the reel" : REELPLAY.done ? "play the reel again" : REELPLAY.started ? "go on with the reel" : "play the reel");
    }
    const clips = REELPLAY.clips, i = REELPLAY.started ? REELPLAY.i : -1;
    if (prev) prev.disabled = !clips.slice(0, Math.max(0, i)).some(c => c.video_id);
    if (next) next.disabled = !clips.slice(i + 1).some(c => c.video_id);
    rpPaint(typeof YT !== "undefined" && YT.time != null ? YT.time : (clips[Math.max(0, i)] || {}).start || 0);
  }
  /* the end card's share row — the link is the reel; the share sheet is the
     reader's own device's, when it has one; nothing else is called */
  function rpShare() {
    const url = location.href;
    if (navigator.share) {
      navigator.share({ title: document.title, url }).catch(() => { /* the reader closed the sheet */ });
      return;
    }
    copyText(url, "reel link copied — send it anywhere");
  }
  function startReel(clips) {
    pvPause();   // one engine seeks (specs/23 B2)
    REELPLAY.paused = false; REELPLAY.userPaused = false; REELPLAY.done = false;
    // begin at the first clip that has a tape — a reel that opens on an
    // audio-only meeting still plays its later, playable clips
    let i = REELPLAY.startAt || 0; REELPLAY.startAt = 0;   // a segment pressed before play starts there
    while (i < clips.length && !clips[i].video_id) i++;
    if (i >= clips.length) return;
    REELPLAY.i = i; REELPLAY.active = true; REELPLAY.armed = false; REELPLAY.started = true;
    REELPLAY.vid = clips[i].video_id;
    const f = $(".player.facade");
    // the clip's own tape — a segment pressed before play on a reel across
    // meetings starts its meeting, not the facade's (a re-review catch)
    if (f) loadTape(clips[i].video_id, clips[i].start); else ytSeek(clips[i].start);
    reelShow();
  }
  /* seek within the current tape, or — when the clip is from another meeting —
     load THAT meeting's tape at the clip start. Never fall back to the tape
     already loaded: a clip must play its own meeting's footage or none. */
  function reelSeek(c) {
    const vid = c.video_id;
    if (!vid) return;                          // a tape-less clip is read, not played
    // the tape a stashed switch will load (another meeting's cite, pressed in
    // the load gap): a later press on that same meeting moves the switch's
    // start — it is not a seek of the tape the switch abandons
    if (REELPLAY.pending && REELPLAY.pending.vid === vid) {
      REELPLAY.pending.start = c.start;
      if (typeof YT !== "undefined") YT.hold = false;   // the reader asked the page for a tape
      return;
    }
    if (vid === REELPLAY.vid) { ytSeek(c.start); return; }
    // a cross-meeting clip: load its tape. The swapped-out video keeps posting
    // stale times for a beat — they belong to another timeline and could arm or
    // skip the new clip — so settle briefly, then let the armed gate re-arm.
    REELPLAY.vid = vid;
    // the reader asked the page for a tape: it is no longer held silent
    if (typeof YT !== "undefined") YT.hold = false;
    if (typeof YT !== "undefined" && YT.win && YT.ready) {
      REELPLAY.settling = true; YT.vid = vid;
      if (typeof setTimeout === "function")
        setTimeout(() => { if (REELPLAY) REELPLAY.settling = false; }, 500);
      ytSend("cmd", "loadVideoById", [{ videoId: vid, startSeconds: c.start }]);
      // a load in flight is not a seen silence, and its first report is the
      // new tape's: forget the old tape's resting state and time, or a pause
      // sent in the gap trusts a state the frame is leaving (a review catch)
      YT.state = -1; YT.time = c.start;
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
    if (!REELPLAY || REELPLAY.settling) return;
    if (REELPLAY.started) rpPaint(t);
    if (!REELPLAY.active) return;
    const c = REELPLAY.clips[REELPLAY.i]; if (!c) return;
    if (!REELPLAY.armed) {
      // arm only on a report that lands inside the clip and BEFORE its end
      // threshold — so a stale time at/after the end (two of which can arrive
      // while a backward seek buffers) can neither arm nor, on the next tick,
      // skip a short clip entirely
      if (t >= c.start - 0.75 && t < c.end - 0.12) REELPLAY.armed = true;
      return;
    }
    if (t >= c.end - 0.12) reelNext();
  }
  /* on to the next clip that actually has a tape (a cite-only clip is read,
     not played) — or the reel is complete */
  function reelNext() {
    REELPLAY.armed = false;
    let n = REELPLAY.i + 1;
    while (n < REELPLAY.clips.length && !REELPLAY.clips[n].video_id) n++;
    if (n < REELPLAY.clips.length) {
      REELPLAY.i = n; reelSeek(REELPLAY.clips[n]); reelShow();
    } else {
      REELPLAY.active = false; REELPLAY.done = true; ytSend("cmd", "pauseVideo", []); reelShow(true);
    }
  }
  function reelShow(done) {
    if (!REELPLAY) return;
    const now = REELPLAY.now, c = REELPLAY.clips[REELPLAY.i];
    // when the reel spans meetings, name each clip's meeting as it plays
    const from = (c && c.mtitle && reelPids(REELPLAY.clips).length > 1)
      ? ` <span class="rn-from">${esc(c.mtitle)}</span>` : "";
    const done_ = done || REELPLAY.done;
    if (now) {
      now.hidden = false;
      now.innerHTML = REELPLAY.paused && c
        ? `<b>paused for the preview</b> — tap a clip below to go on from it`
        : (done_ || !c)
        ? `<b>reel complete</b> — ${REELPLAY.clips.length} clip${REELPLAY.clips.length > 1 ? "s" : ""} played`
          + `<span class="rp-end"><button type="button" class="btn" data-rpend="replay">↺ play it again</button>`
          + `<button type="button" class="btn" data-rpend="share">⧉ share the reel</button>`
          + `<button type="button" class="btn primary" data-rpend="mine">✂ make this reel yours</button></span>`
        : (REELPLAY.userPaused ? `<b>paused</b> — ` : "")
          + `<span class="rn-ord">clip ${REELPLAY.i + 1} of ${REELPLAY.clips.length}</span>`
          + `<span class="ts">${hms(c.start)}</span> `
          + `<span class="rn-quote">${esc(c.quote || c.kind || "")}</span>${from}`
          + (c.date || c.body ? ` <span class="rn-from">${esc([c.body, c.date].filter(Boolean).join(", "))}</span>` : "");
      $$("[data-rpend]", now).forEach(b => b.onclick = () => {
        if (b.dataset.rpend === "replay") rpJump(REELPLAY.clips, REELPLAY.clips.findIndex(c => c.video_id));
        else if (b.dataset.rpend === "share") rpShare();
        else { const m = $("[data-rv=mine]"); if (m) m.click(); }
      });
    }
    $$(".reelcite").forEach((a, i) =>
      a.classList.toggle("on", REELPLAY.started && !done_ && i === REELPLAY.i));
    rpState();
  }
  function reelMessage(el, html) {
    if (el) el.innerHTML = `<p class="hint">${html}</p>`;
    const stage = $("#reelstage"); if (stage) stage.innerHTML = "";
  }

  /* ================= YOUR PAPER — the curated document (specs/21 P1) =========
     The record's front page is the record's judgement; a paper is an
     editor's. It is a document of blocks — stories (a meeting, an issue) and
     reels — plus a title, and it lives the way a reel lives: in this browser
     (the draft), in its link (the whole paper, URL-encoded), and in a file
     (`paper.json`, the desk-openable receipt). A short link is the one
     optional extra: a content-addressed store serves the same bytes back
     read-only, and losing that server loses nothing but the shortness.

     PART 1 — the model and the codec. Server-free by construction, and a
     test holds it so: everything between here and the SHARING marker below
     reads and writes localStorage, strings, and nothing else. decodeReel's
     law governs every decoder: malformed input degrades to fewer blocks,
     never a throw. */

  const PAPER_V = "1";
  // every link version THIS reader can render — one entry per grammar
  // paperV can mint (a twin test holds the two lists equal: v=4 shipped in
  // specs/24 without joining this list, and every v=4 link the press
  // pressed read as "shared from a newer version" until specs/29 P1)
  const PAPER_VS = ["1", "2", "3", "4", "5"];
  /* the layouts a block may ask for (specs/23 C1) — an enum, never data:
       lead — the block is the paper's lead: full width, the large treatment
       head — the block stands as a section head: its name, over a rule
       half — half width; two halves in a row sit side by side
     A block with no layout reads exactly as it always did. */
  const PAPER_LAYOUTS = ["lead", "head", "half"];
  const LAYOUT_LABEL = { lead: "lead story", head: "section head", half: "half width" };
  /* the C2 kinds (specs/23 C2) — refs only, every one:
       quote  — a transcript line by (pid, t); its words are read off the
                pressed tape at render, never stored
       doc    — one of a meeting's own filings (agenda, minutes…) by its id
       digest — "what changed": an issue and a window of its latest
                appearances, computed at render from its timeline */
  const C2_KINDS = ["quote", "doc", "digest"];
  /* the broadsheet's blocks (specs/29 P1) — enums and refs like every kind
     before them, computed at render from the record's own planes:
       lead    — one meeting told large: {kind, pid}
       week    — the record's latest week of meetings as cards
       threads — the widest threads as small multiples
       strip   — how they talked: a lens bar per meeting, in date order
       names   — who and where (or ONE name: who = its slug)
       search  — a search box over the page's own meetings
     week / threads / strip / names may name a municipality (town = the slug
     the press mints from towns.json); names may name a who instead. In the
     link: l.<pid> · w. k. h. p. (bare, t:<town>, and for names w:<who>) · s. */
  const BS_KINDS = ["lead", "week", "threads", "strip", "names", "search"];
  const BS_SCOPED = ["week", "threads", "strip", "names"];
  const BS_PART = { week: "w", threads: "k", strip: "h", names: "p" };
  const BS_KIND_OF = { w: "week", k: "threads", h: "strip", p: "names" };
  /* a slug the way the press mints one (web/bake.py nslug): lower-case
     ascii runs joined by "-" — a municipality's; a name's sits behind its
     kind's letter (p- people · l- places · o- organizations), web/bake.py
     who_slug. A node twin holds both equal. */
  const bsSlug = s => (String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "none").slice(0, 96);
  const bsWho = (kind, name) => `${kind === "places" ? "l" : kind === "organizations" ? "o" : "p"}-${bsSlug(name)}`;
  // the exact shapes a town and a who may take — what the press mints, and
  // nothing looser (record/papers.py holds the same two)
  const BS_TOWN_REF = /^[a-z0-9-]{1,96}$/, BS_WHO_REF = /^[plo]-[a-z0-9-]{1,96}$/;
  const DOC_REF = /^[\w:.-]{1,160}$/;     // a document id, e.g. doc:budget
  const DIGEST_MAX = 12;
  /* which link version a paper needs: v=1 is the shipped P1 grammar
     (stories + reels) and stays byte-identical for those papers forever;
     v=2 marks a paper carrying kinds a v1 reader cannot represent (notes,
     charts) — the shipped reader then shows its honest "shared from a newer
     version" message instead of silently rendering a mutilated paper. */
  // v=3 is the rich tier whole — layouts (C1) and the three ref kinds (C2)
  // shipped in ONE edition (v2.1.14), so no reader ever holds a decoder that
  // knows one grammar and not the other; a fourth grammar mints v=4
  // v=4: the two paths' kinds (specs/24) — a numbers / shape / ledger chart,
  // one meeting's votes, the record's reading; inlined so the twin that
  // lifts this line alone still runs
  // v=5: the broadsheet's blocks (specs/29 P1) — inlined for the same reason
  const paperV = p => p.blocks.some(b => ["lead", "week", "threads", "strip", "names", "search"].includes(b.kind)) ? "5"
    : p.blocks.some(b => b.kind === "reading" || (b.kind === "chart"
      && (b.chart === "numbers" || b.chart === "shape" || b.chart === "ledger" || (b.chart === "votes" && !!b.pid)))) ? "4"
    : p.blocks.some(b => b.layout || C2_KINDS.includes(b.kind)) ? "3"
    : p.blocks.some(b => b.kind === "note" || b.kind === "chart") ? "2" : "1";
  /* does anything actually TRAVEL — a title, or a block that survives
     portablePaper (an empty note does not). The share row, the title
     handler and the note handler all read THIS one truth, so typing across
     the empty↔live boundary repaints the row that depends on it (the fix
     re-review's catch: a gate whose truth can change under a keystroke
     needs a repaint on exactly that boundary). */
  // an untitled paper reads as "Untitled paper" — on the reader's page, in
  // the editor's print twin, everywhere the title is painted (a re-review
  // catch: the twin trimmed and the page did not)
  const printTitle = t => String(t || "").trim() || "Untitled paper";
  const paperHasLive = d => !!(d.title
    || d.blocks.some(b => b.kind !== "note" || b.text.trim()));
  const PAPER_KEY = "cz-paper";        // the one draft this browser kept (P1–P3) — read once, migrated, retired
  const PAPERS_KEY = "cz-papers";      // the shelf: every paper this browser keeps, and which one is open (C1)
  const PAPERS_MAX = 24;               // papers on one shelf — a browser's worth, not a library's
  let PAPERS_BLANK = null;             // a fresh reader's unsaved shelf: one id for the page's life
  const PAPER_ID = /^[a-z0-9]{4,12}$/;  // a paper's own id on the shelf — local, never travels
  const PAPER_TITLE_MAX = 200;
  const PAPER_MAX_BLOCKS = 64;
  const PAPER_MAX_CLIPS = 100;         // per reel block — matches the store's cap
  // a pid or an issue slug, and nothing else. The bake mints pids to 80 chars
  // and issue slugs to 96 (web/bake.py pid()/islug()) — the cap leaves
  // headroom and matches the store's exactly.
  const PAPER_REF = /^[\w-]{1,128}$/;
  const PAPER_NOTE_MAX = 2000;         // matches the store's cap (record/papers.py)
  /* the chart kinds a paper can carry (specs/21 P2) — an enum and a ref,
     never data: the reader's browser computes every picture from the
     record's own pressed planes, so a paper cannot assert a number the
     record would not draw.
       votes   — the record's roll calls over time      (votes.json)
       reach   — one issue's appearances, meeting by meeting (issues/<slug>)
       framing — the eight civic lenses: one meeting (pid) or the whole record
       topics  — what keeps coming back                 (analytics.json) */
  const PAPER_CHARTS = ["votes", "reach", "framing", "topics", "numbers", "shape", "ledger"];
  /* specs/24 — the two paths' kinds. A link carrying one is v=4; a reader
     from before them drops what it does not know (fewer blocks, never a
     throw), so an old reader reads a v4 paper with holes and says nothing
     false. numbers: a meeting's or an issue's; shape: a meeting's moments on
     its own time axis; ledger: an issue's roll calls across meetings; votes
     with a pid: one meeting's roll calls; reading: the record's own reading
     of a meeting or an issue — decisions, questions, names, milestones —
     computed at render, refs only, no model. */
  const NEW_KIND = b => b.kind === "reading" || (b.kind === "chart"
    && (["numbers", "shape", "ledger"].includes(b.chart) || (b.chart === "votes" && !!b.pid)));
  /* m:<pid> | i:<slug> → {pid} | {slug}, or null for anything else — the one
     ref form a numbers chart and a reading travel by, since either may name
     a meeting or an issue */
  const oneRef = s => {
    const m = /^([mi]):(.+)$/.exec(String(s || "")); if (!m || !PAPER_REF.test(m[2])) return null;
    return m[1] === "m" ? { pid: m[2] } : { slug: m[2] };
  };
  /* cut a string at a cap WITHOUT stranding half a surrogate pair — and
     drop any lone surrogate already inside it (a hand-edited draft can hold
     one; JSON round-trips it). encodeURIComponent THROWS on a lone half,
     and decodeReel's law forbids every encoder and decoder here from
     throwing. (The title's caps get this too — the P1 slice had the same
     latent crash.) */
  const cut = (s, n) => s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/([\uD800-\uDBFF])?([\uDC00-\uDFFF])/g, (m, hi) => hi ? m : "")
    .slice(0, n).replace(/[\uD800-\uDBFF]$/, "");
  /* a note's text, made safe to keep: newlines stay (a note has paragraphs),
     every other control character goes, the cap holds. The client is TOTAL —
     it cleans and keeps; the store is STRICT — it refuses (record/papers.py).
     That split is decodeReel's law meeting the store's, one function each. */
  const noteText = s => cut(String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ""), PAPER_NOTE_MAX);

  /* the shelf (specs/23 C1): {active, papers:[{id, title, blocks}]} — an
     ORDERED list, so the switcher paints in a stable order, and one pointer.
     Total over whatever is stored (a hand-edited value, a paper with no id):
     bad entries drop, an empty shelf grows one blank paper, a dangling
     pointer falls to the first. The single P1 draft (`cz-paper`) migrates
     in ONCE, the loadReel way — read, kept whole as the first paper, then
     its key removed so it can never resurrect over a later edit. */
  const paperId = () => (Date.now().toString(36).slice(-4)
    + Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/g, "0").slice(0, 8);
  function readPapers() {
    let sh = null;
    try { sh = JSON.parse(localStorage.getItem(PAPERS_KEY) || "null"); } catch { sh = null; }
    if (!sh || typeof sh !== "object" || !Array.isArray(sh.papers)) {
      let raw = null, old = null;
      try { raw = localStorage.getItem(PAPER_KEY); } catch { raw = null; }
      try { old = JSON.parse(raw || "null"); } catch { old = null; }
      // nothing stored at all: a blank shelf held in memory — a READ mints
      // and writes nothing for a reader who never makes anything; the first
      // real save writes the shelf, under this same id
      const first = { id: raw == null ? (PAPERS_BLANK ||= paperId()) : paperId(), ...normalizePaper(old) };
      sh = { active: first.id, papers: [first] };
      // the sweep: an old draft moves in once, and its key goes only once
      // the shelf holds it
      if (raw != null && writePapers(sh)) { try { localStorage.removeItem(PAPER_KEY); } catch { /* private mode */ } }
      return sh;
    }
    const seen = new Set();
    const papers = [];
    for (const p of sh.papers) {
      if (papers.length >= PAPERS_MAX) break;
      if (!p || typeof p !== "object" || typeof p.id !== "string"
          || !PAPER_ID.test(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      papers.push({ id: p.id, ...normalizePaper(p) });
    }
    if (!papers.length) papers.push({ id: paperId(), title: "", blocks: [] });
    const active = papers.some(p => p.id === sh.active) ? sh.active : papers[0].id;
    return { active, papers };
  }
  function writePapers(sh) {
    try { localStorage.setItem(PAPERS_KEY, JSON.stringify(sh)); return true; }
    catch { return false; }
  }
  /* the OPEN paper — what every panel, editor and render means by "the
     draft". Its shape is unchanged from P1: {title, blocks}. */
  function readPaper() {
    const sh = readPapers();
    const p = sh.papers.find(x => x.id === sh.active) || sh.papers[0];
    return { title: p.title, blocks: p.blocks, ...(p.tpl ? { tpl: p.tpl } : {}) };
  }
  /* returns whether the draft actually held — a browser that blocks storage
     gets told the truth by the callers, not a success toast over a void. Any
     change also retires the last short link: it names the OLD paper. */
  function savePaper(p) {
    PAPER_SHORT = "";
    const sh = readPapers();
    const np = normalizePaper(p);
    const i = sh.papers.findIndex(x => x.id === sh.active);
    if (i < 0) sh.papers.unshift({ id: sh.active, ...np });
    else sh.papers[i] = { id: sh.active, ...np };
    return writePapers(sh);
  }
  /* the shelf's own acts: a new paper opens blank and becomes the open one;
     switching changes the pointer and nothing else; deleting asks when
     there is anything to lose, and the shelf never stands empty. Every one
     retires the minted short link (it named the paper that was open) and
     repaints both surfaces. */
  function newPaper() {
    const sh = readPapers();
    if (sh.papers.length >= PAPERS_MAX) {
      toast(`this browser keeps ${PAPERS_MAX} papers — delete one to start another`); return; }
    const p = { id: paperId(), title: "", blocks: [] };
    sh.papers.push(p); sh.active = p.id;
    if (!writePapers(sh)) { toast("this browser blocks storage — a new paper can’t be kept here"); return; }
    retireShortOut(); refreshPaperSummary({ act: "title" }); renderPaperNow();
    toast("a new paper — name it, then add to it");
  }
  function switchPaper(id) {
    const sh = readPapers();
    if (!sh.papers.some(p => p.id === id) || sh.active === id) return;
    sh.active = id;
    if (!writePapers(sh)) { toast("this browser blocks storage — the switch didn’t hold"); return; }
    retireShortOut(); refreshPaperSummary({ act: "pshelf" }); renderPaperNow();
  }
  function deletePaper() {
    const seen = readPapers();
    const cur = seen.papers.find(p => p.id === seen.active); if (!cur) return;
    const id = cur.id;
    if ((cur.title || cur.blocks.length)
        && !window.confirm(`Delete ${cur.title ? `“${cur.title}”` : "this untitled paper"}? It lives only in this browser; a link or a paper.json you shared keeps reading.`)) return;
    // the confirm blocked; another tab may have written meanwhile — delete
    // the paper the reader named from the shelf as it stands NOW
    const sh = readPapers();
    if (!sh.papers.some(p => p.id === id)) { toast("that paper was already deleted in another tab"); refreshPaperSummary({ act: "pshelf" }); renderPaperNow(); return; }
    sh.papers = sh.papers.filter(p => p.id !== id);
    if (!sh.papers.length) sh.papers.push({ id: paperId(), title: "", blocks: [] });
    if (!sh.papers.some(p => p.id === sh.active)) sh.active = sh.papers[0].id;
    if (!writePapers(sh)) { toast("this browser blocks storage — the delete didn’t hold"); return; }
    retireShortOut(); refreshPaperSummary({ act: "pshelf" }); renderPaperNow();
    toast("paper deleted — the record is untouched");
  }

  /* total: whatever arrives — a draft, a decoded link, a stored paper, a
     hand-edited file — leaves as a valid paper. Unknown kinds, broken refs
     and impossible clips drop silently; nothing throws. */
  function normalizePaper(p) {
    const out = { title: "", blocks: [] };
    if (!p || typeof p !== "object") return out;
    if (typeof p.title === "string") out.title = cut(p.title, PAPER_TITLE_MAX);
    // which template shaped the draft (specs/29 P1) — a local ride-along the
    // writing desk reads for its three questions; no traveling form carries it
    if (typeof p.tpl === "string" && /^[a-z]{3,12}$/.test(p.tpl)) out.tpl = p.tpl;
    for (const b of (Array.isArray(p.blocks) ? p.blocks : [])) {
      if (out.blocks.length >= PAPER_MAX_BLOCKS) break;
      const nb = normalizeBlock(b);
      if (nb) out.blocks.push(nb);
    }
    return out;
  }
  function normalizeBlock(b) {
    const nb = normalizeKind(b);
    if (nb && PAPER_LAYOUTS.includes(b.layout)) nb.layout = b.layout;
    return nb;
  }
  function normalizeKind(b) {
    if (!b || typeof b !== "object") return null;
    if (b.kind === "story" && b.story === "meeting" && PAPER_REF.test(b.pid || "")) {
      const nb = { kind: "story", story: "meeting", pid: b.pid };
      for (const k of ["title", "date", "body", "town", "thumb"])
        if (typeof b[k] === "string") nb[k] = b[k];
      return nb;
    }
    if (b.kind === "story" && b.story === "issue" && PAPER_REF.test(b.slug || "")) {
      const nb = { kind: "story", story: "issue", slug: b.slug };
      for (const k of ["name", "first_seen", "last_seen"])
        if (typeof b[k] === "string") nb[k] = b[k];
      if (isFinite(b.n_meetings)) nb.n_meetings = +b.n_meetings;
      return nb;
    }
    if (b.kind === "reel" && Array.isArray(b.clips)) {
      const clips = b.clips
        .filter(c => c && PAPER_REF.test(c.pid || "") && isFinite(c.start)
          && c.start >= 0 && isFinite(c.end) && c.end > c.start)
        .slice(0, PAPER_MAX_CLIPS)
        .map(c => ({ ...c, start: r1(c.start), end: r1(c.end) }));
      return clips.length ? { kind: "reel", clips } : null;
    }
    if (b.kind === "note" && typeof b.text === "string") {
      // an empty note survives in the DRAFT — it is a block being typed
      // into; no traveling form carries one (portablePaper drops it, the
      // store refuses it)
      return { kind: "note", text: noteText(b.text) };
    }
    if (b.kind === "chart" && b.chart === "reach"
        && typeof b.slug === "string" && PAPER_REF.test(b.slug)) {
      const nb = { kind: "chart", chart: "reach", slug: b.slug };
      if (typeof b.name === "string") nb.name = b.name;   // ride-along label
      return nb;
    }
    if (b.kind === "chart" && b.chart === "framing" && b.pid != null) {
      if (typeof b.pid !== "string" || !PAPER_REF.test(b.pid)) return null;
      const nb = { kind: "chart", chart: "framing", pid: b.pid };
      if (typeof b.title === "string") nb.title = b.title;
      return nb;
    }
    // specs/24: numbers (a meeting or an issue, exactly one), shape (a
    // meeting), ledger (an issue), votes of one meeting, and the reading
    if (b.kind === "chart" && b.chart === "numbers") {
      if (typeof b.pid === "string" && PAPER_REF.test(b.pid) && b.slug == null) {
        const nb = { kind: "chart", chart: "numbers", pid: b.pid };
        if (typeof b.title === "string") nb.title = b.title; return nb; }
      if (typeof b.slug === "string" && PAPER_REF.test(b.slug) && b.pid == null) {
        const nb = { kind: "chart", chart: "numbers", slug: b.slug };
        if (typeof b.name === "string") nb.name = b.name; return nb; }
      return null;
    }
    if (b.kind === "chart" && (b.chart === "shape" || (b.chart === "votes" && b.pid != null))) {
      if (typeof b.pid !== "string" || !PAPER_REF.test(b.pid)) return null;
      const nb = { kind: "chart", chart: b.chart, pid: b.pid };
      if (typeof b.title === "string") nb.title = b.title; return nb;
    }
    if (b.kind === "chart" && b.chart === "ledger") {
      if (typeof b.slug !== "string" || !PAPER_REF.test(b.slug)) return null;
      const nb = { kind: "chart", chart: "ledger", slug: b.slug };
      if (typeof b.name === "string") nb.name = b.name; return nb;
    }
    if (b.kind === "reading") {
      if (typeof b.pid === "string" && PAPER_REF.test(b.pid) && b.slug == null) {
        const nb = { kind: "reading", pid: b.pid };
        if (typeof b.title === "string") nb.title = b.title; return nb; }
      if (typeof b.slug === "string" && PAPER_REF.test(b.slug) && b.pid == null) {
        const nb = { kind: "reading", slug: b.slug };
        if (typeof b.name === "string") nb.name = b.name; return nb; }
      return null;
    }
    if (b.kind === "chart" && (b.chart === "votes" || b.chart === "topics"
        || b.chart === "framing"))
      return { kind: "chart", chart: b.chart };
    if (b.kind === "quote" && PAPER_REF.test(b.pid || "") && isFinite(b.t) && b.t >= 0) {
      const nb = { kind: "quote", pid: b.pid, t: r1(b.t) };
      // the words and the meeting's name ride the DRAFT only, for the panel
      for (const k of ["text", "title", "spk"]) if (typeof b[k] === "string") nb[k] = b[k];
      return nb;
    }
    if (b.kind === "doc" && PAPER_REF.test(b.pid || "") && DOC_REF.test(b.doc || "")) {
      const nb = { kind: "doc", pid: b.pid, doc: b.doc };
      for (const k of ["title", "dkind"]) if (typeof b[k] === "string") nb[k] = b[k];
      return nb;
    }
    if (b.kind === "digest" && PAPER_REF.test(b.slug || "")) {
      const n = Math.max(1, Math.min(DIGEST_MAX, Math.floor(+b.n) || 3));
      const nb = { kind: "digest", slug: b.slug, n };
      if (typeof b.name === "string") nb.name = b.name;
      return nb;
    }
    // specs/29: the broadsheet's blocks — a lead names a meeting; the four
    // scoped kinds may name a municipality (a slug), names may name a who
    // instead (who wins when a hand-edited draft carries both); a search box
    // names nothing. Labels ride the DRAFT only, as every kind's do.
    if (b.kind === "lead" && PAPER_REF.test(b.pid || "")) {
      const nb = { kind: "lead", pid: b.pid };
      for (const k of ["title", "date", "town"]) if (typeof b[k] === "string") nb[k] = b[k];
      return nb;
    }
    if (b.kind === "search") return { kind: "search" };
    if (BS_SCOPED.includes(b.kind)) {
      // a scope that is present but malformed drops the block, as the link
      // does — a block that said "Boston" must never widen to every town
      // under the same headline (a review catch; decodeReel's law is fewer
      // blocks, not broader ones)
      const has = k => b[k] != null && b[k] !== "";
      if (has("who") && !(b.kind === "names" && typeof b.who === "string" && BS_WHO_REF.test(b.who))) return null;
      if (has("town") && !(typeof b.town === "string" && BS_TOWN_REF.test(b.town))) return null;
      const nb = { kind: b.kind };
      if (has("who")) nb.who = b.who;
      else if (has("town")) nb.town = b.town;
      if (typeof b.name === "string") nb.name = b.name;
      return nb;
    }
    return null;
  }

  /* the traveling form: refs only. The draft carries ride-along display meta
     (titles, quotes) so the panel paints without a fetch; the link, the store
     and the export's block list carry none of it — a reader's page enriches
     from the record's own planes, so a paper can never assert a title the
     record would not. */
  const withLayout = (t, b) => (b.layout ? { ...t, layout: b.layout } : t);
  function portablePaper(p) {
    p = normalizePaper(p);
    return {
      schema: "publicrecord.paper/1",
      title: p.title,
      // an empty note is a draft-in-progress; no traveling form carries one
      blocks: p.blocks.filter(b => b.kind !== "note" || b.text.trim())
        .map(b => withLayout(b.kind === "reel"
        ? { kind: "reel",
            clips: b.clips.map(c => ({ pid: c.pid, start: r1(c.start), end: r1(c.end) })) }
        : b.kind === "quote" ? { kind: "quote", pid: b.pid, t: r1(b.t) }
        : b.kind === "doc" ? { kind: "doc", pid: b.pid, doc: b.doc }
        : b.kind === "digest" ? { kind: "digest", slug: b.slug, n: b.n }
        : b.kind === "lead" ? { kind: "lead", pid: b.pid }
        : b.kind === "search" ? { kind: "search" }
        : BS_SCOPED.includes(b.kind)
          ? (b.who ? { kind: b.kind, who: b.who } : b.town ? { kind: b.kind, town: b.town } : { kind: b.kind })
        : b.kind === "note"
          ? { kind: "note", text: b.text }
        : b.kind === "chart"
          ? (b.slug ? { kind: "chart", chart: b.chart, slug: b.slug }
            : b.pid ? { kind: "chart", chart: b.chart, pid: b.pid }
            : { kind: "chart", chart: b.chart })
        : b.kind === "reading"
          ? (b.pid ? { kind: "reading", pid: b.pid } : { kind: "reading", slug: b.slug })
        : b.story === "issue"
          ? { kind: "story", story: "issue", slug: b.slug }
          : { kind: "story", story: "meeting", pid: b.pid }, b)),
    };
  }

  /* the link form: /app/p?v=1&t=<title>&b=<blocks>. Blocks join on ",";
     a block is m.<pid> | i.<slug> | r.<clip>~<clip>… with clip <pid>:<s>-<e>,
     c.<chart>[.<ref>] for a chart, n.<text> for a note.
     "~" is RFC-3986-unreserved and appears in no pid, slug or time, so the
     three separator levels never collide ("+" would decode as a space).
     A note's text is encoded TWICE on purpose: decodePaper's URLSearchParams
     decodes the whole b= value once BEFORE the "," split, and a note's own
     commas (and %) must still be opaque at that moment. Refs never need the
     second coat (their charset has nothing to decode); free text does. */
  function encodePaperQS(p) {
    p = portablePaper(p);
    const parts = p.blocks.map(b =>
      b.kind === "reel"
        ? "r." + b.clips.map(c =>
            `${encodeURIComponent(c.pid)}:${r1(c.start)}-${r1(c.end)}`).join("~")
      : b.kind === "note"
        ? "n." + encodeURIComponent(encodeURIComponent(b.text))
      // C2: q.<pid>:<t> · d.<pid>~<doc id> (a doc id may hold ":") · g.<slug>:<n>
      : b.kind === "quote" ? `q.${encodeURIComponent(b.pid)}:${r1(b.t)}`
      : b.kind === "doc" ? `d.${encodeURIComponent(b.pid)}~${encodeURIComponent(b.doc)}`
      : b.kind === "digest" ? `g.${encodeURIComponent(b.slug)}:${b.n}`
      // specs/29: l.<pid> the lead; w k h p the week, threads, strip and
      // names — bare (dotless: a link that ends in "." loses its last block
      // to every linkifier that trims the period — a review catch), or with
      // t:<town> / (names) w:<who> after the dot; s the search box.
      : b.kind === "lead" ? `l.${encodeURIComponent(b.pid)}`
      : b.kind === "search" ? "s"
      : BS_SCOPED.includes(b.kind)
        ? BS_PART[b.kind] + (b.who ? "." + encodeURIComponent("w:" + b.who) : b.town ? "." + encodeURIComponent("t:" + b.town) : "")
      // specs/24: a numbers chart and a reading name a meeting OR an issue —
      // the ref says which (m:<pid> | i:<slug>; encodeURIComponent spells the
      // colon %3A, and no pid or slug holds one). a.<ref> is the reading.
      : b.kind === "chart" && b.chart === "numbers"
        ? "c.numbers." + encodeURIComponent(b.pid ? "m:" + b.pid : "i:" + b.slug)
      : b.kind === "chart"
        ? "c." + b.chart + (b.slug || b.pid
            ? "." + encodeURIComponent(b.slug || b.pid) : "")
      : b.kind === "reading"
        ? "a." + encodeURIComponent(b.pid ? "m:" + b.pid : "i:" + b.slug)
      : b.story === "issue" ? "i." + encodeURIComponent(b.slug)
      : "m." + encodeURIComponent(b.pid));
    // layouts ride a separate `l=` (C1): <block index>:<layout> pairs, so a
    // v1/v2 link's `b=` never changes shape; a paper carrying one is v=3
    const lays = p.blocks.map((b, i) => b.layout ? `${i}:${b.layout}` : "").filter(Boolean);
    return `v=${paperV(p)}`
      + (p.title ? `&t=${encodeURIComponent(p.title)}` : "")
      + (parts.length ? `&b=${parts.join(",")}` : "")
      + (lays.length ? `&l=${lays.join(",")}` : "");
  }
  function paperShareURL(p) {
    return `${location.origin}${BASE}/p?${encodePaperQS(p)}`;
  }

  /* decode /app/p's query into {v, id, title, blocks}. Pure and total — a
     link that lost a character in an email reads as fewer blocks, never a
     crash. `p=` names a stored paper by content address; everything else is
     the paper itself, carried whole. */
  function decodePaper(search) {
    const q = new URLSearchParams(search || "");
    const id = (q.get("p") || "").trim();
    const out = { v: q.get("v") || "",
                  id: /^[0-9a-f]{16}$/.test(id) ? id : "",
                  title: cut(q.get("t") || "", PAPER_TITLE_MAX),
                  blocks: [] };
    const at = [];   // each decoded block's index among the link's parts
    const parts = (q.get("b") || "").split(",");
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (out.blocks.length >= PAPER_MAX_BLOCKS) break;
      const before = out.blocks.length;
      const dot = part.indexOf(".");
      // a dotless part is a bare broadsheet block (w k h p s) or nothing;
      // the dotted spelling of the same (w. s.) reads as well — and either
      // way the part is indexed below, so an l= pair keeps its block (a
      // skeptic's catch: a `continue` here moved a layout onto the week)
      if (dot < 1) { if (/^[wkhps]$/.test(part)) decodePart(part, "", out); }
      else decodePart(part.slice(0, dot), part.slice(dot + 1), out);
      if (out.blocks.length > before) at.push(pi);
    }
    // layouts (C1): a pair that names no decoded block, or an unknown
    // layout, is simply not applied — a mangled l= costs a layout, never
    // a throw (decodeReel's law)
    for (const pair of (q.get("l") || "").split(",")) {
      const m = /^(\d{1,3}):([a-z]+)$/.exec(pair.trim()); if (!m) continue;
      const bi = at.indexOf(+m[1]);
      if (bi >= 0 && PAPER_LAYOUTS.includes(m[2])) out.blocks[bi].layout = m[2];
    }
    return out;
  }
  /* one part of a link's b=, decoded into out.blocks (or not) */
  function decodePart(kind, rest, out) {
    {
      if (kind === "m" || kind === "i") {
        let ref = "";
        try { ref = decodeURIComponent(rest).trim(); } catch { return; }
        if (!PAPER_REF.test(ref)) return;
        out.blocks.push(kind === "m"
          ? { kind: "story", story: "meeting", pid: ref }
          : { kind: "story", story: "issue", slug: ref });
      } else if (kind === "r") {
        const clips = [];
        for (const cs of rest.split("~")) {
          if (clips.length >= PAPER_MAX_CLIPS) break;
          const colon = cs.indexOf(":");
          if (colon < 1) continue;
          let pid = "";
          try { pid = decodeURIComponent(cs.slice(0, colon)).trim(); }
          catch { continue; }
          const seg = cs.slice(colon + 1).split("-");
          if (!PAPER_REF.test(pid) || seg.length !== 2) continue;
          const start = parseFloat(seg[0]), end = parseFloat(seg[1]);
          if (!isFinite(start) || start < 0 || !isFinite(end) || end <= start) continue;
          clips.push({ pid, start: r1(start), end: r1(end) });
        }
        if (clips.length) out.blocks.push({ kind: "reel", clips });
      } else if (kind === "n") {
        // the second decode of the note's double coat (the first was
        // URLSearchParams's, above); a bad escape drops the block, never throws
        let text = "";
        try { text = noteText(decodeURIComponent(rest)); } catch { return; }
        if (text.trim()) out.blocks.push({ kind: "note", text });
      } else if (kind === "q") {
        const colon = rest.lastIndexOf(":"); if (colon < 1) return;
        let pid = "";
        try { pid = decodeURIComponent(rest.slice(0, colon)).trim(); } catch { return; }
        const t = parseFloat(rest.slice(colon + 1));
        if (!PAPER_REF.test(pid) || !isFinite(t) || t < 0) return;
        out.blocks.push({ kind: "quote", pid, t: r1(t) });
      } else if (kind === "d") {
        const tilde = rest.indexOf("~"); if (tilde < 1) return;
        let pid = "", doc = "";
        try { pid = decodeURIComponent(rest.slice(0, tilde)).trim();
              doc = decodeURIComponent(rest.slice(tilde + 1)).trim(); } catch { return; }
        if (!PAPER_REF.test(pid) || !DOC_REF.test(doc)) return;
        out.blocks.push({ kind: "doc", pid, doc });
      } else if (kind === "g") {
        const colon = rest.lastIndexOf(":"); if (colon < 1) return;
        let slug = "";
        try { slug = decodeURIComponent(rest.slice(0, colon)).trim(); } catch { return; }
        const n = parseInt(rest.slice(colon + 1), 10);
        if (!PAPER_REF.test(slug) || !(n >= 1 && n <= DIGEST_MAX)) return;
        out.blocks.push({ kind: "digest", slug, n });
      } else if (kind === "c") {
        const dot2 = rest.indexOf(".");
        const chart = dot2 < 0 ? rest : rest.slice(0, dot2);
        if (!PAPER_CHARTS.includes(chart)) return;
        if (dot2 < 0) {
          // bare forms: votes, topics, framing (the whole record) — reach,
          // numbers, shape and ledger need their ref, so a bare one is a
          // mangle, not a chart
          if (!["reach", "numbers", "shape", "ledger"].includes(chart))
            out.blocks.push({ kind: "chart", chart });
        } else {
          let ref = "";
          try { ref = decodeURIComponent(rest.slice(dot2 + 1)).trim(); }
          catch { return; }
          if (chart === "numbers") {
            // m:<pid> | i:<slug> — the one ref form that says which
            const one = /^([mi]):(.+)$/.exec(ref);
            if (one && PAPER_REF.test(one[2]))
              out.blocks.push(one[1] === "m" ? { kind: "chart", chart: "numbers", pid: one[2] }
                                             : { kind: "chart", chart: "numbers", slug: one[2] });
            return;
          }
          if (!PAPER_REF.test(ref)) return;
          if (chart === "reach")
            out.blocks.push({ kind: "chart", chart: "reach", slug: ref });
          else if (chart === "ledger")
            out.blocks.push({ kind: "chart", chart: "ledger", slug: ref });
          else if (chart === "framing" || chart === "shape" || chart === "votes")
            out.blocks.push({ kind: "chart", chart, pid: ref });
          // topics carries no ref — a reffed one is a mangle, dropped
        }
      } else if (kind === "l") {
        let ref = "";
        try { ref = decodeURIComponent(rest).trim(); } catch { return; }
        if (PAPER_REF.test(ref)) out.blocks.push({ kind: "lead", pid: ref });
      } else if (kind === "s") {
        // a search box carries nothing — anything after its dot is a mangle
        if (rest === "") out.blocks.push({ kind: "search" });
      } else if (Object.prototype.hasOwnProperty.call(BS_KIND_OF, kind)) {
        // bare, or t:<town>; names alone may say w:<who>; anything else drops
        // (own keys only — "constructor." is not a kind, a review's precedent)
        let ref = "";
        try { ref = decodeURIComponent(rest).trim(); } catch { return; }
        const nb = { kind: BS_KIND_OF[kind] };
        if (ref) {
          const sc = /^([tw]):(.+)$/.exec(ref);
          if (!sc || (sc[1] === "t" ? !BS_TOWN_REF.test(sc[2]) : (nb.kind !== "names" || !BS_WHO_REF.test(sc[2])))) return;
          nb[sc[1] === "t" ? "town" : "who"] = sc[2];
        }
        out.blocks.push(nb);
      } else if (kind === "a") {
        // the record's reading of a meeting (m:<pid>) or an issue (i:<slug>)
        let ref = "";
        try { ref = decodeURIComponent(rest).trim(); } catch { return; }
        const one = /^([mi]):(.+)$/.exec(ref);
        if (one && PAPER_REF.test(one[2]))
          out.blocks.push(one[1] === "m" ? { kind: "reading", pid: one[2] } : { kind: "reading", slug: one[2] });
      }
    }
  }

  /* arrange: the panel's ↑ ↓ ✕, one function. Index-addressed against the
     draft as it is NOW — a stale index (another tab just edited) can at worst
     move the wrong neighbour once, and the repaint shows exactly what held. */
  function movePaperBlock(i, act, where) {
    const p = readPaper();
    if (!(i >= 0 && i < p.blocks.length)) return;
    let focus;
    if (act === "pdel") {
      p.blocks.splice(i, 1);
      // after a delete, focus the NEXT ROW'S LABEL, never its ✕ — held Enter
      // on one delete must not cascade through the whole paper
      focus = p.blocks.length
        ? { act: "row", i: Math.min(i, p.blocks.length - 1) }
        : { act: "title" };
    } else {
      const j = act === "pup" ? i - 1 : i + 1;
      if (j < 0 || j >= p.blocks.length) return;
      const t = p.blocks[i]; p.blocks[i] = p.blocks[j]; p.blocks[j] = t;
      // keyboard focus follows the block it was moving — the repaint must not
      // drop it on <body> mid-arrangement
      focus = { act, i: j };
    }
    if (!savePaper(p)) toast("this browser blocks storage — the change didn’t hold");
    if (where === "page") {
      // the on-page editor (A3): focus follows the block's own handle (or
      // the title when the last block left) — never the ✕, the same rule
      PAGE_FOCUS = focus.act === "title" ? { act: "title" } : { act: "handle", i: focus.i };
      refreshPaperSummary(); renderPaperNow();
    } else { refreshPaperSummary(focus); schedulePaperRender(); }
  }
  /* move a block from index `from` to LAND before index `to`, counted on
     the list as it stands before the move — the editor's drop target (a
     slot between rows). Pure; out of range or a no-op move returns false. */
  function moveBlock(blocks, from, to) {
    const n = blocks.length;
    if (!(from >= 0 && from < n) || !(to >= 0 && to <= n)) return false;
    const j = to > from ? to - 1 : to;
    if (j === from) return false;
    const [b] = blocks.splice(from, 1); blocks.splice(j, 0, b);
    return true;
  }
  function movePaperBlockTo(from, to) {
    const p = readPaper();
    if (!moveBlock(p.blocks, from, to)) return;
    if (!savePaper(p)) toast("this browser blocks storage — the change didn’t hold");
    PAGE_FOCUS = { act: "handle", i: to > from ? to - 1 : to };
    refreshPaperSummary(); renderPaperNow();
  }
  /* insert a block at an index (the on-page editor's insertion point) or
     at the end (the panel's adds) — one function, so the block cap and the
     landing index are decided once. Returns the index it landed at, or -1
     when the paper is full. */
  function insertBlock(p, nb, at) {
    if (p.blocks.length >= PAPER_MAX_BLOCKS) return -1;
    const i = (at == null || !(at >= 0)) ? p.blocks.length
      : Math.min(at | 0, p.blocks.length);
    p.blocks.splice(i, 0, nb);
    return i;
  }
  /* after a block joins: the panel repaints (it is every add's mirror), and
     the /app/p draft page catches up — on its debounce when the add came
     from the panel, at once (with focus handed to the new block's handle)
     when it came from the page itself (A3). */
  function afterAdd(i, at, focus) {
    if (at == null) { refreshPaperSummary(focus); schedulePaperRender(); }
    else { PAGE_FOCUS = focus || { act: "handle", i }; refreshPaperSummary(); renderPaperNow(); }
  }
  /* add a story by ref — the open page's (the panel's "＋ this meeting"),
     a card's (A2), or an add-search hit's (A3). The meta that rides along
     comes from the story's own plane — already in the fetch cache when the
     page it was read on hydrated — so the panel can label the block without
     lying; a plane that will not load still adds the bare ref, and the
     reader's render enriches later. `at` is the editor's insertion index. */
  async function addStoryRef(ref, at) {
    if (!ref) { toast("open a meeting or an issue to add it as a story"); return; }
    if (storyIndex(readPaper(), ref) >= 0) {
      toast(`this ${ref.story} is already in your paper`); return; }
    let nb;
    if (ref.story === "meeting") {
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(ref.pid)}.json`) || {};
      nb = normalizeBlock({ kind: "story", story: "meeting", pid: ref.pid,
        title: m.title || "", date: m.date || "", body: m.body || "",
        town: m.town || "", thumb: m.thumb || "" });
    } else {
      const it = await getJSON(`${BASE}/issues/${encodeURIComponent(ref.slug)}.json`) || {};
      nb = normalizeBlock({ kind: "story", story: "issue", slug: ref.slug,
        name: it.name || "", n_meetings: it.n_meetings,
        first_seen: it.first_seen || "", last_seen: it.last_seen || "" });
    }
    if (!nb) { toast("this page can’t join a paper"); return; }
    // the fetch awaited — re-read the draft so an edit made meanwhile (this
    // tab or another) isn’t silently reverted by a stale snapshot
    const p = readPaper();
    if (storyIndex(p, ref) >= 0) { toast(`this ${ref.story} is already in your paper`); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("added to your paper");
  }
  function addPageToPaper() { return addStoryRef(pageStoryRef()); }
  /* the C2 adds (refs only): a line by (pid, t) — its words ride the draft
     for the panel's label, never the traveling form; a document by id; a
     digest by issue and window. Each lands at `at` (the editor) or the end. */
  async function addQuoteRef(pid, t, at, text) {
    if (!PAPER_REF.test(pid || "") || !isFinite(t)) return;
    const dup = p => p.blocks.some(b => b.kind === "quote" && b.pid === pid && r1(b.t) === r1(t));
    if (dup(readPaper())) { toast("this line is already quoted in your paper"); return; }
    const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(pid)}.json`) || {};
    const nb = normalizeBlock({ kind: "quote", pid, t, text: text || "", title: m.title || "" });
    if (!nb) return;
    const p = readPaper();
    if (dup(p)) { toast("this line is already quoted in your paper"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) { toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) { toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("quoted — the words are read from the record when your paper renders");
  }
  async function addDocRef(pid, doc, at) {
    if (!PAPER_REF.test(pid || "") || !DOC_REF.test(doc || "")) return;
    const dup = p => p.blocks.some(b => b.kind === "doc" && b.pid === pid && b.doc === doc);
    if (dup(readPaper())) { toast("this document is already in your paper"); return; }
    const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(pid)}.json`) || {};
    const d = (m.documents || []).find(x => x && x.doc_id === doc) || {};
    const nb = normalizeBlock({ kind: "doc", pid, doc, title: d.title || "", dkind: d.kind || "" });
    if (!nb) return;
    const p = readPaper();
    if (dup(p)) { toast("this document is already in your paper"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) { toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) { toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("document added");
  }
  async function addDigestRef(slug, at, n) {
    if (!PAPER_REF.test(slug || "")) return;
    const dup = p => p.blocks.some(b => b.kind === "digest" && b.slug === slug);
    if (dup(readPaper())) { toast("this issue’s digest is already in your paper"); return; }
    const it = await getJSON(`${BASE}/issues/${encodeURIComponent(slug)}.json`) || {};
    const nb = normalizeBlock({ kind: "digest", slug, n: n || 3, name: it.name || "" });
    if (!nb) return;
    const p = readPaper();
    if (dup(p)) { toast("this issue’s digest is already in your paper"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) { toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) { toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("digest added — it reads the issue’s timeline when your paper renders");
  }
  /* a card's second press (A2): the story leaves. Index-addressed against
     the draft as it is now, like every arrange. */
  function removeStoryRef(ref) {
    const p = readPaper();
    const i = storyIndex(p, ref);
    if (i < 0) { toast(`this ${ref.story} isn’t in your paper`); return; }
    p.blocks.splice(i, 1);
    if (!savePaper(p)) {
      toast("this browser blocks storage — the change didn’t hold"); return; }
    refreshPaperSummary(); schedulePaperRender();
    toast("removed from your paper");
  }
  /* the reel joins as a snapshot: the block holds these clips as they are
     now, and the tray keeps rolling — tick more moments and add again for a
     second reel. (A live pointer would rewrite a shared paper behind the
     editor's back.) */
  function addReelToPaper(at) {
    const clips = readReel(REEL_KEY);
    if (!clips.length) {
      toast("no clips yet — open a meeting and tick its moments"); return; }
    const p = readPaper();
    const nb = normalizeBlock({ kind: "reel", clips: clips.map(c => ({ ...c })) });
    if (!nb) { toast("these clips don’t make a playable reel"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("reel added to your paper — the tray keeps rolling");
  }
  /* the lead story (specs/29): one meeting told large — its label rides the
     draft from the plane the page already holds or one honest fetch */
  async function addLeadRef(pid, at) {
    if (!PAPER_REF.test(pid || "")) return;
    const dup = p => p.blocks.some(b => b.kind === "lead" && b.pid === pid);
    if (dup(readPaper())) { toast("this meeting is already the lead story"); return; }
    const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(pid)}.json`) || {};
    const nb = normalizeBlock({ kind: "lead", pid, title: m.title || "", date: m.date || "", town: m.town || "" });
    if (!nb) return;
    const p = readPaper();
    if (dup(p)) { toast("this meeting is already the lead story"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) { toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) { toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("the lead story added — its still, its lede and its moments read from the record");
  }
  /* the week, the threads, the strip, the names, the search box (specs/29):
     enums, with a municipality when one is asked for — nothing fetched, the
     page computes each from the record's planes when it renders */
  function addBsBlock(kind, at, town) {
    if (!BS_SCOPED.includes(kind) && kind !== "search") return;
    const nb = normalizeBlock({ kind, ...(town ? { town } : {}) });
    if (!nb) return;
    const p = readPaper();
    if (kind !== "search" && p.blocks.some(b => b.kind === kind && !b.who && (b.town || "") === (nb.town || ""))) {
      toast("that block is already on your page — its town can change from its frame"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) { toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) { toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast(kind === "search" ? "a search box — readers search inside this page’s meetings" : "added — it draws from the record when your page renders");
  }
  /* a scoped block's municipality, from its frame's select (the store keeps
     the slug; the plane names the town) */
  function setBlockTown(i, town) {
    const p = readPaper();
    if (!(i >= 0 && i < p.blocks.length) || !BS_SCOPED.includes(p.blocks[i].kind)) return;
    if (town && BS_TOWN_REF.test(town)) { p.blocks[i].town = town; delete p.blocks[i].who; } else delete p.blocks[i].town;
    // the label follows the choice — a pill that kept saying "Boston" over a
    // frame set to Brookline would describe storage, not the painted state
    const shown = PAPER_TOWNS.find(t => bsSlug(t) === town);
    if (shown) p.blocks[i].name = shown; else delete p.blocks[i].name;
    if (!savePaper(p)) { toast("this browser blocks storage — the change didn’t hold"); return; }
    retireShortOut();
    PAGE_FOCUS = { act: "town", i };
    refreshPaperSummary(); renderPaperNow();
  }
  /* a note joins empty and is typed into in the panel — the draft may hold
     the blank; no traveling form does. Focus lands in the fresh textarea. */
  function addNoteToPaper(at) {
    const p = readPaper();
    const i = insertBlock(p, { kind: "note", text: "" }, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return -1; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return -1; }
    // focus lands in the fresh field — the panel's, or the page's own (A3)
    afterAdd(i, at, { act: "note", i });
    return i;   // the index it landed at, or -1 — a caller's toast must not outrun a refusal
  }
  /* a chart joins as an enum + a ref; the label that rides along comes from
     the plane the open page already fetched (or one honest fetch), so the
     panel can name it without lying. The chart itself is computed at render,
     from the record — never stored numbers. */
  async function addChartToPaper(chart, refv, at) {
    if (!PAPER_CHARTS.includes(chart)) return;
    // a ref names a meeting or an issue: m:<pid> / i:<slug> say which; a bare
    // ref means what the chart's kind implies (reach, ledger: an issue;
    // framing, shape, votes: a meeting)
    const isIssue = /^i:/.test(refv || "")
      || (!/^m:/.test(refv || "") && (chart === "reach" || chart === "ledger"));
    const ref = String(refv || "").replace(/^[mi]:/, "");
    const dup = p => p.blocks.some(b => b.kind === "chart" && b.chart === chart
      && ((b.slug || b.pid || "") === ref));
    if (dup(readPaper())) { toast("this chart is already in your paper"); return; }
    let nb;
    if (chart === "reach" || chart === "ledger" || (chart === "numbers" && isIssue)) {
      if (!ref) { toast("open an issue to chart it"); return; }
      const it = await getJSON(`${BASE}/issues/${encodeURIComponent(ref)}.json`) || {};
      nb = normalizeBlock({ kind: "chart", chart, slug: ref, name: it.name || "" });
    } else if (ref && (chart === "framing" || chart === "shape" || chart === "votes" || chart === "numbers")) {
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(ref)}.json`) || {};
      nb = normalizeBlock({ kind: "chart", chart, pid: ref, title: m.title || "" });
    } else if (chart === "shape" || chart === "numbers") {
      toast("open a meeting or an issue to chart it"); return;
    } else {
      nb = normalizeBlock({ kind: "chart", chart });
    }
    if (!nb) { toast("this chart can’t join a paper"); return; }
    // the fetch awaited — re-read the draft so a meanwhile edit isn't reverted
    const p = readPaper();
    if (dup(p)) { toast("this chart is already in your paper"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("chart added — it draws from the record when your paper renders");
  }
  /* the record's reading of a meeting or an issue (specs/24) — a ref block
     like a chart; the words are the analyzer's, computed at render */
  async function addReadingToPaper(refv, at) {
    const one = oneRef(refv); if (!one) return;
    const dup = p => p.blocks.some(b => b.kind === "reading" && (b.pid || b.slug) === (one.pid || one.slug));
    if (dup(readPaper())) { toast("the record’s reading of this is already in your paper"); return; }
    let nb;
    if (one.pid) {
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(one.pid)}.json`) || {};
      nb = normalizeBlock({ kind: "reading", pid: one.pid, title: m.title || "" });
    } else {
      const it = await getJSON(`${BASE}/issues/${encodeURIComponent(one.slug)}.json`) || {};
      nb = normalizeBlock({ kind: "reading", slug: one.slug, name: it.name || "" });
    }
    if (!nb) return;
    const p = readPaper();
    if (dup(p)) { toast("the record’s reading of this is already in your paper"); return; }
    const i = insertBlock(p, nb, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("the record’s reading added — it reads from the record when your paper renders");
  }
  /* the templates (specs/29 board 7) — each a list of blocks the record
     fills and three questions the writer answers; the questions are the
     paper, and a template never writes a word of it. `pick` is what the
     template is about: a meeting, an issue, a name (people · places), two
     towns, or nothing. `draws` says what the record can actually draw —
     where the board promised more than the planes hold (who moved a vote,
     when a person spoke), the card says what is there instead. */
  const TEMPLATES = {
    meeting: { name: "One meeting — what happened", pick: "meeting",
      draws: "the still, the counted lede, the moments that decided it, the roll calls, the shape of the tape",
      asks: ["What was the room really about?", "Which moment turned it?", "What did it leave undone?"] },
    issue: { name: "An issue over time", pick: "issue",
      draws: "a timeline of the meetings that took it up, a reel of its latest moments, how the night that said it most was framed",
      asks: ["What changed between the first meeting and the last?", "Who pushed, and who pushed back?", "What is still on the table — what should a reader watch for next?"] },
    vote: { name: "A vote and its history", pick: "issue",
      draws: "the tally of every roll call on the question, the words around the first four, the record’s reading",
      asks: ["What was voted, exactly?", "How did the count move?", "What was promised in between?"] },
    person: { name: "A person on the record", pick: "people",
      draws: "when they were named, how often, in which meetings — and the words around the latest three",
      asks: ["What do they return to?", "Where did they change position?", "Who do they answer?"] },
    place: { name: "A place on the record", pick: "places",
      draws: "the meetings that named it, on a map of months, with the latest moments",
      asks: ["What is being decided about it?", "Who lives with the decision?", "When does it come back?"] },
    towns: { name: "Two towns, side by side", pick: "towns",
      draws: "the same lens strip, the same threads, the same names — twice",
      asks: ["Where do they talk alike?", "Where do they diverge?", "What does one do that the other doesn’t?"] },
    year: { name: "The year so far", pick: "",
      draws: "meetings by month with their lenses, the widest threads, the roll calls, the names",
      asks: ["What did the year keep coming back to?", "What was decided?", "What was only discussed?"] },
    rolls: { name: "The roll calls, watched", pick: "",
      draws: "every roll call on the record, dot by dot — and how the talk around them was framed",
      asks: ["Which roll call mattered most?", "Who was on the losing side, and why?", "What comes back for a vote next?"] },
    blank: { name: "Blank broadsheet", pick: "", draws: "start empty; every block is on the shelf", asks: [] },
  };
  const TEMPLATE_ORDER = ["meeting", "issue", "vote", "person", "place", "towns", "year", "blank"];
  const BS_MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  /* "June to September", "June" — an issue's span, the way the press says a
     chapter's (web/story.py month_span_words, first and last only) */
  const bsMonthSpan = (a, b) => { const ms = [a, b].filter(tpIsMonth).map(d => BS_MONTHS[+String(d).slice(5, 7)] || "").filter(Boolean);
    return !ms.length ? "" : ms.length === 1 || ms[0] === ms[1] ? ms[0] : `${ms[0]} to ${ms[1]}`; };
  /* the town an issue slug names (the record's own scheme: issue_<town>_<rest>) */
  const bsSlugTown = slug => { const m = /^issue_([a-z]+)_/.exec(String(slug || "")); return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : ""; };
  /* a template (P3, redrawn for specs/29): a pre-shaped front page the
     writer starts from — the same blocks the shelf adds, written in one
     press, client-side only. Offered on an empty draft; the re-check here
     is for the draft that grew between paint and press (another tab, a
     storage race) — a template never replaces work without asking. The
     note joins empty on purpose: a template may shape a page, but the
     writer's words are the writer's to write. Returns whether the draft
     was written — a caller rendering the page needs to know whether the
     old draft still stands. */
  async function applyPaperTemplate(t, ref, where) {
    // the ref comes from the open page (the panel's offer), the front door's
    // hash, the templates board's picker, or the empty editor's starts;
    // `where` = "page" hands the fresh note to the on-page editor instead
    // of the panel
    ref = ref || pageStoryRef();
    let title = "", blocks = [];
    const bead = n => n && (n.beads || []).find(x => x && typeof x.t === "number");
    if (t === "rolls") {
      title = "the roll calls, watched";
      blocks = [{ kind: "chart", chart: "votes", layout: "lead" },
                { kind: "chart", chart: "framing" },
                { kind: "note", text: "" }];
    } else if ((t === "issue" || t === "vote") && ref && ref.story === "issue") {
      // board 6 — an issue over time: the issue as the lead (its name, the
      // counted lede), the timeline of the meetings that took it up, the
      // writer's paragraphs, a reel of its latest three moments in order,
      // how the talk was framed on the night that said it most, and the
      // search box over its meetings. A vote and its history keeps the
      // lead and puts every roll call along the way first, the words
      // around each (the line at each vote), then the record's reading.
      // A block whose plane holds nothing is not written: a story never
      // opens with an empty picture.
      const it = await getJSON(`${BASE}/issues/${encodeURIComponent(ref.slug)}.json`) || {};
      const name = it.name || ref.slug;
      const tl = (it.timeline || []).filter(n => n && typeof n === "object" && PAPER_REF.test(n.pid || ""));
      const story = { kind: "story", story: "issue", slug: ref.slug, layout: "lead",
                      name: it.name || "", n_meetings: it.n_meetings,
                      first_seen: it.first_seen || "", last_seen: it.last_seen || "" };
      if (t === "issue") {
        const town = bsSlugTown(ref.slug), span = bsMonthSpan(it.first_seen, it.last_seen);
        title = `${name} — what ${town || "the record"} said${span ? `, ${span}` : ""}`;
        const loud = tl.slice().sort((a, c) => ((c.beads || []).length - (a.beads || []).length)
          || (String(c.date || "") > String(a.date || "") ? 1 : String(c.date || "") < String(a.date || "") ? -1 : 0))[0];
        const clips = tl.filter(n => bead(n)).slice(-3).map(n => ({ pid: n.pid, start: r1(Math.max(0, bead(n).t - 5)),
          end: r1(bead(n).t + 40), kind: "moment", quote: bead(n).text || "" }));
        blocks = [story,
                  ...(tl.length ? [{ kind: "chart", chart: "reach", slug: ref.slug, name }] : []),
                  { kind: "note", text: "" },
                  ...(clips.length ? [{ kind: "reel", clips, layout: "half" }] : []),
                  ...(loud ? [{ kind: "chart", chart: "framing", pid: loud.pid, title: loud.title || "", layout: "half" }] : []),
                  { kind: "search" }];
      } else {
        const led = (it.ledger || []).filter(v => v && PAPER_REF.test(v.pid || "") && typeof v.t === "number");
        // the plane answered and holds no roll call: a page titled "the vote"
        // over an empty ledger is a promise the record cannot keep — say so
        // and write nothing (a dark plane still writes the ref-only shape)
        if (it.slug && !led.length) { toast(`no roll call on ${name} has been read from a tape — start from “An issue over time” instead`); return false; }
        title = `${name} — the vote and its history`;
        blocks = [story,
                  { kind: "chart", chart: "ledger", slug: ref.slug, name },
                  ...led.slice(0, 4).map(v => ({ kind: "quote", pid: v.pid, t: v.t, text: cut(String(v.motion || ""), 120), title: v.title || "" })),
                  ...(tl.length ? [{ kind: "reading", slug: ref.slug, name }] : []),
                  { kind: "search" },
                  { kind: "note", text: "" }];
      }
    } else if (t === "meeting" && ref && ref.story === "meeting") {
      // path one, on the board (specs/24 → specs/29): the lead story (the
      // still, the counted lede, the three moments that decided it), the
      // meeting in numbers, the shape of the tape, the three moments as
      // quotes, its roll calls, how it was framed, the record's reading,
      // its filings, the search box, and the note. Blocks whose plane
      // holds nothing are not written.
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(ref.pid)}.json`) || {};
      const mtitle = m.title || ref.pid;
      const top = bsTopMoments(m, 3);
      title = m.body && TP_DAY.test(m.date || "") ? `${m.body}, in one night — ${tpDay(m.date)}` : `${mtitle} — what happened`;
      blocks = [{ kind: "lead", pid: ref.pid, title: m.title || "", date: m.date || "", town: m.town || "" },
                { kind: "chart", chart: "numbers", pid: ref.pid, title: mtitle },
                ...((m.moments || []).length ? [{ kind: "chart", chart: "shape", pid: ref.pid, title: mtitle }] : []),
                ...top.map(mo => ({ kind: "quote", pid: ref.pid, t: mo.t, text: mo.quote || "", title: mtitle })),
                ...((m.votes || []).length ? [{ kind: "chart", chart: "votes", pid: ref.pid, title: mtitle }] : []),
                { kind: "chart", chart: "framing", pid: ref.pid, title: m.title || "" },
                { kind: "reading", pid: ref.pid, title: mtitle },
                ...((m.documents || []).slice(0, 3).filter(d => d && d.doc_id)
                    .map(d => ({ kind: "doc", pid: ref.pid, doc: d.doc_id, title: d.title || "", dkind: d.kind || "" }))),
                { kind: "search" },
                { kind: "note", text: "" }];
    } else if ((t === "person" || t === "place") && ref && PAPER_REF.test(ref.who || "")) {
      // a name on the record: the name told large (when it was named, how
      // often, in which meetings), the words around its latest three
      // mentions, the search box, and the note
      const an = await getJSON(`${BASE}/analytics.json`) || {};
      const one = (an.names || []).find(n => n && n.name && String(n.slug || bsWho(n.kind, n.name)) === ref.who);
      const name = (one && one.name) || ref.name || ref.who;
      title = `${name} — on the record`;
      // a mention at 0:00 is a plane with no time for it (an older analysis),
      // not a moment — real tapes open on a dead-air slate
      const ms = one ? (one.meetings || []).filter(x => x && PAPER_REF.test(x.pid || "") && typeof x.t === "number" && x.t > 0)
        .slice().sort((a, c) => (String(c.date || "") > String(a.date || "") ? 1 : String(c.date || "") < String(a.date || "") ? -1 : 0)) : [];
      blocks = [{ kind: "names", who: ref.who, name, layout: "lead" },
                ...ms.slice(0, 3).map(x => ({ kind: "quote", pid: x.pid, t: x.t, text: "", title: "" })),
                { kind: "search" },
                { kind: "note", text: "" }];
    } else if (t === "towns") {
      // two towns, side by side: the same strip, the same threads, the same
      // names — twice, as halves. The towns come from the picker, or from
      // the pressing's own when it holds two.
      let a = ref && ref.a, b2 = ref && ref.b;
      if (!(a && b2)) {
        const ed = await edition();
        const ts = (ed.towns || []).map(x => String((x && x.town) || "")).filter(Boolean);
        if (ts.length < 2) { toast(`two towns side by side needs two towns — this pressing holds ${ts.length === 1 ? "one" : "none"}`); return false; }
        a = ts[0]; b2 = ts[1];
      }
      title = `${a} and ${b2}, side by side`;
      const pair = kind => [{ kind, town: bsSlug(a), name: a, layout: "half" }, { kind, town: bsSlug(b2), name: b2, layout: "half" }];
      blocks = [...pair("strip"), ...pair("threads"), ...pair("names"), { kind: "note", text: "" }];
    } else if (t === "year") {
      // the year so far: meetings by month with their lenses (the strip),
      // the widest threads, the roll calls, the names, the search box
      const meta = await getJSON(`${BASE}/search/meta.json`);
      const months = tpMonthRange((Array.isArray(meta) ? meta : []).filter(m => m && tpIsMonth(m.date)).map(m => String(m.date).slice(0, 7)));
      title = months.length ? `The year so far — ${bsMonthSpan(months[0], months[months.length - 1])}` : "The year so far";
      blocks = [{ kind: "strip", layout: "lead" }, { kind: "threads" }, { kind: "chart", chart: "votes" },
                { kind: "names" }, { kind: "search" }, { kind: "note", text: "" }];
    } else return false;
    // the fetch awaited — re-read, and never overwrite silently. A draft
    // that is only a title (named first, shaped second — the on-page
    // editor's natural order) loses nothing: the name stays, the shape
    // arrives, no question asked. Blocks are work, and work is asked about.
    const cur = readPaper();
    if (cur.blocks.length
        && !window.confirm("Start from this template? Your current draft "
                           + "will be replaced.")) return false;
    if (!cur.blocks.length && cur.title) title = cur.title;
    const p = normalizePaper({ title, blocks, tpl: t });
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return false; }
    // focus lands in the fresh note: the one block a template cannot write
    const ni = Math.max(0, p.blocks.findIndex(b => b.kind === "note"));
    afterAdd(ni, where === "page" ? ni : null, { act: "note", i: ni });
    toast("a front page, pre-shaped — the paragraphs are yours to write");
    return true;
  }
  function clearPaper() {
    // the open paper empties and stays on the shelf (delete is its own act)
    if (!savePaper({ title: "", blocks: [] })) {
      toast("this browser blocks storage — the change didn’t hold"); return; }
    retireShortOut();
    refreshPaperSummary(); schedulePaperRender();
    toast("draft cleared — the record is untouched");
  }

  /* the export: paper.json, the receipt a paper leaves. Like reel.json it is
     honest about provenance (every block carries its own record URL) and
     about limits (the blocks are refs; the record renders them). */
  /* where a chart's numbers live on the record itself — every chart block in
     the receipt carries the page a reader can recount it on. */
  function chartRecordURL(b) {
    return `${location.origin}${BASE}` + (
      b.slug ? `/i/${b.slug}`
      : b.pid ? `/m/${b.pid}`
      : b.chart === "votes" ? "/officials"
      : "/analytics");
  }
  function paperJSON(p) {
    p = normalizePaper(p);
    return {
      schema: "publicrecord.paper/1",
      title: p.title || "a paper from the record",
      made_with: "publicrecord.studio",
      note: "A curated front page of the public record. Every story, reel "
        + "and chart points back into the record; a note is the editor's "
        + "own words. The share link renders it anywhere.",
      share: paperShareURL(p),
      blocks: p.blocks.filter(b => b.kind !== "note" || b.text.trim())
        .map(b => withLayout(b.kind === "quote"
        ? { kind: "quote", pid: b.pid, t: r1(b.t),
            computed: "the line is read from the record's own transcript at render",
            url: `${location.origin}${BASE}/m/${b.pid}#t${Math.floor(b.t)}` }
        : b.kind === "doc"
        ? { kind: "doc", pid: b.pid, doc: b.doc, title: b.title || "",
            url: `${location.origin}${BASE}/m/${b.pid}` }
        : b.kind === "digest"
        ? { kind: "digest", slug: b.slug, n: b.n, name: b.name || "",
            computed: "from the issue's own timeline at render",
            url: `${location.origin}${BASE}/i/${b.slug}` }
        : b.kind === "reel"
        ? { kind: "reel", runtime: reelRuntime(b.clips),
            play: reelShareURL(b.clips),
            clips: b.clips.map(c => ({ pid: c.pid, start: r1(c.start),
              end: r1(c.end), kind: c.kind || "moment", quote: c.quote || "" })) }
        : b.kind === "note"
          ? { kind: "note", text: b.text }
        : b.kind === "chart"
          ? { kind: "chart", chart: b.chart,
              ...(b.slug ? { slug: b.slug } : {}),
              ...(b.pid ? { pid: b.pid } : {}),
              computed: "in the reader's browser, from the record's own planes",
              url: chartRecordURL(b) }
        : b.kind === "reading"
          ? { kind: "reading", ...(b.pid ? { pid: b.pid } : { slug: b.slug }),
              computed: "in the reader's browser, from the analyzer's pressed read — no model",
              url: `${location.origin}${BASE}/${b.pid ? "m/" + b.pid : "i/" + b.slug}` }
        : b.kind === "lead"
          ? { kind: "lead", pid: b.pid, title: b.title || "",
              computed: "the meeting's still, its counted lede and its moments, from its own pressed plane at render",
              url: `${location.origin}${BASE}/m/${b.pid}` }
        : b.kind === "search"
          ? { kind: "search", computed: "a search box over this page's own meetings — it stores no query",
              url: `${location.origin}${BASE}/s` }
        : BS_SCOPED.includes(b.kind)
          ? { kind: b.kind, ...(b.who ? { who: b.who } : {}), ...(b.town ? { town: b.town } : {}),
              computed: "in the reader's browser, from the record's own planes",
              url: `${location.origin}${BASE}/` }
        : b.story === "issue"
          ? { kind: "story", story: "issue", slug: b.slug, name: b.name || "",
              url: `${location.origin}${BASE}/i/${b.slug}` }
          : { kind: "story", story: "meeting", pid: b.pid, title: b.title || "",
              date: b.date || "", body: b.body || "", town: b.town || "",
              url: `${location.origin}${BASE}/m/${b.pid}` }, b)),
    };
  }
  function downloadPaper(p) {
    const doc = paperJSON(p);
    const name = (doc.title.toLowerCase().replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 40) || "paper");
    const blob = new Blob([JSON.stringify(doc, null, 2)],
                          { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.paper.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast("paper.json downloaded — your paper, as a file you keep");
  }

  /* ---- PART 2: SHARING's server half + the /app/p renderer ----------------
     Everything above travels without a server. The two functions below are
     the paper's whole acquaintance with one: an explicit press of "short
     link" (POST the portable form, get the content address back) and the
     read of a `?p=` address someone shared. Both fail soft to the covenant
     substrate — the long link and the file. */
  let PAPER_SHORT = "";   // the last short link minted, valid until the paper changes
  /* retire the minted link EVERYWHERE the paper can change: the variable
     (savePaper zeroes it too) AND the painted node — a sibling-node removal,
     so the no-repaint-under-the-caret rule stands. Without both halves the
     panel keeps showing a link that serves the OLD paper. */
  function retireShortOut() {
    PAPER_SHORT = "";
    const so = STUDIO && $(".cz-pshort-out", STUDIO);
    if (so) so.remove();
    const pb = $("#paperbody"), po = pb && $(".cz-pshort-out", pb);
    if (po) po.remove();
  }
  async function paperShortLink() {
    const p = readPaper();
    const port = portablePaper(p);   // what would actually travel
    if (!port.blocks.length && !port.title) {
      toast("your paper is empty — nothing to share yet"); return; }
    if (!API) {
      copyText(paperShareURL(p),
        "this pressing has no share store — full link copied"); return; }
    const ctl = new AbortController();
    const bell = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const r = await fetch(API + "/api/papers", {
        method: "POST", credentials: "omit", signal: ctl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(port) });
      if (!r.ok) {
        // the store answers in sentences (413 too-large, 422 refused, 503
        // no bucket) — say ITS reason; "didn’t answer" would be false, and
        // a 70KB "full link" is not the guidance a too-large paper needs
        let said = "";
        try { said = ((await r.json()) || {}).error || ""; } catch { /* not JSON */ }
        if (said) { toast(said); return; }
        throw new Error(String(r.status));
      }
      const d = await r.json();
      if (!d || !/^[0-9a-f]{16}$/.test(d.id || "")) throw new Error("bad id");
      // paint the link into the panel FIRST: the await may have outlived the
      // click's user activation, and a clipboard some browsers then refuse
      // must not be the only place the link exists. A paper carrying P2
      // kinds mints a v=2 address, so a reader still on the shipped v1
      // shell gets the honest newer-version message, never a mutilated one.
      const pv = paperV(port);
      PAPER_SHORT = `${location.origin}${BASE}/p?${pv === "1" ? "" : `v=${pv}&`}p=${d.id}`;
      // the repaint must hand focus back to the button that was pressed
      refreshPaperSummary({ act: "pshort" });
      copyText(PAPER_SHORT,
        "short link copied — it serves this paper exactly as it stands");
    } catch {
      copyText(paperShareURL(p),
        "the share store didn’t answer — full link copied instead");
    } finally { clearTimeout(bell); }
  }
  async function fetchStoredPaper(id) {
    if (!API) return null;
    const ctl = new AbortController();
    const bell = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const r = await fetch(`${API}/api/papers/${id}`,
        { signal: ctl.signal, credentials: "omit" });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
    finally { clearTimeout(bell); }
  }

  /* the reader's side: /app/p. Decode whichever form arrived (stored id →
     link → this browser's draft), fetch the record's own planes for what the
     blocks reference, and render — in the paper palette, whatever mode the
     EDITOR liked. A story whose meeting or issue is not in this pressing
     says so in place; a reel's clips enrich from their meetings' moments the
     way /app/r does. */
  let PAPER_DRAFT_PAGE = false;      // this /app/p render came from the draft
  let PAPER_RERENDER = 0;
  let PAPER_GEN = 0;                 // render generation — a stale async render must not land
  function schedulePaperRender() {
    if (!PAPER_DRAFT_PAGE) return;   // not on /app/p, or it renders a shared paper
    clearTimeout(PAPER_RERENDER);
    PAPER_RERENDER = setTimeout(() => paper(), 350);
  }
  /* the editor's own edits (A3) repaint at once — the debounce exists for
     keystrokes in the panel, not for a drop or a ✕ the reader is watching */
  let PAGE_FOCUS = null;   // where the next /app/p render should land focus
  function renderPaperNow() {
    if (!PAPER_DRAFT_PAGE) return;
    clearTimeout(PAPER_RERENDER);
    paper();
  }
  /* fetch a set of planes a few at a time: the 8-worker pool is what protects
     the host from a hostile link's burst; the cap is sized to the document
     model's own envelope, so no sanctioned paper hits it. Returns what was
     fetched AND what was attempted — a ref past the cap must read as "beyond
     this page's budget", never as the lie "curated away". */
  async function fetchPlanes(ids, path, cap) {
    const got = {}, tried = new Set();
    const list = [...ids].slice(0, cap);
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const id = list[i++];
        tried.add(id);
        const d = await getJSON(`${BASE}/${path}/${encodeURIComponent(id)}.json`);
        if (d) got[id] = d;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    return { got, tried };
  }
  async function paper() {
    const el = $("#paperbody"); if (!el) return;
    /* the featured papers (P3) are pressed into the stub OUTSIDE this
       renderer's node — server-rendered links, the record's own examples.
       They belong to the empty state only: any paper that actually renders
       (or any message about one that was asked for) retires them, and an
       emptied draft brings them back. */
    const feat = $("#pfeat");
    const showFeat = v => { if (feat) feat.hidden = !v; };
    showFeat(false);
    // a repaint invalidates any drag in flight (its source row is about to
    // be detached, and dragend fires on the detached node where no listener
    // hears it) and every render starts as the reader, not the editor
    ED_DRAG = -1; ED_SHELF = "";
    DESK_NOTE = -1;   // the paragraph the caret was in is an index of the shape about to repaint (R7)
    el.classList.remove("cz-editing");
    const gen = ++PAPER_GEN;
    const st = decodePaper(location.search);
    if (st.v && !PAPER_VS.includes(st.v))
      return paperMessage(el, "This paper was shared from a newer version of "
        + `the record than this one. Open <a href="${BASE}/">the record</a> — `
        + "every story a paper cites reads there in place.");
    let doc = null, from = "";
    if (st.id) {
      const stored = await fetchStoredPaper(st.id);
      if (gen !== PAPER_GEN) return;   // a newer render superseded this one
      if (!stored) return paperMessage(el, "No paper answers at this address. "
        + "The share store may be unreachable, the id may have lost a "
        + "character, or the paper was taken down. Papers also travel as full "
        + "links and <code>paper.json</code> files — ask whoever shared this "
        + `for one, or open <a href="${BASE}/">the record</a> itself.`);
      doc = normalizePaper(stored); from = "stored";
    } else if (st.blocks.length || st.title) {
      doc = normalizePaper({ title: st.title, blocks: st.blocks }); from = "link";
    } else if ((location.search || "").length > 1) {
      // a query arrived but nothing decoded — a mangled link or a broken id.
      // Showing the reader THEIR draft here would mislabel what they were
      // sent; say what happened instead.
      return paperMessage(el, "This link doesn’t carry a readable paper — it "
        + "may have lost characters in transit. Ask whoever shared it for a "
        + "fresh link or a <code>paper.json</code> file, or open "
        + `<a href="${BASE}/">the record</a> itself.`);
    } else {
      doc = readPaper(); from = "draft";
      // arm the re-render gate BEFORE the empty early-return: a page opened
      // on an empty draft must still repaint as the paper takes shape in the
      // panel beside it (four review lenses caught this one).
      PAPER_DRAFT_PAGE = true;
      // the editor's hash (specs/23 A1/A4): #edit opens the studio on this
      // page — the front door's "Start your paper"; #edit&tpl=…&ref=… writes
      // a template draft first. Read once per page load, then trimmed back
      // to #edit so a reload never asks twice. A shared or stored paper
      // ignores the hash entirely: it is read-only until specs/22's
      // make-this-yours.
      // a same-document click on an #edit link (the stub's own "edit your
      // own", on a page the service worker served at the bare path) only
      // changes the hash — listen once, and read the door again
      if (!PAPER_HASH_WIRED) {
        PAPER_HASH_WIRED = true;
        window.addEventListener("hashchange", () => {
          if (!PAPER_DRAFT_PAGE) return;
          ED_HASH_SEEN = false; renderPaperNow();
        });
      }
      if (!ED_HASH_SEEN) {
        ED_HASH_SEEN = true;
        const hp = new URLSearchParams((location.hash || "").replace(/^#/, ""));
        const tpl = hp.get("tpl") || "";
        const copy = hp.get("copy") || "";
        if (hp.has("edit") || tpl || copy) {
          // the door is a one-time instruction: consumed, then dropped from
          // the address, so a reload (or back) keeps whatever mode the
          // reader chose afterwards instead of re-opening the studio
          try { history.replaceState(null, "", location.pathname + location.search); }
          catch { /* a sandboxed frame: the hash simply stays */ }
        }
        if (hp.has("edit")) {
          if (shownMode() !== "studio") {
            // on a phone the studio is an overlay drawer that would cover
            // the very editor this door promised — open it collapsed to
            // its rail there; the page shifts by the rail and the editor
            // is the page. Wide screens get the full sidebar beside it.
            const narrow = !!(window.matchMedia
              && window.matchMedia("(max-width: 720px)").matches);
            writeRail(narrow); setMode("studio");
            // setMode armed a debounced repaint; THIS render is painting
            // the studio already, so a second pass would only steal focus
            clearTimeout(PAPER_RERENDER);
          }
          PAGE_FOCUS = PAGE_FOCUS || { act: "title" };
        }
        if (copy) {
          // "make your own from the same receipts" (board 6): the shared
          // page's own link, decoded into the draft — asked about first when
          // a draft with blocks stands, the template's rule
          const got = decodePaper("?" + copy);
          // the receipts travel; the other writer's paragraphs do not — a
          // reshare must never carry someone else's words as yours (a review
          // catch). One empty paragraph joins at the end to write into.
          const refs = got.blocks.filter(b => b.kind !== "note");
          const cur = readPaper();
          if ((refs.length || got.title)
              && (!cur.blocks.length || window.confirm("Start from this front page? Your current draft will be replaced."))) {
            if (savePaper(normalizePaper({ title: (!cur.blocks.length && cur.title) ? cur.title : got.title, blocks: [...refs, { kind: "note", text: "" }] }))) toast("a copy of that front page’s receipts — the paragraphs are yours to write");
            else toast("this browser blocks storage — your copy can’t be kept here");
          }
          doc = readPaper();
        }
        if (tpl) {
          const tref = (hp.get("ref") || "").trim();
          const ref = tpl === "meeting" && PAPER_REF.test(tref) ? { story: "meeting", pid: tref }
            : tpl === "issue" && PAPER_REF.test(tref) ? { story: "issue", slug: tref } : null;
          // the template writes and renders the page itself; a refused
          // confirm (or a mangled ref) falls through to the draft as it is
          if ((tpl === "rolls" || ref) && await applyPaperTemplate(tpl, ref, "page")) return;
          doc = readPaper();
        }
      }
      const editing = shownMode() === "studio";
      if (!doc.blocks.length && (editing || !doc.title)) {
        showFeat(true);   // the one state the pressed examples belong to
        // in the studio the empty draft TEACHES (A4): the title, three big
        // starts, and the first insertion point
        if (editing) return paperTeach(el, doc, gen);
        // the way in is named by what THIS mode paints in the corner: paper
        // mode holds only the ◐ tab and paints no card affordance at all
        return paperMessage(el, "No paper here yet — this page renders one "
          + "when a link carries it, or shows your own draft. "
          + (shownMode() === "paper"
            ? "Press <b>◐ studio</b> in the corner to bring the studio back: "
              + "this page becomes your editor, and every meeting and issue "
              + `on <a href="${BASE}/">the record</a> offers “＋ your paper”.`
            : "Press <b>✎ Your paper — edit</b> in the corner, or open "
              + `<a href="${BASE}/">the record</a> and press “＋ your paper” on `
              + "any meeting or issue — your paper takes shape here."));
      }
    }
    PAPER_DRAFT_PAGE = from === "draft";
    document.title = `${doc.title || "A paper"} — publicrecord.studio`;
    // one fetch per meeting or issue the paper touches, however many blocks.
    // Stories pool BEFORE reel clips, so a single-story block can never lose
    // its fetch budget to a reel's fan-out. A chart's refs join the same
    // pools (a framing chart reads its meeting's plane, a reach chart its
    // issue's); the two record-wide planes a chart can want — votes.json,
    // analytics.json — are one fetch each, asked for only when a block needs
    // them.
    const mpids = new Set(), islugs = new Set();
    for (const b of doc.blocks) {
      if (b.kind === "story" && b.story === "meeting") mpids.add(b.pid);
      else if (b.kind === "lead") mpids.add(b.pid);                      // specs/29: the lead story's meeting
      else if (b.kind === "story" && b.story === "issue") islugs.add(b.slug);
      else if (b.kind === "chart" && b.pid) mpids.add(b.pid);      // framing · numbers · shape · votes, of one meeting
      else if (b.kind === "chart" && b.slug) islugs.add(b.slug);   // reach · numbers · ledger, of one issue
      else if (b.kind === "quote" || b.kind === "doc") mpids.add(b.pid);
      else if (b.kind === "digest") islugs.add(b.slug);
      else if (b.kind === "reading") { if (b.pid) mpids.add(b.pid); else islugs.add(b.slug); }
    }
    for (const b of doc.blocks)
      if (b.kind === "reel") b.clips.forEach(c => mpids.add(c.pid));
    const wantVotes = doc.blocks.some(b => b.kind === "chart" && b.chart === "votes" && !b.pid);
    const wantAnalytics = doc.blocks.some(b => (b.kind === "chart"
      && (b.chart === "topics" || (b.chart === "framing" && !b.pid)))
      || b.kind === "threads" || b.kind === "strip" || b.kind === "names");
    // specs/29: the week, the threads, the strip and the names read the
    // record's own index (search/meta.json: every meeting's town, day and
    // still) and, when they name a municipality, the towns plane; the reach
    // chart reads the index too, for the colour of each dot
    const wantMeta = doc.blocks.some(b => BS_SCOPED.includes(b.kind) || (b.kind === "chart" && b.chart === "reach"));
    const wantTowns = doc.blocks.some(b => BS_SCOPED.includes(b.kind) && b.town);
    // the tape's own words, once per meeting: a reel's cuts that are not
    // moments, and every pull-quote, read their line off transcript.txt,
    // fetched beside the planes
    const linePids = [...new Set(doc.blocks.flatMap(b =>
      b.kind === "reel" ? b.clips.map(c => c.pid) : b.kind === "quote" ? [b.pid] : []))]
      .slice(0, PAPER_MAX_CLIPS);
    const [m, it, votesPlane, analytics, lineSets, metaPlane, townsPlane] = await Promise.all([
      fetchPlanes(mpids, "meetings", PAPER_MAX_BLOCKS + PAPER_MAX_CLIPS),
      fetchPlanes(islugs, "issues", PAPER_MAX_BLOCKS),
      wantVotes ? getJSON(`${BASE}/votes.json`) : Promise.resolve(null),
      wantAnalytics ? getJSON(`${BASE}/analytics.json`) : Promise.resolve(null),
      Promise.all(linePids.map(pid => segLines(pid).then(l => [pid, l]))),
      wantMeta ? getJSON(`${BASE}/search/meta.json`) : Promise.resolve(null),
      wantTowns ? getJSON(`${BASE}/towns.json`) : Promise.resolve(null),   // null when dark (edition() would hand back an empty list)
    ]);
    if (gen !== PAPER_GEN) return;     // a newer render superseded this one
    const mby = m.got, iby = it.got, tried = { m: m.tried, i: it.tried };
    PAPER_PLANES = { mby, iby };       // the writing desk reads what this render fetched
    // every fetched result is kept — null (the tape didn't load), [] (a tape
    // with no lines) and lines are three facts; only a pid never fetched
    // (past the cap) stays undefined
    const lines = {}; for (const [pid, l] of lineSets) lines[pid] = l;
    // the page's own meetings, in the order the blocks name them, and every
    // meeting an issue the page is about took up — the search box searches
    // inside exactly these
    const pagePids = [...mpids];
    for (const slug of islugs) for (const nd of (((iby[slug] || {}).timeline) || []))
      if (nd && PAPER_REF.test(nd.pid || "") && !pagePids.includes(nd.pid)) pagePids.push(nd.pid);
    const aux = { votes: votesPlane, analytics, lines, meta: metaPlane, towns: townsPlane, pids: pagePids };
    // the on-page editor (specs/23 A3): the DRAFT, in the studio, renders
    // as itself with the arranging chrome on it — a handle, ↑ ↓, ✕ per
    // block, the title in place, an insertion point between blocks. A
    // shared or stored paper never does: it stays exactly the reader.
    const editing = from === "draft" && shownMode() === "studio";
    el.classList.toggle("cz-editing", editing);
    // the print sheet spells every relative citation out whole (origin +
    // path) — the origin rides a custom property, not the markup
    el.style.setProperty("--site", JSON.stringify(location.origin));
    if (editing) {
      setTimeout(pvShow, 0);   // the stage's mark on a reel row survives the repaint
      // the municipalities, for the scoped blocks' frames (one cached fetch
      // of the towns plane — an edition path); the template's questions,
      // for the paragraphs' placeholders and the desk
      const ed = (await getJSON(`${BASE}/towns.json`)) || { towns: [] }; if (gen !== PAPER_GEN) return;
      PAPER_TOWNS = (ed.towns || []).map(x => String((x && x.town) || "")).filter(Boolean);
      ED_ASKS = ((TEMPLATES[doc.tpl] || {}).asks || []).length ? TEMPLATES[doc.tpl].asks : DESK_PROMPTS;
      // the draft may have moved under the awaits (a keystroke on this
      // page's own title or note, another tab): paint what stands NOW. A
      // changed shape starts over from the fresh draft; a changed title or
      // note text simply paints fresh — never a stale snapshot over a caret
      const fresh = readPaper();
      if (JSON.stringify(fresh.blocks.map(b => b.kind + (b.pid || b.slug || b.chart || "")))
          !== JSON.stringify(doc.blocks.map(b => b.kind + (b.pid || b.slug || b.chart || "")))) {
        renderPaperNow(); return; }
      doc = fresh;
      const n = doc.blocks.length;
      const paired = halfPairs(doc.blocks);
      const rows = doc.blocks.map((b, i) => edSlot(i)
        + edRow(withLayoutHTML(renderPaperBlock(b, mby, iby, tried, aux) || paperGone("a block"), b, mby, iby), b, i, n, paired.has(i)))
        .join("") + edSlot(n);
      const keep = captureEdFocus(el) || captureEdPanel(el);
      el.innerHTML = edHead(doc) + `<div class="cz-edgrid">${edShelf()}<div class="cz-edpage">${rows}</div>${edDesk(doc, mby)}</div>`;
      wireEditor(el);
      bsEditorPage();
      restoreEdFocus(el, PAGE_FOCUS || keep); PAGE_FOCUS = null;
      return;
    }
    // the kicker says what the page is made of, never who made it (specs/29:
    // the record keeps no reader identity — a front page is judged by its
    // receipts); the labels count what is the record's and what is the writer's
    const made = bsMadeFrom(doc, mby, iby);
    const head = `<header class="phead bs-phead">
        <p class="pb-kick">${esc(made.kind)}${made.towns.length === 1 ? ` · ${esc(made.towns[0])}` : ""}${made.pids.length ? ` · made from ${nOf(made.pids.length, "meeting", "meetings")}` : ""} · ${from === "draft" ? "your draft" : from === "stored" ? "shared as a short link" : "shared as a link"} · the writer is not named, by design</p>
        <h2 class="ptitle">${esc(printTitle(doc.title))}</h2>
        <p class="pfrom">${from === "draft"
          ? "your draft — it lives in this browser. EDIT, in the top bar, opens it in the editor; share it from there as a link or a file"
          : from === "stored"
            ? "served from the share store — content-addressed and read-only; the editor holds the original"
            : "carried whole in the link you followed — no server held it"}</p>
        ${made.labels.length ? `<p class="pb-labels">${made.labels.map(l => `<span>${esc(l)}</span>`).join("")}</p>` : ""}
      </header>`;
    const blocks = paintLayouts(doc.blocks.map(b =>
      [b, renderPaperBlock(b, mby, iby, tried, aux)]).filter(x => x[1]), mby, iby);
    // the foot says whose each part is; a page someone else shared carries
    // the door back into writing — the same receipts, the reader's own words
    const foot = blocks ? `<footer class="pb-foot"><p>${esc(made.foot)} · <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="license">CC BY-SA 4.0</a></p>${from !== "draft"
      ? `<p class="pb-door"><span class="pb-door-k">Disagree? Add to it?</span><b>Make your own from the same receipts</b><a class="pb-door-go" href="${BASE}/p#edit&amp;copy=${encodeURIComponent(encodePaperQS(doc))}">Start from this front page →</a></p>` : ""}</footer>` : "";
    // a title-only paper is a sanctioned form — say what it is, not that its
    // (nonexistent) blocks were curated away
    setTimeout(pvShow, 0);     // the stage's mark on a reel row survives the repaint
    el.innerHTML = head + (blocks ? blocks + foot : (doc.blocks.length
        ? `<p class="hint">This paper’s blocks aren’t in this pressing of the
            record — its meetings or issues may have been curated away. The
            <a href="${BASE}/">record itself</a> is one link up.</p>`
        : `<p class="hint">This paper is a title so far — its editor hasn’t
            added stories or reels yet. The <a href="${BASE}/">record
            itself</a> is one link up.</p>`));
  }
  /* what a page is made of, read off its blocks and the planes this render
     fetched: the kind of front page (by its lead), the towns of its meetings,
     its meetings, and the labels the head carries — who wrote which part */
  function bsMadeFrom(doc, mby, iby) {
    iby = iby || {};
    const pids = [];
    for (const b of doc.blocks) {
      const ps = b.kind === "reel" ? b.clips.map(c => c.pid) : (b.pid ? [b.pid] : []);
      for (const pid of ps) if (!pids.includes(pid)) pids.push(pid);
    }
    // the kind is claimed only where the shape bears it out — one meeting
    // means one; a page that opens on the record's strip is "the record,
    // over time", whatever template it began as
    const first = doc.blocks[0] || {};
    const kind = (first.kind === "lead" || (first.kind === "story" && first.story === "meeting" && first.layout === "lead")) && pids.length === 1 ? "One meeting"
      : first.kind === "story" && first.story === "issue" ? (doc.blocks[1] && doc.blocks[1].kind === "chart" && doc.blocks[1].chart === "ledger" ? "A vote and its history" : "An issue over time")
      : first.kind === "names" && first.who ? (first.who.startsWith("l-") ? "A place on the record" : first.who.startsWith("o-") ? "An organization on the record" : "A person on the record")
      : first.kind === "strip" && first.town && doc.blocks[1] && doc.blocks[1].kind === "strip" && doc.blocks[1].town && doc.blocks[1].town !== first.town ? "Two towns, side by side"
      : first.kind === "strip" || first.kind === "threads" ? "The record, over time"
      : first.kind === "chart" && first.chart === "votes" && !first.pid ? "The roll calls, watched"
      : "A front page";
    const towns = [...new Set(pids.map(pid => (mby[pid] || {}).town || "").filter(Boolean))];
    const paras = doc.blocks.filter(b => b.kind === "note" && b.text.trim())
      .reduce((n, b) => n + b.text.trim().split(/\n+/).filter(x => x.trim()).length, 0);
    // a reel's clips are clips — a cut that matches no scored moment is not a moment
    const clips = doc.blocks.filter(b => b.kind === "reel").reduce((n, b) => n + b.clips.length, 0);
    // the model's parts, counted and named: readings drafted by a model, and
    // issues a model named (the issue plane's name_origin, as the issue page
    // labels it) — the head and the foot say each, or say there were none
    const readings = doc.blocks.filter(b => b.kind === "reading" && b.pid && mby[b.pid]
      && /^ai:/.test(String((((mby[b.pid].analysis || {}).draft) || {}).origin || ""))).length;
    const named = new Set(doc.blocks.map(b => b.slug).filter(slug => slug && iby[slug]
      && /^ai:/.test(String(iby[slug].name_origin || "")))).size;
    const labels = ["counted by the record"];
    if (paras) labels.push(`${nOf(paras, "paragraph", "paragraphs")} by the writer`);
    if (clips) labels.push(`reel: ${nOf(clips, "clip", "clips")}, cited`);
    if (readings) labels.push(`${nOf(readings, "reading", "readings")} drafted by a model, labeled`);
    if (named) labels.push(`${nOf(named, "issue", "issues")} named by a model, labeled`);
    const model = [];
    if (readings) model.push(`${nOf(readings, "reading was", "readings were")} drafted by a model`);
    if (named) model.push(`${nOf(named, "issue’s name is", "issues’ names are")} a model’s`);
    const foot = `the counts and the pictures${clips ? " and the reel" : ""} are the record’s${paras ? " · the paragraphs are the writer’s" : ""} · ${model.length ? model.join(" and ") + " — each says so where it stands" : "nothing here was written by a model"}`;
    return { kind, pids, towns, labels, foot };
  }
  /* a block's section-head form (layout "head"): its name over a rule —
     a story's title linked into the record, a note's first line, a chart's
     or a reel's own kicker. Null when the plane that names it is not here
     (the ordinary render then says so in place). */
  function renderHead(b, mby, iby) {
    let text = "", href = "";
    if (b.kind === "story" && b.story === "meeting") {
      const m = mby[b.pid]; if (!m) return null;
      text = m.title || b.pid; href = `${BASE}/m/${b.pid}`;
    } else if (b.kind === "story" && b.story === "issue") {
      const it = iby[b.slug]; if (!it) return null;
      text = it.name || b.slug; href = `${BASE}/i/${b.slug}`;
    } else if (b.kind === "note") {
      text = (b.text || "").split("\n").find(l => l.trim()) || "";
      if (!text) return null;
    } else if (b.kind === "chart") text = chartRowLabel(b).replace(/^▤ /, "");
    else if (b.kind === "reel") text = `a reel — ${b.clips.length} moment${b.clips.length > 1 ? "s" : ""}`;
    else if (b.kind === "quote") {
      const m = mby[b.pid]; if (!m) return null;
      text = `${m.title || b.pid} · ${hms(b.t)}`; href = `${BASE}/m/${b.pid}#t${Math.floor(b.t)}`;
    } else if (b.kind === "doc") {
      const m = mby[b.pid]; if (!m) return null;
      const d = (m.documents || []).find(x => x && x.doc_id === b.doc);
      text = d ? (d.title || b.doc) : ""; href = d && d.url ? d.url : `${BASE}/m/${b.pid}`;
    } else if (b.kind === "digest") {
      const it = iby[b.slug]; if (!it) return null;
      text = `what changed — ${it.name || b.slug}`; href = `${BASE}/i/${b.slug}`;
    } else if (b.kind === "lead") {
      const m = mby[b.pid]; if (!m) return null;
      text = m.title || b.pid; href = `${BASE}/m/${b.pid}`;
    } else if (BS_KINDS.includes(b.kind)) text = blockLabel(b).replace(/^\S+ /, "");
    if (!text) return null;
    const inner = href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
    return `<h3 class="pb-head">${inner}</h3>`;
  }
  /* one block, its layout painted: lead grows, head becomes its name,
     half is marked for pairing */
  function withLayoutHTML(html, b, mby, iby) {
    if (b.layout === "lead") return `<div class="pb-lead">${html}</div>`;
    if (b.layout === "head") {
      const head = renderHead(b, mby, iby);
      // a story's head IS the story (a name that links to it); anything
      // with a body of its own — a note, a chart, a reel — keeps its body
      // under the head, so a layout never discards the editor's words
      return head ? (b.kind === "story" ? head : head + html) : html;
    }
    if (b.layout === "half") return `<div class="pb-half">${html}</div>`;
    return html;
  }
  /* the reader's page: two consecutive halves share a row; everything
     else stacks as it always did */
  /* which blocks the reader's page pairs: two consecutive halves, taken two
     at a time — paintLayouts' own rule; the editor marks exactly these */
  const halfPairs = blocks => { const s = new Set();
    for (let i = 0; i < blocks.length - 1; i++)
      if (blocks[i].layout === "half" && blocks[i + 1].layout === "half") { s.add(i); s.add(i + 1); i++; }
    return s; };
  function paintLayouts(pairs, mby, iby) {
    const out = [];
    for (let i = 0; i < pairs.length; i++) {
      const [b, html] = pairs[i];
      if (b.layout === "half" && pairs[i + 1] && pairs[i + 1][0].layout === "half") {
        out.push(`<div class="pb-pair">${withLayoutHTML(html, b, mby, iby)}`
          + `${withLayoutHTML(pairs[i + 1][1], pairs[i + 1][0], mby, iby)}</div>`);
        i++;
      } else out.push(withLayoutHTML(html, b, mby, iby));
    }
    return out.join("");
  }
  /* the pressed transcript.txt, read as lines: [{t, spk, text}], sorted;
     one fetch per meeting, cached. Total over garbage — a line that is not
     "[H:MM:SS] words" is simply not a line. */
  const SEGL = {};
  function segLines(pid) {
    if (!pid) return Promise.resolve([]);
    if (SEGL[pid]) return Promise.resolve(SEGL[pid]);
    // null when the tape did not load here (a different fact from a tape
    // with no lines, which is []) — a dark tape is asked for again next time
    return fetch(`${BASE}/m/${encodeURIComponent(pid)}/transcript.txt`)
      .then(r => r.ok ? r.text() : null).catch(() => null)
      .then(tx => { if (tx == null) return null; const l = parseSegLines(tx); if (l.length) SEGL[pid] = l; return l; });
  }
  function parseSegLines(tx) {
    const out = [];
    for (const line of String(tx || "").split("\n")) {
      const m = /^\[(\d+):(\d\d)(?::(\d\d))?\]\s*(.*)$/.exec(line);
      if (!m) continue;
      const t = m[3] == null ? +m[1] * 60 + +m[2] : +m[1] * 3600 + +m[2] * 60 + +m[3];
      const sp = /^([^:]{1,40}):\s+(.*)$/.exec(m[4]);
      out.push({ t, spk: sp ? sp[1].trim() : "", text: (sp ? sp[2] : m[4]).trim() });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  /* the line at or before a time — the pressed text is whole seconds */
  const lineAt = (lines, t) => { let hit = null;
    for (const l of (lines || [])) { if (l.t <= Math.floor(t) + 0.01) hit = l; else break; }
    return hit; };
  /* the lines AT a second: the pressed tape stamps whole seconds, so two
     short lines can share one — a quote by (pid, t) is every line the record
     holds at that second, or the line running through it */
  const linesAt = (lines, t) => {
    const s = Math.floor(t), same = (lines || []).filter(l => l.t === s && l.text);
    if (same.length) return same;
    const l = lineAt(lines, t); return l && l.text ? [l] : [];
  };
  /* C2 renders: every one a ref resolved against the record's own planes,
     in the paper palette; a plane that is not here says so in place */
  function renderQuote(b, mby, aux) {
    const m = mby[b.pid];
    if (!m) return (aux.tried && aux.tried.m.has(b.pid)) ? paperGone(`a line of ${b.pid}`) : paperBudget("a quote");
    const lines = (aux.lines || {})[b.pid];
    // three different facts, each said as itself: the tape did not load
    // here (dark), the tape was past this page's fetch cap, the tape holds
    // no line at that second
    if (lines === null) return paperDark(`the tape of ${m.title || b.pid}`, `the line at ${hms(b.t)} reads on the meeting’s own page`);
    if (!lines) return paperBudget("a quote");
    const ls = linesAt(lines, b.t);
    if (!ls.length) return paperGone(`a line at ${hms(b.t)} of ${m.title || b.pid}`);
    const spk = [...new Set(ls.map(l => l.spk).filter(Boolean))];
    const body = ls.length === 1 ? `<p>“${esc(ls[0].text)}”</p>`
      : ls.map(l => `<p>${l.spk ? `<span class="pb-quote-spk">${esc(l.spk)}:</span> ` : ""}“${esc(l.text)}”</p>`).join("");
    const cite = `${BASE}/m/${esc(b.pid)}#t${Math.floor(b.t)}`;
    return `<figure class="pb-quote"><blockquote>${body}</blockquote>
      <figcaption>${ls.length === 1 && spk.length ? `<span class="pb-quote-spk">${esc(spk[0])}</span> · ` : ""}<a href="${cite}">${esc(m.title || b.pid)} · ${hms(b.t)}</a></figcaption></figure>`;
  }
  function renderDoc(b, mby, tried) {
    const m = mby[b.pid];
    if (!m) return tried.m.has(b.pid) ? paperGone(`a document of ${b.pid}`) : paperBudget("a document");
    const d = (m.documents || []).find(x => x && x.doc_id === b.doc);
    if (!d) return paperGone(`a document (${b.doc}) of ${m.title || b.pid}`);
    const inner = `<span class="pb-doc-k">📄 ${esc(d.kind || "document")}</span>`
      + `<b>${esc(d.title || b.doc)}</b>`
      + `<span class="pb-doc-m">${esc([m.title || b.pid, d.date, d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "))}</span>`;
    return d.url
      ? `<a class="pb-doc" href="${esc(d.url)}" target="_blank" rel="noopener"
           aria-label="${esc(d.kind || "document")} — ${esc(d.title || b.doc)} (opens in a new tab)">${inner}</a>`
      : `<div class="pb-doc">${inner}</div>`;
  }
  function renderDigest(b, iby, tried) {
    const it = iby[b.slug];
    if (!it) return tried.i.has(b.slug) ? paperGone(`an issue (${b.slug})`) : paperBudget("a digest");
    // the timeline parks undated meetings at its tail — "the last n" means
    // the newest n BY DATE, and the undated are counted, not ranked
    const tl = (it.timeline || []).filter(n => n && typeof n === "object");
    if (!tl.length) return paperGone(`appearances of ${it.name || b.slug}`);
    const dated = tl.filter(n => n.date).sort((a, c) => (c.date > a.date ? 1 : c.date < a.date ? -1 : 0));
    const undated = tl.length - dated.length;
    // none dated at all: the timeline's own last n, each said as undated —
    // present in the pressing, never "curated away"
    const nodes = dated.length ? dated.slice(0, b.n) : tl.slice(-b.n).reverse();
    const rows = nodes.map(n => {
      const bead = (n.beads || [])[0];
      const at = `${BASE}/m/${esc(n.pid)}${bead ? `#t${Math.floor(bead.t)}` : ""}`;
      return `<a class="pb-dg" href="${at}">
        <span class="pb-dg-d">${esc(n.date || "undated")}</span>
        <span class="pb-dg-b">${esc(n.body || n.title || n.pid)} · ${n.n || 0} moment${n.n === 1 ? "" : "s"}</span>
        ${bead ? `<span class="pb-dg-q">${esc((bead.text || "").slice(0, 140))}</span>` : ""}</a>`;
    }).join("");
    return `<section class="pb-digest">
      <div class="sectionhead"><span class="kicker">what changed — <a href="${BASE}/i/${esc(b.slug)}">${esc(it.name || b.slug)}</a>, ${dated.length ? `the last ${nodes.length === 1 ? "appearance" : nodes.length + " appearances"}` : `${nodes.length === 1 ? "an undated appearance" : nodes.length + " undated appearances"}`}</span></div>
      <div class="pb-dgs">${rows}</div>
      <p class="pb-chartsrc">computed from the issue’s own timeline when this paper rendered${dated.length ? (undated ? ` — ${undated} undated appearance${undated === 1 ? "" : "s"} not ranked here` : "") : " — none of its appearances is dated, so its last ones stand here, latest-added first"} — the full long view reads on the issue’s page</p>
    </section>`;
  }
  /* one block, drawn — or, when a plane holds a shape this reader cannot
     draw, one honest sentence in its place: a throw would take the whole
     page down with it (decodeReel's law, at the render) */
  function renderPaperBlock(b, mby, iby, tried, aux) {
    try { return renderBlockInner(b, mby, iby, tried, aux); }
    catch (e) { return paperDark(`a ${esc(String((b && b.kind) || "block"))} block`, "its plane held a shape this reader could not draw"); }
  }
  function renderBlockInner(b, mby, iby, tried, aux) {
    tried = tried || { m: new Set(), i: new Set() };
    aux = aux || {};
    if (b.kind === "note") {
      const text = (b.text || "").trim();
      // only the editor's own draft can hold an empty note (no traveling
      // form carries one) — say what it is instead of rendering a void
      if (!text) return `<section class="pb-note pb-note-empty">
        <span class="kicker">what it means — the writer</span>
        <p class="hint">an empty paragraph — press EDIT and write it</p></section>`;
      const paras = text.split(/\n+/).map(s => `<p>${esc(s)}</p>`).join("");
      // labeled out loud: a note is the one block that is the WRITER's words,
      // not the record's — a reader must never mistake the two (board 6:
      // "What it means — the writer")
      return `<section class="pb-note"><span class="kicker">what it means — the writer</span>
        ${paras}</section>`;
    }
    if (b.kind === "chart") return renderChartBlock(b, mby, iby, tried, aux);
    if (b.kind === "reading") return renderReading(b, mby, iby, tried);
    // specs/29: the broadsheet's blocks
    if (b.kind === "lead") return renderLead(b, mby, tried);
    if (b.kind === "week") return renderWeek(b, aux);
    if (b.kind === "threads") return renderThreads(b, aux);
    if (b.kind === "strip") return renderStrip(b, aux);
    if (b.kind === "names") return renderNames(b, aux);
    if (b.kind === "search") return renderSearchBox(b, aux);
    if (b.kind === "quote") return renderQuote(b, mby, { ...aux, tried });
    if (b.kind === "doc") return renderDoc(b, mby, tried);
    if (b.kind === "digest") return renderDigest(b, iby, tried);
    if (b.kind === "story" && b.story === "meeting") {
      const m = mby[b.pid];
      if (!m) return tried.m.has(b.pid)
        ? paperGone(`a meeting (${b.pid})`)
        : paperBudget("a meeting");
      return `<a class="mcard pb-story" href="${BASE}/m/${esc(b.pid)}">`
        + ((m.still || m.thumb) ? `<img loading="lazy" src="${esc(m.still || m.thumb)}" alt="" width="96" height="54">` : "")
        + `<div class="mc-body"><span class="chip">${esc(m.body || "meeting")}</span>`
        + `<b>${esc(m.title || b.pid)}</b>`
        + `<span class="mc-meta">${esc([m.date, m.town].filter(Boolean).join(" · "))}</span>`
        + `</div></a>`;
    }
    if (b.kind === "story" && b.story === "issue") {
      const it = iby[b.slug];
      if (!it) return tried.i.has(b.slug)
        ? paperGone(`an issue (${b.slug})`)
        : paperBudget("an issue");
      const span = [it.first_seen, it.last_seen].filter(Boolean);
      return `<a class="mcard pb-story" href="${BASE}/i/${esc(b.slug)}">`
        + `<div class="mc-body"><span class="chip">issue</span>`
        + `<b>${esc(it.name || b.slug)}</b>`
        + `<span class="mc-meta">${it.n_meetings || 0} meeting${it.n_meetings === 1 ? "" : "s"}`
        + (span.length ? ` · ${esc(span.join(" — "))}` : "")
        // the issue page's own label, carried: a model named this issue
        + (/^ai:/.test(String(it.name_origin || "")) ? ` · <span class="pb-origin">named by a model</span>` : "") + `</span>`
        + `</div></a>`;
    }
    if (b.kind === "reel") {
      const clips = b.clips.map(c => {
        const m = mby[c.pid]; if (!m) return null;
        const mo = momentFor(m.moments || [], c.start, c.end);
        const dur = +m.duration || 0;
        const end = dur ? Math.min(c.end, dur) : c.end;
        if (end <= c.start) return null;
        const lines = (aux.lines || {})[c.pid];
        return { ...c, end, t: mo ? r1(mo.t) : c.start,
                 kind: mo ? mo.kind : "cut",
                 quote: mo ? mo.quote : (lines ? cut((lineAt(lines, c.start) || {}).text || "", 120) : ""),
                 mtitle: m.title || "", video_id: m.video_id || "" };
      }).filter(Boolean);
      if (!clips.length)
        return b.clips.some(c => !tried.m.has(c.pid))
          ? paperBudget("a reel") : paperGone("a reel (its meetings)");
      const multi = reelPids(clips).length > 1;
      // each cite is a link into the record; beside it (a sibling, never a
      // control inside a link) a ▶ that plays the clip in the studio's
      // preview stage — painted only in studio mode, the paper's own
      // deep green, so the rendered paper stays as quiet as today
      const rows = clips.map((c, i) =>
        `<div class="pb-cite"><a class="reelcite" href="${BASE}/m/${esc(c.pid)}#t${Math.floor(c.t)}">
          <span class="rc-ord">${i + 1}</span>
          <span class="rc-body">${multi ? `<span class="rc-from">${esc(c.mtitle || c.pid)}</span>` : ""}
            <span class="rc-quote">${esc(c.quote || "(moment)")}</span>
            <span class="rc-meta"><span class="rt-kind">${esc(c.kind)}</span>
              <span class="ts">${hms(c.start)}</span>–<span class="ts">${hms(c.end)}</span></span>
          </span></a>${c.video_id ? `<button type="button" class="pb-pv" data-pvpid="${esc(c.pid)}"
            data-pvvid="${esc(c.video_id)}" data-pvstart="${r1(c.start)}" data-pvend="${r1(c.end)}"
            data-pvt="${r1(c.t)}" data-pvkind="${esc(c.kind)}" data-pvquote="${esc(cut(String(c.quote || ""), 120))}"
            data-pvmtitle="${esc(c.mtitle)}" data-pvkey="${esc(clipKey({ pid: c.pid, kind: c.kind, t: c.t }))}"
            title="preview this clip in the studio" aria-label="preview clip ${i + 1} in the studio">▶</button>` : ""}</div>`).join("");
      return `<section class="pb-reel">
          <div class="sectionhead"><span class="kicker">a reel —
            ${clips.length} moment${clips.length > 1 ? "s" : ""}${multi
              ? ` across ${reelPids(clips).length} meetings` : ""}
            · ${hms(reelRuntime(clips))}</span></div>
          <div class="reelcitelist">${rows}</div>
          <p class="pb-play"><a class="btn primary"
            href="${esc(reelShareURL(clips))}">▶ play this reel</a></p>
        </section>`;
    }
    return "";
  }
  /* ---- the broadsheet's blocks (specs/29 P1) -------------------------------
     Six blocks in the board's grammar, every one computed HERE from the
     record's own planes — the meeting plane, the index (search/meta.json),
     analytics.json, towns.json — in the paper palette (ink, rust, the
     municipality's colour), a receipt on every mark and an honest sentence
     where a plane did not arrive. The words that count things follow the
     press's (web/story.py hours_prose, day_name) so a page reads the same
     whether the press or the reader set it. */
  const PB = { ink: "#191712", ink2: "#4B473E", muted: "#6F6A5B", rule: "#D9D1BF", rust: "#B23A1D", card: "#FBF9F4" };   // web/charts.py's constants — a twin holds them equal
  const BS_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const BS_TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
  const bsNumberWords = n => { n = Math.floor(+n || 0);
    if (n < 20) return BS_ONES[n]; if (n < 60) return BS_TENS[Math.floor(n / 10)] + (n % 10 ? `-${BS_ONES[n % 10]}` : ""); return String(n); };
  /* "two hours and forty-six minutes" — web/story.py hours_prose */
  function bsHoursProse(seconds) {
    const s = Math.floor(+seconds || 0), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const hw = h ? `${bsNumberWords(h)} hour${h === 1 ? "" : "s"}` : "", mw = m ? `${bsNumberWords(m)} minute${m === 1 ? "" : "s"}` : "";
    return hw && mw ? `${hw} and ${mw}` : hw || mw || "under a minute";
  }
  /* "2 h 46 min" — web/story.py hours_words */
  const bsHoursShort = seconds => { const s = Math.floor(+seconds || 0), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`; };
  const BS_DRIFT = { rising: "rising", fading: "fading", steady: "steady through the night" };
  const bsMoneyLabel = s => String(s || "").trim().replace(/[.,;: ]+$/, "");
  const BS_ARTIFACTS = new Set(["clears throat", "music", "applause", "laughter", "mhm", "um", "uh", "inaudible", "crosstalk", "foreign", "silence",
    "good evening", "good morning", "good afternoon", "good night", "thank you", "thanks", "hello", "welcome", "okay", "yeah", "everybody", "everyone",
    "next slide", "point of order", "roll call", "madam president", "mr president", "mister president", "madam chair", "mr chair",
    "madam clerk", "mr clerk", "madam mayor", "mr mayor", "councilor", "council president"]);   // web/charts.py ARTIFACTS
  /* the ISO day n days before a day — the week's window (web/broadsheet.py week_section) */
  const bsDaysBefore = (date, n) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(date || "")); if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - n)); return isNaN(d) ? "" : d.toISOString().slice(0, 10); };
  /* the three moments that decided a meeting: the loudest roll call,
     decision or pushback, never two from one second — the template's rule */
  function bsTopMoments(m, n) {
    const top = [], secs = new Set();
    for (const mo of (m.moments || [])
        .filter(mo => mo && typeof mo.t === "number" && ["vote", "decision", "tension"].includes(mo.kind))
        .sort((a, c) => (+c.score || 0) - (+a.score || 0))) {
      if (secs.has(Math.floor(mo.t))) continue;
      secs.add(Math.floor(mo.t)); top.push(mo);
      if (top.length === n) break;
    }
    return top;
  }
  /* pid → town, from the index this render fetched (empty when it did not) */
  const bsTownBy = meta => { const by = Object.create(null);
    for (const m of (Array.isArray(meta) ? meta : [])) if (m && m.pid) by[m.pid] = String(m.town || ""); return by; };
  /* a scoped block's municipality: the town whose slug the block names, off
     the towns plane. Three honest answers: no scope; a town; or "not in this
     pressing" — and a towns plane that did not load is said as that, with
     every town shown, never a silent guess (a block scoped to a town the
     index cannot place its meetings in shows every town too, and says so) */
  function bsScopeOf(b, aux) {
    if (!b.town) return { town: "", note: "" };
    const towns = aux.towns && Array.isArray(aux.towns.towns) ? aux.towns.towns.map(t => String((t && t.town) || "")) : null;
    if (!towns) return { town: "", note: "the towns plane didn’t load here — every town shows" };
    const town = towns.find(t => bsSlug(t) === b.town);
    if (!town) return { gone: paperGone(`a municipality (${b.town})`) };
    if (!Array.isArray(aux.meta)) return { town: "", note: `the record’s index didn’t load here, so ${town} could not be told apart — every town shows` };
    return { town, note: "" };
  }
  const bsTownTail = sc => sc.town ? ` — ${esc(sc.town)}` : "";
  /* the lead story: the meeting told large — its still, its counted lede
     (the tape's length, the lens that framed it, the roll calls read, the
     money named), the three moments that decided it, every one a receipt */
  function renderLead(b, mby, tried) {
    const m = mby[b.pid];
    if (!m) return tried.m.has(b.pid) ? paperGone(`a meeting (${b.pid})`) : paperBudget("the lead story");
    const href = `${BASE}/m/${esc(b.pid)}`, town = m.town || "", an = m.analysis || {};
    const pic = m.still
      ? `<img src="${esc(m.still)}" alt="" loading="lazy" width="960" height="540">`
      : `<span class="bs-nostill" style="background:${bsTownLight(town)}"></span>`;
    const fr = an.framing || {}, ftot = Math.floor(+fr.total || 0);
    const lenses = (fr.lenses || []).filter(l => l && +l.count > 0).slice()
      .sort((a, c) => (+c.count - +a.count) || (String(a.lens) < String(c.lens) ? -1 : 1));
    const parts = [`${bsHoursProse(m.duration)} of tape`];
    if (lenses.length && ftot) parts.push(`of ${ftot} words the record files under a lens, ${Math.floor(+lenses[0].count)} were ${esc(lenses[0].lens)} and ${BS_DRIFT[lenses[0].drift] || "steady"}`);
    const nv = (m.votes || []).length;
    if (nv) parts.push(`${nOf(nv, "roll call", "roll calls")} read from the tape`);
    const money = ((an.entities || {}).money || []).filter(e => e && e.name).slice(0, 3).map(e => esc(bsMoneyLabel(e.name)));
    if (money.length) parts.push(`money named: ${money.join(", ")}`);
    const moments = bsTopMoments(m, 3).map(mo =>
      `<li><a href="${href}#t${Math.floor(mo.t)}"><span class="ts">▶ ${hms(mo.t)}</span> <span class="pb-lead-q">“${esc(cut(String(mo.quote || ""), 140))}”</span> <span class="pb-rdtag">${esc(SHAPE_KINDS[mo.kind] || mo.kind || "moment")}</span></a></li>`).join("");
    return `<article class="pb-leadstory" style="--town:${bsTown(town)}">
      <a class="pb-lead-pic" href="${href}" aria-hidden="true" tabindex="-1">${pic}</a>
      <div class="pb-lead-body">
        <span class="pb-kick">${esc([town, m.body, tpDay(m.date)].filter(Boolean).join(" · "))}</span>
        <h3 class="pb-lead-t"><a href="${href}">${esc(m.title || b.pid)}</a></h3>
        <p class="pb-lead-lede">${parts.map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(". ")}.</p>
        ${moments ? `<ol class="pb-lead-moments" aria-label="the moments that decided it">${moments}</ol>` : ""}
        <p class="pb-chartsrc">counted from the meeting’s own pressed plane — every line opens the tape where it was said. <a href="${href}">the meeting</a> holds the whole night</p>
      </div></article>`;
  }
  /* this week: the seven days to the record's latest meeting, as cards with
     their stills — or, when that week holds fewer than three, the latest
     five (the front page's own rule, web/broadsheet.py week_section) */
  function renderWeek(b, aux) {
    const sc = bsScopeOf(b, aux); if (sc.gone) return sc.gone;
    const kicker = `this week on the record${bsTownTail(sc)}`;
    if (!Array.isArray(aux.meta))
      return chartUnfetched(kicker, `the record’s index didn’t load here — <a href="${BASE}/">the front page</a> keeps the week`);
    const rows = aux.meta.filter(m => m && PAPER_REF.test(m.pid || "") && TP_DAY.test(m.date || "") && (!sc.town || String(m.town || "") === sc.town))
      .sort((a, c) => (c.date > a.date ? 1 : c.date < a.date ? -1 : 0) || (c.pid > a.pid ? 1 : c.pid < a.pid ? -1 : 0));
    if (!rows.length)
      return chartShell(kicker, "", `<p class="hint">The record holds no dated meeting${sc.town ? ` for ${esc(sc.town)}` : ""} yet.</p>`, "", "");
    const since = bsDaysBefore(rows[0].date, 7);
    let week = rows.filter(m => m.date > since);
    const fell = week.length < 3;
    if (fell) week = rows.slice(0, 5);
    const inWeek = week.length;
    week = week.slice(0, 8);
    const cards = week.map(m => `<a class="mcard bs-week-card pb-wkcard" href="${BASE}/m/${esc(m.pid)}" style="--town:${bsTown(m.town)}">${m.still
        ? `<img src="${BASE}/stills/${encodeURIComponent(m.pid)}.jpg" alt="" loading="lazy" width="480" height="270">`
        : `<span class="bs-nostill" style="background:${bsTownLight(m.town)}"></span>`}<span class="bs-wkbody">
      <span class="bs-wkkick">${esc([m.town, m.body].filter(Boolean).join(" · "))}</span><b>${esc(m.title || m.pid)}</b>
      <span class="bs-wkmeta">${esc(tpDay(m.date))} · ${bsHoursShort(m.duration)}</span></span></a>`).join("");
    return chartShell(fell ? `the latest on the record${bsTownTail(sc)}` : kicker,
      (fell ? `the record’s latest ${nOf(week.length, "meeting", "meetings")}` : `the seven days to ${esc(tpDay(rows[0].date))} — ${inWeek > week.length ? `the newest ${week.length} of ${nOf(inWeek, "meeting", "meetings")}` : nOf(week.length, "meeting", "meetings")}`) + (sc.note ? ` · ${esc(sc.note)}` : ""),
      `<div class="mcards bs-weekrow pb-week">${cards}</div>`, "",
      `from the record’s own index when this page rendered — <a href="${BASE}/">the front page</a> keeps the week`);
  }
  /* threads: the six widest recurring topics as small multiples — what
     keeps coming back, how often, and when, month by month; each tells its
     story on the search page (web/broadsheet.py threads_section) */
  function renderThreads(b, aux) {
    const sc = bsScopeOf(b, aux); if (sc.gone) return sc.gone;
    const kicker = `threads — what keeps coming back${bsTownTail(sc)}`;
    const an = aux.analytics;
    if (!an) return chartUnfetched(kicker, `the record’s analytics plane didn’t load here — <a href="${BASE}/analytics">the record, drawn</a> reads in place`);
    const townBy = bsTownBy(aux.meta);
    const inTown = r => !sc.town || townBy[r.pid] === sc.town;
    const tops = (an.topics || []).filter(t => t && String(t.topic || "").trim() && !BS_ARTIFACTS.has(String(t.topic).trim().toLowerCase()))
      .map(t => ({ name: String(t.topic).trim(), count: Math.floor(+t.count || 0),
                   meetings: (t.meetings || []).filter(x => x && PAPER_REF.test(x.pid || "") && inTown(x)) }))
      .filter(t => t.meetings.length)
      .sort((a, c) => c.meetings.length - a.meetings.length || c.count - a.count || (a.name < c.name ? -1 : 1)).slice(0, 6);
    if (!tops.length)
      return chartShell(kicker, "", `<p class="hint">Nothing recurs${sc.town ? ` in ${esc(sc.town)}` : ""} yet — the record is young.</p>`, "",
        `from <a href="${BASE}/analytics">the record, drawn</a>`);
    const months = tpMonthRange(tops.flatMap(t => t.meetings.map(x => x.date)).filter(tpIsMonth).map(d => String(d).slice(0, 7)));
    const cards = tops.map(t => {
      const counts = months.map(mo => t.meetings.filter(x => String(x.date || "").slice(0, 7) === mo).length);
      const q = `${BASE}/s?q=${encodeURIComponent(t.name)}${sc.town ? `&town=${encodeURIComponent(sc.town)}` : ""}`;
      // the plane's mention count is the whole record's and a sum over each
      // meeting's most-said topics: inside a town it cannot be rescoped, so
      // it is not shown; elsewhere it reads "at least"
      return `<a class="pb-thread" href="${q}"><b>${esc(t.name)}</b><span class="pb-thread-n">${sc.town ? "" : `at least ${nOf(t.count, "mention", "mentions")} · `}${nOf(t.meetings.length, "meeting", "meetings")}</span>
        ${bsSpark(months, counts, PB.ink, true)}<span class="pb-thread-go">tell its story →</span></a>`; }).join("");
    const twin = `<thead><tr><th>thread</th>${sc.town ? "" : "<th>mentions, at least</th>"}<th>meetings</th></tr></thead><tbody>`
      + tops.map(t => `<tr><td>${esc(t.name)}</td>${sc.town ? "" : `<td>${t.count}</td>`}<td>${t.meetings.length}</td></tr>`).join("") + `</tbody>`;
    return chartShell(kicker, `the ${tops.length === 1 ? "one thread" : `${bsNumberWords(tops.length)} widest threads`}, by the meetings that took them up${months.length ? ` — ${TP_MON[+months[0].slice(5, 7)]} to ${TP_MON[+months[months.length - 1].slice(5, 7)]}` : ""}${sc.note ? ` · ${esc(sc.note)}` : ""}`,
      `<div class="pb-threads">${cards}</div>`, twin,
      `counted from <a href="${BASE}/analytics">the record, drawn</a> — a mention count is summed over each meeting’s most-said topics, so it is a floor; every thread opens its search, told as a story`);
  }
  /* how they talked: one bar per meeting, in date order, its eight lens
     shares side by side in the analyzer's own colours — the record's
     framing, meeting by meeting (web/charts.py framing_strip) */
  function renderStrip(b, aux) {
    const sc = bsScopeOf(b, aux); if (sc.gone) return sc.gone;
    const kicker = `how they talked — the lens strip${bsTownTail(sc)}`;
    const an = aux.analytics;
    if (!an) return chartUnfetched(kicker, `the record’s analytics plane didn’t load here — <a href="${BASE}/analytics">the record, drawn</a> reads in place`);
    const townBy = bsTownBy(aux.meta), order = Array.isArray(an.lens_order) ? an.lens_order : [], color = an.lens_color || {};
    const rows = (an.framing || []).filter(r => r && PAPER_REF.test(r.pid || "") && Math.floor(+r.total || 0) > 0)
      .map(r => ({ ...r, town: townBy[r.pid] || "" })).filter(r => !sc.town || r.town === sc.town)
      .sort((a, c) => (String(a.date || "") < String(c.date || "") ? -1 : String(a.date || "") > String(c.date || "") ? 1 : 0) || (a.pid < c.pid ? -1 : 1));
    if (!rows.length || !order.length)
      return chartShell(kicker, "", `<p class="hint">The framing strip needs a read meeting${sc.town ? ` in ${esc(sc.town)}` : ""}.</p>`, "",
        `from <a href="${BASE}/analytics">the record, drawn</a>`);
    const legend = `<p class="pb-lenskey">${order.map(l => `<span><i style="background:${esc(color[l] || PB.ink)}"></i>${esc(l)}</span>`).join("")}</p>`;
    const bars = rows.map(r => {
      const lz = r.lenses || {}, total = Math.max(1, Math.floor(+r.total || 0));
      const segs = order.map(l => { const n = Math.floor(+lz[l] || 0); return n ? `<i style="width:${(100 * n / total).toFixed(1)}%;background:${esc(color[l] || PB.ink)}" title="${esc(l)}: ${n}"></i>` : ""; }).join("");
      const said = order.map(l => `${l} ${Math.floor(+lz[l] || 0)}`).join(", ");
      return `<a class="pb-striprow" href="${BASE}/m/${esc(r.pid)}#framing" style="--town:${bsTown(r.town)}">
        <span class="pb-strip-d">${esc(bsDayShort(r.date))}</span><span class="pb-strip-b">${esc([r.town, r.body].filter(Boolean).join(" · "))}</span>
        <span class="pb-strip-bar" role="img" aria-label="${esc(r.title || r.pid)} — ${esc(said)}">${segs}</span><span class="pb-strip-n">${total}</span></a>`; }).join("");
    const twin = `<thead><tr><th>meeting</th>${order.map(l => `<th>${esc(l)}</th>`).join("")}<th>words</th></tr></thead><tbody>`
      + rows.map(r => `<tr><td>${esc(bsDayShort(r.date))} · ${esc(r.body || r.pid)}</td>${order.map(l => `<td>${Math.floor(+(r.lenses || {})[l] || 0)}</td>`).join("")}<td>${Math.floor(+r.total || 0)}</td></tr>`).join("") + `</tbody>`;
    return chartShell(kicker, `${nOf(rows.length, "meeting", "meetings")} in date order — each bar is one night’s words the record files under a lens, its eight shares side by side${sc.note ? ` · ${esc(sc.note)}` : ""}`,
      legend + `<div class="pb-strip">${bars}</div>`, twin,
      `counted from <a href="${BASE}/analytics">the record, drawn</a> — every bar opens its meeting’s framing`);
  }
  /* who and where: the names and places the record keeps hearing — two
     columns, each name a search told as a story — or ONE of them (who): when
     it was named, how often, in which meetings, month by month */
  function renderNames(b, aux) {
    const sc = bsScopeOf(b, aux); if (sc.gone) return sc.gone;
    const an = aux.analytics;
    const kicker = b.who ? "on the record" : `who and where${bsTownTail(sc)}`;
    if (!an) return chartUnfetched(kicker, `the record’s analytics plane didn’t load here — <a href="${BASE}/analytics">the record, drawn</a> reads in place`);
    const townBy = bsTownBy(aux.meta);
    const inTown = r => !sc.town || townBy[r.pid] === sc.town;
    const names = (an.names || []).filter(n => n && n.name && typeof n.name === "string")
      .map(n => ({ name: n.name, kind: String(n.kind || "people"), count: Math.floor(+n.count || 0), slug: String(n.slug || bsWho(n.kind, n.name)),
                   meetings: (n.meetings || []).filter(x => x && PAPER_REF.test(x.pid || "") && inTown(x)) }))
      .filter(n => n.meetings.length);
    const searchOf = n => `${BASE}/s?q=${encodeURIComponent(n.name)}${sc.town ? `&town=${encodeURIComponent(sc.town)}` : ""}`;
    const KIND = { people: "a person", places: "a place", organizations: "an organization" };
    if (b.who) {
      const one = names.find(n => n.slug === b.who);
      if (!one) return paperGone(`a name (${b.who})`);
      const dated = one.meetings.filter(x => tpIsMonth(x.date)).slice().sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : 0));
      const months = tpMonthRange(dated.map(x => String(x.date).slice(0, 7)));
      const counts = months.map(mo => dated.filter(x => String(x.date).slice(0, 7) === mo).length);
      const sorted = one.meetings.slice().sort((a, c) => (String(c.date || "") > String(a.date || "") ? 1 : String(c.date || "") < String(a.date || "") ? -1 : 0));
      // a time of 0:00 is a plane with no time for the mention, not a moment
      const rows = sorted.slice(0, 12).map(x =>
        `<a class="pb-rdrow" href="${BASE}/m/${esc(x.pid)}${+x.t > 0 ? `#t${Math.floor(+x.t)}` : ""}">${+x.t > 0 ? `<span class="ts">${hms(+x.t)}</span>` : ""}<span class="pb-rdtag">${esc(bsDayShort(x.date))}</span> ${esc(townBy[x.pid] || "")}${townBy[x.pid] ? " · " : ""}${+x.t > 0 ? `first named at ${hms(+x.t)}` : "named that night"}</a>`).join("");
      // the count is a sum over the meetings where the name was among the
      // most-said — a floor, said as one; inside a town it cannot be rescoped
      const said = sc.town ? `named in ${nOf(one.meetings.length, "meeting", "meetings")}` : `named at least ${nOf(one.count, "time", "times")} across ${nOf(one.meetings.length, "meeting", "meetings")}`;
      return `<section class="pb-chart pb-who" style="--town:${PB.ink}">
        <div class="sectionhead"><span class="kicker">${esc(KIND[one.kind] || "a name")} on the record — ${esc(one.name)}</span></div>
        <p class="pb-chartsub">${said}${months.length ? `, ${TP_MON[+months[0].slice(5, 7)]} to ${TP_MON[+months[months.length - 1].slice(5, 7)]}` : ""}${sc.note ? ` · ${esc(sc.note)}` : ""}</p>
        ${months.length ? `<div class="pb-who-spark">${bsSpark(months, counts, PB.ink)}</div>` : ""}
        <div class="pb-rdpart"><span class="kicker">the meetings that named ${esc(one.kind === "people" ? "them" : "it")}${sorted.length > 12 ? ` — the latest twelve of ${nOf(sorted.length, "meeting", "meetings")}` : ""}</span>${rows}</div>
        <p class="pb-chartsrc">read off the record’s names plane, which keeps each meeting’s most-said names — <a href="${searchOf(one)}">every line that says “${esc(one.name)}”</a>, counted exactly</p>
      </section>`;
    }
    const col = (kind, label) => {
      const list = names.filter(n => n.kind === kind).sort((a, c) => c.meetings.length - a.meetings.length || c.count - a.count || (a.name < c.name ? -1 : 1)).slice(0, 8);
      if (!list.length) return "";
      const months = tpMonthRange(list.flatMap(n => n.meetings.map(x => x.date)).filter(tpIsMonth).map(d => String(d).slice(0, 7)));
      return `<div class="pb-namescol"><span class="kicker">${label}</span>${list.map(n => `<a class="pb-name" href="${searchOf(n)}"><b>${esc(n.name)}</b><span class="pb-name-n">${nOf(n.meetings.length, "meeting", "meetings")}${sc.town ? "" : ` · ${n.count}+ times`}</span>${bsSpark(months, months.map(mo => n.meetings.filter(x => String(x.date || "").slice(0, 7) === mo).length), PB.ink, true)}</a>`).join("")}</div>`;
    };
    const body = col("people", "who") + col("places", "where");
    if (!body) return chartShell(kicker, "", `<p class="hint">The record has not heard a name twice${sc.town ? ` in ${esc(sc.town)}` : ""} yet.</p>`, "", `from <a href="${BASE}/analytics">the record, drawn</a>`);
    const twin = `<thead><tr><th>name</th><th>kind</th><th>meetings</th>${sc.town ? "" : "<th>times, at least</th>"}</tr></thead><tbody>`
      + names.slice().sort((a, c) => c.meetings.length - a.meetings.length || c.count - a.count).slice(0, 24).map(n => `<tr><td>${esc(n.name)}</td><td>${esc(n.kind)}</td><td>${n.meetings.length}</td>${sc.town ? "" : `<td>${n.count}</td>`}</tr>`).join("") + `</tbody>`;
    return chartShell(kicker, `the names and places the record keeps hearing, by the meetings that named them${sc.note ? ` · ${esc(sc.note)}` : ""}`,
      `<div class="pb-names">${body}</div>`, twin,
      `read off <a href="${BASE}/analytics">the record, drawn</a>, which keeps each meeting’s most-said names — a plus means at least; a name may be misheard; every one opens its search`);
  }
  /* the search box: readers search inside this page's own meetings — a real
     form to the search page, the page's pids in a hidden field (the search
     page reads m=); nothing is stored but the kind */
  function renderSearchBox(b, aux) {
    const all = (aux.pids || []).filter(pid => PAPER_REF.test(pid));
    const pids = all.slice(0, PAPER_MAX_BLOCKS);
    const n = pids.length;
    return `<form class="pb-search" action="${BASE}/s" method="get" role="search">
      <span class="kicker" id="pb-search-k${(aux.searchN = (aux.searchN || 0) + 1)}">search inside this front page’s meetings</span>
      <span class="pb-searchrow"><input name="q" type="search" autocomplete="off" aria-labelledby="pb-search-k${aux.searchN}" placeholder="${n ? `a word said in ${n === 1 ? "this meeting" : `these ${bsNumberWords(n)} meetings`}` : "a word said on the record"}">
        ${n ? `<input type="hidden" name="m" value="${esc(pids.join(","))}"><input type="hidden" name="town" value="">` : ""}<button type="submit" class="btn">Find</button></span>
      <span class="pb-chartsrc">${n ? (all.length > n ? `the first ${n} of ${nOf(all.length, "meeting", "meetings")} this page cites` : `${nOf(n, "meeting", "meetings")} this page cites`) : "the whole record"} · ${n ? "searched from the edition’s own index, in your browser — a page’s scope never reaches the record’s server" : "searched from the edition’s own index; when the record’s server answers, it sees the words you typed and nothing about you"}</span>
    </form>`;
  }
  /* ---- the chart blocks (specs/21 P2) --------------------------------------
     Four pictures, all computed HERE from the record's own pressed planes —
     a paper carries which chart, never the numbers. They wear the paper
     palette only: deep green is measurement (the analytics page's rule),
     slate is label, and no studio hue exists on a rendered paper (§6.1).
     Every chart keeps the two house rules the baked charts keep: a table
     twin, and a receipt under every mark. Positional marks (votes, reach)
     are SVG at natural size in a scrolling wrap so a mark never shrinks
     below a finger; magnitude bars (framing, topics) are HTML rows — the
     heatmap's precedent — so their labels stay real, wrappable, AA text at
     every width. */
  function chartShell(kicker, sub, body, twin, src) {
    return `<section class="pb-chart">
        <div class="sectionhead"><span class="kicker">${kicker}</span></div>
        ${sub ? `<p class="pb-chartsub">${sub}</p>` : ""}
        ${body}
        ${twin ? `<details class="graphtwin"><summary>the same, as a table</summary>
          <div class="pb-twinwrap"><table class="twin">${twin}</table></div></details>` : ""}
        ${src ? `<p class="pb-chartsrc">${src}</p>` : ""}
      </section>`;
  }
  /* a plane that did not arrive is "unreachable here", never "empty" — the
     two are different facts and the reader is owed whichever is true */
  const chartUnfetched = (kicker, html) => chartShell(kicker, "",
    `<p class="pb-gone">${html}</p>`, "", "");
  const chartDay = d => d ? esc(String(d).slice(5)) : "—";
  function renderChartBlock(b, mby, iby, tried, aux) {
    if (b.chart === "votes" && b.pid) return chartVotesMeeting(b, mby, tried);
    if (b.chart === "votes") return chartVotes(aux.votes);
    if (b.chart === "numbers") return chartNumbers(b, mby, iby, tried);
    if (b.chart === "shape") return chartShape(b, mby, tried);
    if (b.chart === "ledger") return chartLedger(b, iby, tried);
    if (b.chart === "topics") return chartTopics(aux.analytics);
    if (b.chart === "framing" && !b.pid) return chartFramingRecord(aux.analytics);
    if (b.chart === "framing") return chartFramingMeeting(b, mby, tried);
    if (b.chart === "reach") return chartReach(b, iby, tried, aux);
    return "";
  }
  /* votes over time — every roll call the record holds, one dot each,
     stacked by meeting: filled passes, hollow fails (shape, not color-alone,
     and the twin says the word). Each dot opens the tape where the vote was
     taken. */
  function chartVotes(plane) {
    const kicker = "votes over time — the record’s roll calls";
    if (!plane)
      return chartUnfetched(kicker, `the record’s votes plane didn’t load `
        + `here — <a href="${BASE}/officials">who voted how</a> reads in place`);
    const votes = plane.votes || [];
    if (!votes.length)
      return chartShell(kicker, "",
        `<p class="hint">The record holds no roll calls yet — when a
          meeting’s tape carries one, it lands here.</p>`, "", "");
    const cols = [];
    for (const v of votes) {
      const last = cols[cols.length - 1];
      if (last && last.pid === v.pid) last.votes.push(v);
      else cols.push({ pid: v.pid, date: v.date || "", body: v.body || "", votes: [v] });
    }
    const colW = 56, pad = 10, dotR = 7, pitch = 19;
    const maxN = Math.max(...cols.map(c => c.votes.length));
    const plotH = maxN * pitch + 12;
    const W = pad * 2 + cols.length * colW, H = plotH + 36;
    let marks = "", labels = "", prevYear = null, hasOther = false;
    cols.forEach((c, i) => {
      const cx = r1(pad + i * colW + colW / 2);
      c.votes.forEach((v, j) => {
        const cy = r1(plotH - dotR - 2 - j * pitch);
        // three marks, never a lie: a filled dot is "passes", a hollow dot
        // is "fails", and any other outcome the record holds (tabled, tied,
        // a desk import's own wording) is a half-tone square — the exact
        // word rides the tooltip, the aria-label and the twin. Binarizing
        // would draw a tabled motion as a failed one (a review catch).
        const mark = v.outcome === "passes" ? "pass"
          : v.outcome === "fails" ? "fail" : "other";
        if (mark === "other") hasOther = true;
        const tip = `${c.date || "undated"} · ${v.outcome}`
          + (v.tally ? ` ${v.tally}` : "") + ` — ${v.motion || "(motion)"}`;
        marks += `<a href="${BASE}/m/${esc(c.pid)}#t${Math.floor(v.t || 0)}"`
          + ` aria-label="${esc(tip.slice(0, 140))}">`
          + (mark === "other"
            ? `<rect x="${r1(cx - dotR + 1)}" y="${r1(cy - dotR + 1)}" `
              + `width="${(dotR - 1) * 2}" height="${(dotR - 1) * 2}" rx="2" `
              + `fill="${PB.ink}" fill-opacity=".5"`
            : `<circle cx="${cx}" cy="${cy}" r="${dotR}" `
              + (mark === "pass" ? `fill="${PB.ink}" fill-opacity=".82"`
                                 : `fill="${PB.card}" stroke="${PB.rust}" stroke-width="2"`))
          + `><title>${esc(tip)}</title>`
          + (mark === "other" ? `</rect></a>` : `</circle></a>`);
      });
      const y = c.date.slice(0, 4);
      labels += `<text x="${cx}" y="${plotH + 14}" text-anchor="middle" `
        + `font-size="10" fill="${PB.muted}">${chartDay(c.date)}</text>`;
      if (y && y !== prevYear) {
        labels += `<text x="${cx}" y="${plotH + 28}" text-anchor="middle" `
          + `font-size="10" fill="${PB.muted}">${esc(y)}</text>`;
        prevYear = y;
      }
    });
    // role="group", NOT role="img": img flattens the subtree and every
    // per-dot receipt link would vanish from assistive tech (a review catch)
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
      + `xmlns="http://www.w3.org/2000/svg" role="group" aria-label="the `
      + `record’s roll calls, meeting by meeting — ${votes.length} votes `
      + `across ${plane.n_meetings} meetings; the table below carries every `
      + `motion and outcome">`
      + `<line x1="0" y1="${plotH + 0.5}" x2="${W}" y2="${plotH + 0.5}" `
      + `stroke="${PB.rule}"/>` + marks + labels + `</svg>`;
    const twin = `<thead><tr><th>date</th><th>motion</th><th>outcome</th>
        <th>tally</th></tr></thead><tbody>`
      + votes.map(v =>
        `<tr><td><a href="${BASE}/m/${esc(v.pid)}#t${Math.floor(v.t || 0)}">
           ${esc(v.date || "undated")}</a></td>
         <td>${esc((v.motion || "").slice(0, 110))}</td>
         <td>${esc(v.outcome || "")}</td><td>${esc(v.tally || "")}</td></tr>`)
        .join("") + `</tbody>`;
    return chartShell(kicker,
      `${votes.length} roll call${votes.length > 1 ? "s" : ""} across `
        + `${plane.n_meetings} meeting${plane.n_meetings > 1 ? "s" : ""} — `
        + `every dot opens the tape where the vote was taken`,
      `<div class="pb-chartwrap">${svg}</div>
       <p class="pb-chartkey"><span class="pk-dot pk-full"></span> passes
         <span class="pk-dot pk-hollow"></span> fails${hasOther
           ? `\n         <span class="pk-dot pk-other"></span> other outcomes — the table has each word`
           : ""}</p>`,
      twin,
      `counted from the record’s own roll calls —
       <a href="${BASE}/officials">who voted how</a> holds every member’s record`);
  }
  /* an issue's reach — its appearances, meeting by meeting; a bar is how
     many moments of that meeting the issue surfaced in. */
  function chartReach(b, iby, tried, aux) {
    const it = iby[b.slug];
    if (!it) return tried.i.has(b.slug)
      ? paperGone(`an issue (${b.slug})`)
      : paperBudget("an issue’s reach chart");
    const kicker = `an issue’s reach — ${esc(it.name || b.slug)}`;
    const tl = it.timeline || [];
    if (!tl.length)
      return chartShell(kicker, "",
        `<p class="hint">The record hasn’t seen this issue surface in a
          meeting yet.</p>`, "",
        `from the record’s long view —
         <a href="${BASE}/i/${esc(b.slug)}">${esc(it.name || b.slug)}</a>`);
    // the board's timeline (specs/29 board 6): the meetings that took it up
    // as town-coloured dots on the months — the search page's own picture
    // (bsTimeline); each dot opens the tape at the first bead. An undated
    // node cannot sit on a month — the twin lists it, the picture cannot.
    const townBy = bsTownBy(aux && aux.meta);
    const rows = tl.filter(n => n && n.pid).map(n => ({ pid: n.pid, date: n.date || "", body: n.body || "", title: n.title || n.body || n.pid,
      n: (n.beads || []).length, first_t: ((n.beads || [])[0] || {}).t || 0, town: townBy[n.pid] || "" }));
    const undated = rows.filter(r => !tpIsMonth(r.date)).length;
    const pic = bsTimeline(rows, "", 0, 0, "moment").replace(/<span class="kicker">[^<]*<\/span>/, `<span class="kicker">the meetings that took it up · click a dot${undated ? ` · ${nOf(undated, "undated appearance", "undated appearances")} in the table only` : ""}</span>`);
    const svg = pic || `<p class="hint">Its appearances carry no dates the picture can place — the table below lists them.</p>`;
    const twin = `<thead><tr><th>date</th><th>meeting</th><th>moments</th>
        </tr></thead><tbody>`
      + tl.map(n => `<tr><td><a href="${BASE}/m/${esc(n.pid)}">
          ${esc(n.date || "undated")}</a></td>
          <td>${esc(n.body || n.title || n.pid)}</td>
          <td>${(n.beads || []).length}</td></tr>`).join("") + `</tbody>`;
    return chartShell(kicker,
      `${it.n_meetings} meeting${it.n_meetings === 1 ? "" : "s"}`
        + (it.first_seen ? ` · first seen ${esc(it.first_seen)}` : "")
        + (it.last_seen ? ` · last ${esc(it.last_seen)}` : ""),
      svg,
      twin,
      `from the record’s long view —
       <a href="${BASE}/i/${esc(b.slug)}">${esc(it.name || b.slug)}</a>
       holds every appearance in place`);
  }
  /* ---- the two paths' pictures (specs/24) --------------------------------
     Every one computed HERE from the record's own pressed planes — a paper
     carries which picture and whose, never a number. The paper palette only:
     deep green is measurement, slate is label; a receipt under every mark
     and a table twin where the picture is positional. */
  const nOf = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  /* the meeting plane's lists are CAPPED at press time (web/bake.py: twenty
     decisions, twenty-four questions, ten moments of pushback) — a length at
     the cap is "at least", never a count, and is said with a plus */
  const BS_CAPS = { decisions: 20, questions: 24, tension: 10 };
  const bsCapN = (list, cap) => { const n = (Array.isArray(list) ? list : []).length; return n >= cap ? `${n}+` : String(n); };
  const numbersStrip = cells => `<div class="pb-nums">` + cells.map(([n, label, href]) =>
    `<a class="pb-num" href="${href}"><b>${n}</b><span>${esc(label)}</span></a>`).join("") + `</div>`;
  /* the meeting in numbers / the issue in numbers: a strip of counted facts,
     every cell a receipt into the page that holds the count */
  function chartNumbers(b, mby, iby, tried) {
    if (b.pid) {
      const m = mby[b.pid];
      if (!m) return tried.m.has(b.pid) ? paperGone(`a meeting (${b.pid})`) : paperBudget("a meeting’s numbers");
      const an = m.analysis || {}, href = `${BASE}/m/${esc(b.pid)}`;
      const cells = [
        [Math.round((+m.duration || 0) / 60), "minutes", href],
        [(m.votes || []).length, "roll calls", href],
        [bsCapN(an.decisions, BS_CAPS.decisions), "decisions", href],
        [bsCapN(an.questions, BS_CAPS.questions), "questions asked", href],
        [bsCapN(an.tension, BS_CAPS.tension), "moments of pushback", href],
        [(m.documents || []).length, "filings", href],
      ];
      return chartShell(`the meeting in numbers — ${esc(m.title || b.pid)}`, "",
        numbersStrip(cells), "",
        `counted from the meeting’s own pressed plane when this paper rendered — <a href="${href}">the meeting</a> holds every one in place`);
    }
    const it = iby[b.slug];
    if (!it) return tried.i.has(b.slug) ? paperGone(`an issue (${b.slug})`) : paperBudget("an issue’s numbers");
    const tl = (it.timeline || []).filter(n => n && typeof n === "object"), href = `${BASE}/i/${esc(b.slug)}`;
    const moments = tl.reduce((s, n) => s + ((n.beads || []).length), 0);
    const milestones = tl.reduce((s, n) => s + ((n.milestones || []).length), 0);
    const yr = d => d ? esc(String(d).slice(0, 4)) : "—";
    const cells = [
      [tl.length || (+it.n_meetings || 0), "meetings", href],
      [moments, "moments", href],
      [(it.ledger || []).length, "roll calls", href],
      [milestones, "milestones", href],
      [yr(it.first_seen), "first seen", href],
      [yr(it.last_seen), "last seen", href],
    ];
    return chartShell(`the issue in numbers — ${esc(it.name || b.slug)}`, "",
      numbersStrip(cells), "",
      `counted from the issue’s own long view when this paper rendered — <a href="${href}">the issue</a> holds every appearance in place`);
  }
  /* the shape of a meeting: the tape as one strip, its moments marked where
     they fell — a roll call as a bar, a decision as a triangle, pushback as
     a diamond, a question as a dot — every mark a deep link into the tape,
     and a table twin that reads the same moments in order */
  const SHAPE_KINDS = { vote: "roll call", decision: "decision", tension: "pushback", question: "question" };
  function chartShape(b, mby, tried) {
    const m = mby[b.pid];
    if (!m) return tried.m.has(b.pid) ? paperGone(`a meeting (${b.pid})`) : paperBudget("the shape of a meeting");
    const kicker = `the shape of the meeting — ${esc(m.title || b.pid)}`;
    const mos = (m.moments || []).filter(mo => mo && typeof mo.t === "number" && mo.t >= 0)
      .slice().sort((a, c) => a.t - c.t);
    const src = `from the meeting’s own moments plane — scored, not chosen; every mark opens the tape where it fell. <a href="${BASE}/m/${esc(b.pid)}">the meeting</a> holds them all`;
    if (!mos.length)
      return chartShell(kicker, "", `<p class="hint">The analyzer scored no moments on this tape — the meeting reads whole on its page.</p>`, "", src);
    const dur = Math.max(+m.duration || 0, ...mos.map(mo => +mo.end || mo.t), 1);
    const W = 720, H = 92, padL = 8, padR = 8, axisY = 60, plotW = W - padL - padR;
    const x = t => r1(padL + plotW * Math.max(0, Math.min(1, t / dur)));
    let marks = "";
    const counts = {};
    mos.forEach(mo => {
      const kind = SHAPE_KINDS[mo.kind] ? mo.kind : "question", cx = x(mo.t);
      counts[kind] = (counts[kind] || 0) + 1;
      const tip = `${hms(mo.t)} · ${SHAPE_KINDS[kind]} — ${String(mo.quote || "").slice(0, 120)}`;
      const glyph = kind === "vote"
        ? `<rect x="${r1(cx - 4)}" y="18" width="8" height="${axisY - 18}" rx="1" fill="${PB.ink}" fill-opacity=".85"/>`
        : kind === "decision"
        ? `<path d="M${cx} 26 l7 14 h-14 z" fill="${PB.ink}" fill-opacity=".85"/>`
        : kind === "tension"
        ? `<path d="M${cx} 30 l6 8 -6 8 -6 -8 z" fill="${PB.card}" stroke="${PB.rust}" stroke-width="2"/>`
        : `<circle cx="${cx}" cy="${axisY - 10}" r="3.5" fill="${PB.ink}" fill-opacity=".55"/>`;
      marks += `<a href="${BASE}/m/${esc(b.pid)}#t${Math.floor(mo.t)}" aria-label="${esc(tip.slice(0, 140))}">${glyph}<title>${esc(tip)}</title></a>`;
    });
    let ticks = "";
    for (let h = 0; h * 3600 <= dur; h++) {
      const cx = x(h * 3600);
      ticks += `<line x1="${cx}" y1="${axisY}" x2="${cx}" y2="${axisY + 6}" stroke="${PB.muted}"/>`
        + `<text x="${cx}" y="${axisY + 20}" text-anchor="${h === 0 ? "start" : "middle"}" font-size="10" fill="${PB.muted}">${h}h</text>`;
    }
    const legend = Object.keys(SHAPE_KINDS).filter(k => counts[k])
      .map(k => nOf(counts[k], SHAPE_KINDS[k], SHAPE_KINDS[k] + "s")).join(" · ");
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="group" `
      + `aria-label="the shape of ${esc(m.title || b.pid)} — ${mos.length} moments on a ${hms(dur)} tape; the table below reads them in order">`
      + `<line x1="${padL}" y1="${axisY + 0.5}" x2="${W - padR}" y2="${axisY + 0.5}" stroke="${PB.ink}" stroke-width="1"/>`
      + ticks + marks + `</svg>`;
    const twin = `<thead><tr><th>time</th><th>kind</th><th>the moment</th></tr></thead><tbody>`
      + mos.map(mo => `<tr><td><a href="${BASE}/m/${esc(b.pid)}#t${Math.floor(mo.t)}">${hms(mo.t)}</a></td>
          <td>${esc(SHAPE_KINDS[mo.kind] || "question")}</td><td>${esc(String(mo.quote || "").slice(0, 160))}</td></tr>`).join("")
      + `</tbody>`;
    return chartShell(kicker,
      `${hms(dur)} of tape · ${legend} — a bar is a roll call, a triangle a decision, a diamond pushback, a dot a question`,
      `<div class="pb-chartwrap">${svg}</div>`, twin, src);
  }
  /* a roll call as a row: the mark (filled passes, hollow fails, half-tone
     anything else — the word says which), the time or the day, the motion,
     the tally, the outcome, and the roll beneath */
  function voteRows(votes, when) {
    return votes.map(v => {
      const mark = v.outcome === "passes" ? "pass" : v.outcome === "fails" ? "fail" : "other";
      const roll = (v.roll || []).map(r =>
        `<span class="pb-roll"><span class="pb-rollname">${esc(r.name || "")}</span> ${esc(r.vote || "")}</span>`).join("");
      return `<div class="pb-vote pb-vote-${mark}"><a class="pb-votehead" href="${BASE}/m/${esc(v.pid)}#t${Math.floor(+v.t || 0)}">
          <span class="pb-votemark" aria-hidden="true"></span><span class="ts">${esc(when(v))}</span>
          <span class="pb-motion">${esc(String(v.motion || "(motion)").slice(0, 140))}</span>
          <span class="pb-tally">${esc(v.tally || "")}</span><span class="pb-outcome">${esc(v.outcome || "")}</span></a>
          ${roll ? `<div class="pb-rolls">${roll}</div>` : ""}</div>`;
    }).join("");
  }
  /* one meeting's roll calls, read from its own plane */
  function chartVotesMeeting(b, mby, tried) {
    const m = mby[b.pid];
    if (!m) return tried.m.has(b.pid) ? paperGone(`a meeting (${b.pid})`) : paperBudget("a meeting’s roll calls");
    const kicker = `the roll calls — ${esc(m.title || b.pid)}`;
    const votes = (m.votes || []).filter(v => v && typeof v.t === "number").map(v => ({ ...v, pid: b.pid }));
    if (!votes.length)
      return chartShell(kicker, "", `<p class="hint">No roll call was read from this tape — the body may have voted by voice, or not at all.</p>`, "",
        `from the meeting’s own vote ledger — <a href="${BASE}/m/${esc(b.pid)}">the meeting</a>`);
    return chartShell(kicker,
      `${nOf(votes.length, "roll call", "roll calls")} read from the tape — a filled mark passes, a hollow one fails, the word says which`,
      `<div class="pb-votes">${voteRows(votes, v => hms(v.t))}</div>`, "",
      `read from the transcript; a name may be misheard — verify against the official minutes. <a href="${BASE}/m/${esc(b.pid)}">the meeting</a> holds the ledger in place`);
  }
  /* an issue's ledger: every roll call along its way, across meetings */
  function chartLedger(b, iby, tried) {
    const it = iby[b.slug];
    if (!it) return tried.i.has(b.slug) ? paperGone(`an issue (${b.slug})`) : paperBudget("an issue’s ledger");
    const kicker = `every roll call along the way — ${esc(it.name || b.slug)}`;
    const led = (it.ledger || []).filter(v => v && v.pid);
    if (!led.length)
      return chartShell(kicker, "", `<p class="hint">No roll call on this issue has been read from a tape yet — its appearances are talk, so far.</p>`, "",
        `from the issue’s own ledger — <a href="${BASE}/i/${esc(b.slug)}">the issue</a>`);
    return chartShell(kicker,
      `${nOf(led.length, "roll call", "roll calls")} across ${nOf(new Set(led.map(v => v.pid)).size, "meeting", "meetings")}, oldest first`,
      `<div class="pb-votes">${voteRows(led, v => v.date || "undated")}</div>`, "",
      `from the issue’s own ledger when this paper rendered — <a href="${BASE}/i/${esc(b.slug)}">the issue</a> holds every vote in place`);
  }
  /* the record's reading (specs/24): what was decided, what was asked, who
     and what was named, where the pushback was — for a meeting; the
     milestones in order, for an issue. Extractive, receipts throughout, no
     model: the analyzer's read, pressed, said as a reading. */
  /* a model's prose, read (specs/27 §2.2) — the twin of web/charts.py
     receipt_paras, byte for byte (a node twin holds them equal). Escaped
     first, marked up after: a draft is untrusted text. The subset of
     Markdown the models actually write — a heading line, a bullet, **bold**,
     *italic*; every other asterisk and backtick dropped as the syntax it is
     — and every time in a receipt group its own link into the tape, said
     the way the record says a time ([264:28] reads [4:24:28]). */
  // the bounded classes count code points (u), as Python does — an emoji is
  // one character in both twins; RD_LABEL stays ASCII-only (no u: /iu folds ſ to s)
  const RD_BULLET = /^[*•-][ \t]+(.+)$/, RD_HASH = /^#{1,6}[ \t]+(.+)$/,
    RD_BOLDLINE = /^\*\*([^*]{1,80}?):?\*\*:?$/u, RD_RULE = /^(?:[-*_•#][ \t]*)+$/,
    RD_BOLD = /\*\*([^*]{1,200}?)\*\*/gu, RD_ITAL = /\*([^* \t\u00a0](?:[^*]{0,200}?[^* \t\u00a0])?)\*/gu,
    RD_LABEL = /^(what it means|who moved it|what to watch):/i,
    RD_GROUP = /\[([0-9:,; \t\u2013\u2014-]{3,60})\]/g,
    RD_TIME = /([0-9]{1,3}):([0-9]{2})(?::([0-9]{2}))?/g;
  /* a receipt group: every real time its own bracketed link; a group
     holding anything that is not a real time stays as written */
  function rdGroup(m0, inner, hrefBase) {
    const parts = []; let prev = 0, times = 0, t;
    RD_TIME.lastIndex = 0;
    while ((t = RD_TIME.exec(inner))) {
      const a = +t[1], b = +t[2], c = t[3];
      let sec;
      if (c != null) { if (b > 59 || +c > 59) return m0; sec = a * 3600 + b * 60 + +c; }
      else { if (b > 59) return m0; sec = a * 60 + b; }
      const sep = inner.slice(prev, t.index).trim();
      if (times) {
        if (sep.includes(",") || sep.includes(";")) parts.push(", ");
        else if (sep === "-" || sep === "\u2013" || sep === "\u2014") parts.push("\u2013");
        else if (sep === "") parts.push(" ");
        else return m0;
      } else if (sep) return m0;
      parts.push(`<a class="ts" href="${hrefBase}#t${sec}">[${hms(sec)}]</a>`);
      prev = t.index + t[0].length; times++;
    }
    if (!times || inner.slice(prev).trim()) return m0;
    return parts.join("");
  }
  function rdInline(s, hrefBase) {
    let t = esc(s).replace(RD_BOLD, "<b>$1</b>").replace(RD_ITAL, "<i>$1</i>")
      .replace(/( ?)\*+( ?)/g, (m0, a, b) => a && b ? m0 : a + b).replace(/`/g, "")
      .replace(RD_GROUP, (m0, inner) => rdGroup(m0, inner, hrefBase));
    const lab = RD_LABEL.exec(t);
    if (lab) t = `<b>${lab[0]}</b>` + t.slice(lab[0].length);
    return t;
  }
  /* a line trimmed of exactly the four characters the Python twin strips —
     a loop, not a regex (an unanchored [ ]+$ is quadratic on a long run) */
  const RD_WS = " \t\u00a0\ufeff";
  const rdTrim = s => { let a = 0, b = s.length;
    while (a < b && RD_WS.includes(s[a])) a++;
    while (b > a && RD_WS.includes(s[b - 1])) b--;
    return s.slice(a, b); };
  function receiptParas(text, hrefBase) {
    const lines = String(text || "").replace(/\r\n|[\r\u2028\u2029]/g, "\n").split("\n")
      .map(rdTrim).filter(l => l && !RD_RULE.test(l));
    const out = [], items = [];
    const flush = () => { if (items.length) { out.push(`<ul class="rd-list">${items.map(x => `<li>${x}</li>`).join("")}</ul>`); items.length = 0; } };
    for (const l of lines) {
      const b = RD_BULLET.exec(l);
      if (b) { const x = rdInline(b[1], hrefBase); if (rdTrim(x)) items.push(x); continue; }
      const h = RD_HASH.exec(l) || RD_BOLDLINE.exec(l);
      const x = rdInline(h ? h[1] : l, hrefBase);
      if (!rdTrim(x)) continue;    // a line that was only syntax says nothing
      flush();
      out.push(h ? `<p class="rd-h">${x}</p>` : `<p>${x}</p>`);
    }
    flush();
    return out.join("");
  }
  function renderReading(b, mby, iby, tried) {
    const part = (kicker, rows) => rows ? `<div class="pb-rdpart"><span class="kicker">${kicker}</span>${rows}</div>` : "";
    const row = (href, t, tag, text) => `<a class="pb-rdrow" href="${href}"><span class="ts">${hms(t)}</span>`
      + (tag ? `<span class="pb-rdtag">${esc(tag)}</span>` : "") + ` ${esc(String(text || "").slice(0, 160))}</a>`;
    if (b.pid) {
      const m = mby[b.pid];
      if (!m) return tried.m.has(b.pid) ? paperGone(`a meeting (${b.pid})`) : paperBudget("the record’s reading of a meeting");
      const an = m.analysis || {}, at = t => `${BASE}/m/${esc(b.pid)}#t${Math.floor(+t || 0)}`;
      const ents = an.entities || {};
      const names = ["people", "organizations", "places", "money"].map(k => ({ k,
        v: (Array.isArray(ents[k]) ? ents[k] : []).slice(0, 6)
          .map(e => typeof e === "string" ? e : (e && (e.name || e.text)) || "").filter(Boolean) }))
        .filter(x => x.v.length);
      // the reading's draft (specs/24 §4): a model's paragraphs under the
      // model's own name, receipts linked — beside the counted parts
      const d = an.draft && typeof an.draft === "object" && typeof an.draft.text === "string"
        && /^ai:/.test(String(an.draft.origin || "")) ? an.draft : null;
      const drafted = d ? `<div class="pb-rddraft">${receiptParas(d.text, `${BASE}/m/${esc(b.pid)}`)}
        <p class="pb-chartsrc">the reading, drafted by a model — ${esc(d.origin)}, labeled — check it against the tape</p></div>` : "";
      const body = drafted + part("what was decided", (an.decisions || []).slice(0, 8).map(d => row(at(d.t), d.t, d.outcome, d.text)).join(""))
        + part("what was asked", (an.questions || []).slice(0, 8).map(q => row(at(q.t), q.t, q.type, q.text)).join(""))
        + part("where the pushback was", (an.tension || []).slice(0, 5).map(d => row(at(d.t), d.t, "", d.text)).join(""))
        + part("who and what was named", names.map(x =>
            `<p class="pb-rdnames"><span class="pb-rdtag">${esc(x.k)}</span> ${x.v.map(esc).join(" · ")}</p>`).join(""));
      const head = `<div class="sectionhead"><span class="kicker">the record’s reading — ${esc(m.title || b.pid)}</span></div>`;
      if (!body) return `<section class="pb-reading">${head}<p class="hint">The analyzer read nothing it could name on this tape — the meeting reads whole on its page.</p></section>`;
      return `<section class="pb-reading">${head}${body}<p class="pb-chartsrc">counted and quoted from the transcript by open rules — no model; every line opens the tape where it was said. <a href="${BASE}/m/${esc(b.pid)}">the meeting</a> holds the whole read</p></section>`;
    }
    const it = iby[b.slug];
    if (!it) return tried.i.has(b.slug) ? paperGone(`an issue (${b.slug})`) : paperBudget("the record’s reading of an issue");
    const tl = (it.timeline || []).filter(n => n && typeof n === "object" && n.pid);
    const rows = tl.map(n => {
      const ms = (n.milestones || []).slice(0, 4), bead = (n.beads || [])[0];
      const inner = ms.length
        ? ms.map(mm => row(`${BASE}/m/${esc(n.pid)}#t${Math.floor(+mm.t || 0)}`, mm.t, mm.kind || "milestone",
            String(mm.text || "").slice(0, 150) + (mm.outcome ? ` — ${mm.outcome}` : ""))).join("")
        : bead ? row(`${BASE}/m/${esc(n.pid)}#t${Math.floor(+bead.t || 0)}`, bead.t, "", bead.text) : "";
      return `<div class="pb-rdnode"><a class="pb-rdhead" href="${BASE}/m/${esc(n.pid)}"><b>${esc(n.date || "undated")}</b> · ${esc(n.body || n.title || n.pid)} · ${nOf(+n.n || 0, "moment", "moments")}</a>${inner}</div>`;
    }).join("");
    const head = `<div class="sectionhead"><span class="kicker">the record’s reading — ${esc(it.name || b.slug)}, meeting by meeting</span></div>`;
    if (!rows) return `<section class="pb-reading">${head}<p class="hint">The record hasn’t seen this issue surface in a meeting yet.</p></section>`;
    return `<section class="pb-reading">${head}${rows}<p class="pb-chartsrc">the milestones the analyzer found at each appearance, by open rules — no model; every line opens the tape. <a href="${BASE}/i/${esc(b.slug)}">the issue</a> holds the long view</p></section>`;
  }
  /* magnitude bars in HTML — the heatmap's precedent: real text labels (AA
     at any width), an inline width that is the measurement, deep green the
     only hue. Used by both framing charts and topics. */
  function lensBars(rows) {
    const mx = Math.max(...rows.map(r => r.n), 1);
    return `<div class="pb-bars">` + rows.map(r => {
      const name = r.href
        ? `<a class="pb-name" href="${esc(r.href)}" title="${esc(r.name)}">${esc(r.name)}</a>`
        : `<span class="pb-name" title="${esc(r.name)}">${esc(r.name)}</span>`;
      return `<div class="pb-bar">${name}
        <span class="pb-track" aria-hidden="true"><span class="pb-fill"
          style="width:${Math.max(1.5, 100 * r.n / mx).toFixed(1)}%"></span></span>
        <span class="pb-n">${esc(r.meta || String(r.n))}</span></div>`;
    }).join("") + `</div>`;
  }
  function chartFramingMeeting(b, mby, tried) {
    const m = mby[b.pid];
    if (!m) return tried.m.has(b.pid)
      ? paperGone(`a meeting (${b.pid})`)
      : paperBudget("a framing chart");
    const kicker = `the framing lenses — ${esc(m.title || b.pid)}`;
    const fr = (m.analysis || {}).framing || {};
    const lenses = (fr.lenses || []).slice().sort((a, x) => x.count - a.count);
    if (!lenses.length)
      return chartShell(kicker, "",
        `<p class="hint">The analyzer read no framing signals in this
          meeting.</p>`, "",
        `from the record’s read of
         <a href="${BASE}/m/${esc(b.pid)}">this meeting</a>`);
    const twin = `<thead><tr><th>lens</th><th>signals</th><th>share</th>
        </tr></thead><tbody>`
      + lenses.map(l => `<tr><td>${esc(l.lens)}</td><td>${l.count || 0}</td>
          <td>${Math.round((l.share || 0) * 100)}%</td></tr>`).join("")
      + `</tbody>`;
    return chartShell(kicker,
      `how this meeting framed what it discussed —
       ${fr.total || 0} signals, counted from its own words`,
      lensBars(lenses.map(l => ({ name: l.lens, n: l.count || 0, meta: `${l.count || 0}${l.drift ? " · " + l.drift : ""}` }))),
      twin,
      `counted from the record’s read of
       <a href="${BASE}/m/${esc(b.pid)}">this meeting</a>`);
  }
  function chartFramingRecord(analytics) {
    const kicker = "the framing lenses — the whole record";
    if (!analytics)
      return chartUnfetched(kicker, `the record’s analytics plane didn’t load `
        + `here — <a href="${BASE}/analytics">the record, drawn</a> reads in place`);
    const order = analytics.lens_order || [];
    const totals = order.map(nm => ({ name: nm,
      n: (analytics.framing || []).reduce((s, r) => s + ((r.lenses || {})[nm] || 0), 0) }));
    totals.sort((a, x) => x.n - a.n);
    if (!totals.length || !totals.some(t => t.n))
      return chartShell(kicker, "",
        `<p class="hint">The framing map needs a read meeting.</p>`, "",
        `from <a href="${BASE}/analytics">the record, drawn</a>`);
    const twin = `<thead><tr><th>lens</th><th>signals</th></tr></thead><tbody>`
      + totals.map(t => `<tr><td>${esc(t.name)}</td><td>${t.n}</td></tr>`)
        .join("") + `</tbody>`;
    return chartShell(kicker,
      `how the record frames its talk, across ${analytics.n_meetings || 0}
       meeting${analytics.n_meetings === 1 ? "" : "s"}`,
      lensBars(totals),
      twin,
      `counted from <a href="${BASE}/analytics">the record, drawn</a> —
       the full meeting-by-meeting map reads there`);
  }
  function chartTopics(analytics) {
    const kicker = "recurring topics — what keeps coming back";
    if (!analytics)
      return chartUnfetched(kicker, `the record’s analytics plane didn’t load `
        + `here — <a href="${BASE}/analytics">the record, drawn</a> reads in place`);
    const tops = (analytics.topics || []).slice(0, 12);
    if (!tops.length)
      return chartShell(kicker, "",
        `<p class="hint">Nothing recurs yet — the record is young.</p>`, "",
        `from <a href="${BASE}/analytics">the record, drawn</a>`);
    const rows = tops.map(t => ({
      name: t.topic, n: (t.meetings || []).length,
      meta: `${(t.meetings || []).length} meeting${(t.meetings || []).length === 1 ? "" : "s"} · ${t.count}×`,
      href: t.meetings && t.meetings.length
        ? `${BASE}/m/${t.meetings[0].pid}#t${Math.floor(t.meetings[0].t || 0)}`
        : "" }));
    const twin = `<thead><tr><th>topic</th><th>meetings</th><th>mentions</th>
        </tr></thead><tbody>`
      + tops.map(t => `<tr><td>${esc(t.topic)}</td>
          <td>${(t.meetings || []).length}</td><td>${t.count}</td></tr>`)
        .join("") + `</tbody>`;
    return chartShell(kicker,
      `the top ${tops.length} by meetings touched — a longer bar keeps
       returning`,
      lensBars(rows),
      twin,
      `counted from <a href="${BASE}/analytics">the record, drawn</a>`);
  }

  const paperGone = what => `<p class="pb-gone">This paper cites ${esc(what)} `
    + `that isn’t in this pressing of the record — it may have been curated `
    + `away, or pressed under a different id.</p>`;
  const paperDark = (what, where) => `<p class="pb-gone">${esc(what)} didn’t load here — `
    + `${esc(where)}. Nothing was judged gone.</p>`;
  const paperBudget = what => `<p class="pb-gone">This paper cites more of the `
    + `record than one page fetches at once — ${esc(what)} here was left `
    + `unfetched, not judged gone. The record itself holds it.</p>`;
  function paperMessage(el, html) {
    if (el) el.innerHTML = `<p class="hint">${html}</p>`;
  }

  /* ---- PART 3: the on-page editor (specs/23 A3) ----------------------------
     /app/p in the studio is where YOUR DRAFT is arranged on the paper itself,
     not only in the sidebar. Every block the renderer above paints gets a
     bar: a drag handle (HTML5 drag-and-drop for the pointer; the same handle
     takes ↑ ↓ for the keyboard, and the ↑ ↓ ✕ buttons beside it are the
     panel's own controls, mirrored — so no arrangement is pointer-only), the
     title is typed in place, a note is typed in place, and an insertion point
     between any two blocks opens an inline add: a lexical search over the
     record's own static index (search/meta.json names every meeting,
     issues/index.json every issue — no API door), plus a note, the reel, and
     the record-wide charts. Every edit writes the same `cz-paper` draft the
     panel writes and repaints both surfaces. A shared or stored paper never
     grows any of this: it is read-only until specs/22's make-this-yours. */
  let ED_HASH_SEEN = false;   // #edit / #tpl are read once per page load
  let PAPER_HASH_WIRED = false;
  let PAPER_TOWNS = [];       // the pressing's municipalities, for the scoped blocks' frames
  let ED_ASKS = [];           // the open template's three questions
  let ED_RAILED = false;      // the editor page railed the sidebar once (painted state)
  let ED_SHARE_OPEN = false;  // the share row, once unfolded, stays through repaints
  /* the editor page (board 8): the sidebar rails itself beside the board
     the first time the editor paints on this page — painted state only;
     › expands it, and the stored preference is untouched */
  function bsEditorPage() {
    if (ED_RAILED) return;
    ED_RAILED = true;
    if (window.matchMedia && window.matchMedia("(min-width: 1024px)").matches && !shownRail()) {
      document.documentElement.classList.add("cz-rail"); pvPause(); updateModeButtons();
    }
  }
  /* the head (board 8): the template line, the headline field — the title,
     drafted by the template and yours to change — what is stored, and the
     two acts: preview as readers see it, share as a link */
  const edHead = (doc, opts) => { const T = TEMPLATES[doc.tpl] || null; opts = opts || {};
    // the empty page IS the templates board — its head names no second one
    const tplLine = opts.noBoard
      ? `<span class="cz-edtpl">Template · <b>pick one below</b></span>`
      : `<details class="cz-tplmore"><summary class="cz-edtpl">Template · <b>${esc(T ? T.name : doc.blocks.length ? "your own arrangement" : "Blank broadsheet")}</b> <span class="cz-edtpl-go">change</span></summary>
          <div class="cz-tplboard-wrap">${tplBoard()}<div class="cz-tplpick" hidden></div></div></details>`;
    return `<header class="phead cz-edhead">
      <div class="cz-edtop">
        ${tplLine}
        <input class="cz-edtitle" type="text" maxlength="${PAPER_TITLE_MAX}"
          value="${esc(doc.title)}" placeholder="name your front page"
          aria-label="your front page’s headline — the template’s, yours to change">
        <p class="ptitle cz-edtitle-print" aria-hidden="true">${esc(printTitle(doc.title))}</p>
        <span class="cz-edstored">stored: the title, your notes, and references to the record — nothing else</span>
        <span class="cz-edpill cz-edpill-head" aria-hidden="true">Headline · the template’s, yours to change</span>
      </div>
      <div class="cz-edacts-row">
        <button type="button" class="btn" data-czed="preview">Preview as readers see it</button>
        <button type="button" class="btn primary" data-czed="share">Share as a link</button>
        <span class="cz-edshare"${PAPER_SHORT || ED_SHARE_OPEN ? "" : " hidden"}>
          <button type="button" class="btn" data-czed="plink">⧉ copy the link again</button>
          <button type="button" class="btn" data-czed="pjson">⬇ paper.json</button>
          ${API ? `<button type="button" class="btn" data-czed="pshort">⚡ short link</button>` : ""}
          <button type="button" class="btn" data-czed="pclear">clear</button>
          ${PAPER_SHORT ? `<span class="cz-pshort-out">short link: <a href="${esc(PAPER_SHORT)}">${esc(PAPER_SHORT.replace(location.origin, ""))}</a></span>` : ""}
        </span>
        <p class="pfrom">your draft, open for editing — press a block on the shelf to add it, or drag it into the page;
          a block’s ↑ ↓ move it, × removes it. It lives in this browser; a link carries it whole.</p>
      </div>
    </header>`; };
  /* an insertion point: the index a new block would land at */
  const edSlot = at => `<div class="cz-edslot" data-at="${at}">
      <button type="button" class="cz-edadd" data-czed="add" data-i="${at}"
        aria-expanded="false"
        aria-label="add a block here${at ? ` — after block ${at}` : " — at the top"}">+ add a block here</button>
    </div>`;
  /* the block shelf (board 8): twelve blocks, each a press (adds at the
     end) or a drag (adds where it lands). What each does when pressed: */
  const SHELF = [
    ["lead", "Lead story", "a meeting, its still, its moments"],
    ["over", "Over time", "a thread’s timeline"],
    ["week", "This week", "meetings as cards"],
    ["threads", "Threads", "small multiples"],
    ["strip", "How they talked", "the lens strip"],
    ["names", "Who and where", "names and places"],
    ["reel", "A reel", "moments, in order"],
    ["quote", "A quote", "one caption, cited"],
    ["rolls", "Roll calls", "votes as dots"],
    ["numbers", "In numbers", "the counts"],
    ["note", "Your paragraph", "what it means"],
    ["search", "Search box", "readers search your page"],
  ];
  const edShelf = () => `<aside class="cz-blocks" aria-label="blocks — press one to add it at the end, or drag it into the page">
      <span class="cz-tag">blocks · drag into the page</span>
      ${SHELF.map(([k, name, sub]) => `<button type="button" class="cz-blk" draggable="true" data-czed="blk" data-blk="${k}"
        aria-label="${esc(name)} — ${esc(sub)}"><span class="cz-blk-grip" aria-hidden="true">⠿</span><span class="cz-blk-t"><b>${esc(name)}</b><span>${esc(sub)}</span></span></button>`).join("")}
    </aside>`;
  /* a shelf press or drop: the blocks that need a pick (a meeting, a
     thread, a line, a count) open the inline add at that slot, narrowed to
     the pick; the rest join at once */
  function shelfAdd(kind, at) {
    const el = $("#paperbody"); if (!el) return;
    const n = readPaper().blocks.length;
    const where = at == null ? n : Math.max(0, Math.min(n, at | 0));
    const slot = $(`.cz-edslot[data-at="${where}"]`, el);
    if (kind === "lead" || kind === "over" || kind === "quote" || kind === "numbers") { if (slot) openEdAdd(slot, { pick: kind }); return; }
    if (kind === "reel") return addReelToPaper(where);
    if (kind === "rolls") return addChartToPaper("votes", "", where);
    if (kind === "note") return addNoteToPaper(where);
    if (BS_SCOPED.includes(kind) || kind === "search") return addBsBlock(kind, where);
  }
  /* the frame's pill (board 8): what the block is, in the board's words */
  const bsTownName = slug => PAPER_TOWNS.find(t => bsSlug(t) === slug) || slug;
  const bsWhoName = who => String(who || "").replace(/^[plo]-/, "").split("-").filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  function pillLabel(b) {
    const who = s => cut(String(s || ""), 48);
    const mt = pid => ((PAPER_PLANES.mby || {})[pid] || {}).title || "";
    const it = slug => ((PAPER_PLANES.iby || {})[slug] || {}).name || "";
    if (b.kind === "lead" && !b.title && mt(b.pid)) b = { ...b, title: mt(b.pid) };
    if (b.kind === "story" && b.story === "meeting" && !b.title && mt(b.pid)) b = { ...b, title: mt(b.pid) };
    if (b.kind === "story" && b.story === "issue" && !b.name && it(b.slug)) b = { ...b, name: it(b.slug) };
    if (b.kind === "chart" && !b.name && b.slug && it(b.slug)) b = { ...b, name: it(b.slug) };
    if (b.kind === "chart" && !b.title && b.pid && mt(b.pid)) b = { ...b, title: mt(b.pid) };
    if (b.kind === "reading" && !b.title && !b.name) b = { ...b, title: b.pid ? mt(b.pid) : it(b.slug) };
    if (BS_SCOPED.includes(b.kind) && !b.name) b = { ...b, name: b.who ? bsWhoName(b.who) : b.town ? bsTownName(b.town) : "" };
    return b.kind === "lead" ? `Lead story · ${who(b.title || b.pid)}`
      : b.kind === "story" && b.story === "meeting" ? `A meeting · ${who(b.title || b.pid)}`
      : b.kind === "story" && b.story === "issue" ? `An issue · ${who(b.name || b.slug)}`
      : b.kind === "chart" && b.chart === "reach" ? `Over time · ${who(b.name || b.slug)}`
      : b.kind === "chart" && b.chart === "votes" ? (b.pid ? `Roll calls · ${who(b.title || b.pid)}` : "Roll calls · votes as dots")
      : b.kind === "chart" && b.chart === "numbers" ? `In numbers · ${who(b.title || b.name || b.pid || b.slug)}`
      : b.kind === "chart" && b.chart === "shape" ? `The shape of the tape · ${who(b.title || b.pid)}`
      : b.kind === "chart" && b.chart === "framing" ? (b.pid ? `How it was framed · ${who(b.title || b.pid)}` : "How the record talks · the framing")
      : b.kind === "chart" && b.chart === "ledger" ? `Every roll call · ${who(b.name || b.slug)}`
      : b.kind === "chart" ? "Recurring topics · the counts"
      : b.kind === "reel" ? `A reel · ${nOf(b.clips.length, "clip", "clips")}, cited`
      : b.kind === "note" ? "Your paragraph · what it means"
      : b.kind === "quote" ? `A quote · ${hms(b.t)}${b.title ? " · " + who(b.title) : ""}`
      : b.kind === "doc" ? `A filing · ${who(b.title || b.doc)}`
      : b.kind === "digest" ? `What changed · ${who(b.name || b.slug)}`
      : b.kind === "reading" ? `The record’s reading · ${who(b.title || b.name || b.pid || b.slug)}`
      : b.kind === "week" ? `This week${b.name ? " · " + who(b.name) : b.town ? " · " + b.town : ""}`
      : b.kind === "threads" ? `Threads${b.name ? " · " + who(b.name) : b.town ? " · " + b.town : ""}`
      : b.kind === "strip" ? `How they talked${b.name ? " · " + who(b.name) : b.town ? " · " + b.town : ""}`
      : b.kind === "names" ? (b.who ? `On the record · ${who(b.name || b.who)}` : `Who and where${b.name ? " · " + who(b.name) : b.town ? " · " + b.town : ""}`)
      : b.kind === "search" ? "Search box · readers search your page"
      : blockLabel(b).replace(/^\S+ /, "");
  }
  /* a scoped block's municipality select — the pressing's towns, or every town */
  const edTownSelect = (b, i) => BS_SCOPED.includes(b.kind) && !b.who && PAPER_TOWNS.length
    ? `<select class="cz-edtown" data-i="${i}" aria-label="which town block ${i + 1} reads" title="which town this block reads">
        <option value=""${b.town ? "" : " selected"}>every town</option>
        ${PAPER_TOWNS.map(t => `<option value="${esc(bsSlug(t))}"${b.town === bsSlug(t) ? " selected" : ""}>${esc(t)}</option>`).join("")}
      </select>` : "";
  /* the print twins: an <input> prints one clipped line and a <textarea>
     its four rows, not their words — the paper prints these instead, kept
     in step with every keystroke and re-read on beforeprint */
  const notePrint = text => String(text || "").trim().split(/\n+/).map(t => `<p>${esc(t)}</p>`).join("");
  /* the writing desk (specs/24 §2.3): three prompts rotate in the note's
     placeholder, and a drawer of facts at hand — the numbers, the loudest
     moments, the roll calls, an issue's span and its latest word — drawn
     from the planes this paper's own blocks already fetched. A press cites
     a fact at the caret as a receipt; the sentence around it stays the
     editor's. Nothing is fetched for the desk and nothing leaves the page. */
  const DESK_PROMPTS = ["what was decided, and who moved it?",
                        "what changed since the last time?",
                        "what should a neighbor watch for next?"];
  /* the paragraph's field (board 8): the template's questions rotate in its
     placeholder — the facts and the questions live on the desk beside it */
  const edNote = (b, i) => { const asks = ED_ASKS.length ? ED_ASKS : DESK_PROMPTS;
    return `<div class="pb-note cz-ednotewrap">
      <span class="kicker">what it means — the writer</span>
      <textarea class="cz-ednote" data-i="${i}" rows="5" maxlength="${PAPER_NOTE_MAX}"
        placeholder="${esc(asks[i % asks.length])} — your own words; a [1:46:50] in brackets is a receipt"
        aria-label="paragraph ${i + 1} — your own words">${esc(b.text)}</textarea>
      <div class="cz-ednote-print" aria-hidden="true">${notePrint(b.text)}</div>
      <div class="cz-ednote-foot"><span>every bracket is a receipt — cite a fact from the desk</span><span>yours · not a model’s</span></div></div>`; };
  let PAPER_PLANES = { mby: {}, iby: {} };   // the last render's planes; the desk reads them
  function deskFacts() {
    const facts = [], { mby, iby } = PAPER_PLANES;
    const words = s => cut(String(s || "").replace(/\s+/g, " ").trim(), 140);
    for (const pid of Object.keys(mby || {})) {
      const m = mby[pid]; if (!m) continue;
      const an = m.analysis || {}, who = m.title || pid, when = m.date ? `, ${m.date}` : "";
      // the lists are capped at press time — a length at the cap reads "20+"
      facts.push({ kind: "the numbers", text: `${who}${m.date ? ` (${m.date})` : ""}: `
        + `${nOf(Math.round((+m.duration || 0) / 60), "minute", "minutes")} · ${nOf((m.votes || []).length, "roll call", "roll calls")} · `
        + `${bsCapN(an.decisions, BS_CAPS.decisions)} decisions · ${bsCapN(an.questions, BS_CAPS.questions)} questions asked · `
        + `${bsCapN(an.tension, BS_CAPS.tension)} moments of pushback` });
      for (const mo of (m.moments || []).filter(mo => mo && typeof mo.t === "number")
          .slice().sort((a, c) => (+c.score || 0) - (+a.score || 0)).slice(0, 4))
        facts.push({ kind: SHAPE_KINDS[mo.kind] || mo.kind || "moment",
                     text: `[${hms(mo.t)}] “${words(mo.quote)}” — ${who}${when}` });
      for (const v of (m.votes || []).slice(0, 3))
        facts.push({ kind: "roll call", text: `[${hms(v.t)}] ${words(v.motion)} — ${v.outcome || ""}`
          + `${v.tally ? ` ${v.tally}` : ""} (${who}${when})` });
    }
    for (const slug of Object.keys(iby || {})) {
      const it = iby[slug]; if (!it) continue;
      const tl = (it.timeline || []).filter(n => n && n.pid), last = tl[tl.length - 1];
      const bead = last && (last.beads || []).find(x => x && typeof x.t === "number");
      facts.push({ kind: "the long view", text: `${it.name || slug}: ${nOf(tl.length || (+it.n_meetings || 0), "meeting", "meetings")}`
        + (it.first_seen ? `, ${it.first_seen} to ${it.last_seen || "now"}` : "")
        + `, ${nOf((it.ledger || []).length, "roll call", "roll calls")} along the way` });
      if (bead) facts.push({ kind: "latest", text: `[${hms(bead.t)}] “${words(bead.text)}” — `
        + `${last.body || last.title || last.pid}${last.date ? `, ${last.date}` : ""}` });
    }
    return facts.slice(0, 24);
  }
  /* the writing desk (board 8): three cards — the facts you can cite, a
     draft if you want one (the record's own drafted reading of the lead
     meeting, labeled with the model that wrote it; never silently yours),
     and the template's three questions — and the covenant line */
  const bsDraftOf = m => { const d = m && (m.analysis || {}).draft;
    return d && typeof d === "object" && typeof d.text === "string" && d.text.trim() && /^ai:/.test(String(d.origin || "")) ? d : null; };
  function deskLead(doc, mby) {
    // every meeting the page cites, in the order it cites them (a reel's
    // clips included): the first with a drafted reading is offered; failing
    // that the first meeting, so the card can say "none" honestly
    const seen = [];
    for (const b of doc.blocks) for (const pid of (b.kind === "reel" ? b.clips.map(c => c.pid) : b.pid ? [b.pid] : []))
      if (mby[pid] && !seen.includes(pid)) seen.push(pid);
    const pid = seen.find(x => bsDraftOf(mby[x])) || seen[0];
    return pid ? { pid, m: mby[pid], cited: seen.length } : null;
  }
  function edDesk(doc, mby) {
    const asks = ED_ASKS.length ? ED_ASKS : DESK_PROMPTS;
    const facts = deskFacts();
    const lead = deskLead(doc, mby);
    const d = lead ? bsDraftOf(lead.m) : null;
    const has = !!(lead && doc.blocks.some(b => b.kind === "reading" && b.pid === lead.pid));
    const night = lead ? [lead.m.title || lead.pid, TP_DAY.test(lead.m.date || "") ? tpDay(lead.m.date) : ""].filter(Boolean).join(" · ") : "";
    return `<aside class="cz-desk" aria-label="the writing desk">
      <span class="cz-tag">the writing desk</span>
      <section class="cz-deskcard cz-deskfacts">
        <span class="cz-desklabel">facts you can cite · click to insert</span>
        ${facts.length
          ? facts.map(f => `<button type="button" class="cz-fact" data-czfact="${esc(f.text)}"><span class="rt-kind">${esc(f.kind)}</span> ${esc(cut(f.text, 150))}</button>`).join("")
          : `<p class="cz-hint">add a meeting or an issue to your page and its facts land here — the numbers, the loudest moments, the roll calls</p>`}
      </section>
      <section class="cz-deskcard cz-deskdraft">
        <div class="cz-deskhead"><span class="cz-desklabel">a draft, if you want one</span>${d ? `<span class="cz-modelpill">${esc(String(d.origin).replace(/^ai:/, ""))}</span>` : ""}</div>
        <p class="cz-hint">${d
          ? `Paragraphs a model drafted from the same receipts when the record read <b>${esc(night)}</b> — labeled, never silently yours. Add them as the record’s reading, cut them, or ignore them.`
          : lead ? `The record drafted no paragraphs for ${lead.cited === 1 ? "this page’s meeting" : `any of the ${nOf(lead.cited, "meeting", "meetings")} this page cites`}. The facts above are the receipts; the paragraphs are yours.`
          : "Add a meeting and the record’s drafted reading of it, if it has one, is offered here — labeled, never silently yours."}</p>
        ${d ? `<div class="cz-deskacts">
          <button type="button" class="btn primary" data-czed="draft" data-ref="m:${esc(lead.pid)}"${has ? " disabled" : ""}>${has ? "the drafted reading is on your page" : `Add the drafted reading of ${esc(cut(lead.m.body || lead.m.title || lead.pid, 40))}`}</button>
          <button type="button" class="btn" data-czed="receipts" data-ref="${esc(lead.pid)}" aria-expanded="false">Show the receipts</button></div>
          <div class="cz-deskreceipts" hidden>${receiptParas(d.text, `${BASE}/m/${esc(lead.pid)}`)}<p class="cz-hint">drafted by ${esc(String(d.origin).replace(/^ai:/, ""))} — every bracket opens the tape; check it against the record before you keep a word</p></div>` : ""}
      </section>
      <section class="cz-deskcard cz-deskasks">
        <span class="cz-desklabel">the template asks</span>
        ${asks.map((q, i) => `<button type="button" class="cz-ask" data-czask="${i}"><span class="cz-ask-n">${i + 1}.</span><span>${esc(q)}</span></button>`).join("")}
      </section>
      <p class="cz-deskcov">No account. Nothing uploaded but the title, your notes and the references. Readers who open your link get the record’s bytes and your words; nobody is counted.</p>
    </aside>`;
  }
  let DESK_NOTE = -1;   // the paragraph the caret was last in — the desk cites into it
  /* a question pressed on the desk: the caret goes to a paragraph — the
     first empty one, else the last — and the question becomes its prompt */
  function focusAsk(i) {
    const el = $("#paperbody"); if (!el) return;
    const tas = $$(".cz-ednote", el);
    if (!tas.length) { if (addNoteToPaper(readPaper().blocks.length) >= 0) toast("a paragraph added — press the question again to make it the prompt"); return; }
    const ta = tas.find(t => !t.value.trim()) || tas[tas.length - 1];
    const asks = ED_ASKS.length ? ED_ASKS : DESK_PROMPTS;
    if (asks[i]) ta.placeholder = `${asks[i]} — your own words`;
    ta.focus(); ta.scrollIntoView({ block: "center" });
  }
  function citeFact(btn) {
    const el = $("#paperbody"); if (!el) return;
    const tas = $$(".cz-ednote", el);
    const ta = tas.find(t => +t.dataset.i === DESK_NOTE) || tas.find(t => !t.value.trim()) || tas[tas.length - 1];
    if (!ta) { if (addNoteToPaper(readPaper().blocks.length) >= 0) toast("a paragraph added — press the fact again to cite it there"); return; }
    const text = btn.dataset.czfact || "", s = ta.selectionStart, e = ta.selectionEnd;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const ins = (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "");
    ta.value = cut(before + ins + after, PAPER_NOTE_MAX);
    const at = Math.min(ta.value.length, s + ins.length);
    ta.focus(); ta.setSelectionRange(at, at);
    ta.dispatchEvent(new Event("input", { bubbles: true }));   // the save path hears it
  }
  /* a block's frame (board 8): the rust dashed frame, its pill riding the
     top edge, the handle, the layout, a town for the scoped blocks, ↑ ↓ × */
  function edRow(html, b, i, n, pair) {
    const act = (a, glyph, label, dis) =>
      `<button type="button" class="cz-edact" data-czed="${a}" data-i="${i}"
        aria-label="${esc(label)}" title="${esc(label)}"${dis ? " disabled" : ""}>${glyph}</button>`;
    return `<div class="cz-edrow" data-i="${i}" data-layout="${esc(b.layout || "")}"${pair ? ' data-pair="1"' : ""}>
      <div class="cz-edbar">
        <button type="button" class="cz-edhandle" data-i="${i}"
          aria-label="block ${i + 1} of ${n} — drag to move, or press ↑ ↓"
          title="drag to move — or press ↑ ↓">⠿</button>
        <span class="cz-edkind cz-edpill" title="${esc(blockLabel(b))}">${esc(pillLabel(b))}</span>
        <select class="cz-edlayout" data-i="${i}" aria-label="layout of block ${i + 1}" title="how this block sits on the page">
          <option value=""${b.layout ? "" : " selected"}>as it comes</option>
          ${PAPER_LAYOUTS.map(l => `<option value="${l}"${b.layout === l ? " selected" : ""}>${LAYOUT_LABEL[l]}</option>`).join("")}
        </select>
        ${edTownSelect(b, i)}
        <span class="cz-edacts">${act("up", "↑", `move block ${i + 1} up`, !i)}${act("down", "↓", `move block ${i + 1} down`, i >= n - 1)}${act("del", "×", `remove block ${i + 1}`)}</span>
      </div>
      <div class="cz-edbody">${b.kind === "note" ? edNote(b, i) : html}</div>
    </div>`;
  }
  /* the empty draft, in the studio (A4): a teaching surface — the title,
     three big starts (the same shapes the featured papers press, offered
     as DRAFTS; and the record itself, whose cards now carry "＋ your
     paper"), and the first insertion point. The starts' refs come from
     stats.json, the front page's own plane. */
  async function paperTeach(el, doc, gen) {
    // the stub's "needs JavaScript" hint must not stand while this script
    // is visibly running — paint the head now, the starts when they arrive
    const keep = captureEdFocus(el);
    if (!$(".cz-edteach", el)) {
      el.classList.add("cz-editing");
      el.innerHTML = edHead(doc, { noBoard: true }) + `<p class="hint cz-edwait">opening the editor…</p>`;
      restoreEdFocus(el, keep);
    }
    const st = await getJSON(`${BASE}/stats.json`) || {};
    if (gen !== PAPER_GEN) return;
    // the reader may have typed a title, or added a block from the panel,
    // while stats.json travelled — paint the draft as it stands now
    const fresh = readPaper();
    if (fresh.blocks.length) { renderPaperNow(); return; }
    doc = fresh;
    const keep2 = captureEdFocus(el) || keep;
    const lead = (st.new || [])[0], loud = (st.loud || [])[0];
    const start = (t, ref, label, sub) =>
      `<button type="button" class="cz-edstart" data-czed="tpl" data-tpl="${t}"${ref ? ` data-ref="${esc(ref)}"` : ""}>
        <b>${esc(label)}</b><span>${esc(sub)}</span></button>`;
    el.classList.add("cz-editing");
    ED_ASKS = [];
    // the templates board (board 7): eight cards, each what it draws and
    // what it asks; a Start opens the picker for what it is about. Under
    // them, the record's own two quickest starts — tonight's tape and the
    // widest thread — and the first insertion point for a blank page.
    el.innerHTML = edHead(doc, { noBoard: true }) + `<section class="cz-edteach cz-tplboard" aria-labelledby="cz-tpl-h">
        <h3 class="cz-tpl-h" id="cz-tpl-h">Start from a template</h3>
        <p class="cz-tpl-lede">Every template draws its own pictures from the record and, where the record holds one, offers its labeled reading to keep or cut. Each asks you three questions; your answers are the paper. Pick one, then pick the meeting, thread, question, person, place or towns it is about.</p>
        ${tplBoard()}
        <div class="cz-tplpick" hidden></div>
        <div class="cz-edstarts">
          ${lead && PAPER_REF.test(lead.pid || "") ? start("meeting", lead.pid, "tonight’s tape, covered",
                  `${lead.title || lead.pid} — the lead story, its numbers, its shape, its framing, the record’s reading`) : ""}
          ${loud && PAPER_REF.test(loud.slug || "") ? start("issue", loud.slug, `${cut(loud.name || loud.slug, 60)}, over time`,
                  `the record’s widest thread — ${loud.n_meetings || 0} meeting${loud.n_meetings === 1 ? "" : "s"}, its timeline, a reel, its framing`) : ""}
          ${start("rolls", "", "the roll calls, watched", "every roll call on the record, dot by dot — and how the talk around them was framed")}
          <a class="cz-edstart" href="${BASE}/"><b>browse the record →</b>
            <span>every meeting and issue card carries “＋ your paper” — read, and press it when a story is yours</span></a>
        </div>
        <p class="cz-hint">a template is a list of blocks and three questions — the record fills the blocks, you answer the questions · your page stores its title, your notes and references, nothing else. Or add the first block right here:</p>
        ${edSlot(0)}
      </section>`;
    wireEditor(el);
    bsEditorPage();
    // a second pass (the storage event, the panel typing) must put the
    // caret back where it was — the block path's rule, kept here too
    restoreEdFocus(el, PAGE_FOCUS || keep2); PAGE_FOCUS = null;
  }
  /* the templates board's cards (board 7) — pure over TEMPLATES */
  const tplBoard = () => `<div class="cz-tplgrid">${TEMPLATE_ORDER.map(t => { const T = TEMPLATES[t];
    return `<button type="button" class="cz-tplcard" data-czed="tplstart" data-tpl="${t}">
      <b>${esc(T.name)}</b><span class="cz-tpl-draws">${esc(T.draws)}</span>
      <span class="cz-tpl-asks">asks · ${T.asks.length ? T.asks.map(esc).join(" · ") : "—"}</span>
      <span class="cz-tpl-go">Start →</span></button>`; }).join("")}</div>`;
  const PICK_WORDS = { meeting: ["which meeting?", "a body, a month, a title…"], issue: ["which thread?", "an issue’s name…"],
    people: ["which person?", "a name the record keeps hearing…"], places: ["which place?", "a street, a square, a park…"],
    towns: ["which two towns?", ""] };
  /* a Start (board 7): a template about something opens the picker; the
     year and the roll calls write at once; the blank page opens its first
     insertion point */
  function tplStart(t, el, card) {
    const T = TEMPLATES[t]; if (!T) return;
    if (t === "blank") { const slot = $('.cz-edslot[data-at="0"]', el) || $(".cz-edslot", el); if (slot) openEdAdd(slot); return; }
    if (!T.pick) { applyPaperTemplate(t, null, "page"); return; }
    // the picker of THIS board (the head's, or the empty page's) — a shared
    // id painted the wrong one, inside a closed details (a pane catch)
    const wrap = card && card.closest(".cz-tplboard-wrap, .cz-tplboard");
    tplPicker(t, wrap && $(".cz-tplpick", wrap), card);
  }
  /* the picker's close: the box empties and the keyboard goes back to the
     card that opened it — never to <body> (a review catch) */
  function tplClose(box) {
    if (!box) return;
    const back = box._origin; box.hidden = true; box.innerHTML = "";
    if (back && back.isConnected && typeof back.focus === "function") back.focus();
  }
  async function tplPicker(t, box, card) {
    const T = TEMPLATES[t]; if (!box || !T) return;
    box._origin = card || null;
    const [ask, ph] = PICK_WORDS[T.pick] || ["which?", ""];
    box.hidden = false;
    box.innerHTML = `<div class="cz-tplpick-in" role="group" aria-label="${esc(T.name)} — ${esc(ask)}">
      <div class="cz-deskhead"><span class="cz-tag">${esc(T.name)} — ${esc(ask)}</span><button type="button" class="btn cz-tplclose" data-czed="tplclose">close</button></div>
      ${T.pick === "towns" ? "" : `<input class="cz-tplq" type="search" autocomplete="off" placeholder="${esc(ph)}" aria-label="${esc(ask)}">`}
      <p class="cz-edcount" role="status"></p>
      <div class="cz-tplhits"></div></div>`;
    const q = $(".cz-tplq", box);
    // every keystroke — and every Start on this box — is a generation; only
    // the newest paints (the counter lives on the box, not the call)
    const paint = async () => {
      const my = box._gen = (box._gen || 0) + 1;
      const terms = lexTerms(q ? q.value : "");
      let items = [];
      if (T.pick === "meeting" || T.pick === "issue") {
        const idx = await edIndex();
        items = lexRank(terms, T.pick === "meeting" ? idx.meetings : idx.issues).slice(0, 8)
          .map(h => ({ ref: h.ref, title: h.title, meta: h.meta }));
      } else if (T.pick === "people" || T.pick === "places") {
        const an = await getJSON(`${BASE}/analytics.json`);
        const names = (an && Array.isArray(an.names) ? an.names : []).filter(n => n && typeof n.name === "string" && n.kind === T.pick)
          .map(n => ({ ref: String(n.slug || bsWho(n.kind, n.name)), title: n.name, text: n.name, sort: (n.meetings || []).length,
                       meta: `${nOf((n.meetings || []).length, "meeting", "meetings")} · ${Math.floor(+n.count || 0)}×` }));
        items = lexRank(terms, names).slice(0, 10);
      } else if (T.pick === "towns") {
        const ed = await edition();
        const ts = (ed.towns || []).map(x => String((x && x.town) || "")).filter(Boolean);
        for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++)
          items.push({ ref: `${ts[i]}|${ts[j]}`, title: `${ts[i]} and ${ts[j]}`, meta: "side by side" });
      }
      const hits = $(".cz-tplhits", box), count = $(".cz-edcount", box);
      if (!hits || my !== box._gen) return;
      const none = T.pick === "towns" ? "this pressing holds one town — two towns side by side needs two" : terms.length ? "nothing on the record matches" : "the record holds nothing to pick yet";
      hits.innerHTML = items.length
        ? items.map(it => `<button type="button" class="cz-tplhit" data-czed="tplgo" data-tpl="${t}" data-ref="${esc(it.ref)}" data-name="${esc(it.title)}">
            <b>${esc(it.title)}</b><span>${esc(it.meta)}</span><span class="cz-tplgo">Start →</span></button>`).join("")
        : "";
      // the status line speaks either way — a count, or why there is none
      if (count) count.textContent = items.length ? `${items.length} to pick from` : none;
    };
    if (q) { q.addEventListener("input", () => { clearTimeout(q._deb); q._deb = setTimeout(paint, 180); }); q.focus(); }
    await paint();
    if (!q) { const first = $(".cz-tplhit", box); if (first) first.focus(); }
  }
  function tplGo(t, ref, name) {
    const T = TEMPLATES[t]; if (!T) return;
    const r = T.pick === "meeting" ? { story: "meeting", pid: ref }
      : T.pick === "issue" ? { story: "issue", slug: ref }
      : T.pick === "people" || T.pick === "places" ? { who: ref, name }
      : T.pick === "towns" ? { a: ref.split("|")[0], b: ref.split("|")[1] } : null;
    applyPaperTemplate(t, r, "page");
  }
  /* share as a link (board 8): the link goes to the clipboard and the other
     outputs unfold — paper.json, the short link, clear */
  function edShare(el) {
    const p = readPaper();
    if (!paperHasLive(p)) { toast("add a block or a headline first — an empty page has nothing to share"); return; }
    copyText(paperShareURL(p), "link copied — it carries the whole front page");
    ED_SHARE_OPEN = true;
    const row = $(".cz-edshare", el); if (row) row.hidden = false;
  }
  /* focus survives a repaint: what the reader was on, put back after the
     innerHTML swap — the panel's rule (refreshPaperSummary), on the page */
  function captureEdFocus(el) {
    const ae = document.activeElement;
    if (!ae || !el.contains(ae) || !ae.classList) return null;
    if (ae.classList.contains("cz-edtitle")) return { act: "title", caret: ae.selectionStart };
    if (ae.classList.contains("cz-ednote")) return { act: "note", i: +ae.dataset.i, caret: ae.selectionStart };
    if (ae.classList.contains("cz-edhandle")) return { act: "handle", i: +ae.dataset.i };
    if (ae.classList.contains("cz-edlayout")) return { act: "layout", i: +ae.dataset.i };
    if (ae.classList.contains("cz-edtown")) return { act: "town", i: +ae.dataset.i };
    if (ae.classList.contains("cz-blk")) return { act: "blk", blk: ae.dataset.blk };
    if (ae.classList.contains("cz-tplq")) return { act: "tplq", caret: ae.selectionStart };
    if (ae.classList.contains("pb-pv")) return { act: "pbpv", key: ae.dataset.pvkey };
    // an open inline add survives the repaint with its query and its caret:
    // the field itself, or one of its hit buttons (focus returns to the field)
    const slot = ae.closest(".cz-edslot");
    const q = slot && $(".cz-edq", slot);
    if (q) return { act: "q", at: +slot.dataset.at, v: q.value, pick: slot.dataset.pick || "",
                    caret: ae === q ? q.selectionStart : null };
    if (ae.dataset && ae.dataset.czed) return { act: ae.dataset.czed, i: +ae.dataset.i };
    return null;
  }
  /* an open inline add that does NOT hold focus still survives a repaint —
     as an open panel with its query, focus left where it was */
  function captureEdPanel(el) {
    const q = $(".cz-edpanel .cz-edq", el); if (!q) return null;
    const slot = q.closest(".cz-edslot");
    return { act: "qkeep", at: +slot.dataset.at, v: q.value, pick: slot.dataset.pick || "" };
  }
  function restoreEdFocus(el, f) {
    if (!f) return;
    if (f.act === "q" || f.act === "qkeep") {
      const slot = $(`.cz-edslot[data-at="${f.at}"]`, el);
      if (!slot) return;
      openEdAdd(slot, { value: f.v, focus: f.act === "q", caret: f.caret, pick: f.pick });
      return;
    }
    let t = f.act === "title" ? $(".cz-edtitle", el)
      : f.act === "note" ? $(`.cz-ednote[data-i="${f.i}"]`, el)
      : f.act === "handle" ? $(`.cz-edhandle[data-i="${f.i}"]`, el)
      : f.act === "layout" ? $(`.cz-edlayout[data-i="${f.i}"]`, el)
      : f.act === "town" ? $(`.cz-edtown[data-i="${f.i}"]`, el)
      : f.act === "blk" ? $(`.cz-blk[data-blk="${f.blk}"]`, el)
      : f.act === "tplq" ? $(".cz-tplq", el)
      : f.act === "pbpv" ? $$(".pb-pv", el).find(b => b.dataset.pvkey === f.key)
      : f.act === "add" ? $(`.cz-edadd[data-i="${f.i}"]`, el)
      : $(`[data-czed="${f.act}"][data-i="${f.i}"]`, el);
    // NEVER fall to the destructive ✕: a control that vanished or disabled
    // under the repaint falls to its block's handle, then to the title
    if (!t || t.disabled || f.act === "del") t = $(`.cz-edhandle[data-i="${f.i}"]`, el);
    if (!t && f.i != null) { const hs = $$(".cz-edhandle", el); t = hs[Math.min(f.i, hs.length - 1)]; }
    if (!t) t = $(".cz-edtitle", el);
    if (!t || typeof t.focus !== "function") return;
    t.focus();
    if (typeof f.caret === "number" && t.setSelectionRange)
      t.setSelectionRange(f.caret, f.caret);
  }
  /* the editor's listeners — delegated, installed once per #paperbody, so a
     repaint never needs rewiring */
  function wireEditor(el) {
    if (el._czed) return; el._czed = true;
    // as the page goes to paper, the print twins re-read the live fields
    window.addEventListener("beforeprint", () => {
      if (!el.isConnected) return;
      $$(".cz-ednote", el).forEach(ta => {
        const tw = ta.parentElement && $(".cz-ednote-print", ta.parentElement);
        if (tw) tw.innerHTML = notePrint(noteText(ta.value)); });
      const ti = $(".cz-edtitle", el), tw = $(".cz-edtitle-print", el);
      if (ti && tw) tw.textContent = printTitle(cut(ti.value, PAPER_TITLE_MAX));
    });
    // the desk cites into the paragraph the caret was last in
    el.addEventListener("focusin", e => {
      const t = e.target; if (t && t.classList && t.classList.contains("cz-ednote")) DESK_NOTE = +t.dataset.i;
    });
    el.addEventListener("click", e => {
      const f = e.target.closest && e.target.closest("[data-czfact]");
      if (f && el.contains(f)) { citeFact(f); return; }
      const ask = e.target.closest && e.target.closest("[data-czask]");
      if (ask && el.contains(ask)) { focusAsk(+ask.dataset.czask); return; }
      const b = e.target.closest && e.target.closest("[data-czed]");
      if (!b || !el.contains(b)) return;
      const act = b.dataset.czed, i = +b.dataset.i;
      if (act === "up" || act === "down") movePaperBlock(i, act === "up" ? "pup" : "pdown", "page");
      else if (act === "del") movePaperBlock(i, "pdel", "page");
      else if (act === "add") openEdAdd(b.closest(".cz-edslot"));
      else if (act === "close") closeEdAdd(b.closest(".cz-edslot"));
      // the board (specs/29): the shelf, the head's two acts and the share
      // row, the templates board and its picker, the desk's draft
      else if (act === "blk") shelfAdd(b.dataset.blk);
      else if (act === "preview") setMode("preview");
      else if (act === "share") edShare(el);
      else if (act === "plink") copyText(paperShareURL(readPaper()), "link copied — it carries the whole front page");
      else if (act === "pjson") downloadPaper(readPaper());
      else if (act === "pshort") paperShortLink().then(() => { if (PAPER_SHORT) renderPaperNow(); });
      else if (act === "pclear") clearPaper();
      else if (act === "tplstart") tplStart(b.dataset.tpl, el, b);
      else if (act === "tplgo") tplGo(b.dataset.tpl, b.dataset.ref || "", b.dataset.name || "");
      else if (act === "tplclose") tplClose(b.closest(".cz-tplpick"));
      else if (act === "draft") addReadingToPaper(b.dataset.ref || "");
      else if (act === "receipts") { const r = b.closest(".cz-deskcard") && $(".cz-deskreceipts", b.closest(".cz-deskcard"));
        if (r) { r.hidden = !r.hidden; b.setAttribute("aria-expanded", r.hidden ? "false" : "true"); b.textContent = r.hidden ? "Show the receipts" : "Hide the receipts"; } }
      else if (act === "tpl") {
        const t = b.dataset.tpl, r = b.dataset.ref || "";
        applyPaperTemplate(t, t === "meeting" ? { story: "meeting", pid: r }
                            : t === "issue" ? { story: "issue", slug: r } : null, "page");
      } else if (act === "hit") {
        const slot = b.closest(".cz-edslot"); if (!slot) return;
        const at = +slot.dataset.at, kind = b.dataset.kind, ref = b.dataset.ref || "";
        if (kind === "m") addStoryRef({ story: "meeting", pid: ref }, at);
        else if (kind === "lead") addLeadRef(ref, at);
        else if (kind === "bs") addBsBlock(ref, at);
        else if (kind === "pick") openEdAdd(slot, { pick: ref });
        else if (kind === "i") addStoryRef({ story: "issue", slug: ref }, at);
        else if (kind === "cm") addChartToPaper("framing", ref, at);
        else if (kind === "ci") addChartToPaper("reach", ref, at);
        else if (kind === "cn") addChartToPaper("numbers", ref, at);
        else if (kind === "cs") addChartToPaper("shape", ref, at);
        else if (kind === "cl") addChartToPaper("ledger", ref, at);
        else if (kind === "cv") addChartToPaper("votes", ref, at);
        else if (kind === "a") addReadingToPaper(ref, at);
        else if (kind === "chart") addChartToPaper(ref, "", at);
        else if (kind === "note") addNoteToPaper(at);
        else if (kind === "reel") addReelToPaper(at);
        else if (kind === "q") { const [pid, t] = ref.split(":"); addQuoteRef(pid, +t, at, b.dataset.text || ""); }
        else if (kind === "g") addDigestRef(ref, at, 3);
        else if (kind === "dd") { const [pid, doc] = ref.split("~"); addDocRef(pid, doc, at); }
        else if (kind === "d") docChooser(b, ref);
      }
    });
    el.addEventListener("keydown", e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const h = e.target.closest && e.target.closest(".cz-edhandle");
      if (h && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        movePaperBlock(+h.dataset.i, e.key === "ArrowUp" ? "pup" : "pdown", "page");
      } else if (e.key === "Escape") {
        const slot = e.target.closest && e.target.closest(".cz-edslot");
        if (slot && $(".cz-edpanel", slot)) { e.preventDefault(); closeEdAdd(slot); return; }
        const pick = e.target.closest && e.target.closest(".cz-tplpick");
        if (pick && !pick.hidden) { e.preventDefault(); tplClose(pick); }
      }
    });
    // typing on the page saves on every keystroke and repaints the PANEL
    // (never this page, whose field holds the caret) — the panel's own rule,
    // mirrored. The panel's fields are not focused, so its repaint is safe.
    el.addEventListener("input", e => {
      const t = e.target; if (!t || !t.classList) return;
      if (t.classList.contains("cz-edtitle")) {
        const d = readPaper();
        d.title = cut(t.value, PAPER_TITLE_MAX);
        const tw = $(".cz-edtitle-print", el); if (tw) tw.textContent = printTitle(d.title);
        if (!savePaper(d)) return;
        retireShortOut(); refreshPaperSummary();
        document.title = `${d.title || "A paper"} — publicrecord.studio`;
      } else if (t.classList.contains("cz-ednote")) {
        const d = readPaper(), i = +t.dataset.i;
        if (!(d.blocks[i] && d.blocks[i].kind === "note")) return;
        d.blocks[i].text = noteText(t.value);
        const tw = t.parentElement && $(".cz-ednote-print", t.parentElement);
        if (tw) tw.innerHTML = notePrint(d.blocks[i].text);
        if (!savePaper(d)) return;
        retireShortOut(); refreshPaperSummary();
      } else if (t.classList.contains("cz-edq")) {
        edSearch(t.closest(".cz-edslot"));
      }
    });
    // the layout select (C1): a change writes the enum and repaints both
    // surfaces; focus returns to the same select on the same block
    el.addEventListener("change", e => {
      const t = e.target; if (!t || !t.classList) return;
      if (t.classList.contains("cz-edlayout")) setBlockLayout(+t.dataset.i, t.value);
      else if (t.classList.contains("cz-edtown")) setBlockTown(+t.dataset.i, t.value);
    });
    wireEditorDnD(el);
  }
  function setBlockLayout(i, layout) {
    const p = readPaper();
    if (!(i >= 0 && i < p.blocks.length)) return;
    if (PAPER_LAYOUTS.includes(layout)) p.blocks[i].layout = layout;
    else delete p.blocks[i].layout;
    if (!savePaper(p)) { toast("this browser blocks storage — the change didn’t hold"); return; }
    retireShortOut();
    PAGE_FOCUS = { act: "layout", i };
    refreshPaperSummary(); renderPaperNow();
  }
  /* drag-and-drop: the handle arms its row (a row is draggable only while
     its handle is held, so text in a note can still be selected — Firefox
     cannot select inside a draggable ancestor); a row or a slot is the
     target; the drop index is the slot's, or the row's upper/lower half. */
  let ED_DRAG = -1;
  let ED_SHELF = "";   // a shelf block in flight (board 8: drag into the page)
  const edClearDrop = el => { ED_SHELF = "";   // a shelf block in flight is forgotten with the marks
    $$(".cz-drop-before, .cz-drop-after, .cz-drop-here, .cz-dragging", el)
      .forEach(x => x.classList.remove("cz-drop-before", "cz-drop-after", "cz-drop-here", "cz-dragging")); };
  function wireEditorDnD(el) {
    el.addEventListener("pointerdown", e => {
      const h = e.target.closest && e.target.closest(".cz-edhandle");
      const row = h && h.closest(".cz-edrow");
      if (row) row.draggable = true;
    });
    el.addEventListener("pointerup", () => $$(".cz-edrow[draggable]", el).forEach(r => r.draggable = false));
    // a shelf block lifted: it lands where it is dropped (a slot, or a row's
    // upper/lower half), through the same targets a moved row uses
    el.addEventListener("dragstart", e => {
      const blk = e.target.closest && e.target.closest(".cz-blk");
      if (!blk) return;
      ED_SHELF = blk.dataset.blk || ""; ED_DRAG = -1;
      // copyMove: the dragover below asks for "copy" on a shelf block and
      // "move" on a row; an effect outside effectAllowed is "none" and the
      // drop never fires (a review catch, confirmed live)
      try { e.dataTransfer.setData("text/plain", "block:" + ED_SHELF); e.dataTransfer.effectAllowed = "copyMove"; } catch { /* no dataTransfer */ }
    });
    el.addEventListener("dragstart", e => {
      const row = e.target.closest && e.target.closest(".cz-edrow");
      // outside an editor row this is the reader's own drag (a link, a
      // selection) and none of our business; inside an UNARMED row it is
      // a link being dragged out of a block, which the handle owns
      if (!row) return;
      if (!row.draggable) { e.preventDefault(); return; }
      ED_DRAG = +row.dataset.i; row.classList.add("cz-dragging");
      try { e.dataTransfer.setData("text/plain", String(ED_DRAG));
            e.dataTransfer.effectAllowed = "move"; } catch { /* a browser without dataTransfer */ }
    });
    el.addEventListener("dragover", e => {
      if (ED_DRAG < 0 && !ED_SHELF) return;
      const row = e.target.closest && e.target.closest(".cz-edrow");
      const slot = e.target.closest && e.target.closest(".cz-edslot");
      if (!row && !slot) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = ED_SHELF ? "copy" : "move"; } catch { /* ditto */ }
      $$(".cz-drop-before, .cz-drop-after, .cz-drop-here", el)
        .forEach(x => x.classList.remove("cz-drop-before", "cz-drop-after", "cz-drop-here"));
      if (slot) slot.classList.add("cz-drop-here");
      else { const r = row.getBoundingClientRect();
        row.classList.add(e.clientY < r.top + r.height / 2 ? "cz-drop-before" : "cz-drop-after"); }
    });
    el.addEventListener("drop", e => {
      if (ED_DRAG < 0 && !ED_SHELF) return;
      const row = e.target.closest && e.target.closest(".cz-edrow");
      const slot = e.target.closest && e.target.closest(".cz-edslot");
      // a block dropped anywhere else in the editor (the title field, a
      // note) is a cancelled move — never a payload typed into a field
      if (!row && !slot) { e.preventDefault(); ED_DRAG = -1; edClearDrop(el); return; }
      e.preventDefault();
      let to;
      if (slot) to = +slot.dataset.at;
      else { const r = row.getBoundingClientRect();
        to = +row.dataset.i + (e.clientY < r.top + r.height / 2 ? 0 : 1); }
      const from = ED_DRAG, kind = ED_SHELF; ED_DRAG = -1; ED_SHELF = "";
      edClearDrop(el);
      if (kind) shelfAdd(kind, to); else movePaperBlockTo(from, to);
    });
    el.addEventListener("dragend", () => { ED_DRAG = -1; ED_SHELF = ""; edClearDrop(el);
      $$(".cz-edrow[draggable]", el).forEach(r => r.draggable = false); });
  }
  /* the inline add (A3): one open at a time; the ＋ it replaces takes focus
     back on close (Escape, or the close button) */
  function openEdAdd(slot, opts) {
    if (!slot) return;
    opts = opts || {};
    $$(".cz-edpanel").forEach(x => closeEdAdd(x.closest(".cz-edslot"), true));
    const btn = $(".cz-edadd", slot); if (!btn) return;
    btn.setAttribute("aria-expanded", "true"); btn.hidden = true;
    // a shelf pick narrows the add to one kind of thing (board 8)
    const pick = opts.pick || ""; slot.dataset.pick = pick;
    const PICK = { lead: ["the lead story — which meeting?", "a body, a month, a title…"],
      over: ["over time — which thread?", "an issue’s name…"],
      quote: ["a quote — a word said on the tape", "three characters or more of what was said…"],
      numbers: ["in numbers — which meeting or issue?", "a body, a month, an issue’s name…"] };
    const [label, ph] = PICK[pick] || ["find a meeting or an issue", "a body, a month, an issue’s name…"];
    const clips = readReel(REEL_KEY);
    const quick = (kind, ref, label) =>
      `<button type="button" class="btn" data-czed="hit" data-kind="${kind}" data-ref="${esc(ref)}">${esc(label)}</button>`;
    const panel = document.createElement("div"); panel.className = "cz-edpanel";
    // the hit list is NOT a live region: ten cards re-announced per
    // keystroke would drown the field. One short status line speaks the
    // count instead; the list is there to be walked.
    panel.innerHTML = `<label class="cz-edqlabel">${esc(label)}
        <input class="cz-edq" type="search" autocomplete="off"
          placeholder="${esc(ph)}"></label>
      <p class="cz-edcount" role="status"></p>
      <div class="cz-edhits"></div>
      <div class="cz-edquick">
        ${pick ? "" : quick("note", "", "＋ a paragraph")}
        ${!pick && clips.length ? quick("reel", "", `＋ your reel (${clips.length} clip${clips.length > 1 ? "s" : ""})`) : ""}
        ${pick ? "" : quick("pick", "lead", "★ a lead story")}
        ${pick ? "" : quick("pick", "over", "◈ over time")}
        ${pick ? "" : quick("bs", "week", "▦ this week")}
        ${pick ? "" : quick("bs", "threads", "⟁ threads")}
        ${pick ? "" : quick("bs", "strip", "▤ how they talked")}
        ${pick ? "" : quick("bs", "names", "◎ who and where")}
        ${pick ? "" : quick("bs", "search", "⌕ a search box")}
        ${pick ? "" : quick("chart", "votes", "▤ votes over time")}
        ${pick ? "" : quick("chart", "framing", "▤ the record’s framing")}
        ${pick ? "" : quick("chart", "topics", "▤ recurring topics")}
        <button type="button" class="btn cz-edclose" data-czed="close">close</button>
      </div>`;
    slot.appendChild(panel);
    const q = $(".cz-edq", panel);
    if (q) {
      if (typeof opts.value === "string") q.value = opts.value;
      if (opts.focus !== false) { q.focus();
        if (typeof opts.caret === "number" && q.setSelectionRange)
          q.setSelectionRange(opts.caret, opts.caret); }
    }
    edSearch(slot);   // the empty query lists a browse start
  }
  function closeEdAdd(slot, quiet) {
    if (!slot) return;
    const p = $(".cz-edpanel", slot); if (p) p.remove();
    const btn = $(".cz-edadd", slot);
    if (btn) { btn.hidden = false; btn.setAttribute("aria-expanded", "false");
      if (!quiet) btn.focus(); }
  }
  /* the add-search's lexical rank — pure, twin-tested: every term must
     occur in the item's text; a hit at a word start outranks one inside a
     word; ties fall to the item's own order (newest meeting, widest issue).
     No terms = everything, in that order (the browse start). */
  const lexTerms = q => (String(q || "").toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 8);
  function lexRank(terms, items) {
    const scored = [];
    for (const it of items) {
      const text = String(it.text || "").toLowerCase();
      let score = 0, ok = true;
      for (const t of terms) {
        const at = text.indexOf(t);
        if (at < 0) { ok = false; break; }
        score += (at === 0 || /[^a-z0-9]/.test(text[at - 1])) ? 2 : 1;
      }
      if (ok) scored.push([score, it]);
    }
    scored.sort((a, b) => b[0] - a[0]
      || (b[1].sort > a[1].sort ? 1 : b[1].sort < a[1].sort ? -1 : 0));
    return scored.map(x => x[1]);
  }
  /* the tape's lines by the words a search finds — the reader's own static
     search index (search/segs.json + a term shard), the same planes
     staticSearch reads, so no plane is new and no door is added; three
     characters or more, five hits, the newest meeting first */
  async function linesSearch(terms, q) {
    if (!terms.length || String(q || "").trim().length < 3) return [];
    const [meta, segs] = await Promise.all([
      getJSON(`${BASE}/search/meta.json`), getJSON(`${BASE}/search/segs.json`)]);
    if (!Array.isArray(meta) || !Array.isArray(segs)) return [];
    const sets = await Promise.all(terms.map(async t => {
      const c = /^[a-z0-9]$/.test(t[0]) ? t[0] : "_";
      const sh = await getJSON(`${BASE}/search/t-${c}.json`);
      // own, listed postings only — a query holding "constructor" would
      // otherwise read Object.prototype's and throw (a review catch)
      return new Set(Array.isArray(sh && sh[t]) && Object.prototype.hasOwnProperty.call(sh, t) ? sh[t] : []);
    }));
    let ids = [...(sets[0] || [])];
    for (let i = 1; i < sets.length; i++) ids = ids.filter(x => sets[i].has(x));
    const phrase = String(q).trim().toLowerCase();
    let hits = ids.filter(id => segs[id]);
    if (terms.length > 1) {
      const exact = hits.filter(id => String(segs[id][3]).toLowerCase().includes(phrase));
      if (exact.length) hits = exact;
    }
    return hits.map(id => { const [mi, t, , text] = segs[id]; const m = meta[mi] || {};
      return { pid: m.pid || "", t: +t || 0, text: String(text || ""), title: m.title || m.pid || "", date: m.date || "" }; })
      .filter(l => PAPER_REF.test(l.pid))
      .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0) || a.t - b.t)
      .slice(0, 5);
  }
  /* a meeting's documents on demand — the one button becomes one per filing */
  async function docChooser(btn, pid) {
    const url = `${BASE}/meetings/${encodeURIComponent(pid)}.json`;
    // a null the paper's own render cached is not this press's answer: ask
    // once more before saying "didn't load" — and only then, so a fresh
    // failure costs one fetch, not two (a review catch)
    const cached = url in _cache;
    let m = await getJSON(url);
    if (!m && cached) { delete _cache[url]; m = await getJSON(url); }
    if (!btn.isConnected) return;
    // a failed load is not kept: the retry below fetches again
    if (!m) delete _cache[url];
    const span = document.createElement("span"); span.className = "cz-eddocs";
    const docs = (m && Array.isArray(m.documents)) ? m.documents : [];
    // a plane that did not load is a different fact from a meeting that
    // filed nothing — and either way the keyboard lands on something
    span.innerHTML = !m
      ? `<span class="cz-edhit-in">this meeting’s plane didn’t load</span> <button type="button" class="btn"
          data-czed="hit" data-kind="d" data-ref="${esc(pid)}" aria-label="try again — load this meeting’s documents">try again</button>`
      : docs.length
      ? docs.slice(0, 6).map(d => `<button type="button" class="btn" data-czed="hit" data-kind="dd"
          data-ref="${esc(pid)}~${esc(d.doc_id)}" aria-label="add the ${esc(d.kind || "document")} “${esc(d.title || d.doc_id)}”">📄 ${esc(d.kind || "document")}${d.title ? ` — ${esc(cut(d.title, 28))}` : ""}</button>`).join("")
      : `<span class="cz-edhit-in" tabindex="-1">no documents filed for this meeting</span>`;
    // a retry replaces the whole chooser it stood in, message and all
    (btn.closest(".cz-eddocs") || btn).replaceWith(span);
    const first = $("button, [tabindex]", span); if (first) first.focus();
  }
  let ED_INDEX = null;   // the static index, read once per page
  /* total over whatever arrives (decodeReel's law): a plane that did not
     load is remembered as DARK — "the index didn't load" is a different
     fact from "the record holds nothing", and the reader is owed the true
     one; a plane that loaded is re-asked for never, a dark one is retried
     on the next open. A malformed element is simply not an entry. */
  const edEntry = x => x && typeof x === "object";
  function edIndex() {
    return ED_INDEX ||= Promise.all([
      getJSON(`${BASE}/search/meta.json`), getJSON(`${BASE}/issues/index.json`),
    ]).then(([meta, issues]) => ({
      dark: { m: !Array.isArray(meta), i: !Array.isArray(issues) },
      meetings: (Array.isArray(meta) ? meta : []).filter(m => edEntry(m) && PAPER_REF.test(m.pid || "")).map(m => ({
        kind: "m", ref: m.pid, title: m.title || m.pid,
        meta: [m.body, m.town, m.date].filter(Boolean).join(" · "),
        text: [m.title, m.body, m.town, m.date].filter(Boolean).join(" "),
        sort: m.date || "" })),
      issues: (Array.isArray(issues) ? issues : []).filter(i => edEntry(i) && PAPER_REF.test(i.slug || "")).map(i => ({
        kind: "i", ref: i.slug, title: i.name || i.slug,
        meta: `issue · ${i.n_meetings || 0} meeting${i.n_meetings === 1 ? "" : "s"}`
          + (i.first_seen ? ` · ${String(i.first_seen).slice(0, 4)}–${String(i.last_seen || "").slice(0, 4)}` : ""),
        text: [i.name, ...(Array.isArray(i.aliases) ? i.aliases : [])].filter(Boolean).join(" "),
        sort: +i.n_meetings || 0 })),
    })).then(idx => { if (idx.dark.m || idx.dark.i) edForget(idx.dark); return idx; },
             () => { edForget({ m: true, i: true });
                     return { dark: { m: true, i: true }, meetings: [], issues: [] }; });
  }
  /* a dark plane is retried on the next open — which means forgetting it
     in getJSON's own cache as well (that cache keeps a failed fetch's null
     for the page's life), not only here */
  function edForget(dark) {
    ED_INDEX = null;
    if (dark.m) delete _cache[`${BASE}/search/meta.json`];
    if (dark.i) delete _cache[`${BASE}/issues/index.json`];
  }
  async function edSearch(slot) {
    if (!slot) return;
    const idx = await edIndex();
    const box = $(".cz-edhits", slot), q = $(".cz-edq", slot);
    const count = $(".cz-edcount", slot);
    if (!box || !q) return;   // closed while the index loaded
    const terms = lexTerms(q.value);
    const pick = slot.dataset.pick || "";
    const is = pick === "lead" || pick === "quote" ? [] : lexRank(terms, idx.issues).slice(0, 5);
    const ms = pick === "over" || pick === "quote" ? [] : lexRank(terms, idx.meetings).slice(0, 5);
    const p = readPaper();
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    if (idx.dark.m && idx.dark.i) {
      if (count) count.textContent = "";
      box.innerHTML = `<p class="cz-hint">the record’s index didn’t load here —
        try again in a moment, or add a story from its own meeting or issue
        page (“＋ your paper”).</p>`;
      return;
    }
    const dark = idx.dark.m ? " · the meetings index didn’t load"
               : idx.dark.i ? " · the issues index didn’t load" : "";
    // every keystroke is a generation; only the newest paints. The index
    // hits paint at once; the tape's lines (C2 — a bigger plane) land after
    const gen = slot._edgen = (slot._edgen || 0) + 1;
    const countLine = ls => (is.length || ms.length || ls.length)
      ? (pick === "quote" ? "" : `${n(is.length, "issue", "issues")} · ${n(ms.length, "meeting", "meetings")}`)
        + (ls.length ? `${pick === "quote" ? "" : " · "}${n(ls.length, "line", "lines")}` : "") + (terms.length ? " match" : "") + dark
      : `no match${dark}`;
    // no verdict while the tape's lines are still being read — a "no match"
    // announced now would be taken back when they land. The lines are read
    // only for three characters or more (linesSearch's own gate): "searching"
    // and "or their lines" are said only then (a review catch)
    const linesOK = terms.length > 0 && q.value.trim().length >= 3;
    // a shelf pick for a meeting, a thread or a count reads the index alone
    // (never the tape's lines); the quote pick reads the lines alone
    const indexPick = pick === "lead" || pick === "over" || pick === "numbers";
    if (count) count.textContent = (pick === "quote" && !linesOK) ? ""
      : (linesOK && !indexPick && !is.length && !ms.length) ? "searching the tape’s own lines…" : countLine([]);
    const hit = h => {
      const ref = h.kind === "m" ? { story: "meeting", pid: h.ref } : { story: "issue", slug: h.ref };
      const on = storyIndex(p, ref) >= 0;
      // a pick narrows each hit to its one act (board 8's shelf)
      if (pick) return `<div class="cz-edhit">
        <span class="cz-edhit-t"><b>${esc(h.title)}</b><span class="cz-edhit-m">${esc(h.meta)}</span></span>
        <span class="cz-edhit-a">${pick === "lead"
          ? `<button type="button" class="btn" data-czed="hit" data-kind="lead" data-ref="${esc(h.ref)}" aria-label="“${esc(h.title)}” as the lead story">★ lead story</button>`
          : pick === "over"
          ? `<button type="button" class="btn" data-czed="hit" data-kind="ci" data-ref="${esc(h.ref)}" aria-label="“${esc(h.title)}” over time — its timeline">◈ over time</button>`
          : `<button type="button" class="btn" data-czed="hit" data-kind="cn" data-ref="${h.kind === "m" ? "m:" : "i:"}${esc(h.ref)}" aria-label="“${esc(h.title)}” in numbers">▤ in numbers</button>`}</span></div>`;
      return `<div class="cz-edhit">
        <span class="cz-edhit-t"><b>${esc(h.title)}</b><span class="cz-edhit-m">${esc(h.meta)}</span></span>
        <span class="cz-edhit-a">${on
          ? `<span class="cz-edhit-in">✓ in your paper</span>`
          : `<button type="button" class="btn" data-czed="hit" data-kind="${h.kind}" data-ref="${esc(h.ref)}"
               aria-label="add “${esc(h.title)}” as a story">＋ story</button>`}
          <button type="button" class="btn" data-czed="hit" data-kind="cn" data-ref="${h.kind === "m" ? "m:" : "i:"}${esc(h.ref)}"
            aria-label="“${esc(h.title)}” in numbers — a strip of counted facts">▤ numbers</button>
          ${h.kind === "m"
            ? `<button type="button" class="btn" data-czed="hit" data-kind="cs" data-ref="${esc(h.ref)}" aria-label="the shape of “${esc(h.title)}” — its moments on the tape">▤ shape</button>`
            : `<button type="button" class="btn" data-czed="hit" data-kind="cl" data-ref="${esc(h.ref)}" aria-label="every roll call along the way of “${esc(h.title)}”">▤ ledger</button>`}
          <button type="button" class="btn" data-czed="hit" data-kind="a" data-ref="${h.kind === "m" ? "m:" : "i:"}${esc(h.ref)}"
            aria-label="the record’s reading of “${esc(h.title)}”">✎ the reading</button>
          <button type="button" class="btn" data-czed="hit" data-kind="${h.kind === "m" ? "cm" : "ci"}" data-ref="${esc(h.ref)}"
            aria-label="add a ${h.kind === "m" ? "framing" : "reach"} chart for “${esc(h.title)}”">▤ ${h.kind === "m" ? "framing" : "reach"}</button>
          ${h.kind === "m"
            ? `<button type="button" class="btn" data-czed="hit" data-kind="d" data-ref="${esc(h.ref)}" aria-label="a document — choose one of “${esc(h.title)}”’s filings to add">📄 a document</button>`
            : `<button type="button" class="btn" data-czed="hit" data-kind="g" data-ref="${esc(h.ref)}" aria-label="what changed in “${esc(h.title)}” — a digest">⟳ what changed</button>`}
        </span></div>`; };
    // a line of the tape, by the same words a search finds — quoted whole
    const lineHit = l => `<div class="cz-edhit">
        <span class="cz-edhit-t"><b>“${esc(cut(l.text, 110))}”</b><span class="cz-edhit-m">${esc(l.title)} · ${hms(l.t)}${l.date ? ` · ${esc(l.date)}` : ""}</span></span>
        <span class="cz-edhit-a"><button type="button" class="btn" data-czed="hit" data-kind="q"
          data-ref="${esc(l.pid)}:${r1(l.t)}" data-text="${esc(cut(l.text, 120))}"
          aria-label="quote — the line at ${hms(l.t)} of ${esc(l.title)}, in your paper">❝ quote</button></span></div>`;
    const nothing = ls => `<p class="cz-hint">nothing among the record’s ${n(idx.meetings.length, "meeting", "meetings")},
           ${n(idx.issues.length, "issue", "issues")}${ls ? " or their lines" : ""} matches “${esc(q.value.trim())}”${esc(dark)}</p>`;
    box.innerHTML = (is.length ? `<span class="cz-edgroup">issues</span>${is.map(hit).join("")}` : "")
      + (ms.length ? `<span class="cz-edgroup">meetings</span>${ms.map(hit).join("")}` : "");
    if (indexPick) { if (!ms.length && !is.length) box.innerHTML = nothing(false); return; }
    if (pick === "quote" && !linesOK) { box.innerHTML = `<p class="cz-hint">type three characters or more of a word said on the tape — its lines appear here, each a quote you can cite</p>`; return; }
    if (!linesOK) { if (!ms.length && !is.length) box.innerHTML = nothing(false); return; }
    if (!ms.length && !is.length) box.innerHTML = `<p class="cz-hint cz-edlines-wait">searching the tape’s own lines…</p>`;
    // a lines search that breaks must not strand the status line on
    // "searching…" — nor be painted as "no match": the lines were not read
    let ls = [], broke = false;
    try { ls = await linesSearch(terms, q.value); } catch { broke = true; }
    const box2 = $(".cz-edhits", slot);
    if (slot._edgen !== gen || !box2) return;   // a newer query painted, or the panel closed
    const wait = $(".cz-edlines-wait", box2); if (wait) wait.remove();
    if (count) count.textContent = broke ? `${countLine([])} — the tape’s lines couldn’t be read` : countLine(ls);
    // appended in place — never a rebuild of the hits already painted, so a
    // reader who has tabbed onto one keeps their place when the lines land
    if (ls.length) box2.insertAdjacentHTML("beforeend", `<span class="cz-edgroup">lines of the tape</span>${ls.map(lineHit).join("")}`);
    else if (!ms.length && !is.length) box2.innerHTML = broke
      ? `<p class="cz-hint">the tape’s lines couldn’t be read here — the index didn’t answer</p>` : nothing(true);
  }

  /* ================= SEARCH ================= */

  /* ================= A WORD, OVER TIME — the search, told as a story (specs/25) ==
     The JS twin of web/topic.py: the same counts over the same lines, drawn
     with the same classes, live for any word a reader types. The pure half
     first — tpAggregate answers exactly what the press's aggregate() answers
     on the same (meetings, hits), and the node twin test holds it so — the
     DOM after. Nothing here leaves the browser: the index is the record's
     own static planes, the reel is a link, the tray is localStorage. */
  const TP_WINDOW = 12, TP_CAP = 90, TP_BINS = 48, TP_FULL_CAP = 120;   // the press's FULL_CAP
  const TP_FLOOR_LINES = 3, TP_FLOOR_MEETINGS = 2;
  /* at most `cap` of the items, spread evenly from the first to the last —
     a capped cut of a word over time still reaches its latest night (the
     press's spread; integer steps, so the twins pick the same clips) */
  const tpSpread = (items, cap) => {
    const n = items.length;
    if (n <= cap) return items.slice();
    if (cap <= 1) return items.slice(0, cap);
    return Array.from({ length: cap }, (_, i) => items[Math.floor(i * (n - 1) / (cap - 1))]);
  };
  /* the spread over the DATED items (so "the latest" is the latest night a
     date names, never an undated one sorted last), then the undated in the
     room left — the press's cap_spread */
  const tpCapSpread = (items, dated, cap) => {
    const d = items.filter((_, i) => dated[i]), u = items.filter((_, i) => !dated[i]);
    const out = tpSpread(d, cap);
    return out.concat(u.slice(0, Math.max(0, cap - out.length)));
  };
  /* whole-word, case-blind — the press's phrase_re; no lookbehind, so an
     older browser still parses it (the prefix group is consumed, and the
     phrase's own start is index + prefix length) */
  const phraseRe = p => new RegExp("(^|[^a-z0-9])" + String(p).toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9])", "g");
  /* a caption line is short and a phrase can break across two — the line is
     read with the next joined on, and only a match that STARTS inside the
     line counts for it (the press's mentions_in) */
  function mentionsIn(text, after, pats) {
    const t = String(text || "").toLowerCase();
    const joined = t + " " + String(after || "").toLowerCase();
    let n = 0;
    for (const p of pats) {
      p.lastIndex = 0; let m;
      while ((m = p.exec(joined))) {
        if (m.index + m[1].length <= t.length) n++;
        if (m[0].length === 0) p.lastIndex++;
      }
    }
    return n;
  }
  const TP_MONTH = /^\d{4}-(0[1-9]|1[0-2])/, TP_DAY = /^\d{4}-\d{2}-\d{2}/;
  const tpIsMonth = d => TP_MONTH.test(String(d || ""));
  const tpMonthRange = months => {
    const ms = months.filter(tpIsMonth).map(m => String(m).slice(0, 7)).sort();
    if (!ms.length) return [];
    let y = +ms[0].slice(0, 4), mo = +ms[0].slice(5, 7);
    const y1 = +ms[ms.length - 1].slice(0, 4), mo1 = +ms[ms.length - 1].slice(5, 7);
    const out = [];
    while (y < y1 || (y === y1 && mo <= mo1)) {
      out.push(`${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`);
      if (++mo > 12) { y++; mo = 1; }
    }
    return out;
  };
  const tpCutWords = (s, n) => {
    s = String(s || "").split(/\s+/).join(" ").trim();
    if (s.length <= n) return s;
    let head = s.slice(0, n);
    if (head.includes(" ")) head = head.slice(0, head.lastIndexOf(" "));
    return head.replace(/[,;:—-]+$/, "") + "…";
  };
  const tpContext = (h, n) => tpCutWords([h.before, h.text, h.after].filter(Boolean)
    .map(x => String(x).split(/\s+/).join(" ")).join(" "), n || 220);
  /* each hit is a clip of its line and the twelve seconds after it; hits that
     fall inside the clip before them extend it, up to the cap — the press's
     merge_windows, so the pressed supercut and the live one are one cut */
  function tpMerge(hits, duration) {
    const dur = +duration || 0, out = [];
    for (const h of hits.slice().sort((a, b) => a.t - b.t)) {
      const t = +h.t; let end = t + TP_WINDOW;
      if (dur) end = Math.min(end, dur);
      const last = out[out.length - 1];
      if (last && t <= last.end && (end - last.start) <= TP_CAP) { last.end = Math.max(last.end, end); last.n++; continue; }
      if (end <= t) continue;
      out.push({ pid: h.pid, start: t, end, n: 1 });
    }
    return out;
  }
  const TP_STOP = new Set(("a about above after again against all am an and any are as at be because been before being below between both but by could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves would can may might must shall going go get got know think say said says see right okay ok yeah yes um uh like well really just actually also one two three want make made need look looking thing things time way lot bit dont don didnt cant wont let lets us thank thanks gonna kind sort mr mrs ms dr item items next new motion second meeting board committee town public comment agenda minutes vote member members chair year percent question questions").split(" "));
  const TP_ART = new Set(["applause", "clears throat", "council president", "councilor", "crosstalk", "everybody", "everyone", "foreign", "good afternoon", "good evening", "good morning", "good night", "hello", "inaudible", "laughter", "madam chair", "madam clerk", "madam mayor", "madam president", "mhm", "mister president", "mr chair", "mr clerk", "mr mayor", "mr president", "music", "next slide", "okay", "point of order", "roll call", "silence", "thank you", "thanks", "uh", "um", "welcome", "yeah"]);
  const tpStopish = w => {
    if (TP_STOP.has(w) || w.length < 3) return true;
    if (w.includes("'")) { const b = w.split("'")[0]; return TP_STOP.has(b) || b.length < 4; }
    return false;
  };
  function tpCowords(hits, phrases, top) {
    const skip = new Set();
    for (const p of phrases) for (const w of (String(p).toLowerCase().match(/[a-z][a-z'’-]+/g) || [])) skip.add(w);
    const counts = Object.create(null);
    for (const h of hits) {
      const text = [h.before || "", h.text || "", h.after || ""].join(" ").toLowerCase();
      for (let w of (text.match(/[a-z][a-z'’-]+/g) || [])) {
        w = w.replace(/^['’-]+|['’-]+$/g, "");
        if (!w || skip.has(w) || tpStopish(w) || TP_ART.has(w)) continue;
        counts[w] = (counts[w] || 0) + 1;
      }
    }
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, top || 12).filter(w => counts[w] > 1).map(w => ({ word: w, count: counts[w] }));
  }
  /* the count — pure over (meetings, hits); the press's aggregate() twin.
     `town` pins the story to one town (the reader's scope); otherwise the
     town with the most lines leads, the rest are counted as elsewhere. */
  function tpAggregate(meetings, hits, topic, town, floor) {
    const phrases = (topic.phrases || []).filter(p => String(p || "").trim());
    // maps without a prototype: a pid or a town named "constructor" is data (a review catch)
    const byPid = Object.create(null); for (const m of meetings) byPid[m.pid] = m;
    const hitsBy = Object.create(null);
    for (const h of hits.slice().sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0) || a.t - b.t))
      if (byPid[h.pid]) (hitsBy[h.pid] ||= []).push(h);
    const pids = Object.keys(hitsBy);
    if (!pids.length) return null;
    const townLines = Object.create(null), townMeets = Object.create(null);
    for (const pid of pids) { const tn = String(byPid[pid].town || "");
      townLines[tn] = (townLines[tn] || 0) + hitsBy[pid].length; townMeets[tn] = (townMeets[tn] || 0) + 1; }
    // a meeting with no town recorded never leads a story — it is counted
    // as elsewhere, and named as what it is
    const named = Object.keys(townLines).filter(t => t);
    if (!town || !(town in townLines)) {
      if (!named.length) return null;
      town = named.sort((a, b) => townLines[b] - townLines[a] || townMeets[b] - townMeets[a] || (a < b ? -1 : a > b ? 1 : 0))[0];
    }
    if (floor !== false && (townLines[town] < TP_FLOOR_LINES || townMeets[town] < TP_FLOOR_MEETINGS)) return null;
    // undated nights sort last: the first word on the record is a dated one
    const dkey = m => tpIsMonth(m.date) ? String(m.date) : "9999-99-99";
    const ms = meetings.filter(m => String(m.town || "") === town)
      .sort((a, b) => (dkey(a) < dkey(b) ? -1 : dkey(a) > dkey(b) ? 1 : 0) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
    const rows = ms.map(m => {
      const hs = hitsBy[m.pid] || [];
      let dur = +m.duration || 0;
      if (hs.length) dur = Math.max(dur, Math.max(...hs.map(h => h.t)) + 1);
      const bins = new Array(TP_BINS).fill(0);
      for (const h of hs) bins[Math.min(TP_BINS - 1, Math.floor(TP_BINS * h.t / dur))] += dur ? 1 : 0;
      return { pid: m.pid, title: String(m.title || m.pid), date: String(m.date || ""), body: String(m.body || ""),
               duration: dur, n: hs.length, mentions: hs.reduce((a, h) => a + (+h.mentions || 0), 0),
               first_t: hs.length ? hs[0].t : null, last_t: hs.length ? hs[hs.length - 1].t : null,
               bins, hits: hs, clips: tpMerge(hs, dur) };
    });
    const said = rows.filter(r => r.n);
    const all = [].concat(...said.map(r => r.hits));
    const dated = rows.filter(r => tpIsMonth(r.date));
    const months = tpMonthRange(dated.map(r => r.date.slice(0, 7))).map(mo => {
      const rs = dated.filter(r => r.date.slice(0, 7) === mo);
      return { month: mo, meetings: rs.length, said: rs.filter(r => r.n).length,
               moments: rs.reduce((a, r) => a + r.n, 0), mentions: rs.reduce((a, r) => a + r.mentions, 0) };
    });
    const bb = Object.create(null);
    for (const r of said) { const k = r.body || "—";
      const b = bb[k] ||= { body: k, moments: 0, meetings: 0, mentions: 0 };
      b.moments += r.n; b.meetings++; b.mentions += r.mentions; }
    const bodies = Object.values(bb).sort((a, b) => b.moments - a.moments || (a.body < b.body ? -1 : 1));
    // "the latest" is a chronological claim: the last dated night that said
    // it, when any night is dated (undated nights sort last, and cannot be it)
    const datedSaid = said.filter(r => tpIsMonth(r.date));
    const first = said[0], latest = datedSaid.length ? datedSaid[datedSaid.length - 1] : said[said.length - 1];
    const peak = said.reduce((p, r) => (r.n > p.n || (r.n === p.n && r.date > p.date)) ? r : p, said[0]);
    let gap = 0;
    for (const r of rows.slice(rows.indexOf(first) + 1)) { if (r.n) break; gap++; }
    const elsewhere = Object.keys(townLines).filter(t => t !== town)
      .map(t => ({ town: t, moments: townLines[t], meetings: townMeets[t] }))
      .sort((a, b) => b.moments - a.moments || (a.town < b.town ? -1 : 1));
    const chapters = said.map(r => ({ pid: r.pid, date: r.date, body: r.body, title: r.title, n: r.n,
      t: r.hits[0].t, quote: tpContext(r.hits[0]),
      clip: { pid: r.pid, start: r.hits[0].t, end: r.clips.length ? r.clips[0].end : r.hits[0].t + TP_WINDOW } }));
    const every = [].concat(...said.map(r => r.clips));
    const full = tpCapSpread(every, [].concat(...said.map(r => r.clips.map(() => tpIsMonth(r.date)))), TP_FULL_CAP);
    const short = tpCapSpread(chapters.map(c => c.clip), chapters.map(c => tpIsMonth(c.date)), REEL_LINK_CAP);
    const rt = cs => cs.reduce((a, c) => a + Math.max(0, c.end - c.start), 0);
    return { slug: topic.slug || "", name: topic.name || topic.slug || "", q: topic.q || topic.name || "",
      phrases, town, moments: all.length, mentions: all.reduce((a, h) => a + (+h.mentions || 0), 0),
      n_meetings: said.length, n_town_meetings: rows.length, meetings: rows, months,
      undated: said.filter(r => !tpIsMonth(r.date)).length, bodies,
      first: { pid: first.pid, date: first.date, body: first.body, t: first.hits[0].t, quote: tpContext(first.hits[0]) },
      latest: { pid: latest.pid, date: latest.date, body: latest.body, t: latest.hits[latest.hits.length - 1].t, quote: tpContext(latest.hits[latest.hits.length - 1]) },
      peak: { pid: peak.pid, date: peak.date, body: peak.body, n: peak.n, mentions: peak.mentions, t: peak.first_t,
              span: Math.max(0, peak.last_t - peak.first_t) },
      gap, elsewhere, cowords: tpCowords(all, phrases), chapters,
      reel: { short: reelShareURL(short), short_n: short.length, short_runtime: rt(short),
              full: reelShareURL(full), full_n: full.length, full_all: every.length, full_runtime: rt(full) } };
  }

  /* ---- the pictures, the press's twins (web/charts.py) ---- */
  const TP_MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const tpMonthName = mo => tpIsMonth(mo) ? `${TP_MON[+mo.slice(5, 7)]} ${mo.slice(0, 4)}` : "undated";
  const tpN = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
  const tpTwin = (rows, head) => `<details class="graphtwin"><summary>the same, as a table</summary>
    <div class="fp-twinwrap"><table class="twin"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
  function tpMonthBars(months, rows) {
    if (!months.length) return '<p class="hint">no dated meeting says it yet</p>';
    const mx = Math.max(1, ...months.map(x => +x.mentions || 0));
    const firstOf = Object.create(null);
    for (const r of rows) if (r.n && tpIsMonth(r.date)) firstOf[r.date.slice(0, 7)] ||= r;
    let prev = null; const cols = [], trows = [];
    for (const x of months) {
      const n = +x.mentions || 0, h = n ? 6 + Math.round(58 * n / mx) : 2;
      const tip = x.meetings ? `${tpMonthName(x.month)}: ${tpN(n, "mention")} in ${x.said} of ${tpN(x.meetings, "meeting")}`
                             : `${tpMonthName(x.month)}: no meeting on the record`;
      const dots = '<i class="tp-dot on"></i>'.repeat(x.said) + '<i class="tp-dot"></i>'.repeat(x.meetings - x.said);
      const yr = x.month.slice(0, 4);
      const label = `<label>${esc(TP_MON[+x.month.slice(5, 7)] || x.month)}${yr !== prev ? `<small>${esc(yr)}</small>` : ""}</label>`;
      prev = yr;
      const inner = `<b>${n || ""}</b><span class="tp-bar" style="height:${h}px"></span><span class="tp-dots">${dots}</span>${label}`;
      const r0 = firstOf[x.month];
      cols.push(n && r0
        ? `<a class="tp-mcol" href="${BASE}/m/${encodeURIComponent(r0.pid)}#t${Math.floor(r0.first_t || 0)}" title="${esc(tip)}" aria-label="${esc(tip)}">${inner}</a>`
        : `<span class="tp-mcol${x.meetings ? "" : " tp-nomeet"}" title="${esc(tip)}" aria-label="${esc(tip)}">${inner}</span>`);
      trows.push(`<tr><td>${esc(tpMonthName(x.month))}</td><td>${x.meetings}</td><td>${x.said}</td><td>${n}</td></tr>`);
    }
    return `<div class="tp-months" role="group" aria-label="mentions month by month">${cols.join("")}</div>`
      + tpTwin(trows.join(""), "<th>month</th><th>meetings</th><th>said it</th><th>mentions</th>");
  }
  function tpTapes(rows) {
    const said = rows.filter(r => r.n); if (!said.length) return "";
    const out = [], trows = [];
    for (const r of said) {
      const dur = Math.max(+r.duration || 0, 1), counts = r.bins, mx = Math.max(1, ...counts);
      const bars = counts.map((c, i) => `<a class="fp-sbar" href="${BASE}/m/${encodeURIComponent(r.pid)}#t${Math.floor(dur * i / counts.length)}"
        title="${hms(dur * i / counts.length)}–${hms(dur * (i + 1) / counts.length)}: ${tpN(c, "line")}"><i style="height:${c ? 2 + Math.round(20 * c / mx) : 1}px"></i></a>`).join("");
      out.push(`<div class="fp-spark"><a class="fp-sterm" href="${BASE}/m/${encodeURIComponent(r.pid)}" title="${esc(r.title)}">${TP_DAY.test(r.date) ? esc(r.date.slice(5, 10)) : "undated"} · ${esc(r.body)}</a>
        <span class="fp-sbars">${bars}</span><span class="fp-sn">${tpN(r.n, "line")}</span></div>`);
      trows.push(`<tr><td><a href="${BASE}/m/${encodeURIComponent(r.pid)}#t${Math.floor(r.first_t || 0)}">${esc(r.date || "undated")}</a></td><td>${esc(r.body)}</td><td>${r.n}</td><td>${hms(r.first_t || 0)}</td><td>${hms(r.last_t || 0)}</td></tr>`);
    }
    return `<div class="fp-sparks tp-tapes">${out.join("")}</div>`
      + tpTwin(trows.join(""), "<th>meeting</th><th>body</th><th>lines</th><th>first at</th><th>last at</th>");
  }
  function tpCowordBars(words, q, town) {
    if (!words.length) return "";
    const mx = Math.max(1, ...words.map(w => +w.count || 0));
    return `<div class="lenses fp-topics tp-cowords">` + words.map(w => {
      const both = `${q} ${w.word}`;
      const href = `${BASE}/s?q=${encodeURIComponent(both)}` + (town ? `&town=${encodeURIComponent(town)}` : "");
      return `<div class="lensrow"><a class="lenslabel fp-topic" href="${href}" title="search the record for “${esc(both)}”">${esc(w.word)}</a>
        <span class="lensbar"><i style="width:${Math.round(100 * w.count / mx)}%"></i></span><span class="lensn">${w.count}</span><span class="lensdrift"></span></div>`;
    }).join("") + `</div>`;
  }
  /* ---- the pictures as files (specs/27 §3.3) — the twins of web/pictures.py
     months_svg / tapes_svg / words_svg, byte for byte (a node twin holds
     them equal): the search page's live story downloads its pictures the
     way the pressed story does, a white page with its title and source */
  const TP_PIC = { GREEN: "#052e16", INK: "#0f172a", SLATE: "#475569", HAIR: "#e2e8f0",
    FONT: "IBM Plex Mono, Menlo, Consolas, monospace" };
  const TP_NUM = /^[ \t\n\r]*[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?[ \t\n\r]*$/;
  const tpPicN = v => {
    if (typeof v === "string") { if (!TP_NUM.test(v)) return 0; } else if (typeof v !== "number") return 0;
    const f = +v; return Number.isFinite(f) ? Math.trunc(Math.min(Math.max(f, 0), 1e9)) : 0; };
  const tpPicS = v => typeof v === "string" ? v : "";
  const tpPicCut = (s, n) => { const cp = Array.from(s); return cp.length <= n ? s : cp.slice(0, n - 1).join("") + "…"; };
  const tpPicTrim = s => s.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  // what XML forbids, gone before the escape (the press's pictures.x): C0
  // controls but tab/newline/return, the two noncharacters, a lone surrogate
  const tpPicClean = s => String(s == null ? "" : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "").replace(/[\ud800-\udfff]/gu, "");
  const tpPicX = s => esc(tpPicClean(s));
  const TP_LEGEND = {
    months: "a bar is the month's mentions · a filled dot, a meeting that said it; a hollow one, a meeting that did not; past twenty, said/met",
    tapes: "a row is one night's tape, start to end · a taller bar, more lines said it there",
    words: "counted in each line that says it and the lines either side, civic stopwords out" };
  const tpPicFit = (w, title, source, legend) => {
    const src = String(source), i = src.indexOf(" · ");
    const where = i < 0 ? src : src.slice(0, i), how = i < 0 ? "" : src.slice(i + 3);
    const cp = t => Array.from(tpPicClean(t)).length;
    return Math.max(w, 32 + cp(title) * 8, ...[where, how, legend].map(t => 32 + Math.floor(cp(t) * 61 / 10))); };
  const tpPicPage = (w, h, title, source, inner, legend) => {
    const src = String(source), i = src.indexOf(" · ");
    const where = i < 0 ? src : src.slice(0, i), how = i < 0 ? "" : src.slice(i + 3);
    h += 14 + (legend ? 14 : 0);
    const keyLine = legend ? `<text x="16" y="${h - 40}" font-size="10" fill="${TP_PIC.SLATE}">${tpPicX(legend)}</text>` : "";
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${TP_PIC.FONT}"><title>${tpPicX(title)}</title>`
      + `<rect width="${w}" height="${h}" fill="#ffffff"/>`
      + `<text x="16" y="26" font-size="13" font-weight="700" fill="${TP_PIC.INK}">${tpPicX(title)}</text>`
      + inner + keyLine + `<text x="16" y="${h - 26}" font-size="10" fill="${TP_PIC.SLATE}">${tpPicX(where)}</text>`
      + `<text x="16" y="${h - 12}" font-size="10" fill="${TP_PIC.SLATE}">${tpPicX(how)}</text></svg>\n`; };
  const tpObj = v => v && typeof v === "object" && !Array.isArray(v);
  function tpMonthsSvg(months, title, source, legend = TP_LEGEND.months) {
    const { GREEN, INK, SLATE, HAIR } = TP_PIC;
    const ms = (Array.isArray(months) ? months : []).filter(m => tpObj(m) && /^[0-9]{4}-(0[1-9]|1[0-2])/.test(tpPicS(m.month)));
    const colw = 40, barMax = 72, n = ms.length;
    const mx = Math.max(1, ...ms.map(m => tpPicN(m.mentions)));
    const most = Math.min(20, Math.max(0, ...ms.map(m => tpPicN(m.meetings))));
    const dotRows = Math.max(1, Math.floor((most + 4) / 5));
    const baseY = 58 + barMax, labelY = baseY + 10 + dotRows * 7 + 10;
    const W = tpPicFit(Math.max(32 + n * colw, 600), title, source, legend), H = labelY + 14 + 12 + 36, x0 = Math.floor((W - n * colw) / 2);
    const parts = [`<line x1="${x0}" y1="${baseY}" x2="${x0 + n * colw}" y2="${baseY}" stroke="${HAIR}"/>`];
    let prevYear = "";
    ms.forEach((m, i) => {
      const mo = String(m.month), c = tpPicN(m.mentions);
      const meets = tpPicN(m.meetings), said = Math.min(meets, tpPicN(m.said));
      const cx = x0 + i * colw + Math.floor(colw / 2);
      if (c) {
        const h = 4 + Math.floor((barMax - 4) * c / mx);
        parts.push(`<rect x="${cx - 12}" y="${baseY - h}" width="24" height="${h}" fill="${GREEN}"/>`);
        parts.push(`<text x="${cx}" y="${baseY - h - 5}" text-anchor="middle" font-size="11" font-weight="700" fill="${INK}">${c}</text>`);
      } else parts.push(`<rect x="${cx - 12}" y="${baseY - 2}" width="24" height="2" fill="${HAIR}"/>`);
      if (meets > 20) parts.push(`<text x="${cx}" y="${baseY + 13}" text-anchor="middle" font-size="9" fill="${GREEN}">${said}/${meets}</text>`);
      else for (let k = 0; k < meets; k++) {
        const row = Math.floor(k / 5), col = k % 5, inRow = Math.min(5, meets - row * 5);
        const dx = cx + col * 7 - Math.floor((inRow - 1) * 7 / 2), dy = baseY + 10 + row * 7;
        parts.push(k < said ? `<circle cx="${dx}" cy="${dy}" r="2.5" fill="${GREEN}"/>`
                            : `<circle cx="${dx}" cy="${dy}" r="2.5" fill="#ffffff" stroke="${GREEN}"/>`);
      }
      parts.push(`<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="10" fill="${meets ? SLATE : HAIR}">${TP_MON[+mo.slice(5, 7)]}</text>`);
      if (mo.slice(0, 4) !== prevYear) {
        parts.push(`<text x="${cx}" y="${labelY + 12}" text-anchor="middle" font-size="9" fill="${SLATE}">${mo.slice(0, 4)}</text>`);
        prevYear = mo.slice(0, 4);
      }
    });
    return tpPicPage(W, H, title, source, parts.join(""), legend);
  }
  function tpTapesSvg(rows, title, source, legend = TP_LEGEND.tapes) {
    const { GREEN, INK, SLATE, HAIR } = TP_PIC;
    const said = (Array.isArray(rows) ? rows : []).filter(r => tpObj(r) && tpPicN(r.n));
    const rowH = 24, bw = 6, W = tpPicFit(640, title, source, legend), H = 52 + said.length * rowH + 36, parts = [];
    said.forEach((r, i) => {
      const y = 52 + i * rowH;
      const counts = Array.isArray(r.bins) ? r.bins.map(tpPicN).slice(0, 64) : [];
      const mx = Math.max(1, ...counts), date = tpPicS(r.date);
      const when = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(date) ? date.slice(5, 10) : "undated";
      const label = tpPicCut(`${when} · ${tpPicS(r.body)}`, 26);
      parts.push(`<text x="16" y="${y + 16}" font-size="11" fill="${INK}">${tpPicX(label)}</text>`);
      parts.push(`<line x1="200" y1="${y + 18}" x2="${200 + counts.length * bw}" y2="${y + 18}" stroke="${HAIR}"/>`);
      counts.forEach((c, j) => { if (c) { const h = 2 + Math.floor(14 * c / mx);
        parts.push(`<rect x="${200 + j * bw}" y="${y + 18 - h}" width="${bw - 1}" height="${h}" fill="${GREEN}"/>`); } });
      parts.push(`<text x="${210 + counts.length * bw}" y="${y + 16}" font-size="11" fill="${SLATE}">${tpN(tpPicN(r.n), "line")}</text>`);
    });
    return tpPicPage(W, H, title, source, parts.join(""), legend);
  }
  function tpWordsSvg(words, title, source, legend = TP_LEGEND.words) {
    const { GREEN, INK } = TP_PIC;
    const ws = (Array.isArray(words) ? words : []).filter(w => tpObj(w) && tpPicTrim(tpPicS(w.word)));
    const rowH = 20, W = tpPicFit(600, title, source, legend), H = 52 + ws.length * rowH + 36, parts = [];
    const mx = Math.max(1, ...ws.map(w => tpPicN(w.count)));
    ws.forEach((w, i) => {
      const y = 52 + i * rowH, c = tpPicN(w.count), bar = 2 + Math.floor(298 * c / mx);
      parts.push(`<text x="16" y="${y + 13}" font-size="11" fill="${INK}">${tpPicX(tpPicCut(tpPicTrim(tpPicS(w.word)), 18))}</text>`);
      parts.push(`<rect x="150" y="${y + 4}" width="${bar}" height="11" fill="${GREEN}"/>`);
      parts.push(`<text x="${150 + bar + 8}" y="${y + 13}" font-size="11" font-weight="700" fill="${INK}">${c}</text>`);
    });
    return tpPicPage(W, H, title, source, parts.join(""), legend);
  }
  /* the file itself: a Blob, a click, the address let go a moment later
     (revoked at once, some browsers drop the download) — nothing leaves */
  function tpPicSave(svg, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 40000);   // an iPhone asks before it saves
    toast(`${name} downloaded — the picture, its title and its source`);
  }
  const tpPicSlug = s => String(s || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "picture";
  const tpDay = d => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(d || ""));
    if (!m) return "an undated meeting";
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));   // a real calendar day, or undated
    if (dt.getUTCFullYear() !== +m[1] || dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) return "an undated meeting";
    return `${["","January","February","March","April","May","June","July","August","September","October","November","December"][+m[2]]} ${+m[3]}, ${m[1]}`; };
  const tpTown = t => t ? `${esc(t)}’s bodies` : "meetings with no town recorded";
  const tpSpan = sec => sec < 90 ? "in under two minutes" : sec < 3600 ? `in ${Math.max(2, Math.round(sec / 60))} minutes`
    : `over ${Math.floor(sec / 3600)} h` + (Math.floor((sec % 3600) / 60) ? ` ${Math.floor((sec % 3600) / 60)} min` : "");
  const tpList = xs => { xs = xs.filter(Boolean); return xs.length < 2 ? (xs[0] || "") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]; };
  /* the lede, counted — the press's story.topic() sentences */
  function tpLede(d, searchHref) {
    const at = (pid, t) => `${BASE}/m/${encodeURIComponent(pid)}#t${Math.floor(t || 0)}`;
    const q = esc(d.q), f = d.first, l = d.latest, p = d.peak, out = [];
    out.push(`The first time anyone said “${q}” on ${esc(d.town)}’s record was <a href="${at(f.pid, f.t)}">${esc(tpDay(f.date))}</a>, ${hms(f.t)} into a ${esc(f.body || "meeting")} meeting: “${esc(f.quote)}”.`);
    if (d.gap === 1) out.push("The next meeting passed without it."); else if (d.gap > 1) out.push(`${d.gap} meetings then passed without it.`);
    const share = Math.round(100 * p.mentions / Math.max(1, d.mentions));
    out.push(p.pid !== f.pid
      ? `It peaked on <a href="${at(p.pid, p.t)}">${esc(tpDay(p.date))}</a>, when the ${esc(p.body || "board")} said it ${tpN(p.mentions, "time")} ${tpSpan(p.span)} — ${share}% of every mention on the record.`
      : `That night is still the peak: ${tpN(p.mentions, "mention")} ${tpSpan(p.span)}, ${share}% of every one on the record.`);
    const bodies = tpList(d.bodies.filter(b => b.body && b.body !== "—").map(b => `the ${b.body}`));
    const cw = d.cowords.slice(0, 4).map(w => w.word);
    out.push(`In all, <a href="${searchHref}">${tpN(d.mentions, "mention")}</a> across ${d.n_meetings} of ${esc(d.town)}’s ${tpN(d.n_town_meetings, "meeting")}`
      + (bodies ? `, by ${esc(bodies)}` : "") + (cw.length ? `; the words said beside it most: ${esc(cw.join(", "))}` : "") + ".");
    if (l.pid !== f.pid || l.t !== f.t) out.push(`The latest was <a href="${at(l.pid, l.t)}">${esc(tpDay(l.date))}</a>: “${esc(l.quote)}”.`);
    for (const e of d.elsewhere.slice(0, 2))
      out.push(`${tpTown(e.town)} said it in ${tpN(e.moments, "line")} across ${tpN(e.meetings, "meeting")} — <a href="${BASE}/s?q=${encodeURIComponent(d.q)}">the whole record’s search</a> reads them together.`);
    return out.join(" ");
  }

  /* ---- the search page: the index once, the progress line, the story ---- */
  let SQ_INDEX = null;
  function sqIndex() {
    return SQ_INDEX ||= Promise.all([
      getJSON(`${BASE}/search/meta.json`), getJSON(`${BASE}/search/segs.json`), getJSON(`${BASE}/search/shards.json`)])
      .then(([meta, segs, shards]) => {
        if (!Array.isArray(meta) || !Array.isArray(segs)) { SQ_INDEX = null; return null; }
        return { meta, segs, shards: shards || {} };
      });
  }
  /* the progress line: real stages at real await boundaries — never a timer
     pretending to be work. Three stages, then it goes. */
  const SQ_STAGES = 3;
  function sqProgress(stage, text) {
    const box = $("#sq-prog"); if (!box) return;
    const bar = $(".sq-progbar i", box), txt = $(".sq-progtext", box);
    if (stage == null) { box.hidden = true; return; }
    box.hidden = false;
    if (bar) bar.style.width = `${Math.round(100 * Math.min(stage, SQ_STAGES) / SQ_STAGES)}%`;
    if (txt) txt.textContent = text || "";
    if (stage >= SQ_STAGES) setTimeout(() => { if (box.dataset.stage === String(stage)) box.hidden = true; }, 900);
    box.dataset.stage = String(stage);
  }
  const SQ_RANGES = [["1", "the last month", 1], ["6", "six months", 6], ["12", "a year", 12], ["all", "the whole record", 0]];
  let SQ_RANGE = "all";
  /* the stretch: the same day N months before the record's latest day
     (the day clamped to 28, so every month has it) — "the last month" is a
     month, not "since the first of last month" (a review catch) */
  const sqSince = (latest, months) => {
    const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(latest || "")); if (!m || !months) return "";
    let y = +m[1], mo = +m[2] - months; const d = Math.min(28, +m[3]);
    while (mo < 1) { mo += 12; y--; }
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  /* the hits the story counts: every line of the index that says the words,
     in the reader's scope, with its neighbours for context */
  function sqHits(idx, ids, phrases) {
    const { meta, segs } = idx, pats = phrases.map(phraseRe);
    const out = [];
    for (const id of ids) {
      const s = segs[id]; if (!s) continue;
      const m = meta[s[0]] || {};
      if (!inScope(m.town || "", m.body || "")) continue;
      // a front page's scope (specs/29): its own meetings, and no other —
      // read off SCOPE itself, so the twins that lift this function alone run
      if (SCOPE.pids && SCOPE.pids.length && !SCOPE.pids.includes(String(m.pid || ""))) continue;
      const nx = segs[id + 1], pv = segs[id - 1];
      const after = nx && nx[0] === s[0] ? String(nx[3]) : "", before = pv && pv[0] === s[0] ? String(pv[3]) : "";
      const n = mentionsIn(s[3], after, pats);
      out.push({ pid: m.pid || "", t: +s[1] || 0, text: String(s[3] || ""), before, after, mentions: n || 1 });
    }
    return out;
  }
  async function sqStory(q, ids, idx, feat) {
    const box = $("#sq-story"); if (!box) return;
    if (!ids.length) { box.innerHTML = ""; return; }
    const phrases = feat ? feat.phrases : [q.trim()];
    // what the count read, said the way the pressed story says it
    const saidAs = phrases.map(p => `“${esc(p)}”`).join(" or ");
    // the meetings the story counts are the ones in the reader's scope —
    // a body scope must not count the other bodies' nights as silence
    const meetings = idx.meta.filter(m => m && m.pid && inScope(m.town || "", m.body || "") && inPids(m.pid)).map(m => ({ pid: m.pid, title: m.title || m.pid, date: m.date || "",
      body: m.body || "", town: m.town || "", duration: +m.duration || 0 }));
    const hitsAll = sqHits(idx, ids, phrases);
    const latestDay = meetings.map(m => m.date).filter(d => TP_DAY.test(d)).sort().pop() || "";
    // the story's town, fixed once: the reader's scope, else the town the
    // whole record's count leads with — a narrower stretch keeps the town
    const whole = tpAggregate(meetings, hitsAll, { slug: "", name: q, q, phrases }, SCOPE.town || "", false);
    const townFixed = SCOPE.town || (whole && whole.town) || "";
    const draw = () => {
      const months = (SQ_RANGES.find(r => r[0] === SQ_RANGE) || SQ_RANGES[3])[2];
      const since = sqSince(latestDay, months);
      const ms = since ? meetings.filter(m => TP_DAY.test(m.date) && m.date >= since) : meetings;
      const keep = new Set(ms.map(m => m.pid));
      const hits = since ? hitsAll.filter(h => keep.has(h.pid)) : hitsAll;
      const d = tpAggregate(ms, hits, { slug: "", name: q, q, phrases }, townFixed, false);
      const range = `<div class="sq-range" role="radiogroup" aria-label="how far back to count">
        <span class="kicker">count</span>${SQ_RANGES.map(r => `<button type="button" class="sq-rb" role="radio" data-range="${r[0]}"
          aria-checked="${SQ_RANGE === r[0] ? "true" : "false"}" tabindex="${SQ_RANGE === r[0] ? 0 : -1}">${r[1]}</button>`).join("")}</div>`;
      const rangeNote = (SQ_RANGE !== "all" && !since)
        ? `<p class="hint">no dated meeting to count from — the whole record is counted</p>` : "";
      if (!d || (townFixed && d.town !== townFixed)) {
        // nothing in the story's town for this stretch — say so, and say who
        // did say it: another town, or meetings with no town recorded
        const scopeName = townFixed || [SCOPE.town, SCOPE.body].filter(Boolean).join(" · ") || "a town the record names";
        const others = d ? [d, ...d.elsewhere].map(e => `${e.moments} in ${esc(e.town || "meetings with no town recorded")}`).join(", ") : "";
        const why = (!whole && hitsAll.length && !since)
          ? `the ${tpN(hitsAll.length, "line")} below are from meetings with no town recorded — the story needs a town to count by`
          : `nothing says ${saidAs} in ${esc(scopeName)}${since ? ` since ${esc(tpDay(since))}` : ""}${others ? ` — elsewhere on the record: ${others}` : ""}`;
        box.innerHTML = `<section class="sq-story tp-story"><span class="kicker">a word, over time — this search, told as a story</span>
          <h2 class="fp-hl" id="sq-hl">How ${esc(townFixed || "the record")} talks about ${esc(q)}</h2>${range}${rangeNote}
          <p class="hint">${why}.</p></section>`;
        wireRange(); return;
      }
      const searchHref = location.pathname + location.search;
      // each picture downloads as the pressed story's do (specs/27 §3.3) — drawn on the press, not before
      const picBtn = kind => `<p class="pic-dl"><button type="button" class="pic-dlb" data-pic="${kind}" aria-label="this picture, as .svg — ${esc({ months: "mentions, month by month", tapes: "where it fell", words: "the words beside it" }[kind])}">↓ this picture, as .svg</button></p>`;
      const cells = [[d.mentions, "mentions", searchHref], [`${d.n_meetings} of ${d.n_town_meetings}`, "meetings", `${BASE}/s`],
        [d.bodies.length, "bodies", `${BASE}/analytics`],
        [tpMonthName(d.first.date).replace(" ", " "), "first said", `${BASE}/m/${encodeURIComponent(d.first.pid)}#t${Math.floor(d.first.t)}`],
        [tpMonthName(d.latest.date).replace(" ", " "), "latest", `${BASE}/m/${encodeURIComponent(d.latest.pid)}#t${Math.floor(d.latest.t)}`],
        [hms(d.reel.short_runtime), "the supercut", d.reel.short]];   // one clip a night, as the pressed story's is
      const busiest = d.months.reduce((p, x) => (!p || (+x.mentions > +p.mentions)) ? x : p, null);
      const silent = d.months.filter(x => x.meetings && !x.said).length;
      const p = d.peak;
      box.innerHTML = `<section class="sq-story tp-story" aria-labelledby="sq-hl">
        <span class="kicker">a word, over time — this search, told as a story</span>
        <h2 class="fp-hl" id="sq-hl">How ${esc(d.town)} talks about ${esc(q)}</h2>
        ${range}${rangeNote}
        <p class="fp-lede">${tpLede(d, searchHref)}</p>
        <p class="sq-jump"><a href="#results">the lines themselves ↓</a></p>
        <p class="decksrc">counted in your browser from the record’s own index — every line of every transcript that says ${saidAs}, whole-word${feat ? (feat.kind === "glossary"
          // the glossary's count is its own towns' only: a Boston search for a
          // Brookline word is not the glossary's number, and is not credited to it
          ? (!feat.only.length || feat.only.includes(d.town || "") ? `, the words <a href="${BASE}/glossary/#${encodeURIComponent(feat.slug)}">the glossary</a> counts` : "")
          : `, the words <a href="${BASE}/topic/${encodeURIComponent(feat.slug)}/">the front page’s story</a> counts`) : ""}; no model, nothing sent anywhere; every number opens the tape</p>
        <div class="sq-acts">
          <a class="btn primary tp-play" href="${esc(d.reel.full)}">▶ play ${d.reel.full_all > d.reel.full_n ? `${d.reel.full_n} of ${tpN(d.reel.full_all, "clip")}, first to latest,` : `all ${tpN(d.reel.full_n, "clip")}`} as a reel · ${hms(d.reel.full_runtime)}</a>
          <button type="button" class="btn" data-sq="tray">✂ put ${d.reel.full_all > TP_FULL_CAP ? `${TP_FULL_CAP} of ${tpN(d.reel.full_all, "clip")}` : "every clip"} on my tray</button>
          <button type="button" class="btn" data-sq="share">⧉ copy the link to this search</button>
        </div>
        ${bsSearchExtras(d, q, idx)}
        <section class="fp-part"><div class="sectionhead"><span class="kicker">“${esc(q)}”, by the numbers</span></div>
          <div class="lead-nums">${cells.map(c => `<a class="ln" href="${esc(c[2])}"><b>${esc(c[0])}</b><span>${esc(c[1])}</span></a>`).join("")}</div></section>
        <section class="fp-part"><div class="sectionhead"><span class="kicker">mentions, month by month</span></div>${tpMonthBars(d.months, d.meetings)}${d.months.length ? picBtn("months") : ""}
          ${busiest && busiest.mentions ? `<p class="fp-say">${esc(tpMonthName(busiest.month))} was the loudest month — ${tpN(busiest.mentions, "mention")} in ${busiest.said} of ${tpN(busiest.meetings, "meeting")}${silent ? `; in ${tpN(silent, "month")} the town met and never said it` : ""}. A dot is a meeting: filled where the word came up, hollow where it did not. Every bar opens the tape at the month’s first mention.</p>` : ""}</section>
        <section class="fp-part"><div class="sectionhead"><span class="kicker">where it fell — every night that said it, slice by slice</span></div>${tpTapes(d.meetings)}${picBtn("tapes")}
          <p class="fp-say">Each row is a tape, start to end; a taller bar is a slice where “${esc(q)}” came up more. On ${esc(tpDay(p.date))} the ${esc(p.body || "board")} said it ${tpN(p.mentions, "time")} ${tpSpan(p.span)}. Every bar opens the tape there.</p></section>
        ${d.cowords.length ? `<section class="fp-part"><div class="sectionhead"><span class="kicker">the words beside it — what was said in the same breath</span></div>${tpCowordBars(d.cowords, q, SCOPE.town || "")}${picBtn("words")}
          <p class="fp-say">Counted in each line that says ${saidAs} and the lines either side of it, civic stopwords out. Each word opens the record’s search for the two together.</p></section>` : ""}
        <p class="sq-count">the ${tpN(hitsAll.length, "line")} themselves, newest first${d.elsewhere.length ? ` — ${d.moments} in ${esc(d.town)}, ${d.elsewhere.map(e => `${e.moments} in ${esc(e.town || "meetings with no town recorded")}`).join(", ")}` : ""}${since ? ` (the list is the whole record; the count above is ${esc((SQ_RANGES.find(r => r[0] === SQ_RANGE) || SQ_RANGES[3])[1])})` : ""} — press <b>＋ reel</b> on any to cut it; <b>j</b> / <b>k</b> walk them, <b>c</b> cuts the one under the cursor</p>
      </section>`;
      wireRange();
      const tray = $("[data-sq=tray]", box), share = $("[data-sq=share]", box);
      if (tray) tray.onclick = () => sqTray(d, q, idx);
      // a picture of a stretch says which stretch — in its title, its name
      // and its source (a review catch: "the last month" downloaded as the whole record)
      // — only when a start date was applied: a scope with no dated meeting
      // counted the whole record, and its picture says so
      const stretch = since ? ((SQ_RANGES.find(r => r[0] === SQ_RANGE) || [])[1] || "") : "";
      const told = `How ${d.town} talks about ${q}` + (stretch ? `, ${stretch}` : "");
      const ed = ($(".dateline b") || {}).textContent || "";
      const src = `${location.origin}${location.pathname}${location.search} · counted in the browser from the record’s index${stretch ? `, over ${stretch}` : ""}, no model`
        + (ed ? ` · the record of ${ed}` : "") + " · CC BY-SA 4.0";
      const draws = { months: () => tpMonthsSvg(d.months, `${told} — mentions, month by month`, src),
                      tapes: () => tpTapesSvg(d.meetings, `${told} — where it fell, night by night`, src),
                      words: () => tpWordsSvg(d.cowords, `${told} — the words beside it`, src) };
      const what = { months: "mentions month by month", tapes: "where it fell", words: "the words beside it" };
      $$("[data-pic]", box).forEach(b => b.onclick = () => {
        const k = b.dataset.pic; if (!draws[k]) return;
        tpPicSave(draws[k](), `${tpPicSlug(`${told} ${what[k]}`)}.svg`);
      });
      if (share) share.onclick = () => copyText(location.href, "link copied — this search, its scope and all");
    };
    const wireRange = () => {
      const rbs = $$(".sq-rb", box);
      rbs.forEach(b => {
        b.onclick = () => { SQ_RANGE = b.dataset.range; draw(); const nb = $(`.sq-rb[data-range="${SQ_RANGE}"]`, box); if (nb) nb.focus(); };
        b.onkeydown = e => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const i = rbs.indexOf(b), n = rbs[(i + (e.key === "ArrowRight" ? 1 : rbs.length - 1)) % rbs.length];
          if (n) n.click();
        };
      });
    };
    draw();
  }
  /* every clip of the counted story onto the tray — appended after what is
     there, by identity (takeMerge's rule), never doubled; the meeting's own
     facts from the index (the tape, its length, the date) */
  function sqTray(d, q, idx) {
    const byPid = Object.create(null); for (const m of idx.meta) if (m && m.pid) byPid[m.pid] = m;
    const clips = [], dated = [];
    for (const r of d.meetings) for (const c of r.clips) {
      dated.push(tpIsMonth(r.date));
      const m = byPid[c.pid] || {};
      const h = r.hits.find(h => h.t === c.start) || r.hits[0] || {};
      clips.push({ pid: c.pid, start: r1(c.start), end: r1(c.end), t: r1(c.start), kind: "hit",
        quote: cut(h.text || "", 120), video_id: m.video_id || "", mtitle: m.title || "",
        body: m.body || "", town: m.town || "", date: m.date || "", duration: +m.duration || 0 });
    }
    if (!clips.length) return;
    // a word said six hundred times is not a tray: the full cut's own
    // spread, first to latest, and the toast says how many of how many
    const take = tpCapSpread(clips, dated, TP_FULL_CAP);
    const have = readReel(REEL_KEY);
    const next = takeMerge("append", have, take, true);
    const added = next.length - have.length;
    writeTray(next);
    const of = take.length < clips.length ? ` (${take.length} of ${clips.length}, first to latest)` : "";
    toast(added ? `${tpN(added, "clip")} on your tray${of} — ${next.length} in all; open the studio to re-cut, or ▶ play` : "every one of these was on your tray already");
  }

  let SQ_NOTE0 = null;   // the pressed search note, to restore when a front page's scope is widened
  async function search() {
    SQ_NOTE0 = ($("#search-note") || {}).textContent;
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
      if (SCOPE.pids.length) u.searchParams.set("m", SCOPE.pids.join(","));
      history.replaceState(null, "", u.pathname + u.search);
      runSearch(val);
    });
    // a front page's scope (specs/29): say it under the form, with the way out
    if (SCOPE.pids.length && form && !$("#sq-scoped")) {
      const wide = new URL(location.href); wide.searchParams.delete("m");
      const line = document.createElement("p"); line.className = "hint sq-scoped"; line.id = "sq-scoped";
      line.innerHTML = `searching inside the ${esc(tpN(SCOPE.pids.length, "meeting"))} a front page cites · <a href="${esc(wide.pathname + wide.search)}">search the whole record</a>`;
      form.insertAdjacentElement("afterend", line);
    }
    // instant search: debounced, and never under three characters — a two-letter
    // query is mostly noise over a lot of postings. Enter (the submit above)
    // still works for a reader who prefers it.
    let deb;
    if (inp) inp.addEventListener("input", () => {
      clearTimeout(deb);
      const val = inp.value.trim();
      if (val.length < 3) {
        if (!val) { $("#results").innerHTML = ""; selReset();
          const story = $("#sq-story"), guide = $("#sq-guide");
          if (story) story.innerHTML = ""; if (guide) guide.hidden = false; sqProgress(null); }
        return; }
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
      if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button") return;
      // the keys sheet, open, keeps the page's keys out (a re-review catch:
      // Enter on its close button opened a hit behind the modal)
      if (e.target.closest && e.target.closest(".kb-sheet")) return;
      const res = $$(".sresult"); if (!res.length) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); selMove(res, 1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); selMove(res, -1); }
      else if (e.key === "Enter" && res[SEL]) location.href = res[SEL].href;
      else if (e.key === "c" && res[SEL]) {
        // the selected hit's own tick — the same press a pointer makes
        const b = res[SEL].parentElement && $("[data-czcut]", res[SEL].parentElement);
        if (b) { e.preventDefault(); toggleCut(b); }
      }
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
    const guide = $("#sq-guide"), story = $("#sq-story");
    if (!terms.length) { box.innerHTML = '<p class="hint">type a word or phrase</p>';
      if (story) story.innerHTML = ""; if (guide) guide.hidden = false; sqProgress(null); return; }
    if (guide) guide.hidden = true;
    sqProgress(0, "opening the record’s index…");
    // a front page's scope (m=) is read from the edition's own index, which
    // counts every line exactly — the Studio's first eighty across a town,
    // filtered after, could say "nothing" over lines it never returned. Said
    // as a choice, never as a Studio that failed to answer (a skeptic's catch).
    if (SCOPE.pids.length) {
      saySearchIsStatic("This search reads inside a front page’s own meetings, so it is counted from "
        + "the edition’s index in your browser — every line, exactly. Nothing was sent anywhere.");
      return staticSearch(q, terms, box);
    }
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
    // the featured-word lookup rides beside the API call, never after it, and
    // a static file that hangs never holds the list: past 2.5 s the typed
    // words mark it
    const featSoon = Promise.race([sqFeatured(q).catch(() => null),
      new Promise(res => setTimeout(() => res(null), 2500))]);
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

    const where = scopeWords();
    if (!r.hits.length) {
      box.innerHTML = `<p class="hint">nothing in the record for “${esc(q)}”`
        + (where ? ` in ${esc(where)}` : "") + `.</p>`;
      const story = $("#sq-story"); if (story) story.innerHTML = "";
      sqProgress(3, "nothing to count");
      return true;
    }
    const feat = await featSoon, marks = feat ? feat.phrases : terms;
    box.innerHTML = `<p class="hint">${tpN(r.hits.length, "line")} `
      + (where ? `in ${esc(where)}` : "across the record")
      + ` · <span class="live">live</span></p>`
      + r.hits.map(h => {
        const bits = [h.title, h.body, SCOPE.town ? "" : h.town, h.date];
        // the hit is an anchor, so its tick is a SIBLING in a wrapper —
        // a button inside a link is a keyboard trap (specs/22 §5.1)
        return `<div class="swrap"><a class="sresult" href="${BASE}/m/${encodeURIComponent(h.meeting_id)}#t${Math.floor(h.t || 0)}">
          <span class="ts">${hms(h.t)}</span>${why(h.why)}${mark(h.text || "", marks)}
          <span class="smeta">${esc(bits.filter(Boolean).join(" · "))}${h.speaker ? " · " + esc(h.speaker) : ""}</span></a>${searchTick(h.meeting_id, h.t, h.text, h.title, h.body, h.town, h.date)}</div>`;
      }).join("");
    paintCutTicks();
    // the Studio answered the list; the story of the search is still the
    // words themselves, counted from the record's own index (specs/25)
    sqStoryFor(q, terms);
    return true;
  }
  /* the story for a query the live path answered: the index's own postings
     for the same terms — what the static path would have listed */
  async function sqStoryFor(q, terms) {
    const idx = await sqIndex(); if (!idx) { sqProgress(null); return; }
    sqProgress(1, `reading the lines that say “${q}”…`);
    const feat = await sqFeatured(q);
    const ids = feat ? await sqPhraseIds(idx, feat.phrases) : await sqIds(idx, terms, q);
    sqProgress(2, `${tpN(ids.length, "line")} — counting, month by month…`);
    await sqStory(q, ids, idx, feat);
    sqProgress(3, `${tpN(ids.length, "line")} counted`);
  }
  /* the front page's featured words (topics/index.json, specs/27 §2.3): a
     search for one counts every phrase its pressed story counts — "AI" is
     AI or artificial intelligence — so the story's own "80 mentions" link
     lands on 80. Malformed rows are no featured word, never a throw. */
  async function sqFeatured(q) {
    const k = String(q || "").trim().toLowerCase();
    if (!k) return null;
    // the front page's featured words first, then the glossary's (its counts
    // link here the same way, specs/28 §3.4) — both fetched at once
    const [topics, words] = await Promise.all([getJSON(`${BASE}/topics/index.json`), getJSON(`${BASE}/glossary/index.json`)]);
    const find = (list, kind) => {
      const t = Array.isArray(list) ? list.find(t => t && typeof t.q === "string"
        && t.q.trim().toLowerCase() === k && Array.isArray(t.phrases)) : null;
      if (!t) return null;
      const phrases = t.phrases.filter(p => typeof p === "string" && p.trim()).map(p => p.trim());
      // a glossary word counted only in its own towns ([] = every town)
      const only = Array.isArray(t.only) ? t.only.filter(x => typeof x === "string") : [];
      return phrases.length ? { slug: String(t.slug || ""), phrases, kind, only,
        terms: [...new Set(phrases.flatMap(p => p.toLowerCase().match(/[a-z0-9]+/g) || []))] } : null;
    };
    return find(topics, "topic") || find(words, "glossary");
  }
  /* a featured word's lines: for each phrase, the index's postings for its
     first word, kept where the phrase itself starts in the line (read with
     the next line joined on — mentionsIn, the press's own rule), in the
     index's order — so the count is the pressed story's, line for line */
  async function sqPhraseIds(idx, phrases) {
    const keep = new Set();
    for (const p of phrases) {
      const toks = p.toLowerCase().match(/[a-z0-9]+/g) || [];
      if (!toks.length) continue;
      const pats = [phraseRe(p)];
      for (const id of await sqIds(idx, [toks[0]], toks[0])) {
        const s = idx.segs[id], nx = idx.segs[id + 1];
        const after = nx && nx[0] === s[0] ? String(nx[3]) : "";
        if (mentionsIn(s[3], after, pats)) keep.add(id);
      }
    }
    return [...keep].sort((a, b) => a - b);
  }
  /* the index's postings for the terms, intersected, exact-phrase-first —
     the one rule both the list and the story read by */
  async function sqIds(idx, terms, q) {
    const sets = await Promise.all(terms.map(async t => {
      const c = /^[a-z0-9]$/.test(t[0]) ? t[0] : "_";
      const sh = await getJSON(`${BASE}/search/t-${c}.json`);
      return new Set(Array.isArray(sh && sh[t]) && Object.prototype.hasOwnProperty.call(sh, t) ? sh[t] : []);
    }));
    let ids = [...(sets[0] || [])];
    for (let i = 1; i < sets.length; i++) ids = ids.filter(x => sets[i].has(x));
    const phrase = q.trim().toLowerCase();
    let hits = ids.filter(id => idx.segs[id]);
    if (terms.length > 1) {
      const exact = hits.filter(id => String(idx.segs[id][3]).toLowerCase().includes(phrase));
      if (exact.length) hits = exact;
    }
    return hits;
  }
  /* the topic story's chapters (specs/25) — pressed as plain anchors with
     the facts a tick needs; here each grows the search hit's own tick, so
     the front page's moments cut like any search result. Hydration only:
     the pressed bytes carry no button. */
  function hydrateTopicTicks() {
    for (const w of $$(".tq-wrap")) {
      if ($("[data-czcut]", w)) continue;
      const a = $("a.tq", w); if (!a) continue;
      const d = a.dataset;
      if (!d.pid || !isFinite(+d.t)) continue;
      w.insertAdjacentHTML("beforeend",
        searchTick(d.pid, +d.t, d.quote || "", d.mtitle || "", d.body || "", d.town || "", d.date || ""));
    }
    if ($(".tq-wrap [data-czcut]")) paintCutTicks();
  }
  /* a search hit's tick: everything the tray can label with, stamped at
     render — the end starts at the twelve-second window and trims to the
     record's own bounds in the tray (specs/22 §5.6). */
  function searchTick(pid, t, text, title, body, town, date) {
    return `<button class="stick" type="button" data-czcut="hit"
      data-pid="${esc(pid)}" data-t="${r1(+t || 0)}"
      data-quote="${esc(cut(String(text || ""), 120))}"
      data-mtitle="${esc(title || "")}" data-body="${esc(body || "")}"
      data-town="${esc(town || "")}" data-date="${esc(date || "")}"
      aria-label="reel — add this moment"></button>`;
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
    const [idx, feat] = await Promise.all([sqIndex(), sqFeatured(q)]);
    if (!idx) { box.innerHTML = '<p class="hint">the index didn\'t load</p>'; sqProgress(null); return; }
    const { meta, segs } = idx;
    sqProgress(1, `${(+idx.shards.segments || segs.length).toLocaleString()} lines open — reading the ones that say “${q}”…`);
    // each term's prefix shard, intersected; exact-phrase-first on a
    // multi-word query (hits stays a list of segIds so a peek can reach
    // the ±1 neighbours) — the one rule the story counts by too
    let hits = feat ? await sqPhraseIds(idx, feat.phrases) : await sqIds(idx, terms, q);
    // a featured word's phrases highlight whole ("artificial intelligence"),
    // never a lone "artificial" (artificial turf)
    const marks = feat ? feat.phrases : terms;
    sqProgress(2, `${tpN(hits.length, "line")} — counting, month by month…`);
    const storyIds = hits.slice();
    // scope BEFORE the cut, or the 80-hit ceiling would be spent on meetings
    // the reader has said they are not looking at — and a scoped search would
    // silently return fewer results than it found
    const total = hits.length;
    if (SCOPE.town || SCOPE.body || SCOPE.pids.length)
      hits = hits.filter(id => {
        const m = meta[segs[id][0]] || {};
        return inScope(m.town || "", m.body || "") && inPids(m.pid || "");
      });
    const cut = hits.length;
    // untowned meetings ride along in every scope, so "18 in Brookline" would
    // be claiming a town for moments the record never learned one for — count
    // them out loud instead, over every scoped line like the count beside
    // them (a review catch: over the 80 shown, the header said nothing while
    // the story beneath it said 129)
    const noTown = SCOPE.town
      ? hits.filter(id => !((meta[segs[id][0]] || {}).town)).length : 0;
    hits = hits.slice(0, 80);
    const where = scopeWords();
    if (!hits.length) {
      // an empty scoped result is two different facts, and the reader is owed
      // whichever one is true: nothing anywhere, or nothing *here*
      box.innerHTML = where && total
        ? `<p class="hint">Nothing for “${esc(q)}” in ${esc(where)} — but
             ${tpN(total, "line")} elsewhere on the record.
             <button class="btn" type="button" id="widen">${SCOPE.pids.length ? "search the whole record" : "search every town"}</button></p>`
        : `<p class="hint">nothing in the record for “${esc(q)}”. It holds ${tpN(meta.length, "meeting")}.</p>`;
      const story = $("#sq-story"); if (story) story.innerHTML = "";
      sqProgress(3, "nothing to count");
      const w = $("#widen");
      if (w) w.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.delete("town"); u.searchParams.delete("body"); u.searchParams.delete("m");
        history.replaceState(null, "", u.pathname + u.search);
        const ts = $("#townsel"), bs = $("#bodysel");
        if (ts) ts.value = ""; if (bs) bs.value = "";
        SCOPE = { ...SCOPE, town: "", body: "", pids: [] };
        const sc = $("#sq-scoped"); if (sc) sc.remove();
        if (SQ_NOTE0 != null) saySearchIsStatic(SQ_NOTE0);   // the scoped sentence must not outlive the scope
        runSearch(q);
      };
      return;
    }
    // the count is the scope's own (a review catch: "80 moments in
    // Brookline" was the display's cap, over 441 lines the story had counted)
    box.innerHTML = `<p class="hint">${tpN(cut, "line")} `
      + (where ? `in ${esc(where)}` : "across the record")
      + (cut > hits.length ? ` — the newest ${hits.length} below` : "")
      + (noTown ? ` · ${tpN(noTown, "line")} from meetings with no town recorded` : "")
      + (where && cut < total ? ` · ${total - cut} more elsewhere on the record` : "")
      + `</p>` +
      hits.map(id => {
        const [mi, t, spk, text] = segs[id];
        const m = meta[mi] || {};
        return `<div class="swrap"><a class="sresult" data-sid="${id}" href="${BASE}/m/${m.pid}#t${Math.floor(t)}">
          <span class="ts">${hms(t)}</span>${mark(text, marks, segs[id + 1] && segs[id + 1][0] === mi ? segs[id + 1][3] : "")}
          <span class="smeta">${esc([m.title, m.body, SCOPE.town ? "" : m.town, m.date].filter(Boolean).join(" · "))}${spk ? " · " + esc(spk) : ""}</span>${peek(segs, id, mi)}</a>${searchTick(m.pid, t, text, m.title, m.body, m.town, m.date)}</div>`;
      }).join("");
    paintCutTicks();
    selReset();
    // the story of the search, over every line it found (not the eighty shown)
    await sqStory(q, storyIds, idx, feat);
    sqProgress(3, `${tpN(storyIds.length, "line")} counted`);
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
  function mark(text, terms, after) {
    let t = esc(text);
    const rx = w => String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const term of terms) {
      const re = new RegExp(`\\b(${rx(term)})`, "ig");
      if (re.test(t)) { t = t.replace(re, "<mark>$1</mark>"); continue; }
      // a phrase that breaks across two captions ("…the select" / "board…")
      // starts at the end of this line, and the line is listed for it — mark
      // the words of it the line holds, when the next line (`after`, the
      // same meeting's) finishes it; never a lone "artificial" before turf
      if (after == null) continue;
      const w = String(term).trim().split(/\s+/), nx = String(after);
      for (let k = w.length - 1; k >= 1; k--) {
        const tail = new RegExp(`\\b(${w.slice(0, k).map(rx).join("\\s+")})\\s*$`, "i");
        const rest = new RegExp(`^\\s*${w.slice(k).map(rx).join("\\s+")}(?![a-z0-9])`, "i");
        if (tail.test(t) && rest.test(nx)) { t = t.replace(tail, "<mark>$1</mark>"); break; }
      }
    }
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
    wireBeadTicks();   // every bead grows its quiet tick (specs/22 §5.1)
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
      // a status region: every confirmation the sighted reader gets, a screen
      // reader hears — polite, so it never interrupts mid-sentence
      toEl.setAttribute("role", "status");
      document.body.appendChild(toEl); }
    toEl.textContent = msg; toEl.classList.add("on");
    clearTimeout(toEl._t); toEl._t = setTimeout(() => toEl.classList.remove("on"), 2600);
  }

  /* ================= THE CIVIC BROADSHEET (specs/29) =========================
     The press draws every picture and stamps its numbers beside it as
     data-bs-* JSON; this file re-lights them. The pure halves come first —
     bsScoreState, bsYearState, bsGroup, bsMonthX — so the node twins in
     tests/test_web_bake.py can lift and run them against the press's own
     answers; the DOM after. Nothing here leaves the browser: the index is
     the edition's own static planes, the reel is a link, a click is a
     seek. With this file gone every chart is a still and every control an
     anchor. */
  let BS_FOLLOW = null;   // the meeting page's score follows the playing tape
  /* the score at a time t: the playhead's x, the nearest decision (ties to
     the earlier), the third the frame shows — web/charts.py score_state */
  function bsScoreState(D, t) {
    const dur = Math.max(1, +D.dur || 1), w = +D.w || 880;
    t = Math.max(0, Math.min(dur, +t || 0));
    let near = null;
    (D.decisions || []).forEach((d, i) => { if (near === null || Math.abs(+d.t - t) < Math.abs(+D.decisions[near].t - t)) near = i; });
    return { x: Math.round(t / dur * w), near, third: Math.min(2, Math.floor(t / dur * 3)), mmss: hms(t) };
  }
  function bsScore() {
    const onMeeting = !!$(".meeting");
    for (const box of $$(".bs-score")) {
      let D; try { D = JSON.parse(box.dataset.bsScore || ""); } catch { continue; }
      if (!D || !Array.isArray(D.decisions)) continue;
      const svg = $("svg", box); if (!svg) continue;
      const sec = box.closest(".bs-tonight") || box.closest(".meeting") || document;
      const head = $(".bs-playhead", svg), line = head && $("line", head), lab = head && $("text", head);
      const decs = $$(".bs-dec", svg), ticks = $$(".bs-tick", svg);
      const frames = $$(".bs-frame", sec), money = $$(".bs-moneyrow", sec);
      const now = $("#bs-now", sec), heroQ = $("#bs-hero-q", sec), heroImg = $("#bs-hero-img", sec);
      const play = $("#bs-playfrom", sec), playT = play && $(".bs-play-t", play);
      const paint = (t, said) => {
        const st = bsScoreState(D, t);
        if (line) { line.setAttribute("x1", st.x); line.setAttribute("x2", st.x); }
        if (lab) { lab.setAttribute("x", st.x); lab.textContent = st.mmss; }
        decs.forEach((a, i) => a.classList.toggle("on", i === st.near));
        ticks.forEach(a => a.classList.toggle("near", Math.abs(+a.dataset.t - t) < 240));
        const cur = (el, on) => { el.classList.toggle("on", on); if (on) el.setAttribute("aria-current", "true"); else el.removeAttribute("aria-current"); };
        frames.forEach(f => cur(f, +f.dataset.i === st.third));
        money.forEach(r => cur(r, Math.abs(+r.dataset.t - t) < 1));
        if (play) { play.href = `${BASE}/m/${encodeURIComponent(D.pid)}#t${Math.floor(t)}`; if (playT) playT.textContent = st.mmss; }
        const d = st.near !== null ? D.decisions[st.near] : null;
        if (now && d) {
          $(".bs-now-t", now).textContent = st.mmss;
          $(".bs-now-kind", now).textContent = d.kind === "tension" ? "tension" : d.kind === "vote" ? "a roll call" : "a decision";
          $(".bs-now-q", now).textContent = `“${d.quote || ""}”`;
          $(".bs-now-why", now).textContent = d.kind === "vote" ? "the record read a roll call here"
            : d.kind === "tension" ? "the record heard the room push back here"
            : d.reason === "passes" ? "the record heard a motion carry here" : "the record heard a decision here";
        }
        if (heroQ) heroQ.textContent = said ? `“${said}”` : d ? `“${d.quote || ""}”` : "";
        if (heroImg) { const f = frames.find(x => +x.dataset.i === st.third), im = f && $("img", f);
          if (im && im.getAttribute("src")) heroImg.src = im.getAttribute("src"); }
      };
      const go = (t, said) => {
        paint(t, said);
        if (onMeeting) {
          const f = $(".player.facade"); if (f) loadTape(f.dataset.video, t); else ytSeek(t);
          history.replaceState(null, "", "#t" + Math.floor(t));
        }
      };
      svg.addEventListener("click", e => {
        const a = e.target.closest("a[data-t]");
        if (a && svg.contains(a)) { e.preventDefault(); go(+a.dataset.t, a.dataset.text || ""); return; }
        // anywhere on the lanes: the time under the pointer (click anywhere to jump)
        const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal; if (!r.width || !vb) return;
        const x = (e.clientX - r.left) / r.width * vb.width + vb.x;
        if (x < 0 || x > (+D.w || 880)) return;
        go((+D.dur || 1) * Math.max(0, Math.min(1, x / (+D.w || 880))));
      });
      sec.addEventListener("click", e => {
        const a = e.target.closest(".bs-frame[data-t], .bs-moneyrow[data-t]");
        if (!a || !sec.contains(a)) return;
        e.preventDefault(); go(+a.dataset.t);
      });
      if (onMeeting) BS_FOLLOW = t => paint(t);
    }
  }
  /* the year at a chapter, with a picked tape: which tapes dim, what the
     line says — web/charts.py year_tapes's pressed state is chapter = last */
  function bsYearState(D, chapter, pick) {
    const chs = D.chapters || [], ch = chs[chapter] || null;
    const months = new Set(ch ? ch.months : []);
    const t = pick ? (D.tapes || []).find(x => x.pid === pick) : null;
    return {
      dim: ch ? (D.tapes || []).filter(x => !months.has(x.month)).map(x => x.pid) : [],
      line: t ? String(t.title || t.pid) : ch ? String(ch.blurb || "") : "",
      // the pressed paragraph, with its receipts, when the press shipped one
      html: t ? "" : ch ? String(ch.html || "") : "",
      meta: t ? `${tpDay(t.date)} · ${[t.town, t.body].filter(Boolean).join(" · ")} · ${+t.hours || 0} hours of tape · press again to open its page`
              : ch ? `chapter ${chapter + 1} of ${chs.length} · ${tpN((ch.months || []).length, "month")}` : "",
      href: t ? `${BASE}/m/${encodeURIComponent(t.pid)}` : "",
    };
  }
  function bsYear() {
    const box = $(".bs-year"); if (!box) return;
    let D; try { D = JSON.parse(box.dataset.bsYear || ""); } catch { return; }
    if (!D || !Array.isArray(D.tapes)) return;
    const sec = box.closest(".bs-year-sec") || box.parentElement;
    const line = $("#bs-tapeline", sec), meta = $("#bs-tapemeta", sec);
    const pills = $$(".bs-chap", sec), tapes = $$(".bs-tape", box);
    let chapter = Math.max(0, (D.chapters || []).length - 1), pick = null;
    const paint = () => {
      const st = bsYearState(D, chapter, pick), dim = new Set(st.dim);
      tapes.forEach(a => { a.classList.toggle("bs-dim", dim.has(a.dataset.pid)); const on = a.dataset.pid === pick;
        a.classList.toggle("on", on); if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
      pills.forEach(p => { const on = +p.dataset.chapter === chapter; p.classList.toggle("on", on); if (on) p.setAttribute("aria-current", "true"); else p.removeAttribute("aria-current"); });
      if (line) { if (st.href) line.innerHTML = `<a href="${esc(st.href)}">${esc(st.line)}</a>`;
        else if (st.html) line.innerHTML = st.html;      // press-made and already escaped — the page's own bytes
        else line.textContent = st.line; }
      if (meta) meta.textContent = st.meta;
    };
    pills.forEach(p => p.addEventListener("click", e => { e.preventDefault(); chapter = +p.dataset.chapter; pick = null; paint(); }));
    // the first press on a still names the meeting; a second opens it (the link)
    tapes.forEach(a => a.addEventListener("click", e => { if (pick === a.dataset.pid) return; e.preventDefault(); pick = a.dataset.pid; paint(); }));
  }
  /* a lens label isolates its band; the same label again shows all eight */
  function bsRiver() {
    for (const svg of $$(".bs-river-svg")) {
      svg.addEventListener("click", e => {
        const l = e.target.closest(".bs-rlabel"); if (!l) return;
        e.preventDefault();
        const lens = l.dataset.lens, was = svg.classList.contains("bs-iso") && !!$(`.bs-band.on[data-lens="${lens}"]`, svg);
        $$(".bs-band", svg).forEach(b => b.classList.toggle("on", !was && b.dataset.lens === lens));
        svg.classList.toggle("bs-iso", !was);
      });
    }
  }
  /* ---- the search page's extras (board 5): the timeline of town-coloured
     dots, and the reel rows with stills — the press's charts.timeline_dots */
  const BS_TOWNS = { boston: "#1F4E79", brookline: "#1E5E3F" }, BS_TOWNS_LIGHT = { boston: "#DEE8F3", brookline: "#DDEBE1" };
  const bsTown = t => BS_TOWNS[String(t || "").trim().toLowerCase()] || "#191712";
  const bsTownLight = t => BS_TOWNS_LIGHT[String(t || "").trim().toLowerCase()] || "#D9D1BF";
  const BS_MDAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  /* x along a run of months: a date lands at its month's column plus its
     day's share of it — web/charts.py month_axis */
  function bsMonthX(months, width) {
    const colw = width / Math.max(1, months.length), idx = Object.create(null);
    months.forEach((m, i) => idx[m] = i);
    return date => {
      const d = String(date || ""), mo = d.slice(0, 7);
      if (!(mo in idx)) return (!months.length || d < months[0]) ? 0 : width;
      const day = TP_DAY.test(d) ? Math.max(1, Math.min(31, +d.slice(8, 10))) : 1;
      const days = BS_MDAYS[+mo.slice(5, 7)] || 30;
      return (idx[mo] + (day - 1) / days) * colw;
    };
  }
  const bsDayShort = d => TP_DAY.test(String(d || "")) ? `${TP_MON[+String(d).slice(5, 7)]} ${+String(d).slice(8, 10)}` : "undated";
  const bsEsc = s => esc(s).replace(/'/g, "&#x27;");   // the press's html.escape(quote=True) — the twin holds byte for byte
  function bsTimeline(rows, q, width, height, unit) {
    width = width || 1160; height = height || 170;
    const said = rows.filter(r => r.n && tpIsMonth(r.date));
    const months = tpMonthRange(rows.filter(r => tpIsMonth(r.date)).map(r => r.date.slice(0, 7)));
    if (!said.length || !months.length) return "";
    const x = bsMonthX(months, width), colw = width / months.length, base = 110;
    let out = months.map((mo, i) => `<text x="${r1(i * colw + 4)}" y="${height - 8}" font-size="11" fill="#6F6A5B" style="font-family:var(--font-mono)">${TP_MON[+mo.slice(5, 7)]}</text><line x1="${r1(i * colw)}" y1="${base - 6}" x2="${r1(i * colw)}" y2="${base + 6}" stroke="#D9D1BF"/>`).join("");
    out += `<line x1="0" y1="${base}" x2="${width}" y2="${base}" stroke="#D9D1BF" stroke-width="2"/>`;
    for (const r of said.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))) {
      const cx = x(r.date);
      out += `<a href="${BASE}/m/${bsEsc(r.pid)}#t${Math.floor(r.first_t || 0)}" class="bs-tdot" data-pid="${bsEsc(r.pid)}"><circle cx="${r1(cx)}" cy="${base}" r="9" fill="${bsTown(r.town)}"><title>${bsEsc(r.title || r.pid)} — ${tpN(+r.n || 0, unit || "line")}</title></circle>`
        + `<text x="${r1(cx)}" y="${base - 22}" font-size="12" fill="#4B473E" text-anchor="middle" style="font-family:var(--font-sans)">${bsEsc(tpCutWords(r.body, 24))}</text>`
        + `<text x="${r1(cx)}" y="${base - 38}" font-size="11" fill="#6F6A5B" text-anchor="middle" style="font-family:var(--font-mono)">${bsEsc(bsDayShort(r.date))}</text></a>`;
    }
    const label = q ? `when “${q}” came up` : "when it came up";
    return `<div class="bs-timeline"><span class="kicker">${bsEsc(label)} — each dot is a meeting; click one to jump</span><div class="fp-chartwrap"><svg class="bs-timeline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${bsEsc(label)}">${out}</svg></div></div>`;
  }
  function bsSearchExtras(d, q, idx) {
    const stills = Object.create(null);
    for (const m of ((idx && idx.meta) || [])) if (m && m.pid) stills[m.pid] = !!m.still;
    const rows = (d.chapters || []).map(c => {
      const m = (d.meetings || []).find(x => x.pid === c.pid) || {};
      const pic = stills[c.pid] ? `<img src="${BASE}/stills/${encodeURIComponent(c.pid)}.jpg" alt="" loading="lazy" width="200" height="112">`
        : `<span class="bs-nostill" style="background:${bsTownLight(d.town)}"></span>`;
      return `<a class="bs-reelrow" href="${BASE}/m/${encodeURIComponent(c.pid)}#t${Math.floor(c.t || 0)}" style="--town:${bsTown(d.town)}">${pic}
        <span class="bs-reelrow-b"><span class="bs-reelrow-k">${esc([d.town, c.body].filter(Boolean).join(" · "))}</span>
        <span class="bs-reelrow-t">${esc(c.title || m.title || c.pid)}</span>
        <span class="bs-reelrow-m">first said at ${hms(c.t || 0)} · ${tpN(c.n, "line")} that night · play the moment, or read the captions around it</span></span>
        <span class="bs-reelrow-go">▶ ${hms(c.t || 0)}</span></a>`;
    }).join("");
    // the story's rows carry no town of their own — the story's town is theirs
    const tl = bsTimeline((d.meetings || []).map(r => ({ ...r, town: r.town || d.town })), q);
    return (tl ? `<section class="fp-part">${tl}</section>` : "")
      + (rows ? `<section class="fp-part"><div class="sectionhead"><span class="kicker">the reel — ${tpN((d.chapters || []).length, "meeting")}, in order</span></div><div class="bs-reelrows">${rows}</div></section>` : "");
  }
  /* ---- the spine's type-ahead (board 2): moments · meetings · threads ·
     over time, over the shipped index; keyboard-first; nothing leaves the
     browser. The grouping is pure (bsGroup) and twinned. */
  const BS_TA_MOMENTS = 5, BS_TA_MEETINGS = 3, BS_TA_THREADS = 2, BS_TA_CLIPS = 200;
  function bsGroup(idx, ids, q, issues) {
    const meta = idx.meta || [], hits = sqHits(idx, ids, [q.trim()]);
    const by = Object.create(null); for (const m of meta) if (m && m.pid) by[m.pid] = m;
    const dkey = h => (by[h.pid] || {}).date || "";
    const moments = hits.slice().sort((a, b) => (dkey(b) > dkey(a) ? 1 : dkey(b) < dkey(a) ? -1 : 0) || a.t - b.t)
      .map(h => ({ pid: h.pid, t: h.t, text: h.text, title: (by[h.pid] || {}).title || h.pid, body: (by[h.pid] || {}).body || "",
                   town: (by[h.pid] || {}).town || "", date: dkey(h) }));
    const perPid = Object.create(null);
    for (const h of hits) (perPid[h.pid] ||= []).push(h);
    const meetings = Object.keys(perPid).map(pid => { const m = by[pid] || {}; const hs = perPid[pid].slice().sort((a, b) => a.t - b.t);
      return { pid, title: String(m.title || pid), date: String(m.date || ""), town: String(m.town || ""), body: String(m.body || ""), still: !!m.still, n: hs.length, first_t: hs[0].t }; })
      .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0) || (a.pid < b.pid ? -1 : 1));
    const ql = q.trim().toLowerCase();
    const threads = (Array.isArray(issues) ? issues : []).filter(i => i && typeof i === "object" && PAPER_REF.test(i.slug || "")
      && [i.name, ...(Array.isArray(i.aliases) ? i.aliases : [])].some(x => String(x || "").toLowerCase().includes(ql)))
      .sort((a, b) => (+b.n_meetings || 0) - (+a.n_meetings || 0) || (String(a.name) < String(b.name) ? -1 : 1))
      .map(i => ({ slug: i.slug, name: i.name || i.slug, n_meetings: +i.n_meetings || 0 }));
    const months = tpMonthRange(meta.filter(m => m && tpIsMonth(m.date)).map(m => m.date.slice(0, 7)));
    const counts = months.map(mo => meetings.filter(m => String(m.date).slice(0, 7) === mo).length);
    let clips = [];
    for (const pid of Object.keys(perPid).sort()) clips = clips.concat(tpMerge(perPid[pid], +(by[pid] || {}).duration || 0));
    return { total: hits.length, moments, meetings, threads, months, counts, clips: clips.slice(0, BS_TA_CLIPS) };
  }
  function bsSpark(months, counts, color, quiet) {
    if (!months.length) return "";
    const W = 300, H = 70, step = (W - 8) / Math.max(1, months.length - 1);
    const pts = counts.map((c, i) => [4 + i * step, H - 6 - Math.min(2, c) * 28]);
    // inside a link the spark is decoration — the link's own text is its name
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${quiet ? 'aria-hidden="true"' : 'role="img" aria-label="meetings that took it up, month by month"'}>
      <polyline points="${pts.map(p => `${r1(p[0])},${r1(p[1])}`).join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" opacity=".55"/>
      ${pts.map((p, i) => counts[i] ? `<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="3" fill="${color}"><title>${TP_MON[+months[i].slice(5, 7)]}: ${tpN(counts[i], "meeting")}</title></circle>` : "").join("")}</svg>`;
  }
  const bsMark = (text, q) => { const t = String(text || ""), i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(tpCutWords(t, 90));
    const a = Math.max(0, i - 40), b = Math.min(t.length, i + q.length + 50);
    return (a ? "…" : "") + esc(t.slice(a, i)) + `<mark>${esc(t.slice(i, i + q.length))}</mark>` + esc(t.slice(i + q.length, b)) + (b < t.length ? "…" : ""); };
  function bsSpine() {
    const box = $("#bs-spine"); if (!box) return;
    const input = $("#spine", box), panel = $("#bs-ta", box); if (!input || !panel) return;
    input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false"); input.setAttribute("aria-controls", "bs-ta");
    panel.setAttribute("role", "listbox"); panel.setAttribute("aria-label", "suggestions");
    let deb, items = [], sel = -1, open = false, seq = 0, dismissed = "";
    const close = () => { clearTimeout(deb); seq++; panel.hidden = true; panel.innerHTML = ""; items = []; sel = -1; open = false;
      input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
    const mark = () => { items.forEach((el, i) => el.setAttribute("aria-selected", i === sel ? "true" : "false"));
      if (sel >= 0 && items[sel]) { input.setAttribute("aria-activedescendant", items[sel].id); items[sel].scrollIntoView({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant"); };
    const move = d => { if (!items.length) return; sel = (sel + d + items.length) % items.length; mark(); };
    // the next group's first suggestion, or -1 past the last group (Tab then leaves the spine)
    const nextGroup = () => { if (!items.length) return -1; const g = sel >= 0 ? items[sel].dataset.g : "";
      const i = items.findIndex((el, k) => k > sel && el.dataset.g !== g); if (i < 0) return -1; sel = i; mark(); return i; };
    const paint = (g, q) => {
      const townOf = m => [m.town, m.body].filter(Boolean).join(" · ");
      const mom = g.moments.slice(0, BS_TA_MOMENTS).map((h, i) => `<a class="bs-ta-hit" role="option" id="bs-ta-m${i}" data-g="m" href="${BASE}/m/${encodeURIComponent(h.pid)}#t${Math.floor(h.t)}">
        <span class="ts">▶ ${hms(h.t)}</span><span class="bs-ta-hit-body"><span class="bs-ta-hit-t">${bsMark(h.text, q)}</span><span class="bs-ta-hit-m">${esc([townOf(h), bsDayShort(h.date)].filter(Boolean).join(" · "))}</span></span></a>`).join("");
      const all = g.clips.length ? `<a class="bs-ta-all" role="option" id="bs-ta-all" data-g="m" href="${esc(reelShareURL(g.clips))}"><span>all ${tpN(g.total, "moment")}, as a reel →</span><span>⌘↵</span></a>` : "";
      const meet = g.meetings.slice(0, BS_TA_MEETINGS).map((m, i) => `<a class="bs-ta-mrow" role="option" id="bs-ta-e${i}" data-g="e" href="${BASE}/m/${encodeURIComponent(m.pid)}#t${Math.floor(m.first_t)}">
        ${m.still ? `<img src="${BASE}/stills/${encodeURIComponent(m.pid)}.jpg" alt="" loading="lazy" width="96" height="54">` : `<span class="bs-nostill" style="background:${bsTownLight(m.town)}"></span>`}
        <span class="bs-ta-hit-body"><span class="bs-ta-hit-t">${esc(m.title)}</span><span class="bs-ta-hit-m">${esc(tpDay(m.date))} · first said at ${hms(m.first_t)}</span></span></a>`).join("");
      const thr = g.threads.slice(0, BS_TA_THREADS).map((t, i) => `<a class="bs-ta-trow" role="option" id="bs-ta-t${i}" data-g="t" href="${BASE}/i/${encodeURIComponent(t.slug)}"><span>${esc(t.name)}</span><span class="bs-ta-hit-m">${tpN(t.n_meetings, "meeting")}</span></a>`).join("");
      const sq = `${BASE}/s?q=${encodeURIComponent(q)}`;
      const start = g.threads.length ? `${BASE}/p#edit&tpl=issue&ref=${encodeURIComponent(g.threads[0].slug)}` : `${BASE}/p#edit`;
      const color = g.meetings.length && g.meetings.every(m => m.town === g.meetings[0].town) ? bsTown(g.meetings[0].town) : "#191712";
      panel.innerHTML = g.total ? `
        <div class="bs-ta-col bs-ta-moments" role="group" aria-label="moments that say it"><div class="bs-ta-head"><span class="kicker">moments that say it · ${g.total}</span><span class="bs-ta-keys">↑↓ move · ↵ play · ⇥ next group</span></div>${mom}${all}</div>
        <div class="bs-ta-col bs-ta-meet" role="group" aria-label="meetings that took it up, and threads"><div class="bs-ta-head"><span class="kicker">meetings that took it up · ${g.meetings.length}</span></div>${meet}
          <div class="bs-ta-head"><span class="kicker">threads</span></div>${thr || `<span class="bs-ta-empty">no thread the record tracks by that name</span>`}</div>
        <div class="bs-ta-col bs-ta-time" role="group" aria-label="over time"><span class="kicker">over time</span>${bsSpark(g.months, g.counts, color)}
          <span class="bs-ta-note" style="margin-top:0">${g.months.length ? `${TP_MON[+g.months[0].slice(5, 7)]} → ${TP_MON[+g.months[g.months.length - 1].slice(5, 7)]} · meetings that took it up` : ""}</span>
          <a class="bs-ta-btn" role="option" id="bs-ta-tell" data-g="o" href="${sq}">Tell “${esc(q)}” as a story →</a>
          <a class="bs-ta-btn rust" role="option" id="bs-ta-start" data-g="o" href="${esc(start)}">Start a front page from it</a>
          <span class="bs-ta-note">searches never leave your browser: the index ships with the edition</span></div>`
        : `<div class="bs-ta-col bs-ta-moments" style="grid-column:span 12"><span class="bs-ta-empty">nothing on the record says “${esc(q)}” yet — press Search for the whole page, or try another word</span></div>`;
      items = $$("[role=option]", panel); sel = -1; open = true; panel.hidden = false; input.setAttribute("aria-expanded", "true");
    };
    async function run(q) {
      const my = ++seq;
      const [idx, issues] = await Promise.all([sqIndex(), getJSON(`${BASE}/issues/index.json`)]);
      if (my !== seq || !idx || input.value.trim() !== q) return;
      const terms = q.toLowerCase().match(/[a-z0-9]+/g) || [];
      if (!terms.length) { close(); return; }
      const ids = await sqIds(idx, terms, q);
      if (my !== seq || input.value.trim() !== q) return;
      paint(bsGroup(idx, ids, q, issues), q);
    }
    input.addEventListener("input", () => { clearTimeout(deb); dismissed = ""; const v = input.value.trim();
      if (v.length < 3) { close(); return; } deb = setTimeout(() => run(v), 220); });
    // a dismissed word stays dismissed until it changes — a returning focus does not reopen it
    input.addEventListener("focus", () => { const v = input.value.trim(); if (v.length >= 3 && !open && dismissed !== v) run(v); });
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") { dismissed = input.value.trim(); if (open) e.preventDefault(); close(); return; }
      if (!open) return;
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Tab" && !e.shiftKey && items.length) {
        // the next group; past the last, Tab leaves the spine for the page (no trap)
        if (nextGroup() >= 0) e.preventDefault(); else close();
      }
      else if (e.key === "Enter") {
        if (e.metaKey || e.ctrlKey) { const a = $("#bs-ta-all", panel); if (a) { e.preventDefault(); location.href = a.href; } return; }
        const el = items[sel]; if (el) { e.preventDefault(); location.href = el.href; }
      }
    });
    document.addEventListener("click", e => { if (!box.contains(e.target)) close(); });
    // focus leaving the spine — Shift+Tab, a Tab with no suggestions — closes it too
    box.addEventListener("focusout", e => { if (!e.relatedTarget || !box.contains(e.relatedTarget)) close(); });
  }
})();
