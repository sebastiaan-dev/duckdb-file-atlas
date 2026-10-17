import { describe, expect, test } from "bun:test";
import { createDemo, demoBytes } from "../src/lib/demo";

const demo = createDemo();

describe("illustrative warehouse model", () => {
  test("is deterministic, substantial, and explicitly synthetic", () => {
    expect(createDemo()).toEqual(demo);
    expect(demo.source).toBe("demo");
    expect(demo.capabilities.checksums).toBe(false);
    expect(demo.warnings.join(" ")).toMatch(/synthetic/);
    expect(demo.blocks.filter((block) => block.id >= 0).length).toBeGreaterThan(
      200,
    );
    expect(demo.blockSize).toBe(256 * 1024);
    expect(demo.headers).toHaveLength(2);
    expect(
      demo.headers.every(
        (header) =>
          header.valid && header.blockCount === demo.blocks.length - 3,
      ),
    ).toBe(true);
  });

  test("partitions the complete file without overlaps or unexplained bytes", () => {
    let fileCursor = 0;
    for (const block of demo.blocks) {
      expect(block.offset).toBe(fileCursor);
      if (block.id >= 0) {
        expect(block.offset).toBe(3 * 4096 + block.id * demo.blockSize);
        expect(block.size).toBe(demo.blockSize);
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
    expect(fileCursor).toBe(demo.fileSize);
  });

  test("every segment and pointer resolves within its physical block", () => {
    const blocks = new Map(demo.blocks.map((block) => [block.id, block]));
    const ids = new Set(demo.segments.map((segment) => segment.id));
    expect(ids.size).toBe(demo.segments.length);
    for (const block of demo.blocks) {
      for (const link of block.links) expect(blocks.has(link)).toBe(true);
      for (const id of block.segmentIds) expect(ids.has(id)).toBe(true);
    }
    for (const segment of demo.segments) {
      const block = blocks.get(segment.blockId)!;
      expect(block.role).toBe("data");
      expect(block.segmentIds).toContain(segment.id);
      expect(segment.offset).toBeGreaterThanOrEqual(demo.blockHeaderSize);
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
      demo.blocks
        .filter((block) => block.role === "free")
        .map((block) => block.id),
    );
  });

  test("column chunks cover each row group exactly once and share physical storage", () => {
    const logicalColumns = new Map<string, typeof demo.segments>();
    for (const segment of demo.segments) {
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
    expect(new Set(demo.segments.map((segment) => segment.table)).size).toBe(3);
    for (const table of new Set(
      demo.segments.map((segment) => segment.table),
    )) {
      expect(
        new Set(
          demo.segments
            .filter((segment) => segment.table === table)
            .map((segment) => segment.rowGroup),
        ).size,
      ).toBeGreaterThanOrEqual(8);
    }
    expect(
      demo.blocks.some(
        (block) =>
          new Set(
            demo.segments
              .filter((segment) => block.segmentIds.includes(segment.id))
              .map((segment) => segment.table),
          ).size > 1,
      ),
    ).toBe(true);
  });

  test("placeholder byte slices are bounded and stable", () => {
    expect(demoBytes(29, 10)).toEqual(demoBytes(24, 15).slice(5));
    expect(() => demoBytes(demo.fileSize, 1)).toThrow(RangeError);
    expect(() => demoBytes(-1, 1)).toThrow(RangeError);
  });
});
