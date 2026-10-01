import { expect, inject, it } from "vitest";

// Duplicated deliberately, as in lobby.test.ts and world.test.ts: existing
// test files are kept unchanged, so this slice's tests carry their own copy
// of the same small cookie-jar helper.
class CookieJar {
  #cookies = new Map<string, string>();

  #absorb(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    this.#absorb(response);
    return response;
  }
}

const baseUrl = inject("baseUrl");

async function createCampaign(jar: CookieJar): Promise<string> {
  const res = await jar.fetch(new URL("/campaigns", baseUrl), { method: "POST" });
  expect(res.status).toBe(303);
  const code = res.headers.get("location")?.split("/").pop();
  expect(code).toBeTruthy();
  return code as string;
}

async function pageText(jar: CookieJar, code: string): Promise<string> {
  const res = await jar.fetch(new URL(`/c/${code}`, baseUrl));
  return res.text();
}

async function build(jar: CookieJar, code: string, row: unknown, col: unknown): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/build`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `row=${encodeURIComponent(String(row))}&col=${encodeURIComponent(String(col))}`,
  });
}

async function startFullyApprovedCampaign(): Promise<{ a: CookieJar; b: CookieJar; code: string }> {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);
  await b.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
  await a.fetch(new URL(`/c/${code}/approve`, baseUrl), { method: "POST" });
  await b.fetch(new URL(`/c/${code}/approve`, baseUrl), { method: "POST" });
  await a.fetch(new URL(`/c/${code}/start`, baseUrl), { method: "POST" });
  return { a, b, code };
}

function countBuildForms(html: string, code: string): number {
  const matches = html.match(new RegExp(`<form method="post" action="/c/${code}/build"`, "g"));
  return matches ? matches.length : 0;
}

it("participant 1 can build a resource building on an owned empty tile", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const res = await build(a, code, 0, 1);
  expect(res.status).toBe(303);

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 0, column 1: resource building, country 1"');
  expect(page).toContain(">R1</td>");
});

it("participant 2 can build a resource building on an owned empty tile", async () => {
  const { a, b, code } = await startFullyApprovedCampaign();

  const res = await build(b, code, 6, 6);
  expect(res.status).toBe(303);

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 6, column 6: resource building, country 2"');
  expect(page).toContain(">R2</td>");
});

it("the resulting building belongs to the correct country and occupies exactly the requested tile", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 1, 1);

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 1, column 1: resource building, country 1"');
  // No other previously-empty seat-1 tile was touched.
  expect(page).toContain('aria-label="row 0, column 1: owned by country 1"');
  expect(page).toContain('aria-label="row 1, column 0: owned by country 1"');
});

it("the headquarters tile cannot receive another building", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const res = await build(a, code, 0, 0);
  expect(res.status).toBe(409);

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 0, column 0: headquarters, country 1"');
});

it("an already-occupied resource-building tile cannot receive another building", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);

  const res = await build(a, code, 0, 1);
  expect(res.status).toBe(409);
});

it("a neutral tile cannot be built on", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const res = await build(a, code, 3, 3);
  expect(res.status).toBe(403);

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 3, column 3: neutral"');
});

it("an enemy-owned tile cannot be built on", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const res = await build(a, code, 6, 6); // belongs to country 2
  expect(res.status).toBe(403);

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 6, column 6: owned by country 2"');
});

it("a coordinate outside 0..7 is rejected", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  expect((await build(a, code, 8, 0)).status).toBe(400);
  expect((await build(a, code, 0, -1)).status).toBe(400);
});

it("a malformed coordinate is rejected", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  expect((await build(a, code, "abc", 0)).status).toBe(400);
  expect((await build(a, code, "1.5", 0)).status).toBe(400);
});

it("a non-participant cannot construct", async () => {
  const { code } = await startFullyApprovedCampaign();
  const stranger = new CookieJar();

  const res = await build(stranger, code, 0, 1);
  expect(res.status).toBe(403);
});

it("a client-submitted spoofed country/seat/identity/host value grants no authority", async () => {
  const { a, b, code } = await startFullyApprovedCampaign();

  // B (seat 2) attempts to build on A's (seat 1) empty tile, claiming to be
  // country/seat 1 via extra body fields the route never reads.
  const res = await b.fetch(new URL(`/c/${code}/build`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "row=0&col=1&countryId=1&seat=1&identityId=999&isHost=true",
  });
  expect(res.status).toBe(403); // rejected as not owning that tile, regardless of the claims

  const page = await pageText(a, code);
  expect(page).toContain('aria-label="row 0, column 1: owned by country 1"'); // untouched, still empty
});

it("construction before match start is rejected", async () => {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);
  await b.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
  // Not approved/started yet.

  const res = await build(a, code, 0, 1);
  expect(res.status).toBe(409);
});

it("two conflicting build attempts for the same tile result in exactly one building", async () => {
  const { a, b, code } = await startFullyApprovedCampaign();

  // B can't legally build on A's tile anyway, but to exercise the same-tile
  // race on a tile a single identity is actually allowed to touch, fire two
  // concurrent requests from A at the same coordinate.
  const [first, second] = await Promise.all([build(a, code, 0, 1), build(a, code, 0, 1)]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([303, 409]); // exactly one winner, one clean conflict

  const page = await pageText(a, code);
  // Exactly one R1 cell exists — matched on the visible label, not the
  // description text, since that same text appears in both the aria-label
  // and title attributes of one cell and would double-count a single match.
  const matches = page.match(/>R1<\/td>/g);
  expect(matches).toHaveLength(1); // exactly one building exists, not two
});

it("repeated subsequent GET requests do not regenerate or duplicate the building", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);

  const first = await pageText(a, code);
  const second = await pageText(a, code);
  const worldOf = (html: string) => html.slice(html.indexOf('<table class="world">'));
  expect(worldOf(first)).toBe(worldOf(second));
});

it("the started world page visibly renders the resource building", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 1, 0);

  const page = await pageText(a, code);
  expect(page).toContain(">R1</td>");
});

it("a non-participant's world view has no construction control", async () => {
  const { code } = await startFullyApprovedCampaign();
  const stranger = new CookieJar();

  const page = await pageText(stranger, code);
  expect(countBuildForms(page, code)).toBe(0);
});
