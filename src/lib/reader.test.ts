import { describe, expect, it } from "bun:test";
import { inspectFile, LATEST_STORAGE_VERSION, readBytes } from "./reader";

const PAGE_SIZE = 4096;
const DATA_START = PAGE_SIZE * 3;
const DEFAULT_BLOCK_SIZE = 16_384;
const INVALID = 0xffff_ffff_ffff_ffffn;

interface FixtureOptions {
  mainVersion?: bigint;
  encrypted?: boolean;
  blockCount?: number;
  blockSize?: number;
  slot1?: Partial<HeaderValues>;
  slot2?: Partial<HeaderValues>;
  corruptSlot1Checksum?: boolean;
  corruptSlot2Checksum?: boolean;
  corruptBothSlotChecksums?: boolean;
}

interface HeaderValues {
  iteration: bigint;
  metaBlock: bigint;
  freeList: bigint;
  blockCount: bigint;
  blockSize: bigint;
  vectorSize: bigint;
  storageVersion: bigint;
}

function makeFixture(options: FixtureOptions = {}): Uint8Array {
  const blockCount = options.blockCount ?? 0;
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const bytes = new Uint8Array(DATA_START + blockCount * blockSize);

  const main = bytes.subarray(0, PAGE_SIZE);
  const payload = main.subarray(8);
  payload.set(new TextEncoder().encode("DUCK"));
  putU64(payload, 4, options.mainVersion ?? 999n);
  putU64(payload, 12, options.encrypted ? 1n : 0n);
  payload.set(new TextEncoder().encode("v2.0.0-test"), 44);
  checksumPage(main);

  const slot1 = {
    iteration: 4n,
    metaBlock: INVALID,
    freeList: INVALID,
    blockCount: BigInt(blockCount),
    blockSize: BigInt(blockSize),
    vectorSize: 2048n,
    storageVersion: BigInt(LATEST_STORAGE_VERSION),
    ...options.slot1,
  };
  const slot2 = {
    iteration: 5n,
    metaBlock: INVALID,
    freeList: INVALID,
    blockCount: BigInt(blockCount),
    blockSize: BigInt(blockSize),
    vectorSize: 2048n,
    storageVersion: BigInt(LATEST_STORAGE_VERSION),
    ...options.slot2,
  };
  writeHeader(bytes, 1, slot1);
  writeHeader(bytes, 2, slot2);
  if (options.corruptSlot1Checksum || options.corruptBothSlotChecksums)
    bytes[PAGE_SIZE] ^= 1;
  if (options.corruptSlot2Checksum || options.corruptBothSlotChecksums)
    bytes[PAGE_SIZE * 2] ^= 1;
  return bytes;
}

function writeHeader(
  bytes: Uint8Array,
  slot: 1 | 2,
  header: HeaderValues,
): void {
  const page = bytes.subarray(slot * PAGE_SIZE, (slot + 1) * PAGE_SIZE);
  const payload = page.subarray(8);
  putU64(payload, 0, header.iteration);
  putU64(payload, 8, header.metaBlock);
  putU64(payload, 16, header.freeList);
  putU64(payload, 24, header.blockCount);
  putU64(payload, 32, header.blockSize);
  putU64(payload, 40, header.vectorSize);
  putU64(payload, 48, header.storageVersion);
  checksumPage(page);
}

function writeMetadataBlock(
  bytes: Uint8Array,
  blockId: number,
  blockSize: number,
  fill: (payload: Uint8Array) => void,
): void {
  const offset = DATA_START + blockId * blockSize;
  const block = bytes.subarray(offset, offset + blockSize);
  fill(block.subarray(8));
  putU64(block, 0, checksum(block.subarray(8)));
}

function makePointer(blockId: number, subblockIndex = 0): bigint {
  return (BigInt(subblockIndex) << 56n) | BigInt(blockId);
}

function putU64(bytes: Uint8Array, offset: number, value: bigint): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(
    0,
    value,
    true,
  );
}

function checksumPage(page: Uint8Array): void {
  putU64(page, 0, checksum(page.subarray(8)));
}

