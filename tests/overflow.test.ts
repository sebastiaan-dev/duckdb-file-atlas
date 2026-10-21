import { describe, expect, test } from "bun:test";
import { attachNativeSegments } from "../src/lib/checkpoint-reader";
import {
  indexSegmentsByBlock,
  overflowRuns,
  segmentBlockIds,
  segmentTouchesBlock,
} from "../src/lib/overflow";
import type { FileBlock, Segment } from "../src/lib/types";

const segment = (id: string, extra: Partial<Segment> = {}): Segment => ({
  id,
  table: "main.t",
  column: "text",
  columnType: "VARCHAR",
  rowGroup: 0,
  blockId: 0,
  offset: 8,
  byteSize: 32,
  rowStart: 0,
  rowCount: 1,
  compression: "Uncompressed",
  auxiliaryBlocks: [1],
  ...extra,
});
const fixture = (): FileBlock[] =>
  Array.from({ length: 6 }, (_, i) => ({
    id: i - 3,
    offset: i * 1024,
    size: 1024,
    role: i < 3 ? "header" : "unknown",
    label: "fixture",
    usedBytes: null,
    ranges: [],
    segmentIds: [],
    links: [],
  }));

describe("bounded overflow ownership queries", () => {
  test("deduplicates direct and auxiliary blocks without following links", () => {
    const a = segment("a", { auxiliaryBlocks: [0, 1, 1, 2] });
    const b = segment("b", { blockId: 2, auxiliaryBlocks: [1] });
    expect(segmentBlockIds(a)).toEqual([0, 1, 2]);
    expect(segmentTouchesBlock(a, 1)).toBe(true);
    expect(segmentTouchesBlock(a, 3)).toBe(false);
    expect([...indexSegmentsByBlock([a, b])]).toEqual([
      [0, [a]],
      [1, [a, b]],
      [2, [a, b]],
    ]);
  });

  test("excludes sentinel and invalid physical IDs", () => {
    const a = segment("a", {
      blockId: -1,
      auxiliaryBlocks: [-1, 1.5, NaN, Infinity, 2],
    });
    expect(segmentBlockIds(a)).toEqual([2]);
    for (const id of [-1, 1.5, NaN, Infinity])
      expect(segmentTouchesBlock(a, id)).toBe(false);
    expect(indexSegmentsByBlock([]).size).toBe(0);
  });
});

describe("native overflow allocation attachment", () => {
  test("dedicated shared overflow has indirect refs, unknown bytes and no invented links", () => {
    const blocks = fixture();
    const a = segment("a", { auxiliaryBlocks: [1, 1, 2] });
    const b = segment("b", { offset: 40 });
    blocks[3].links = [2]; // Existing verified links are preserved, not expanded.
    attachNativeSegments(blocks, [a, b]);
    expect(blocks[3].segmentIds).toEqual(["a", "b"]);
    expect(blocks[3].usedBytes).toBe(72);
    expect(blocks[3].links).toEqual([2]);
    expect(blocks[4].role).toBe("overflow");
    expect(blocks[4].segmentIds).toEqual([]);
    expect(blocks[4].overflowSegmentIds).toEqual(["a", "b"]);
    expect(blocks[5].overflowSegmentIds).toEqual(["a"]);
    for (const block of blocks.slice(4)) {
      expect(block.usedBytes).toBeNull();
      expect(block.links).toEqual([]);
      expect(block.ranges.map((range) => [range.kind, range.size])).toEqual([
        ["checksum", 8],
        ["unknown", 1016],
      ]);
      expect(block.ranges.every((range) => range.segmentId == null)).toBe(true);
    }
  });

  test("mixed direct and overflow allocations keep data role and measured direct extents only", () => {
    const blocks = fixture();
    const a = segment("a", { auxiliaryBlocks: [0, 1] });
    const b = segment("b", { blockId: 1, auxiliaryBlocks: [] });
    attachNativeSegments(blocks, [a, b]);
    for (const [id, direct] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      const block = blocks[id + 3];
      expect(block.role).toBe("data");
      expect(block.segmentIds).toEqual([direct]);
      expect(block.overflowSegmentIds).toEqual(["a"]);
      expect(block.usedBytes).toBeNull();
      expect(block.ranges.map((range) => [range.kind, range.size])).toEqual([
        ["checksum", 8],
        ["segment", 32],
        ["unknown", 984],
      ]);
      expect(block.links).toEqual([]);
    }
  });

  test("rejects corrupt auxiliary pointers before classifying any allocations", () => {
    for (const id of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 3]) {
      const blocks = fixture();
      const before = structuredClone(blocks);
      expect(() =>
        attachNativeSegments(blocks, [
          segment("a", { auxiliaryBlocks: [1, id] }),
        ]),
      ).toThrow(/overflow block pointer/);
      expect(blocks).toEqual(before);
    }
    for (const role of ["free", "metadata", "header", "index"] as const) {
      const blocks = fixture();
      blocks[4].role = role;
      expect(() => attachNativeSegments(blocks, [segment("a")])).toThrow(
        /overflow block pointer/,
      );
    }
    expect(() =>
      attachNativeSegments(fixture(), [segment("a")], new Set(), new Set([1])),
    ).toThrow(/overflow block pointer/);
    const blocks = fixture();
    blocks[4].id = 2;
    expect(() => attachNativeSegments(blocks, [segment("a")])).toThrow(
      /overflow block pointer/,
    );
    expect(() =>
      attachNativeSegments(fixture(), [
        segment("constant", {
          blockId: -1,
          compression: "Constant",
          byteSize: 0,
          auxiliaryBlocks: [20],
        }),
      ]),
    ).toThrow(/overflow block pointer/);
  });
});

describe("overflow runs", () => {
  const blocksById = (blocks: FileBlock[]) =>
    new Map(blocks.map((block) => [block.id, block]));
  const block = (id: number, offset = 12_288 + id * 1024): FileBlock => ({
    ...fixture()[0],
    id,
    offset,
    role: "overflow",
  });
  const summary = (segment: Segment, blocks: FileBlock[]) =>
    overflowRuns(segment, blocksById(blocks)).map((run) => [
      run.first.id,
      run.last.id,
      run.blocks,
      run.bytes,
    ]);

  test("groups file-contiguous allocations in file order and deduplicates", () => {
    const blocks = [1, 2, 3, 5, 6, 9].map((id) => block(id));
    expect(
      summary(segment("a", { auxiliaryBlocks: [9, 3, 1, 2, 2, 6, 5] }), blocks),
    ).toEqual([
      [1, 3, 3, 3072],
      [5, 6, 2, 2048],
      [9, 9, 1, 1024],
    ]);
  });

  test("splits consecutive IDs whose extents do not touch and skips unknown IDs", () => {
    // Consecutive IDs only form a range when the blocks are also adjacent.
    const blocks = [block(1), block(2, 99_999)];
    expect(
      summary(segment("a", { auxiliaryBlocks: [1, 2, 404] }), blocks),
    ).toEqual([
      [1, 1, 1, 1024],
      [2, 2, 1, 1024],
    ]);
    expect(summary(segment("a", { auxiliaryBlocks: undefined }), blocks)).toEqual(
      [],
    );
  });
});
