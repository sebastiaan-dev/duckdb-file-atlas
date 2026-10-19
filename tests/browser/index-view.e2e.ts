import { expect, test } from "@playwright/test";
import { databaseFixture, indexDatabaseFixture } from "./fixture";

test("Indexes has empty help on no-index files without logical color controls", async ({
  page,
}) => {
  await page.goto("/");
  // No data views until a database is opened.
  await expect(page.getByRole("tab", { name: "Indexes" })).toHaveCount(0);
  const open = async () => {
    await page
      .getByLabel("Choose a DuckDB database file")
      .setInputFiles(databaseFixture());
    await expect(
      page.getByRole("heading", { name: "browser-fixture.duckdb" }),
    ).toBeVisible();
  };
  await open();
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No recorded index details" }),
  ).toBeVisible();
  await expect(page.getByLabel("Color segments by")).toHaveCount(0);
  await expect(page.getByLabel("Color blocks by")).toHaveCount(0);
  await page.getByLabel("Search indexes or tables").fill("named_id");
  // Opening a file starts a fresh workspace.
  await open();
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.getByLabel("Search indexes or tables")).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "No recorded index details" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Physical map", exact: true }).click();
  // A fresh workspace starts with the default table coloring.
  await expect(page.getByLabel("Color blocks by")).toHaveValue("table");
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
  await expect(page.locator(".index-comparison-row")).toHaveCount(3);
  // Full coverage stays out of the way, behind the totals info tooltip.
  await expect(page.locator(".index-coverage")).toHaveCount(0);
  await page.getByLabel("About index storage totals").hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "3 of 3 indexes completely measured",
  );
  await expect(page.getByRole("tooltip")).toContainText(
    "not unallocated block tails",
  );
  // Radix keeps a tooltip open inside its pointer grace area until a move
  // lands outside it, so leave in steps like a real pointer.
  await page.mouse.move(0, 0, { steps: 4 });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.getByLabel("Search indexes or tables").fill("no such index");
  await expect(page.locator(".index-comparison-row")).toHaveCount(0);
  await expect(page.locator(".index-view")).toContainText("No indexes match");
  await page.getByLabel("Search indexes or tables").fill("main.t");
  await expect(page.locator(".index-comparison-row")).toHaveCount(2);
  await page.getByLabel("Search indexes or tables").fill("named_id");
  await expect(page.locator(".index-comparison-row")).toHaveCount(1);
  await page.locator(".index-comparison-row").click();
  await expect(page.locator(".index-allocator-row").first()).toBeVisible();
  await expect(page.locator(".index-technical")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator(".index-buffer-tile").first()).toBeVisible();
  await page.getByLabel("About allocators").click();
  await expect(page.getByRole("tooltip")).toContainText(
    "Capacity outside the persisted envelope is not counted as bytes",
  );
  await page.getByLabel("About allocators").click();
  await page.locator(".index-buffer-tile").first().click();
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
    "Row group 0",
  );
  await expect(page.getByLabel("Selection details")).toContainText("Live rows");
  await expect(page.getByLabel("Selection details")).toContainText("5,000");
});
