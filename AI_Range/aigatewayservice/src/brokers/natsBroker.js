"use strict";

const config = require("../config");

/**
 * natsBroker.js - the real broker adapter for EVENT_BROKER_MODE=nats.
 *
 * Implements the same { subscribe(topic, handler), publish(topic, event) }
 * interface as InMemoryBroker (see brokers/inMemoryBroker.js for the notes
 * on mapping this to other broker technologies), so eventAdapter.js does
 * not need to change at all to use this instead - it only ever calls those
 * two methods.
 *
 * The `nats` package is required lazily, inside connect(), the same way
 * src/db.js lazily requires `pg` - so memory-mode dev/test runs (including
 * `npm test`) never need it installed. Only a deployment that actually sets
 * EVENT_BROKER_MODE=nats does.
 */
function createNatsBroker({ url = config.natsUrl } = {}) {
  let nc = null;
  let sc = null; // string codec
  const subscriptions = new Map(); // topic -> Set<{ handler, natsSub }>

  async function connect() {
    if (nc) return nc;
    let connect_, StringCodec; // eslint-disable-line camelcase
    try {
      // eslint-disable-next-line global-require
      ({ connect: connect_, StringCodec } = require("nats"));
    } catch {
      throw new Error(
        '[ai-gateway] natsBroker: the "nats" package is not installed. Run `npm install nats` ' +
          "on the tower to use EVENT_BROKER_MODE=nats."
      );
    }
    nc = await connect_({ servers: url });
    sc = StringCodec();
    return nc;
  }

  function subscribe(topic, handler) {
    const entry = { handler, natsSub: null };
    if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
    subscriptions.get(topic).add(entry);

    // subscribe() is synchronous from the caller's point of view (matches
    // InMemoryBroker), but the actual NATS subscription is async - queue it
    // up without making callers await a connection handshake.
    connect()
      .then((conn) => {
        entry.natsSub = conn.subscribe(topic);
        (async () => {
          for await (const msg of entry.natsSub) {
            try {
              const event = JSON.parse(sc.decode(msg.data));
              await entry.handler(event);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(`[natsBroker] handler error on topic "${topic}":`, err.message);
            }
          }
        })();
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[natsBroker] failed to subscribe to "${topic}":`, err.message);
      });

    return () => {
      subscriptions.get(topic)?.delete(entry);
      entry.natsSub?.unsubscribe();
    };
  }

  async function publish(topic, event) {
    const conn = await connect();
    conn.publish(topic, sc.encode(JSON.stringify(event)));
  }

  async function close() {
    await nc?.drain();
    nc = null;
  }

  return { subscribe, publish, close, connect };
}

module.exports = { createNatsBroker };
