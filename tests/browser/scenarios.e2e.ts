import { expect, test, type Page } from "@playwright/test";
import { databaseFixture } from "./fixture";
import { readFile } from "node:fs/promises";

type WorkerCounts = { created: number; terminated: number };

async function trackWorkers(page: Page) {
  await page.addInitScript(() => {
    const state = { created: 0, terminated: 0 };
    (window as typeof window & { atlasWorkers: WorkerCounts }).atlasWorkers =
      state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.created++;
      }
      override terminate() {
        if (!this.stopped) {
          this.stopped = true;
          state.terminated++;
        }
        super.terminate();
      }
    };
  });
  return () =>
    page.evaluate(
      () =>
        (window as typeof window & { atlasWorkers: WorkerCounts }).atlasWorkers,
    );
}

const runtimeOnly = () =>
  test.skip(
    process.env.TPCH_BROWSER_GENERATE !== "1",
    "Set TPCH_BROWSER_GENERATE=1 to run the real runtime/extensions",
  );

async function openScenarios(page: Page, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: /^Scenarios/ }).click();
}
const pick = (page: Page, name: string) =>
  page.getByRole("radio", { name, exact: true }).click();
const setting = (page: Page, group: string, value: string) =>
  page
    .getByRole("group", { name: group })
    .getByRole("button", { name: value, exact: true })
    .click();
/** Storage format and block size live in a small options menu. */
async function fileFormat(page: Page, storage: string, block: string) {
  await page.getByRole("button", { name: "File format options" }).click();
  await page.getByLabel("Storage").selectOption(storage);
  await page.getByLabel("Block size").selectOption(block);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "File format" })).toHaveCount(0);
}
const tables = (page: Page) =>
  page
    .locator(".side-tables > button > span")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));

async function generate(page: Page, button: string, heading: string) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 150_000,
  });
}

