import { expect, inject, it } from "vitest";

// Node's fetch doesn't keep a cookie jar between calls the way a browser
// does, so each simulated "browser" in these tests carries its own jar and
// resends whatever it was given — this is what makes two CookieJar
// instances behave like two independent, distinct identities.
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
  const location = res.headers.get("location");
  expect(location).toBeTruthy();
  const code = location?.split("/").pop();
  expect(code).toBeTruthy();
  return code as string;
}

async function pageText(jar: CookieJar, path: string): Promise<string> {
  const res = await jar.fetch(new URL(path, baseUrl));
  return res.text();
}

it("a first anonymous browser can create a campaign and becomes seat 1 / host", async () => {
  const a = new CookieJar();
  const code = await createCampaign(a);

  const page = await pageText(a, `/c/${code}`);
  expect(page).toContain("You are seat 1");
  expect(page).toContain("configuration-role host");
});

it("a second independent identity can join the open seat", async () => {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);

  const joinRes = await b.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
  expect(joinRes.status).toBe(303);

  const page = await pageText(b, `/c/${code}`);
  expect(page).toContain("You are seat 2");
});

it("the same identity revisiting join does not create a duplicate participant", async () => {
  const a = new CookieJar();
  const code = await createCampaign(a);

  const res = await a.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
  expect(res.status).toBe(303); // idempotent no-op, not an error

  const page = await pageText(a, `/c/${code}`);
  expect(page).toContain("You are seat 1");
  expect(page).toContain("Seat 2: open");
});

it("a third independent identity cannot take a seat once the campaign is full", async () => {
  const a = new CookieJar();
  const b = new CookieJar();
  const c = new CookieJar();
  const code = await createCampaign(a);

  await b.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });

  const res = await c.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
  expect(res.status).toBe(409);

  const page = await pageText(c, `/c/${code}`);
  expect(page).toContain("full");
});

it("the landing page lists an identity's own campaign under Your campaigns", async () => {
  const a = new CookieJar();
  const code = await createCampaign(a);

  const page = await pageText(a, "/");
  expect(page).toContain(code);
});

it("a different identity does not see another identity's campaign on the landing page", async () => {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);

  const page = await pageText(b, "/");
  expect(page).not.toContain(code);
});

it("a fresh visit issues a persistent (non-session) anonymous identity cookie", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const identityCookie = res.headers.getSetCookie().find((sc) => sc.startsWith("gs_identity="));

  expect(identityCookie).toBeTruthy();
  const cookie = identityCookie as string;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("SameSite=Lax");
  // Max-Age is what makes this a persistent cookie rather than session-only;
  // Secure is intentionally conditional on HTTPS and isn't asserted here.
  expect(cookie).toContain("Max-Age=31536000");
});

it("a client-submitted identity/seat/host claim in the request body is ignored", async () => {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);

  const res = await b.fetch(new URL(`/c/${code}/join`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: 1, seat: 1, isHost: true }),
  });
  expect(res.status).toBe(303);

  const page = await pageText(b, `/c/${code}`);
  expect(page).toContain("You are seat 2");
  expect(page).not.toContain("configuration-role host");
});
