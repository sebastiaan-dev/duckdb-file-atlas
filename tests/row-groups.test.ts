import { describe, expect, test } from "bun:test";
import { blockCellColors, blockOwners, roleColors } from "../src/lib/palette";
import { rowGroupColor, summarizeRowGroup } from "../src/lib/row-groups";
import type { FileBlock, NativeRowGroup, Segment } from "../src/lib/types";

const SIZE = 1000;
const block = (id: number, role: FileBlock["role"] = "data"): FileBlock => ({
  id,
  offset: 12288 + id * SIZE,
  size: SIZE,
  role,
  label: "fixture",
  usedBytes: null,
  ranges: [],
  segmentIds: [],
  links: [],
});
let next = 0;
const segment = (
  table: string,
  rowGroup: number,
  blockId: number,
  extra: Partial<Segment> = {},
): Segment => ({
  id: `s${next++}`,
  table,
  column: `c${next}`,
  columnType: "INTEGER",
  rowGroup,
  blockId,
  offset: 8,
  byteSize: 100,
  rowStart: 0,
  rowCount: 10,
  compression: "RLE",
  ...extra,
});

// File order is 0, 1, 2, 3, 5, 4: block 5 sits physically before block 4.
const ordered = [0, 1, 2, 3, 5, 4].map((id, position) => ({
  ...block(id),
  offset: 12288 + position * SIZE,
}));
const segments = [
  segment("main.a", 0, 0),
  segment("main.a", 0, 1),
  segment("main.a", 0, 5, { byteSize: null }),
  segment("main.a", 0, -1, { byteSize: 0 }),
  segment("main.a", 0, 4, { auxiliaryBlocks: [3] }),
  segment("main.a", 1, 1),
  segment("main.b", 0, 2),
];
const byBlock = new Map<number, Segment[]>();
for (const item of segments)
  if (item.blockId >= 0)
    byBlock.set(item.blockId, [...(byBlock.get(item.blockId) ?? []), item]);
const rowGroupsInfo = [
  {
    table: "main.a",
    rowGroup: 0,
    rowStart: 0,
    physicalRows: 50,
    liveRows: 40,
    deletedRows: 10,
    deleteVectors: [],
  },
] satisfies NativeRowGroup[];

describe("row group summary", () => {
  const summary = summarizeRowGroup(
    { table: "main.a", rowGroup: 0 },
    segments,
    ordered,
    byBlock,
    rowGroupsInfo,
  )!;

  test("lists touched blocks, including string overflow, in file order", () => {
    expect(summary.blockIds).toEqual([0, 1, 3, 5, 4]);
    expect(summary.overflowBlocks).toBe(1);
    expect(summary.blockBytes).toBe(5 * SIZE);
    expect(summary.startOffset).toBe(12288);
    expect(summary.endOffset).toBe(12288 + 6 * SIZE);
  });

  test("counts runs by physical adjacency and blocks shared with other row groups", () => {
    // Positions 0, 1, 3, 4, 5 → runs [0–1] and [3–5].
    expect(summary.runs).toBe(2);
    expect(summary.sharedBlocks).toBe(1);
  });

  test("keeps unknown sizes and constants apart from measured bytes", () => {
    expect(summary.segments).toBe(5);
    expect(summary.constantSegments).toBe(1);
    expect(summary.unknownSizeSegments).toBe(1);
    expect(summary.dataBytes).toBe(300);
    expect(summary.rows).toEqual({
      physicalRows: 50,
      liveRows: 40,
      deletedRows: 10,
      rowStart: 0,
    });
  });

  test("an unknown row group has no summary", () => {
    expect(
      summarizeRowGroup(
        { table: "main.a", rowGroup: 9 },
        segments,
        ordered,
        byBlock,
      ),
    ).toBeNull();
  });
});

describe("row-group color mode", () => {
  test("splits shared blocks per row group in table, then row-group order", () => {
    const shared = block(1);
    const owned = byBlock.get(1)!;
    expect(blockOwners(shared, "rowgroup", owned)).toEqual([
      "main.a · RG 0",
      "main.a · RG 1",
    ]);
    expect(blockCellColors(shared, "rowgroup", owned)).toEqual([
      rowGroupColor({ table: "main.a", rowGroup: 0 }),
      rowGroupColor({ table: "main.a", rowGroup: 1 }),
    ]);
  });

  test("neighbouring row groups of a table get different shades", () => {
    const shades = [0, 1, 2, 3].map((rowGroup) =>
      rowGroupColor({ table: "main.a", rowGroup }),
    );
    expect(new Set(shades).size).toBe(4);
    expect(rowGroupColor({ table: "main.a", rowGroup: 4 })).toBe(shades[0]);
  });

  test("blocks without column data keep their role color", () => {
    expect(blockCellColors(block(7, "index"), "rowgroup", [])).toEqual([
      roleColors.index,
    ]);
    expect(blockCellColors(block(8, "data"), "rowgroup", [])).toEqual([
      roleColors.unknown,
    ]);
  });
});
