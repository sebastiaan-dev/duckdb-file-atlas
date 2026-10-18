import { compressionPalette, stableColor } from "./palette";
import type { Segment } from "./types";

export type LogicalColorMode =
  | "compression"
  | "bytes-per-row"
  | "relative-footprint"
  | "value-range"
  | "null-fraction";
export const logicalColorOptions: { value: LogicalColorMode; label: string }[] =
  [
    { value: "compression", label: "Compression" },
    { value: "bytes-per-row", label: "Bytes per row" },
    { value: "relative-footprint", label: "Relative footprint" },
    { value: "value-range", label: "Value ranges" },
    { value: "null-fraction", label: "Null fraction" },
  ];
export const logicalRamp = ["#eeecf8", "#c4bfec", "#9890df", "#6258ce"];
export const relativeRamp = [
  "#689ac8",
  "#abc5dc",
  "#e2dfe9",
  "#dcaf88",
  "#ce805f",
];
export const valueRamp = [
  "#6961d8",
  "#668eb4",
  "#67aaa7",
  "#b7ad83",
  "#d7a267",
];
const unknownColor = "var(--chart-unknown)";
const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 3,
});
export const formatRate = (value: number) =>
  value > 0 && value < 0.001 ? "<0.001" : decimalFormatter.format(value);
export const columnKey = (segment: Pick<Segment, "table" | "column">) =>
  JSON.stringify([segment.table, segment.column]);

interface ExactValue {
  coefficient: bigint;
  scale: number;
}
interface RawRange {
  min: ExactValue;
  max: ExactValue;
}
interface Range {
  min: bigint;
  max: bigint;
}
export interface ValueColumn {
  table: string;
  key: string;
  label: string;
  min: bigint;
  max: bigint;
  minLabel: string;
  maxLabel: string;
  ranges: Map<string, Range>;
}
export interface SegmentMetric {
  bytesPerRow: number | null;
  median: number | null;
  relative: number | null;
  nullFraction: number | null;
}
export interface LogicalMetrics {
  segments: Map<string, SegmentMetric>;
  valueColumns: ValueColumn[];
  maxBytesPerRow: number;
  compressions: string[];
}

/** Decimal strings stay exact until normalized to a color, including HUGEINT/DECIMAL bounds. */
function numericValue(value: string): ExactValue | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(
    value.trim(),
  );
  if (!match || value.length > 1024) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 512) return null;
  let coefficient = BigInt(
    `${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`,
  );
  let scale = (match[3]?.length ?? 0) - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}
function temporalValue(value: string, type: string): ExactValue | null {
  // Only accept unambiguous ISO dates/timestamps. Never use the browser's local timezone.
  const dateOnly = type === "DATE";
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(
      value,
    );
  if (!match || (!dateOnly && !match[2]) || (dateOnly && match[2])) return null;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (
    !Number.isFinite(day) ||
    new Date(day).toISOString().slice(0, 10) !== match[1]
  )
    return null;
  if (match[2]) {
    const [hours, minutes, seconds] = match[2].split(":").map(Number);
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
  }
  const zone = match[4] ?? "Z";
  const normalizedZone = /^[+-]\d{2}$/.test(zone) ? `${zone}:00` : zone;
  const epoch = Date.parse(
    `${match[1]}T${match[2] ?? "00:00:00"}${normalizedZone}`,
  );
  if (!Number.isFinite(epoch)) return null;
  const fraction = BigInt((match[3] ?? "").padEnd(9, "0"));
  return { coefficient: BigInt(epoch) * 1_000_000n + fraction, scale: 0 };
}
function rawRange(
  segment: Segment,
  nullFraction: number | null,
): RawRange | null {
  if (segment.min == null || segment.max == null || nullFraction === 1)
    return null;
  const type = segment.columnType.toUpperCase();
  const numeric =
    /^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT(?:8|16|32|64|128)?|UINT(?:8|16|32|64|128)|FLOAT|DOUBLE|REAL|DECIMAL(?:\(\d+,\s*\d+\))?)$/.test(
      type,
    );
  const temporal =
    /^(?:DATE|TIMESTAMP(?:_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE|TIMESTAMPTZ)$/.test(
      type,
    );
  if (!numeric && !temporal) return null;
  const parse = (value: string) =>
    numeric ? numericValue(value) : temporalValue(value, type);
  const min = parse(segment.min),
    max = parse(segment.max);
  if (!min || !max) return null;
  const scale = Math.max(min.scale, max.scale);
  if (scaled(min, scale) > scaled(max, scale)) return null;
  return { min, max };
}
function scaled(value: ExactValue, scale: number) {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}
/**
 * Log scale: per-row footprints span orders of magnitude (bit-packed ints vs.
 * long strings), so a linear ramp would leave nearly every segment pale.
 */
