// ─────────────────────────────────────────────────────────────────────────────
//  salon-bot  ·  src/index.js  ·  Multi-Tenant SaaS Entry Point
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const http = require("http");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const logger = require("./utils/logger");
const { initializeAllTenants, getDb, invalidateSettingsCache } = require("./db/database");
const { setupCallServer } = require("./server/apiCallLive.js");
const { initCache, getCache, patchCache } = require("./cache/salonDataCache");

// Tenant / Super-Admin helpers
const {
  getSuperDb,
  getAllTenants,
  createTenant,
  updateTenantStatus,
  authenticateTenant,
  getTenantById,
  updateSalonName,
  isTenantActive,
  getWebhookConfig,
  upsertWebhookConfig,
} = require("./db/tenantManager");

// Auth middleware
const {
  requireSuperAdminAuth,
  requireTenantAuth,
  generateTenantToken,
} = require("./middleware/tenantAuth");

// Platform webhook handlers
const { handleWhatsApp, verifyWhatsApp } = require("./handlers/whatsapp");
const { handleInstagram, verifyInstagram } = require("./handlers/instagram");
const { handleFacebook, verifyFacebook } = require("./handlers/facebook");

// Chat router (web widget)
const { routeMessage } = require("./core/router");

// ── JWT secret — REQUIRED in production ──────────────────────────────────────
const JWT_SECRET = process.env.TENANT_JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: TENANT_JWT_SECRET env var is not set. Set it to a 32-byte random hex string.");
  process.exit(1);
}

// ── Simple in-memory rate limiter ─────────────────────────────────────────────
const _rateBuckets = new Map(); // key → { count, resetAt }
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let bucket = _rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    _rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count > maxRequests; // true = rate limited
}
// Clean up stale buckets every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) if (now > v.resetAt) _rateBuckets.delete(k);
}, 300_000);

const NO_SHOW_GRACE_MIN = parseInt(process.env.NO_SHOW_GRACE_MIN || "30", 10);
const NO_SHOW_SCAN_MS = 15 * 60 * 1000; // every 15 min

