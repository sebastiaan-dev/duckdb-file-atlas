import { expect, test } from "bun:test";
import {
  buildFreeRuns,
  filterFreeRuns,
  metadataSlotSize,
  fitRunGrouping,
  runBarWidth,
  runCell,
  hitRunCell,
} from "../src/lib/free-list";
import type { FreeListState } from "../src/lib/types";

test("groups sorted free IDs into contiguous runs without mixing serialized and implicit sources", () => {
  const state: FreeListState = {
    checkpoint: 1,
    complete: true,
    root: null,
    chain: [],
    blockIds: [6, 3, 2, 8],
    implicitBlockIds: [9, 10],
    metadata: [],
    multiUseBlocks: [],
  };
  const runs = buildFreeRuns(state);
  expect(runs).toEqual([
    { start: 2, end: 3, count: 2, source: "serialized" },
    { start: 6, end: 6, count: 1, source: "serialized" },
    { start: 8, end: 8, count: 1, source: "serialized" },
    { start: 9, end: 10, count: 2, source: "implicit" },
  ]);
  expect(filterFreeRuns(runs, "3")).toEqual([runs[0]]);
  expect(filterFreeRuns(runs, "10")).toEqual([runs[3]]);
  expect(filterFreeRuns(runs, "implicit")).toEqual([runs[3]]);
  expect(filterFreeRuns(runs, "11")).toEqual([]);
  expect(filterFreeRuns(runs, "")).toBe(runs);
  expect(state.blockIds).toEqual([6, 3, 2, 8]);
  expect(metadataSlotSize(262144)).toBe(4088);
  expect(metadataSlotSize(16384)).toBe(248);
});

test("free-run tiles share a scale and group long runs without building per-block objects", () => {
  expect(fitRunGrouping(68, 680)).toBe(1);
  expect(fitRunGrouping(100000, 680)).toBe(2048);
  expect(fitRunGrouping(0, 0)).toBe(1);
  expect(runBarWidth(1, 1)).toBe(8);
  expect(runBarWidth(8, 1)).toBe(78);
  expect(runBarWidth(68, 1)).toBe(678);
  const run: FreeRun = {
    start: 100,
    end: 109,
    count: 10,
    source: "serialized",
  };
  expect(runCell(run, 4, 2)).toEqual({
    index: 2,
    first: 108,
    last: 109,
    count: 2,
  });
  expect(runCell(run, 4, 3)).toBeNull();
  expect(hitRunCell(run, 1, 14)?.first).toBe(101);
  expect(hitRunCell(run, 1, 8)).toBeNull();
  expect(hitRunCell(run, 1, -1)).toBeNull();
  expect(hitRunCell(run, 1, 98)).toBeNull();
  expect(hitRunCell(run, 4, 22)?.count).toBe(2);
  expect(hitRunCell(run, 4, 24)).toBeNull();
  const huge: FreeRun = {
    start: 1,
    end: 100000,
    count: 100000,
    source: "serialized",
  };
  expect(runCell(huge, 1, 99999)?.first).toBe(100000);
  expect(runCell(huge, 2048, 48)?.last).toBe(100000);
});
