import { expect, inject, it } from "vitest";

// Duplicated deliberately, as in lobby.test.ts: existing Slice 2/3 test
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

// Counts rendered <td>LABEL</td> cells with an exact label, so "HQ1" isn't
// accidentally matched by a naive substring search for "1".
function countCells(html: string, label: string): number {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = html.match(new RegExp(`>${escaped}</td>`, "g"));
  return matches ? matches.length : 0;
}

function countTotalTiles(html: string): number {
  const matches = html.match(/<td class="tile/g);
  return matches ? matches.length : 0;
}

it("no world exists before a successful start", async () => {
  const a = new CookieJar();
  const code = await createCampaign(a);

  const page = await pageText(a, code);
  expect(page).not.toContain("table class=\"world\"");
  expect(page).not.toContain("HQ1");
  expect(page).not.toContain("HQ2");
});

it("a successful start creates exactly 64 tiles with the fixed symmetric layout", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  const page = await pageText(a, code);

  expect(countTotalTiles(page)).toBe(64);
  expect(countCells(page, "HQ1")).toBe(1);
  expect(countCells(page, "HQ2")).toBe(1);
  expect(countCells(page, "C1")).toBe(3); // the three non-HQ seat-1 starting tiles
  expect(countCells(page, "C2")).toBe(3); // the three non-HQ seat-2 starting tiles
  expect(countCells(page, "·")).toBe(56); // 64 - 4 - 4 neutral tiles
});

it("seat 1 owns exactly the four approved top-left starting tiles, HQ at (0,0)", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  const page = await pageText(a, code);

  expect(page).toContain('aria-label="row 0, column 0: headquarters, country 1"');
  expect(page).toContain('aria-label="row 0, column 1: owned by country 1"');
  expect(page).toContain('aria-label="row 1, column 0: owned by country 1"');
  expect(page).toContain('aria-label="row 1, column 1: owned by country 1"');
  // Exactly one HQ1 cell exists (the "exactly 64 tiles" test already checks
  // this globally; re-asserted here via the visible label, not the
  // aria-label/title text, to avoid double-counting the same cell's two
  // attributes that both carry the same description).
  expect(countCells(page, "HQ1")).toBe(1);
});

it("seat 2 owns exactly the four approved bottom-right starting tiles, HQ at (7,7)", async () => {
  const { a, code } = await startFullyApprovedCampaign();
  const page = await pageText(a, code);

  expect(page).toContain('aria-label="row 6, column 6: owned by country 2"');
  expect(page).toContain('aria-label="row 6, column 7: owned by country 2"');
  expect(page).toContain('aria-label="row 7, column 6: owned by country 2"');
  expect(page).toContain('aria-label="row 7, column 7: headquarters, country 2"');
  expect(countCells(page, "HQ2")).toBe(1);
});

it("a duplicate start attempt does not generate a duplicate world", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const duplicate = await a.fetch(new URL(`/c/${code}/start`, baseUrl), { method: "POST" });
  expect(duplicate.status).toBe(409);

  const page = await pageText(a, code);
  expect(countTotalTiles(page)).toBe(64);
  expect(countCells(page, "HQ1")).toBe(1);
  expect(countCells(page, "HQ2")).toBe(1);
});

it("the world is identical across repeated ordinary requests (no regeneration)", async () => {
  const { a, code } = await startFullyApprovedCampaign();

  const first = await pageText(a, code);
  const second = await pageText(a, code);
  const third = await pageText(a, code);

  const worldOf = (html: string) => html.slice(html.indexOf('<table class="world">'));
  expect(worldOf(first)).toBe(worldOf(second));
  expect(worldOf(second)).toBe(worldOf(third));
});

it("a non-participant viewing a started campaign sees the world but no game controls", async () => {
  const { code } = await startFullyApprovedCampaign();
  const stranger = new CookieJar();

  const page = await pageText(stranger, code);
  expect(page).toContain("You are not a participant.");
  expect(countTotalTiles(page)).toBe(64);
  expect(page).not.toContain('action="/c/');
});
