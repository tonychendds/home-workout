import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "worker");
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const PASSWORD = "correct-horse";
const LOGIN = "tony@example.com";

const browserArgs = ["--no-sandbox", "--disable-dev-shm-usage"];

async function main() {
  const worker = await startWorker();
  const site = await startSite(root);
  const appUrl = `${site.url}?sync=${encodeURIComponent(worker.url)}`;
  const browsers = [];
  try {
    const html = await (await fetch(site.url)).text();
    assert.match(html, /https:\/\/workout-sync\.tonychendds\.workers\.dev/);
    assert.doesNotMatch(html, /localStorage\.clear\s*\(/);
    const manifest = await (await fetch(`${site.url}manifest.json`)).json();
    assert.equal(manifest.name, "Workout");
    assert.equal(manifest.short_name, "Workout");

    const phone = await launch(browsers, true);
    const page = await openApp(phone, appUrl, true);
    assert.equal(await page.title(), "Workout");
    await page.waitForFunction(() => {
      const text = document.querySelector("#sync-banner p")?.textContent || "";
      return text === "Not signed in. Your workouts stay on this phone only.";
    });
    assert.equal(await persistCount(page) >= 1, true);

    await page.evaluate(async () => {
      localStorage.setItem("other-app-key", "keep");
      const cache = await caches.open("other-app-cache");
      await cache.put("/other-marker", new Response("keep"));
      await new Promise((resolve, reject) => {
        const req = indexedDB.open("other-app-db", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("items");
        req.onsuccess = () => { req.result.close(); resolve(); };
        req.onerror = () => reject(req.error);
      });
    });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector("#sync-banner p")?.textContent.includes("Not signed in"));
    await page.evaluate(async () => {
      if (localStorage.getItem("other-app-key") !== "keep") throw new Error("foreign localStorage was removed");
      if (window.__storageCleared) throw new Error("localStorage.clear was called");
      const names = await caches.keys();
      if (!names.includes("other-app-cache")) throw new Error("foreign cache was removed: " + names.join(","));
      const dbs = await indexedDB.databases();
      if (!dbs.some((db) => db.name === "other-app-db")) throw new Error("foreign database was removed");
    });

    await tap(page, "#hw");
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Home Workout");
    await tap(page, "[data-day='upper']");
    await page.waitForFunction(() => document.querySelector("h2.name")?.textContent === "Lat pulldown");
    await tap(page, "#start");
    await page.waitForFunction(() => document.querySelector("#start")?.textContent === "Resting");
    await tap(page, "#back");
    await tap(page, "#back");

    await tap(page, "#banner-create");
    await page.waitForSelector("#acct-ack");
    assert.match(await page.evaluate(() => document.body.innerText), /A forgotten password cannot be recovered\. There is no reset email\./);
    await page.type("#acct-login", LOGIN);
    await page.type("#acct-password", PASSWORD);
    await page.type("#acct-confirm", PASSWORD);
    await tap(page, "#acct-submit");
    await page.waitForFunction(() => document.querySelector("#acct-error")?.textContent === "Check the box before creating the account.");
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /account created/i);
    await tap(page, "#acct-ack");
    await tap(page, "#acct-submit");
    await page.waitForFunction(() => (document.querySelector("#sync-banner p")?.textContent || "").includes("Last synced"), { timeout: 20000 });
    assert.equal(await persistCount(page) >= 2, true);
    assert.match(await bannerText(page), new RegExp("Signed in as " + LOGIN.replace(".", "\\.")));

    let stamp = await syncedAt(page);
    await tap(page, "#hw");
    await tap(page, "[data-day='upper']");
    for (let step = 0; step < 5; step++) {
      const before = await page.evaluate(() => document.body.innerText.slice(0, 400));
      await tap(page, "#next2");
      try {
        await page.waitForFunction((prev) => document.body.innerText.slice(0, 400) !== prev, { timeout: 5000 }, before);
      } catch (error) {
        const now = await page.evaluate(() => document.body.innerText.slice(0, 800));
        throw new Error("next did not advance from:\n" + before + "\nNOW:\n" + now);
      }
    }
    await page.waitForSelector("#mark");
    await tap(page, "#mark");
    try {
      await page.waitForFunction(() => [...document.querySelectorAll(".badge")].some((el) => el.textContent === "Done"), { timeout: 5000 });
    } catch (error) {
      const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
      const plan = await page.evaluate(() => localStorage.getItem("tony-home-gym-plan-v1"));
      throw new Error(text + "\nPLAN " + plan);
    }
    await waitForSync(page, stamp);

    stamp = await syncedAt(page);
    await tap(page, "#add");
    await page.type("input[name='name']", "Phone squat");
    await page.select("select[name='day']", "lower");
    await page.type("input[name='dose']", "3 x 8");
    await page.type("textarea[name='how']", "Squat.");
    await tap(page, "#save-exercise");
    await page.waitForFunction(() => document.body.innerText.includes("Phone squat"));
    await waitForSync(page, stamp);

    stamp = await syncedAt(page);
    await tap(page, "#back");
    await tap(page, "#back");
    await tap(page, "#pf");
    await tap(page, "[data-pf-toggle='hip']");
    await tap(page, "[data-pf-add='hip']");
    await page.type("#pf-form input[name='name']", "Hip abduction");
    await page.type("#pf-form input[name='weight']", "40.5");
    await page.$eval("#pf-form input[name='date']", (input) => { input.value = "2026-10-06"; });
    await page.type("#pf-form input[name='link']", "https://example.com/hip");
    const photo = await page.$("#pf-photo-file");
    await photo.uploadFile("/tmp/pf-blue.png");
    await tap(page, "#pf-form button[type='submit']");
    await page.waitForFunction(() => document.body.innerText.includes("Hip abduction") && document.body.innerText.includes("Watch video"));
    await waitForSync(page, stamp);

    const desktop = await launch(browsers, false);
    const other = await openApp(desktop, appUrl, false);
    await tap(other, "#banner-sign-in");
    await other.waitForSelector("#acct-login");
    await other.type("#acct-login", LOGIN);
    await other.type("#acct-password", PASSWORD);
    await tap(other, "#acct-submit");
    await other.waitForFunction(() => (document.querySelector("#sync-banner p")?.textContent || "").includes("Last synced"), { timeout: 20000 });
    await tap(other, "#hw");
    await tap(other, "#add");
    await other.waitForFunction(() => document.body.innerText.includes("Phone squat"));
    await tap(other, "#back");
    await other.waitForFunction(() => [...document.querySelectorAll(".badge")].some((el) => el.textContent === "Done"));
    await tap(other, "#back");
    await tap(other, "#pf");
    await tap(other, "[data-pf-toggle='hip']");
    await other.waitForFunction(() => document.body.innerText.includes("Hip abduction") && document.querySelector("img[alt='Photo of Hip abduction']"));

    stamp = await syncedAt(page);
    await tap(page, "#back");
    await tap(page, "#hw");
    await tap(page, "#add");
    await tap(page, "[data-remove]");
    await page.waitForFunction(() => !document.body.innerText.includes("Phone squat"));
    await waitForSync(page, stamp);

    const otherStamp = await syncedAt(other);
    await tap(other, "#banner-sync");
    await waitForSync(other, otherStamp);
    await tap(other, "#back");
    await tap(other, "#hw");
    await tap(other, "#add");
    await other.waitForFunction(() => !document.body.innerText.includes("Phone squat"));
    await tap(other, "#back");
    await tap(other, "#back");
    await tap(other, "#pf");
    await tap(other, "[data-pf-toggle='hip']");
    await other.waitForFunction(() => document.body.innerText.includes("Hip abduction"));

    const emptyBrowser = await launch(browsers, false);
    const empty = await openApp(emptyBrowser, appUrl, false);
    await tap(empty, "#banner-sign-in");
    await empty.type("#acct-login", LOGIN);
    await empty.type("#acct-password", PASSWORD);
    await tap(empty, "#acct-submit");
    await empty.waitForFunction(() => (document.querySelector("#sync-banner p")?.textContent || "").includes("Last synced"), { timeout: 20000 });
    await tap(empty, "#pf");
    await tap(empty, "[data-pf-toggle='hip']");
    await empty.waitForFunction(() => document.body.innerText.includes("Hip abduction"));
    assert.equal(await empty.evaluate(() => document.body.innerText.includes("Phone squat")), false);
    await tap(empty, "#back");
    await tap(empty, "#hw");
    await empty.waitForFunction(() => [...document.querySelectorAll(".badge")].some((el) => el.textContent === "Done"));

    await page.evaluate(() => {
      const orig = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).includes("/sync")) return Promise.reject(new TypeError("Failed to fetch"));
        return orig.call(this, url, opts);
      };
    });
    await tap(page, "#banner-sync");
    await page.waitForFunction(() => {
      const banner = document.querySelector("#sync-banner");
      return banner && banner.classList.contains("error") && /not changed|didn't finish|too big/i.test(banner.textContent || "");
    });
    const kept = await page.evaluate(() => localStorage.getItem("tony-planet-fitness-v1") || "");
    assert.match(kept, /Hip abduction/);
    assert.equal(await page.evaluate(() => window.__storageCleared === true), false);
    await page.evaluate(async () => {
      if (localStorage.getItem("other-app-key") !== "keep") throw new Error("foreign localStorage was removed");
      const names = await caches.keys();
      if (!names.includes("other-app-cache")) throw new Error("foreign cache was removed");
      const dbs = await indexedDB.databases();
      if (!dbs.some((db) => db.name === "other-app-db")) throw new Error("foreign database was removed");
      if (!dbs.some((db) => db.name === "tony-planet-fitness")) throw new Error("app photo database missing");
    });
    console.log("e2e sync ok");
  } finally {
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
    await new Promise((resolve) => site.server.close(resolve));
    await worker.stop();
  }
}

