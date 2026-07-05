// ==UserScript==
// @name         SES Activity - Who's Here (scan kiosk sidebar)
// @namespace    seslogin.userscripts
// @version      0.12.2
// @description  Adds a compact live "who's currently signed in" sidebar to the SES Activity scan kiosk so the last person out can see who forgot to sign out, with a per-person Sign out button that types their member number into the kiosk box and submits. Event-driven refresh with a slow background safety poll - very light on the server.
// @author       seslogin-tools contributors
// @homepageURL  https://github.com/jacksgithubacct/seslogin-tools
// @supportURL   https://github.com/jacksgithubacct/seslogin-tools/issues
// @downloadURL  https://github.com/jacksgithubacct/seslogin-tools/raw/refs/heads/main/whos-here.user.js
// @updateURL    https://github.com/jacksgithubacct/seslogin-tools/raw/refs/heads/main/whos-here.user.js
// @match        https://seslogin.com/scan*
// @match        https://seslogin.com/kiosk*
// @match        https://test.seslogin.com/scan*
// @match        https://test.seslogin.com/kiosk*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * Design notes (for a future upstream PR):
 *
 * - The scan kiosk only runs scanRegister2 / scanSignOut. The live list is
 *   the Status kiosk's `StatusQuery` = location.periods(onlyActive:true).
 *   This script just runs that same query and renders it on the scan screen.
 *
 * - Auth: the scan kiosk session token lives in
 *   localStorage["kiosk_default"].scanAuthToken. It auto-renews (~2 week
 *   rolling) while the kiosk is open, so this script needs zero token
 *   handling of its own. The scan kiosk stores NO locationId - location
 *   is bound to the session server-side - so we use the no-arg `session`
 *   query, which the scan token is authorised for, and read
 *   session.location.periods(onlyActive:true). Confirmed working with a
 *   live scan kiosk token.
 *
 * - Fallback token (Tampermonkey menu) is optional/defensive only; the
 *   normal path needs nothing configured.
 *
 * - No React hooks: minified internals change every build. We only read
 *   localStorage + call GraphQL + inject our own fixed element.
 *
 * - Barcode scanners auto-type into the scan field. The panel never takes
 *   focus and adds no focusable elements, so it cannot disrupt scanning.
 */

