/* GitHub Pages cannot set COOP/COEP response headers. This scope-local
 * service worker adds them without caching or changing response bodies.
 * All runtime assets and extensions are served from this same origin.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return;
  // Chromium can issue this otherwise-invalid request during navigation.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin")
    return;
  event.respondWith(
    (async () => {
      const response = await fetch(request);
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })(),
  );
});
