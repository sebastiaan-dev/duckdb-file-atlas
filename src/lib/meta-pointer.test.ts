import { describe, expect, test } from "bun:test";
import { decodeMetaPointer } from "./meta-pointer";

describe("decodeMetaPointer", () => {
  test("splits slot and block ID", () => {
    expect(decodeMetaPointer("4035225266123965737")).toEqual({
      blockId: 1321,
      slot: 56,
    });
    expect(decodeMetaPointer("216172782113786284")).toEqual({
      blockId: 2476,
      slot: 3,
    });
  });
  test("rejects invalid and malformed pointers", () => {
    expect(decodeMetaPointer("18446744073709551615")).toBeNull();
    expect(decodeMetaPointer("not a number")).toBeNull();
    expect(decodeMetaPointer("")).toBeNull();
  });
});
