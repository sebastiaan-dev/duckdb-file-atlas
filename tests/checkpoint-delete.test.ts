import { describe, expect, test } from "bun:test";
import { BinaryReader } from "../src/lib/binary-reader";
import { decodeCheckpointDeletes } from "../src/lib/checkpoint-delete";

function fixed(value: number | bigint, width: number): number[] {
  let remaining = BigInt(value);
  return Array.from({ length: width }, () => {
    const byte = Number(remaining & 255n);
    remaining >>= 8n;
    return byte;
  });
}
const u64 = (value: number | bigint) => fixed(value, 8);
const record = (index: number, type: number, tail: number[] = []) => [
  ...u64(index),
  type,
  ...tail,
];
const constant = (index: number, size: number) =>
  record(index, 0, u64(index * size));
const sparse = (
  index: number,
  size: number,
  encoding: number,
  indexes: number[],
) =>
  record(index, 1, [
    ...u64(index * size),
    encoding,
    ...fixed(indexes.length, 4),
    ...indexes.flatMap((value) => fixed(value, size < 65535 ? 2 : 4)),
  ]);
function mask(index: number, size: number, deleted: number[]) {
  const bytes = new Uint8Array(Math.ceil(size / 64) * 8);
  for (const position of deleted) bytes[position >>> 3] |= 1 << (position & 7);
  return record(index, 1, [...u64(index * size), 0, ...bytes]);
}
const stream = (...records: number[][]) =>
  new Uint8Array([...u64(records.length), ...records.flat()]);
const decode = (bytes: Uint8Array, size = 2048, rows = size) =>
  decodeCheckpointDeletes(new BinaryReader(bytes), size, rows);

