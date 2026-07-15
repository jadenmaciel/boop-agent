#!/usr/bin/env node

const [command, code] = process.argv.slice(2);
if (command !== "approve" || !code) {
  console.error("Usage: boop approve <code>");
  process.exit(2);
}

const port = process.env.PORT ?? "3456";
const response = await fetch(`http://127.0.0.1:${port}/internal/approve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code }),
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(body.error ?? `Boop returned HTTP ${response.status}.`);
  process.exit(1);
}
console.log(body.result ?? "Approval recorded.");
