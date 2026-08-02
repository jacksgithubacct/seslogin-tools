// ==UserScript==
// @name         SES Activity - Quick Category Tiles
// @namespace    seslogin.userscripts
// @version      0.11.0
// @description  TEMPORARILY DISABLED - this script intentionally does nothing. See the note below.
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
// @grant        none
// ==/UserScript==

/*
 * TEMPORARILY DISABLED - this version is deliberately a no-op.
 *
 * Why: the kiosk gained a native "Quick pick" sign-out screen (upstream
 * PR #48, merged and deployed 2026-07-31) which covers the same ground as
 * this script, and kiosks running it have been reported freezing on
 * sign-out. This stub is published so a kiosk that cannot be reached in
 * person picks up an inert version on its next Tampermonkey update and
 * page reload, ruling this script out entirely.
 *
 * NOTE: this only disables THIS script. If the freeze is the native
 * quick-pick screen, it is turned off server-side per kiosk session:
 * admin dashboard -> Kiosks -> the session -> untick "Quick pick
 * categories" -> Save. That does not need physical access to the kiosk.
 *
 * The full script is not lost - it is in this repo's git history (the
 * last working version is 0.10.0). To bring it back, restore that file
 * and bump @version above 0.11.0 so Tampermonkey takes the update.
 *
 * Kept as a valid userscript rather than an empty file on purpose:
 * Tampermonkey needs the metadata block and a higher @version to accept
 * an update, so a genuinely empty file would simply be ignored and the
 * old version would keep running.
 */

// Intentionally empty.
