/// <reference lib="webworker" />
import { inspectFile } from "./reader";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<File>) => {
  try {
    scope.postMessage({ inspection: await inspectFile(event.data) });
  } catch (error) {
    scope.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "The database could not be inspected.",
    });
  }
};
