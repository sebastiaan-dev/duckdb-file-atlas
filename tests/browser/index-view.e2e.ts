import { expect, test } from "@playwright/test";
import { databaseFixture, indexDatabaseFixture } from "./fixture";

test("Indexes has empty help on example and no-index files without logical color controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No recorded index details" }),
  ).toBeVisible();
  await expect(page.getByLabel("Color segments by")).toHaveCount(0);
  await expect(page.getByLabel("Color blocks by")).toHaveCount(0);
  await page.getByLabel("Search indexes or tables").fill("named_id");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.getByLabel("Search indexes or tables")).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "No recorded index details" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Physical map", exact: true }).click();
  await expect(page.getByLabel("Color blocks by")).toHaveValue("role");
});

test("native named indexes expose persisted allocator occupancy, block ownership, and checkpoint deletes", async ({
  page,
}) => {
  test.skip(
    !process.env.DUCKDB_BIN,
    "Set DUCKDB_BIN to a v69-capable CLI for native browser coverage",
  );
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(await indexDatabaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-indexes.duckdb" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.locator(".index-card")).toHaveCount(3);
  await expect(page.locator(".index-view")).toContainText(
    "3 of 3 indexes completely measured",
  );
  await expect(page.locator(".index-view")).toContainText(
    "not unallocated block tails",
  );
  await page.getByLabel("Search indexes or tables").fill("no such index");
  await expect(page.locator(".index-card")).toHaveCount(0);
  await expect(page.locator(".index-view")).toContainText("No indexes match");
  await page.getByLabel("Search indexes or tables").fill("main.t");
  await expect(page.locator(".index-card")).toHaveCount(2);
  await page.getByLabel("Search indexes or tables").fill("named_id");
  await expect(page.locator(".index-card")).toHaveCount(1);
  await expect(page.locator(".index-card")).toContainText("Root:");
  await expect(page.locator(".index-buffer")).toHaveCount(0);
  await page
    .locator(".index-card details > summary")
    .filter({ hasText: /[1-9][\d,]* buffers/ })
    .first()
    .click();
  await expect(page.locator(".index-card")).toContainText(
    "Capacity outside the persisted envelope is not counted as bytes",
  );
  await expect(page.locator(".index-slot-bar").first()).toBeVisible();
  await page.locator(".index-card .index-buffer .link-chip").first().click();
  await expect(
    page.getByRole("tab", { name: "Indexes", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(page.getByLabel("Selection details")).toContainText(
    "Index ownership",
  );
  await expect(page.getByLabel("Selection details")).toContainText("named_id");
  await expect(page.getByLabel("64 byte hexadecimal preview")).toBeVisible();
  await page.getByRole("tab", { name: "Physical map", exact: true }).click();
  await page.getByLabel("Color blocks by").selectOption("column");
  const bars = await page
    .locator(".byte-range.range-index")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).background),
    );
  expect(bars.length).toBeGreaterThan(0);
  expect(bars).toEqual(
    await page
      .locator(".range-swatch.range-index")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).background),
      ),
  );
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  await expect(page.locator(".row-label").first()).toContainText(
    "10,000 live / 15,000 physical",
  );
  await expect(page.locator(".row-label").first()).toContainText(
    "5,000 deleted",
  );
  await page.locator(".segment-choice").first().click();
  await expect(page.getByLabel("Selection details")).toContainText(
    "CHECKPOINT ROW GROUP",
  );
  await expect(page.getByLabel("Selection details")).toContainText("Live rows");
  await expect(page.getByLabel("Selection details")).toContainText("5,000");
});
