// In-process pub/sub hub for Crit 9 realtime notifications (Slice 1:
// transport only — see docs/crit-9-architecture.md). Deliberately
// independent of db.ts: this module knows nothing about campaigns, players,
// resources or SQL. It only tracks subscriber callbacks keyed by a numeric
// campaign id and invokes them; the HTTP boundary (server.ts) is the only
// place that gives a subscriber call meaning (writing an actual SSE event).
//
// A single in-process Map, matching the single-Fly-machine deployment this
// slice targets. Scaling to more than one app instance would need a
// cross-process mechanism this module does not provide (see architecture doc
// section 2) — not implemented here.

type Subscriber = () => void | Promise<void>;

const subscribersByCampaignId = new Map<number, Set<Subscriber>>();

// Registers `subscriber` to be invoked (with no arguments — the hub carries
// no payload; see architecture doc section 4) every time `publish` is called
// for this campaign id. Returns a function that removes exactly this
// subscriber; calling the returned function more than once is harmless.
export function subscribe(campaignId: number, subscriber: Subscriber): () => void {
  let subscribers = subscribersByCampaignId.get(campaignId);
  if (!subscribers) {
    subscribers = new Set();
    subscribersByCampaignId.set(campaignId, subscribers);
  }
  subscribers.add(subscriber);

  return () => {
    removeSubscriber(campaignId, subscriber);
  };
}

function removeSubscriber(campaignId: number, subscriber: Subscriber): void {
  const subscribers = subscribersByCampaignId.get(campaignId);
  if (!subscribers) return;
  subscribers.delete(subscriber);
  if (subscribers.size === 0) subscribersByCampaignId.delete(campaignId);
}

// Notifies every current subscriber for `campaignId`. Safe to call with no
// subscribers registered (a no-op). Subscribers are snapshotted into an array
// before iterating, so a subscriber that unsubscribes itself (or another
// subscriber) during delivery doesn't corrupt the in-progress iteration.
//
// A subscriber that throws synchronously, or returns a promise that
// rejects, is treated as dead: it's removed and every other subscriber still
// gets notified. A rejecting promise is always given a .catch here, so this
// never leaves an unhandled rejection behind.
export function publish(campaignId: number): void {
  const subscribers = subscribersByCampaignId.get(campaignId);
  if (!subscribers) return;

  for (const subscriber of [...subscribers]) {
    try {
      const result = subscriber();
      if (result instanceof Promise) {
        result.catch(() => {
          removeSubscriber(campaignId, subscriber);
        });
      }
    } catch {
      removeSubscriber(campaignId, subscriber);
    }
  }
}

// Test support only: the registry itself is never exported, so callers
// observe behaviour through subscribe/publish. This exists only so a test
// can assert that cleanup actually happened, rather than inferring it from
// timing.
export function subscriberCount(campaignId: number): number {
  return subscribersByCampaignId.get(campaignId)?.size ?? 0;
}
