import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** Builds a real database with DUCKDB_BIN (a v69-capable DuckDB CLI). */
async function nativeFixture(name: string, sql: (db: string) => string) {
  if (!process.env.DUCKDB_BIN) throw new Error("DUCKDB_BIN is required");
  const directory = await mkdtemp(join(tmpdir(), "atlas-browser-native-"));
  const path = join(directory, name);
  try {
    await promisify(execFile)(process.env.DUCKDB_BIN, [
      "-no-agent",
      "-batch",
      "-c",
      sql(path.replaceAll("'", "''")),
    ]);
    return {
      name,
      mimeType: "application/octet-stream",
      buffer: await readFile(path),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Opt-in native fixture: set DUCKDB_BIN to a v69-capable DuckDB CLI. */
export function indexDatabaseFixture() {
  return nativeFixture(
    "browser-indexes.duckdb",
    (path) => `
      ATTACH '${path}' AS db (STORAGE_VERSION 'v2.0.0', BLOCK_SIZE 16384);
      CREATE TABLE db.t AS SELECT i, i % 13 AS duplicate FROM range(15000) t(i);
      CREATE INDEX named_id ON db.t(i);
      CREATE INDEX named_duplicate ON db.t(duplicate);
      CREATE TABLE db.empty(i BIGINT); CREATE INDEX empty_idx ON db.empty(i);
      CHECKPOINT db;
      DELETE FROM db.t WHERE i % 3 = 0;
      CHECKPOINT db;
    `,
  );
}

/**
 * Opt-in native fixture with several row groups: `wide` has three, and an
 * append after the first checkpoint stores its last row group apart.
 */
export function rowGroupDatabaseFixture() {
  return nativeFixture(
    "browser-row-groups.duckdb",
    (path) => `
      ATTACH '${path}' AS db (STORAGE_VERSION 'v2.0.0', BLOCK_SIZE 16384);
      CREATE TABLE db.wide AS
        SELECT i, i * 7 AS v, 'value ' || (i % 97) AS s FROM range(245760) t(i);
      CREATE TABLE db.small AS SELECT i FROM range(1000) t(i);
      CHECKPOINT db;
      INSERT INTO db.wide
        SELECT i, i * 7, 'value ' || (i % 97) FROM range(245760, 300000) t(i);
      CHECKPOINT db;
    `,
  );
}

/** Long uncompressed strings spanning several blocks, plus an inline column. */
export function overflowDatabaseFixture() {
  return nativeFixture(
    "browser-overflow.duckdb",
    (path) => `
    SET threads = 1;
    SET force_compression = 'uncompressed';
    ATTACH '${path}' AS db (STORAGE_VERSION 'v2.0.0', BLOCK_SIZE 16384);
    CREATE TABLE db.documents AS
      SELECT i AS id, repeat(chr((65 + i % 26)::INTEGER), 20000 + i * 10) AS body
      FROM range(12) t(i);
    CHECKPOINT db;
  `,
  );
}

export const DATA_START = 3 * 4096;
export const BLOCK_SIZE = 16384;

/** A real file upload with valid headers and 200 implicit free blocks.
 * Defaults to v69; older targets encode the deprecated serialization version.
 * No external database binary, server mocks, or application test hooks needed.
 */
export function databaseFixture(
  fill = 0,
  physicalOnly = false,
  blockCount = 200,
  storageVersion: 64 | 65 | 66 | 67 | 68 | 69 = 69,
) {
  const buffer = Buffer.alloc(DATA_START + blockCount * BLOCK_SIZE, fill);
  buffer.fill(0, 0, DATA_START);
  buffer.write("DUCK", 8);
  buffer.writeBigUInt64LE(BigInt(storageVersion), 12);
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
      BigInt(
        storageVersion === 69
          ? 69
          : storageVersion === 64
            ? 1
            : storageVersion - 61,
      ),
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

export interface ManifestSegment {
  id: string;
  table: string;
  column: string;
  columnType: string;
  rowGroup: number;
  blockId: number;
  offset: number;
  byteSize: number;
  rowStart: number;
  rowCount: number;
  compression: string;
}

/** A semantic sidecar matching `databaseFixture(0, true)`. */
export function manifestFor(segments: ManifestSegment[]) {
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
        segments,
      }),
    ),
  };
}

export function manifestFixture() {
  return manifestFor(
    [0, 1].map((index) => ({
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
  );
}
