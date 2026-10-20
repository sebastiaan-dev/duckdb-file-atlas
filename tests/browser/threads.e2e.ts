import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const base = "/duckdb-file-atlas/";
const settings = (page: Page) =>
  page.getByRole("button", { name: "File format options" });
async function chooseThreads(page: Page, count: number) {
  await settings(page).click();
  const select = page.getByRole("combobox", { name: "Threads", exact: true });
  await expect(select.locator(`option[value="${count}"]`)).toHaveJSProperty(
    "disabled",
    false,
  );
  await select.selectOption(String(count));
  await page.keyboard.press("Escape");
}
const runtimeOnly = () =>
  test.skip(
    process.env.TPCH_BROWSER_GENERATE !== "1",
    "Real WASM runtime tests are opt-in",
  );

test.describe("Pages-compatible isolation", () => {
  test.use({ serviceWorkers: "allow" });

  test("isolates once, preserves shared settings, and stays within the app scope", async ({
    page,
    context,
  }) => {
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.goto(`${base}#scenario=churn&threads=4`);
    await expect(
      page.getByRole("radio", { name: "Churn", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(navigations).toBe(2);
    expect(new URL(page.url()).hash).toBe("#scenario=churn&threads=4");
    await expect(settings(page)).toHaveText("4 threads");
    await expect(
      page.getByRole("button", { name: "Generate Churn", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map(
          (r) => new URL(r.scope).pathname,
        ),
      ),
    ).toEqual([base]);
    await page.reload();
    await expect(settings(page)).toHaveText("4 threads");
    expect(navigations).toBe(3);
    // An already-controlled new tab needs no bootstrap reload.
    const other = await context.newPage();
    await other.goto(base);
    await expect(
      other.getByRole("button", { name: /^Scenarios/ }),
    ).toBeVisible();
    expect(await other.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  for (const count of [1, 2, 4, 8]) {
    test(`generates, checkpoints, exports and reopens with ${count} thread(s)`, async ({
      page,
    }) => {
      runtimeOnly();
      test.setTimeout(120_000);
      const requests: string[] = [];
      // Pthread workers are nested workers; their fetches are visible on the
      // browser context (via the service worker), not always on the page.
      page.context().on("request", (request) => requests.push(request.url()));
      await page.goto(base);
      await page.getByRole("button", { name: /^Scenarios/ }).click();
      await chooseThreads(page, count);
      await page.getByRole("radio", { name: "Custom", exact: true }).click();
      await page.getByLabel("SQL script").fill(`
        SELECT CASE WHEN current_setting('threads')::INTEGER = ${count}
          THEN true ELSE error('Wrong scheduler thread count') END;
        CREATE TABLE t AS SELECT i, md5(i::VARCHAR) AS payload FROM range(500000) t(i);
        CHECKPOINT;
        UPDATE t SET payload = md5(payload) WHERE i % 3 = 0;
        SELECT CASE WHEN count(*) = 500000 THEN true ELSE error('Wrong row count') END FROM t;
      `);
      await page.getByRole("button", { name: "Run SQL", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "custom-sql.duckdb", exact: true }),
      ).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(new URL(page.url()).hash).toContain(`threads=${count}`);
      const platform = count === 1 ? "base" : "threads";
      expect(
        requests.some((url) => url.endsWith(`/duckdb-${platform}.wasm`)),
      ).toBe(true);
      // This Emscripten build starts pthreads from the main worker URL;
      // the separately supplied pthread URL is a compatibility entry point.
      expect(
        requests.some((url) =>
          url.endsWith(`/duckdb-browser-${platform}.worker.js`),
        ),
      ).toBe(true);
      const downloading = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download" }).click();
      const download = await downloading;
      const bytes = await readFile((await download.path())!);
      expect(bytes.length).toBeGreaterThan(1_000_000);
      expect(bytes.subarray(8, 12).toString()).toBe("DUCK");
      // The menu also works in the workspace; Escape only dismisses the menu.
      await page
        .getByRole("button", { name: "Scenarios", exact: true })
        .click();
      await settings(page).click();
      await expect(
        page.getByRole("combobox", { name: "Threads", exact: true }),
      ).toHaveValue(String(count));
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("group", { name: "File format" }),
      ).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  }

  for (const [name, file, extension] of [
    ["TPC-H", "tpch-sf0.01.duckdb", "tpch"],
    ["TPC-DS", "tpcds-sf0.01.duckdb", "tpcds"],
  ]) {
    test(`loads the matching threaded ${name} extension`, async ({ page }) => {
      runtimeOnly();
      test.setTimeout(120_000);
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(base);
      await page.getByRole("button", { name: /^Scenarios/ }).click();
      await page.getByRole("radio", { name, exact: true }).click();
      await page
        .getByRole("group", { name: "Scale factor", exact: true })
        .getByRole("button", { name: "0.01", exact: true })
        .click();
      await chooseThreads(page, 4);
      await page
        .getByRole("button", { name: `Generate ${name}`, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: file, exact: true }),
      ).toBeVisible({ timeout: 90_000 });
      expect(
        requests.some((url) =>
          url.endsWith(`/wasm_threads/${extension}.duckdb_extension.wasm`),
        ),
      ).toBe(true);
      await expect(page.getByRole("alert")).toHaveCount(0);
    });
  }

  test("canceling threaded work releases OPFS handles and allows another build", async ({
    page,
  }) => {
    runtimeOnly();
    test.setTimeout(120_000);
    await page.goto(`${base}#scenario=churn&threads=8`);
    await page.getByRole("button", { name: "Edit SQL", exact: true }).click();
    await page
      .getByLabel("SQL script")
      .fill(
        "CREATE TABLE t AS SELECT sum(sin(i)) FROM range(100000000000) t(i);",
      );
    await page.getByRole("button", { name: "Run SQL", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Running statement", {
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Generation cancelled",
    );
    await page
      .getByLabel("SQL script")
      .fill("CREATE TABLE t AS SELECT 42 AS value;");
    await page.getByRole("button", { name: "Run SQL", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "custom-sql.duckdb", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
  });
});

test("blocked isolation keeps file loading and single-threaded generation available", async ({
  page,
}) => {
  await page.goto(`${base}#scenario=churn&threads=8`);
  await expect(settings(page)).toHaveText("8 threads");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await expect(
    page.getByRole("button", { name: "Generate Churn", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Single threaded");
  await settings(page).click();
  const select = page.getByRole("combobox", { name: "Threads", exact: true });
  for (const count of [2, 4, 8])
    await expect(select.locator(`option[value="${count}"]`)).toHaveJSProperty(
      "disabled",
      true,
    );
  await select.selectOption("1");
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveText("");
  await expect(
    page.getByRole("button", { name: "Generate Churn", exact: true }),
  ).toBeEnabled();
});
