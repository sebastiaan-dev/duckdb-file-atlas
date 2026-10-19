import { BUILD_CATALOG, buildDatabase } from "./database-builder";

export const TPCH_SCALE_FACTORS = [0.01, 0.1, 1] as const;
export type TpchScaleFactor = (typeof TPCH_SCALE_FACTORS)[number];
export const DEFAULT_TPCH_SCALE_FACTOR: TpchScaleFactor = 1;

export interface TpchGenerationOptions {
  scaleFactor?: TpchScaleFactor;
  signal?: AbortSignal;
  /** Stage descriptions, not an estimated percentage of dbgen's work. */
  onProgress?: (message: string) => void;
}

export function tpchGenerationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `TPC-H generation failed. The DuckDB runtime (about 35 MB) is served by this site; check your connection and retry. If memory is limited, use SF 0.01 or close other tabs.${detail ? ` Details: ${detail}` : ""}`;
}

/** Generate a real, checkpointed TPC-H database in v2.0 storage. */
export async function generateTpchDatabase({
  scaleFactor = DEFAULT_TPCH_SCALE_FACTOR,
  signal,
  onProgress,
}: TpchGenerationOptions = {}): Promise<File> {
  // Runtime validation matters even though TypeScript callers get a narrow type.
  if (!TPCH_SCALE_FACTORS.includes(scaleFactor)) {
    throw new Error("Choose TPC-H scale factor 0.01, 0.1 or 1.");
  }
  return buildDatabase({
    fileName: `tpch-sf${scaleFactor}.duckdb`,
    extensions: ["tpch"],
    statements: [
      {
        sql: `CALL dbgen(sf = ${scaleFactor}, catalog = '${BUILD_CATALOG}')`,
        label: `Generating TPC-H tables (SF ${scaleFactor})…`,
      },
    ],
    signal,
    onProgress,
    timeoutMessage:
      "Generation timed out after five minutes. Retry with SF 0.01.",
  });
}
