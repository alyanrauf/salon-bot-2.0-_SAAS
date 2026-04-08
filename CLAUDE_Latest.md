# CLAUDE.md — Deep Analysis: salon-bot

> **Generated:** 2026-03-31  
> **Codebase:** `salon-bot/` (Node.js/Express, SQLite, WhatsApp/Instagram/Facebook, Web Widget, WP Plugin, Gemini Voice Call)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File-by-File Breakdown](#2-file-by-file-breakdown)
3. [Critical Bugs](#3-critical-bugs)
4. [Issues by Severity](#4-issues-by-severity)
5. [Voice Call — Will It Work in Web Widget?](#5-voice-call--will-it-work-in-web-widget)
6. [Voice Call — Will It Work in WP Plugin?](#6-voice-call--will-it-work-in-wp-plugin)
7. [Security Issues](#7-security-issues)
8. [Recommended Fixes Summary](#8-recommended-fixes-summary)

---

## 1. Architecture Overview

```
Browser/WhatsApp/Instagram/Facebook
         │
         ▼
   src/index.js  (Express + HTTP server)
         │
   ┌─────┴──────┐
   │            │
/api/chat    /webhook
(web widget)  (Meta platforms)
   │            │
   └─────┬──────┘
         ▼
   src/core/router.js
         │
   ┌─────┴──────────────────┐
   │         │              │
intent.js  session.js   replies/
(Haiku AI) (in-memory)  (booking, prices, deals, branches)
                             │
                        src/db/database.js
                        (better-sqlite3)

/api/call  ──WebSocket──▶  src/server/apiCall.js
(voice)                    (Gemini Live Audio)

public/widget.js  ──────▶  Standalone chat + call UI
wp-plugin/        ──────▶  WordPress embed via <script>
```

**Stack:** Node.js 18+, Express 4, better-sqlite3, ws, @anthropic-ai/sdk (Haiku for intent), @google/genai (Gemini 2.5 Flash Native Audio for voice).

---

## 2. File-by-File Breakdown

### `src/index.js`
The main Express server. Does **too much** — all route definitions live here (~350 lines). Contains full CRUD for bookings, clients, staff, branches, timings, roles, and app settings. Also starts the HTTP server and attaches the WebSocket call server. Architecture smell: this file should be split into route modules.

**Notable:** There are **two `app.get('/admin', ...)` handlers** registered (lines ~104 and ~210). Express will only use the first one. The second is dead code.

### `src/server/apiCall.js`
The Gemini Live Audio WebSocket proxy. **Critical issue: uses ES Module syntax (`import`/`export`) in a CommonJS project.** The rest of the codebase uses `require()`. This file will throw a `SyntaxError` at runtime and crash the server on startup.

### `public/widget.js`
Vanilla JS IIFE that builds the chat widget and voice call modal. Self-contained, loads from the bot server. WebSocket URL is derived from the script's `src` origin. Has the voice call modal UI and PCM16 audio pipeline.

**Issues:** 
- `End Call` button in the modal does **not** close the WebSocket (`window._VOICE_WS`). The microphone stream and AudioContext are never stopped.
- A new `AudioContext` is created **per audio chunk** in `playPCM16()`. This is a memory/resource leak that will accumulate rapidly.
- `createScriptProcessor()` is deprecated in the Web Audio API. Should use `AudioWorklet`.

### `wp-plugin/salon-bot-widget.php`
Clean, minimal WP plugin. Injects `<script src="{server}/widget.js">` in `wp_footer`. Has admin settings page for URL, bot name, color, enable/disable toggle. Sanitizes all inputs properly.

**Issue:** The `<script>` tag is added with `defer` attribute. Since `widget.js` uses `document.currentScript` to read its own `src` and `data-*` attributes, and `defer` scripts run after HTML parsing when `document.currentScript` is `null`, **`scriptEl` will be `null`** and the widget will silently fail to initialize (crash at `new URL(scriptEl.src)`).

### `src/core/session.js`
**Critical Bug:** `sessions` is declared as a `new Map()` but `setSession()` uses **bracket notation** (`sessions[userId] = ...`) — treating it as a plain object. Meanwhile `getSession()`, `clearSession()`, and the pruning interval all use `Map` methods (`.get()`, `.delete()`, `.entries()`).

The result: sessions written by `setSession()` are **invisible** to `getSession()`. The booking flow will break at every step after the first, because the session state is never retrievable.

### `src/core/router.js`
Clean logic. Handles CANCEL at any step (good), checks for expired sessions, routes to the correct reply module. No major bugs, but `isSessionExpired()` is called with a hardcoded `5` minutes while the session TTL in `session.js` is `10` minutes — inconsistent.

### `src/core/intent.js`
Calls Claude Haiku to classify intent. Very lean (~20 tokens). `SERVICE_DETAIL|<term>` parsing is correct. The only concern is **every single message** to the chatbot costs an Anthropic API call before even hitting the booking flow — including mid-flow responses like "John Smith" or "2pm". This is wasteful and adds latency.

### `src/replies/booking.js`
**SQL Bug in `getActiveStaff()`:**  
```sql
ORDER BY s.name AND s.role NOT IN ('admin', 'manager', 'receptionist')
```
`AND` is a boolean operator, not a comma separator. This makes `ORDER BY` evaluate `s.name AND (boolean)` which is always `0` or `1`. Staff won't be filtered by role and won't be sorted by name correctly. The `WHERE` clause should contain the role filter.

**Correct query should be:**
```sql
WHERE s.status = 'active' 
  AND (s.branch_id = ? OR s.branch_id IS NULL)
  AND s.role NOT IN ('admin', 'manager', 'receptionist')
ORDER BY s.name
```

### `src/db/database.js`
Solid. WAL mode enabled. Schema init with IF NOT EXISTS. Incremental migration pattern for adding columns. Settings cache with invalidation. Good.

**Minor:** The branch seeding loop is hardcoded for `i = 1 to 2` (only 2 branches from env). If you add a third branch via admin panel it's fine, but the env seeding won't pick it up.

### `src/admin/auth.js`
Auth is cookie-based, comparing the cookie value directly to `ADMIN_SESSION_SECRET`. No bcrypt, no JWT — but acceptable for a simple admin panel behind HTTPS.

**Issue:** `req.cookies?.adminToken` — the optional chaining is fine, but the cookie parser in `index.js` can produce malformed entries if a cookie value contains `=` (e.g. base64). The split logic is `.split('=').map(decodeURIComponent)` which only splits on the first `=` correctly as-written, but only if the array destructuring is used — here it isn't, so a value like `abc=def=ghi` will yield `['abc', 'def=ghi']` which is incorrect. Use `.split(/=(.+)/)` or a proper cookie parser.

### `wp-plugin/salon-bot-widget.php`
Good overall. Proper nonce-less settings (using `settings_fields`), sanitization with `sanitize_hex_color`, `esc_url_raw`. The inline color preview JS is acceptable.

**Minor XSS risk:** Uses `<?= $server_url ?>` and `<?= $bot_name ?>` in the embed code preview block without going through `esc_html()` a second time (they were `esc_attr()`-ed earlier but the raw `$opts` variables are used in the `<pre>` block). Low risk since it's admin-only.

---

## 3. Critical Bugs

### BUG-1 — `apiCall.js` uses ESM in a CJS project (SERVER CRASH)

**File:** `src/server/apiCall.js`  
**Severity:** 🔴 FATAL — server will not start

The file uses:
```js
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
export function setupCallServer(server) { ... }
```

But `package.json` has no `"type": "module"` and all other files use `require()`. Node.js will throw:

```
SyntaxError: Cannot use import statement in a module
```

**Fix:** Convert to CommonJS:
```js
const { WebSocketServer } = require('ws');
const { GoogleGenAI, Modality } = require('@google/genai');

function setupCallServer(server) { ... }
module.exports = { setupCallServer };
```

---

### BUG-2 — `setSession()` writes to Map as plain object (BOOKING FLOW BROKEN)

**File:** `src/core/session.js`  
**Severity:** 🔴 FATAL — booking flow cannot progress past step 1

```js
const sessions = new Map();   // ← Map

function setSession(userId, newData) {
  sessions[userId] = { ... }; // ← writes as plain object property, NOT into the Map
}

function getSession(userId) {
  const entry = sessions.get(userId); // ← reads from Map → always undefined
}
```

Every call to `setSession()` stores data on the Map object as a property, but `getSession()` calls `sessions.get()` which looks in the Map's internal entries. They never see each other.

**Fix:** Replace `setSession` with:
```js
function setSession(userId, newData) {
  const existing = sessions.get(userId);
  sessions.set(userId, {
    ...(existing?.data || {}),
    ...newData,
    lastUpdated: Date.now()
  });
  // Re-wrap in the entry shape getSession expects:
}
```

But this also requires reconciling the entry shape. `getSession` returns `entry.data` but `setSession` stores the data flat. The cleanest fix:

```js
function setSession(userId, newData) {
  const prev = sessions.get(userId)?.data || {};
  sessions.set(userId, { data: { ...prev, ...newData }, updatedAt: Date.now() });
}
```

And update `isSessionExpired` to use `entry.updatedAt` or store `lastUpdated` inside `data`.

---

### BUG-3 — `getActiveStaff()` SQL is malformed (WRONG STAFF SHOWN)

**File:** `src/replies/booking.js`  
**Severity:** 🟠 HIGH — admins/managers/receptionists appear in stylist selection

```sql
ORDER BY s.name AND s.role NOT IN ('admin', 'manager', 'receptionist')
```

`AND` here is a bitwise/boolean operator, not SQL list syntax. SQLite evaluates this as `ORDER BY (boolean_expression)` (0 or 1), discarding both the name sort and the role filter entirely.

**Fix:**
```sql
WHERE s.status = 'active' 
  AND (s.branch_id = ? OR s.branch_id IS NULL)
  AND s.role NOT IN ('admin', 'manager', 'receptionist')
ORDER BY s.name
```

---

### BUG-4 — WP Plugin: `defer` breaks `document.currentScript` (WIDGET SILENT FAIL)

**File:** `wp-plugin/salon-bot-widget.php` + `public/widget.js`  
**Severity:** 🔴 FATAL for WP — widget won't initialize

The plugin injects:
```html
<script src="https://yourserver.com/widget.js" ... defer></script>
```

`widget.js` starts with:
```js
var scriptEl = document.currentScript ||
  document.querySelector('script[src*="widget.js"]');
var baseUrl = new URL(scriptEl.src).origin;
```

With `defer`, `document.currentScript` is `null` at execution time. The fallback `querySelector` should work, **but only if** no other script on the WP site also has `widget.js` in its src. On busy WP installs with caching plugins or CDNs that rename assets, this fallback may also fail.

**Fix:** Remove `defer` from the plugin:
```php
echo '<script src="' . $script_src . '"'
   . ' data-bot-name="' . $bot_name . '"'
   . ' data-primary-color="' . $primary_color . '"'
   . '></script>' . "\n";
```

Or change `widget.js` to not rely on `currentScript` at all — use a known global config object injected before the script tag.

---

## 4. Issues by Severity

### 🔴 Fatal (Prevent Startup or Core Function)

| # | File | Issue |
|---|------|-------|
| 1 | `src/server/apiCall.js` | ESM `import/export` in CJS project — server crashes on startup |
| 2 | `src/core/session.js` | `setSession` writes to Map as plain object — booking flow always broken |
| 3 | `wp-plugin/salon-bot-widget.php` | `defer` on script tag — widget fails to init in WordPress |

### 🟠 High (Wrong Behavior)

| # | File | Issue |
|---|------|-------|
| 4 | `src/replies/booking.js` | `getActiveStaff()` SQL `ORDER BY ... AND ...` — role filter and sort broken |
| 5 | `public/widget.js` | `End Call` button doesn't close WebSocket or stop microphone |
| 6 | `public/widget.js` | New `AudioContext` per audio chunk in `playPCM16()` — memory leak |
| 7 | `src/index.js` | Duplicate `app.get('/admin', ...)` route — second handler is dead code |

### 🟡 Medium (Quality / Performance)

| # | File | Issue |
|---|------|-------|
| 8 | `src/core/intent.js` | Claude Haiku called for every message including mid-booking replies (e.g. name, phone) — wasteful |
| 9 | `src/core/router.js` | `isSessionExpired(session, 5)` uses 5 min but session TTL is 10 min — inconsistent |
| 10 | `src/core/session.js` | Entry shape inconsistency: `getSession` reads `.data` / `.updatedAt` but `setSession` writes flat with `.lastUpdated` |
| 11 | `public/widget.js` | `createScriptProcessor()` is deprecated — should use `AudioWorkletNode` |
| 12 | `src/server/apiCall.js` | All voice calls share `__CALL_USER__` as session ID — parallel calls share booking state |
| 13 | `src/index.js` | Seed endpoint `/run-seed` protected only by `?key=adminkey123` — hardcoded insecure key |

### 🟢 Low / Code Quality

| # | File | Issue |
|---|------|-------|
| 14 | `src/index.js` | Monolithic file — all routes (~350 lines) should be split into route modules |
| 15 | `src/server/apiCall.js` | `systemInstruction` is very sparse — voice bot won't know the salon name, services, or fallback gracefully |
| 16 | `src/replies/booking.js` | `isValidName()` rejects single-name inputs (requires 2 words) — may reject valid Pakistani/Arabic single names |
| 17 | `src/db/database.js` | Branch env seeding hardcoded to 2 branches |
| 18 | `wp-plugin/salon-bot-widget.php` | Minor XSS risk in admin `<pre>` embed preview (uses `esc_attr` vars not `esc_html`) |

---

## 5. Voice Call — Will It Work in Web Widget?

### Short Answer: **No, not currently. Two fatal blockers.**

### Blocker 1 — Server Crash (`apiCall.js` ESM syntax)

The server won't even start because `src/server/apiCall.js` uses `import/export`. The WebSocket endpoint `/api/call` will never exist. The widget's `new WebSocket(...)` call will immediately fail.

**Fix:** Convert `apiCall.js` to CJS (see BUG-1 fix above).

### Blocker 2 — After fixing the crash, the call flow itself has issues:

**Issue A — `End Call` doesn't clean up:**
```js
document.getElementById("call-end").onclick = function () {
  modal.remove();
  // also close WebSocket if active etc.   ← TODO comment, not implemented
};
```
The WebSocket stays open, the microphone keeps capturing, and `AudioContext` instances keep piling up. The user's mic stays on indefinitely.

**Fix:**
```js
document.getElementById("call-end").onclick = function () {
  if (window._VOICE_WS) {
    window._VOICE_WS.close();
    window._VOICE_WS = null;
  }
  if (window._VOICE_STREAM) {
    window._VOICE_STREAM.getTracks().forEach(t => t.stop());
  }
  if (window._VOICE_CTX) {
    window._VOICE_CTX.close();
  }
  modal.remove();
};
```
And in `startMicrophone`, save the stream and context to globals.

**Issue B — `playPCM16()` creates a new `AudioContext` per chunk:**
```js
function playPCM16(buffer) {
  const ctx = new AudioContext({ sampleRate: 16000 }); // ← new every call!
  ...
}
```
Browsers allow ~6 simultaneous AudioContexts and then start throwing. Audio will stutter and eventually fail on longer calls.

**Fix:** Create one `AudioContext` for the call session and reuse it.

**Issue C — Parallel calls share one session ID:**
In `apiCall.js`:
```js
const reply = await routeMessage("__CALL_USER__", userText, "voice");
```
If two users make voice calls simultaneously, they share the same booking session. The second caller will see the first caller's booking state.

**Fix:** Generate a unique session ID per WebSocket connection:
```js
const callSessionId = `__CALL_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
```

### What Will Work (once crash is fixed):

- WebSocket connection from browser to server: ✅ (HTTPS → WSS upgrade is handled correctly)
- Microphone capture at 16kHz PCM16: ✅ (correct format for Gemini)
- Audio streaming to Gemini: ✅
- Gemini response audio received and played: ✅ (once AudioContext leak is fixed)
- Tool call → `routeMessage()` → DB query → spoken reply: ✅ (routing works)
- URL derivation (`baseUrl.replace("https","wss")`): ✅ correct

---

## 6. Voice Call — Will It Work in WP Plugin?

### Short Answer: **No. Two separate fatal blockers.**

### Blocker 1 — `defer` breaks widget initialization

As described in BUG-4, the WP plugin adds `defer` to the script tag. `document.currentScript` is `null` for deferred scripts. The widget crashes before it even renders. The call button never appears.

**Fix:** Remove `defer` from the plugin output.

### Blocker 2 — Mixed Content (HTTP vs WSS)

If the WordPress site is on `https://` (as it should be), and the bot server is also on `https://`, the WebSocket URL derivation in `widget.js` works:
```js
baseUrl.replace("https", "wss").replace("http", "ws")
```
This gives `wss://yourserver.com/api/call` — correct.

**BUT** — if any user is on an HTTP WordPress page (e.g. dev/staging, or misconfigured SSL) and the bot server is HTTPS, the browser will block the WSS connection as mixed content. This is a configuration issue, not a code bug, but worth documenting.

### Blocker 3 — Same-origin WebSocket vs CORS

The WebSocket connection goes directly from the browser to `wss://botserver.com/api/call`. WS upgrades don't use CORS headers — they use the `Origin` header. The current `apiCall.js` doesn't validate the `Origin` header, meaning any website can open a voice call connection to the server. This is a security concern (resource abuse), not a functional blocker, but should be fixed.

**Fix in `apiCall.js`:**
```js
server.on("upgrade", (req, socket, head) => {
  const allowed = process.env.WIDGET_ALLOWED_ORIGINS || '*';
  const origin = req.headers.origin || '';
  if (allowed !== '*' && !allowed.split(',').includes(origin)) {
    socket.destroy();
    return;
  }
  if (req.url === "/api/call") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});
```

### What Will Work in WP (after fixes):

Once `defer` is removed and BUG-1 (ESM crash) is fixed, the call feature will work on WordPress the same as it does in the standalone widget. There is no WP-specific incompatibility beyond those two issues.

---

## 7. Security Issues

| Issue | Severity | Details |
|-------|----------|---------|
| **API keys in `.env` committed to repo** | 🔴 CRITICAL | Real `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `WA_ACCESS_TOKEN`, and `ADMIN_SESSION_SECRET` are in the committed `.env` file in the zip. These must be rotated immediately. |
| **Weak seed key** | 🟠 HIGH | `/run-seed?key=adminkey123` — hardcoded weak key. Anyone who knows this can reseed/wipe data. Should require admin auth. |
| **Admin password in .env** | 🟡 MEDIUM | `ADMIN_PASSWORD=admin123` — very weak default. Acceptable for dev, must be changed for prod. |
| **Cookie parser splits on first `=` only** | 🟡 MEDIUM | The manual cookie parser can misparse values containing `=`. Use `cookie` npm package. |
| **No CSRF protection on admin POST routes** | 🟡 MEDIUM | `/admin/deals`, `/admin/services`, etc. have no CSRF token. Mitigated by cookie `SameSite=Strict` but should have explicit CSRF protection for defense in depth. |
| **No WebSocket origin validation** | 🟡 MEDIUM | Any website can connect to `/api/call` and consume Gemini API quota. |
| **SQL injection risk in prices.js** | 🟢 LOW | `db.prepare(...).get(` `%${name.toLowerCase()}%` `)` — uses parameterized query, so safe. |

---

## 8. Recommended Fixes Summary

### Do First (blockers):

1. **Fix `apiCall.js`** — Convert from ESM to CJS. The server cannot start without this.
2. **Fix `session.js` `setSession()`** — Use `sessions.set()` instead of bracket notation. Booking is fully broken without this.
3. **Remove `defer`** from the WP plugin script tag. Widget is silent without this.
4. **Fix `getActiveStaff()` SQL** — Move role filter into `WHERE`, remove `AND` from `ORDER BY`.
5. **Rotate all keys** from the committed `.env` — Anthropic key, Gemini key, WA access token, admin secret.

### Do Next (call quality):

6. **Fix `End Call` cleanup** — Close WebSocket, stop mic tracks, close AudioContext.
7. **Fix `playPCM16()`** — Reuse a single `AudioContext` for the call duration.
8. **Fix parallel call session ID** — Use a per-connection unique ID instead of `__CALL_USER__`.
9. **Add WebSocket origin validation** in `apiCall.js`.

### Do Later (code quality):

10. Skip `detectIntent()` during active booking steps — check `session.state` before calling Claude Haiku.
11. Split `index.js` into route modules.
12. Replace `createScriptProcessor` with `AudioWorkletNode` in `widget.js`.
13. Fix the duplicate `app.get('/admin', ...)` registration.
14. Add `cookie` npm package for robust cookie parsing.
15. Tighten `systemInstruction` in `apiCall.js` — include salon name, branch info, and behavior guidelines.
