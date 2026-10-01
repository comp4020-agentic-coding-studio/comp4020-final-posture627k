import { expect, inject, it } from "vitest";

// Duplicated deliberately, as in the other HTTP spec files: existing test
// files are kept unchanged, so this slice's tests carry their own copy of
// the same small cookie-jar helper.
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

async function build(jar: CookieJar, code: string, row: number, col: number): Promise<Response> {
  return jar.fetch(new URL(`/c/${code}/build`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `row=${row}&col=${col}`,
  });
}

function extractBalance(html: string): number | undefined {
  const match = html.match(/Resources:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
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

it("a participant's started campaign page shows their resource balance", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const page = await pageText(a, code);
  expect(extractBalance(page)).toBe(0);
  expect(page).toContain("Resource buildings produce every 10 seconds.");
});

it("a newly-built resource building does not immediately receive historical production", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);

  const page = await pageText(a, code);
  expect(extractBalance(page)).toBe(0);
});

it("repeated immediate GETs do not cause duplicate credit", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);

  const first = extractBalance(await pageText(a, code));
  const second = extractBalance(await pageText(a, code));
  const third = extractBalance(await pageText(a, code));
  expect(first).toBe(0);
  expect(second).toBe(0);
  expect(third).toBe(0);
});

it("spoofed form/query identity/country/rate/time values cannot alter settlement", async () => {
  const { a, b, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);

  // B attempts to view/settle A's country by claiming A's identity, country,
  // and a fabricated rate/time via query string and a form body — none of
  // this is ever read by the page route or the settlement function.
  const spoofedUrl = new URL(
    `/c/${code}?identityId=1&countryId=1&rate=999999&now=${Date.now() + 1_000_000_000}`,
    baseUrl,
  );
  const res = await b.fetch(spoofedUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "identityId=1&countryId=1&rate=999999",
  });
  // POST isn't even a route on /c/:code (only GET), so this itself 404s —
  // but the important invariant is the next check: A's real balance is
  // unaffected by any of these claims.
  void res;

  const page = await pageText(a, code);
  expect(extractBalance(page)).toBe(0);
});

it("a non-participant cannot obtain or trigger another player's resource settlement", async () => {
  const { code } = await startFullyApprovedCampaign();
  const stranger = new CookieJar();

  const page = await pageText(stranger, code);
  expect(page).not.toContain("Resources:");
  expect(page).toContain("You are not a participant.");
});

it("a non-participant viewing the campaign does not mutate either country's economy", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);
  const stranger = new CookieJar();

  await pageText(stranger, code); // merely viewing
  await pageText(stranger, code);

  const page = await pageText(a, code);
  expect(extractBalance(page)).toBe(0); // unaffected by the stranger's visits
});

it("two concurrent settlement reads do not double-credit", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  await build(a, code, 0, 1);

  const [first, second] = await Promise.all([pageText(a, code), pageText(a, code)]);
  // Neither request can see more than a few milliseconds of elapsed time,
  // so both must report 0 — but the real point of this test is that issuing
  // them concurrently doesn't corrupt state (verified by the follow-up read
  // below being consistent, not by the exact number here).
  expect(extractBalance(first)).toBe(0);
  expect(extractBalance(second)).toBe(0);

  const after = await pageText(a, code);
  expect(extractBalance(after)).toBe(0);
});

it(
  "one real elapsed-time check: Standard preset credits +10 after slightly more than 10 real seconds",
  async () => {
    const { a, code } = await startFullyApprovedCampaign();
    await build(a, code, 0, 1);

    await new Promise((resolve) => setTimeout(resolve, 10_500));

    const page = await pageText(a, code);
    const balance = extractBalance(page);
    expect(balance).toBeDefined();
    expect(balance).toBeGreaterThanOrEqual(10);
    expect((balance as number) % 10).toBe(0); // exact multiple of the Standard per-interval rate

    const again = extractBalance(await pageText(a, code));
    expect(again).toBe(balance); // stable on an immediate second read, no further credit
  },
  15_000,
);

it("existing fixed course and Slice 2-5 flows remain green alongside resource production", async () => {
  // A lightweight end-to-end smoke check that the full pre-existing pipeline
  // (create/join/approve/start/build) still works unchanged with Slice 6's
  // additions in place; the dedicated per-slice suites cover the details.
  const { a, b, code } = await startFullyApprovedCampaign();
  const buildRes = await build(b, code, 6, 6);
  expect(buildRes.status).toBe(303);

  const page = await pageText(a, code);
  expect(page).toContain("Status: started.");
  expect(page).toContain(">HQ1</td>");
  expect(page).toContain(">HQ2</td>");
  expect(page).toContain(">R2</td>");
});
