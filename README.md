# SES Activity - userscripts

Tampermonkey userscripts that add quality-of-life features to the
[SES Activity](https://seslogin.com) volunteer sign-in/out system, built
against its public GraphQL API. They read the same queries the kiosk
already uses and inject their own UI without touching the app's
internals. The only actions they take (the sign-out button and the
quick tiles) drive the kiosk's own normal on-screen flow - no mutation
is ever called directly, and nothing commits without the usual Submit.

## Status

SES Activity is open source - the upstream project lives at
[**NSWSESMembers/seslogin**](https://github.com/NSWSESMembers/seslogin)
(MIT). These userscripts are an **interim community implementation** of
features intended to be contributed upstream as PRs once they've had
real-unit testing. Treat this repo as the testing/staging home; the
long-term home for each feature is a React/Relay component in the
upstream `web/` tree behind an opt-in flag.

Use at your own discretion; these are unofficial.

## Scripts

### `quick-tiles.user.js` - Quick category tiles

Adds a native-looking "Recently used" section to the category screen
with the unit's most recently used categories, so common picks skip the
parent/child drill-down. Workflow becomes: enter member number -> tap a
quick tile -> confirm the time -> Submit.

- Each tile is a native-looking square (icon + child category name), with
  its parent category as a bold caption below the box, so e.g. `Other /
  Other` and `Training / Other` (same child, different parent) are
  unambiguous.
- "Recent" = the unit's most recently used distinct categories, ranked
  by most recent activity (a just-completed sign-out counts, future /
  scheduled end times don't), read from the same GraphQL the kiosk
  already uses (scan token). It re-fetches for each new member (when the
  kiosk passes back through the entry screen), so when one person signs
  out of an activity it's first on the list for the next 20 doing the
  same - while parent/child tapping within one member reuses the result
  (one request per member, only ever during an actual sign-in/out).
- Categories under Trainer / Assessor / Workshop - Trainer are excluded
  (those roles use the full flow; this is for the majority of members).
- Renders as a native-looking "Recently used" section right after the
  real category grid, cloning the app's own tile classes at runtime, so
  the tile boxes are pixel-identical to the real ones - same box, size and
  category artwork - and follow the app's "Small categories" option
  automatically. Not a separate overlay/bar. The only difference from a
  real tile is the parent category shown as a bold caption below the box.
- Tile icons aren't in the API, so they're harvested from the app's own
  grids as they're seen (cached, persisted). A category not yet seen
  falls back to its parent's icon; the cache fills quickly in normal
  use.
- Tapping a tile drives the normal flow: it clicks the matching parent
  tile then the matching child tile for you, landing on the usual
  confirmation screen where the member presses Submit. No mutation is
  called directly; nothing commits until Submit, and Cancel still
  works.
- Shows only on the parent category grid (detected by breadcrumb depth
  + absence of a Back button). Never on the sign-in screen, the child
  grid, or the confirmation screen.

### `whos-here.user.js` - Who's Here scan-kiosk sidebar

Adds a compact live "currently signed in" sidebar to the scan kiosk so
the last person out can see at a glance who forgot to sign out before
locking up.

**Features**

- Compact one-line rows: name, time signed in, and a Sign out button,
  with a running total in the header. Long names truncate; the list
  scrolls, so it handles a full callout (60+ people) fine.
- Duration colour tiers: green normally, amber after 4 h, red after 6 h
  (likely a forgotten sign-out). Thresholds are constants near the top
  of the file (`WARN_MINS` / `ALERT_MINS`).
- Per-person **Sign out** button: types that member's number into the
  kiosk's SES ID box and submits it, exactly as if they had scanned.
  The normal on-screen step (category tile, etc.) is still completed by
  the person as usual. This is purely a convenience so the last person
  out can sign out anyone who forgot, without hunting for member numbers.
- Only shows on the entry screen. It detects the kiosk's view via the
  header breadcrumb and hides itself (and its layout shift) on the
  sign-in / sign-out / category screens, so it never blocks them.
- Runs on `seslogin.com` and the `test.seslogin.com` bake environment,
  on both `/scan*` and `/kiosk*` (a scan-configured kiosk serves the
  sign-in/out UI at `/kiosk`). The GraphQL endpoint auto-selects by host
  so each environment talks to its own API.

**Server load**

Designed to be light, since a kiosk is typically left running 24/7, but
reliable while people are actually there. Polling is adaptive: every
~15 s while there is recent kiosk activity (someone signing in/out -
exactly when the list changes and matters), relaxing to every 5 min
once the kiosk has been idle for a few minutes (nobody around). A screen
transition re-arms the active window, and returning to the entry screen
also fires a short burst of refreshes to reliably catch a
just-committed sign-in/out. No requests are made on non-entry screens.
It uses the same `StatusQuery` as the app's own Status kiosk, at a far
lower frequency than a live Status kiosk. Tunables are constants near
the top of the file (`ACTIVE_MS`, `IDLE_MS`, `ACTIVE_WINDOW_MS`).

**Auth**

Zero configuration. It reuses the scan kiosk's own session token from
`localStorage` and the no-arg `session` GraphQL query, which resolves
the kiosk's location automatically. The kiosk token auto-renews while
the kiosk is open, so nothing needs maintaining. An optional defensive
fallback token (Tampermonkey menu) exists but is not needed normally.

It never autofocuses or moves focus - the only interactive elements are
the per-person Sign out buttons, and they're never focused
automatically - so a barcode scanner typing into the SES ID field is
unaffected.

## Install & updates

Install the [Tampermonkey](https://www.tampermonkey.net/) browser
extension on the kiosk machine, then open each script's raw URL -
Tampermonkey shows an install page; click **Install**, then reload the
kiosk page (`/scan` or `/kiosk`).

- Who's Here:
  `https://github.com/jacksgithubacct/seslogin-tools/raw/refs/heads/main/whos-here.user.js`
- Quick Tiles:
  `https://github.com/jacksgithubacct/seslogin-tools/raw/refs/heads/main/quick-tiles.user.js`

Install whichever you want - they're independent. Both declare
`@updateURL` / `@downloadURL` pointing at those raw URLs, so Tampermonkey
auto-updates them whenever the `@version` is bumped (no manual re-paste).
You can also force a check from the Tampermonkey dashboard ("Check for
userscript updates").

## Notes

No credentials or member data are stored in this repository. Scripts
authenticate at runtime using the session token the SES Activity app
already holds in the browser.
