/* Navigations reload so a published update, including collapsible Planet Fitness sections, is what the phone opens. */
/* This origin is shared by every app on tonychendds.github.io. Cache names for this app start with tony-workout-. Do not delete other apps' caches or databases. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request, { cache: "reload" }));
});
