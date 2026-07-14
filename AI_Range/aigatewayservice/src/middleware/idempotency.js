"use strict";

/**
 * Optional Idempotency-Key support for POST endpoints that trigger a model
 * call. If a client retries a request (e.g. after a timeout) with the same
 * key, they get back the cached response instead of triggering a second
 * (possibly divergent) AI call.
 *
 * In-memory + TTL only — fine for a single gateway instance behind a
 * load balancer with sticky routing; back this with Redis (or similar) once
 * you run more than one replica.
 */
function createIdempotencyStore(ttlMs = 10 * 60 * 1000) {
  const store = new Map(); // key -> { status, body, expiresAt }

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  }

  function middleware(req, res, next) {
    const key = req.get("idempotency-key");
    if (!key) return next();

    sweep();
    const cached = store.get(key);
    if (cached) {
      res.setHeader("Idempotency-Replayed", "true");
      return res.status(cached.status).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      store.set(key, { status: res.statusCode, body, expiresAt: Date.now() + ttlMs });
      return originalJson(body);
    };

    next();
  }

  return { middleware, store };
}

module.exports = { createIdempotencyStore };
