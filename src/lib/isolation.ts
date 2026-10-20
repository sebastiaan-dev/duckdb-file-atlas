/** Enable shared WASM memory on static hosting before mounting any UI.
 * One bounded, guarded reload preserves the scenario hash. Registration failure
 * must never prevent opening a file or using the single-threaded generator.
 */
export async function prepareIsolation(): Promise<void> {
  if (
    globalThis.crossOriginIsolated ||
    !globalThis.isSecureContext ||
    !("serviceWorker" in navigator)
  )
    return;
  const base = new URL(import.meta.env.BASE_URL, location.href);
  const script = new URL("isolation-worker.js", base);
  const key = `atlas-isolation:${base.pathname}`;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controllerChanged: (() => void) | undefined;
  try {
    // Avoid a reload loop when a browser accepts the worker but cannot isolate.
    if (sessionStorage.getItem(key)) return;
    await Promise.race([
      (async () => {
        await navigator.serviceWorker.register(script, {
          scope: base.pathname,
        });
        if (!active) return;
        await new Promise<void>((resolve) => {
          const check = () => {
            if (navigator.serviceWorker.controller?.scriptURL === script.href)
              resolve();
          };
          controllerChanged = check;
          navigator.serviceWorker.addEventListener("controllerchange", check);
          check();
        });
        if (!active) return;
        sessionStorage.setItem(key, "1");
        location.reload();
        // Do not mount an interactive app just before the navigation commits.
        await new Promise<void>(() => {});
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } catch {
    // Private browsing, storage restrictions or blocked workers: use one thread.
  } finally {
    active = false;
    clearTimeout(timer);
    if (controllerChanged)
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        controllerChanged,
      );
  }
}
