import { expect, test } from "bun:test";
import { byteRangeAppearance } from "../src/lib/byte-range-colors";
import {
  blockColor,
  stableColor,
  tablePalette,
  compressionPalette,
} from "../src/lib/palette";
import type {
  ByteRange,
  ColorMode,
  FileBlock,
  Segment,
} from "../src/lib/types";

const range: ByteRange = {
  id: "range",
  label: "Data",
  offset: 8,
  size: 128,
  kind: "segment",
  segmentId: "segment",
};
const block: FileBlock = {
  id: 0,
  offset: 0,
  size: 256,
  role: "data",
  label: "Data block",
  usedBytes: 136,
  ranges: [
    range,
    { id: "tail", label: "Tail", kind: "unused", offset: 136, size: 120 },
  ],
  segmentIds: ["segment"],
  links: [],
};
const segment: Segment = {
  id: "segment",
  table: "main.orders",
  column: "o_orderkey",
  columnType: "BIGINT",
  rowGroup: 0,
  blockId: 0,
  offset: 8,
  byteSize: 128,
  rowStart: 0,
  rowCount: 16,
  compression: "BitPacking",
};

test("byte ownership colors agree with physical-map palettes", () => {
  for (const [mode, owner, palette] of [
    ["table", segment.table, tablePalette],
    ["column", `${segment.table}.${segment.column}`, tablePalette],
    ["compression", segment.compression, compressionPalette],
  ] as const) {
    for (const kind of ["segment", "validity", "dictionary"] as const) {
      expect(
        byteRangeAppearance({ ...range, kind }, block, mode, segment),
      ).toEqual({ label: owner, background: stableColor(owner, palette) });
    }
    expect(byteRangeAppearance(range, block, mode)).toEqual(
      byteRangeAppearance(range, block, "role"),
    );
  }
});

test("allocator bytes and unknown coverage stay distinct in every main color mode", () => {
  for (const mode of [
    "role",
    "table",
    "column",
    "compression",
    "utilization",
    "fragmentation",
  ] as ColorMode[]) {
    for (const kind of [
      "checksum",
      "header",
      "metadata",
      "unused",
      "unknown",
    ] as const) {
      const value = { ...range, kind };
      expect(byteRangeAppearance(value, block, mode, segment)).toEqual(
        byteRangeAppearance(value, block, "role"),
      );
    }
    expect(
      byteRangeAppearance(
        { ...range, kind: "unknown" },
        { ...block, role: "index" },
        mode,
        segment,
      ).background,
    ).toContain("repeating-linear-gradient");
  }
});

test("space modes use the main map's measured block ramp, including unknown measurements", () => {
  for (const mode of ["utilization", "fragmentation"] as const) {
    for (const measured of [block, { ...block, usedBytes: null }]) {
      expect(
        byteRangeAppearance(range, measured, mode, segment).background,
      ).toBe(blockColor(measured, mode, [segment]));
    }
  }
});

test("whole reusable blocks are distinct from gaps inside allocated blocks", () => {
  const unused = { ...range, kind: "unused" as const };
  const gap = byteRangeAppearance(unused, block, "role");
  const free = byteRangeAppearance(
    unused,
    { ...block, role: "free" },
    "column",
    segment,
  );
  expect(gap.label).toBe("Unused bytes");
  expect(free.label).toBe("Reusable free block");
  expect(gap.background).not.toBe(free.background);
  expect(
    byteRangeAppearance(
      { ...range, kind: "checksum" },
      { ...block, role: "free" },
      "table",
      segment,
    ).label,
  ).toBe("Checksum");
});

test("role mode colors index ranges like the Indexes view's node-type legend", () => {
  const indexBlock: FileBlock = { ...block, role: "index" };
  const node = byteRangeAppearance(
    { ...range, kind: "index", nodeType: "NODE16", indexId: "i" },
    indexBlock,
    "role",
  );
  expect(node).toEqual({
    label: "NODE16 nodes",
    background: "var(--node-node16)",
  });
  expect(
    byteRangeAppearance(
      { ...range, kind: "index", nodeType: "PREFIX", indexMask: true },
      indexBlock,
      "role",
    ).background,
  ).toBe("var(--index-mask)");
  const hole = byteRangeAppearance(
    { ...range, kind: "unused", nodeType: "PREFIX", indexId: "i" },
    indexBlock,
    "role",
  );
  expect(hole.label).toBe("Free PREFIX slots");
  // Other color modes keep their ownership semantics.
  expect(
    byteRangeAppearance(
      { ...range, kind: "index", nodeType: "NODE16" },
      indexBlock,
      "compression",
    ).label,
  ).toBe("Unknown compression (index nodes)");
});