test("scenarios start collapsed; opening them turns the drop zone into a slim bar", async ({
  page,
}) => {
  const counts = await trackWorkers(page);
  await page.goto("/");
  const dropzone = page.locator(".landing-dropzone");
  const tall = (await dropzone.boundingBox())!.height;
  const header = page.getByRole("button", { name: /^Scenarios/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("radiogroup", { name: "Scenario" })).toHaveCount(
    0,
  );
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("radio")).toHaveCount(7);
  await expect(page.getByRole("radio", { name: "TPC-H" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect((await dropzone.boundingBox())!.height).toBeLessThan(tall * 0.7);
  // Each tile shows its own settings.
  await pick(page, "Churn");
  await expect(page.getByRole("group", { name: "Delete" })).toBeVisible();
  await expect(page.getByLabel("Checkpoint between steps")).toBeChecked();
  await pick(page, "Custom");
  await expect(page.getByLabel("SQL script")).toBeVisible();
  // "Edit SQL" carries a scenario's script into Custom.
  await pick(page, "Indexes");
  await page.getByRole("button", { name: "Edit SQL" }).click();
  await expect(page.getByRole("radio", { name: "Custom" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByLabel("SQL script")).toHaveValue(
    /CREATE UNIQUE INDEX users_id/,
  );
  // The file format menu closes on an outside press, and shows no badge
  // while the defaults are chosen.
  const options = page.getByRole("button", { name: "File format options" });
  await expect(options).toHaveText("");
  await options.click();
  await expect(page.getByLabel("Storage")).toHaveValue("v2.0.0");
  await expect(page.getByLabel("Block size")).toHaveValue("262144");
  await page.getByRole("radio", { name: "Custom" }).click();
  await expect(page.getByRole("group", { name: "File format" })).toHaveCount(0);
  await header.click();
  expect((await dropzone.boundingBox())!.height).toBe(tall);
  // Browsing scenarios never starts the runtime.
  expect(await counts()).toEqual({ created: 0, terminated: 0 });
});

test("shared links reopen the scenario and its settings without running", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const counts = await trackWorkers(page);
  await openScenarios(page);
  await pick(page, "Churn");
  await setting(page, "Rows", "1M");
  await setting(page, "Delete", "90%");
  await page.getByLabel("Add a table afterwards").uncheck();
  await fileFormat(page, "v1.3.0", "65536");
  // Non-default formats stay visible on the closed menu.
  await expect(
    page.getByRole("button", { name: "File format options" }),
  ).toHaveText("v1.3.0 · 64 KiB");
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).hash).toBe(
    "#scenario=churn&rows=1000000&delete=90&update=50&checkpoint=1&refill=0&storage=v1.3.0&block=65536&threads=1",
  );

  await page.goto(link);
  await expect(page.getByRole("radio", { name: "Churn" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const pressed = (group: string) =>
    page.getByRole("group", { name: group }).locator('[aria-pressed="true"]');
  await expect(pressed("Rows")).toHaveText("1M");
  await expect(pressed("Delete")).toHaveText("90%");
  await expect(page.getByLabel("Add a table afterwards")).not.toBeChecked();
  await page.getByRole("button", { name: "File format options" }).click();
  await expect(page.getByLabel("Storage")).toHaveValue("v1.3.0");
  await expect(page.getByLabel("Block size")).toHaveValue("65536");
  expect(await counts()).toEqual({ created: 0, terminated: 0 });
});

test("cancels a runtime download and can retry", async ({ page }) => {
  test.setTimeout(180_000);
  const counts = await trackWorkers(page);
  // Keep the worker download pending. Cancelling must not wait for it.
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/duckdb-browser-*.worker.js", async (route) => {
    await blocked;
    await route.abort().catch(() => {});
  });
  try {
    await openScenarios(page);
    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect.poll(counts).toEqual({ created: 1, terminated: 0 });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(counts).toEqual({ created: 1, terminated: 1 });
    await expect(page.getByRole("status")).toContainText(
      "Generation cancelled",
    );
    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    await expect.poll(counts).toEqual({ created: 2, terminated: 1 });
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(counts).toEqual({ created: 2, terminated: 2 });
  } finally {
    release();
  }
});

test("opening a local file during generation releases the generator worker", async ({
  page,
}) => {
  const counts = await trackWorkers(page);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/duckdb-browser-*.worker.js", async (route) => {
    await blocked;
    await route.abort().catch(() => {});
  });
  try {
    await openScenarios(page);
    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    await expect.poll(counts).toEqual({ created: 1, terminated: 0 });
    await page
      .getByLabel("Choose a DuckDB database file")
      .setInputFiles(databaseFixture());
    await expect(
      page.getByRole("heading", { name: "browser-fixture.duckdb" }),
    ).toBeVisible();
    await expect(page.locator(".scenarios-card")).toHaveCount(0);
    // Both the generation worker and the completed inspection worker are gone.
    await expect.poll(counts).toEqual({ created: 2, terminated: 2 });
    // An opened file is not generated, so there is nothing to download.
    await expect(page.getByRole("link", { name: "Download" })).toHaveCount(0);
  } finally {
    release();
  }
});

test("failed runtime downloads show actionable errors", async ({ page }) => {
  const counts = await trackWorkers(page);
  await page.route("**/duckdb-browser-*.worker.js", (route) => route.abort());
  await openScenarios(page);
  await page
    .getByRole("button", { name: "Generate TPC-H", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("DuckDB runtime", {
    timeout: 30_000,
  });
  await expect(page.getByRole("alert")).toContainText("smaller scenario");
  expect(await counts()).toEqual({ created: 1, terminated: 1 });
  await expect(
    page.getByRole("button", { name: "Generate TPC-H", exact: true }),
  ).toBeEnabled();
});

// The tests below run the real vendored runtime and extensions; a mocked
// worker cannot verify a checkpointed database export. They take a while.
for (const scale of ["0.01", "0.1", "1"]) {
  test(`generates, opens and downloads a real v2.0 TPC-H database at SF ${scale}`, async ({
    page,
  }) => {
    runtimeOnly();
    test.setTimeout(180_000);
    const counts = await trackWorkers(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await openScenarios(page);
    await setting(page, "Scale factor", scale);
    await generate(page, "Generate TPC-H", `tpch-sf${scale}.duckdb`);
    // Generation and inspection each used a worker; both are released.
    await expect.poll(counts).toEqual({ created: 2, terminated: 2 });
    // Everything, including the TPC-H extension, came from this site.
    const origin = new URL(page.url()).origin;
    expect(requests.every((url) => url.startsWith(origin))).toBe(true);
    expect(
      requests.some((url) =>
        url.endsWith("/wasm_base/tpch.duckdb_extension.wasm"),
      ),
    ).toBe(true);
    expect(new URL(page.url()).hash).toBe(
      `#scenario=tpch&sf=${scale}&storage=v2.0.0&block=262144&threads=1`,
    );

    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`tpch-sf${scale}.duckdb`);
    const bytes = await readFile((await download.path())!);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    expect(bytes.subarray(8, 12).toString()).toBe("DUCK");
    // DuckDB 2.0 development builds stamp 999; releases stamp 69.
    expect([69n, 999n]).toContain(bytes.readBigUInt64LE(12));
    expect(bytes.readBigUInt64LE(4096 + 56)).toBe(69n);
    expect(bytes.readBigUInt64LE(8192 + 56)).toBe(69n);

    // v2.0 storage records exact segment sizes: no legacy warning.
    await expect(
      page.getByRole("status", { name: "Storage compatibility warning" }),
    ).toHaveCount(0);
    await expect(page.locator(".app-shell")).not.toHaveClass(/is-landing/);
    expect(await tables(page)).toHaveLength(8);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("tab", { name: "Logical map", exact: true }).click();
    await expect(
      page.locator('[data-logical-table="main.lineitem"]'),
    ).toBeVisible();
    expect(await page.locator(".segment-choice").count()).toBeGreaterThan(100);
  });
}

const SCENARIO_TABLES: [string, string, string, string[]][] = [
  ["TPC-DS", "Generate TPC-DS", "tpcds-sf0.01.duckdb", []],
  ["Compression", "Generate Compression", "compression.duckdb", ["codecs"]],
  ["Churn", "Generate Churn", "churn.duckdb", ["events", "refill"]],
  ["Indexes", "Generate Indexes", "indexes.duckdb", ["users"]],
  ["Overflow", "Generate Overflow", "overflow.duckdb", ["documents"]],
  ["Custom", "Run SQL", "custom-sql.duckdb", ["t"]],
];
for (const [name, button, file, expected] of SCENARIO_TABLES) {
  test(`the ${name} scenario generates and opens ${file}`, async ({ page }) => {
    runtimeOnly();
    await openScenarios(page);
    await pick(page, name);
    await generate(page, button, file);
    const names = await tables(page);
    if (name === "TPC-DS") expect(names).toHaveLength(24);
    else expect(names).toEqual(expected);
    if (name === "Overflow")
      await expect(
        page.locator('.heatmap-cell[data-overflow="true"]').first(),
      ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("scenarios show their storage effects", async ({ page }) => {
  runtimeOnly();
  await openScenarios(page);
  await pick(page, "Churn");
  await generate(page, "Generate Churn", "churn.duckdb");
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  await expect(page.locator(".row-label-deleted").first()).toBeVisible();

  // The workspace dialog replaces the open database.
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Indexes" }).click();
  await dialog.getByRole("button", { name: "Generate Indexes" }).click();
  await expect(
    page.getByRole("heading", { name: "indexes.duckdb" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.locator(".index-comparison-row")).toHaveCount(2);
});

test("storage version and block size options shape the file", async ({
  page,
}) => {
  runtimeOnly();
  await openScenarios(page);
  await pick(page, "Custom");
  await page
    .getByLabel("SQL script")
    .fill("CREATE TABLE t AS SELECT i FROM range(100000) t(i);");
  await fileFormat(page, "v1.2.0", "16384");
  await generate(page, "Run SQL", "custom-sql.duckdb");
  await expect(
    page.getByRole("status", { name: "Storage compatibility warning" }),
  ).toContainText("v1.2.0");
  await page.getByRole("button", { name: "Expand summary" }).click();
  await expect(
    page.getByRole("region", { name: "Database overview" }),
  ).toContainText("16 KiB each");
});

test("a failing statement is reported with its line, and nothing opens", async ({
  page,
}) => {
  runtimeOnly();
  await openScenarios(page);
  await pick(page, "Custom");
  await page
    .getByLabel("SQL script")
    .fill(
      "CREATE TABLE ok AS SELECT 1 AS a;\n\n-- the next one fails\nSELECT * FROM missing;",
    );
  await page.getByRole("button", { name: "Run SQL" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Statement 2 of 2 (line 4) failed", {
    timeout: 60_000,
  });
  await expect(alert).toContainText("missing");
  await expect(page.locator(".app-shell")).toHaveClass(/is-landing/);
  await expect(page.getByRole("button", { name: "Run SQL" })).toBeEnabled();
});
