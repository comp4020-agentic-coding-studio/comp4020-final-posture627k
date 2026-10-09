// In-process pub/sub hub for Card Clash room/match change notifications
// (D4B). A deliberately SEPARATE module from the project's existing
// realtime.ts, not a namespaced extension of it: that hub is keyed by a
// bare numeric id with no domain tag, and poker table ids and Card Clash
// room ids come from independent SQLite auto-increment sequences — two
// different domains could easily share the same numeric id, which would
// silently cross-wire notifications between a poker table and an unrelated
// Card Clash room. A second, fully independent Map removes that risk
// entirely without touching realtime.ts or any existing poker route.
//
// Mirrors realtime.ts's own proven discipline exactly (snapshot-before-
// iterate, dead-subscriber removal on throw/reject), with one addition: a
// publish carries a small `scope` tag ("room" | "match") so a single
// subscription can tell a viewer which of the two existing, already-
// privacy-filtered read endpoints (GET /rooms/:code and GET
// /rooms/:code/state) is worth refetching — never a payload beyond that.

export type CardClashInvalidationScope = "room" | "match";
type Subscriber = (scope: CardClashInvalidationScope) => void | Promise<void>;

const subscribersByRoomId = new Map<number, Set<Subscriber>>();

export function subscribeToCardClashRoom(roomId: number, subscriber: Subscriber): () => void {
  let subscribers = subscribersByRoomId.get(roomId);
  if (!subscribers) {
    subscribers = new Set();
    subscribersByRoomId.set(roomId, subscribers);
  }
  subscribers.add(subscriber);

  return () => {
    removeSubscriber(roomId, subscriber);
  };
}

function removeSubscriber(roomId: number, subscriber: Subscriber): void {
  const subscribers = subscribersByRoomId.get(roomId);
  if (!subscribers) return;
  subscribers.delete(subscriber);
  if (subscribers.size === 0) subscribersByRoomId.delete(roomId);
}

// Notifies every current subscriber for `roomId` with `scope`. A room
// change (create/join/ready) publishes "room"; a match change (start/any
// successfully committed, non-duplicate gameplay action) publishes
// "match". Safe to call with no subscribers (room creation routinely does,
// harmlessly). A subscriber that throws or rejects is treated as dead and
// removed; every other subscriber still gets notified.
export function publishCardClashRoomEvent(roomId: number, scope: CardClashInvalidationScope): void {
  const subscribers = subscribersByRoomId.get(roomId);
  if (!subscribers) return;

  for (const subscriber of [...subscribers]) {
    try {
      const result = subscriber(scope);
      if (result instanceof Promise) {
        result.catch(() => {
          removeSubscriber(roomId, subscriber);
        });
      }
    } catch {
      removeSubscriber(roomId, subscriber);
    }
  }
}

// Test support only, mirroring realtime.ts's own subscriberCount: lets a
// test assert cleanup actually happened without exposing the Map itself.
export function cardClashSubscriberCount(roomId: number): number {
  return subscribersByRoomId.get(roomId)?.size ?? 0;
}
