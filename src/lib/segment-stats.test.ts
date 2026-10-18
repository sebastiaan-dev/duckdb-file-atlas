import { expect, test } from "bun:test";
import { describeStatistics } from "./segment-stats";

test("summarizes checkpoint statistics without repeating min/max", () => {
  const summary = describeStatistics(
    JSON.stringify({
      type: "VARCHAR",
      hasNull: false,
      hasNoNull: true,
      distinctCount: 0,
      min: "a",
      max: "b",
      string: { minExact: false, maxExact: true, maxLength: 48 },
    }),
  );
  expect(summary).toEqual({
    rows: [
      ["Contains NULLs", "No"],
      ["Contains values", "Yes"],
      ["Max string length", "48"],
    ],
    minPrefix: true,
    maxPrefix: false,
  });
});

test("keeps unparsable statistics verbatim and ignores missing input", () => {
  expect(describeStatistics("not json")?.raw).toBe("not json");
  expect(describeStatistics(undefined)).toBeNull();
});
