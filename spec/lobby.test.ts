import { expect, inject, it } from "vitest";

// Duplicated from campaigns.test.ts deliberately: that file is an existing
// Slice 2 test and is kept unchanged, so this slice's tests carry their own
// copy of the same small cookie-jar helper rather than factoring it out.
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

async function join(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/join`, baseUrl), { method: "POST" });
}

async function setPreset(jar: CookieJar, code: string, preset: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/settings`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `preset=${preset}`,
  });
}

async function approve(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/approve`, baseUrl), { method: "POST" });
}

async function start(jar: CookieJar, code: string): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/start`, baseUrl), { method: "POST" });
}

async function pageText(jar: CookieJar, code: string): Promise<string> {
  const res = await jar.fetch(new URL(`/c/${code}`, baseUrl));
  return res.text();
}

async function setUpFullCampaign(): Promise<{ a: CookieJar; b: CookieJar; code: string }> {
  const a = new CookieJar();
  const b = new CookieJar();
  const code = await createCampaign(a);
  await join(b, code);
  return { a, b, code };
}

it("the host can change the resource preset pre-start, which advances the revision", async () => {
  const { a, code } = await setUpFullCampaign();

  const before = await pageText(a, code);
  expect(before).toContain("Settings revision: 1");
  expect(before).toContain("Standard");

  const res = await setPreset(a, code, "rapid");
  expect(res.status).toBe(303);

  const after = await pageText(a, code);
  expect(after).toContain("Rapid");
  expect(after).toContain("Settings revision: 2");
});

it("a non-host cannot change settings", async () => {
  const { b, code } = await setUpFullCampaign();

  const res = await setPreset(b, code, "rapid");
  expect(res.status).toBe(403);

  const page = await pageText(b, code);
  expect(page).toContain("Standard");
  expect(page).toContain("Settings revision: 1");
});

it("changing settings invalidates approvals from both seats", async () => {
  const { a, b, code } = await setUpFullCampaign();

  await approve(a, code);
  await approve(b, code);
  const beforeChange = await pageText(a, code);
  expect(beforeChange).toContain("Ready to start: yes");

  await setPreset(a, code, "rapid");

  const afterChange = await pageText(a, code);
  expect(afterChange).toContain("Seat 1: occupied (host) — not approved current settings");
  expect(afterChange).toContain("Seat 2: occupied — not approved current settings");
  expect(afterChange).toContain("Ready to start: no");
});

it("resubmitting the already-active preset is a no-op and does not advance the revision", async () => {
  const { a, code } = await setUpFullCampaign();

  const res = await setPreset(a, code, "standard"); // already the default
  expect(res.status).toBe(303);

  const page = await pageText(a, code);
  expect(page).toContain("Settings revision: 1");
});

it("both participants can approve the current revision, and repeated approval is idempotent", async () => {
  const { a, b, code } = await setUpFullCampaign();

  expect((await approve(a, code)).status).toBe(303);
  expect((await approve(b, code)).status).toBe(303);
  expect((await approve(a, code)).status).toBe(303); // repeat: idempotent, not an error

  const page = await pageText(a, code);
  expect(page).toContain("Seat 1: occupied (host) — approved current settings");
  expect(page).toContain("Seat 2: occupied — approved current settings");
});

it("a single approval is not enough for derived readiness", async () => {
  const { a, code } = await setUpFullCampaign();

  await approve(a, code);

  const page = await pageText(a, code);
  expect(page).toContain("Ready to start: no");
});

it("both seats occupied plus both current-revision approvals makes the campaign ready", async () => {
  const { a, b, code } = await setUpFullCampaign();

  await approve(a, code);
  await approve(b, code);

  const page = await pageText(a, code);
  expect(page).toContain("Ready to start: yes");
});

it("a vacant required seat prevents readiness even if the lone participant approved", async () => {
  const a = new CookieJar();
  const code = await createCampaign(a);

  await approve(a, code);

  const page = await pageText(a, code);
  expect(page).toContain("Seat 2: open");
  expect(page).toContain("Ready to start: no");

  const res = await start(a, code);
  expect(res.status).toBe(409);
});

it("a non-host cannot start the match", async () => {
  const { a, b, code } = await setUpFullCampaign();
  await approve(a, code);
  await approve(b, code);

  const res = await start(b, code);
  expect(res.status).toBe(403);
});

it("the host cannot start before unanimous current-revision approval", async () => {
  const { a, b, code } = await setUpFullCampaign();
  await approve(a, code); // only one of two

  const res = await start(a, code);
  expect(res.status).toBe(409);
  void b; // present only to mirror the two-participant shape of this scenario
});

it("the host can start once both have approved, and the campaign transitions exactly once", async () => {
  const { a, b, code } = await setUpFullCampaign();
  await approve(a, code);
  await approve(b, code);

  const res = await start(a, code);
  expect(res.status).toBe(303);

  const page = await pageText(a, code);
  expect(page).toContain("Status: started.");

  const duplicate = await start(a, code);
  expect(duplicate.status).toBe(409);
});

it("settings cannot change after the match has started", async () => {
  const { a, b, code } = await setUpFullCampaign();
  await approve(a, code);
  await approve(b, code);
  await start(a, code);

  const res = await setPreset(a, code, "rapid");
  expect(res.status).toBe(409);

  const page = await pageText(a, code);
  expect(page).toContain("Standard");
});

it("an approval from a revision before a settings change never counts toward a later start", async () => {
  const { a, b, code } = await setUpFullCampaign();

  await approve(a, code);
  await approve(b, code); // both approve revision 1

  await setPreset(a, code, "rapid"); // revision advances to 2, old approvals are now stale

  await approve(b, code); // only B approves the new revision 2

  const res = await start(a, code);
  expect(res.status).toBe(409); // A's stale revision-1 approval must not count for revision 2
});

it("spoofed identity/seat/host/revision values in request bodies grant no authority", async () => {
  const { a, b, code } = await setUpFullCampaign();

  // B (the real seat-2, non-host participant) sends a well-formed settings
  // change with extra fields claiming to be seat 1 / host / a different
  // identity. The route only ever reads "preset" from the body and resolves
  // who's asking from B's own cookie-backed identity, so this must still be
  // rejected as a non-host change, not accepted because of the claims.
  const spoofedSettings = await b.fetch(new URL(`/c/${code}/settings`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "preset=rapid&identityId=1&seat=1&isHost=true",
  });
  expect(spoofedSettings.status).toBe(403);

  const unchanged = await pageText(a, code);
  expect(unchanged).toContain("Standard");
  expect(unchanged).toContain("Settings revision: 1");

  // B approves with a spoofed identityId/revision alongside the real action;
  // it must land as B's own real seat 2 for the real current revision, not
  // as whatever the body claimed.
  const approveSpoof = await b.fetch(new URL(`/c/${code}/approve`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identityId=1&revision=999",
  });
  expect(approveSpoof.status).toBe(303);

  const afterApprove = await pageText(a, code);
  expect(afterApprove).toContain("Seat 2: occupied — approved current settings");
  expect(afterApprove).toContain("Seat 1: occupied (host) — not approved current settings");

  // A spoofed start attempt from B (non-host) must also be rejected.
  const spoofedStart = await b.fetch(new URL(`/c/${code}/start`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "isHost=true",
  });
  expect(spoofedStart.status).toBe(403);
});
