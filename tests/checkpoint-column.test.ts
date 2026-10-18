import { expect, test } from "bun:test";
import { BinaryReader } from "../src/lib/binary-reader";
import { readColumn, readStatistics } from "../src/lib/checkpoint-column";

test("missing scalar and validity pointer lists cannot be accepted as complete nonempty columns", () => {
  const context = {
    table: "main.t",
    column: "x",
    rowGroup: 0,
    rowStart: 0,
    rowCount: 100,
  };
  for (const type of [
    { id: 13, name: "INTEGER" },
    { id: 53, name: "VALIDITY" },
  ]) {
    expect(() =>
      readColumn(new BinaryReader(Uint8Array.of(255, 255)), type, context),
    ).toThrow(/Corrupt checkpoint.*tuple count/);
  }
});

const field = (id: number) => [id & 255, id >>> 8];
const end = field(0xffff);
function signed(value: bigint): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = Number(value & 127n);
    value >>= 7n;
    if ((value === 0n && !(byte & 64)) || (value === -1n && byte & 64)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 128);
  }
}
function statistics(payload: number[]): BinaryReader {
  return new BinaryReader(
    Uint8Array.from([
      ...field(100),
      0,
      ...field(101),
      1,
      ...field(102),
      0,
      ...field(103),
      ...payload,
      ...end,
      ...end,
    ]),
  );
}
test("legacy INTERVAL statistics may omit numeric bounds", () => {
  const result = readStatistics(statistics([]), { id: 27, name: "INTERVAL" });
  expect(result.min).toBeUndefined();
  expect(result.max).toBeUndefined();
  expect(result.hasNull).toBe(false);
  expect(result.hasNoNull).toBe(true);
  // If a minimum is present, a missing maximum must still fail.
  expect(() =>
    readStatistics(statistics([...field(200)]), { id: 27, name: "INTERVAL" }),
  ).toThrow();
});

function legacyString(
  min: number[],
  max: number[],
  maxLength?: number,
): BinaryReader {
  return statistics([
    ...field(200),
    min.length,
    ...min,
    ...field(201),
    max.length,
    ...max,
    ...field(202),
    0,
    ...field(203),
    Number(maxLength !== undefined),
    ...field(204),
    maxLength ?? 0,
  ]);
}
const padded = (value: string) => {
  const bytes = new Uint8Array(8);
  bytes.set(new TextEncoder().encode(value));
  return [...bytes];
};

test("legacy string bounds retain padding, truncation, and exactness semantics", () => {
  const cases = [
    { min: "aa", max: "zz", length: 2, exact: true },
    { min: "abcdefgh", max: "zzzzzzzz", length: 8, exact: true },
    { min: "abcdefgh", max: "zzzzzzzz", length: 9, exact: false },
    { min: "a", max: "zz", length: 2, exact: false },
    { min: "aa", max: "zz", length: undefined, exact: false },
    { min: "", max: "", length: 0, exact: true },
    { min: "a\u0000b", max: "z\u0000z", length: 3, exact: true },
    // Legacy padding cannot distinguish a trailing NUL from a shorter value.
    { min: "a\u0000", max: "z\u0000", length: 2, exact: false },
  ];
  for (const { min, max, length, exact } of cases) {
    const reader = legacyString(padded(min), padded(max), length);
    const result = readStatistics(reader, { id: 25, name: "VARCHAR" });
    expect(result.min).toBe(min.replace(/\u0000+$/, ""));
    expect(result.max).toBe(max.replace(/\u0000+$/, ""));
    expect(result.string).toEqual({
      minExact: exact,
      maxExact: exact,
      maxLength: length,
    });
    expect(reader.remaining).toBe(0);
  }
});

test("legacy empty and unavailable string statistics do not expose sentinel bounds", () => {
  for (const [min, max] of [
    [255, 0],
    [0, 255],
  ]) {
    const result = readStatistics(
      legacyString(Array(8).fill(min), Array(8).fill(max)),
      {
        id: 25,
        name: "VARCHAR",
      },
    );
    expect(result.min).toBeUndefined();
    expect(result.max).toBeUndefined();
    expect(result.string?.minExact).toBeUndefined();
    expect(result.string?.maxExact).toBeUndefined();
  }
});

test("legacy binary string bounds render as bytes and reject malformed lengths", () => {
  const result = readStatistics(
    legacyString(padded("a\u0000b"), padded("z\u0000z"), 3),
    {
      id: 26,
      name: "BLOB",
    },
  );
  expect(result.min).toBe("0x610062");
  expect(result.max).toBe("0x7a007a");
  for (const length of [7, 9]) {
    expect(() =>
      readStatistics(legacyString(Array(length).fill(97), padded("z")), {
        id: 25,
        name: "VARCHAR",
      }),
    ).toThrow(/Invalid legacy checkpoint string statistics/);
  }
});

test("temporal infinity is signed maximum, not signed minimum, at every precision", () => {
  for (const type of [
    { id: 15, name: "DATE" },
    { id: 17, name: "TIMESTAMP_S" },
    { id: 18, name: "TIMESTAMP_MS" },
    { id: 19, name: "TIMESTAMP" },
    { id: 20, name: "TIMESTAMP_NS" },
    { id: 32, name: "TIMESTAMP WITH TIME ZONE" },
    { id: 33, name: "TIMESTAMP_NS WITH TIME ZONE" },
  ]) {
    const max = type.id === 15 ? 2147483647n : 9223372036854775807n;
    const decode = (min: bigint, max: bigint) =>
      readStatistics(
        statistics([
          ...field(200),
          ...field(100),
          1,
          ...field(101),
          ...signed(min),
          ...end,
          ...field(201),
          ...field(100),
          1,
          ...field(101),
          ...signed(max),
          ...end,
        ]),
        type,
      );
    expect(decode(-max, max)).toMatchObject({
      min: "-infinity",
      max: "infinity",
    });
    expect(decode(-max - 1n, -max - 1n).min).not.toBe("-infinity");
  }
});