async function launch(browsers, mobile) {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: browserArgs,
  });
  browsers.push(browser);
  browser._mobile = mobile;
  return browser;
}

async function openApp(browser, appUrl, mobile) {
  const page = await browser.newPage();
  if (mobile) {
    await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  }
  await page.evaluateOnNewDocument(() => {
    window.__persistCount = 0;
    window.__storageCleared = false;
    const origClear = Storage.prototype.clear;
    Storage.prototype.clear = function () {
      window.__storageCleared = true;
      return origClear.call(this);
    };
    const storage = navigator.storage;
    if (storage && typeof storage.persist === "function") {
      const orig = storage.persist.bind(storage);
      const wrapped = async function () {
        window.__persistCount += 1;
        try { return await orig(); } catch (e) { return false; }
      };
      try { storage.persist = wrapped; } catch (e) {
        Object.defineProperty(storage, "persist", { configurable: true, value: wrapped });
      }
    }
  });
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => console.error("pageerror", error));
  await page.goto(appUrl, { waitUntil: "networkidle0" });
  return page;
}

async function tap(page, selector) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.click();
  });
}

function persistCount(page) {
  return page.evaluate(() => window.__persistCount || 0);
}

function bannerText(page) {
  return page.evaluate(() => document.querySelector("#sync-banner p")?.textContent || "");
}

