import { expect, test } from "bun:test";
import {
  DEFAULT_SCENARIO_STATE,
  decodeScenario,
  encodeScenario,
  SCENARIOS,
  scenario,
  scenarioScript,
  type ScenarioState,
} from "../src/lib/scenarios";
import { splitStatements } from "../src/lib/sql-statements";

const withSettings = (
  id: ScenarioState["id"],
  settings: Record<string, string>,
): ScenarioState => ({
  ...DEFAULT_SCENARIO_STATE,
  id,
  settings: { ...DEFAULT_SCENARIO_STATE.settings, [id]: settings },
});

test("every scenario setting combination compiles to statements", () => {
  for (const definition of SCENARIOS) {
    if (definition.id === "custom") continue;
    // Walk each field through all of its values on top of the defaults.
    for (const field of definition.fields) {
      const values =
        field.kind === "toggle"
          ? ["0", "1"]
          : field.options.map((option) => option.value);
      for (const value of values) {
        const sql = scenarioScript(
          withSettings(definition.id, {
            ...definition.defaults,
            [field.key]: value,
          }),
        );
        expect(sql).not.toContain("undefined");
        expect(splitStatements(sql).length).toBeGreaterThan(0);
      }
    }
  }
});

test("churn writes only the steps that were chosen", () => {
  const sql = scenarioScript(
    withSettings("churn", {
      rows: "100000",
      delete: "0",
      update: "0",
      checkpoint: "1",
      refill: "0",
    }),
  );
  expect(splitStatements(sql).map((s) => s.text.split(/\s/)[0])).toEqual([
    "CREATE",
    "CHECKPOINT",
  ]);
  const full = scenarioScript(
    withSettings("churn", scenario("churn").defaults),
  );
  expect(full).toContain("DELETE FROM events WHERE id % 100 < 33");
  expect(full).toContain("WHERE (id // 7) % 100 < 50");
  expect(full).toContain("CREATE TABLE refill");
});

test("overflow forces uncompressed strings unless compression is allowed", () => {
  expect(scenarioScript(withSettings("overflow", { compress: "0" }))).toContain(
    "SET force_compression = 'uncompressed'",
  );
  expect(
    scenarioScript(withSettings("overflow", { compress: "1" })),
  ).not.toContain("force_compression");
});

test("links round-trip scenario settings and custom SQL", async () => {
  const churn = {
    ...withSettings("churn", {
      ...scenario("churn").defaults,
      rows: "1000000",
      delete: "90",
    }),
    storageVersion: "v1.3.0" as const,
    blockSize: 65536 as const,
    threads: 4 as const,
  };
  const hash = await encodeScenario(churn);
  expect(hash).toBe(
    "scenario=churn&rows=1000000&delete=90&update=50&checkpoint=1&refill=1&storage=v1.3.0&block=65536&threads=4",
  );
  expect(await decodeScenario(`#${hash}`)).toEqual(churn);

  const custom: ScenarioState = {
    ...DEFAULT_SCENARIO_STATE,
    id: "custom",
    script: `${"SELECT 'naïve ✓';\n".repeat(50)}-- done`,
    threads: 8,
  };
  const customHash = await encodeScenario(custom);
  expect(customHash).toMatch(/^scenario=custom&sql=[\w-]+&storage=/);
  expect(customHash.length).toBeLessThan(custom.script.length / 4);
  expect(await decodeScenario(`#${customHash}`)).toEqual(custom);
});

test("old SQL links still open as single-threaded custom scripts", async () => {
  const hash = await encodeScenario({
    ...DEFAULT_SCENARIO_STATE,
    id: "custom",
    script: "SELECT 1;",
    threads: 8,
  });
  const sql = new URLSearchParams(hash).get("sql");
  expect(await decodeScenario(`#sql=${sql}`)).toEqual({
    ...DEFAULT_SCENARIO_STATE,
    id: "custom",
    script: "SELECT 1;",
    threads: 1,
  });
});

test("legacy scenario links default to one thread", async () => {
  expect(DEFAULT_SCENARIO_STATE.threads).toBe(1);
  expect(await decodeScenario("#scenario=tpch&sf=0.1")).toEqual(
    withSettings("tpch", { sf: "0.1" }),
  );
});

test("links preserve every supported thread count", async () => {
  for (const threads of [1, 2, 4, 8] as const) {
    const state = { ...DEFAULT_SCENARIO_STATE, threads };
    const hash = await encodeScenario(state);
    expect(new URLSearchParams(hash).get("threads")).toBe(String(threads));
    expect(await decodeScenario(`#${hash}`)).toEqual(state);
  }
});

test("invalid link thread counts fall back to one thread", async () => {
  for (const threads of [
    "",
    "0",
    "-1",
    "3",
    "16",
    "1.5",
    "2.0",
    "2e0",
    "0x2",
    "02",
    " 2 ",
    "Infinity",
    "NaN",
    "2;DROP TABLE t",
  ]) {
    const hash = new URLSearchParams({ scenario: "tpch", threads });
    expect(await decodeScenario(`#${hash}`)).toEqual(DEFAULT_SCENARIO_STATE);
  }
});

test("damaged or foreign hashes never inject values", async () => {
  expect(await decodeScenario("")).toBeNull();
  expect(await decodeScenario("#tab=physical")).toBeNull();
  expect(await decodeScenario("#scenario=nope")).toBeNull();
  expect(await decodeScenario("#scenario=custom&sql=%%%")).toBeNull();
  const decoded = await decodeScenario(
    "#scenario=tpch&sf=1);DROP&storage=v9')&block=7",
  );
  expect(decoded).toEqual({ ...DEFAULT_SCENARIO_STATE, id: "tpch" });
});

test("scenario files are named after the scenario", () => {
  expect(scenario("tpch").fileName({ sf: "0.1" })).toBe("tpch-sf0.1.duckdb");
  expect(scenario("custom").fileName({})).toBe("custom-sql.duckdb");
  expect(new Set(SCENARIOS.map((item) => item.id)).size).toBe(7);
});
