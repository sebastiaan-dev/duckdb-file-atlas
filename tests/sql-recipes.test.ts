import { expect, test } from "bun:test";
import {
  DEFAULT_SQL_RECIPE,
  decodeRecipe,
  encodeRecipe,
  recipeFileName,
  SQL_PRESETS,
} from "../src/lib/sql-recipes";
import { splitStatements } from "../src/lib/sql-statements";

test("links round-trip scripts, including non-ASCII text, compactly", async () => {
  const recipe = {
    script: `${"SELECT 'naïve ✓';\n".repeat(50)}-- done`,
    storageVersion: "v1.2.0" as const,
    blockSize: 16384 as const,
  };
  const hash = await encodeRecipe(recipe);
  expect(hash).toMatch(/^sql=[\w-]+&storage=v1\.2\.0&block=16384$/);
  // Repetitive SQL compresses well below its raw length.
  expect(hash.length).toBeLessThan(recipe.script.length / 4);
  expect(await decodeRecipe(`#${hash}`)).toEqual(recipe);
});

test("damaged or foreign hashes do not produce recipes", async () => {
  expect(await decodeRecipe("")).toBeNull();
  expect(await decodeRecipe("#tab=physical")).toBeNull();
  expect(await decodeRecipe("#sql=%%%")).toBeNull();
  // Unknown options fall back to the defaults instead of reaching SQL.
  const hash = await encodeRecipe(DEFAULT_SQL_RECIPE);
  const tampered = hash
    .replace("storage=v2.0.0", "storage=v9')")
    .replace("block=262144", "block=7");
  expect(await decodeRecipe(tampered)).toEqual(DEFAULT_SQL_RECIPE);
});

test("presets are non-empty scripts and name their files", () => {
  for (const preset of SQL_PRESETS) {
    expect(splitStatements(preset.script).length).toBeGreaterThan(0);
    expect(
      recipeFileName({ ...DEFAULT_SQL_RECIPE, script: preset.script }),
    ).toBe(`${preset.id}.duckdb`);
  }
  expect(recipeFileName({ ...DEFAULT_SQL_RECIPE, script: "SELECT 1" })).toBe(
    "custom-sql.duckdb",
  );
});
