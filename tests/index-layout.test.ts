import { describe, expect, test } from "bun:test";
import type { IndexInspection } from "../src/lib/types";
import {
  allocatorValue,
  bufferOccupancy,
  BUFFER_TILE_LIMIT,
  INDEX_ROW_LIMIT,
  initialBufferCount,
  indexMeasurements,
  isMeasuredIndex,
  moveBufferFocus,
  occupancyColor,
  rankAllocators,
  sortedIndexBuffers,
} from "../src/lib/index-layout";

const index = (complete = true): IndexInspection => ({
  id: "a",
  table: "main.t",
  name: "a",
  root: "0",
  rootPointer: { packed: "0", nodeType: "EMPTY", typeId: 0, gate: false },
  options: {},
  blockIds: [],
  complete,
  occupiedBytes: 24,
  freeBytes: 8,
  maskOverheadBytes: 16,
  allocationBytes: 48,
  allocators: [
    {
      ordinal: 0,
      nodeType: "WIDE",
      segmentSize: 16,
      capacity: 16,
      maskBytes: 8,
      occupiedSlots: 1,
      occupiedBytes: 16,
      freeBytes: 0,
      maskOverheadBytes: 8,
      allocationBytes: 24,
      buffers: [
        {
          bufferId: 0,
          blockId: 2,
          offset: 0,
          absoluteOffset: 200,
          allocationSize: 24,
          segmentCount: 1,
          storedSlots: 1,
          occupiedBytes: 16,
          freeBytes: 0,
          hasFreeSpace: true,
          runs: [],
        },
      ],
    },
    {
      ordinal: 1,
      nodeType: "NARROW",
      segmentSize: 4,
      capacity: 16,
      maskBytes: 8,
      occupiedSlots: 2,
      occupiedBytes: 8,
      freeBytes: 8,
      maskOverheadBytes: 8,
      allocationBytes: 24,
      buffers: [
        {
          bufferId: 0,
          blockId: 1,
          offset: 0,
          absoluteOffset: 100,
          allocationSize: 24,
          segmentCount: 2,
          storedSlots: 4,
          occupiedBytes: 8,
          freeBytes: 8,
          hasFreeSpace: true,
          runs: [],
        },
      ],
    },
    {
      ordinal: 2,
      nodeType: "EMPTY",
      segmentSize: 8,
      capacity: 16,
      maskBytes: 8,
      occupiedSlots: 0,
      occupiedBytes: 0,
      freeBytes: 0,
      maskOverheadBytes: 0,
      allocationBytes: 0,
      buffers: [],
    },
  ],
});

describe("linked index graph measurements", () => {
  test("ordinary buffer maps are complete initially; exceptional maps stay bounded", () => {
    for (const count of [0, 1, 256, 621, 1024])
      expect(initialBufferCount(count)).toBe(count);
    for (const count of [1025, 100000])
      expect(initialBufferCount(count)).toBe(256);
  });
  test("complete zero is measured, partial catalog counters are not", () => {
    const zero = {
      ...index(),
      occupiedBytes: 0,
      freeBytes: 0,
      maskOverheadBytes: 0,
      allocationBytes: 0,
      allocators: [],
    };
    expect(isMeasuredIndex(zero)).toBe(true);
    expect(indexMeasurements([zero]).axisMax).toBe(0);
    expect(indexMeasurements([zero]).measuredCount).toBe(1);
    const partial = index(false);
    expect(isMeasuredIndex(partial)).toBe(false);
    expect(rankAllocators(partial, "bytes")).toEqual([]);
    expect(sortedIndexBuffers(partial)).toEqual([]);
    expect(indexMeasurements([partial]).totals.allocationBytes).toBe(0);
    expect(isMeasuredIndex({ ...index(), freeBytes: null })).toBe(false);
  });
  test("full-file totals and axis exclude unknowns but retain largest measured envelope", () => {
    const huge = { ...index(), id: "b", allocationBytes: 48000 };
    const result = indexMeasurements([index(), huge, index(false)]);
    expect(result.axisMax).toBe(48000);
    expect(result.measuredCount).toBe(2);
    expect(result.totals.allocationBytes).toBe(48048);
  });
  test("bytes and slot rankings differ and empty classes are hidden without mutation", () => {
    const model = index();
    expect(rankAllocators(model, "bytes").map((row) => row.ordinal)).toEqual([
      0, 1,
    ]);
    expect(rankAllocators(model, "slots").map((row) => row.ordinal)).toEqual([
      1, 0,
    ]);
    expect(allocatorValue(model.allocators[0], "bytes")).toBe(16);
    expect(model.allocators.map((row) => row.ordinal)).toEqual([0, 1, 2]);
  });
  test("buffers sort by absolute offset with class-scoped IDs", () => {
    const tiles = sortedIndexBuffers(index());
    expect(tiles.map((tile) => tile.buffer.absoluteOffset)).toEqual([100, 200]);
    expect(new Set(tiles.map((tile) => tile.key)).size).toBe(2);
    expect(bufferOccupancy(tiles[0].buffer)).toBe(0.5);
    expect(bufferOccupancy({ ...tiles[0].buffer, storedSlots: 0 })).toBeNull();
    expect(occupancyColor(0.5)).toContain("50%");
    expect(occupancyColor(0)).toContain("0%");
    expect(occupancyColor(1)).toContain("100%");
  });
  test("roving focus is bounded and graph batches are deliberately limited", () => {
    expect(INDEX_ROW_LIMIT).toBe(32);
    expect(BUFFER_TILE_LIMIT).toBe(256);
    expect(moveBufferFocus(0, "ArrowLeft", 10, 256)).toBe(0);
    expect(moveBufferFocus(5, "ArrowDown", 10, 256)).toBe(15);
    expect(moveBufferFocus(255, "ArrowRight", 10, 256)).toBe(255);
    expect(moveBufferFocus(20, "Home", 10, 256)).toBe(0);
    expect(moveBufferFocus(20, "End", 10, 256)).toBe(255);
  });
});
