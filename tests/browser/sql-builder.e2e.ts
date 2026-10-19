import { expect, test, type Page } from "@playwright/test";

const generate = process.env.TPCH_BROWSER_GENERATE === "1";
const runtimeOnly = () =>
  test.skip(
    !generate,
    "Set TPCH_BROWSER_GENERATE=1 to run the real runtime/extensions",
  );

async function sqlTab(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Your SQL" }).click();
  return page.getByLabel("SQL script");
}

async function run(page: Page, heading: string) {
  await page.getByRole("button", { name: "Run SQL" }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({
    timeout: 60_000,
  });
}

const tables = (page: Page) =>
  page
    .locator(".side-tables > button > span")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent));

test("shared links open the SQL tab with their script and options, without running", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const editor = await sqlTab(page);
  await editor.fill("CREATE TABLE shared AS SELECT 42 AS answer;");
  await page.getByLabel("Storage").selectOption("v1.3.0");
  await page.getByLabel("Block size").selectOption("65536");
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#sql=[\w-]+&storage=v1\.3\.0&block=65536$/);

  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto(link);
  await expect(page.getByRole("button", { name: "Your SQL" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("SQL script")).toHaveValue(
    "CREATE TABLE shared AS SELECT 42 AS answer;",
  );
  await expect(page.getByLabel("Storage")).toHaveValue("v1.3.0");
  await expect(page.getByLabel("Block size")).toHaveValue("65536");
  // Opening a link never runs SQL by itself.
  expect(workers).toEqual([]);
});

const PRESETS: [string, string, string[]][] = [
  ["Compression codecs", "compression.duckdb", ["codecs"]],
  ["Deletes", "deletes.duckdb", ["events"]],
  ["Updates and free blocks", "updates.duckdb", ["accounts", "audit"]],
  ["Appends and row groups", "appends.duckdb", ["log"]],
  ["ART indexes", "indexes.duckdb", ["users"]],
  ["Long strings and overflow blocks", "strings.duckdb", ["documents"]],
];
for (const [name, file, expected] of PRESETS) {
  test(`the ${name} preset builds and opens ${file}`, async ({ page }) => {
    runtimeOnly();
    await sqlTab(page);
    await page.getByLabel("Start from").selectOption({ label: name });
    await run(page, file);
    expect(await tables(page)).toEqual(expected);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The address now reproduces this database.
    expect(new URL(page.url()).hash).toMatch(/^#sql=/);
  });
}

test("presets show their storage effects", async ({ page }) => {
  runtimeOnly();
  await sqlTab(page);
  await page.getByLabel("Start from").selectOption({ label: "Deletes" });
  await run(page, "deletes.duckdb");
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  await expect(page.locator(".row-label-deleted").first()).toBeVisible();

  await page.getByRole("button", { name: "SQL", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Start from")
    .selectOption({ label: "ART indexes" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Run SQL" })
    .click();
  await expect(
    page.getByRole("heading", { name: "indexes.duckdb" }),
  ).toBeVisible({ timeout: 60_000 });
  // The dialog closes once the new database is open.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.locator(".index-comparison-row")).toHaveCount(2);
});

test("storage version and block size options shape the file", async ({
  page,
}) => {
  runtimeOnly();
  const editor = await sqlTab(page);
  await editor.fill("CREATE TABLE t AS SELECT i FROM range(100000) t(i);");
  await page.getByLabel("Storage").selectOption("v1.2.0");
  await page.getByLabel("Block size").selectOption("16384");
  await run(page, "custom-sql.duckdb");
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
  const editor = await sqlTab(page);
  await editor.fill(
    "CREATE TABLE ok AS SELECT 1 AS a;\n\n-- the next one fails\nSELECT * FROM missing;",
  );
  await page.getByRole("button", { name: "Run SQL" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Statement 2 of 2 (line 4) failed", {
    timeout: 60_000,
  });
  await expect(alert).toContainText("missing");
  await expect(page.locator(".app-shell")).toHaveClass(/is-landing/);
  // The builder is ready for another attempt.
  await expect(page.getByRole("button", { name: "Run SQL" })).toBeEnabled();
});

test("the TPC-DS preset autoloads its extension from this site", async ({
  page,
}) => {
  runtimeOnly();
  test.setTimeout(120_000);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await sqlTab(page);
  await page
    .getByLabel("Start from")
    .selectOption({ label: "TPC-DS (SF 0.01)" });
  await run(page, "tpcds.duckdb");
  expect(await tables(page)).toHaveLength(24);
  const origin = new URL(page.url()).origin;
  expect(requests.every((url) => url.startsWith(origin))).toBe(true);
  expect(
    requests.some((url) => url.endsWith("/tpcds.duckdb_extension.wasm")),
  ).toBe(true);
});
