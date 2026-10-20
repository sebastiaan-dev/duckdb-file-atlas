/** Match DuckDB's threaded-bundle requirements, not just CPU count. */
export async function threadSupport(): Promise<boolean> {
  if (!globalThis.crossOriginIsolated) return false;
  try {
    const { getPlatformFeatures } = await import("@duckdb/duckdb-wasm");
    const features = await getPlatformFeatures();
    return (
      features.wasmExceptions &&
      features.wasmSIMD &&
      features.wasmThreads &&
      features.crossOriginIsolated
    );
  } catch {
    return false;
  }
}