function syncedAt(page) {
  return page.evaluate(() => {
    try {
      const data = JSON.parse(localStorage.getItem("tony-workout-sync-v1") || "{}");
      return data.lastSyncedAt || 0;
    } catch (e) {
      return 0;
    }
  });
}

async function waitForSync(page, previous) {
  await page.waitForFunction((prev) => {
    let data = {};
    try { data = JSON.parse(localStorage.getItem("tony-workout-sync-v1") || "{}"); } catch (e) { data = {}; }
    const text = document.querySelector("#sync-banner p")?.textContent || "";
    if (data.syncError) return true;
    return typeof data.lastSyncedAt === "number" && data.lastSyncedAt !== prev && text.includes("Last synced");
  }, { timeout: 20000 }, previous);
  const error = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("tony-workout-sync-v1") || "{}").syncError || ""; } catch (e) { return ""; }
  });
  if (error) throw new Error(error);
}

function startSite(dir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const filePath = path.normalize(path.join(dir, pathname));
      if (!filePath.startsWith(dir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const { readFile } = await import("node:fs/promises");
      const body = await readFile(filePath);
      const type = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
      }[path.extname(filePath)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("missing");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function startWorker() {
  const dir = await mkdtemp(path.join(tmpdir(), "workout-e2e-"));
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
    } catch { /* still booting */ }
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
