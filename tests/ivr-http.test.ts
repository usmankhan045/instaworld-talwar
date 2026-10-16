import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no test port"));
      server.close(() => resolve(address.port));
    });
  });
}

test("standalone HTTP API requires a token and accepts only test-number jobs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "talwar-ivr-http-"));
  const port = await freePort();
  const token = "test-token-012345678901234567890123";
  const child = spawn(process.execPath, ["--experimental-strip-types", "ivr-standalone/server.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {...process.env, IVR_DB_PATH: join(directory, "test.sqlite"), IVR_PORT: String(port), IVR_ADMIN_TOKEN: token, IVR_TEST_NUMBERS: "03001234567"},
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`${base}/jobs`, {headers: {Authorization: `Bearer ${token}`}});
        ready = response.ok;
        if (ready) break;
      } catch { /* server starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "standalone server started");
    assert.equal((await fetch(`${base}/jobs`)).status, 401);
    const rejected = await fetch(`${base}/jobs`, {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({reference: "TEST-HTTP", customerName: "Ali", productSummary: "Shawl", address: "Lahore", phone: "03009999999"}),
    });
    assert.equal(rejected.status, 400);
    const accepted = await fetch(`${base}/jobs`, {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({reference: "TEST-HTTP", customerName: "Ali", productSummary: "Shawl", address: "Lahore", phone: "03001234567"}),
    });
    assert.equal(accepted.status, 201);
    const job = await accepted.json() as {id: string; status: string};
    assert.equal(job.status, "queued");
    const detail = await fetch(`${base}/jobs/${job.id}`, {headers: {Authorization: `Bearer ${token}`}});
    assert.equal(detail.status, 200);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(directory, {recursive: true, force: true});
  }
});
