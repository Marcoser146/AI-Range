"use strict";

/**
 * inMemoryBroker.js — DEV/TEST ONLY.
 *
 * Minimal pub-sub satisfying the { subscribe(topic, handler), publish(topic,
 * event) } interface that eventAdapter.js depends on. Swap this out for a
 * real client in production; eventAdapter.js does not change either way
 * because it only ever calls these two methods.
 *
 * Mapping notes for real brokers:
 *   - Kafka:    subscribe -> kafkaConsumer.on('message', ...) per topic
 *                            (topic == Kafka topic, or a shared topic with
 *                            event-type routing on the "event" field)
 *               publish   -> producer.send({ topic, messages: [...] })
 *   - RabbitMQ: subscribe -> channel.consume(queueBoundToTopicExchange, ...)
 *               publish   -> channel.publish(exchange, routingKey=topic, ...)
 *   - NATS:     subscribe -> nc.subscribe(topic, { callback })
 *               publish   -> nc.publish(topic, jsonCodec.encode(event))
 */
class InMemoryBroker {
  constructor() {
    this._handlers = new Map(); // topic -> Set<handler>
    this._published = []; // audit trail for tests/inspection
  }

  subscribe(topic, handler) {
    if (!this._handlers.has(topic)) this._handlers.set(topic, new Set());
    this._handlers.get(topic).add(handler);
    return () => this._handlers.get(topic)?.delete(handler);
  }

  async publish(topic, event) {
    this._published.push({ topic, event, publishedAt: new Date().toISOString() });
    const handlers = this._handlers.get(topic);
    if (!handlers) return;
    // Fire handlers concurrently but don't let one subscriber's failure
    // break another's, or break the publisher.
    await Promise.all(
      [...handlers].map((handler) =>
        Promise.resolve()
          .then(() => handler(event))
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[inMemoryBroker] handler error on topic "${topic}":`, err);
          })
      )
    );
  }

  get publishedEvents() {
    return this._published;
  }
}

module.exports = { InMemoryBroker };