// ─────────────────────────────────────────────────────────────────────────────
//  Express setup
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Minimal cookie parser (no extra dependency)
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = Object.fromEntries(
    raw
      .split(";")
      .filter(Boolean)
      .map((c) => c.trim().split("=").map(decodeURIComponent))
  );
  next();
});
app.use('/salon-admin/api', (err, req, res, next) => {
  if (err) {
    console.error('API Error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
  next();
});

// CORS for widget.js
app.use("/widget.js", (_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Serve /public (widget.js lives here)
app.use(express.static(path.join(__dirname, "../public")));

// Per-tenant widget URL: /widget/SA_01/widget.js
// widget.js auto-extracts tenantId from this URL pattern
app.get("/widget/:tenantId/widget.js", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "../public/widget.js"));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Helper functions
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  VALIDATION — booking body
//  Pass isEdit=true on PUT so past-date check is skipped
// ─────────────────────────────────────────────────────────────────────────────
function validateBookingBody(body, isEdit = false) {
  const { customer_name, phone, service, branch, date, time } = body;
  const errs = [];
  if (!customer_name?.trim()) errs.push("customer_name");
  if (!phone?.trim()) errs.push("phone");
  if (!service?.trim()) errs.push("service");
  if (!branch?.trim()) errs.push("branch");
  if (!time?.trim()) errs.push("time");

  if (!date?.trim()) {
    errs.push("date");
  } else if (!isEdit) {
    const today = new Date().toISOString().slice(0, 10);
    if (date.trim() < today) errs.push("date (cannot be in the past)");
  }
  return errs;
}

function calculateEndTime(startHHMM, durationMinutes) {
  if (!startHHMM || !durationMinutes) return startHHMM;
  const [h, m] = startHHMM.split(":").map(Number);
  const totalMin = h * 60 + m + Number(durationMinutes);
  const newH = Math.floor(totalMin / 60) % 24;
  const newM = totalMin % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

function getServiceDuration(serviceName, db, tenantId) {
  try {
    const svc = db
      .prepare(`SELECT durationMinutes FROM ${tenantId}_services WHERE name = ?`)
      .get(serviceName);
    return svc ? svc.durationMinutes : 60;
  } catch {
    return 60;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIMING CHECK — start + end both within salon hours
// ─────────────────────────────────────────────────────────────────────────────
function checkBookingTimingWithEndTime(date, time, endTime, db, tenantId) {
  const dow = new Date(date).getDay();
  const dayType = dow === 0 || dow === 6 ? "weekend" : "workday";
  const timing = db
    .prepare(`SELECT * FROM ${tenantId}_salon_timings WHERE day_type = ?`)
    .get(dayType);

  if (!timing) return null; // no timings configured → allow

  const startMin = toMin(time);
  const endMin = toMin(endTime);
  const openMin = toMin(timing.open_time);
  const closeMin = toMin(timing.close_time);

  if (isNaN(startMin) || isNaN(openMin) || isNaN(closeMin))
    return `Could not parse salon timing or booking time`;

  if (startMin < openMin || startMin > closeMin)
    return `Start time ${time} is outside ${dayType} hours (${timing.open_time}–${timing.close_time})`;

  if (!isNaN(endMin) && endMin > closeMin)
    return `End time ${endTime} exceeds ${dayType} closing time (${timing.close_time})`;

  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
//  STAFF BRANCH CHECK
// ─────────────────────────────────────────────────────────────────────────────
function checkStaffBranch(staffId, branch, db, tenantId) {
  // Guard: null, undefined, empty string, 0 — all mean "no staff selected"
  if (!staffId || staffId === '' || staffId === 0 || staffId === '0') return null;
  const id = parseInt(staffId, 10);
  if (isNaN(id)) return null;
  const staff = db.prepare(`SELECT * FROM ${tenantId}_staff WHERE id = ?`).get(id);
  if (!staff) return "Selected staff member not found.";
  if (staff.branch_id === null) return null; // unassigned staff → works everywhere
  const br = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch);
  if (!br || staff.branch_id !== br.id)
    return "Selected staff does not belong to this branch.";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER — parse "HH:MM" or "YYYY-MM-DD HH:MM" safely → total minutes
//  Returns NaN only if the string is genuinely unparseable
// ─────────────────────────────────────────────────────────────────────────────
function toMin(timeStr) {
  if (!timeStr) return NaN;
  // Strip date prefix if present ("2026-04-08 14:30" → "14:30")
  const t = timeStr.includes(" ") ? timeStr.split(" ")[1] : timeStr;
  const parts = t.split(":").map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return NaN;
  return parts[0] * 60 + parts[1];
}

// ─────────────────────────────────────────────────────────────────────────────
//  STAFF AVAILABILITY CHECK (single staff, for POST/PUT with explicit staff_id)
//  excludeBookingId — pass the booking being edited so it doesn't conflict
//  with itself
// ─────────────────────────────────────────────────────────────────────────────
function checkStaffAvailability(staffId, date, startTime, endTime, db, tenantId, excludeBookingId = null) {
  if (!staffId) return null;

  const newStart = toMin(startTime);
  const newEnd = toMin(endTime);

  if (isNaN(newStart) || isNaN(newEnd)) {
    logger.warn(`[STAFF-AVAIL] Could not parse time: ${startTime} / ${endTime}`);
    return null; // don't block on bad input — let timing check catch it
  }

  let sql = `
    SELECT id, time, endTime, service FROM ${tenantId}_bookings
    WHERE staff_id = ? AND date = ? AND status = 'confirmed'
  `;
  const params = [staffId, date];
  if (excludeBookingId) {
    sql += ` AND id != ?`;
    params.push(excludeBookingId);
  }

  const conflicts = db.prepare(sql).all(...params);

  for (const b of conflicts) {
    const exStart = toMin(b.time);
    // endTime may be null on older bookings — fall back to 60-min default
    const exEnd = !isNaN(toMin(b.endTime)) ? toMin(b.endTime) : exStart + 60;

    if (isNaN(exStart)) continue; // corrupt row — skip

    // Overlap condition: new starts before existing ends AND new ends after existing starts
    if (newStart < exEnd && newEnd > exStart) {
      const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return `Staff already booked from ${fmt(exStart)} to ${fmt(exEnd)} (${b.service || "another service"})`;
    }
  }

  return null; // no conflict
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIND AVAILABLE STAFF for a given slot (used when no staff_id is specified)
//  Returns array of staff objects that are free in [startTime, endTime]
// ─────────────────────────────────────────────────────────────────────────────
function findAvailableStaff(date, startTime, endTime, branch, db, tenantId) {
  const newStart = toMin(startTime);
  const newEnd = toMin(endTime);

  console.log(`[FIND-STAFF] === DEBUG START ===`);
  console.log(`[FIND-STAFF] Input: date=${date}, startTime=${startTime}, endTime=${endTime}, branch=${branch}, tenantId=${tenantId}`);

  if (isNaN(newStart) || isNaN(newEnd)) {
    logger.warn(`[FIND-STAFF] Unparseable slot: ${startTime}–${endTime}`);
    return [];
  }

  // ── 1. Resolve branch id ──────────────────────────────────────────────────
  const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch);
  const branchId = branchRow ? branchRow.id : null;
  console.log(`[FIND-STAFF] Branch: ${branch}, branchId: ${branchId}`);

  // ── 2. Get service-provider roles (excludes admin/manager/receptionist) ───
  let serviceRoles = [];
  try {
    serviceRoles = db
      .prepare(`SELECT name FROM ${tenantId}_staff_roles WHERE name NOT IN ('admin','manager','receptionist')`)
      .all()
      .map((r) => r.name);
    console.log(`[FIND-STAFF] Service roles from DB:`, serviceRoles);
  } catch (e) {
    logger.warn(`[FIND-STAFF] Could not load roles: ${e.message}`);
    console.log(`[FIND-STAFF] Error loading roles:`, e.message);
  }

  // ── 3. Fetch candidate staff ──────────────────────────────────────────────
  let staffList = [];
  try {
    if (serviceRoles.length > 0) {
      const ph = serviceRoles.map(() => "?").join(",");
      const sql = `
        SELECT s.* FROM ${tenantId}_staff s
        WHERE s.status = 'active'
          AND s.role IN (${ph})
          AND (s.branch_id = ? OR s.branch_id IS NULL)
      `;
      console.log(`[FIND-STAFF] SQL with roles:`, sql);
      console.log(`[FIND-STAFF] Parameters: roles=${serviceRoles.join(', ')}, branchId=${branchId}`);

      staffList = db.prepare(sql).all(...serviceRoles, branchId);
    } else {
      const sql = `
        SELECT s.* FROM ${tenantId}_staff s
        WHERE s.status = 'active'
          AND s.role NOT IN ('admin', 'manager', 'receptionist')
          AND (s.branch_id = ? OR s.branch_id IS NULL)
      `;
      console.log(`[FIND-STAFF] SQL without roles:`, sql);
      staffList = db.prepare(sql).all(branchId);
    }

    console.log(`[FIND-STAFF] Staff found: ${staffList.length}`);
    staffList.forEach(s => {
      console.log(`[FIND-STAFF]   - ${s.name}, role: ${s.role}, branch_id: ${s.branch_id}, status: ${s.status}`);
    });
  } catch (e) {
    logger.error(`[FIND-STAFF] Staff query failed: ${e.message}`);
    console.error(`[FIND-STAFF] Error:`, e);
    return [];
  }

  if (staffList.length === 0) {
    logger.warn(`[FIND-STAFF] No active service-provider staff found for branch "${branch}" (branchId=${branchId})`);
    console.log(`[FIND-STAFF] No staff found - check branch assignment!`);
    return [];
  }

  // ── 4. Pre-fetch all confirmed bookings for this date/branch once ─────────
  let dateBookings = [];
  try {
    dateBookings = db
      .prepare(`
        SELECT staff_id, time, endTime, service FROM ${tenantId}_bookings
        WHERE date = ? AND status = 'confirmed' AND branch = ?
      `)
      .all(date, branch);
    console.log(`[FIND-STAFF] Bookings on ${date} for branch ${branch}: ${dateBookings.length}`);
  } catch (e) {
    logger.error(`[FIND-STAFF] Booking query failed: ${e.message}`);
    console.log(`[FIND-STAFF] Error loading bookings:`, e.message);
  }

  // ── 5. Filter to free staff ───────────────────────────────────────────────
  const freeStaff = staffList.filter((staff) => {
    const staffBookings = dateBookings.filter((b) => b.staff_id === staff.id);

    if (staffBookings.length === 0) {
      console.log(`[FIND-STAFF] ${staff.name} has NO bookings on this date - FREE`);
      return true;
    }

    for (const b of staffBookings) {
      const exStart = toMin(b.time);
      const exEnd = !isNaN(toMin(b.endTime)) ? toMin(b.endTime) : exStart + 60;

      if (isNaN(exStart)) continue;

      if (newStart < exEnd && newEnd > exStart) {
        console.log(`[FIND-STAFF] ${staff.name} BUSY: ${b.time}–${b.endTime || '(no endTime)'} overlaps ${startTime}–${endTime}`);
        return false;
      }
    }

    console.log(`[FIND-STAFF] ${staff.name} is FREE at ${startTime}–${endTime}`);
    return true;
  });

  console.log(`[FIND-STAFF] Free staff count: ${freeStaff.length}`);
  console.log(`[FIND-STAFF] === DEBUG END ===`);

  return freeStaff;
}


// ─────────────────────────────────────────────────────────────────────────────
//  FIND NEXT AVAILABLE SLOTS (for suggesting alternatives in the widget)
// ─────────────────────────────────────────────────────────────────────────────
function findNextAvailableSlots(date, branch, durationMinutes, db, tenantId) {
  const dow = new Date(date).getDay();
  const dayType = dow === 0 || dow === 6 ? "weekend" : "workday";
  const timing = db
    .prepare(`SELECT * FROM ${tenantId}_salon_timings WHERE day_type = ?`)
    .get(dayType);

  if (!timing) return [];

  const openMin = toMin(timing.open_time);
  const closeMin = toMin(timing.close_time);

  if (isNaN(openMin) || isNaN(closeMin)) return [];

  const slots = [];
  let cursor = openMin;
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  while (cursor + durationMinutes <= closeMin) {
    const slotTime = fmt(cursor);
    const slotEndTime = fmt(cursor + durationMinutes);
    const available = findAvailableStaff(date, slotTime, slotEndTime, branch, db, tenantId);

    if (available.length > 0) {
      slots.push({
        time: slotTime,
        endTime: slotEndTime,
        availableStaff: available.length,
      });
    }
    cursor += 30; // 30-minute increments
  }

  return slots;
}

// Valid status transitions — anything not in this map is rejected
const STATUS_TRANSITIONS = {
  confirmed:   ["canceled", "completed", "no_show"],
  no_show:     ["confirmed"],  // allow un-marking a false no-show
  canceled:    [],             // terminal — no restoring
  completed:   [],             // terminal
};

function validateStatusTransition(currentStatus, newStatus) {
  const curr = (currentStatus || "confirmed").toLowerCase();
  const next = (newStatus || "").toLowerCase();
  if (curr === next) return null; // no-op
  const allowed = STATUS_TRANSITIONS[curr] || [];
  if (!allowed.includes(next))
    return `Cannot change status from '${curr}' to '${next}'. Allowed: ${allowed.join(", ") || "none"}.`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Health + chat
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.send("Salon Bot is running ✅"));

// CORS pre-flight for chat
app.options("/api/chat", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/api/chat", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { message, sessionId, tenantId } = req.body;
  if (!message || !sessionId)
    return res.status(400).json({ error: "message and sessionId required" });
  if (!tenantId)
    return res.status(400).json({ error: "tenantId required" });

  // Rate limit: 60 messages / minute per sessionId
  if (rateLimit(`chat:${sessionId}`, 60, 60_000))
    return res.status(429).json({ error: "Too many messages. Please slow down." });

  // Validate tenant is active
  if (!isTenantActive(tenantId))
    return res.status(403).json({ error: "Salon not found or inactive" });

  try {
    const reply = await routeMessage(sessionId, message.trim(), "webchat", tenantId);
    res.json({ reply });
  } catch (err) {
    logger.error("[chat-api] Error:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Meta webhooks
// ─────────────────────────────────────────────────────────────────────────────

// ── Legacy single-tenant webhook (kept for backwards compat; logs a warning) ──
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN) {
    logger.warn("[Webhook] Legacy /webhook used. Migrate to /webhooks/:tenantSlug/<platform>");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  logger.warn("[Webhook] Legacy /webhook — no tenantId context. Messages will be dropped.");
  const obj = req.body?.object;
  if (obj === "whatsapp_business_account") return handleWhatsApp(req, res, null, null);
  if (obj === "instagram") return handleInstagram(req, res, null, null);
  if (obj === "page") return handleFacebook(req, res, null, null);
  res.sendStatus(200);
});

// ── Per-tenant webhook middleware ─────────────────────────────────────────────
function tenantWebhookMiddleware(req, res, next) {
  const slug = req.params.tenantSlug;
  if (!slug) return res.status(400).json({ error: "tenantSlug required" });

  const tenant = getTenantById(slug);
  if (!tenant || tenant.status !== "active")
    return res.status(404).json({ error: "Salon not found or inactive" });

  req.tenantId = tenant.tenant_id;
  req.webhookConfig = getWebhookConfig(tenant.tenant_id);
  next();
}

// Per-tenant WhatsApp
app.get("/webhooks/:tenantSlug/whatsapp", tenantWebhookMiddleware, (req, res) =>
  verifyWhatsApp(req, res, req.webhookConfig));
app.post("/webhooks/:tenantSlug/whatsapp", tenantWebhookMiddleware, (req, res) =>
  handleWhatsApp(req, res, req.tenantId, req.webhookConfig));

// Per-tenant Instagram
app.get("/webhooks/:tenantSlug/instagram", tenantWebhookMiddleware, (req, res) =>
  verifyInstagram(req, res, req.webhookConfig));
app.post("/webhooks/:tenantSlug/instagram", tenantWebhookMiddleware, (req, res) =>
  handleInstagram(req, res, req.tenantId, req.webhookConfig));

// Per-tenant Facebook
app.get("/webhooks/:tenantSlug/facebook", tenantWebhookMiddleware, (req, res) =>
  verifyFacebook(req, res, req.webhookConfig));
app.post("/webhooks/:tenantSlug/facebook", tenantWebhookMiddleware, (req, res) =>
  handleFacebook(req, res, req.tenantId, req.webhookConfig));

// ─────────────────────────────────────────────────────────────────────────────
//  Salon-config endpoint (for multi-tenant widget bootstrap)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-config/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenantById(tenantId);
  if (!tenant || tenant.status !== "active")
    return res.status(404).json({ error: "Salon not found" });

  await initCache(tenantId);
  res.json({
    salon_name: tenant.salon_name,
    bot_name: tenant.salon_name + " Assistant",
    primary_color: "#8b4a6b",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon-data JSON cache endpoint (for external/widget use)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-data.json", (req, res) => {
  const { tenantId, key } = req.query;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const expectedKey = process.env.SALON_DATA_KEY || "adminkey123";
  if (!key || key !== expectedKey) return res.status(401).json({ error: "Unauthorized" });
  const cache = getCache(tenantId);
  if (!cache) return res.status(503).json({ error: "Cache not ready" });
  res.json(cache);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Auth
// ─────────────────────────────────────────────────────────────────────────────

// Login page
app.get("/salon-admin/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin/views/salon-login.html"));
});

// Login POST (JSON — called by frontend fetch)
app.post("/salon-admin/login", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimit(`login:tenant:${ip}`, 5, 15 * 60_000))
    return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });

  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "email and password required" });

  const tenant = authenticateTenant(email, password);
  if (!tenant)
    return res.status(401).json({ error: "Invalid credentials" });

  const token = generateTenantToken(tenant);
  res.cookie("tenantToken", token, { httpOnly: true, maxAge: 604_800_000, path: "/" });
  res.json({ success: true, redirect: "/salon-admin/dashboard" });
});

// Dashboard
app.get("/salon-admin/dashboard", requireTenantAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin/views/panel.html"));
});

