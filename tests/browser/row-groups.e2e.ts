import { expect, test, type Page } from "@playwright/test";
import { rowGroupDatabaseFixture } from "./fixture";

const inspector = (page: Page) => page.getByLabel("Selection details");
const ids = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-block-id"))),
    );

test.beforeEach(async ({ page }) => {
  test.skip(
    !process.env.DUCKDB_BIN,
    "Set DUCKDB_BIN to a v69-capable CLI for native browser coverage",
  );
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(await rowGroupDatabaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-row-groups.duckdb" }),
  ).toBeVisible();
});

test("the row-group color mode shades each table's row groups", async ({
  page,
}) => {
  await page.getByLabel("Color blocks by").selectOption("rowgroup");
  const legend = page.getByLabel("Block map legend");
  await expect(legend).toContainText("main.wide");
  await expect(legend).toContainText("main.small");
  const fills = await page
    .locator(".heatmap-cell:not(.is-free)")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        (node as HTMLElement).style.getPropertyValue("--cell-fill"),
      ),
    );
  // Three row groups of one table need at least three distinct shades.
  expect(new Set(fills).size).toBeGreaterThanOrEqual(3);
});

test("a row group picked in the logical map is highlighted on the physical map", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  const pick = page.getByRole("button", {
    name: "Row group 2 of main.wide: show where it is stored",
  });
  await pick.click();
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Row group 2", exact: true }),
  ).toBeVisible();
  const details = inspector(page);
  await expect(details).toContainText("main.wide");
  await expect(details).toContainText("Contiguous runs");
  const listed = await details
    .locator(".link-chip")
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(/Block (\d+)/.exec(node.textContent!)![1])),
    );
  expect(listed.length).toBeGreaterThan(0);

  await details
    .getByRole("button", { name: "Show on the physical map" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Physical map", exact: true }),
  ).toHaveAttribute("data-state", "active");
  // The inspector lists the first blocks; the map outlines all of them.
  const total = Number(
    (await details
      .locator(".detail-section-heading", { hasText: "Blocks in file order" })
      .locator("span")
      .last()
      .textContent())!.replaceAll(",", ""),
  );
  const highlighted = await ids(page, ".heatmap-cell.is-in-range");
  expect(highlighted).toHaveLength(total);
  expect(highlighted.slice(0, listed.length)).toEqual(listed);
  // Everything else is dimmed so the row group stands out.
  const dimmed = await ids(page, ".heatmap-cell.is-dimmed");
  const all = await ids(page, ".heatmap-cell");
  expect(dimmed.length).toBe(all.length - total);

  // Clicking a block returns to normal single-block inspection.
  await page.locator(`[data-block-id="${listed[0]}"]`).click();
  await expect(
    page.getByRole("heading", { name: `Block ${listed[0]}`, exact: true }),
  ).toBeVisible();
  expect(await ids(page, ".heatmap-cell.is-dimmed")).toEqual([]);
});

test("segments and blocks link to their row groups", async ({ page }) => {
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  await page.locator(".segment-choice").first().click();
  await inspector(page)
    .getByRole("button", { name: /Show row group \d+ on disk/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /^Row group \d+$/ }),
  ).toBeVisible();
  const highlighted = await ids(page, ".heatmap-cell.is-in-range");
  expect(highlighted.length).toBeGreaterThan(0);

  // A block's inspector lists the row groups it stores.
  await page.locator(`[data-block-id="${highlighted[0]}"]`).click();
  const chip = inspector(page)
    .locator(".link-chip")
    .filter({ hasText: /main\.\w+ · RG \d+/ })
    .first();
  const label = (await chip.textContent())!.trim();
  await chip.click();
  await expect(
    page.getByRole("heading", {
      name: `Row group ${label.split("RG ")[1]}`,
      exact: true,
    }),
  ).toBeVisible();
});
