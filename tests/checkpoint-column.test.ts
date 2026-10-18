import { expect, test } from "bun:test";
import { BinaryReader } from "../src/lib/binary-reader";
import { readColumn } from "../src/lib/checkpoint-column";

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
