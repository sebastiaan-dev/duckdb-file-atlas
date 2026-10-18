import { expect, test } from "bun:test";
import { resolveStorageVersion, storageVersionName } from "./storage-version";

test("maps deprecated serialization versions like DuckDB does", () => {
  for (const [field, expected] of [
    [0, 64],
    [1, 64],
    [2, 64],
    [3, 64],
    [64, 64],
    [4, 65],
    [5, 66],
    [6, 67],
    [7, 68],
  ] as const)
    expect(resolveStorageVersion(64n, field)).toBe(expected);
  expect(resolveStorageVersion(999n, 69)).toBe(69);
  // An upgraded file keeps an older main-header marker but stores 69.
  expect(resolveStorageVersion(65n, 69)).toBe(69);
  expect(resolveStorageVersion(64n, 8)).toBeNull();
  expect(resolveStorageVersion(999n, 7)).toBeNull();
  expect(resolveStorageVersion(64n, 70)).toBeNull();
  expect(storageVersionName(67)).toBe("v1.4.0");
});
