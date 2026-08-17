"use strict";

/**
 * Optional Idempotency-Key support for POST endpoints that trigger a model
 * call. If a client retries the same request (say, after a timeout) with
 * the same key, they get the cached response back instead of triggering a
 * second, possibly different, AI call.
 *
 * This is in-memory with a TTL, which is fine for a single gateway instance
 * behind a load balancer with sticky routing. Once you're running more than
 * one replica, back it with Redis or similar instead.
 */
function createIdempotencyStore(ttlMs = 10 * 60 * 1000) {
  const store = new Map(); // keyed by idempotency key -> { status, body, expiresAt }

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
