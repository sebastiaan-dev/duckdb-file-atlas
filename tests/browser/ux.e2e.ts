import { expect, test, type Page } from "@playwright/test";
import {
  databaseFixture,
  manifestFor,
  multiRunFixture,
  type ManifestSegment,
} from "./fixture";

async function open(page: Page, file = databaseFixture()) {
  await page.goto("/");
  await page.getByLabel("Choose a DuckDB database file").setInputFiles(file);
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
}

test("the inspector is always reserved, so selecting a block never moves the map; Escape clears", async ({
  page,
}) => {
  await open(page);
  const details = page.getByLabel("Selection details");
  await expect(details).toContainText("Select a block");
  const block = page.locator('[data-block-id="150"]');
  const before = (await block.boundingBox())!;
  await block.click();
  await expect(
    page.getByRole("heading", { name: "Block 150", exact: true }),
  ).toBeVisible();
  expect(await block.boundingBox()).toEqual(before);
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(details).toContainText("Select a block");
  await expect(
    page.getByRole("button", { name: "Clear selection" }),
  ).toHaveCount(0);
});

test("checkpoints show which header is active and decode metadata pointers into block links", async ({
  page,
}) => {
  await open(page, multiRunFixture());
  const cards = page.locator(".checkpoint-card");
  await expect(cards.nth(0)).toContainText("Previous");
  await expect(cards.nth(1)).toContainText("Active");
  await cards.nth(1).click();
  const details = page.getByLabel("Selection details");
  await expect(details).toContainText("newest valid header");
  // Metadata root is INVALID in this fixture; the free list points at block 0.
  await expect(
    details.locator(".detail-pair").filter({ hasText: "Metadata root" }),
  ).toContainText("None");
  await details.getByRole("button", { name: /Block 0 · slot 0/ }).click();
  await expect(
    page.getByRole("heading", { name: "Block 0", exact: true }),
  ).toBeVisible();
});

let nextOffset = 128;
const segment = (
  table: string,
  column: string,
  rowGroup: number,
  rowStart: number,
  rowCount: number,
  columnType = "INTEGER",
): ManifestSegment => ({
  id: `${table}-${column}-${rowGroup}-${rowStart}`,
  table,
  column,
  columnType,
  rowGroup,
  blockId: rowGroup,
  offset: (nextOffset += 64),
  byteSize: 64,
  rowStart,
  rowCount,
  compression: "Uncompressed",
});

async function openLogical(page: Page) {
  await open(page, databaseFixture(0, true));
  await page
    .getByLabel("Choose a semantic manifest JSON file")
    .setInputFiles(
      manifestFor([
        segment("main.part", "p_id", 0, 0, 30),
        segment("main.part", "p_id", 0, 30, 10),
        segment("main.part", "p_id.validity", 0, 0, 40, "VALIDITY"),
        segment("main.part", "p_id", 1, 40, 40),
        segment("main.partsupp", "ps_id", 0, 0, 40),
      ]),
    );
  await expect(page.locator(".segment-choice").first()).toBeVisible();
}

test("logical cells are row-proportional strips; tables collapse and validity columns can be hidden", async ({
  page,
}) => {
  await openLogical(page);
  const part = page.locator('[data-logical-table="main.part"]');
  const strips = part
    .locator(".segment-cell-stack")
    .first()
    .locator(".segment-choice");
  await expect(strips).toHaveCount(2);
  const [wide, narrow] = await strips.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().width),
  );
  // 30 vs 10 rows (minus the 1px gap) — widths follow row counts.
  expect(wide / narrow).toBeGreaterThan(2.5);
  expect(wide / narrow).toBeLessThan(3.5);
  await expect(part.locator(".logical-column-head")).toHaveCount(2);
  await page.getByLabel("Validity columns").uncheck();
  await expect(part.locator(".logical-column-head")).toHaveCount(1);
  await part.locator(".table-group-heading").click();
  await expect(part.locator(".logical-table")).toHaveCount(0);
  await expect(part.locator(".table-group-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("an exact table name from the sidebar selects only that table", async ({
  page,
}) => {
  await openLogical(page);
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  await page
    .locator(".side-tables")
    .getByRole("button", { name: /^part\b/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Search blocks, tables, or columns" }),
  ).toHaveValue("main.part");
  await expect(page.locator("[data-logical-table]")).toHaveCount(1);
  await expect(page.locator('[data-logical-table="main.part"]')).toBeVisible();
  // Free-text search still matches substrings.
  await page
    .getByRole("textbox", { name: "Search blocks, tables, or columns" })
    .fill("main.par");
  await expect(page.locator("[data-logical-table]")).toHaveCount(2);
});

test("switching views reveals the selection in the logical map", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  await openLogical(page);
  await page.getByRole("tab", { name: "Physical map", exact: true }).click();
  await page.locator('[data-block-id="1"]').click();
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  const selected = page.locator(".segment-choice.selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeInViewport();
});
