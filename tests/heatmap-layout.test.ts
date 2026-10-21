import { expect, test } from "bun:test";
import { clampTileSize, heatmapLayout } from "../src/lib/heatmap-layout";

test("min, default, and max tiles fit phone and desktop widths without a column cap", () => {
  for (const width of [320, 375, 800, 1092, 1920, 3840]) {
    for (const cellSize of [2, 4, 7, 8, 24, 64]) {
      const layout = heatmapLayout(width, cellSize);
      expect(layout.cellSize).toBe(cellSize);
      expect(layout.gap).toBe(cellSize < 8 ? 1 : 2);
      expect(layout.gridWidth).toBe(
        layout.columns * cellSize + (layout.columns - 1) * layout.gap,
      );
      expect(layout.gridWidth).toBeLessThanOrEqual(width - 51);
      expect(layout.gridWidth + cellSize + layout.gap).toBeGreaterThan(
        width - 51,
      );
    }
  }
  expect(heatmapLayout(1092, 8).columns).toBe(104);
  expect(heatmapLayout(375, 8).columns).toBe(32);
  expect(heatmapLayout(1920, 4).columns).toBe(374);
});

test("cell size is bounded to 2–64 pixels, with an 8px non-finite fallback", () => {
  expect(heatmapLayout(800, -10).cellSize).toBe(2);
  expect(heatmapLayout(800, 0).cellSize).toBe(2);
  expect(heatmapLayout(800, 100).cellSize).toBe(64);
  for (const size of [NaN, Infinity, -Infinity]) {
    expect(heatmapLayout(800, size).cellSize).toBe(8);
  }
  expect(heatmapLayout(800, 6.5).cellSize).toBe(6.5);
});

test("tiny, invalid, and exact-fit widths always produce at least one column", () => {
  for (const width of [-1, 0, 40, 50, 51, 52, NaN, Infinity, -Infinity]) {
    expect(heatmapLayout(width, 8).columns).toBe(1);
  }
  expect(heatmapLayout(59, 8).columns).toBe(1);
  expect(heatmapLayout(68, 8).columns).toBe(1);
  expect(heatmapLayout(69, 8).columns).toBe(2);
});

test("row labels retain 14px of vertical space, including the first row", () => {
  for (const size of [4, 7, 8, 24]) {
    const { cellSize, gap, labelStride } = heatmapLayout(1092, size);
    const pitch = cellSize + gap;
    expect(labelStride * pitch).toBeGreaterThanOrEqual(14);
    expect((labelStride - 1) * pitch).toBeLessThan(14);
    expect(0 % labelStride).toBe(0);
  }
  expect(heatmapLayout(1092, 4).labelStride).toBe(3);
  expect(heatmapLayout(1092, 8).labelStride).toBe(2);
  expect(heatmapLayout(1092, 24).labelStride).toBe(1);
});

test("axis ticks reserve enough horizontal space for multi-digit column indices", () => {
  for (const width of [320, 1092, 3840, 10000]) {
    for (const size of [4, 8, 24]) {
      const { columns, cellSize, gap, tickStride } = heatmapLayout(width, size);
      const tickWidth = (Math.max(2, String(columns - 1).length) + 1) * 6 + 6;
      expect(tickStride * (cellSize + gap)).toBeGreaterThanOrEqual(tickWidth);
      expect((tickStride - 1) * (cellSize + gap)).toBeLessThan(tickWidth);
    }
  }
});

test("typed tile sizes round to whole pixels within 2–64", () => {
  expect(clampTileSize(1)).toBe(2);
  expect(clampTileSize(-5)).toBe(2);
  expect(clampTileSize(12.4)).toBe(12);
  expect(clampTileSize(12.5)).toBe(13);
  expect(clampTileSize(40)).toBe(40);
  expect(clampTileSize(1000)).toBe(64);
});
