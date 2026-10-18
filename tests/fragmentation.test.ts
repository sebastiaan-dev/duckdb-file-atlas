import { expect, test } from "bun:test";
import { attachNativeSegments } from "../src/lib/checkpoint-reader";
import {
  fragmentationSummary,
  internalFreeBytes,
} from "../src/lib/fragmentation";
import type { FileBlock, FileInspection, Segment } from "../src/lib/types";
const makeBlock = (
  id: number,
  role: FileBlock["role"] = "unknown",
): FileBlock => ({
  id,
  offset: id < 0 ? (id + 3) * 4096 : 12288 + id * 1024,
  size: id < 0 ? 4096 : 1024,
  role,
  label: "fixture",
  usedBytes: null,
  ranges: [],
  segmentIds: [],
  links: [],
});
const segment = (
  id: string,
  offset: number,
  byteSize: number | null,
): Segment => ({
  id,
  offset,
  byteSize,
  blockId: 0,
  table: "main.t",
  column: id,
  columnType: "INTEGER",
  rowGroup: 0,
  rowStart: 0,
  rowCount: 100,
  compression: "BitPacking",
});
function fixture() {
  return [-3, -2, -1, 0].map((id) => makeBlock(id));
}
test("exact index holes and tails are mapped but never mixed into data-only summary", () => {
  const index = makeBlock(0, "index");
  index.usedBytes = 224;
  index.ranges = [
    {
      id: "hole",
      label: "Free stored slots",
      kind: "unused",
      offset: index.offset + 224,
      size: 32,
    },
    {
      id: "tail",
      label: "Unallocated index block tail",
      kind: "unused",
      offset: index.offset + 256,
      size: 768,
    },
  ];
  expect(internalFreeBytes(index)).toBe(800);
  const summary = fragmentationSummary({ blocks: [index] } as FileInspection);
  expect(summary.bytes).toBe(0);
  expect(summary.measuredBlocks).toBe(0);
  expect(summary.dataBytes).toBe(0);
  index.usedBytes = null;
  expect(internalFreeBytes(index)).toBeNull();
  for (const role of ["free", "metadata", "unknown"] as const) {
    expect(internalFreeBytes({ ...index, role, usedBytes: 224 })).toBeNull();
  }
});

test("measures exact internal gaps and tails without counting whole free blocks", () => {
  const blocks = fixture();
  attachNativeSegments(blocks, [segment("a", 8, 100), segment("b", 128, 200)]);
  expect(blocks[3].usedBytes).toBe(308);
  expect(
    blocks[3].ranges
      .filter((range) => range.kind === "unused")
      .map((range) => range.size),
  ).toEqual([20, 696]);
  expect(blocks[3].ranges.reduce((sum, range) => sum + range.size, 0)).toBe(
    1024,
  );
  const free = makeBlock(1, "free");
  free.usedBytes = 0;
  blocks.push(free);
  const summary = fragmentationSummary({ blocks } as FileInspection);
  expect(summary.bytes).toBe(716);
  expect(summary.dataBytes).toBe(1024);
  expect(summary.coverage).toBe(1);
});
test("unknown segment lengths and auxiliary allocations never turn unexplained bytes into free space", () => {
  for (const auxiliary of [false, true]) {
    const blocks = fixture();
    attachNativeSegments(
      blocks,
      [segment("a", 8, 100), segment("b", 128, auxiliary ? 200 : null)],
      auxiliary ? new Set([0]) : new Set(),
    );
    expect(blocks[3].usedBytes).toBeNull();
    expect(blocks[3].ranges.some((range) => range.kind === "unused")).toBe(
      false,
    );
  }
});
test("rejects overlapping or out-of-bounds ranges and data in a free block", () => {
  expect(() =>
    attachNativeSegments(fixture(), [
      segment("a", 8, 100),
      segment("b", 100, 200),
    ]),
  ).toThrow(/overlapping/);
  expect(() =>
    attachNativeSegments(fixture(), [segment("a", 1000, 100)]),
  ).toThrow(/bounds/);
  const blocks = fixture();
  blocks[3].role = "free";
  expect(() => attachNativeSegments(blocks, [segment("a", 8, 100)])).toThrow(
    /bounds/,
  );
});
test("accepts only the disk constant sentinel and validates its empty payload", () => {
  const constant = {
    ...segment("constant", 8, 0),
    compression: "Constant",
    blockId: -1,
  };
  expect(() => attachNativeSegments(fixture(), [constant])).not.toThrow();
  expect(() =>
    attachNativeSegments(fixture(), [{ ...constant, blockId: -2 }]),
  ).toThrow(/pointer/);
  expect(() =>
    attachNativeSegments(fixture(), [
      { ...constant, compression: "BitPacking" },
    ]),
  ).toThrow(/sentinel/);
  expect(() =>
    attachNativeSegments(fixture(), [{ ...constant, byteSize: 10 }]),
  ).toThrow(/constant/);
});
