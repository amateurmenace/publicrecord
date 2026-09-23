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

  function setMode(m) {
    if (!MODES.includes(m)) m = "preview";
    if (m !== "studio") pvPause();   // a hidden stage must not keep playing
    writeMode(m); markMode(m); updateModeButtons();
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
        <span class="cz-rord">${i + 1}</span>
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
    body.innerHTML =
        `<p class="cz-reeln"><b>${n}</b> clip${n > 1 ? "s" : ""} · ${hms(reelRuntime(clips))}${span}</p>`
      + `<div class="cz-rclips">${rows}</div>`
      + `<div class="cz-reelacts">`
      +   `<a class="btn primary" href="${esc(url)}">▶ play the reel</a>`
      +   `<button type="button" class="btn" data-cz="reelcopy">⧉ share link</button>`
      +   `<button type="button" class="btn" data-cz="preel">📰 file into your paper</button>`
      +   `<button type="button" class="btn" data-cz="reelcite">⧉ cite sheet</button>`
      +   (meets > 1 ? "" : `<button type="button" class="btn" data-cz="reeljson">⬇ reel.json</button>`)
      +   `<button type="button" class="btn" data-cz="reelclear">clear</button></div>`
      + `<p class="cz-hint">The reel lives in this browser and its link — no
         account, no server. Trims snap to the record’s own lines; filing it
         into your paper keeps a snapshot, and the tray keeps rolling.</p>`;
    if (mini) { mini.hidden = false; mini.href = url;
      mini.textContent = `▶ ${n} clip${n > 1 ? "s" : ""} · ${hms(reelRuntime(clips))}`; }
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
      if (t) t.focus();
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
    /* templates (P3): pre-shaped papers, offered only while the WHOLE draft
       is empty (no title, no blocks) — a starting shape, never a thing that
       could sit beside real work. The apply re-checks emptiness at the
       click and confirms before replacing anything (another tab may have
       typed meanwhile). Client-side only: a template just writes the draft. */
    const tplBtn = (t, label) =>
      `<button type="button" class="btn" data-cz="ptpl" data-tpl="${t}">${esc(label)}</button>`;
    const tpls = (n || p.title) ? "" :
        `<div class="cz-tpls"><span class="cz-tplhead">or start from a shape</span>`
      + tplBtn("rolls", "the roll calls, watched")
      + (ref && ref.story === "issue" ? tplBtn("issue", "this issue, watched") : "")
      + (ref && ref.story === "meeting" ? tplBtn("meeting", "this meeting, covered") : "")
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
    if (!PV.clip) return;
    const key = clipKey(PV.clip);
    const c = clips.find(x => clipKey(x) === key);
    if (c && (c.start !== PV.clip.start || c.end !== PV.clip.end)) {
      // the gate follows the new edges. A clip that has PLAYED stays played
      // (its frame rests paused at the old end — ▶ hears the new cut), a
      // paused one stays paused: nothing here plays, seeks, or repaints a
      // state the frame is not in
      PV.clip = { ...PV.clip, start: c.start, end: c.end };
      if (PV.pending && clipKey(PV.pending) === key) PV.pending = PV.clip;
      pvShow();
    }
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
        pvSend("cueVideoById", [{ videoId: PV.vid, startSeconds: Math.floor(+at.start || 0) }]);
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
      } else if (YT.pending != null) { const p = YT.pending; YT.pending = null; ytSeek(p); }
    }
    if (d.info && typeof d.info.playerState === "number" && d.info.playerState !== YT.state) {
      YT.state = d.info.playerState;
      if (YT.state === 0 || YT.state === 2 || YT.state === 5) YT.hold = false;   // seen silent
      else if (YT.state === 1) {
        // held silent and not yet seen so: a play with no reader's hand in
        // it is an autoplay landing late — silenced again
        if (YT.hold && !inFrame(YT.el)) ytSend("cmd", "pauseVideo", []);
        else {
          // a play in the page's own frame: the page is the engine — the
          // stage yields, and a reel the stage paused goes on from its clip
          YT.hold = false;
          if (PV.clip || PV.free) pvPause();
          if (REELPLAY && REELPLAY.paused) {
            REELPLAY.paused = false; REELPLAY.active = true; REELPLAY.armed = false; reelShow();
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
    if (focus) {
      // the pole rule (the panel's): a move that landed on a pole disabled
      // the arrow under the keyboard — the opposite arrow takes it; a
      // removal lands on the next row's first control, never its ✕
      const row = $(`.rt-clip[data-i="${focus.act === "row" ? focus.i : focus.i}"]`, tray);
      let t = row && (focus.act === "row" ? $(".rt-b", row) : $(`.rt-b[data-act="${focus.act}"]`, row));
      if (t && t.disabled) { const other = focus.act === "up" ? "down" : focus.act === "down" ? "up" : "";
        t = other ? $(`.rt-b[data-act="${other}"]`, row) : $(".rt-b", row); }
      if (!t) t = $(".rt-clear", tray);
      if (t && typeof t.focus === "function") t.focus();
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
          <button class="btn primary" type="button" data-rv="mine">✂ make this reel yours</button>
          <button class="btn" type="button" data-rv="cite">⧉ Copy cite sheet</button>
          ${multi ? "" : '<button class="btn" type="button" data-rv="json">⬇ reel.json</button>'}
          ${multi ? "" : `<a class="btn" href="${BASE}/m/${esc(vmeta.pid)}">open the meeting →</a>`}</div>
        <p class="rv-take" id="rvtake" hidden></p>
        <p class="hint">This reel lives in the link you followed — no account, no
          server kept it. <b>Make it yours</b> and its clips land on your own
          tray, to re-cut and re-share. ${multi
            ? "<b>This reel spans meetings</b> — it plays and cites here; rendering one video across meetings is a desk step still to come."
            : "<b>Rendering it as a video needs the desk</b> — the reel.json opens in Highlighter."}</p>`;
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
      : takeReel(mine(), $("#rvtake", cites)));
    // clicking a cite while the reel plays jumps to that clip (switching the tape
    // when the clip is from another meeting); a tape-less clip just follows its
    // deep link, and so does any click when the reel isn't playing
    $$(".reelcite", cites).forEach(a => a.addEventListener("click", ev => {
      const i = +a.dataset.i, c = REELPLAY.clips[i];
      // a reel the stage paused resumes from the clip pressed
      if (REELPLAY.paused && c.video_id) {
        ev.preventDefault(); pvPause();
        REELPLAY.paused = false; REELPLAY.active = true; REELPLAY.i = i; REELPLAY.armed = false;
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
  function startReel(clips) {
    pvPause();   // one engine seeks (specs/23 B2)
    REELPLAY.paused = false;
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
    // the reader asked the page for a tape: it is no longer held silent
    if (typeof YT !== "undefined") YT.hold = false;
    if (typeof YT !== "undefined" && YT.win && YT.ready) {
      REELPLAY.settling = true; YT.vid = vid;
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
      now.innerHTML = REELPLAY.paused && c
        ? `<b>paused for the preview</b> — tap a clip below to go on from it`
        : (done || !c)
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
  const PAPER_VS = ["1", "2", "3"];
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
  const paperV = p => p.blocks.some(b => b.layout || C2_KINDS.includes(b.kind)) ? "3"
    : p.blocks.some(b => b.kind === "note" || b.kind === "chart") ? "2" : "1";
  /* does anything actually TRAVEL — a title, or a block that survives
     portablePaper (an empty note does not). The share row, the title
     handler and the note handler all read THIS one truth, so typing across
     the empty↔live boundary repaints the row that depends on it (the fix
     re-review's catch: a gate whose truth can change under a keystroke
     needs a repaint on exactly that boundary). */
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
    return { title: p.title, blocks: p.blocks };
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
      : b.kind === "chart"
        ? "c." + b.chart + (b.slug || b.pid
            ? "." + encodeURIComponent(b.slug || b.pid) : "")
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
      if (dot < 1) continue;
      const kind = part.slice(0, dot), rest = part.slice(dot + 1);
      decodePart(kind, rest, out);
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
          // bare forms: votes, topics, framing (the whole record) — reach
          // needs its issue, so a bare reach is a mangle, not a chart
          if (chart !== "reach") out.blocks.push({ kind: "chart", chart });
        } else {
          let ref = "";
          try { ref = decodeURIComponent(rest.slice(dot2 + 1)).trim(); }
          catch { return; }
          if (!PAPER_REF.test(ref)) return;
          if (chart === "reach")
            out.blocks.push({ kind: "chart", chart: "reach", slug: ref });
          else if (chart === "framing")
            out.blocks.push({ kind: "chart", chart: "framing", pid: ref });
          // votes/topics carry no ref — a reffed one is a mangle, dropped
        }
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
  /* a note joins empty and is typed into in the panel — the draft may hold
     the blank; no traveling form does. Focus lands in the fresh textarea. */
  function addNoteToPaper(at) {
    const p = readPaper();
    const i = insertBlock(p, { kind: "note", text: "" }, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    // focus lands in the fresh field — the panel's, or the page's own (A3)
    afterAdd(i, at, { act: "note", i });
  }
  /* a chart joins as an enum + a ref; the label that rides along comes from
     the plane the open page already fetched (or one honest fetch), so the
     panel can name it without lying. The chart itself is computed at render,
     from the record — never stored numbers. */
  async function addChartToPaper(chart, refv, at) {
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
    const i = insertBlock(p, nb, at);
    if (i < 0) {
      toast("your paper is full — a paper holds " + PAPER_MAX_BLOCKS + " blocks"); return; }
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return; }
    afterAdd(i, at);
    toast("chart added — it draws from the record when your paper renders");
  }
  /* a template (P3): a pre-shaped paper the editor starts from — the same
     blocks the panel's own buttons add, written in one press, client-side
     only. The panel offers them only on an empty draft; the re-check here
     is for the draft that grew between paint and press (another tab, a
     storage race) — a template never replaces work without asking. The
     note joins empty on purpose: a template may shape a paper, but the
     editor's words are the editor's to write. */
  async function applyPaperTemplate(t, ref, where) {
    // the ref comes from the open page (the panel's offer), the front door's
    // hash, or the empty editor's starts (A1/A4); `where` = "page" hands the
    // fresh note to the on-page editor instead of the panel. Returns whether
    // the draft was written — a caller rendering the page needs to know
    // whether the old draft still stands.
    ref = ref || pageStoryRef();
    let title = "", blocks = [];
    if (t === "rolls") {
      title = "the roll calls, watched";
      blocks = [{ kind: "chart", chart: "votes", layout: "lead" },
                { kind: "chart", chart: "framing" },
                { kind: "note", text: "" }];
    } else if (t === "issue" && ref && ref.story === "issue") {
      const it = await getJSON(`${BASE}/issues/${encodeURIComponent(ref.slug)}.json`) || {};
      title = `${it.name || ref.slug}, watched`;
      blocks = [{ kind: "story", story: "issue", slug: ref.slug, layout: "lead",
                  name: it.name || "", n_meetings: it.n_meetings,
                  first_seen: it.first_seen || "", last_seen: it.last_seen || "" },
                { kind: "chart", chart: "reach", slug: ref.slug, name: it.name || "" },
                { kind: "note", text: "" }];
    } else if (t === "meeting" && ref && ref.story === "meeting") {
      const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(ref.pid)}.json`) || {};
      title = `${m.title || ref.pid}, covered`;
      blocks = [{ kind: "story", story: "meeting", pid: ref.pid, layout: "lead",
                  title: m.title || "", date: m.date || "", body: m.body || "",
                  town: m.town || "", thumb: m.thumb || "" },
                { kind: "chart", chart: "framing", pid: ref.pid, title: m.title || "" },
                { kind: "note", text: "" }];
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
    const p = normalizePaper({ title, blocks });
    if (!savePaper(p)) {
      toast("this browser blocks storage — your paper can’t be kept here"); return false; }
    // focus lands in the fresh note: the one block a template cannot write
    afterAdd(p.blocks.length - 1, where === "page" ? p.blocks.length - 1 : null,
             { act: "note", i: p.blocks.length - 1 });
    toast("a paper, pre-shaped — the note is yours to write");
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
    ED_DRAG = -1;
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
        if (hp.has("edit") || tpl) {
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
      else if (b.kind === "story" && b.story === "issue") islugs.add(b.slug);
      else if (b.kind === "chart" && b.chart === "framing" && b.pid) mpids.add(b.pid);
      else if (b.kind === "chart" && b.chart === "reach") islugs.add(b.slug);
      else if (b.kind === "quote" || b.kind === "doc") mpids.add(b.pid);
      else if (b.kind === "digest") islugs.add(b.slug);
    }
    for (const b of doc.blocks)
      if (b.kind === "reel") b.clips.forEach(c => mpids.add(c.pid));
    const wantVotes = doc.blocks.some(b => b.kind === "chart" && b.chart === "votes");
    const wantAnalytics = doc.blocks.some(b => b.kind === "chart"
      && (b.chart === "topics" || (b.chart === "framing" && !b.pid)));
    // the tape's own words, once per meeting: a reel's cuts that are not
    // moments, and every pull-quote, read their line off transcript.txt,
    // fetched beside the planes
    const linePids = [...new Set(doc.blocks.flatMap(b =>
      b.kind === "reel" ? b.clips.map(c => c.pid) : b.kind === "quote" ? [b.pid] : []))]
      .slice(0, PAPER_MAX_CLIPS);
    const [m, it, votesPlane, analytics, lineSets] = await Promise.all([
      fetchPlanes(mpids, "meetings", PAPER_MAX_BLOCKS + PAPER_MAX_CLIPS),
      fetchPlanes(islugs, "issues", PAPER_MAX_BLOCKS),
      wantVotes ? getJSON(`${BASE}/votes.json`) : Promise.resolve(null),
      wantAnalytics ? getJSON(`${BASE}/analytics.json`) : Promise.resolve(null),
      Promise.all(linePids.map(pid => segLines(pid).then(l => [pid, l]))),
    ]);
    if (gen !== PAPER_GEN) return;     // a newer render superseded this one
    const mby = m.got, iby = it.got, tried = { m: m.tried, i: it.tried };
    const lines = {}; for (const [pid, l] of lineSets) if (l === null || l.length) lines[pid] = l;
    const aux = { votes: votesPlane, analytics, lines };
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
      const rows = doc.blocks.map((b, i) => edSlot(i)
        + edRow(withLayoutHTML(renderPaperBlock(b, mby, iby, tried, aux) || paperGone("a block"), b, mby, iby), b, i, n))
        .join("") + edSlot(n);
      const keep = captureEdFocus(el) || captureEdPanel(el);
      el.innerHTML = edHead(doc) + rows;
      wireEditor(el);
      restoreEdFocus(el, PAGE_FOCUS || keep); PAGE_FOCUS = null;
      return;
    }
    const head = `<header class="phead">
        <h2 class="ptitle">${esc(doc.title || "Untitled paper")}</h2>
        <p class="pfrom">${from === "draft"
          ? "your draft — it lives in this browser. ✎ open the studio to edit it here; share it from the panel as a link or a file"
          : from === "stored"
            ? "served from the share store — content-addressed and read-only; the editor holds the original"
            : "carried whole in the link you followed — no server held it"}</p>
      </header>`;
    const blocks = paintLayouts(doc.blocks.map(b =>
      [b, renderPaperBlock(b, mby, iby, tried, aux)]).filter(x => x[1]), mby, iby);
    // a title-only paper is a sanctioned form — say what it is, not that its
    // (nonexistent) blocks were curated away
    setTimeout(pvShow, 0);     // the stage's mark on a reel row survives the repaint
    el.innerHTML = head + (blocks
      || (doc.blocks.length
        ? `<p class="hint">This paper’s blocks aren’t in this pressing of the
            record — its meetings or issues may have been curated away. The
            <a href="${BASE}/">record itself</a> is one link up.</p>`
        : `<p class="hint">This paper is a title so far — its editor hasn’t
            added stories or reels yet. The <a href="${BASE}/">record
            itself</a> is one link up.</p>`));
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
    }
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
      <figcaption>${ls.length === 1 && spk.length ? `<span class="pb-quote-spk">${esc(spk[0])}</span> · ` : ""}<a href="${cite}" data-cite="${esc(location.origin)}${cite}">${esc(m.title || b.pid)} · ${hms(b.t)}</a></figcaption></figure>`;
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
    const undated = tl.filter(n => !n.date).length;
    const nodes = tl.filter(n => n.date).sort((a, c) => (c.date > a.date ? 1 : c.date < a.date ? -1 : 0)).slice(0, b.n);
    if (!nodes.length) return paperGone(`dated appearances of ${it.name || b.slug}`);
    const rows = nodes.map(n => {
      const bead = (n.beads || [])[0];
      const at = `${BASE}/m/${esc(n.pid)}${bead ? `#t${Math.floor(bead.t)}` : ""}`;
      return `<a class="pb-dg" href="${at}" data-cite="${esc(location.origin)}${at}">
        <span class="pb-dg-d">${esc(n.date)}</span>
        <span class="pb-dg-b">${esc(n.body || n.title || n.pid)} · ${n.n || 0} moment${n.n === 1 ? "" : "s"}</span>
        ${bead ? `<span class="pb-dg-q">${esc((bead.text || "").slice(0, 140))}</span>` : ""}</a>`;
    }).join("");
    return `<section class="pb-digest">
      <div class="sectionhead"><span class="kicker">what changed — <a href="${BASE}/i/${esc(b.slug)}">${esc(it.name || b.slug)}</a>, the last ${nodes.length === 1 ? "appearance" : nodes.length + " appearances"}</span></div>
      <div class="pb-dgs">${rows}</div>
      <p class="pb-chartsrc">computed from the issue’s own timeline when this paper rendered${undated ? ` — ${undated} undated appearance${undated === 1 ? "" : "s"} not ranked here` : ""} — the full long view reads on the issue’s page</p>
    </section>`;
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
    if (b.kind === "quote") return renderQuote(b, mby, { ...aux, tried });
    if (b.kind === "doc") return renderDoc(b, mby, tried);
    if (b.kind === "digest") return renderDigest(b, iby, tried);
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
  const edHead = doc => `<header class="phead cz-edhead">
      <input class="cz-edtitle" type="text" maxlength="${PAPER_TITLE_MAX}"
        value="${esc(doc.title)}" placeholder="name your paper"
        aria-label="your paper’s title">
      <p class="pfrom">your draft, open for editing — drag a block by its
        handle or use its ↑ ↓; ✕ removes it; ＋ adds one at that spot. It lives
        in this browser; share it from the studio panel.</p>
    </header>`;
  /* an insertion point: the index a new block would land at */
  const edSlot = at => `<div class="cz-edslot" data-at="${at}">
      <button type="button" class="cz-edadd" data-czed="add" data-i="${at}"
        aria-expanded="false"
        aria-label="add here${at ? ` — after block ${at}` : " — at the top"}">＋ add here</button>
    </div>`;
  const edNote = (b, i) => `<div class="pb-note cz-ednotewrap">
      <span class="kicker">the editor’s note</span>
      <textarea class="cz-ednote" data-i="${i}" rows="4" maxlength="${PAPER_NOTE_MAX}"
        placeholder="your own words — why this matters"
        aria-label="note ${i + 1} — your own words">${esc(b.text)}</textarea>
      <div class="cz-ednote-print" aria-hidden="true">${(b.text || "").trim().split(/\n+/).map(t => `<p>${esc(t)}</p>`).join("")}</div></div>`;
  function edRow(html, b, i, n) {
    const act = (a, glyph, label, dis) =>
      `<button type="button" class="cz-edact" data-czed="${a}" data-i="${i}"
        aria-label="${esc(label)}" title="${esc(label)}"${dis ? " disabled" : ""}>${glyph}</button>`;
    return `<div class="cz-edrow" data-i="${i}" data-layout="${esc(b.layout || "")}">
      <div class="cz-edbar">
        <button type="button" class="cz-edhandle" data-i="${i}"
          aria-label="block ${i + 1} of ${n} — drag to move, or press ↑ ↓"
          title="drag to move — or press ↑ ↓">⠿</button>
        <span class="cz-edkind">${esc(blockLabel(b))}</span>
        <select class="cz-edlayout" data-i="${i}" aria-label="layout of block ${i + 1}" title="how this block sits on the page">
          <option value=""${b.layout ? "" : " selected"}>as it comes</option>
          ${PAPER_LAYOUTS.map(l => `<option value="${l}"${b.layout === l ? " selected" : ""}>${LAYOUT_LABEL[l]}</option>`).join("")}
        </select>
        <span class="cz-edacts">${act("up", "↑", `move block ${i + 1} up`, !i)}${act("down", "↓", `move block ${i + 1} down`, i >= n - 1)}${act("del", "✕", `remove block ${i + 1}`)}</span>
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
      el.innerHTML = edHead(doc) + `<p class="hint cz-edwait">opening the editor…</p>`;
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
    el.innerHTML = edHead(doc) + `<section class="cz-edteach">
        <div class="sectionhead"><span class="kicker">your paper starts empty — three ways in</span></div>
        <div class="cz-edstarts">
          ${start("rolls", "", "the roll calls, watched",
                  "every roll call on the record, dot by dot — and how the talk around them was framed")}
          ${lead && PAPER_REF.test(lead.pid || "") ? start("meeting", lead.pid, "the latest meeting, covered",
                  `${lead.title || lead.pid} — as a story, with its framing and what keeps coming back`) : ""}
          ${loud && PAPER_REF.test(loud.slug || "") ? start("issue", loud.slug, `${cut(loud.name || loud.slug, 60)}, watched`,
                  `one issue across ${loud.n_meetings || 0} meeting${loud.n_meetings === 1 ? "" : "s"}, and its reach over time`) : ""}
          <a class="cz-edstart" href="${BASE}/"><b>browse the record →</b>
            <span>every meeting and issue card carries “＋ your paper” now — read, and press it when a story is yours</span></a>
        </div>
        <p class="cz-hint">A shape is a draft, not a decision — every block can be moved or removed, and the note is yours to write. Or add the first block right here:</p>
        ${edSlot(0)}
      </section>`;
    wireEditor(el);
    // a second pass (the storage event, the panel typing) must put the
    // caret back where it was — the block path's rule, kept here too
    restoreEdFocus(el, PAGE_FOCUS || keep2); PAGE_FOCUS = null;
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
    if (ae.classList.contains("pb-pv")) return { act: "pbpv", key: ae.dataset.pvkey };
    // an open inline add survives the repaint with its query and its caret:
    // the field itself, or one of its hit buttons (focus returns to the field)
    const slot = ae.closest(".cz-edslot");
    const q = slot && $(".cz-edq", slot);
    if (q) return { act: "q", at: +slot.dataset.at, v: q.value,
                    caret: ae === q ? q.selectionStart : null };
    if (ae.dataset && ae.dataset.czed) return { act: ae.dataset.czed, i: +ae.dataset.i };
    return null;
  }
  /* an open inline add that does NOT hold focus still survives a repaint —
     as an open panel with its query, focus left where it was */
  function captureEdPanel(el) {
    const q = $(".cz-edpanel .cz-edq", el); if (!q) return null;
    return { act: "qkeep", at: +q.closest(".cz-edslot").dataset.at, v: q.value };
  }
  function restoreEdFocus(el, f) {
    if (!f) return;
    if (f.act === "q" || f.act === "qkeep") {
      const slot = $(`.cz-edslot[data-at="${f.at}"]`, el);
      if (!slot) return;
      openEdAdd(slot, { value: f.v, focus: f.act === "q", caret: f.caret });
      return;
    }
    let t = f.act === "title" ? $(".cz-edtitle", el)
      : f.act === "note" ? $(`.cz-ednote[data-i="${f.i}"]`, el)
      : f.act === "handle" ? $(`.cz-edhandle[data-i="${f.i}"]`, el)
      : f.act === "layout" ? $(`.cz-edlayout[data-i="${f.i}"]`, el)
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
    el.addEventListener("click", e => {
      const b = e.target.closest && e.target.closest("[data-czed]");
      if (!b || !el.contains(b)) return;
      const act = b.dataset.czed, i = +b.dataset.i;
      if (act === "up" || act === "down") movePaperBlock(i, act === "up" ? "pup" : "pdown", "page");
      else if (act === "del") movePaperBlock(i, "pdel", "page");
      else if (act === "add") openEdAdd(b.closest(".cz-edslot"));
      else if (act === "close") closeEdAdd(b.closest(".cz-edslot"));
      else if (act === "tpl") {
        const t = b.dataset.tpl, r = b.dataset.ref || "";
        applyPaperTemplate(t, t === "meeting" ? { story: "meeting", pid: r }
                            : t === "issue" ? { story: "issue", slug: r } : null, "page");
      } else if (act === "hit") {
        const slot = b.closest(".cz-edslot"); if (!slot) return;
        const at = +slot.dataset.at, kind = b.dataset.kind, ref = b.dataset.ref || "";
        if (kind === "m") addStoryRef({ story: "meeting", pid: ref }, at);
        else if (kind === "i") addStoryRef({ story: "issue", slug: ref }, at);
        else if (kind === "cm") addChartToPaper("framing", ref, at);
        else if (kind === "ci") addChartToPaper("reach", ref, at);
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
        if (slot && $(".cz-edpanel", slot)) { e.preventDefault(); closeEdAdd(slot); }
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
        if (!savePaper(d)) return;
        retireShortOut(); refreshPaperSummary();
        document.title = `${d.title || "A paper"} — publicrecord.studio`;
      } else if (t.classList.contains("cz-ednote")) {
        const d = readPaper(), i = +t.dataset.i;
        if (!(d.blocks[i] && d.blocks[i].kind === "note")) return;
        d.blocks[i].text = noteText(t.value);
        if (!savePaper(d)) return;
        retireShortOut(); refreshPaperSummary();
      } else if (t.classList.contains("cz-edq")) {
        edSearch(t.closest(".cz-edslot"));
      }
    });
    // the layout select (C1): a change writes the enum and repaints both
    // surfaces; focus returns to the same select on the same block
    el.addEventListener("change", e => {
      const t = e.target; if (!t || !t.classList || !t.classList.contains("cz-edlayout")) return;
      setBlockLayout(+t.dataset.i, t.value);
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
  const edClearDrop = el => $$(".cz-drop-before, .cz-drop-after, .cz-drop-here, .cz-dragging", el)
    .forEach(x => x.classList.remove("cz-drop-before", "cz-drop-after", "cz-drop-here", "cz-dragging"));
  function wireEditorDnD(el) {
    el.addEventListener("pointerdown", e => {
      const h = e.target.closest && e.target.closest(".cz-edhandle");
      const row = h && h.closest(".cz-edrow");
      if (row) row.draggable = true;
    });
    el.addEventListener("pointerup", () => $$(".cz-edrow[draggable]", el).forEach(r => r.draggable = false));
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
      if (ED_DRAG < 0) return;
      const row = e.target.closest && e.target.closest(".cz-edrow");
      const slot = e.target.closest && e.target.closest(".cz-edslot");
      if (!row && !slot) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch { /* ditto */ }
      $$(".cz-drop-before, .cz-drop-after, .cz-drop-here", el)
        .forEach(x => x.classList.remove("cz-drop-before", "cz-drop-after", "cz-drop-here"));
      if (slot) slot.classList.add("cz-drop-here");
      else { const r = row.getBoundingClientRect();
        row.classList.add(e.clientY < r.top + r.height / 2 ? "cz-drop-before" : "cz-drop-after"); }
    });
    el.addEventListener("drop", e => {
      if (ED_DRAG < 0) return;
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
      const from = ED_DRAG; ED_DRAG = -1;
      edClearDrop(el);
      movePaperBlockTo(from, to);
    });
    el.addEventListener("dragend", () => { ED_DRAG = -1; edClearDrop(el);
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
    const clips = readReel(REEL_KEY);
    const quick = (kind, ref, label) =>
      `<button type="button" class="btn" data-czed="hit" data-kind="${kind}" data-ref="${esc(ref)}">${esc(label)}</button>`;
    const panel = document.createElement("div"); panel.className = "cz-edpanel";
    // the hit list is NOT a live region: ten cards re-announced per
    // keystroke would drown the field. One short status line speaks the
    // count instead; the list is there to be walked.
    panel.innerHTML = `<label class="cz-edqlabel">find a meeting or an issue
        <input class="cz-edq" type="search" autocomplete="off"
          placeholder="a body, a month, an issue’s name…"></label>
      <p class="cz-edcount" role="status"></p>
      <div class="cz-edhits"></div>
      <div class="cz-edquick">
        ${quick("note", "", "＋ a note")}
        ${clips.length ? quick("reel", "", `＋ your reel (${clips.length} clip${clips.length > 1 ? "s" : ""})`) : ""}
        ${quick("chart", "votes", "▤ votes over time")}
        ${quick("chart", "framing", "▤ the record’s framing")}
        ${quick("chart", "topics", "▤ recurring topics")}
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
      return new Set(sh && sh[t] ? sh[t] : []);
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
    const m = await getJSON(`${BASE}/meetings/${encodeURIComponent(pid)}.json`);
    if (!btn.isConnected) return;
    const span = document.createElement("span"); span.className = "cz-eddocs";
    const docs = (m && Array.isArray(m.documents)) ? m.documents : [];
    // a plane that did not load is a different fact from a meeting that
    // filed nothing — and either way the keyboard lands on something
    span.innerHTML = !m
      ? `<span class="cz-edhit-in" tabindex="-1">this meeting’s plane didn’t load — try again</span>`
      : docs.length
      ? docs.slice(0, 6).map(d => `<button type="button" class="btn" data-czed="hit" data-kind="dd"
          data-ref="${esc(pid)}~${esc(d.doc_id)}" aria-label="add the ${esc(d.kind || "document")} “${esc(d.title || d.doc_id)}”">📄 ${esc(d.kind || "document")}${d.title ? ` — ${esc(cut(d.title, 28))}` : ""}</button>`).join("")
      : `<span class="cz-edhit-in" tabindex="-1">no documents filed for this meeting</span>`;
    btn.replaceWith(span);
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
    const is = lexRank(terms, idx.issues).slice(0, 5);
    const ms = lexRank(terms, idx.meetings).slice(0, 5);
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
      ? `${n(is.length, "issue", "issues")} · ${n(ms.length, "meeting", "meetings")}`
        + (ls.length ? ` · ${n(ls.length, "line", "lines")}` : "") + (terms.length ? " match" : "") + dark
      : `no match${dark}`;
    if (count) count.textContent = countLine([]);
    const hit = h => {
      const ref = h.kind === "m" ? { story: "meeting", pid: h.ref } : { story: "issue", slug: h.ref };
      const on = storyIndex(p, ref) >= 0;
      return `<div class="cz-edhit">
        <span class="cz-edhit-t"><b>${esc(h.title)}</b><span class="cz-edhit-m">${esc(h.meta)}</span></span>
        <span class="cz-edhit-a">${on
          ? `<span class="cz-edhit-in">✓ in your paper</span>`
          : `<button type="button" class="btn" data-czed="hit" data-kind="${h.kind}" data-ref="${esc(h.ref)}"
               aria-label="add “${esc(h.title)}” as a story">＋ story</button>`}
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
    if (!terms.length) { if (!ms.length && !is.length) box.innerHTML = nothing(false); return; }
    if (!ms.length && !is.length) box.innerHTML = `<p class="cz-hint cz-edlines-wait">searching the tape’s own lines…</p>`;
    const ls = await linesSearch(terms, q.value);
    const box2 = $(".cz-edhits", slot);
    if (slot._edgen !== gen || !box2) return;   // a newer query painted, or the panel closed
    const wait = $(".cz-edlines-wait", box2); if (wait) wait.remove();
    if (count) count.textContent = countLine(ls);
    if (ls.length) box2.innerHTML += `<span class="cz-edgroup">lines of the tape</span>${ls.map(lineHit).join("")}`;
    else if (!ms.length && !is.length) box2.innerHTML = nothing(true);
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
        // the hit is an anchor, so its tick is a SIBLING in a wrapper —
        // a button inside a link is a keyboard trap (specs/22 §5.1)
        return `<div class="swrap"><a class="sresult" href="${BASE}/m/${encodeURIComponent(h.meeting_id)}#t${Math.floor(h.t || 0)}">
          <span class="ts">${hms(h.t)}</span>${why(h.why)}${mark(h.text || "", terms)}
          <span class="smeta">${esc(bits.filter(Boolean).join(" · "))}${h.speaker ? " · " + esc(h.speaker) : ""}</span></a>${searchTick(h.meeting_id, h.t, h.text, h.title, h.body, h.town, h.date)}</div>`;
      }).join("");
    paintCutTicks();
    return true;
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
        return `<div class="swrap"><a class="sresult" data-sid="${id}" href="${BASE}/m/${m.pid}#t${Math.floor(t)}">
          <span class="ts">${hms(t)}</span>${mark(text, terms)}
          <span class="smeta">${esc([m.title, m.body, SCOPE.town ? "" : m.town, m.date].filter(Boolean).join(" · "))}${spk ? " · " + esc(spk) : ""}</span>${peek(segs, id, mi)}</a>${searchTick(m.pid, t, text, m.title, m.body, m.town, m.date)}</div>`;
      }).join("");
    paintCutTicks();
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
})();
