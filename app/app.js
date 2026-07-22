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
    else if (/\/app\/p$/.test(path)) paper();
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
    refreshReelSummary();
    refreshPaperSummary();
    // another tab that ticks a moment (or edits the paper, or clears either)
    // writes a shared key; reflect it here without a reload. When THIS page is
    // also composing, the tray and ticks must move together with the summary,
    // or the two disagree. A clear() fires with key === null and touches both.
    window.addEventListener("storage", e => {
      const k = e && e.key;
      if (k === REEL_KEY || k === null) {
        if (CREEL) { CREEL.clips = readReel(REEL_KEY); buildTray(); paintTicks(); }
        refreshReelSummary();
        refreshPaperSummary();   // the reel add-button's count rides the tray
      }
      if (k === PAPER_KEY || k === null) {
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
      // your paper (P1) — every handler here is a call into the paper section;
      // painting and arranging stay pure localStorage, and the one server
      // touch a paper can have (the optional short link) happens only inside
      // paperShortLink, behind this explicit press and nowhere else.
      else if (act === "padd") addPageToPaper();
      else if (act === "preel") addReelToPaper();
      else if (act === "pnote") addNoteToPaper();
      else if (act === "pchart") addChartToPaper(b.dataset.chart, b.dataset.ref || "");
      else if (act === "pup" || act === "pdown" || act === "pdel")
        movePaperBlock(+b.dataset.i, act);
      else if (act === "plink") copyText(paperShareURL(readPaper()),
        "paper link copied — it carries the whole paper");
      else if (act === "pjson") downloadPaper(readPaper());
      else if (act === "pshort") paperShortLink();
      else if (act === "pclear") clearPaper();
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
    refreshReelSummary(); refreshPaperSummary(); toast("reel cleared");
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
  function refreshPaperSummary(focus) {
    if (!STUDIO) return;
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
      const label = b.kind === "reel"
        ? `▶ a reel — ${b.clips.length} clip${b.clips.length > 1 ? "s" : ""} · ${hms(reelRuntime(b.clips))}`
        : b.kind === "note"
          ? `✎ a note${b.text.trim() ? " — " + b.text.trim().slice(0, 40) : ""}`
        : b.kind === "chart" ? chartRowLabel(b)
        : b.story === "issue" ? `◈ ${b.name || b.slug}`
        : `§ ${b.title || b.pid}`;
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
          ${ref && ref.story === "meeting" ? chartBtn("framing", ref.pid, "this meeting’s framing") : ""}
          ${ref && ref.story === "issue" ? chartBtn("reach", ref.slug, "this issue’s reach") : ""}
          ${chartBtn("votes", "", "votes over time")}
          ${chartBtn("framing", "", "the record’s framing")}
          ${chartBtn("topics", "", "recurring topics")}
        </div></details>`;
    const adds =
        (ref ? `<button type="button" class="btn" data-cz="padd">＋ ${ref.story === "issue" ? "this issue" : "this meeting"}</button>` : "")
      + (clips.length ? `<button type="button" class="btn" data-cz="preel">＋ your reel (${clips.length} clip${clips.length > 1 ? "s" : ""})</button>` : "")
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
    el.innerHTML =
        `<input class="cz-ptitle" type="text" maxlength="200"
           placeholder="name your paper" aria-label="your paper’s title"
           value="${esc(p.title)}">`
      + rows
      + (n ? "" : `<p class="cz-hint">Your paper starts empty. Add the meeting
           or issue you’re reading, or your reel — arrange the blocks, title
           it, share it as your own front page.</p>`)
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
    if (focus) {
      let t = focus.act === "title" ? ti
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
  const saveReel = () => { try {
    localStorage.setItem(REEL_KEY, JSON.stringify(CREEL.clips));
  } catch { /* private mode: the tray still works for this visit */ }
    refreshReelSummary();     // keep the studio's reel count live as you tick
    refreshPaperSummary();    // and the panel's "＋ your reel" button with it
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
  const PAPER_VS = ["1", "2"];
  /* which link version a paper needs: v=1 is the shipped P1 grammar
     (stories + reels) and stays byte-identical for those papers forever;
     v=2 marks a paper carrying kinds a v1 reader cannot represent (notes,
     charts) — the shipped reader then shows its honest "shared from a newer
     version" message instead of silently rendering a mutilated paper. */
  const paperV = p => p.blocks.some(
    b => b.kind === "note" || b.kind === "chart") ? "2" : "1";
  /* does anything actually TRAVEL — a title, or a block that survives
     portablePaper (an empty note does not). The share row, the title
     handler and the note handler all read THIS one truth, so typing across
     the empty↔live boundary repaints the row that depends on it (the fix
     re-review's catch: a gate whose truth can change under a keystroke
     needs a repaint on exactly that boundary). */
  const paperHasLive = d => !!(d.title
    || d.blocks.some(b => b.kind !== "note" || b.text.trim()));
  const PAPER_KEY = "cz-paper";        // the one draft this browser keeps
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
  const PAPER_CHARTS = ["votes", "reach", "framing", "topics"];
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

  function readPaper() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(PAPER_KEY) || "null"); }
    catch { p = null; }
    return normalizePaper(p);
  }
  /* returns whether the draft actually held — a browser that blocks storage
     gets told the truth by the callers, not a success toast over a void. Any
     change also retires the last short link: it names the OLD paper. */
  function savePaper(p) {
    PAPER_SHORT = "";
    try { localStorage.setItem(PAPER_KEY, JSON.stringify(p)); return true; }
    catch { return false; }
  }

  /* total: whatever arrives — a draft, a decoded link, a stored paper, a
     hand-edited file — leaves as a valid paper. Unknown kinds, broken refs
     and impossible clips drop silently; nothing throws. */
  function normalizePaper(p) {
    const out = { title: "", blocks: [] };
    if (!p || typeof p !== "object") return out;
    if (typeof p.title === "string") out.title = cut(p.title, PAPER_TITLE_MAX);
    for (const b of (Array.isArray(p.blocks) ? p.blocks : [])) {
      if (out.blocks.length >= PAPER_MAX_BLOCKS) break;
      const nb = normalizeBlock(b);
      if (nb) out.blocks.push(nb);
    }
    return out;
  }
  function normalizeBlock(b) {
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
    if (b.kind === "chart" && (b.chart === "votes" || b.chart === "topics"
        || b.chart === "framing"))
      return { kind: "chart", chart: b.chart };
    return null;
  }

  /* the traveling form: refs only. The draft carries ride-along display meta
     (titles, quotes) so the panel paints without a fetch; the link, the store
     and the export's block list carry none of it — a reader's page enriches
     from the record's own planes, so a paper can never assert a title the
     record would not. */
  function portablePaper(p) {
    p = normalizePaper(p);
    return {
      schema: "publicrecord.paper/1",
      title: p.title,
      // an empty note is a draft-in-progress; no traveling form carries one
      blocks: p.blocks.filter(b => b.kind !== "note" || b.text.trim())
        .map(b => b.kind === "reel"
        ? { kind: "reel",
            clips: b.clips.map(c => ({ pid: c.pid, start: r1(c.start), end: r1(c.end) })) }
        : b.kind === "note"
          ? { kind: "note", text: b.text }
        : b.kind === "chart"
          ? (b.chart === "reach"
              ? { kind: "chart", chart: "reach", slug: b.slug }
            : b.pid
              ? { kind: "chart", chart: "framing", pid: b.pid }
              : { kind: "chart", chart: b.chart })
        : b.story === "issue"
          ? { kind: "story", story: "issue", slug: b.slug }
          : { kind: "story", story: "meeting", pid: b.pid }),
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
      : b.kind === "chart"
        ? "c." + b.chart + (b.slug || b.pid
            ? "." + encodeURIComponent(b.slug || b.pid) : "")
      : b.story === "issue" ? "i." + encodeURIComponent(b.slug)
      : "m." + encodeURIComponent(b.pid));
    return `v=${paperV(p)}`
      + (p.title ? `&t=${encodeURIComponent(p.title)}` : "")
      + (parts.length ? `&b=${parts.join(",")}` : "");
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
    for (const part of (q.get("b") || "").split(",")) {
      if (out.blocks.length >= PAPER_MAX_BLOCKS) break;
      const dot = part.indexOf(".");
      if (dot < 1) continue;
      const kind = part.slice(0, dot), rest = part.slice(dot + 1);
      if (kind === "m" || kind === "i") {
        let ref = "";
        try { ref = decodeURIComponent(rest).trim(); } catch { continue; }
        if (!PAPER_REF.test(ref)) continue;
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
        try { text = noteText(decodeURIComponent(rest)); } catch { continue; }
        if (text.trim()) out.blocks.push({ kind: "note", text });
      } else if (kind === "c") {
        const dot2 = rest.indexOf(".");
        const chart = dot2 < 0 ? rest : rest.slice(0, dot2);
        if (!PAPER_CHARTS.includes(chart)) continue;
        if (dot2 < 0) {
          // bare forms: votes, topics, framing (the whole record) — reach
          // needs its issue, so a bare reach is a mangle, not a chart
          if (chart !== "reach") out.blocks.push({ kind: "chart", chart });
        } else {
          let ref = "";
          try { ref = decodeURIComponent(rest.slice(dot2 + 1)).trim(); }
          catch { continue; }
          if (!PAPER_REF.test(ref)) continue;
          if (chart === "reach")
            out.blocks.push({ kind: "chart", chart: "reach", slug: ref });
          else if (chart === "framing")
            out.blocks.push({ kind: "chart", chart: "framing", pid: ref });
          // votes/topics carry no ref — a reffed one is a mangle, dropped
        }
      }
    }
    return out;
  }

  /* arrange: the panel's ↑ ↓ ✕, one function. Index-addressed against the
     draft as it is NOW — a stale index (another tab just edited) can at worst
     move the wrong neighbour once, and the repaint shows exactly what held. */
  function movePaperBlock(i, act) {
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
    refreshPaperSummary(focus); schedulePaperRender();
  }
  /* add the open page as a story. The meta that rides along comes from the
     page's own plane — already in the fetch cache when the page hydrated — so
     the panel can label the block without lying; a plane that will not load
     still adds the bare ref, and the reader's render enriches later. */
  async function addPageToPaper() {
    const ref = pageStoryRef();
    if (!ref) { toast("open a meeting or an issue to add it as a story"); return; }
    const dup = p => ref.story === "meeting"
      ? p.blocks.some(b => b.kind === "story" && b.story === "meeting" && b.pid === ref.pid)
      : p.blocks.some(b => b.kind === "story" && b.story === "issue" && b.slug === ref.slug);
    if (dup(readPaper())) {
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
    if (dup(p)) { toast(`this ${ref.story} is already in your paper`); return; }
    p.blocks.push(nb);
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    refreshPaperSummary(); schedulePaperRender();
    toast("added to your paper");
  }
  /* the reel joins as a snapshot: the block holds these clips as they are
     now, and the tray keeps rolling — tick more moments and add again for a
     second reel. (A live pointer would rewrite a shared paper behind the
     editor's back.) */
  function addReelToPaper() {
    const clips = readReel(REEL_KEY);
    if (!clips.length) {
      toast("no clips yet — open a meeting and tick its moments"); return; }
    const p = readPaper();
    const nb = normalizeBlock({ kind: "reel", clips: clips.map(c => ({ ...c })) });
    if (!nb) { toast("these clips don’t make a playable reel"); return; }
    p.blocks.push(nb);
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    refreshPaperSummary(); schedulePaperRender();
    toast("reel added to your paper — the tray keeps rolling");
  }
  /* a note joins empty and is typed into in the panel — the draft may hold
     the blank; no traveling form does. Focus lands in the fresh textarea. */
  function addNoteToPaper() {
    const p = readPaper();
    if (p.blocks.length >= PAPER_MAX_BLOCKS) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    p.blocks.push({ kind: "note", text: "" });
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    refreshPaperSummary({ act: "note", i: p.blocks.length - 1 });
    schedulePaperRender();
  }
  /* a chart joins as an enum + a ref; the label that rides along comes from
     the plane the open page already fetched (or one honest fetch), so the
     panel can name it without lying. The chart itself is computed at render,
     from the record — never stored numbers. */
  async function addChartToPaper(chart, refv) {
    if (!PAPER_CHARTS.includes(chart)) return;
    const dup = p => p.blocks.some(b => b.kind === "chart" && b.chart === chart
      && ((b.slug || b.pid || "") === (refv || "")));
    if (dup(readPaper())) { toast("this chart is already in your paper"); return; }
    let nb;
    if (chart === "reach") {
      if (!refv) { toast("open an issue to chart its reach"); return; }
      const it = await getJSON(`${BASE}/issues/${encodeURIComponent(refv)}.json`) || {};
      nb = normalizeBlock({ kind: "chart", chart: "reach", slug: refv,
                            name: it.name || "" });
    } else if (chart === "framing" && refv) {
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(refv)}.json`) || {};
      nb = normalizeBlock({ kind: "chart", chart: "framing", pid: refv,
                            title: m.title || "" });
    } else {
      nb = normalizeBlock({ kind: "chart", chart });
    }
    if (!nb) { toast("this chart can’t join a paper"); return; }
    // the fetch awaited — re-read the draft so a meanwhile edit isn't reverted
    const p = readPaper();
    if (dup(p)) { toast("this chart is already in your paper"); return; }
    if (p.blocks.length >= PAPER_MAX_BLOCKS) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    p.blocks.push(nb);
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    refreshPaperSummary(); schedulePaperRender();
    toast("chart added — it draws from the record when your paper renders");
  }
  function clearPaper() {
    try { localStorage.removeItem(PAPER_KEY); } catch { /* private mode */ }
    retireShortOut();   // removeItem bypasses savePaper — retire here too
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
      b.chart === "votes" ? "/officials"
      : b.chart === "reach" ? `/i/${b.slug}`
      : b.chart === "framing" && b.pid ? `/m/${b.pid}`
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
        .map(b => b.kind === "reel"
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
        : b.story === "issue"
          ? { kind: "story", story: "issue", slug: b.slug, name: b.name || "",
              url: `${location.origin}${BASE}/i/${b.slug}` }
          : { kind: "story", story: "meeting", pid: b.pid, title: b.title || "",
              date: b.date || "", body: b.body || "", town: b.town || "",
              url: `${location.origin}${BASE}/m/${b.pid}` }),
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
      if (!doc.blocks.length && !doc.title)
        return paperMessage(el, "No paper here yet — this page renders one "
          + "when a link carries it, or shows your own draft. Enter the "
          + `studio on any page of <a href="${BASE}/">the record</a>, add `
          + "the stories and reels that matter to you, and your paper takes "
          + "shape here.");
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
      else if (b.kind === "story" && b.story === "issue") islugs.add(b.slug);
      else if (b.kind === "chart" && b.chart === "framing" && b.pid) mpids.add(b.pid);
      else if (b.kind === "chart" && b.chart === "reach") islugs.add(b.slug);
    }
    for (const b of doc.blocks)
      if (b.kind === "reel") b.clips.forEach(c => mpids.add(c.pid));
    const wantVotes = doc.blocks.some(b => b.kind === "chart" && b.chart === "votes");
    const wantAnalytics = doc.blocks.some(b => b.kind === "chart"
      && (b.chart === "topics" || (b.chart === "framing" && !b.pid)));
    const [m, it, votesPlane, analytics] = await Promise.all([
      fetchPlanes(mpids, "meetings", PAPER_MAX_BLOCKS + PAPER_MAX_CLIPS),
      fetchPlanes(islugs, "issues", PAPER_MAX_BLOCKS),
      wantVotes ? getJSON(`${BASE}/votes.json`) : Promise.resolve(null),
      wantAnalytics ? getJSON(`${BASE}/analytics.json`) : Promise.resolve(null),
    ]);
    if (gen !== PAPER_GEN) return;     // a newer render superseded this one
    const mby = m.got, iby = it.got, tried = { m: m.tried, i: it.tried };
    const aux = { votes: votesPlane, analytics };
    const head = `<header class="phead">
        <h2 class="ptitle">${esc(doc.title || "Untitled paper")}</h2>
        <p class="pfrom">${from === "draft"
          ? "your draft — it lives in this browser; share it from the studio as a link or a file"
          : from === "stored"
            ? "served from the share store — content-addressed and read-only; the editor holds the original"
            : "carried whole in the link you followed — no server held it"}</p>
      </header>`;
    const blocks = doc.blocks.map(b => renderPaperBlock(b, mby, iby, tried, aux))
      .filter(Boolean).join("");
    // a title-only paper is a sanctioned form — say what it is, not that its
    // (nonexistent) blocks were curated away
    el.innerHTML = head + (blocks
      || (doc.blocks.length
        ? `<p class="hint">This paper’s blocks aren’t in this pressing of the
            record — its meetings or issues may have been curated away. The
            <a href="${BASE}/">record itself</a> is one link up.</p>`
        : `<p class="hint">This paper is a title so far — its editor hasn’t
            added stories or reels yet. The <a href="${BASE}/">record
            itself</a> is one link up.</p>`));
  }
  function renderPaperBlock(b, mby, iby, tried, aux) {
    tried = tried || { m: new Set(), i: new Set() };
    aux = aux || {};
    if (b.kind === "note") {
      const text = (b.text || "").trim();
      // only the editor's own draft can hold an empty note (no traveling
      // form carries one) — say what it is instead of rendering a void
      if (!text) return `<section class="pb-note pb-note-empty">
        <span class="kicker">the editor’s note</span>
        <p class="hint">an empty note — write it in the studio panel</p></section>`;
      const paras = text.split(/\n+/).map(s => `<p>${esc(s)}</p>`).join("");
      // labeled out loud: a note is the one block that is the EDITOR's words,
      // not the record's — a reader must never mistake the two
      return `<section class="pb-note"><span class="kicker">the editor’s note</span>
        ${paras}</section>`;
    }
    if (b.kind === "chart") return renderChartBlock(b, mby, iby, tried, aux);
    if (b.kind === "story" && b.story === "meeting") {
      const m = mby[b.pid];
      if (!m) return tried.m.has(b.pid)
        ? paperGone(`a meeting (${b.pid})`)
        : paperBudget("a meeting");
      return `<a class="mcard pb-story" href="${BASE}/m/${esc(b.pid)}">`
        + (m.thumb ? `<img loading="lazy" src="${esc(m.thumb)}" alt="" width="96" height="54">` : "")
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
        + (span.length ? ` · ${esc(span.join(" — "))}` : "") + `</span>`
        + `</div></a>`;
    }
    if (b.kind === "reel") {
      const clips = b.clips.map(c => {
        const m = mby[c.pid]; if (!m) return null;
        const mo = nearestMoment(m.moments || [], c.start);
        return { ...c, t: mo ? r1(mo.t) : c.start,
                 kind: mo ? mo.kind : "moment", quote: mo ? mo.quote : "",
                 mtitle: m.title || "" };
      }).filter(Boolean);
      if (!clips.length)
        return b.clips.some(c => !tried.m.has(c.pid))
          ? paperBudget("a reel") : paperGone("a reel (its meetings)");
      const multi = reelPids(clips).length > 1;
      const rows = clips.map((c, i) =>
        `<a class="reelcite" href="${BASE}/m/${esc(c.pid)}#t${Math.floor(c.t)}">
          <span class="rc-ord">${i + 1}</span>
          <span class="rc-body">${multi ? `<span class="rc-from">${esc(c.mtitle || c.pid)}</span>` : ""}
            <span class="rc-quote">${esc(c.quote || "(moment)")}</span>
            <span class="rc-meta"><span class="rt-kind">${esc(c.kind)}</span>
              <span class="ts">${hms(c.start)}</span>–<span class="ts">${hms(c.end)}</span></span>
          </span></a>`).join("");
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
    if (b.chart === "votes") return chartVotes(aux.votes);
    if (b.chart === "topics") return chartTopics(aux.analytics);
    if (b.chart === "framing" && !b.pid) return chartFramingRecord(aux.analytics);
    if (b.chart === "framing") return chartFramingMeeting(b, mby, tried);
    if (b.chart === "reach") return chartReach(b, iby, tried);
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
              + `fill="#052e16" fill-opacity=".5"`
            : `<circle cx="${cx}" cy="${cy}" r="${dotR}" `
              + (mark === "pass" ? `fill="#052e16" fill-opacity=".82"`
                                 : `fill="#ffffff" stroke="#052e16" stroke-width="2"`))
          + `><title>${esc(tip)}</title>`
          + (mark === "other" ? `</rect></a>` : `</circle></a>`);
      });
      const y = c.date.slice(0, 4);
      labels += `<text x="${cx}" y="${plotH + 14}" text-anchor="middle" `
        + `font-size="10" fill="#475569">${chartDay(c.date)}</text>`;
      if (y && y !== prevYear) {
        labels += `<text x="${cx}" y="${plotH + 28}" text-anchor="middle" `
          + `font-size="10" fill="#475569">${esc(y)}</text>`;
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
      + `stroke="#e2e8f0"/>` + marks + labels + `</svg>`;
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
  function chartReach(b, iby, tried) {
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
    const barW = 34, gap = 14, pad = 10, plotH = 110;
    const maxB = Math.max(...tl.map(n => (n.beads || []).length), 1);
    const W = pad * 2 + tl.length * (barW + gap) - gap, H = plotH + 36;
    let marks = "", labels = "", prevYear = null;
    tl.forEach((n, i) => {
      const x = r1(pad + i * (barW + gap));
      const nb = (n.beads || []).length;
      const h = nb ? Math.max(6, r1(nb * (plotH - 22) / maxB)) : 3;
      const y = r1(plotH - h);
      const t0 = nb ? Math.floor(n.beads[0].t || 0) : 0;
      const tip = `${n.date || "undated"} · ${n.body || n.title || n.pid} — `
        + `${nb} moment${nb === 1 ? "" : "s"}`;
      marks += `<a href="${BASE}/m/${esc(n.pid)}${nb ? `#t${t0}` : ""}"`
        + ` aria-label="${esc(tip)}">`
        + `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" `
        + `fill="#052e16" fill-opacity="${nb ? ".82" : ".35"}">`
        + `<title>${esc(tip)}</title></rect></a>`
        + `<text x="${r1(x + barW / 2)}" y="${y - 5}" text-anchor="middle" `
        + `font-size="11" fill="#0f172a">${nb}</text>`;
      const yr = (n.date || "").slice(0, 4);
      labels += `<text x="${r1(x + barW / 2)}" y="${plotH + 14}" `
        + `text-anchor="middle" font-size="10" fill="#475569">${chartDay(n.date)}</text>`;
      if (yr && yr !== prevYear) {
        labels += `<text x="${r1(x + barW / 2)}" y="${plotH + 28}" `
          + `text-anchor="middle" font-size="10" fill="#475569">${esc(yr)}</text>`;
        prevYear = yr;
      }
    });
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
      + `xmlns="http://www.w3.org/2000/svg" role="group" aria-label="`
      + `${esc(it.name || b.slug)} — appearances meeting by meeting; the `
      + `table below carries the same counts">`
      + `<line x1="0" y1="${plotH + 0.5}" x2="${W}" y2="${plotH + 0.5}" `
      + `stroke="#e2e8f0"/>` + marks + labels + `</svg>`;
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
      `<div class="pb-chartwrap">${svg}</div>`,
      twin,
      `from the record’s long view —
       <a href="${BASE}/i/${esc(b.slug)}">${esc(it.name || b.slug)}</a>
       holds every appearance in place`);
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
      lensBars(lenses.map(l => ({ name: l.lens, n: l.count || 0 }))),
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
  const paperBudget = what => `<p class="pb-gone">This paper cites more of the `
    + `record than one page fetches at once — ${esc(what)} here was left `
    + `unfetched, not judged gone. The record itself holds it.</p>`;
  function paperMessage(el, html) {
    if (el) el.innerHTML = `<p class="hint">${html}</p>`;
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
      // a status region: every confirmation the sighted reader gets, a screen
      // reader hears — polite, so it never interrupts mid-sentence
      toEl.setAttribute("role", "status");
      document.body.appendChild(toEl); }
    toEl.textContent = msg; toEl.classList.add("on");
    clearTimeout(toEl._t); toEl._t = setTimeout(() => toEl.classList.remove("on"), 2600);
  }
})();
