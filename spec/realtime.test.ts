import { expect, it } from "vitest";
import { publish, subscribe, subscriberCount } from "../realtime.ts";

// Hub-direct tests: exercise realtime.ts's exported functions with no HTTP
// and no database at all — the module has none of its own, and nothing
// about it is specific to any particular domain (it was written for the
// strategy-war product's campaigns and is reused completely unchanged for
// poker tables; both are just numeric ids to this module).
//
// The HTTP/SSE boundary tests that used to live in this file exercised the
// strategy-war product's own routes (/campaigns, /c/:code/events), which
// were removed when the project pivoted to poker. Equivalent HTTP-level SSE
// coverage for the poker routes lives in spec/poker.test.ts instead.

let nextId = 900_000;
function freshId(): number {
  return nextId++;
}

it("publishing to an id with no subscribers is a safe no-op", () => {
  expect(() => publish(freshId())).not.toThrow();
});

it("a single subscriber receives exactly one notification per publish", () => {
  const id = freshId();
  let calls = 0;
  subscribe(id, () => {
    calls++;
  });

  publish(id);

  expect(calls).toBe(1);
});

it("two subscribers to the same id both receive the publish", () => {
  const id = freshId();
  let callsA = 0;
  let callsB = 0;
  subscribe(id, () => {
    callsA++;
  });
  subscribe(id, () => {
    callsB++;
  });

  publish(id);

  expect(callsA).toBe(1);
  expect(callsB).toBe(1);
});

it("a publish for one id never reaches a subscriber of a different id", () => {
  const idA = freshId();
  const idB = freshId();
  let calls = 0;
  subscribe(idA, () => {
    calls++;
  });

  publish(idB);

  expect(calls).toBe(0);
});

it("unsubscribing prevents future delivery", () => {
  const id = freshId();
  let calls = 0;
  const unsubscribe = subscribe(id, () => {
    calls++;
  });

  unsubscribe();
  publish(id);

  expect(calls).toBe(0);
});

it("a synchronously-throwing subscriber does not prevent another subscriber from receiving the same publish", () => {
  const id = freshId();
  let callsB = 0;
  subscribe(id, () => {
    throw new Error("subscriber A is broken");
  });
  subscribe(id, () => {
    callsB++;
  });

  expect(() => publish(id)).not.toThrow();
  expect(callsB).toBe(1);
});

it("a subscriber whose promise rejects does not prevent another subscriber from receiving the same publish", () => {
  const id = freshId();
  let callsB = 0;
  subscribe(id, async () => {
    throw new Error("subscriber A fails asynchronously");
  });
  subscribe(id, () => {
    callsB++;
  });

  expect(() => publish(id)).not.toThrow();
  expect(callsB).toBe(1);
});

it("a synchronously-throwing subscriber is removed from the registry", () => {
  const id = freshId();
  subscribe(id, () => {
    throw new Error("broken");
  });
  subscribe(id, () => {});
  expect(subscriberCount(id)).toBe(2);

  publish(id);

  expect(subscriberCount(id)).toBe(1);
});

it("a subscriber whose promise rejects is removed from the registry, with no unhandled rejection", async () => {
  const id = freshId();
  subscribe(id, async () => {
    throw new Error("async failure");
  });
  subscribe(id, () => {});
  expect(subscriberCount(id)).toBe(2);

  publish(id);
  // The rejection is caught asynchronously (a microtask); give it one tick
  // to settle rather than asserting immediately or sleeping for real time.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(subscriberCount(id)).toBe(1);
});