// Logout
app.get("/salon-admin/logout", (_req, res) => {
  res.clearCookie("tenantToken");
  res.redirect("/salon-admin/login");
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Stats
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/stats", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();

  // ✅ FIX: Accept optional tz param. If provided, compute today in that timezone.
  // Falls back to UTC. Format: YYYY-MM-DD for SQL date comparison.
  const tz = req.query.tz || "UTC";
  let today;
  try {
    today = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD in salon TZ
  } catch {
    today = new Date().toISOString().slice(0, 10);
  }

  const serverTime = new Date().toISOString();

  res.json({
    total_bookings:  db.prepare(`SELECT COUNT(*) AS n FROM ${tenantId}_bookings WHERE status != 'archived'`).get().n,
    today_bookings:  db.prepare(`SELECT COUNT(*) AS n FROM ${tenantId}_bookings WHERE date = ? AND status NOT IN ('archived','canceled')`).get(today).n,
    active_services: db.prepare(`SELECT COUNT(*) AS n FROM ${tenantId}_services`).get().n,
    total_clients:   db.prepare(`SELECT COUNT(DISTINCT phone) AS n FROM ${tenantId}_bookings WHERE status != 'archived'`).get().n,
    // ✅ Metadata: frontend can verify what "today" was computed as
    queryRange: { start: today, end: today, tz },
    dataFreshAsOf: serverTime,
    serverTime,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Deals
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/deals", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.deals) return res.json(cache.deals);

  const deals = getDb().prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
  res.json(deals);
});

app.post("/salon-admin/deals", requireTenantAuth, (req, res) => {
  try {
    const { deals } = req.body;
    const tenantId = req.tenantId;
    if (!Array.isArray(deals)) return res.json({ ok: false, error: "Invalid data" });

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO ${tenantId}_deals (id, title, description, active, updated_at)
      VALUES (@id, @title, @description, @active, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        title       = excluded.title,
        description = excluded.description,
        active      = excluded.active,
        updated_at  = excluded.updated_at
    `);
    const insert = db.prepare(`
      INSERT INTO ${tenantId}_deals (title, description, active, updated_at)
      VALUES (@title, @description, @active, datetime('now'))
    `);

    const existingIds = new Set(db.prepare(`SELECT id FROM ${tenantId}_deals`).all().map((r) => r.id));
    const incomingIds = new Set(deals.filter((d) => d.id).map((d) => d.id));
    const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));

    db.transaction(() => {
      for (const id of toDelete)
        db.prepare(`DELETE FROM ${tenantId}_deals WHERE id = ?`).run(id);
      for (const deal of deals) {
        const payload = { title: deal.title, description: deal.description, active: deal.active ? 1 : 0 };
        if (deal.id) upsert.run({ id: deal.id, ...payload });
        else insert.run(payload);
      }
    })();

    const updated = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    patchCache(tenantId, "deals", "replace", updated).catch((e) =>
      logger.error("[cache] deals patch:", e.message)
    );
    res.json({ ok: true, deals: updated });
  } catch (err) {
    logger.error("[admin] Save deals error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Services
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/services", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.services) return res.json(cache.services);

  const services = getDb()
    .prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`)
    .all();
  res.json(services);
});

app.post("/salon-admin/services", requireTenantAuth, (req, res) => {
  try {
    const { services } = req.body;
    const tenantId = req.tenantId;
    if (!Array.isArray(services)) return res.json({ ok: false, error: "Invalid data" });

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO ${tenantId}_services (id, name, price, description, branch, durationMinutes, updated_at)
      VALUES (@id, @name, @price, @description, @branch, @durationMinutes, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name            = excluded.name,
        price           = excluded.price,
        description     = excluded.description,
        branch          = excluded.branch,
        durationMinutes = excluded.durationMinutes,
        updated_at      = excluded.updated_at
    `);
    const insert = db.prepare(`
      INSERT INTO ${tenantId}_services (name, price, description, branch, durationMinutes, updated_at)
      VALUES (@name, @price, @description, @branch, @durationMinutes, datetime('now'))
    `);

    const existingIds = new Set(db.prepare(`SELECT id FROM ${tenantId}_services`).all().map((r) => r.id));
    const incomingIds = new Set(services.filter((s) => s.id).map((s) => s.id));
    const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));

    db.transaction(() => {
      for (const id of toDelete)
        db.prepare(`DELETE FROM ${tenantId}_services WHERE id = ?`).run(id);
      for (const svc of services) {
        const payload = {
          name: svc.name,
          price: svc.price,
          description: svc.description,
          branch: svc.branch || "All Branches",
          durationMinutes: svc.durationMinutes || 60,
        };
        if (svc.id) upsert.run({ id: svc.id, ...payload });
        else insert.run(payload);
      }
    })();

    const updated = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    patchCache(tenantId, "services", "replace", updated).catch((e) =>
      logger.error("[cache] services patch:", e.message)
    );
    res.json({ ok: true, services: updated });
  } catch (err) {
    logger.error("[admin] Save services error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Bookings (CRUD)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/bookings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  let sql = `SELECT * FROM ${tenantId}_bookings WHERE 1=1`;
  const args = [];

  if (req.query.date) { sql += " AND date = ?"; args.push(req.query.date); }
  if (req.query.status) { sql += " AND status = ?"; args.push(req.query.status); }
  sql += " ORDER BY created_at DESC";
  if (req.query.limit) { sql += " LIMIT ?"; args.push(parseInt(req.query.limit)); }

  // Use cache only for unfiltered requests
  if (!req.query.date && !req.query.status && !req.query.limit) {
    const cache = getCache(tenantId);
    if (cache?.bookings) return res.json(cache.bookings);
  }

  const bookings = getDb().prepare(sql).all(...args);
  res.json(bookings);
});

app.post("/salon-admin/api/bookings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  let { customer_name, phone, service, branch, date, time, notes, staff_id, staff_name } = req.body;

  // Normalize staff_id: empty string / "0" / 0 / null → null
  staff_id = (staff_id && staff_id !== "0") ? (parseInt(staff_id, 10) || null) : null;

  const errs = validateBookingBody(req.body);
  if (errs.length)
    return res.status(400).json({ ok: false, error: `Missing/invalid: ${errs.join(", ")}` });

  const staffBranchErr = checkStaffBranch(staff_id, branch.trim(), db, tenantId);
  if (staffBranchErr) return res.status(400).json({ ok: false, error: staffBranchErr });

  const duration = getServiceDuration(service.trim(), db, tenantId);
  const endTime = calculateEndTime(time.trim(), duration);

  const timingErr = checkBookingTimingWithEndTime(date.trim(), time.trim(), endTime, db, tenantId);
  if (timingErr) return res.status(400).json({ ok: false, error: timingErr });

  let staffRequested = staff_id ? 1 : 0;

  if (staff_id) {
    const availErr = checkStaffAvailability(staff_id, date.trim(), time.trim(), endTime, db, tenantId);
    if (availErr) return res.status(400).json({ ok: false, error: availErr });
  } else {
    const available = findAvailableStaff(date.trim(), time.trim(), endTime, branch.trim(), db, tenantId);
    if (available.length > 0) {
      const picked = available[Math.floor(Math.random() * available.length)];
      staff_id = picked.id;
      staff_name = picked.name;
      staffRequested = 0;
    }
  }

  const r = db.prepare(`
    INSERT INTO ${tenantId}_bookings
      (customer_name, phone, service, branch, date, time, endTime, notes, status, source, staff_id, staff_name, staffRequested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'manual', ?, ?, ?)
  `).run(
    customer_name.trim(), phone.trim(), service.trim(), branch.trim(),
    date.trim(), time.trim(), endTime, notes || null,
    staff_id || null, staff_name || null, staffRequested
  );

  const newBooking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(r.lastInsertRowid);

  if (staff_id && newBooking) {
    const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch.trim());
    try {
      db.prepare(`
        INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(staff_id, newBooking.id, branchRow?.id || null, `${date.trim()} ${time.trim()}`, `${date.trim()} ${endTime}`);
    } catch (e) { logger.error("[booking] staff_bookings insert:", e.message); }
  }

  patchCache(tenantId, "bookings", "upsert", newBooking).catch((e) =>
    logger.error("[cache] bookings upsert:", e.message)
  );
  res.json(newBooking);
});

app.put("/salon-admin/api/bookings/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();
  let { customer_name, phone, service, branch, date, time, notes, staff_id, staff_name, status } = req.body;

  // Normalize staff_id: empty string / "0" / 0 / null → null
  staff_id = (staff_id && staff_id !== "0") ? (parseInt(staff_id, 10) || null) : null;

  const errs = validateBookingBody(req.body, true);
  if (errs.length)
    return res.status(400).json({ ok: false, error: `Missing/invalid: ${errs.join(", ")}` });

  const staffBranchErr = checkStaffBranch(staff_id, branch.trim(), db, tenantId);
  if (staffBranchErr) return res.status(400).json({ ok: false, error: staffBranchErr });

  const duration = getServiceDuration(service.trim(), db, tenantId);
  const endTime = calculateEndTime(time.trim(), duration);

  const timingErr = checkBookingTimingWithEndTime(date.trim(), time.trim(), endTime, db, tenantId);
  if (timingErr) return res.status(400).json({ ok: false, error: timingErr });

  let staffRequested = staff_id ? 1 : 0;

  if (staff_id) {
    // Pass excludeBookingId so the existing booking doesn't conflict with itself
    const availErr = checkStaffAvailability(staff_id, date.trim(), time.trim(), endTime, db, tenantId, bookingId);
    if (availErr) return res.status(400).json({ ok: false, error: availErr });
  } else {
    const available = findAvailableStaff(date.trim(), time.trim(), endTime, branch.trim(), db, tenantId);
    if (available.length > 0) {
      const picked = available[Math.floor(Math.random() * available.length)];
      staff_id = picked.id;
      staff_name = picked.name;
      staffRequested = 0;
    }
  }

  db.prepare(`
    UPDATE ${tenantId}_bookings
    SET customer_name=?, phone=?, service=?, branch=?, date=?, time=?, endTime=?,
        notes=?, status=?, staff_id=?, staff_name=?, staffRequested=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    customer_name.trim(), phone.trim(), service.trim(), branch.trim(),
    date.trim(), time.trim(), endTime, notes || null,
    status || "confirmed", staff_id || null, staff_name || null, staffRequested,
    bookingId
  );

  // Refresh staff_bookings link
  db.prepare(`DELETE FROM ${tenantId}_staff_bookings WHERE bookingId = ?`).run(bookingId);
  if (staff_id) {
    const branchRow = db.prepare(`SELECT id FROM ${tenantId}_branches WHERE name = ?`).get(branch.trim());
    try {
      db.prepare(`
        INSERT INTO ${tenantId}_staff_bookings (staffId, bookingId, branchId, startTime, endTime, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(staff_id, bookingId, branchRow?.id || null, `${date.trim()} ${time.trim()}`, `${date.trim()} ${endTime}`);
    } catch (e) { logger.error("[booking] staff_bookings insert:", e.message); }
  }

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (updated)
    patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
      logger.error("[cache] bookings put:", e.message)
    );
  res.json({ ok: true });
});

app.patch("/salon-admin/api/bookings/:id/status", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();
  const newStatus = (req.body.status || "").toLowerCase();

  const VALID_STATUSES = ["confirmed", "canceled", "completed", "no_show"];
  if (!VALID_STATUSES.includes(newStatus))
    return res.status(400).json({ ok: false, error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });

  const current = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (!current) return res.status(404).json({ ok: false, error: "Booking not found" });

  const transitionErr = validateStatusTransition(current.status, newStatus);
  if (transitionErr) return res.status(400).json({ ok: false, error: transitionErr });

  db.prepare(`UPDATE ${tenantId}_bookings SET status=?, updated_at=datetime('now') WHERE id=?`)
    .run(newStatus, bookingId);

  if (["canceled", "no_show", "completed"].includes(newStatus))
    db.prepare(`UPDATE ${tenantId}_staff_bookings SET status=?, updated_at=datetime('now') WHERE bookingId=?`)
      .run(newStatus, bookingId);

  // Track metrics for completed bookings
  if (newStatus === "completed") {
    db.prepare(`
      INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, completed) VALUES (?, 1, 1)
      ON CONFLICT(phone) DO UPDATE SET completed = completed + 1, last_visit = ?, updated_at = datetime('now')
    `).run(current.phone, current.date);
    db.prepare(`
      INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
      VALUES (?, ?, 'completed', 'admin', 'Marked as completed via admin panel')
    `).run(bookingId, current.status);
  }

  if (newStatus === "canceled") {
    db.prepare(`
      INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
      VALUES (?, ?, 'canceled', 'admin', ?)
    `).run(bookingId, current.status, req.body.reason || "Canceled via admin panel");
  }

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (updated)
    patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
      logger.error("[cache] bookings status patch:", e.message)
    );
  res.json({ ok: true });
});

