"use strict";

const config = require("./config");

let pool = null;

/**
 * Lazily requires and constructs a `pg` Pool the first time a Postgres-
 * backed store (jobStore, audit, approvalStore) actually needs one, and
 * only then. Keeping the `require("pg")` inside this function - instead of
 * at module load time - means memory-mode dev/test runs (the default,
 * including `npm test`) never need the `pg` package installed at all; only
 * a deployment that actually sets *_STORE_MODE=postgres does.
 */
function getPool() {
  if (pool) return pool;
  if (!config.db.url) {
    throw new Error(
      "[ai-gateway] db: DATABASE_URL is not set - Postgres-backed stores need it, see .env.example."
    );
  }
  let Pool;
  try {
    // eslint-disable-next-line global-require
    ({ Pool } = require("pg"));
  } catch {
    throw new Error(
      '[ai-gateway] db: the "pg" package is not installed. Run `npm install pg` on the tower ' +
        "to use a *_STORE_MODE=postgres setting (memory mode needs no extra dependency)."
    );
  }
  pool = new Pool({ connectionString: config.db.url });
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
