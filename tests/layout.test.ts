import { describe, expect, test } from "bun:test";
import {
  aggregateByteSize,
  buildRowGroupUnits,
  continuousLayoutCount,
  LARGE_BLOCK_COUNT,
  LARGE_SEGMENT_COUNT,
  rowCoverage,
} from "../src/lib/layout";
import type { Segment } from "../src/lib/types";

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "s1",
    table: "items",
    column: "id",
    columnType: "BIGINT",
    rowGroup: 0,
    blockId: 1,
    offset: 8,
    byteSize: 100,
    rowStart: 0,
    rowCount: 1000,
    compression: "Uncompressed",
    ...overrides,
  };
}

describe("logical layout helpers", () => {
  test("builds a row group with every segment, including multiple validity and data extents per column", () => {
    const units = buildRowGroupUnits([
      segment({ id: "value-2", column: "value", rowStart: 500, byteSize: 40 }),
      segment({ id: "validity", column: "value", rowStart: 0, byteSize: 8 }),
      segment({ id: "value-1", column: "value", rowStart: 0, byteSize: 60 }),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0].segments.map((item) => item.id)).toEqual([
      "validity",
      "value-1",
      "value-2",
    ]);
    expect(aggregateByteSize(units[0].segments)).toBe(108);
  });

  test("unions row ranges across columns so overlapping validity extents do not inflate row count", () => {
    const coverage = rowCoverage([
      segment({ rowStart: 0, rowCount: 1000 }),
      segment({
        id: "validity-a",
        column: "validity",
        rowStart: 0,
        rowCount: 64,
      }),
      segment({
        id: "validity-b",
        column: "validity",
        rowStart: 60,
        rowCount: 40,
      }),
      segment({ id: "tail", column: "other", rowStart: 1200, rowCount: 20 }),
    ]);

    expect(coverage).toEqual({ start: 0, end: 1220, count: 1020 });
  });

  test("keeps an aggregate unknown when any segment footprint is unknown", () => {
    expect(
      aggregateByteSize([
        segment({ byteSize: 100 }),
        segment({ id: "unknown", byteSize: null }),
      ]),
    ).toBeNull();
    expect(
      aggregateByteSize([
        segment({ byteSize: 100 }),
        segment({ id: "known", byteSize: 25 }),
      ]),
    ).toBe(125);
    expect(aggregateByteSize([])).toBeNull();
  });

  test("renders SF4-sized maps and all logical row groups without truncation", () => {
    expect(
      continuousLayoutCount(4279, 4279 > LARGE_BLOCK_COUNT, 4096, 4096),
    ).toBe(4279);
    const units = buildRowGroupUnits(
      Array.from({ length: 6332 }, (_, index) =>
        segment({
          id: `s${index}`,
          rowGroup: Math.floor(index / 20),
        }),
      ),
    );
    const count = continuousLayoutCount(
      units.length,
      6332 > LARGE_SEGMENT_COUNT,
      64,
      64,
    );
    expect(
      units.slice(0, count).flatMap((group) => group.segments),
    ).toHaveLength(6332);
    expect(count).toBeGreaterThan(32);
    expect(continuousLayoutCount(0, false, 64, 64)).toBe(0);
    expect(continuousLayoutCount(LARGE_BLOCK_COUNT, false, 4096, 4096)).toBe(
      LARGE_BLOCK_COUNT,
    );
  });

  test("appends a continuous prefix for exceptionally large maps, retaining complete row groups", () => {
    const units = buildRowGroupUnits(
      Array.from({ length: 50001 }, (_, index) =>
        segment({
          id: `s${index}`,
          rowGroup: Math.floor(index / 100),
        }),
      ),
    );
    const initial = continuousLayoutCount(units.length, true, 64, 64);
    const extended = continuousLayoutCount(
      units.length,
      true,
      initial + 64,
      64,
    );
    expect(
      units.slice(0, initial).flatMap((group) => group.segments),
    ).toHaveLength(6400);
    expect(units.slice(0, extended).slice(0, initial)).toEqual(
      units.slice(0, initial),
    );
    expect(extended).toBe(128);
    // A selected or searched item beyond the loaded prefix becomes available immediately.
    expect(continuousLayoutCount(100000, true, 4096, 4096, 9000)).toBe(12288);
    expect(continuousLayoutCount(50001, true, 49152, 4096, 50000)).toBe(50001);
  });
});
