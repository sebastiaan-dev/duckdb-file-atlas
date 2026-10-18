import { describe, expect, test } from "bun:test";
import {
  inspectIndexes,
  attachIndexRanges,
  indexAllocatorGeometry,
  interpretIndexRoot,
} from "../src/lib/checkpoint-index";
import type { IndexStorage } from "../src/lib/checkpoint-catalog";
import type { FileInspection } from "../src/lib/types";

function fixture() {
  const payload = 16376;
  const geometry = indexAllocatorGeometry(payload, 48);
  const bytes = new Uint8Array(16384);
  bytes.fill(255, 8, 8 + geometry.maskBytes);
  bytes[8] = 0b11101010; // occupied slots 0, 2, 4; highest=4.
  const block = {
    id: 0,
    offset: 0,
    size: 16384,
    role: "unknown" as const,
    label: "unknown",
    usedBytes: null,
    ranges: [],
    segmentIds: [],
    links: [],
  };
  const physical = {
    blockSize: 16384,
    blockHeaderSize: 8,
    activeHeader: 1,
    headers: [{ slot: 1, blockCount: 1 }],
    blocks: [block],
  } as unknown as FileInspection;
  const sizes = [16, 48, 40, 152, 648, 2056, 8, 16, 264];
  const index: IndexStorage = {
    name: "by_id",
    root: 2n << 56n,
    options: { storage_version: "69", v1_0_0_storage: false },
    allocatorInfos: sizes.map((segmentSize) => ({
      segmentSize,
      bufferIds: [],
      blockPointers: [],
      segmentCounts: [],
      allocationSizes: [],
      freeBufferIds: [],
    })),
  };
  index.allocatorInfos[1] = {
    segmentSize: 48,
    bufferIds: [0],
    blockPointers: [{ blockId: 0, offset: 0 }],
    segmentCounts: [3],
    allocationSizes: [geometry.maskBytes + 5 * 48],
    freeBufferIds: [0],
  };
  return {
    bytes,
    physical,
    index,
    file: new File([bytes], "index.duckdb"),
    checksum: () => 0n,
  };
}

