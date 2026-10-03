import { expect, inject, it } from "vitest";

// Duplicated deliberately, as in the other HTTP spec files: existing test
// files are kept unchanged, so this slice's tests carry their own copy of
// the same small cookie-jar helper. Unlike spec/realtime.test.ts, these
// tests are pure black-box HTTP assertions (status codes and response body
// text) with no need to reach into realtime.ts's in-memory registry, so
// they run the same way as every other HTTP spec file here: against the
// externally-running app at `baseUrl`, not in-process.
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
      headers.set("cookie", [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    this.#absorb(response);
    return response;
  }
}

const baseUrl = inject("baseUrl");

function pageUrl(code: string): URL {
  return new URL(`/c/${code}`, baseUrl);
}

function liveUrl(code: string): URL {
  return new URL(`/c/${code}/live`, baseUrl);
}

async function createCampaign(jar: CookieJar): Promise<string> {
  const res = await jar.fetch(new URL("/campaigns", baseUrl), { method: "POST" });
  expect(res.status).toBe(303);
  const code = res.headers.get("location")?.split("/").pop();
  expect(code).toBeTruthy();
  return code as string;
}

async function join(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
}

async function approve(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/approve`, baseUrl), { method: "POST" });
}

async function start(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/start`, baseUrl), { method: "POST" });
}

async function build(jar: CookieJar, code: string, row: number, col: number): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/build`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `row=${row}&col=${col}`,
  });
}

async function startFullyApprovedCampaign(): Promise<{ a: CookieJar; b: CookieJar; code: string }> {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);
  await join(b, code);
  await approve(a, code);
  await approve(b, code);
  await start(a, code);
  return { a, b, code };
}

async function text(jar: CookieJar, url: URL): Promise<string> {
  return (await jar.fetch(url)).text();
}

it("GET /c/:code/live for an unknown campaign code 404s", async () => {
  const jar = new CookieJar();
  const res = await jar.fetch(liveUrl("NOSUCHCODE"));
  expect(res.status).toBe(404);
});

it("a participant's lobby /live fragment contains their own seat/status and host controls", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const fragment = await text(host, liveUrl(code));
  expect(fragment).toContain("You are seat 1");
  expect(fragment).toContain("configuration-role host");
  expect(fragment).toContain(`action="/c/${code}/settings"`);
  expect(fragment).toContain(`action="/c/${code}/approve"`);
});

it("a non-participant's /live fragment contains no participant-only controls", async () => {
  const host = new CookieJar();
  const stranger = new CookieJar();
  const code = await createCampaign(host);

  const fragment = await text(stranger, liveUrl(code));
  expect(fragment).not.toContain(`action="/c/${code}/settings"`);
  expect(fragment).not.toContain(`action="/c/${code}/approve"`);
  expect(fragment).not.toContain(`action="/c/${code}/start"`);
});

it("a started participant's /live fragment shows their own Resources line", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const fragment = await text(a, liveUrl(code));
  expect(fragment).toContain("Resources:");
});

it("a non-participant's /live fragment for a started campaign never reveals a resource balance", async () => {
  const { code } = await startFullyApprovedCampaign();
  const stranger = new CookieJar();

  const fragment = await text(stranger, liveUrl(code));
  expect(fragment).not.toContain("Resources:");
});

it("one participant's /live fragment never reveals the opponent's resource balance alongside their own", async () => {
  const { a, b, code } = await startFullyApprovedCampaign();
  await build(b, code, 6, 6); // opponent builds a resource building

  const fragment = await text(a, liveUrl(code));
  // Only ever one "Resources:" label exists — the viewer's own — never a
  // second, differently-scoped one for the opponent.
  const matches = fragment.match(/Resources:/g);
  expect(matches).toHaveLength(1);
});

it("the full campaign page contains exactly one #campaign-live wrapper", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const page = await text(host, pageUrl(code));
  const matches = page.match(/id="campaign-live"/g);
  expect(matches).toHaveLength(1);
});

it("a participant's full campaign page wires an EventSource to its own campaign events route", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const page = await text(host, pageUrl(code));
  expect(page).toContain(`new EventSource("/c/${code}/events")`);
});

it("a non-participant's full campaign page does not open an EventSource", async () => {
  const host = new CookieJar();
  const stranger = new CookieJar();
  const code = await createCampaign(host);

  const page = await text(stranger, pageUrl(code));
  expect(page).not.toContain("EventSource");
});

it("the participant's realtime script listens for both ready and campaign_changed", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const page = await text(host, pageUrl(code));
  expect(page).toContain('addEventListener("ready"');
  expect(page).toContain('addEventListener("campaign_changed"');
});

it("the participant's realtime script never listens for heartbeat", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const page = await text(host, pageUrl(code));
  expect(page).not.toContain('addEventListener("heartbeat"');
});

it("the /live fragment is not a full HTML document", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const fragment = await text(host, liveUrl(code));
  expect(fragment).not.toContain("<!doctype html>");
  expect(fragment).not.toContain("<html");
});

it("the /live fragment response is marked no-store/private", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const res = await host.fetch(liveUrl(code));
  const cacheControl = res.headers.get("cache-control") ?? "";
  expect(cacheControl).toContain("no-store");
  expect(cacheControl).toContain("private");
});

it("existing lobby controls still render unchanged inside the new wrapper", async () => {
  const host = new CookieJar();
  const code = await createCampaign(host);

  const page = await text(host, pageUrl(code));
  expect(page).toContain(`action="/c/${code}/settings"`);
  expect(page).toContain(`action="/c/${code}/approve"`);
  expect(page).toContain("Invite link");
});
