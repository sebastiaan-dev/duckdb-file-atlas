import { expect, test } from "bun:test";
import { BinaryReader } from "../src/lib/binary-reader";
test("reads values and field IDs across metadata subblock boundaries without copying whole streams", () => {
  const reader = new BinaryReader([
    Uint8Array.of(100),
    Uint8Array.of(0, 229),
    Uint8Array.of(142, 38, 101, 0, 127, 255),
    Uint8Array.of(255),
  ]);
  reader.field(100);
  expect(reader.uint()).toBe(624485);
  expect(reader.optional(101)).toBe(true);
  expect(reader.int()).toBe(-1);
  reader.end();
  expect(reader.remaining).toBe(0);
});
test("rejects oversized, truncated and unsafe integers and unterminated objects", () => {
  expect(() => new BinaryReader(Uint8Array.of(128)).uint()).toThrow(
    /Truncated/,
  );
  expect(() =>
    new BinaryReader(Uint8Array.from(Array(11).fill(255))).unsigned(),
  ).toThrow();
  expect(() =>
    new BinaryReader(
      Uint8Array.of(128, 128, 128, 128, 128, 128, 128, 16),
    ).uint(),
  ).toThrow(/precision/);
  expect(() => new BinaryReader(Uint8Array.of(2)).bool()).toThrow(/boolean/);
  expect(() => new BinaryReader(Uint8Array.of(100, 0)).end()).toThrow(/field/);
});