app.patch("/salon-admin/api/bookings/:id/no-show", requireTenantAuth, async (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();

  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });
  if (booking.status !== "confirmed")
    return res.status(400).json({ ok: false, error: "Only confirmed bookings can be marked as no-show" });

  db.prepare(`UPDATE ${tenantId}_bookings SET status='no_show', updated_at=datetime('now') WHERE id=?`).run(bookingId);
  db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='no_show', updated_at=datetime('now') WHERE bookingId=?`).run(bookingId);
  db.prepare(`
    INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, no_shows)
    VALUES (?, 1, 1)
    ON CONFLICT(phone) DO UPDATE SET no_shows = no_shows + 1, updated_at = datetime('now')
  `).run(booking.phone);
  db.prepare(`
    INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
    VALUES (?, 'confirmed', 'no_show', 'admin', 'Manually marked as no-show')
  `).run(bookingId);

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  await patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
    logger.error("[cache] no-show:", e.message)
  );
  res.json({ ok: true });
});

// Soft-delete: archive instead of physical delete so history is preserved
app.delete("/salon-admin/api/bookings/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const bookingId = req.params.id;
  const db = getDb();

  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "Booking not found" });

  db.prepare(`UPDATE ${tenantId}_bookings SET status='archived', updated_at=datetime('now') WHERE id=?`)
    .run(bookingId);
  db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='archived', updated_at=datetime('now') WHERE bookingId=?`)
    .run(bookingId);
  db.prepare(`
    INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
    VALUES (?, ?, 'archived', 'admin', 'Soft-deleted via admin panel')
  `).run(bookingId, booking.status);

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
    logger.error("[cache] bookings archive:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Clients & Customer Analytics
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/clients", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);

  if (cache?.bookings) {
    const map = new Map();
    cache.bookings.forEach((b) => {
      if (!map.has(b.phone))
        map.set(b.phone, { customer_name: b.customer_name, phone: b.phone, booking_count: 0, last_visit: b.date });
      const c = map.get(b.phone);
      c.booking_count++;
      if (b.date > c.last_visit) c.last_visit = b.date;
    });
    return res.json([...map.values()].sort((a, b) => b.last_visit.localeCompare(a.last_visit)));
  }

  const clients = getDb().prepare(`
    SELECT customer_name, phone, COUNT(*) AS booking_count, MAX(date) AS last_visit
    FROM ${tenantId}_bookings
    GROUP BY customer_name, phone
    ORDER BY last_visit DESC
  `).all();
  res.json(clients);
});

