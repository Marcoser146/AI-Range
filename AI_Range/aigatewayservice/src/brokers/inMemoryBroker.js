"use strict";

/**
 * inMemoryBroker.js - dev/test only, not for production.
 *
 * A minimal pub-sub that satisfies the { subscribe(topic, handler),
 * publish(topic, event) } interface eventAdapter.js depends on. Swap it out
 * for a real client in production - eventAdapter.js won't need to change
 * either way, since it only ever calls these two methods.
 *
 * Notes on mapping this to a real broker:
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
    this._published = []; // keeps everything published, so tests can inspect it
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
    // Run handlers concurrently, and don't let one subscriber blowing up
    // take down the others or the publisher.
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