describe("index allocator inspection", () => {
  test("literal geometry retains a final extra mask word", () => {
    expect(indexAllocatorGeometry(528, 8)).toEqual({
      capacity: 64,
      maskBytes: 16,
    });
    expect(() => indexAllocatorGeometry(1024, 0)).toThrow("Corrupt");
  });
  test("exact occupied/free runs, burden totals, partition and no fake segments", async () => {
    const f = fixture();
    const indexes = await inspectIndexes(
      f.file,
      f.physical,
      [{ table: "main.t", index: f.index }],
      f.checksum,
    );
    const index = indexes[0],
      allocator = index.allocators[1],
      buffer = allocator.buffers[0];
    expect(index.complete).toBe(true);
    expect(buffer.runs).toEqual([
      { start: 0, count: 1, occupied: true },
      { start: 1, count: 1, occupied: false },
      { start: 2, count: 1, occupied: true },
      { start: 3, count: 1, occupied: false },
      { start: 4, count: 1, occupied: true },
    ]);
    expect(index.occupiedBytes).toBe(144);
    expect(index.freeBytes).toBe(96);
    expect(index.allocationBytes).toBe(
      index.occupiedBytes! + index.freeBytes! + index.maskOverheadBytes!,
    );
    attachIndexRanges(f.physical.blocks, indexes);
    const block = f.physical.blocks[0];
    expect(block.indexIds).toEqual([index.id]);
    expect(block.segmentIds).toEqual([]);
    expect(block.ranges.reduce((n, r) => n + r.size, 0)).toBe(block.size);
    expect(block.usedBytes).toBe(8 + allocator.maskBytes + 144);
    expect(
      block.ranges.every(
        (r, i) =>
          !i ||
          r.offset === block.ranges[i - 1].offset + block.ranges[i - 1].size,
      ),
    ).toBe(true);
  });
  test("released v1.5 serialization version 7 uses the same checked allocator layout", async () => {
    for (const version of ["7", "68", "69"]) {
      const f = fixture();
      f.index.options.storage_version = version;
      const [index] = await inspectIndexes(
        f.file,
        f.physical,
        [{ table: "main.t", index: f.index }],
        f.checksum,
      );
      expect(index.complete).toBe(true);
      expect(index.occupiedBytes).toBe(144);
      expect(index.freeBytes).toBe(96);
    }
  });
  test("unknown and retained legacy versions preserve names without invented occupancy", async () => {
    for (const options of [
      {},
      { storage_version: "67", v1_0_0_storage: false },
      { storage_version: "69", v1_0_0_storage: true },
      { storage_version: "70", v1_0_0_storage: false },
      {
        storage_version: "69",
        v1_0_0_storage: false,
        extension_layout: "unknown",
      },
    ]) {
      const f = fixture();
      f.index.options = options;
      const [index] = await inspectIndexes(
        f.file,
        f.physical,
        [{ table: "t", index: f.index }],
        f.checksum,
      );
      expect(index.name).toBe("by_id");
      expect(index.complete).toBe(false);
      expect(index.reason).toBeDefined();
      expect(index.occupiedBytes).toBeNull();
      attachIndexRanges(f.physical.blocks, [index]);
      expect(f.physical.blocks[0].usedBytes).toBeNull();
    }
  });
  test("legacy metadata roots remain explicitly incomplete", async () => {
    const f = fixture();
    f.index.allocatorInfos = [];
    f.index.legacyRootPointer = { blockId: 0, offset: 32 };
    const [index] = await inspectIndexes(
      f.file,
      f.physical,
      [{ table: "t", index: f.index }],
      f.checksum,
    );
    expect(index.complete).toBe(false);
    expect(index.legacyRootPointer).toEqual({ blockId: 0, offset: 32 });
    expect(index.blockIds).toEqual([]); // The metadata root is not an ART allocation block.
    expect(index.occupiedBytes).toBeNull();
  });
  test("empty and inlined roots need no buffers", async () => {
    const f = fixture();
    f.index.allocatorInfos[1].bufferIds = [];
    f.index.allocatorInfos[1].blockPointers = [];
    f.index.allocatorInfos[1].segmentCounts = [];
    f.index.allocatorInfos[1].allocationSizes = [];
    f.index.allocatorInfos[1].freeBufferIds = [];
    for (const root of [0n, (7n << 56n) | 123n]) {
      f.index.root = root;
      const [index] = await inspectIndexes(
        f.file,
        f.physical,
        [{ table: "t", index: f.index }],
        f.checksum,
      );
      expect(index.complete).toBe(true);
      expect(index.occupiedBytes).toBe(0);
      expect(index.blockIds).toEqual([]);
    }
    expect(interpretIndexRoot((7n << 56n) | 123n).inlinedRowId).toBe("123");
    expect(
      interpretIndexRoot((0x83n << 56n) | (23n << 32n) | 17n),
    ).toMatchObject({ nodeType: "NODE4", gate: true, bufferId: 17, slot: 23 });
  });
  test("malformed arrays, masks, counts, IDs, bounds, overlaps and checksums throw Corrupt", async () => {
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      (f) => {
        f.index.allocatorInfos[1].segmentSize = 0;
      },
      (f) => {
        f.index.allocatorInfos[1].allocationSizes = [];
      },
      (f) => {
        f.index.allocatorInfos[1].segmentCounts[0] = 4;
      },
      (f) => {
        f.index.allocatorInfos[1].allocationSizes[0] += 48;
      },
      (f) => {
        f.index.allocatorInfos[1].allocationSizes[0] = 1;
      },
      (f) => {
        f.index.allocatorInfos[1].freeBufferIds = [];
      },
      (f) => {
        f.index.allocatorInfos[1].freeBufferIds = [0, 0];
      },
      (f) => {
        f.index.allocatorInfos[1].bufferIds[0] = 2 ** 32;
      },
      (f) => {
        f.index.allocatorInfos[1].blockPointers[0].offset = 16384;
      },
      (f) => {
        f.index.allocatorInfos[1].blockPointers[0].blockId = 1;
      },
      (f) => {
        f.physical.blocks[0].role = "free";
      },
      (f) => {
        f.physical.blocks[0].segmentIds = ["column"];
      },
      (f) => {
        f.bytes[8] &= ~(1 << 6);
        f.file = new File([f.bytes], "bad");
      },
      (f) => {
        f.checksum = () => 1n;
      },
      (f) => {
        f.index.root |= 1n << 32n;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await expect(
        inspectIndexes(
          f.file,
          f.physical,
          [{ table: "t", index: f.index }],
          f.checksum,
        ),
      ).rejects.toThrow("Corrupt");
    }
    const f = fixture();
    await expect(
      inspectIndexes(
        f.file,
        f.physical,
        [
          { table: "t", index: f.index },
          { table: "other", index: f.index },
        ],
        f.checksum,
      ),
    ).rejects.toThrow("Corrupt");
  });
  test("padding mask bits above capacity are ignored", async () => {
    const f = fixture(),
      geometry = indexAllocatorGeometry(f.physical.blockSize - 8, 48);
    for (let slot = geometry.capacity; slot < geometry.maskBytes * 8; slot++)
      f.bytes[8 + (slot >> 3)] &= ~(1 << (slot & 7));
    f.file = new File([f.bytes], "padding");
    const [index] = await inspectIndexes(
      f.file,
      f.physical,
      [{ table: "t", index: f.index }],
      f.checksum,
    );
    expect(index.complete).toBe(true);
    expect(index.occupiedBytes).toBe(144);
  });
  test("one block read for several nonoverlapping allocator buffers", async () => {
    const f = fixture(),
      a = f.index.allocatorInfos[1];
    const position = a.allocationSizes[0] + 8;
    f.bytes.set(f.bytes.subarray(8, 8 + a.allocationSizes[0]), 8 + position);
    a.bufferIds.push(9);
    a.blockPointers.push({ blockId: 0, offset: position });
    a.segmentCounts.push(3);
    a.allocationSizes.push(a.allocationSizes[0]);
    a.freeBufferIds.push(9);
    const file = new File([f.bytes], "packed");
    let reads = 0;
    const wrapped = {
      slice(...args: Parameters<File["slice"]>) {
        reads++;
        return file.slice(...args);
      },
    } as File;
    const indexes = await inspectIndexes(
      wrapped,
      f.physical,
      [{ table: "t", index: f.index }],
      f.checksum,
    );
    expect(reads).toBe(1);
    expect(indexes[0].occupiedBytes).toBe(288);
    attachIndexRanges(f.physical.blocks, indexes);
    expect(
      f.physical.blocks[0].ranges.some((r) => r.label.includes("gap")),
    ).toBe(true);
  });
});