app.get("/salon-admin/api/customer-analytics", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();

  const analytics = {
    topCustomers: db.prepare(`
      SELECT name, phone, total_bookings, completed, no_shows, cancellations, total_spent
      FROM ${tenantId}_customer_metrics ORDER BY total_spent DESC LIMIT 20
    `).all(),
    repeatRate: db.prepare(`
      SELECT COUNT(DISTINCT phone) AS total_customers,
             SUM(CASE WHEN total_bookings > 1 THEN 1 ELSE 0 END) AS repeat_customers
      FROM ${tenantId}_customer_metrics
    `).get(),
    noShowRate: db.prepare(`
      SELECT SUM(no_shows) * 1.0 / NULLIF(SUM(total_bookings), 0) AS rate
      FROM ${tenantId}_customer_metrics
    `).get(),
    atRiskCustomers: db.prepare(`
      SELECT name, phone, no_shows, cancellations, total_bookings
      FROM ${tenantId}_customer_metrics
      WHERE no_shows > 2 OR (no_shows * 1.0 / NULLIF(total_bookings, 0)) > 0.3
      ORDER BY no_shows DESC LIMIT 10
    `).all(),
  };
  res.json(analytics);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Branches
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/branches", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.branches) return res.json(cache.branches);

  const branches = getDb().prepare(`SELECT * FROM ${tenantId}_branches ORDER BY number ASC`).all();
  res.json(branches);
});

app.post("/salon-admin/api/settings/branches", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, address, map_link, phone } = req.body;
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!address?.trim()) errs.push("address");
  if (!map_link?.trim() || !map_link.trim().startsWith("http")) errs.push("map_link (must start with http)");
  if (!phone?.trim()) errs.push("phone");
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  const db = getDb();
  const maxNum = db.prepare(`SELECT COALESCE(MAX(number), 0) AS m FROM ${tenantId}_branches`).get().m;
  const r = db.prepare(`
    INSERT INTO ${tenantId}_branches (number, name, address, map_link, phone)
    VALUES (?, ?, ?, ?, ?)
  `).run(maxNum + 1, name.trim(), address.trim(), map_link.trim(), phone.trim());
  const newBranch = db.prepare(`SELECT * FROM ${tenantId}_branches WHERE id = ?`).get(r.lastInsertRowid);
  patchCache(tenantId, "branches", "upsert", newBranch).catch((e) =>
    logger.error("[cache] branches insert:", e.message)
  );
  res.json(newBranch);
});

app.put("/salon-admin/api/settings/branches/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, address, map_link, phone } = req.body;
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!address?.trim()) errs.push("address");
  if (!map_link?.trim() || !map_link.trim().startsWith("http")) errs.push("map_link");
  if (!phone?.trim()) errs.push("phone");
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  const db = getDb();
  db.prepare(`
    UPDATE ${tenantId}_branches SET name=?, address=?, map_link=?, phone=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name.trim(), address.trim(), map_link.trim(), phone.trim(), req.params.id);
  const updated = db.prepare(`SELECT * FROM ${tenantId}_branches WHERE id = ?`).get(req.params.id);
  if (updated)
    patchCache(tenantId, "branches", "upsert", updated).catch((e) =>
      logger.error("[cache] branches update:", e.message)
    );
  res.json({ ok: true });
});

app.delete("/salon-admin/api/settings/branches/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  getDb().prepare(`DELETE FROM ${tenantId}_branches WHERE id=?`).run(req.params.id);
  patchCache(tenantId, "branches", "delete", { id: req.params.id }).catch((e) =>
    logger.error("[cache] branches delete:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Staff
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/staff", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.staff) return res.json(cache.staff);

  const staff = getDb().prepare(`
    SELECT s.*, b.name AS branch_name
    FROM ${tenantId}_staff s
    LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id
    ORDER BY s.name ASC
  `).all();
  res.json(staff);
});

app.post("/salon-admin/api/settings/staff", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, phone, role, branch_id, status } = req.body;
  const db = getDb();
  const validRoles = db.prepare(`SELECT name FROM ${tenantId}_staff_roles`).all().map((r) => r.name);
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!phone?.trim()) errs.push("phone");
  if (!role || !validRoles.includes(role)) errs.push(`role (${validRoles.join(", ")})`);
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  const r = db.prepare(`
    INSERT INTO ${tenantId}_staff (name, phone, role, branch_id, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), phone.trim(), role, branch_id || null, status || "active");
  const newStaff = db.prepare(`
    SELECT s.*, b.name AS branch_name FROM ${tenantId}_staff s
    LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id WHERE s.id = ?
  `).get(r.lastInsertRowid);
  patchCache(tenantId, "staff", "upsert", newStaff).catch((e) =>
    logger.error("[cache] staff insert:", e.message)
  );
  res.json(newStaff);
});

