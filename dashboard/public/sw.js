/*
 * Two Minute Billing service worker (scope "/").
 *
 * Stores static files only: hashed build assets, fonts, icons and the offline page. It never
 * stores a page, an API answer, a server action or an RSC payload. The storefront and the
 * gateway return routes are not touched at all (no respondWith), so a buyer's checkout is
 * exactly what the network sends.
 *
 * Bump VERSION to drop every cached file on the next activation.
 */
// The worker's global scope (`self`, which our lint config restricts).
const sw = globalThis;
const VERSION = "v1";
const CACHE = `tmb-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const MAX_ENTRIES = 400;

const PRECACHE = [
  OFFLINE_URL,
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
  "/favicon.svg",
];

// Buyer-facing and gateway paths: always straight to the network, never through this worker.
const BYPASS = ["/checkout", "/portal", "/buy", "/pricing", "/gateway-return", "/start"];

const under = (path, prefix) => path === prefix || path.startsWith(prefix + "/");
const isBypassed = (path) => BYPASS.some((p) => under(path, p));

function isStatic(url) {
  const p = url.pathname;
  return (
    p.startsWith("/_next/static/") ||
    /\.(?:woff2?|ttf|otf)$/.test(p) ||
    /^\/icon-[\w-]+\.png$/.test(p) ||
    p === "/apple-touch-icon.png" ||
    p === "/favicon.ico" ||
    p === "/favicon.svg"
  );
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("tmb-static-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

// Storefront windows seen navigating since this worker started; their requests pass through.
const storefrontClients = new Set();

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // A storefront page, and everything it loads, never goes through this worker.
  if (req.mode === "navigate" && isBypassed(url.pathname)) {
    if (event.resultingClientId) storefrontClients.add(event.resultingClientId);
    return;
  }
  if (storefrontClients.has(event.clientId)) return;
  // The same after a worker restart forgot the set: a storefront page's scripts name it as referrer.
  if (req.referrer && isBypassed(new URL(req.referrer).pathname)) return;
  // Server actions and every other write; other origins.
  if (req.method !== "GET" || url.origin !== sw.location.origin) return;
  if (isBypassed(url.pathname)) return;
  // RSC payloads are pages in another format.
  if (req.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;

  if (req.mode === "navigate") {
    // Network first; the offline page only when the network itself fails.
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (isStatic(url)) event.respondWith(cacheFirst(req));
  // Anything else (/api/*, route handlers, images from public/): the network, untouched.
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    await cache.put(req, res.clone());
    trim(cache);
  }
  return res;
}

// Each build adds new hashed chunks; keep the cache bounded by dropping the oldest.
async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ENTRIES;
  for (let i = 0; i < extra; i++) {
    if (!PRECACHE.includes(new URL(keys[i].url).pathname)) await cache.delete(keys[i]);
  }
}

/*
 * Push payload (JSON): { title, body, url, tag?, renotify?, badge_count? }.
 * `url` is a same-origin path; anything else opens the app home.
 */
sw.addEventListener("push", (event) => {
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    p = {};
  }
  const work = [
    sw.registration.showNotification(p.title || "Two Minute Billing", {
      body: p.body || "",
      tag: p.tag,
      // renotify without a tag is an error in Chrome.
      renotify: Boolean(p.tag && p.renotify),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: safePath(p.url) },
    }),
  ];
  if (typeof p.badge_count === "number") work.push(setBadge(p.badge_count));
  // Open app windows refresh the bell's count now instead of at the next poll.
  work.push(
    sw.clients
      .matchAll({ type: "window" })
      .then((all) => all.forEach((c) => c.postMessage({ type: "notification" }))),
  );
  event.waitUntil(Promise.all(work));
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    safePath(event.notification.data && event.notification.data.url),
    sw.location.origin,
  ).href;
  event.waitUntil(openApp(target));
});

sw.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-badge") event.waitUntil(setBadge(0));
});

function safePath(raw) {
  try {
    const u = new URL(raw || "/", sw.location.origin);
    return u.origin === sw.location.origin ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

function setBadge(n) {
  const nav = sw.navigator;
  const call =
    n > 0 ? nav.setAppBadge && nav.setAppBadge(n) : nav.clearAppBadge && nav.clearAppBadge();
  return Promise.resolve(call).catch(() => {});
}

// Focus an open app window and move it to the record; open one when there is none.
async function openApp(target) {
  const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  const app = all.find((c) => {
    const u = new URL(c.url);
    return u.origin === sw.location.origin && !isBypassed(u.pathname);
  });
  if (app) {
    try {
      await app.focus();
      // navigate() works only on a window this worker controls.
      if (await app.navigate(target)) return;
    } catch {
      // Fall through to a new window.
    }
  }
  await sw.clients.openWindow(target);
}
