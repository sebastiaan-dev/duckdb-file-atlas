import { describe, expect, test } from "bun:test";
import {
  blockCellColors,
  blockOwners,
  fragmentationSteps,
  rampLabels,
  rampStep,
  utilizationSteps,
  roleColors,
  stableColor,
  tablePalette,
} from "../src/lib/palette";
import { byteRangeAppearance } from "../src/lib/byte-range-colors";
import type { ByteRange, FileBlock, Segment } from "../src/lib/types";

const owner = { id: "idx", table: "main.t", name: "named_index" };
const range: ByteRange = {
  id: "nodes",
  label: "nodes",
  offset: 8,
  size: 40,
  kind: "index",
  indexId: owner.id,
};
const block: FileBlock = {
  id: 0,
  offset: 0,
  size: 128,
  role: "index",
  label: "index",
  usedBytes: 48,
  ranges: [
    range,
    { id: "hole", label: "Free slots", offset: 48, size: 80, kind: "unused" },
  ],
  segmentIds: [],
  links: [],
  indexIds: [owner.id],
  indexOwners: [owner, owner],
};

test("index table and named column ownership are deduplicated and match byte-range colors", () => {
  for (const mode of ["table", "column"] as const) {
    const key =
      mode === "table" ? owner.table : `${owner.table} / ${owner.name}`;
    expect(blockOwners(block, mode, [])).toEqual([key]);
    expect(blockCellColors(block, mode, [])).toEqual([
      stableColor(key, tablePalette),
    ]);
    expect(byteRangeAppearance(range, block, mode, undefined, owner)).toEqual({
      label: key,
      background: stableColor(key, tablePalette),
    });
  }
});

test("index role is teal; compression remains unknown rather than fabricating a column codec", () => {
  expect(byteRangeAppearance(range, block, "role").background).toBe(
    roleColors.index,
  );
  expect(blockCellColors(block, "compression", [])).toEqual([
    roleColors.unknown,
  ]);
  expect(
    byteRangeAppearance(range, block, "compression", undefined, owner)
      .background,
  ).toBe(roleColors.unknown);
  expect(byteRangeAppearance(range, block, "column").background).toBe(
    roleColors.unknown,
  );
});

test("index fragmentation and utilization use physical palettes without coloring free-slot holes as owners", () => {
  for (const mode of ["fragmentation", "utilization"] as const) {
    expect(
      byteRangeAppearance(range, block, mode, undefined, owner).background,
    ).toBe(blockCellColors(block, mode, [])[0]);
    expect(
      byteRangeAppearance(block.ranges[1], block, mode, undefined, owner),
    ).toEqual(byteRangeAppearance(block.ranges[1], block, "role"));
  }
});

test("existing segment owners retain their stable keys with named indexes added", () => {
  const segment = {
    blockId: 0,
    table: owner.table,
    column: "value",
    compression: "BitPacking",
  } as Segment;
  expect(blockOwners(block, "table", [segment])).toEqual([owner.table]);
  expect(blockOwners(block, "column", [segment])).toEqual([
    "main.t.value",
    "main.t / named_index",
  ]);
  expect(blockOwners(block, "compression", [segment])).toEqual(["BitPacking"]);
});

describe("space ramp legend steps", () => {
  test("labels describe the same thresholds the cells use", () => {
    expect(rampLabels(fragmentationSteps)).toEqual([
      "≤ 2%",
      "2–20%",
      "20–50%",
      "> 50%",
    ]);
    expect(rampStep(0.02, fragmentationSteps)).toBe(0);
    expect(rampStep(0.021, fragmentationSteps)).toBe(1);
    expect(rampStep(0.9, utilizationSteps)).toBe(3);
  });
});
