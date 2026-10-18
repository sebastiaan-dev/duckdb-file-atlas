import { describe, expect, test } from "bun:test";
import {
  createSyntheticInspection,
  syntheticBytes,
} from "./fixtures/synthetic-inspection";

const model = createSyntheticInspection();

describe("illustrative warehouse model", () => {
  test("is deterministic, substantial, and explicitly synthetic", () => {
    expect(createSyntheticInspection()).toEqual(model);
    expect(model.capabilities.checksums).toBe(false);
    expect(model.warnings.join(" ")).toMatch(/synthetic/);
    expect(
      model.blocks.filter((block) => block.id >= 0).length,
    ).toBeGreaterThan(200);
    expect(model.blockSize).toBe(256 * 1024);
    expect(model.headers).toHaveLength(2);
    expect(
      model.headers.every(
        (header) =>
          header.valid && header.blockCount === model.blocks.length - 3,
      ),
    ).toBe(true);
  });

  test("partitions the complete file without overlaps or unexplained bytes", () => {
    let fileCursor = 0;
    for (const block of model.blocks) {
      expect(block.offset).toBe(fileCursor);
      if (block.id >= 0) {
        expect(block.offset).toBe(3 * 4096 + block.id * model.blockSize);
        expect(block.size).toBe(model.blockSize);
      }
      let cursor = block.offset;
      for (const range of block.ranges) {
        expect(range.offset).toBe(cursor);
        expect(range.size).toBeGreaterThan(0);
        cursor += range.size;
      }
      expect(cursor).toBe(block.offset + block.size);
      expect(block.usedBytes).toBe(
        block.ranges.reduce(
          (sum, range) => sum + (range.kind === "unused" ? 0 : range.size),
          0,
        ),
      );
      fileCursor += block.size;
    }
    expect(fileCursor).toBe(model.fileSize);
  });

  test("every segment and pointer resolves within its physical block", () => {
    const blocks = new Map(model.blocks.map((block) => [block.id, block]));
    const ids = new Set(model.segments.map((segment) => segment.id));
    expect(ids.size).toBe(model.segments.length);
    for (const block of model.blocks) {
      for (const link of block.links) expect(blocks.has(link)).toBe(true);
      for (const id of block.segmentIds) expect(ids.has(id)).toBe(true);
    }
    for (const segment of model.segments) {
      const block = blocks.get(segment.blockId)!;
      expect(block.role).toBe("data");
      expect(block.segmentIds).toContain(segment.id);
      expect(segment.offset).toBeGreaterThanOrEqual(model.blockHeaderSize);
      expect(segment.offset + segment.byteSize!).toBeLessThanOrEqual(
        block.size,
      );
      const range = block.ranges.find(
        (range) => range.segmentId === segment.id,
      )!;
      expect(range.offset).toBe(block.offset + segment.offset);
      expect(range.size).toBe(segment.byteSize);
    }
    expect(blocks.get(1)!.links).toEqual(
      model.blocks
        .filter((block) => block.role === "free")
        .map((block) => block.id),
    );
  });

  test("column chunks cover each row group exactly once and share physical storage", () => {
    const logicalColumns = new Map<string, typeof model.segments>();
    for (const segment of model.segments) {
      const key = `${segment.table}.${segment.column}:${segment.rowGroup}`;
      logicalColumns.set(key, [...(logicalColumns.get(key) ?? []), segment]);
    }
    const rowsByGroup = new Map<string, number>();
    for (const chunks of logicalColumns.values()) {
      chunks.sort((a, b) => a.rowStart - b.rowStart);
      let cursor = chunks[0].rowGroup * 122_880;
      for (const chunk of chunks) {
        expect(chunk.rowStart).toBe(cursor);
        expect(chunk.nullCount!).toBeLessThanOrEqual(chunk.rowCount);
        cursor += chunk.rowCount;
      }
      const rows = cursor - chunks[0].rowGroup * 122_880;
      const group = `${chunks[0].table}:${chunks[0].rowGroup}`;
      if (rowsByGroup.has(group)) expect(rows).toBe(rowsByGroup.get(group)!);
      rowsByGroup.set(group, rows);
    }
    expect(
      [...logicalColumns.values()].some((chunks) => chunks.length > 4),
    ).toBe(true);
    expect(new Set(model.segments.map((segment) => segment.table)).size).toBe(
      3,
    );
    for (const table of new Set(
      model.segments.map((segment) => segment.table),
    )) {
      expect(
        new Set(
          model.segments
            .filter((segment) => segment.table === table)
            .map((segment) => segment.rowGroup),
        ).size,
      ).toBeGreaterThanOrEqual(8);
    }
    expect(
      model.blocks.some(
        (block) =>
          new Set(
            model.segments
              .filter((segment) => block.segmentIds.includes(segment.id))
              .map((segment) => segment.table),
          ).size > 1,
      ),
    ).toBe(true);
  });

  test("placeholder byte slices are bounded and stable", () => {
    expect(syntheticBytes(29, 10)).toEqual(syntheticBytes(24, 15).slice(5));
    expect(() => syntheticBytes(model.fileSize, 1)).toThrow(RangeError);
    expect(() => syntheticBytes(-1, 1)).toThrow(RangeError);
  });
});
