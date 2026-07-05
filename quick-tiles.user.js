// ==UserScript==
// @name         SES Activity - Quick Category Tiles
// @namespace    seslogin.userscripts
// @version      0.8.2
// @description  Adds a row of quick-select tiles at the bottom of the SES Activity category screen for the unit's most recently used categories, so common picks skip the parent/child drill-down. Drives the normal tile flow (no direct mutation); you still confirm with Submit as usual.
// @author       seslogin-tools contributors
// @homepageURL  https://github.com/jacksgithubacct/seslogin-tools
// @supportURL   https://github.com/jacksgithubacct/seslogin-tools/issues
// @downloadURL  https://github.com/jacksgithubacct/seslogin-tools/raw/refs/heads/main/quick-tiles.user.js
// @updateURL    https://github.com/jacksgithubacct/seslogin-tools/raw/refs/heads/main/quick-tiles.user.js
// @match        https://seslogin.com/scan*
// @match        https://seslogin.com/kiosk*
// @match        https://test.seslogin.com/scan*
// @match        https://test.seslogin.com/kiosk*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * How it works
 *
 * - Categories are stored as full paths joined by " - " (e.g.
 *   "Trainer - Fit for Role", "Other - Maintenance - Equipment"). The
 *   parent tiles are a fixed known set; we cache them whenever the
 *   parent view is on screen, then split a recent category name into
 *   parent + child by longest-parent-prefix match. This disambiguates
 *   e.g. "Trainer - Fit for Role" vs "Training - Fit for Role" - the
 *   tile shows the child with the parent labelled beneath it.
 *
 * - "Recent" = the unit's most recently used distinct categories, read
 *   from the same GraphQL the kiosk already uses (periods, scan token).
 *   Fetched once when the category screen opens (cached per session);
 *   very light on the server.
 *
 * - Clicking a quick tile replicates the manual flow: ensure the parent
 *   grid is shown (press Back if in a child grid), click the matching
 *   parent tile, wait for the child grid, click the matching child
 *   tile. The app then shows its normal confirmation screen and the
 *   member presses Submit as usual. No mutation is called directly.
 *
 * - Shows ONLY on the category screen (a visible "Categories" heading
 *   while a member is mid sign-in/out). Never on the entry screen or
 *   the confirmation screen.
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
  const MAX_TILES = 6;
  // Quick tiles are for the majority of members. Trainers/assessors use
  // the full flow, so skip recent categories under these parents.
  const EXCLUDE_PARENTS = ["Trainer", "Assessor", "Workshop - Trainer"];
  const WINDOW_DAYS = 60; // look back this far for "recently used"
  const FETCH_FIRST = 50; // newest N periods in that window (1 request)
  const CACHE_MS = 300000; // re-fetch recent list at most every 5 min

  function token() {
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

  // --- recent categories ------------------------------------------------
  // Refresh policy: re-fetch whenever a new member flow has started
  // (the kiosk passed through the entry screen since the last fetch),
  // so each member sees an up-to-date list including the prior member's
  // pick. Within one member's flow (parent <-> child toggling, which
  // never returns to entry) the cached list is reused, plus CACHE_MS as
  // a hard safety ceiling. This is event-gated - the category screen
  // only appears during an actual sign-in/out - so it's very light.
  let recentCache = { at: 0, list: [] };
  let sawEntry = true; // start true so the first open fetches

  async function fetchRecent() {
    if (
      !sawEntry &&
      Date.now() - recentCache.at < CACHE_MS &&
      recentCache.list.length
    )
      return recentCache.list;
    const t = token();
    if (!t) return recentCache.list;
    // The periods connection's default order is NOT recency. Within an
    // explicit startTime window it is newest-first, so first:N gives the
    // most recently *started* N in one request - which still covers
    // tonight's sign-outs (they signed in earlier today). We then rank
    // by most recent ACTIVITY = max(startTime, endTime): a member who
    // just signed out of an activity makes that category #1 immediately
    // for the next people signing out of the same thing.
    const now = Math.floor(Date.now() / 1000);
    const start = now - WINDOW_DAYS * 86400;
    const q =
      "query{session{location{periods(startTime:" +
      start +
      ",endTime:" +
      (now + 86400) +
      ",first:" +
      FETCH_FIRST +
      "){edges{node{startTime endTime category{id name}}}}}}}";
    try {
      const res = await fetch(gqlUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + t,
        },
        body: JSON.stringify({ query: q }),
      });
      const j = await res.json();
      if (j.errors) throw new Error(j.errors[0].message);
      const edges =
        (j.data &&
          j.data.session &&
          j.data.session.location &&
          j.data.session.location.periods.edges) ||
        [];
      // Most recent real activity. endTime can be set in the FUTURE
      // (scheduled / auto end), so only count it when it's in the past
      // (a genuine completed sign-out ~ the click time); otherwise rank
      // by sign-in time. This makes "just signed out of X" put X first
      // for the next people signing out of the same thing.
      const rec = (n) => {
        const e = n.endTime && n.endTime <= now ? n.endTime : 0;
        return Math.max(n.startTime, e);
      };
      const nodes = edges
        .map((e) => e.node)
        .sort((a, b) => rec(b) - rec(a));
      const excluded = (name) =>
        EXCLUDE_PARENTS.some(
          (p) => name === p || name.startsWith(p + " - ")
        );
      const seen = new Set();
      const list = [];
      for (const n of nodes) {
        const c = n.category;
        if (c && c.name && !seen.has(c.name) && !excluded(c.name)) {
          seen.add(c.name);
          list.push(c.name);
          if (list.length >= MAX_TILES) break;
        }
      }
      if (list.length) {
        recentCache = { at: Date.now(), list };
        sawEntry = false; // fresh - reuse until the next member
      }
    } catch (e) {
      console.warn("[quick-tiles] recent fetch failed:", e);
    }
    return recentCache.list;
  }

  // --- screen / tile helpers -------------------------------------------
  function root() {
    return document.getElementById("root") || document.body;
  }

  // A tile/category button: a button that isn't one of the controls.
  function isControl(txt) {
    return /^(cancel sign\s?out|back|edit|submit|←|→|‹|›)$/i.test(txt);
  }

  function categoryButtons() {
    return [...root().querySelectorAll("button")].filter((b) => {
      if (b.closest("#qt-bar")) return false;
      if (b.offsetParent === null) return false;
      const t = (b.innerText || "").trim();
      return t && !isControl(t);
    });
  }

  // The app pre-renders everything into the DOM, so text/heading/Submit
  // presence cannot tell screens apart. Two signals that DO work:
  //  - header breadcrumb depth: entry = 2 segments ("Unit > kiosk"),
  //    member mid sign-in/out = 3 ("Unit > kiosk > Member").
  //  - a visible "Back" button: present only in the child grid and the
  //    confirmation screen, NOT on the parent grid.
  // So the parent category grid (the only screen we want) is uniquely:
  //   3 segments AND no Back button.
  function headerSegments() {
    for (const el of document.querySelectorAll("div,header")) {
      if (el.closest("#qt-bar") || el.closest("#wh-panel")) continue;
      const s = getComputedStyle(el);
      const m = s.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const r = +m[1],
        g = +m[2],
        b = +m[3];
      const rc = el.getBoundingClientRect();
      if (
        r > 225 &&
        g > 95 &&
        g < 145 &&
        b < 75 &&
        rc.width > window.innerWidth * 0.5 &&
        rc.top <= 5 &&
        rc.height > 35 &&
        rc.height < 170
      )
        return el.innerText.split(">").map((x) => x.trim()).filter(Boolean)
          .length;
    }
    return 0;
  }

  function backButton() {
    return [...root().querySelectorAll("button")].find(
      (b) =>
        b.offsetParent !== null && /^back$/i.test((b.innerText || "").trim())
    );
  }

  function onParentGrid() {
    return headerSegments() === 3 && !backButton();
  }

  // Only the parent grid - never entry (2 segs), child grid or
  // confirmation (both have Back).
  function onCategoryScreen() {
    return onParentGrid();
  }

  // Known parent labels, learned from the parent grid and remembered.
  function parentSet() {
    let cached = [];
    try {
      cached = JSON.parse(GM_getValue("parents", "[]"));
    } catch (e) {}
    if (onParentGrid()) {
      const live = categoryButtons().map((b) =>
        (b.innerText || "").trim().replace(/\s+/g, " ")
      );
      if (live.length) {
        cached = live;
        GM_setValue("parents", JSON.stringify(live));
      }
    }
    return cached;
  }

  // Split a full category name into [parent, child] using the longest
  // known parent label that prefixes it.
  function split(name) {
    const parents = parentSet()
      .slice()
      .sort((a, b) => b.length - a.length);
    for (const p of parents) {
      if (name === p) return [p, p];
      if (name.startsWith(p + " - ")) return [p, name.slice(p.length + 3)];
    }
    // Unknown parent set yet: best-effort - first segment as parent.
    const i = name.indexOf(" - ");
    return i < 0 ? ["", name] : [name.slice(0, i), name.slice(i + 3)];
  }

  function clickByText(txt) {
    const b = [...root().querySelectorAll("button")].find(
      (x) =>
        x.offsetParent !== null &&
        (x.innerText || "").trim().replace(/\s+/g, " ") === txt
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }

  function waitFor(predicate, timeout = 2500) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        if (predicate()) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(poll, 60);
      })();
    });
  }

  async function pick(fullName) {
    const [parent, child] = split(fullName);
    // Make sure we're on the parent grid.
    const back = backButton();
    if (back) {
      back.click();
      await waitFor(onParentGrid);
    }
    if (parent && !clickByText(parent)) {
      console.warn("[quick-tiles] parent tile not found:", parent);
      return;
    }
    // Wait for the child grid, then click the child.
    await waitFor(() =>
      [...root().querySelectorAll("button")].some(
        (b) =>
          b.offsetParent !== null &&
          (b.innerText || "").trim().replace(/\s+/g, " ") === child
      )
    );
    if (!clickByText(child)) {
      console.warn("[quick-tiles] child tile not found:", child);
    }
    // The app now shows its confirmation screen; the member presses
    // Submit as usual.
  }

  // --- UI ---------------------------------------------------------------
  // Rendered as a native-looking section INSIDE the category view, right
  // after the real tile grid. By reusing the app's own `ul.categories`
  // markup/classes the tiles inherit all native styling automatically -
  // including the "Small categories" option - so it looks built-in
  // rather than a bolted-on bar.

  function styleOnce() {
    if (document.getElementById("qt-style")) return;
    const s = document.createElement("style");
    s.id = "qt-style";
    s.textContent =
      "#qt-sec{margin:10px auto 0;padding-top:10px;" +
      "border-top:2px solid #ddd;text-align:center}" +
      "#qt-sec .qt-h{font-family:inherit;font-size:22px;color:#555;" +
      "margin:0 0 4px}" +
      // .qt-t buttons live inside ul.categories so they inherit the
      // native tile look; we only style the two text lines + ensure the
      // box height matches the icon'd native tiles.
      "#qt-list .qt-c{display:block;font-weight:700;line-height:1.15}" +
      "#qt-list .qt-p{display:block;font-size:.7em;color:#666;" +
      "font-weight:400;margin-top:5px}";
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  // Delegated once on document - survives the view being re-rendered.
  let clickBound = false;
  function bindClick() {
    if (clickBound) return;
    clickBound = true;
    document.addEventListener("click", (e) => {
      const t = e.target.closest("#qt-list .qt-t[data-name]");
      if (t) pick(t.getAttribute("data-name"));
    });
  }

  function nativeList() {
    const v = root().querySelector(".view.categoriesview");
    if (!v) return null;
    return v.querySelector("ul.categories:not(#qt-list)");
  }

  // Category icons aren't in GraphQL - each native tile just has an
  // <img src="/image/categories-cas/<hash>.png">. We harvest label->src
  // from whatever grid is on screen (parent or child) and remember it,
  // so quick tiles can reuse the real artwork. The cache fills as the
  // app's grids are seen during normal use.
  let iconMap = {};
  try {
    iconMap = JSON.parse(GM_getValue("iconmap", "{}"));
  } catch (e) {}

  function harvestIcons() {
    let changed = false;
    for (const b of root().querySelectorAll(
      "ul.categories:not(#qt-list) li button"
    )) {
      if (b.offsetParent === null) continue;
      const label = (b.innerText || "").trim().replace(/\s+/g, " ");
      const img = b.querySelector("img");
      const src = img && img.getAttribute("src");
      if (label && src && iconMap[label] !== src) {
        iconMap[label] = src;
        changed = true;
      }
    }
    if (changed) GM_setValue("iconmap", JSON.stringify(iconMap));
  }

  function render(list) {
    styleOnce();
    bindClick();
    const ul = nativeList();
    if (!ul || !list.length) {
      document.getElementById("qt-sec")?.remove();
      return;
    }
    // Match the native tile box height (with/without "Small categories").
    const nb = ul.querySelector("li button");
    const minH = nb ? Math.round(nb.getBoundingClientRect().height) : 120;
    const rows = list.map((name) => {
      const [p, c] = split(name);
      const icon = iconMap[c] || iconMap[p] || "";
      return { name, p, c, icon };
    });
    const sig =
      rows.map((r) => r.name + ":" + (r.icon ? 1 : 0)).join("|") + "@" + minH;

    let sec = document.getElementById("qt-sec");
    if (sec && sec.dataset.sig === sig && sec.previousElementSibling === ul)
      return; // already correct - don't thrash (avoids observer loop)

    sec?.remove();
    sec = document.createElement("div");
    sec.id = "qt-sec";
    sec.dataset.sig = sig;
    let tiles = "";
    for (const r of rows) {
      tiles +=
        "<li><button type='button' class='qt-t' data-name='" +
        esc(r.name) +
        "' style='min-height:" +
        minH +
        "px'>" +
        (r.icon ? "<img src='" + esc(r.icon) + "'>" : "") +
        "<span class='qt-c'>" +
        esc(r.c) +
        "</span>" +
        (r.p ? "<span class='qt-p'>" + esc(r.p) + "</span>" : "") +
        "</button></li>";
    }
    sec.innerHTML =
      '<div class="qt-h">Recently used</div>' +
      '<ul class="categories" id="qt-list">' +
      tiles +
      "</ul>";
    ul.insertAdjacentElement("afterend", sec);
  }

  async function update() {
    harvestIcons(); // learn icons from whatever grid is showing
    // Entry/sign-in screen (<=2 breadcrumb segments) = a member flow is
    // starting/ending -> next category-screen open should re-fetch.
    if (headerSegments() <= 2) sawEntry = true;
    if (!onCategoryScreen()) {
      document.getElementById("qt-sec")?.remove();
      return;
    }
    parentSet(); // refresh parent cache while the grid is visible
    render(await fetchRecent());
  }

  update();
  let t = null;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(update, 100);
  }).observe(document.body, { childList: true, subtree: true });
})();
