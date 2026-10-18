import { describe, expect, it } from "bun:test";
import {
  buildLogicalMetrics,
  bytesPerRow,
  columnKey,
  logicalAppearance,
  nullFraction,
} from "./logical-colors";
import type { Segment } from "./types";

function segment(id: string, values: Partial<Segment> = {}): Segment {
  return {
    id,
    table: "main.t",
    column: "x",
    columnType: "BIGINT",
    rowGroup: 0,
    blockId: 0,
    offset: 8,
    byteSize: 100,
    rowStart: 0,
    rowCount: 100,
    compression: "BitPacking",
    ...values,
  };
}

describe("logical color measurements", () => {
  it("keeps the default range column in layout order and rejects invalid ISO dates", () => {
    const rows = [
      segment("z", { column: "z_first", min: "1", max: "2" }),
      segment("a", { column: "a_second", min: "3", max: "4" }),
      segment("bad-date", {
        column: "bad_date",
        columnType: "DATE",
        min: "2026-02-30",
        max: "2026-03-03",
      }),
      segment("bad-time", {
        column: "bad_time",
        columnType: "TIMESTAMP",
        min: "2026-01-01 24:00:00",
        max: "2026-01-02 00:00:00",
      }),
    ];
    const metrics = buildLogicalMetrics(rows);
    expect(metrics.valueColumns.map((column) => column.key)).toEqual([
      columnKey(rows[0]),
      columnKey(rows[1]),
    ]);
  });
  it("normalizes partially filled segments by their own row counts", () => {
    expect(bytesPerRow(segment("full"))).toBe(1);
    expect(
      bytesPerRow(segment("partial", { byteSize: 20, rowCount: 20 })),
    ).toBe(1);
    expect(bytesPerRow(segment("constant", { byteSize: 0, blockId: -1 }))).toBe(
      0,
    );
    for (const values of [
      { byteSize: null },
      { rowCount: 0 },
      { byteSize: NaN },
      { rowCount: -1 },
    ])
      expect(bytesPerRow(segment("bad", values))).toBeNull();
  });
  it("uses column-specific medians, excludes missing values and preserves baselines when rendering a subset", () => {
    const rows = [
      segment("a"),
      segment("b", { byteSize: 300 }),
      segment("missing", { byteSize: null }),
      segment("other", { column: "y", byteSize: 9000 }),
    ];
    const metrics = buildLogicalMetrics(rows);
    expect(metrics.segments.get("a")?.median).toBe(2);
    expect(metrics.segments.get("a")?.relative).toBe(0.5);
    expect(metrics.segments.get("b")?.relative).toBe(1.5);
    expect(metrics.segments.get("missing")?.relative).toBeNull();
    expect(
      logicalAppearance(rows[0], "relative-footprint", metrics).description,
    ).toContain("0.5×");
    expect(metrics.segments.get("other")?.relative).toBe(1);
  });
  it("handles a zero median without NaN and distinguishes unknown bytes", () => {
    const rows = [
      segment("zero", { byteSize: 0 }),
      segment("zero2", { byteSize: 0 }),
      segment("positive"),
      segment("unknown", { byteSize: null }),
    ];
    const metrics = buildLogicalMetrics(rows);
    expect(metrics.segments.get("zero")?.relative).toBe(1);
    expect(metrics.segments.get("positive")?.relative).toBe(Infinity);
    expect(
      logicalAppearance(rows[1], "relative-footprint", metrics).background,
    ).not.toContain("NaN");
    expect(
      logicalAppearance(rows[2], "relative-footprint", metrics).description,
    ).toContain("zero baseline");
    expect(logicalAppearance(rows[3], "bytes-per-row", metrics).unknown).toBe(
      true,
    );
  });
  it("only derives null fractions from exact counts or definitive flags", () => {
    expect(nullFraction(segment("exact", { nullCount: 23 }))).toBe(0.23);
    expect(
      nullFraction(
        segment("none", { stats: '{"hasNull":false,"hasNoNull":true}' }),
      ),
    ).toBe(0);
    expect(
      nullFraction(
        segment("all", { stats: '{"hasNull":true,"hasNoNull":false}' }),
      ),
    ).toBe(1);
    for (const stats of [
      '{"hasNull":true,"hasNoNull":true}',
      '{"hasNull":false,"hasNoNull":false}',
      "illustrative",
      "null",
    ])
      expect(nullFraction(segment("unknown", { stats }))).toBeNull();
    expect(nullFraction(segment("bad", { nullCount: 101 }))).toBeNull();
  });
  it("keeps adjacent HUGEINT and decimal bounds distinct", () => {
    const rows = [
      segment("a", {
        min: "170141183460469231731687303715884100",
        max: "170141183460469231731687303715884101",
      }),
      segment("b", {
        min: "170141183460469231731687303715884102",
        max: "170141183460469231731687303715884103",
      }),
    ];
    const metrics = buildLogicalMetrics(rows),
      column = metrics.valueColumns[0];
    expect(column.max - column.min).toBe(3n);
    expect(
      logicalAppearance(rows[0], "value-range", metrics, column).background,
    ).not.toBe(
      logicalAppearance(rows[1], "value-range", metrics, column).background,
    );
    const decimal = buildLogicalMetrics([
      segment("d", {
        columnType: "DECIMAL(38,4)",
        min: "999999999999999999999999999999.0001",
        max: "999999999999999999999999999999.0002",
      }),
    ]).valueColumns[0];
    expect(decimal.max - decimal.min).toBe(1n);
  });
  it("uses a shared domain and rejects numeric-looking text, invalid and all-null bounds", () => {
    const rows = [
      segment("a", { min: "-1.5", max: "1e1", columnType: "DOUBLE" }),
      segment("b", { min: "20", max: "30", columnType: "DOUBLE" }),
      segment("text", {
        column: "text",
        columnType: "VARCHAR",
        min: "1",
        max: "99",
      }),
      segment("bad", { column: "bad", min: "100", max: "-2" }),
      segment("null", { column: "null", min: "0", max: "0", nullCount: 100 }),
    ];
    const metrics = buildLogicalMetrics(rows);
    expect(metrics.valueColumns.length).toBe(1);
    const column = metrics.valueColumns[0];
    expect(column.minLabel).toBe("-1.5");
    expect(column.maxLabel).toBe("30");
    expect(column.ranges.size).toBe(2);
    expect(
      logicalAppearance(rows[2], "value-range", metrics, column).unknown,
    ).toBe(true);
    expect(columnKey(segment("x", { table: "a.b", column: "c" }))).not.toBe(
      columnKey(segment("y", { table: "a", column: "b.c" })),
    );
  });
  it("handles dates and nanosecond timestamps without local timezone or precision loss", () => {
    const rows = [
      segment("d", {
        columnType: "DATE",
        min: "2026-01-01",
        max: "2026-01-02",
      }),
      segment("ts", {
        column: "ts",
        columnType: "TIMESTAMP_NS",
        min: "2026-01-01 00:00:00.000000001",
        max: "2026-01-01 00:00:00.000000002",
      }),
      segment("tz", {
        column: "tz",
        columnType: "TIMESTAMP WITH TIME ZONE",
        min: "2026-01-01 02:00:00+02",
        max: "2026-01-01 00:00:00Z",
      }),
    ];
    const metrics = buildLogicalMetrics(rows);
    expect(
      metrics.valueColumns.find((c) => c.key === columnKey(rows[0]))!.max -
        metrics.valueColumns.find((c) => c.key === columnKey(rows[0]))!.min,
    ).toBe(86_400_000_000_000n);
    const ns = metrics.valueColumns.find((c) => c.key === columnKey(rows[1]))!;
    expect(ns.max - ns.min).toBe(1n);
    const tz = metrics.valueColumns.find((c) => c.key === columnKey(rows[2]))!;
    expect(tz.max).toBe(tz.min);
  });
  it("excludes infinite temporal bounds instead of assigning them a finite value range", () => {
    for (const columnType of [
      "DATE",
      "TIMESTAMP",
      "TIMESTAMP_S",
      "TIMESTAMP_MS",
      "TIMESTAMP_NS",
      "TIMESTAMP WITH TIME ZONE",
    ]) {
      const finite =
        columnType === "DATE" ? "2026-01-01" : "2026-01-01T00:00:00Z";
      const rows = [
        segment("negative", { columnType, min: "-infinity", max: finite }),
        segment("positive", { columnType, min: finite, max: "infinity" }),
        segment("both", { columnType, min: "-infinity", max: "infinity" }),
        segment("finite", { columnType, min: finite, max: finite }),
      ];
      const metrics = buildLogicalMetrics(rows);
      expect(metrics.valueColumns).toHaveLength(1);
      expect([...metrics.valueColumns[0].ranges.keys()]).toEqual(["finite"]);
      for (const row of rows.slice(0, 3)) {
        expect(
          logicalAppearance(
            row,
            "value-range",
            metrics,
            metrics.valueColumns[0],
          ).unknown,
        ).toBe(true);
      }
    }
  });
  it("handles empty and constant value domains", () => {
    expect(buildLogicalMetrics([]).valueColumns).toEqual([]);
    const row = segment("constant", {
      min: "7",
      max: "7",
      byteSize: 0,
      blockId: -1,
    });
    const metrics = buildLogicalMetrics([row]);
    expect(
      logicalAppearance(row, "value-range", metrics, metrics.valueColumns[0])
        .background,
    ).not.toContain("NaN");
  });
});