(function () {
  "use strict";

  // Endpoint auto-selects by host so this works on prod and on the
  // test bake env (test.seslogin.com), each hitting its own API. The
  // kiosk token in localStorage is per-origin, so it always matches.
  const GQL_PROD =
    "https://zba3de77v7oiwjwfzkyilnwgyu0lpddq.lambda-url.ap-southeast-2.on.aws/";
  const GQL_TEST =
    "https://rkrle4ilsgx6btclhy66ziufgu0yjgyr.lambda-url.ap-southeast-2.on.aws/";
  const gqlUrl = () =>
    location.hostname === "test.seslogin.com" ? GQL_TEST : GQL_PROD;
  // Adaptive polling for low server load without missing changes:
  //  - ACTIVE_MS while there's recent kiosk activity (people signing
  //    in/out -> exactly when the list matters and changes fast).
  //  - IDLE_MS once the kiosk has had no screen activity for
  //    ACTIVE_WINDOW_MS (nobody around -> barely any traffic 24/7).
  // Any screen transition (sign in/out flow) re-arms the active window,
  // so during a muster it stays fresh, then relaxes when the unit's
  // empty. Far lighter than a live Status kiosk, still reliable.
  const ACTIVE_MS = 15000; // poll cadence while active
  const IDLE_MS = 300000; // poll cadence when idle (5 min)
  const ACTIVE_WINDOW_MS = 180000; // stay "active" 3 min after last activity
  const TICK_MS = 30000; // re-render durations locally (no API call)
  const PANEL_W = 300;
  const HEAD_H = 73; // matches the SES Activity orange header height (px)

  // Duration-based conditional colouring. A normal muster/training night
  // is a few hours; a very long sign-in usually means someone forgot to
  // sign out. Tune these (minutes) to your unit's nights.
  const WARN_MINS = 240; // 4h  -> amber
  const ALERT_MINS = 360; // 6h -> red (likely forgot to sign out)
  const COL_OK = "#2e7d32";
  const COL_WARN = "#ef6a00";
  const COL_ALERT = "#c62828";

  GM_registerMenuCommand("Set Who's-Here fallback token", () => {
    const t = prompt(
      "Paste a Status-scoped kiosk/bearer token to use if the scan token is not authorised (leave blank to clear):"
    );
    GM_setValue("fallbackToken", (t || "").trim());
    location.reload();
  });

  function getToken() {
    const fb = (GM_getValue("fallbackToken", "") || "").trim();
    if (fb) return fb;
    try {
      return (
        JSON.parse(localStorage.getItem("kiosk_default") || "{}")
          .scanAuthToken || null
      );
    } catch (e) {
      return null;
    }
  }

  async function fetchActive() {
    const token = getToken();
    if (!token) throw new Error("No kiosk token in localStorage");
    // No-arg `session` resolves the current kiosk's own session/location
    // from the token - the scan kiosk stores no locationId.
    const query =
      "query{session{location{periods(onlyActive:true){edges{node{startTime person{firstName lastName memberNumber}}}}}}}";
    const res = await fetch(gqlUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ query }),
    });
    const j = await res.json();
    if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
    const edges =
      (j.data &&
        j.data.session &&
        j.data.session.location &&
        j.data.session.location.periods.edges) ||
      [];
    return edges.map((e) => e.node).sort((a, b) => a.startTime - b.startTime);
  }

  function durMins(startSec) {
    return Math.max(0, Math.floor((Date.now() / 1000 - startSec) / 60));
  }

  function fmtDur(startSec) {
    const tot = durMins(startSec);
    const h = Math.floor(tot / 60);
    const m = tot % 60;
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  function durColour(startSec) {
    const mins = durMins(startSec);
    if (mins >= ALERT_MINS) return COL_ALERT;
    if (mins >= WARN_MINS) return COL_WARN;
    return COL_OK;
  }

  let panel, listEl, countEl, lastNodes = [], errMsg = null;

  function ensurePanel() {
    if (panel) return;
    const style = document.createElement("style");
    style.textContent =
      "#wh-panel{position:fixed;top:0;left:0;width:" +
      PANEL_W +
      "px;height:100vh;background:#fff;border-right:3px solid #e8772e;" +
      "box-shadow:2px 0 8px rgba(0,0,0,.12);z-index:2147483646;display:flex;" +
      "flex-direction:column;font-family:system-ui,Arial,sans-serif;color:#222}" +
      "#wh-head{height:" +
      HEAD_H +
      "px;box-sizing:border-box;display:flex;align-items:center;" +
      "background:#222;color:#fff;padding:0 20px;font-size:18px;font-weight:700}" +
      "#wh-list{flex:1;overflow-y:auto;margin:0;padding:0;list-style:none}" +
      "#wh-list li{padding:7px 12px;border-bottom:1px solid #eee;display:flex;" +
      "align-items:center;gap:8px}" +
      "#wh-list .nm{flex:1;min-width:0;font-weight:600;font-size:14px;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#wh-list .du{flex:none;font-size:13px;white-space:nowrap;font-weight:600;" +
      "min-width:42px;text-align:right}" +
      "#wh-list .wh-so{flex:none;appearance:none;border:0;border-radius:6px;" +
      "background:#e8772e;color:#fff;font:600 12px/1 system-ui,Arial,sans-serif;" +
      "padding:7px 9px;cursor:pointer;white-space:nowrap}" +
      "#wh-list .wh-so:active{background:#c75f1c}" +
      "#wh-empty{padding:16px;color:#888}" +
      "#wh-err{padding:10px 16px;background:#fdecea;color:#a3261c;font-size:12px}" +
      // Hidden by default; only the dashboard view adds body.wh-active,
      // so the panel and its layout shift never block the sign-out /
      // category screens.
      "#wh-panel{display:none}" +
      "body.wh-active #wh-panel{display:flex}" +
      "body.wh-active{margin-left:" +
      PANEL_W +
      "px!important}";
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "wh-panel";
    panel.innerHTML =
      '<div id="wh-head"><span id="wh-count">…</span></div>' +
      '<ul id="wh-list"></ul>';
    document.body.appendChild(panel);
    listEl = panel.querySelector("#wh-list");
    countEl = panel.querySelector("#wh-count");

    // Delegated click: a row's "Sign out" button just types that
    // member's number into the kiosk's SES ID box and submits, exactly
    // as if they had scanned. The normal on-screen flow (category tile
    // etc.) is then completed by the person as usual. This is a
    // convenience for the last person out to sign out anyone who forgot.
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".wh-so");
      if (!btn) return;
      const mn = btn.getAttribute("data-mn");
      if (mn) submitMemberNumber(mn);
    });
  }

  function submitMemberNumber(mn) {
    const root = document.getElementById("root") || document.body;
    let input = null;
    for (const el of root.querySelectorAll("input")) {
      const ty = (el.type || "text").toLowerCase();
      if (/button|submit|checkbox|radio|hidden|file/.test(ty)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && el.offsetParent !== null) {
        input = el;
        break;
      }
    }
    if (!input) {
      console.warn("[whos-here] SES ID input not found; cannot sign out");
      return;
    }
    // React controlled input: set value via the native setter then fire
    // an input event so React's state updates.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(input, mn);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Submit the same way Enter / the arrow button does.
    if (input.form && input.form.requestSubmit) {
      input.form.requestSubmit();
    } else {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        })
      );
      const sb = root.querySelector(
        'input[type=submit],button[type=submit],form button'
      );
      if (sb) sb.click();
    }
  }

  // The scan kiosk is a single-URL SPA. Only the entry/dashboard view
  // should show the sidebar - on the member's category / sign-out
  // screens it would block the tiles.
  //
  // The scan app pre-renders the category tiles AND the SES ID input
  // into the DOM on every view, so neither text nor input presence can
  // distinguish screens. The reliable signal is the header breadcrumb:
  //   entry screen:  "Unit > kiosk scan"           (2 segments)
  //   sign in/out:   "Unit > kiosk scan > <Name>"  (3 segments, member)
  // We find the orange header bar, count its ">"-separated segments,
  // and only treat 2-or-fewer (no member selected) as the dashboard.
  function findHeader() {
    for (const el of document.querySelectorAll("div,header")) {
      if (el.id === "wh-panel" || el.closest("#wh-panel")) continue;
      const s = getComputedStyle(el);
      const m = s.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const r = +m[1],
        g = +m[2],
        b = +m[3];
      const rect = el.getBoundingClientRect();
      if (
        r > 225 &&
        g > 95 &&
        g < 145 &&
        b < 75 &&
        rect.width > window.innerWidth * 0.5 &&
        rect.top <= 5 &&
        rect.height > 35 &&
        rect.height < 170
      )
        return el;
    }
    return null;
  }

  function isDashboard() {
    const h = findHeader();
    if (!h) return false; // can't tell -> stay hidden, never block sign-out
    const segs = (h.innerText || "")
      .split(">")
      .map((x) => x.trim())
      .filter(Boolean);
    return segs.length <= 2;
  }

  // When the kiosk returns to the entry screen after a sign in/out, a
  // single immediate fetch can race the backend (the period may not be
  // committed yet). With the slow safety poll that would leave the
  // change invisible for minutes. So fire a short burst of refreshes -
  // enough to reliably catch the just-completed change, then back to
  // idle. Still tied to an actual screen event, so it stays light.
  const BURST_MS = [0, 2000, 5000, 10000];
  let burstTimers = [];
  function burstRefresh() {
    burstTimers.forEach(clearTimeout);
    burstTimers = BURST_MS.map((d) => setTimeout(poll, d));
  }

  // Any screen transition = someone is using the kiosk -> keep polling
  // fast for a while.
  let activeUntil = Date.now() + ACTIVE_WINDOW_MS;
  function markActivity() {
    activeUntil = Date.now() + ACTIVE_WINDOW_MS;
  }

  let prevDash = false;
  function applyVisibility() {
    const d = isDashboard();
    document.body.classList.toggle("wh-active", d);
    if (d !== prevDash) markActivity(); // a view changed
    if (d && !prevDash) {
      prevDash = d;
      burstRefresh();
      return;
    }
    prevDash = d;
  }

  function render() {
    ensurePanel();
    applyVisibility();
    const n = lastNodes.length;
    countEl.textContent =
      n + " member" + (n === 1 ? "" : "s") + " signed in";
    let html = "";
    if (errMsg) {
      html +=
        '<li id="wh-err">Live list unavailable: ' +
        errMsg.replace(/</g, "&lt;") +
        "</li>";
    }
    if (n === 0 && !errMsg) {
      html += '<li id="wh-empty">Nobody is currently signed in.</li>';
    }
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    for (const node of lastNodes) {
      const p = node.person || {};
      const nm = ((p.firstName || "") + " " + (p.lastName || "")).trim();
      const mn = (p.memberNumber || "").trim();
      html +=
        "<li><span class='nm'>" +
        esc(nm) +
        "</span><span class='du' style='color:" +
        durColour(node.startTime) +
        "'>" +
        fmtDur(node.startTime) +
        "</span>" +
        (mn
          ? "<button type='button' class='wh-so' data-mn='" +
            esc(mn) +
            "'>Sign out</button>"
          : "") +
        "</li>";
    }
    listEl.innerHTML = html;
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    // Don't hit the API while the panel is hidden (sign-out / category /
    // other screens). applyVisibility() fires an immediate poll the
    // instant we return to the entry screen, so nothing is missed.
    if (!isDashboard()) return;
    polling = true;
    try {
      lastNodes = await fetchActive();
      errMsg = null;
    } catch (e) {
      errMsg = String(e.message || e);
      console.warn("[whos-here]", e);
    } finally {
      polling = false;
    }
    render();
  }

  ensurePanel();
  render(); // applyVisibility() fires the first poll if we start on entry

  // Adaptive scheduler: poll fast while active, slow when idle.
  (function scheduleNext() {
    const delay = Date.now() < activeUntil ? ACTIVE_MS : IDLE_MS;
    setTimeout(async () => {
      await poll();
      scheduleNext();
    }, delay);
  })();
  setInterval(render, TICK_MS); // keep durations fresh between polls

  // SPA view changes don't reload the page - re-evaluate visibility on
  // any DOM change (debounced) so the sidebar appears/hides instantly.
  let visTimer = null;
  new MutationObserver(() => {
    clearTimeout(visTimer);
    visTimer = setTimeout(applyVisibility, 80);
  }).observe(document.body, { childList: true, subtree: true });
})();