describe("native checkpoint deletes", () => {
  test("decodes all chunk types and all validity encodings with row-group-relative ranges", () => {
    const size = 2048;
    const bytes = stream(
      constant(0, size),
      sparse(1, size, 1, [1, 2, 3, 100]),
      sparse(2, size, 2, [0, 10, 11, 2047]),
      mask(3, size, [0, 1, 63, 64, 65, 2047]),
      record(4, 2),
    );
    const decoded = decode(bytes, size, size * 5);
    expect(decoded.deletedRows).toBe(2048 + 4 + 2044 + 6);
    expect(decoded.vectors.map((v) => v.encoding)).toEqual([
      "constant",
      "deleted-positions",
      "alive-positions",
      "bitmask",
      "empty",
    ]);
    expect(decoded.vectors[1].deletedRanges).toEqual([
      { start: 2049, count: 3 },
      { start: 2148, count: 1 },
    ]);
    expect(decoded.vectors[2].deletedRanges).toEqual([
      { start: 4097, count: 9 },
      { start: 4108, count: 2035 },
    ]);
    expect(decoded.vectors[3].deletedRanges).toEqual([
      { start: 6144, count: 2 },
      { start: 6207, count: 3 },
      { start: 8191, count: 1 },
    ]);
    expect(decoded.vectors[4]).toMatchObject({
      rowStart: 8192,
      rowCount: 2048,
      deletedRows: 0,
      deletedRanges: [],
    });
  });

  test("clips every encoding to a final partial vector, validating the full mask", () => {
    for (const [payload, deletedRows] of [
      [constant(1, 64), 3],
      [sparse(1, 64, 1, [0, 1, 63]), 2],
      [sparse(1, 64, 2, [0, 63]), 2],
      [mask(1, 64, [0, 1, 2]), 3],
      [mask(1, 64, [63]), 0],
      [record(1, 2), 0],
    ] as const) {
      const result = decode(stream([...payload]), 64, 67);
      expect(result.deletedRows).toBe(deletedRows);
      expect(result.vectors[0].rowCount).toBe(3);
      for (const range of result.vectors[0].deletedRanges)
        expect(range.start + range.count).toBeLessThanOrEqual(67);
    }
  });

  test("uses fixed U16 below 65535 and U32 at and above the threshold", () => {
    for (const size of [65534, 65535, 65536]) {
      expect(
        decode(stream(sparse(0, size, 1, [0, size - 1])), size).deletedRows,
      ).toBe(2);
      expect(
        decode(stream(sparse(0, size, 2, [0, size - 1])), size).deletedRows,
      ).toBe(size - 2);
    }
  });

  test("handles non-word-aligned masks, ignoring word padding bits", () => {
    const payload = mask(0, 65, [0, 64]);
    payload[payload.length - 1] = 255;
    expect(decode(stream(payload), 65).deletedRows).toBe(2);
  });

  test("reads fields across arbitrarily split metadata slots and leaves retained tails unread", () => {
    const bytes = stream(sparse(0, 2048, 1, [1, 2, 2047]));
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    chunks.push(Uint8Array.of(255, 255, 255));
    const reader = new BinaryReader(chunks);
    expect(decodeCheckpointDeletes(reader, 2048, 2048).deletedRows).toBe(3);
    expect(reader.offset).toBe(bytes.length);
    expect(reader.remaining).toBe(3);
  });

  test("accepts an explicit zero-record stream without consuming padding", () => {
    const reader = new BinaryReader(new Uint8Array([...u64(0), 255]));
    expect(decodeCheckpointDeletes(reader, 2048, 0)).toEqual({
      deletedRows: 0,
      vectors: [],
    });
    expect(reader.remaining).toBe(1);
  });

  test("rejects unknown tags, unsafe integers, inconsistent starts and vector bounds", () => {
    const bad = [
      stream(record(0, 3)),
      stream(record(0, 1, [...u64(0), 3])),
      stream(record(0, 0, u64(1))),
      stream(record(1, 2)),
      stream(record(0, 0, u64(1n << 63n))),
      new Uint8Array([...u64(1), ...u64(1n << 63n), 2]),
      new Uint8Array(u64(1n << 63n)),
      stream(record(0, 2), record(0, 2)),
    ];
    for (const bytes of bad)
      expect(() => decode(bytes)).toThrow(/Corrupt checkpoint deletes/);
    expect(() =>
      decode(stream(record(1, 2), record(0, 2)), 2048, 4096),
    ).toThrow(/unsorted/);
    expect(() =>
      decode(stream(record(0, 2), record(0, 2)), 2048, 4096),
    ).toThrow(/duplicate/);
  });

  test("rejects sparse count/index overflow, duplicates and unsorted indexes", () => {
    for (const encoding of [1, 2]) {
      for (const indexes of [[64], [1, 1], [2, 1]])
        expect(() =>
          decode(stream(sparse(0, 64, encoding, indexes)), 64),
        ).toThrow(/Corrupt/);
      expect(() =>
        decode(
          stream(record(0, 1, [...u64(0), encoding, ...fixed(65, 4)])),
          64,
        ),
      ).toThrow(/entry count/);
    }
  });

  test("rejects full-vector all-deleted/all-alive VECTOR_INFO in each encoding", () => {
    for (const payload of [
      mask(0, 64, []),
      mask(
        0,
        64,
        Array.from({ length: 64 }, (_, i) => i),
      ),
      sparse(0, 64, 1, []),
      sparse(0, 64, 2, []),
      sparse(
        0,
        64,
        1,
        Array.from({ length: 64 }, (_, i) => i),
      ),
      sparse(
        0,
        64,
        2,
        Array.from({ length: 64 }, (_, i) => i),
      ),
    ])
      expect(() => decode(stream(payload), 64, 3)).toThrow(
        /both deleted and alive/,
      );
  });

  test("rejects every truncation prefix rather than returning zero deletes", () => {
    for (const bytes of [
      stream(constant(0, 64)),
      stream(mask(0, 64, [1])),
      stream(sparse(0, 64, 1, [1, 2])),
    ])
      for (let end = 0; end < bytes.length; end++)
        expect(() => decode(bytes.subarray(0, end), 64)).toThrow(/Truncated/);
  });

  test("bounds decode work and output ranges before unbounded loops or allocations", () => {
    expect(() => decode(new Uint8Array(u64(65537)), 1, 65537)).toThrow(
      /work limit/,
    );
    const size = 16 * 1024 * 1024 + 1;
    expect(() => decode(stream(record(0, 1, [...u64(0), 0])), size)).toThrow(
      /work limit/,
    );
    const rangeSize = 524290;
    const bytes = new Uint8Array(
      8 + 8 + 1 + 8 + 1 + Math.ceil(rangeSize / 64) * 8,
    );
    bytes.set(u64(1), 0);
    bytes[16] = 1;
    bytes.fill(0x55, 26);
    expect(() => decode(bytes, rangeSize)).toThrow(/range work limit/);
  });

  test("rejects invalid caller dimensions", () => {
    for (const size of [0, -1, 1.5, NaN, Infinity, 2 ** 30 + 1])
      expect(() => decode(stream(), size, 0)).toThrow(/vector size/);
    for (const rows of [-1, 1.5, NaN, Infinity, 2 ** 30 + 1])
      expect(() => decode(stream(), 2048, rows)).toThrow(/row-group count/);
  });
});