app.put("/salon-admin/api/settings/staff/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name, phone, role, branch_id, status } = req.body;
  const db = getDb();
  const validRoles = db.prepare(`SELECT name FROM ${tenantId}_staff_roles`).all().map((r) => r.name);
  const errs = [];
  if (!name?.trim()) errs.push("name");
  if (!phone?.trim()) errs.push("phone");
  if (!role || !validRoles.includes(role)) errs.push("role");
  if (errs.length)
    return res.status(400).json({ error: `Missing/invalid: ${errs.join(", ")}` });

  db.prepare(`
    UPDATE ${tenantId}_staff SET name=?, phone=?, role=?, branch_id=?, status=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name.trim(), phone.trim(), role, branch_id || null, status || "active", req.params.id);
  const updated = db.prepare(`
    SELECT s.*, b.name AS branch_name FROM ${tenantId}_staff s
    LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id WHERE s.id = ?
  `).get(req.params.id);
  if (updated)
    patchCache(tenantId, "staff", "upsert", updated).catch((e) =>
      logger.error("[cache] staff update:", e.message)
    );
  res.json({ ok: true });
});

app.delete("/salon-admin/api/settings/staff/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  getDb().prepare(`DELETE FROM ${tenantId}_staff WHERE id=?`).run(req.params.id);
  patchCache(tenantId, "staff", "delete", { id: req.params.id }).catch((e) =>
    logger.error("[cache] staff delete:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Timings
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/timings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.salonTimings) return res.json(cache.salonTimings);

  const rows = getDb().prepare(`SELECT * FROM ${tenantId}_salon_timings`).all();
  const result = {};
  rows.forEach((r) => { result[r.day_type] = r; });
  res.json(result);
});

app.put("/salon-admin/api/settings/timings", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { workday, weekend } = req.body;
  const timeRx = /^\d{2}:\d{2}$/;
  const errs = [];
  if (!workday?.open_time || !timeRx.test(workday.open_time)) errs.push("workday.open_time");
  if (!workday?.close_time || !timeRx.test(workday.close_time)) errs.push("workday.close_time");
  if (!weekend?.open_time || !timeRx.test(weekend.open_time)) errs.push("weekend.open_time");
  if (!weekend?.close_time || !timeRx.test(weekend.close_time)) errs.push("weekend.close_time");
  if (errs.length)
    return res.status(400).json({ error: `Invalid/missing: ${errs.join(", ")}` });
  if (workday.close_time <= workday.open_time)
    return res.status(400).json({ error: "Workday closing must be after opening" });
  if (weekend.close_time <= weekend.open_time)
    return res.status(400).json({ error: "Weekend closing must be after opening" });

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO ${tenantId}_salon_timings (day_type, open_time, close_time, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(day_type) DO UPDATE SET
      open_time  = excluded.open_time,
      close_time = excluded.close_time,
      updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    upsert.run("workday", workday.open_time, workday.close_time);
    upsert.run("weekend", weekend.open_time, weekend.close_time);
  })();

  const timings = db.prepare(`SELECT * FROM ${tenantId}_salon_timings`).all();
  const timingsMap = {};
  timings.forEach((t) => { timingsMap[t.day_type] = t; });
  patchCache(tenantId, "salonTimings", "replace", timingsMap).catch((e) =>
    logger.error("[cache] timings update:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: Staff Roles
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/roles", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  if (cache?.staffRoles) return res.json(cache.staffRoles);

  const roles = getDb().prepare(`SELECT * FROM ${tenantId}_staff_roles ORDER BY name ASC`).all();
  res.json(roles);
});

app.post("/salon-admin/api/settings/roles", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { name } = req.body;
  if (!name?.trim())
    return res.status(400).json({ error: "Role name is required" });
  const normalized = name.trim().toLowerCase();
  try {
    const db = getDb();
    const r = db.prepare(`INSERT INTO ${tenantId}_staff_roles (name) VALUES (?)`).run(normalized);
    const newRole = db.prepare(`SELECT * FROM ${tenantId}_staff_roles WHERE id = ?`).get(r.lastInsertRowid);
    patchCache(tenantId, "staffRoles", "upsert", newRole).catch((e) =>
      logger.error("[cache] roles insert:", e.message)
    );
    res.json(newRole);
  } catch (err) {
    if (err.message.includes("UNIQUE"))
      return res.status(400).json({ error: "Role already exists" });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/salon-admin/api/settings/roles/:id", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  getDb().prepare(`DELETE FROM ${tenantId}_staff_roles WHERE id = ?`).run(req.params.id);
  patchCache(tenantId, "staffRoles", "delete", { id: req.params.id }).catch((e) =>
    logger.error("[cache] roles delete:", e.message)
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Settings: General (currency etc.)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/settings/general", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const cache = getCache(tenantId);
  const base = cache?.appSettings ?? (() => {
    const rows = getDb().prepare(`SELECT key, value FROM ${tenantId}_app_settings`).all();
    const result = {};
    rows.forEach((r) => { result[r.key] = r.value; });
    return result;
  })();
  res.json({ ...base, tenantId });
});

app.put("/salon-admin/api/settings/general", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const { currency } = req.body;
  if (!currency?.trim())
    return res.status(400).json({ error: "Currency is required" });

  getDb().prepare(`
    INSERT INTO ${tenantId}_app_settings (key, value, updated_at) VALUES ('currency', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(currency.trim());

  invalidateSettingsCache();
  patchCache(tenantId, "appSettings", "upsert", { currency: currency.trim() }).catch((e) =>
    logger.error("[cache] appSettings patch:", e.message)
  );
  res.json({ ok: true });
});

// Update salon name
app.put("/salon-admin/api/salon-name", requireTenantAuth, (req, res) => {
  const { salon_name } = req.body;
  if (!salon_name?.trim())
    return res.status(400).json({ error: "salon_name is required" });
  updateSalonName(req.tenantId, salon_name.trim());
  res.json({ success: true, salon_name: salon_name.trim() });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Availability API (public — used by widget)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/availability/check", (req, res) => {
  const { branch, date, time, service, tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  if (!branch || !date || !time || !service)
    return res.status(400).json({ error: "branch, date, time, service required" });

  const db = getDb();
  const duration = getServiceDuration(service, db, tenantId);
  const endTime = calculateEndTime(time, duration);
  const staff = findAvailableStaff(date, time, endTime, branch, db, tenantId);
  const timingErr = checkBookingTimingWithEndTime(date, time, endTime, db, tenantId);

  res.json({
    available: staff.length > 0 && !timingErr,
    availableStaff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role })),
    timingError: timingErr,
    suggestedTimes: timingErr ? findNextAvailableSlots(date, branch, duration, db, tenantId) : [],
  });
});

app.get("/api/availability/slots", (req, res) => {
  const { branch, date, service, tenantId } = req.query;
  if (!branch || !date || !service || !tenantId)
    return res.status(400).json({ error: "branch, date, service, tenantId required" });

  const db = getDb();
  const duration = getServiceDuration(service, db, tenantId);
  const slots = findNextAvailableSlots(date, branch, duration, db, tenantId);
  res.json({ slots });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Customer self-service API (no admin auth — uses tenantId from query/body)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/customer/bookings", (req, res) => {
  const { phone, tenantId } = req.query;
  if (!phone) return res.status(400).json({ error: "phone required" });
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const db = getDb();
  const bookings = db.prepare(`
    SELECT * FROM ${tenantId}_bookings WHERE phone = ? ORDER BY date DESC, time DESC
  `).all(phone);
  const metrics = db.prepare(`SELECT * FROM ${tenantId}_customer_metrics WHERE phone = ?`).get(phone);
  res.json({ bookings, metrics });
});

