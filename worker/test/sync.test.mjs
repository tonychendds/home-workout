import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

test("register, login, per-record sync, tombstones, and CORS", { timeout: 180000 }, async () => {
  const server = await startWorker();
  try {
    const origin = "https://tonychendds.github.io";
    const health = await fetch(`${server.url}/`, { headers: { Origin: origin } });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "workout-sync");
    assert.equal(health.headers.get("access-control-allow-origin"), origin);

    const preflight = await fetch(`${server.url}/sync`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:4173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");

    const evil = await fetch(`${server.url}/`, { headers: { Origin: "https://evil.example" } });
    assert.notEqual(evil.headers.get("access-control-allow-origin"), "https://evil.example");

    const bad = await server.request("/auth/register", { method: "POST", body: { email: "tony", password: "short" } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).token, undefined);

    const created = await server.request("/auth/register", { method: "POST", body: { email: "Tony@Example.com", password: "correct-horse" } });
    assert.equal(created.status, 201);
    const account = await created.json();
    assert.equal(account.email, "tony@example.com");
    assert.match(account.token, /^[a-f0-9]{64}$/);

    const duplicate = await server.request("/auth/register", { method: "POST", body: { email: "tony@example.com", password: "correct-horse" } });
    assert.equal(duplicate.status, 409);

    const wrong = await server.request("/auth/login", { method: "POST", body: { email: "tony@example.com", password: "wrong-password" } });
    assert.equal(wrong.status, 401);

    const signedIn = await server.request("/auth/login", { method: "POST", body: { email: "tony@example.com", password: "correct-horse" } });
    assert.equal(signedIn.status, 200);
    const token = (await signedIn.json()).token;

    const exercise = {
      id: "c-squat",
      type: "exercise",
      updatedAt: 10,
      deleted: false,
      payload: { dayId: "lower", name: "Phone squat", dose: "3 x 8", how: "Squat.", photo: PHOTO, rest: 60 },
    };
    const hip = {
      id: "p-hip",
      type: "pf",
      updatedAt: 20,
      deleted: false,
      payload: { section: "hip", name: "Hip abduction", weight: 40.5, date: "2026-10-06", link: "https://example.com/hip", created: 20, photo: "" },
    };
    const progress = {
      id: "plan",
      type: "progress",
      updatedAt: 30,
      deleted: false,
      payload: { done: { upper: "2026-10-01T00:00:00.000Z" }, cursor: { lower: 1 } },
    };
    const first = await server.sync(token, [exercise, hip, progress]);
    assert.equal(first.status, 200);
    const stored = await first.json();
    assert.equal(stored.records.length, 3);
    assert.equal(stored.records.find((record) => record.id === "c-squat").payload.photo, PHOTO);
    assert.equal(stored.records.find((record) => record.id === "p-hip").payload.section, "hip");
    assert.equal(stored.records.find((record) => record.id === "p-hip").payload.weight, 40.5);
    assert.equal(stored.records.find((record) => record.id === "plan").payload.done.upper, "2026-10-01T00:00:00.000Z");

    const empty = await server.sync(token, []);
    const afterEmpty = await empty.json();
    assert.equal(afterEmpty.records.length, 3);
    assert.equal(afterEmpty.records.find((record) => record.id === "p-hip").payload.name, "Hip abduction");

    const older = { ...hip, updatedAt: 5, payload: { ...hip.payload, name: "Old name", weight: 10 } };
    await server.sync(token, [older]);
    const kept = await (await server.sync(token, [])).json();
    assert.equal(kept.records.find((record) => record.id === "p-hip").payload.name, "Hip abduction");

    const newer = { ...hip, updatedAt: 50, payload: { ...hip.payload, name: "Hip machine", weight: 55 } };
    await server.sync(token, [newer]);
    const renamed = await (await server.sync(token, [])).json();
    assert.equal(renamed.records.find((record) => record.id === "p-hip").payload.name, "Hip machine");

    const invalid = await server.sync(token, [{ ...exercise, id: "c-bad", payload: { ...exercise.payload, dayId: "legs" }, updatedAt: 60 }]);
    assert.equal(invalid.status, 400);
    const stillThere = await (await server.sync(token, [])).json();
    assert.equal(stillThere.records.length, 3);

    const hugePhoto = "data:image/jpeg;base64," + "a".repeat(80_001);
    const oversized = await server.sync(token, [{ ...exercise, id: "c-huge", payload: { ...exercise.payload, photo: hugePhoto }, updatedAt: 70 }]);
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /too large/i);
    assert.equal((await (await server.sync(token, [])).json()).records.length, 3);

    const tombstone = { ...exercise, deleted: true, updatedAt: 80, payload: null };
    assert.equal((await server.sync(token, [tombstone])).status, 200);
    const resurrect = { ...exercise, deleted: false, updatedAt: 90 };
    await server.sync(token, [resurrect]);
    const afterDelete = await (await server.sync(token, [])).json();
    assert.equal(afterDelete.records.find((record) => record.id === "c-squat").deleted, true);
    assert.equal(afterDelete.records.find((record) => record.id === "p-hip").deleted, false);

    const other = await server.request("/auth/register", { method: "POST", body: { email: "other-user", password: "correct-horse" } });
    const otherToken = (await other.json()).token;
    const otherBook = await (await server.sync(otherToken, [])).json();
    assert.deepEqual(otherBook.records, []);

    const pulled = await server.request("/sync", { token });
    assert.equal(pulled.status, 200);
    assert.equal((await pulled.json()).records.length, 3);

    const me = await (await server.request("/auth/me", { token })).json();
    assert.equal(me.email, "tony@example.com");

    await server.request("/auth/logout", { method: "POST", token });
    assert.equal((await server.sync(token, [])).status, 401);

    const again = await server.request("/auth/login", { method: "POST", body: { email: "tony@example.com", password: "correct-horse" } });
    const nextToken = (await again.json()).token;
    const restored = await (await server.sync(nextToken, [])).json();
    assert.equal(restored.records.find((record) => record.id === "p-hip").payload.link, "https://example.com/hip");
    assert.equal(restored.records.find((record) => record.id === "c-squat").deleted, true);
  } finally {
    await server.stop();
  }
});

async function startWorker() {
  const dir = await mkdtemp(path.join(tmpdir(), "workout-d1-"));
  const port = await freePort();
  const inspector = await freePort();
  const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
  await execFileAsync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "workout-sync", "--local", "--persist-to", dir],
    { cwd: workerDir, env },
  );
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", dir, "--show-interactive-dev-session=false", "--log-level", "log"],
    { cwd: workerDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const url = `http://127.0.0.1:${port}`;
  const ready = Date.now() + 90000;
  let up = false;
  while (Date.now() < ready) {
    if (child.exitCode != null) break;
    try {
      const response = await fetch(`${url}/`);
      if (response.ok) { up = true; break; }
    } catch { /* worker still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!up) {
    await stop(child);
    throw new Error(`wrangler dev did not start\n${logs}`);
  }
  return {
    url,
    stop: async () => {
      await stop(child);
      await rm(dir, { recursive: true, force: true });
    },
    request(pathname, { method = "GET", body, token, origin = "http://127.0.0.1:4173" } = {}) {
      return fetch(`${url}${pathname}`, {
        method,
        headers: {
          Origin: origin,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
    sync(token, records) {
      return this.request("/sync", { method: "POST", token, body: { records } });
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, 5000);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });
}
