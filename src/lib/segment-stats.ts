/** Human-readable view of the serialized checkpoint statistics JSON. */
export interface StatisticsSummary {
  rows: [label: string, value: string][];
  /** String zonemap bounds that DuckDB truncated to a prefix. */
  minPrefix: boolean;
  maxPrefix: boolean;
  /** Unparsable input, shown verbatim. */
  raw?: string;
}

const yesNo = (value: unknown) => (value ? "Yes" : "No");

export function describeStatistics(stats?: string): StatisticsSummary | null {
  if (!stats) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stats);
  } catch {
    return { rows: [], minPrefix: false, maxPrefix: false, raw: stats };
  }
  if (!parsed || typeof parsed !== "object")
    return { rows: [], minPrefix: false, maxPrefix: false, raw: stats };
  const value = parsed as {
    hasNull?: boolean;
    hasNoNull?: boolean;
    distinctCount?: number;
    string?: { minExact?: boolean; maxExact?: boolean; maxLength?: number };
  };
  const rows: StatisticsSummary["rows"] = [];
  if (typeof value.hasNull === "boolean")
    rows.push(["Contains NULLs", yesNo(value.hasNull)]);
  if (typeof value.hasNoNull === "boolean")
    rows.push(["Contains values", yesNo(value.hasNoNull)]);
  // DuckDB writes 0 when no HyperLogLog estimate was kept.
  if (typeof value.distinctCount === "number" && value.distinctCount > 0)
    rows.push(["Distinct (estimate)", value.distinctCount.toLocaleString()]);
  if (typeof value.string?.maxLength === "number")
    rows.push(["Max string length", value.string.maxLength.toLocaleString()]);
  return {
    rows,
    minPrefix: value.string?.minExact === false,
    maxPrefix: value.string?.maxExact === false,
  };
}