export function bytesPerRowPosition(rate: number, max: number): number {
  if (!(max > 0) || !(rate > 0)) return 0;
  return Math.min(1, Math.log1p(rate) / Math.log1p(max));
}

export function bytesPerRow(segment: Segment): number | null {
  return segment.byteSize != null &&
    Number.isFinite(segment.byteSize) &&
    segment.byteSize >= 0 &&
    Number.isSafeInteger(segment.rowCount) &&
    segment.rowCount > 0
    ? segment.byteSize / segment.rowCount
    : null;
}
export function nullFraction(segment: Segment): number | null {
  if (!Number.isSafeInteger(segment.rowCount) || segment.rowCount <= 0)
    return null;
  if (segment.nullCount != null)
    return Number.isSafeInteger(segment.nullCount) &&
      segment.nullCount >= 0 &&
      segment.nullCount <= segment.rowCount
      ? segment.nullCount / segment.rowCount
      : null;
  try {
    const stats = JSON.parse(segment.stats ?? "null");
    if (stats?.hasNull === false && stats?.hasNoNull === true) return 0;
    if (stats?.hasNull === true && stats?.hasNoNull === false) return 1;
  } catch {
    /* Imported statistics may be a human-readable description. */
  }
  return null;
}

/** Baselines use the entire file, independent of search and progressive rendering. */
export function buildLogicalMetrics(segments: Segment[]): LogicalMetrics {
  const metrics = new Map<string, SegmentMetric>();
  const groups = new Map<
    string,
    {
      segments: Segment[];
      rates: number[];
      ranges: Map<string, RawRange>;
      scale: number;
    }
  >();
  let maxBytesPerRow = 0;
  for (const segment of segments) {
    const rate = bytesPerRow(segment),
      fraction = nullFraction(segment);
    metrics.set(segment.id, {
      bytesPerRow: rate,
      nullFraction: fraction,
      median: null,
      relative: null,
    });
    if (rate != null) maxBytesPerRow = Math.max(maxBytesPerRow, rate);
    const key = columnKey(segment);
    let group = groups.get(key);
    if (!group)
      groups.set(
        key,
        (group = { segments: [], rates: [], ranges: new Map(), scale: 0 }),
      );
    group.segments.push(segment);
    if (rate != null) group.rates.push(rate);
    const range = rawRange(segment, fraction);
    if (range) {
      group.ranges.set(segment.id, range);
      group.scale = Math.max(group.scale, range.min.scale, range.max.scale);
    }
  }
  const valueColumns: ValueColumn[] = [];
  for (const [key, group] of groups) {
    const rates = group.rates.sort((a, b) => a - b),
      middle = Math.floor(rates.length / 2);
    const median =
      rates.length === 0
        ? null
        : rates.length % 2
          ? rates[middle]
          : rates[middle - 1] / 2 + rates[middle] / 2;
    let domain: ValueColumn | undefined;
    for (const segment of group.segments) {
      const metric = metrics.get(segment.id)!;
      metric.median = median;
      if (metric.bytesPerRow != null && median != null)
        metric.relative =
          median === 0
            ? metric.bytesPerRow === 0
              ? 1
              : Infinity
            : metric.bytesPerRow / median;
      const raw = group.ranges.get(segment.id);
      if (!raw) continue;
      const range = {
        min: scaled(raw.min, group.scale),
        max: scaled(raw.max, group.scale),
      };
      if (!domain)
        domain = {
          key,
          table: segment.table,
          label: `${segment.table} · ${segment.column}`,
          ...range,
          minLabel: segment.min!,
          maxLabel: segment.max!,
          ranges: new Map(),
        };
      if (range.min < domain.min) {
        domain.min = range.min;
        domain.minLabel = segment.min!;
      }
      if (range.max > domain.max) {
        domain.max = range.max;
        domain.maxLabel = segment.max!;
      }
      domain.ranges.set(segment.id, range);
    }
    if (domain) valueColumns.push(domain);
  }
  return {
    segments: metrics,
    valueColumns: valueColumns.sort((a, b) => a.table.localeCompare(b.table)),
    maxBytesPerRow,
    compressions: [...new Set(segments.map((s) => s.compression))].sort(),
  };
}
function rampColor(ratio: number, ramp: string[]) {
  const position = Math.max(0, Math.min(1, ratio)) * (ramp.length - 1);
  const index = Math.min(ramp.length - 2, Math.floor(position));
  return `color-mix(in srgb, ${ramp[index]} ${((1 - (position - index)) * 100).toFixed(2)}%, ${ramp[index + 1]})`;
}
function rangePosition(value: bigint, column: ValueColumn) {
  return column.max === column.min
    ? 0.5
    : Number(((value - column.min) * 1_000_000n) / (column.max - column.min)) /
        1_000_000;
}
export interface SegmentAppearance {
  background: string;
  description: string;
  unknown: boolean;
}
export function logicalAppearance(
  segment: Segment,
  mode: LogicalColorMode,
  metrics: LogicalMetrics,
  column?: ValueColumn,
): SegmentAppearance {
  const metric = metrics.segments.get(segment.id)!;
  const unknown = (description: string): SegmentAppearance => ({
    background: unknownColor,
    description,
    unknown: true,
  });
  const known = (
    background: string,
    description: string,
  ): SegmentAppearance => ({ background, description, unknown: false });
  if (mode === "compression")
    return /^(?:unknown)?$/i.test(segment.compression)
      ? unknown("Compression unknown")
      : known(
          stableColor(segment.compression, compressionPalette),
          segment.compression,
        );
  if (mode === "bytes-per-row")
    return metric.bytesPerRow == null
      ? unknown("Bytes per row unknown")
      : known(
          rampColor(
            bytesPerRowPosition(metric.bytesPerRow, metrics.maxBytesPerRow),
            logicalRamp,
          ),
          `${formatRate(metric.bytesPerRow)} B/row`,
        );
  if (mode === "relative-footprint") {
    if (metric.relative == null) return unknown("Relative footprint unknown");
    const ratio = metric.relative;
    return known(
      rampColor(
        (Math.max(-2, Math.min(2, Math.log2(ratio))) + 2) / 4,
        relativeRamp,
      ),
      `${ratio === Infinity ? "Above zero baseline" : `${formatRate(ratio)}× column median`} · ${formatRate(metric.bytesPerRow!)} B/row · median ${formatRate(metric.median!)} B/row`,
    );
  }
  if (mode === "null-fraction")
    return metric.nullFraction == null
      ? unknown("Null fraction unknown")
      : known(
          rampColor(metric.nullFraction, logicalRamp),
          `${formatRate(metric.nullFraction * 100)}% null`,
        );
  const range = column?.ranges.get(segment.id);
  if (!range || !column)
    return unknown(
      column && columnKey(segment) !== column.key
        ? "Outside selected value column"
        : "Value range unavailable",
    );
  return known(
    `linear-gradient(90deg, ${rampColor(rangePosition(range.min, column), valueRamp)}, ${rampColor(rangePosition(range.max, column), valueRamp)})`,
    `Range: ${segment.min} → ${segment.max}`,
  );
}
