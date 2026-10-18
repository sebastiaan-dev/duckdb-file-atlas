import type { FileInspection } from "./types";

/** File handles are cloned to the worker; the database is never read into a single buffer. */
export function inspectDatabase(
  file: File,
  signal: AbortSignal,
): Promise<FileInspection> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Inspection cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("./inspection-worker.ts", import.meta.url),
      { type: "module" },
    );
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Inspection cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ inspection?: FileInspection; error?: string }>,
    ) => {
      cleanup();
      if (event.data.inspection) resolve(event.data.inspection);
      else
        reject(
          new Error(event.data.error ?? "The database could not be inspected."),
        );
    };
    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Database inspection failed."));
    };
    worker.postMessage(file);
  });
}