function checksum(bytes: Uint8Array): bigint {
  let result = 5381n;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 8 <= bytes.length; offset += 8) {
    result ^=
      (view.getBigUint64(offset, true) * 0xbf58476d1ce4e5b9n) &
      0xffff_ffff_ffff_ffffn;
  }
  return result & 0xffff_ffff_ffff_ffffn;
}

function asFile(bytes: Uint8Array, name = "fixture.duckdb"): File {
  return new File([bytes], name, { type: "application/octet-stream" });
}

describe("DuckDB file reader", () => {
  it("selects the checksummed checkpoint with the highest iteration and exposes JSON-safe header blocks", async () => {
    const result = await inspectFile(
      asFile(
        makeFixture({
          slot1: { iteration: 18n },
          slot2: { iteration: 21n },
        }),
      ),
    );

    expect(result.storageVersion).toBe(69);
    expect(result.activeHeader).toBe(2);
    expect(result.blocks.slice(0, 3).map((block) => block.id)).toEqual([
      -3, -2, -1,
    ]);
    expect(result.blocks[0].ranges[0]).toMatchObject({
      offset: 0,
      size: 8,
      kind: "checksum",
    });
    expect(result.headerFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("falls back to the other checkpoint when one header checksum is damaged", async () => {
    const result = await inspectFile(
      asFile(makeFixture({ corruptSlot2Checksum: true })),
    );
    expect(result.activeHeader).toBe(1);
    expect(result.headers.find((header) => header.slot === 2)?.valid).toBe(
      false,
    );
  });

  it("rejects storage versions other than 69", async () => {
    const bytes = makeFixture({ slot2: { storageVersion: 68n } });
    await expect(inspectFile(asFile(bytes))).rejects.toThrow(
      /Storage version 68 is not supported/,
    );
  });

  it("rejects encrypted files and truncated headers", async () => {
    await expect(
      inspectFile(asFile(makeFixture({ encrypted: true }))),
    ).rejects.toThrow(/Encrypted/);
    await expect(
      inspectFile(asFile(makeFixture().subarray(0, DATA_START - 1))),
    ).rejects.toThrow(/truncated/);
  });

  it("rejects out-of-range metadata pointers before reading blocks", async () => {
    const bytes = makeFixture({
      blockCount: 1,
      slot2: { metaBlock: makePointer(1) },
    });
    await expect(inspectFile(asFile(bytes))).rejects.toThrow(
      /outside the 1-block checkpoint/,
    );
  });

  it("verifies a reachable metadata block and rejects a bad block checksum", async () => {
    const blockSize = DEFAULT_BLOCK_SIZE;
    const bytes = makeFixture({
      blockCount: 1,
      slot2: { metaBlock: makePointer(0) },
    });
    writeMetadataBlock(bytes, 0, blockSize, (payload) =>
      putU64(payload, 0, INVALID),
    );
    writeHeader(bytes, 2, {
      iteration: 5n,
      metaBlock: makePointer(0),
      freeList: INVALID,
      blockCount: 1n,
      blockSize: BigInt(blockSize),
      vectorSize: 2048n,
      storageVersion: 69n,
    });
    const result = await inspectFile(asFile(bytes));
    expect(result.blocks.find((block) => block.id === 0)?.role).toBe(
      "metadata",
    );
    expect(result.blocks.find((block) => block.id === 0)?.checksum).toMatch(
      /^0x[0-9a-f]{16}$/,
    );

    bytes[DATA_START + 8 + 16] ^= 1;
    await expect(inspectFile(asFile(bytes))).rejects.toThrow(
      /block 0 failed checksum/,
    );
  });

  it("classifies free blocks only after verifying the free-list chain", async () => {
    const blockSize = DEFAULT_BLOCK_SIZE;
    const bytes = makeFixture({
      blockCount: 2,
      slot2: { freeList: makePointer(0) },
    });
    writeMetadataBlock(bytes, 0, blockSize, (payload) => {
      putU64(payload, 0, INVALID);
      putU64(payload, 8, 1n); // one free block
      putU64(payload, 16, 1n); // block id 1
      putU64(payload, 24, 0n); // no multi-use blocks
      putU64(payload, 32, 0n); // no metadata allocator blocks
    });
    writeHeader(bytes, 2, {
      iteration: 5n,
      metaBlock: INVALID,
      freeList: makePointer(0),
      blockCount: 2n,
      blockSize: BigInt(blockSize),
      vectorSize: 2048n,
      storageVersion: 69n,
    });

    const result = await inspectFile(asFile(bytes));
    expect(result.blocks.find((block) => block.id === 1)?.role).toBe("free");
    expect(result.freeList).toEqual({
      checkpoint: 2,
      complete: true,
      root: { blockId: 0, slot: 0 },
      chain: [{ blockId: 0, slot: 0, next: null }],
      blockIds: [1],
      implicitBlockIds: [],
      metadata: [],
      multiUseBlocks: [],
      trimmedBlocks: 0,
    });
  });

  it("accepts a file DuckDB truncated after writing the header's block count", async () => {
    // DuckDB writes block_count before releasing this checkpoint's freed
    // blocks, then trims trailing free blocks without rewriting the header.
    const blockSize = DEFAULT_BLOCK_SIZE;
    const full = makeFixture({
      blockCount: 5,
      slot2: { freeList: makePointer(0) },
    });
    writeMetadataBlock(full, 0, blockSize, (payload) => {
      putU64(payload, 0, INVALID);
      putU64(payload, 8, 2n); // two serialized free blocks…
      putU64(payload, 16, 1n);
      putU64(payload, 24, 4n); // …one of them in the trimmed tail
      putU64(payload, 32, 0n);
      putU64(payload, 40, 0n);
    });
    const trimmed = full.slice(0, DATA_START + 3 * blockSize);
    const result = await inspectFile(asFile(trimmed));
    expect(result.headers.find((h) => h.slot === 2)?.blockCount).toBe(5);
    expect(result.blocks.filter((block) => block.id >= 0)).toHaveLength(3);
    expect(result.freeList?.blockIds).toEqual([1]);
    expect(result.freeList?.trimmedBlocks).toBe(2);
    expect(result.warnings.join(" ")).toMatch(
      /records 5 blocks, but the file holds 3.*released 2 trailing free blocks/,
    );
  });

  it("rejects a copy cut partway through a block", async () => {
    const bytes = makeFixture({ blockCount: 3 });
    await expect(
      inspectFile(
        asFile(bytes.slice(0, DATA_START + DEFAULT_BLOCK_SIZE + 100)),
      ),
    ).rejects.toThrow(/ends partway through block 1/);
  });

  it("rejects live metadata that lies in a missing file tail", async () => {
    const bytes = makeFixture({
      blockCount: 3,
      slot2: { metaBlock: makePointer(2) },
    });
    await expect(
      inspectFile(asFile(bytes.slice(0, DATA_START + 2 * DEFAULT_BLOCK_SIZE))),
    ).rejects.toThrow(/metadata block 2 lies beyond the end of the file/);
  });

  it("tracks slot-level chains, metadata masks and shared references without BigInt serialization", async () => {
    const blockSize = DEFAULT_BLOCK_SIZE;
    const slotSize = Math.floor((blockSize - 8) / 64 / 8) * 8;
    const bytes = makeFixture({
      blockCount: 44,
      slot2: { freeList: makePointer(0, 2) },
    });
    const stream = new Uint8Array(388);
    let cursor = 0;
    const put = (value: bigint) => {
      putU64(stream, cursor, value);
      cursor += 8;
    };
    put(40n);
    for (let id = 2; id < 42; id++) put(BigInt(id));
    put(1n);
    put(1n);
    new DataView(stream.buffer).setUint32(cursor, 3, true);
    cursor += 4;
    put(2n);
    put(0n);
    put(INVALID ^ (1n << 2n) ^ (1n << 3n));
    put(42n);
    put(INVALID ^ (1n << 7n));
    writeMetadataBlock(bytes, 0, blockSize, (payload) => {
      putU64(payload, 2 * slotSize, makePointer(0, 3));
      payload.set(stream.subarray(0, slotSize - 8), 2 * slotSize + 8);
      putU64(payload, 3 * slotSize, INVALID);
      payload.set(stream.subarray(slotSize - 8), 3 * slotSize + 8);
    });
    const result = await inspectFile(asFile(bytes));
    expect(result.freeList?.root).toEqual({ blockId: 0, slot: 2 });
    expect(result.freeList?.chain).toEqual([
      { blockId: 0, slot: 2, next: { blockId: 0, slot: 3 } },
      { blockId: 0, slot: 3, next: null },
    ]);
    expect(result.freeList?.blockIds).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 2),
    );
    expect(result.freeList?.multiUseBlocks).toEqual([
      { blockId: 1, references: 3 },
    ]);
    expect(result.freeList?.metadata[0].freeSlots).toHaveLength(62);
    expect(result.freeList?.metadata[1].freeSlots).not.toContain(7);
    expect(() => JSON.stringify(result.freeList)).not.toThrow();
  });

  it("distinguishes implicit trailing blocks from an absent serialized free list", async () => {
    const bytes = makeFixture({ blockCount: 3, slot2: { blockCount: 1n } });
    const result = await inspectFile(asFile(bytes));
    expect(result.freeList?.complete).toBe(true);
    expect(result.freeList?.root).toBeNull();
    expect(result.freeList?.blockIds).toEqual([]);
    expect(result.freeList?.implicitBlockIds).toEqual([1, 2]);
  });

  it("rejects shared references that are duplicated or also declared free", async () => {
    for (const overlap of [false, true]) {
      const bytes = makeFixture({
        blockCount: 3,
        slot2: { freeList: makePointer(0) },
      });
      writeMetadataBlock(bytes, 0, DEFAULT_BLOCK_SIZE, (payload) => {
        putU64(payload, 0, INVALID);
        putU64(payload, 8, overlap ? 1n : 0n);
        let cursor = 16;
        if (overlap) {
          putU64(payload, cursor, 1n);
          cursor += 8;
        }
        putU64(payload, cursor, overlap ? 1n : 2n);
        cursor += 8;
        for (let i = 0; i < (overlap ? 1 : 2); i++) {
          putU64(payload, cursor, 1n);
          cursor += 8;
          new DataView(payload.buffer, payload.byteOffset).setUint32(
            cursor,
            2,
            true,
          );
          cursor += 4;
        }
        putU64(payload, cursor, 0n);
      });
      await expect(inspectFile(asFile(bytes))).rejects.toThrow(
        /multi-use block entry/,
      );
    }
  });

  it("keeps an oversized free-list chain explicitly incomplete instead of reporting zero free blocks", async () => {
    const blockSize = DEFAULT_BLOCK_SIZE,
      slotSize = Math.floor((blockSize - 8) / 64 / 8) * 8;
    const bytes = makeFixture({
      blockCount: 3,
      slot2: { freeList: makePointer(0) },
    });
    for (let block = 0; block < 3; block++)
      writeMetadataBlock(bytes, block, blockSize, (payload) => {
        for (let slot = 0; slot < 64; slot++) {
          const index = block * 64 + slot;
          putU64(
            payload,
            slot * slotSize,
            index < 128
              ? makePointer(Math.floor((index + 1) / 64), (index + 1) % 64)
              : INVALID,
          );
        }
      });
    const result = await inspectFile(asFile(bytes));
    expect(result.freeList?.complete).toBe(false);
    expect(result.freeList?.chain).toHaveLength(128);
    expect(result.freeList?.blockIds).toEqual([]);
    expect(result.blocks.some((block) => block.role === "free")).toBe(false);
    expect(
      result.warnings.some((warning) =>
        warning.includes("Free-list metadata chain exceeded"),
      ),
    ).toBe(true);
  });

  it("reads only requested byte slices and checks range bounds", async () => {
    const file = asFile(new Uint8Array([1, 2, 3, 4, 5]));
    expect(Array.from(await readBytes(file, 1, 3))).toEqual([2, 3, 4]);
    await expect(readBytes(file, 4, 2)).rejects.toThrow(/exceed/);
  });
});
