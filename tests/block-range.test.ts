import { describe, expect, test } from "bun:test";
import { blocksBetween, summarizeBlockRange } from "../src/lib/block-range";
import type {
  ByteRange,
  FileBlock,
  IndexInspection,
  Segment,
} from "../src/lib/types";

const SIZE = 1000;
const block = (
  id: number,
  role: FileBlock["role"],
  ranges: Omit<ByteRange, "id">[] = [],
  usedBytes: number | null = null,
): FileBlock => ({
  id,
  offset: 12288 + id * SIZE,
  size: SIZE,
  role,
  label: "fixture",
  usedBytes,
  ranges: ranges.map((range, i) => ({ ...range, id: `${id}-${i}` })),
  segmentIds: [],
  links: [],
});
const range = (
  blockId: number,
  start: number,
  size: number,
  kind: ByteRange["kind"],
  extra: Partial<ByteRange> = {},
): Omit<ByteRange, "id"> => ({
  label: kind,
  offset: 12288 + blockId * SIZE + start,
  size,
  kind,
  ...extra,
});
const segment = (id: string, table: string, compression: string): Segment => ({
  id,
  table,
  column: "c",
  columnType: "INTEGER",
  rowGroup: 0,
  blockId: 0,
  offset: 0,
  byteSize: null,
  rowStart: 0,
  rowCount: 1,
  compression,
});

const segments = new Map(
  [
    segment("a", "main.orders", "BitPacking"),
    segment("b", "main.orders", "RLE"),
    segment("c", "main.part", "BitPacking"),
  ].map((item) => [item.id, item]),
);
const indexes = [
  { id: "idx", table: "main.orders", name: "orders_pk" },
] as IndexInspection[];

const blocks = [
  // Data block: 8 B checksum, two segments, measured 192 B tail.
  block(
    0,
    "data",
    [
      range(0, 0, 8, "checksum"),
      range(0, 8, 500, "segment", { segmentId: "a" }),
      range(0, 508, 300, "segment", { segmentId: "c" }),
      range(0, 808, 192, "unused"),
    ],
    808,
  ),
  // Data block whose usage is unknown: unmapped bytes stay unknown.
  block(1, "data", [range(1, 8, 400, "segment", { segmentId: "b" })]),
  block(2, "free"),
  block(
    3,
    "index",
    [
      range(3, 0, 8, "checksum"),
      range(3, 8, 600, "index", { indexId: "idx" }),
      // Extends past the block end; only the in-block part counts.
      range(3, 608, 1000, "unused"),
    ],
    608,
  ),
];

describe("block range summary", () => {
  const summary = summarizeBlockRange(blocks, segments, indexes)!;

  test("covers the selection's extent, roles and free blocks", () => {
    expect(summary.blockCount).toBe(4);
    expect([summary.firstId, summary.lastId]).toEqual([0, 3]);
    expect(summary.startOffset).toBe(12288);
    expect(summary.endOffset).toBe(12288 + 4 * SIZE);
    expect(summary.totalBytes).toBe(4 * SIZE);
    expect(summary.freeBlocks).toBe(1);
    expect(summary.roles).toEqual([
      { role: "data", blocks: 2, bytes: 2 * SIZE },
      { role: "index", blocks: 1, bytes: SIZE },
      { role: "free", blocks: 1, bytes: SIZE },
    ]);
  });

  test("totals usage only over measured blocks and keeps unknown bytes unknown", () => {
    expect(summary.used).toEqual({
      bytes: 808 + 608,
      ofBytes: 2 * SIZE,
      blocks: 2,
    });
    expect(summary.internalFree).toEqual({
      bytes: 192 + 392,
      ofBytes: 2 * SIZE,
      blocks: 2,
    });
    expect(summary.unmeasuredBlocks).toBe(1);
    expect(summary.composition).toEqual([
      { kind: "data", bytes: 500 + 300 + 400 },
      { kind: "index", bytes: 600 },
      { kind: "metadata", bytes: 16 },
      { kind: "unused", bytes: 192 + 392 },
      { kind: "free", bytes: SIZE },
      { kind: "unknown", bytes: SIZE - 400 },
    ]);
    const composed = summary.composition.reduce(
      (sum, part) => sum + part.bytes,
      0,
    );
    expect(composed).toBe(summary.totalBytes);
  });

  test("ranks owners by measured bytes, with indexes kept apart from tables", () => {
    expect(summary.tables).toEqual([
      { name: "main.orders", bytes: 900, blocks: 2 },
      { name: "main.part", bytes: 300, blocks: 1 },
    ]);
    expect(summary.indexes).toEqual([
      { name: "main.orders / orders_pk", bytes: 600, blocks: 1 },
    ]);
    expect(summary.compressions).toEqual([
      { name: "BitPacking", bytes: 800, blocks: 1 },
      { name: "RLE", bytes: 400, blocks: 1 },
    ]);
    expect(summary.segmentCount).toBe(3);
  });

  test("an empty selection has no summary", () => {
    expect(summarizeBlockRange([], segments)).toBeNull();
  });
});

describe("blocksBetween", () => {
  test("is inclusive and independent of drag direction", () => {
    expect(blocksBetween(blocks, 1, 3).map((b) => b.id)).toEqual([1, 2, 3]);
    expect(blocksBetween(blocks, 3, 1).map((b) => b.id)).toEqual([1, 2, 3]);
    expect(blocksBetween(blocks, 2, 2).map((b) => b.id)).toEqual([2]);
  });

  test("returns nothing when an end is not in the list", () => {
    expect(blocksBetween(blocks, -3, 2)).toEqual([]);
  });
});