app.post("/api/customer/cancel", async (req, res) => {
  const { bookingId, phone, reason, tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  if (!bookingId || !phone) return res.status(400).json({ error: "bookingId and phone required" });

  const db = getDb();
  const booking = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ? AND phone = ?`).get(bookingId, phone);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const settings = db.prepare(`
    SELECT value FROM ${tenantId}_business_settings WHERE key = 'cancellation_hours'
  `).get();
  const cancellationHours = settings ? parseInt(settings.value) : 24;
  const hoursUntil = (new Date(`${booking.date}T${booking.time}`) - new Date()) / 3_600_000;

  if (hoursUntil < cancellationHours)
    return res.status(400).json({
      error: `Cannot cancel within ${cancellationHours}h of appointment. Contact salon directly.`,
    });

  db.prepare(`
    UPDATE ${tenantId}_bookings SET status='canceled', cancellation_reason=?, updated_at=datetime('now')
    WHERE id=?
  `).run(reason || "Customer canceled", bookingId);
  db.prepare(`
    UPDATE ${tenantId}_staff_bookings SET status='canceled', updated_at=datetime('now') WHERE bookingId=?
  `).run(bookingId);
  db.prepare(`
    INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, cancellations) VALUES (?, 1, 1)
    ON CONFLICT(phone) DO UPDATE SET cancellations = cancellations + 1, updated_at = datetime('now')
  `).run(phone);
  db.prepare(`
    INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
    VALUES (?, ?, 'canceled', 'customer', ?)
  `).run(bookingId, booking.status, reason);

  const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(bookingId);
  await patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
    logger.error("[cache] cancel:", e.message)
  );
  res.json({ ok: true, message: "Booking cancelled", refundEligible: hoursUntil > 48 });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Booking Analytics (single source of truth)
//  GET /salon-admin/api/analytics?branch=&period=week&from=&to=&status=completed&tz=Asia/Karachi
//  status may be comma-separated: "confirmed,completed"
//  period shorthand: day|week|month|year (computed in salon timezone)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/analytics", requireTenantAuth, (req, res) => {
  const tenantId = req.tenantId;
  const db = getDb();
  // ✅ FIX: Default to "completed" so revenue calcs are semantically correct
  const { branch, from, to, status = "completed", period, tz = "UTC" } = req.query;

  // ✅ FIX: Accept comma-separated status values (e.g., "confirmed,completed")
  const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);

  // ✅ FIX: Compute date range from period using salon timezone
  let rangeFrom = from || null;
  let rangeTo = to || null;
  const serverTime = new Date().toISOString();

  if (period && !from && !to) {
    try {
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

      if (period === "day") {
        rangeFrom = todayStr;
        rangeTo = todayStr;
      } else if (period === "week") {
        const d = new Date(todayStr);
        d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
        rangeFrom = d.toISOString().slice(0, 10);
        rangeTo = todayStr;
      } else if (period === "month") {
        rangeFrom = todayStr.slice(0, 7) + "-01"; // First of month
        rangeTo = todayStr;
      } else if (period === "year") {
        rangeFrom = todayStr.slice(0, 4) + "-01-01";
        rangeTo = todayStr;
      }
    } catch {
      // period ignored if tz is invalid
    }
  }

  // Build WHERE clause
  const statusPlaceholders = statuses.map(() => "?").join(",");
  let sql = `SELECT b.*, s.price AS service_price FROM ${tenantId}_bookings b
             LEFT JOIN ${tenantId}_services s ON b.service = s.name
             WHERE b.status IN (${statusPlaceholders})`;
  const args = [...statuses];

  if (branch && branch !== "all") { sql += " AND b.branch = ?"; args.push(branch); }
  if (rangeFrom) { sql += " AND b.date >= ?"; args.push(rangeFrom); }
  if (rangeTo)   { sql += " AND b.date <= ?"; args.push(rangeTo); }

  const bookings = db.prepare(sql).all(...args);

  // ── Aggregations (all derived from the same query result) ─────────────────
  const totalRevenue = bookings.reduce((sum, b) => {
    const price = parseFloat(String(b.service_price || "0").replace(/[^0-9.]/g, "")) || 0;
    return sum + price;
  }, 0);

  const serviceMap = {};
  const dealMap = {};
  const revenueByService = {};

  for (const b of bookings) {
    const svc = b.service || "Unknown";
    serviceMap[svc] = (serviceMap[svc] || 0) + 1;

    const price = parseFloat(String(b.service_price || "0").replace(/[^0-9.]/g, "")) || 0;
    revenueByService[svc] = (revenueByService[svc] || 0) + price;

    if (b.deal_name) dealMap[b.deal_name] = (dealMap[b.deal_name] || 0) + 1;
  }

  const topServices = Object.entries(serviceMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count, revenue: revenueByService[name] || 0 }));

  const topDeals = Object.entries(dealMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const revenueByServiceArr = Object.entries(revenueByService)
    .sort((a, b) => b[1] - a[1])
    .map(([name, revenue]) => ({
      name,
      revenue,
      percent: totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 100) : 0,
    }));

  const bookingsByBranch = {};
  for (const b of bookings) {
    bookingsByBranch[b.branch || "Unknown"] = (bookingsByBranch[b.branch || "Unknown"] || 0) + 1;
  }

  res.json({
    totalRevenue,
    bookingCount: bookings.length,
    topServices,
    topDeals,
    revenueByService: revenueByServiceArr,
    bookingsByBranch,
    // ✅ Metadata: client can verify filter applied
    queryRange: { start: rangeFrom, end: rangeTo, tz },
    filtersApplied: { statuses, branch: branch || null, period: period || null },
    dataFreshAsOf: serverTime,
    serverTime,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Salon Admin — Webhook Config (per-tenant platform credentials)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/salon-admin/api/webhook-config", requireTenantAuth, (req, res) => {
  const config = getWebhookConfig(req.tenantId);
  if (!config) return res.json({});
  // Never return tokens to the frontend — return only metadata
  res.json({
    has_whatsapp: !!(config.wa_access_token),
    has_instagram: !!(config.ig_page_access_token),
    has_facebook: !!(config.fb_page_access_token),
    wa_phone_number_id: config.wa_phone_number_id || "",
    webhook_urls: {
      whatsapp:  `/webhooks/${req.tenantId}/whatsapp`,
      instagram: `/webhooks/${req.tenantId}/instagram`,
      facebook:  `/webhooks/${req.tenantId}/facebook`,
    },
  });
});

app.put("/salon-admin/api/webhook-config", requireTenantAuth, (req, res) => {
  const {
    wa_phone_number_id, wa_access_token, wa_verify_token,
    ig_page_access_token, ig_verify_token,
    fb_page_access_token, fb_verify_token,
  } = req.body;

  upsertWebhookConfig(req.tenantId, {
    wa_phone_number_id, wa_access_token, wa_verify_token,
    ig_page_access_token, ig_verify_token,
    fb_page_access_token, fb_verify_token,
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Run-seed utility
// ─────────────────────────────────────────────────────────────────────────────

app.get("/run-seed", async (req, res) => {
  if (req.query.key !== (process.env.SALON_DATA_KEY || "adminkey123"))
    return res.status(401).send("Unauthorized");
  const tenantId = req.query.tenantId;
  if (!tenantId) return res.status(400).send("tenantId required");

  try {
    delete require.cache[require.resolve("./db/seed.js")];
    require("./db/seed.js")(tenantId);

    const db = getDb();
    const updatedDeals = db.prepare(`SELECT * FROM ${tenantId}_deals ORDER BY id`).all();
    const updatedServices = db.prepare(`SELECT * FROM ${tenantId}_services ORDER BY branch, name`).all();
    const updatedStaff = db.prepare(`
      SELECT s.*, b.name AS branch_name FROM ${tenantId}_staff s
      LEFT JOIN ${tenantId}_branches b ON s.branch_id = b.id ORDER BY s.name
    `).all();
    const settingRows = db.prepare(`SELECT key, value FROM ${tenantId}_app_settings`).all();
    const updatedSettings = {};
    settingRows.forEach((r) => { updatedSettings[r.key] = r.value; });

    await Promise.all([
      patchCache(tenantId, "deals", "replace", updatedDeals),
      patchCache(tenantId, "services", "replace", updatedServices),
      patchCache(tenantId, "staff", "replace", updatedStaff),
      patchCache(tenantId, "appSettings", "replace", updatedSettings),
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).send(err.toString());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Super Admin — Auth
// ─────────────────────────────────────────────────────────────────────────────

app.get("/super-admin/login", (_req, res) => {
  const fp = path.join(__dirname, "admin/views/super-login.html");
  res.sendFile(fp, (err) => {
    if (err) res.status(500).send("super-login.html not found");
  });
});

app.post("/super-admin/login", (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimit(`login:super:${ip}`, 3, 15 * 60_000))
    return res.status(429).send("Too many login attempts. Try again in 15 minutes.");

  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).send("Username and password required");

  const superDb = getSuperDb();
  try {
    const admin = superDb.prepare("SELECT * FROM super_admin WHERE username = ?").get(username);
    if (admin && bcrypt.compareSync(password, admin.password_hash)) {
      const token = jwt.sign(
        { username: admin.username, role: "super_admin", email: admin.email },
        JWT_SECRET,
        { expiresIn: "1d" }
      );
      res.cookie("superAdminSession", token, { httpOnly: true, sameSite: "lax", maxAge: 86_400_000, path: "/" });
      // Support both JSON fetch (frontend) and HTML form POST (legacy)
      if (req.headers["content-type"]?.includes("application/json")) {
        return res.json({ ok: true });
      }
      return res.redirect("/super-admin/dashboard");
    }
    if (req.headers["content-type"]?.includes("application/json")) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }
    res.status(401).send("Invalid credentials");
  } catch (err) {
    logger.error("[super-admin login]", err.message);
    if (req.headers["content-type"]?.includes("application/json")) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.status(500).send("Login error: " + err.message);
  }
});

app.get("/super-admin/dashboard", requireSuperAdminAuth, (_req, res) => {
  const fp = path.join(__dirname, "admin/views/super-dashboard.html");
  res.sendFile(fp, (err) => {
    if (err) res.status(500).send("super-dashboard.html not found");
  });
});

app.get("/super-admin/logout", (_req, res) => {
  res.clearCookie("superAdminSession");
  res.redirect("/super-admin/login");
});

// ─────────────────────────────────────────────────────────────────────────────
//  Super Admin — API
// ─────────────────────────────────────────────────────────────────────────────

app.get("/super-admin/api/stats", requireSuperAdminAuth, (_req, res) => {
  try {
    const tenants = getAllTenants();
    res.json({
      total_tenants: tenants.length,
      active_tenants: tenants.filter((t) => t.status === "active").length,
      total_revenue: 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/super-admin/api/tenants", requireSuperAdminAuth, (_req, res) => {
  try {
    res.json(getAllTenants());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/super-admin/api/tenants", requireSuperAdminAuth, async (req, res) => {
  const { owner_name, salon_name, email, phone, password } = req.body;
  if (!owner_name || !salon_name || !email || !phone)
    return res.status(400).json({ error: "Missing required fields" });
  try {
    const generatedPassword = password || Math.random().toString(36).slice(-8);
    const tenantId = await createTenant(owner_name, salon_name, email, phone, generatedPassword);
    // Pre-warm cache for the new tenant
    await initCache(tenantId).catch((e) => logger.warn("[cache] new tenant init:", e.message));
    res.json({ success: true, tenant_id: tenantId, password: generatedPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/super-admin/api/tenants/:tenantId/status", requireSuperAdminAuth, (req, res) => {
  const { status } = req.body;
  if (!["active", "suspended"].includes(status))
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  try {
    updateTenantStatus(req.params.tenantId, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/super-admin/api/settings", requireSuperAdminAuth, (req, res) => {
  const { default_plan } = req.body;
  if (default_plan) process.env.DEFAULT_PLAN = default_plan;
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Background jobs
// ─────────────────────────────────────────────────────────────────────────────

async function autoMarkNoShowsForTenant(tenantId) {
  const db = getDb();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  try {
    const bookings = db.prepare(`
      SELECT id, date, time, endTime, customer_name, phone
      FROM ${tenantId}_bookings
      WHERE status = 'confirmed' AND date <= ?
      ORDER BY date, time
    `).all(todayStr);

    const nowMin = now.getHours() * 60 + now.getMinutes();
    let count = 0;

    for (const b of bookings) {
      const bDate = new Date(b.date);
      const today = new Date(); today.setHours(0, 0, 0, 0); bDate.setHours(0, 0, 0, 0);
      if (bDate > today) continue;

      const [bH, bM] = b.time.split(":").map(Number);
      const bMin = bH * 60 + bM;
      let endMin = bMin + 60;
      if (b.endTime) {
        const [eH, eM] = b.endTime.split(":").map(Number);
        endMin = eH * 60 + eM;
      }

      const isPast = bDate < today;
      const isToday = bDate.getTime() === today.getTime();
      if (!isPast && !(isToday && nowMin > endMin + NO_SHOW_GRACE_MIN)) continue;

      try {
        db.prepare(`UPDATE ${tenantId}_bookings SET status='no_show', updated_at=datetime('now') WHERE id=?`).run(b.id);
        db.prepare(`UPDATE ${tenantId}_staff_bookings SET status='no_show', updated_at=datetime('now') WHERE bookingId=?`).run(b.id);
        db.prepare(`
          INSERT INTO ${tenantId}_customer_metrics (phone, total_bookings, no_shows) VALUES (?, 1, 1)
          ON CONFLICT(phone) DO UPDATE SET no_shows = no_shows + 1, updated_at = datetime('now')
        `).run(b.phone);
        db.prepare(`
          INSERT INTO ${tenantId}_booking_audit (booking_id, old_status, new_status, changed_by, reason)
          VALUES (?, 'confirmed', 'no_show', 'system', 'Auto-marked after grace period')
        `).run(b.id);
        count++;
        const updated = db.prepare(`SELECT * FROM ${tenantId}_bookings WHERE id = ?`).get(b.id);
        await patchCache(tenantId, "bookings", "upsert", updated).catch((e) =>
          logger.error("[cache] no-show:", e.message)
        );
      } catch (e) {
        logger.error(`[NO-SHOW] Booking ${b.id}:`, e.message);
      }
    }
    if (count > 0) logger.info(`[NO-SHOW] ${tenantId}: auto-marked ${count} booking(s)`);
  } catch (e) {
    logger.error(`[NO-SHOW] Scan failed for ${tenantId}:`, e.message);
  }
}

async function sendRemindersForTenant(tenantId) {
  const db = getDb();
  const setting = db.prepare(`SELECT value FROM ${tenantId}_business_settings WHERE key='reminder_hours'`).get();
  const reminderHours = setting ? parseInt(setting.value) : 24;
  const target = new Date(); target.setHours(target.getHours() + reminderHours);
  const targetDate = target.toISOString().slice(0, 10);

  const bookings = db.prepare(`
    SELECT * FROM ${tenantId}_bookings
    WHERE status='confirmed' AND date=? AND reminder_sent=0
  `).all(targetDate);

  for (const b of bookings) {
    try {
      logger.info(`[REMINDER] ${tenantId} → ${b.phone}: ${b.time} ${b.service} @ ${b.branch}`);
      db.prepare(`UPDATE ${tenantId}_bookings SET reminder_sent=1 WHERE id=?`).run(b.id);
    } catch (e) {
      logger.error(`[REMINDER] Booking ${b.id}:`, e.message);
    }
  }
}

async function runJobsForAllTenants() {
  try {
    const tenants = getAllTenants();
    for (const t of tenants.filter((t) => t.status === "active")) {
      await sendRemindersForTenant(t.tenant_id).catch((e) =>
        logger.error(`[JOB] Reminders ${t.tenant_id}:`, e.message)
      );
      await autoMarkNoShowsForTenant(t.tenant_id).catch((e) =>
        logger.error(`[JOB] No-shows ${t.tenant_id}:`, e.message)
      );
    }
  } catch (e) {
    logger.error("[JOB] Failed:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Server startup
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
setupCallServer(server);

server.listen(PORT, async () => {
  logger.info(`Salon Bot server running on port ${PORT}`);
  await initializeAllTenants();
  getDb(); // ensure schema initialised

  // Optional migration
  // if (process.env.RUN_MIGRATION === "true") {
  //   const { migrateToMultiTenant } = require("./scripts/migrate-to-multitenant");
  //   migrateToMultiTenant().catch(console.error);
  // }

  // Pre-warm caches for all active tenants
  try {
    const tenants = getAllTenants();
    for (const t of tenants.filter((t) => t.status === "active")) {
      // Check if tenant has any staff before caching
      const db = getDb();
      const staffCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.tenant_id}_staff`).get();
      const serviceCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.tenant_id}_services`).get();

      console.log(`Tenant ${t.tenant_id}: Staff=${staffCount.count}, Services=${serviceCount.count}`);

      // Only initialize cache if there's data, otherwise skip
      if (staffCount.count > 0 || serviceCount.count > 0) {
        await initCache(t.tenant_id).catch((e) =>
          logger.error(`[cache] init ${t.tenant_id}:`, e.message)
        );
      } else {
        logger.info(`[cache] Skipping cache for ${t.tenant_id} - no data yet`);
      }
    }
    logger.info(`[cache] Warmed caches for tenants with data`);
  } catch (e) {
    logger.warn("[cache] Could not warm tenant caches on startup:", e.message);
  }

  // Initial no-show scan after 5 s
  setTimeout(() => runJobsForAllTenants(), 5_000);

  // Periodic jobs — every 15 min only (was incorrectly double-scheduled before)
  setInterval(() => runJobsForAllTenants(), NO_SHOW_SCAN_MS);

  logger.info("Server started successfully ✅");
});