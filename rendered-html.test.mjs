import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the DirectDrop upload experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>DirectDrop — Public video download links<\/title>/i);
  assert.match(html, /Upload once\. Share directly\./);
  assert.match(html, /Upload Video/);
  assert.match(html, /Range requests supported/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("declares durable R2 video storage and direct byte routes", async () => {
  const [hosting, worker] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(hosting, /"r2"\s*:\s*"VIDEOS"/);
  assert.match(worker, /Accept-Ranges/);
  assert.match(worker, /Content-Range/);
  assert.match(worker, /application\/octet-stream/);
  assert.match(worker, /request\.method === "HEAD"/);
  assert.match(worker, /resumeMultipartUpload/);
});
