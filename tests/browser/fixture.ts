import { createHash } from "node:crypto";

export const DATA_START = 3 * 4096;
export const BLOCK_SIZE = 16384;

/** A real file upload with valid v69 headers and 200 implicit free blocks.
 * No external database binary, server mocks, or application test hooks needed.
 */
export function databaseFixture(
  fill = 0,
  physicalOnly = false,
  blockCount = 200,
) {
  const buffer = Buffer.alloc(DATA_START + blockCount * BLOCK_SIZE, fill);
  buffer.fill(0, 0, DATA_START);
  buffer.write("DUCK", 8);
  buffer.writeBigUInt64LE(69n, 12);
  buffer.write("v2.0.0-test", 52);
  for (const slot of [1, 2]) {
    const start = slot * 4096 + 8;
    const fields = [
      BigInt(slot),
      physicalOnly ? 199n : 0xffffffffffffffffn,
      0xffffffffffffffffn,
      physicalOnly ? 200n : 0n,
      BigInt(BLOCK_SIZE),
      2048n,
      69n,
    ];
    fields.forEach((value, i) => buffer.writeBigUInt64LE(value, start + i * 8));
  }
  const seal = (start: number, size: number) => {
    let checksum = 5381n;
    for (let i = start + 8; i < start + size; i += 8)
      checksum ^= BigInt.asUintN(
        64,
        buffer.readBigUInt64LE(i) * 0xbf58476d1ce4e5b9n,
      );
    buffer.writeBigUInt64LE(checksum, start);
  };
  for (let start = 0; start < DATA_START; start += 4096) seal(start, 4096);
  if (physicalOnly) {
    // A verified metadata block with an unsupported catalog field exercises
    // the supported physical-inspection + semantic-sidecar fallback.
    const start = DATA_START + 199 * BLOCK_SIZE;
    buffer.writeBigUInt64LE(0xffffffffffffffffn, start + 8);
    seal(start, BLOCK_SIZE);
  }
  return {
    name: "browser-fixture.duckdb",
    mimeType: "application/octet-stream",
    buffer,
  };
}

export function multiRunFixture() {
  const file = databaseFixture(0, false, 66);
  const { buffer } = file;
  // Verified slot-0 free-list stream: three serialized runs, then six
  // implicit blocks beyond the 60-block checkpoint extent.
  for (const slot of [1, 2]) {
    buffer.writeBigUInt64LE(0n, slot * 4096 + 24);
    buffer.writeBigUInt64LE(60n, slot * 4096 + 32);
  }
  buffer.writeBigUInt64LE(0xffffffffffffffffn, DATA_START + 8);
  const ids = [
    ...Array.from({ length: 12 }, (_, i) => i + 1),
    ...Array.from({ length: 6 }, (_, i) => i + 20),
    40,
  ];
  const stream = [BigInt(ids.length), ...ids.map(BigInt), 0n, 0n];
  stream.forEach((value, i) =>
    buffer.writeBigUInt64LE(value, DATA_START + 16 + i * 8),
  );
  for (const [start, size] of [
    [4096, 4096],
    [8192, 4096],
    [DATA_START, BLOCK_SIZE],
  ]) {
    let checksum = 5381n;
    for (let i = start + 8; i < start + size; i += 8)
      checksum ^= BigInt.asUintN(
        64,
        buffer.readBigUInt64LE(i) * 0xbf58476d1ce4e5b9n,
      );
    buffer.writeBigUInt64LE(checksum, start);
  }
  return file;
}

export function manifestFixture() {
  const file = databaseFixture(0, true);
  return {
    name: "browser-manifest.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "duckdb-file-layout/v1",
        storageVersion: 69,
        fileSize: file.buffer.length,
        headerFingerprint: createHash("sha256")
          .update(file.buffer.subarray(0, DATA_START))
          .digest("hex"),
        segments: [0, 1].map((index) => ({
          id: `segment-${index}`,
          table: "main.example",
          column: `value${index}`,
          columnType: "INTEGER",
          rowGroup: 0,
          blockId: 0,
          offset: 128 + index * 128,
          byteSize: 128,
          rowStart: 0,
          rowCount: 32,
          compression: "Uncompressed",
        })),
      }),
    ),
  };
}
