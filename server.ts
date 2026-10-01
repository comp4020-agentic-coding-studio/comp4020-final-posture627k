import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

// Co-located with this file so it resolves the same way locally and in the
// Docker image, regardless of the process's working directory.
const readmePath = new URL("./README.md", import.meta.url);

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const app = new Hono();

app.get("/", (c) =>
  c.html(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Grid Strategy</title>
  </head>
  <body>
    <main>
      <h1>Grid Strategy (working title)</h1>
      <p>This is the Crit 8 foundation: a real Node/Hono server has replaced
      the placeholder runtime. No campaign, lobby, world or resource systems
      are implemented yet.</p>
      <p><a href="/readme/">About this project</a></p>
    </main>
  </body>
</html>
`),
);

app.get("/readme/", (c) => {
  const readme = readFileSync(readmePath, "utf8");
  return c.html(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About</title>
  </head>
  <body>
    <main>
      <h1>About</h1>
      <pre>${escapeHtml(readme)}</pre>
    </main>
  </body>
</html>
`);
});

const port = Number(process.env.PORT) || 8080;

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
