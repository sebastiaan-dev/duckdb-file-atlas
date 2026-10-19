import { expect, test, type Page } from "@playwright/test";
import { BLOCK_SIZE, databaseFixture, indexDatabaseFixture } from "./fixture";

const cell = (page: Page, id: number) =>
  page.locator(`[data-block-id="${id}"]`);
const inspector = (page: Page) => page.getByLabel("Selection details");

async function openFixture(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
}

async function drag(page: Page, from: number, to: number) {
  const start = (await cell(page, from).boundingBox())!;
  const end = (await cell(page, to).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
}

const inRange = (page: Page) =>
  page
    .locator(".heatmap-cell.is-in-range")
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-block-id"))),
    );

test("dragging across tiles selects the blocks between them in file order", async ({
  page,
}) => {
  await openFixture(page);
  await drag(page, 12, 3);
  await expect(
    page.getByRole("heading", { name: "Blocks 3–12", exact: true }),
  ).toBeVisible();
  expect(await inRange(page)).toEqual(
    Array.from({ length: 10 }, (_, i) => i + 3),
  );
  await expect(cell(page, 7)).toHaveAttribute("aria-selected", "true");
  // The drag ends with a click on block 3; that must not replace the range.
  await expect(cell(page, 3)).not.toHaveClass(/is-selected/);
  const details = inspector(page);
  await expect(details.locator(".detail-pair").first()).toContainText("10");
  await expect(details).toContainText(`${(10 * BLOCK_SIZE) / 1024} KiB`);
  await expect(details).toContainText("Free blocks");
  await expect(
    details.getByRole("img", { name: "Free blocks 160 KiB (100.0%)" }),
  ).toBeVisible();

  // A plain click returns to single-block inspection.
  await cell(page, 20).click();
  await expect(
    page.getByRole("heading", { name: "Block 20", exact: true }),
  ).toBeVisible();
  expect(await inRange(page)).toEqual([]);

  // Escape clears a range like any other selection.
  await drag(page, 20, 24);
  await expect(
    page.getByRole("heading", { name: "Blocks 20–24", exact: true }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toContainText("Select a block");
  expect(await inRange(page)).toEqual([]);
});

test("Shift+click and Shift+arrow keys extend a range from the selected block", async ({
  page,
}) => {
  await openFixture(page);
  await cell(page, 5).click();
  await cell(page, 9).click({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("heading", { name: "Blocks 5–9", exact: true }),
  ).toBeVisible();
  // Shift+click keeps the original anchor.
  await cell(page, 2).click({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("heading", { name: "Blocks 2–5", exact: true }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await cell(page, 40).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(
    page.getByRole("heading", { name: "Blocks 40–42", exact: true }),
  ).toBeVisible();
  await expect(cell(page, 42)).toBeFocused();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  // Collapsing back onto the anchor is a single selection again.
  await expect(
    page.getByRole("heading", { name: "Block 40", exact: true }),
  ).toBeVisible();
});

test("a range aggregates owners, usage and composition of real blocks", async ({
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
  const ids = await page
    .locator(".heatmap-cell")
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-block-id"))),
    );
  await drag(page, ids[0], ids.at(-1)!);
  await expect(
    page.getByRole("heading", {
      name: `Blocks ${ids[0]}–${ids.at(-1)}`,
      exact: true,
    }),
  ).toBeVisible();
  const details = inspector(page);
  await expect(details).toContainText("Space used");
  await expect(details.locator(".range-owner-list").first()).toContainText(
    "main.t",
  );
  await expect(details).toContainText("named_id");
  await expect(details).toContainText("Blocks by role");
});
