import { expect, test } from "@playwright/test";
import { overflowDatabaseFixture } from "./fixture";

test("overflow allocations are distinct and navigate to their owning segment", async ({
  page,
}) => {
  test.skip(
    !process.env.DUCKDB_BIN,
    "Set DUCKDB_BIN to generate an overflow fixture",
  );
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(await overflowDatabaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-overflow.duckdb", exact: true }),
  ).toBeVisible();
  const overflow = page.getByRole("gridcell", { name: /Block \d+, overflow,/ });
  await expect(overflow.first()).toBeVisible();
  await expect(overflow.first()).toHaveAttribute(
    "aria-label",
    /main.documents/,
  );
  await expect(overflow.first()).toHaveClass(/overflow-allocation-mark/);
  const blockId = await overflow.first().getAttribute("data-block-id");
  await expect(page.locator(".physical-legend")).toContainText(
    "Overflow allocation",
  );
  await page.getByLabel("Color blocks by").selectOption("column");
  await expect(overflow.first()).toHaveAttribute(
    "aria-label",
    /main.documents.body/,
  );
  await page.getByLabel("Color blocks by").selectOption("rowgroup");
  await expect(overflow.first()).toHaveAttribute(
    "aria-label",
    /main.documents · RG 0/,
  );
  await page.getByLabel("Color blocks by").selectOption("utilization");
  await expect(overflow.first()).toHaveClass(/is-unknown/);
  await page.getByLabel("Color blocks by").selectOption("role");
  await expect(page.locator(".physical-legend")).toContainText("Overflow");
  await overflow.first().click();
  await expect(page.locator(".selected-kind-row")).toContainText(
    "overflow block",
  );
  await expect(page.locator(".detail-content")).toContainText(
    "contents are not decoded",
  );
  await page
    .locator(".owner-row")
    .filter({ hasText: "main.documents.body" })
    .click();
  await expect(
    page.getByRole("group", { name: "Overflow allocations" }),
  ).toBeVisible();
  const allocations = page.getByRole("group", {
    name: "Overflow allocations",
  });
  // Contiguous allocations collapse into one run that selects a block range.
  const run = allocations.getByRole("button", {
    name: /^Select overflow blocks \d+ to \d+$/,
  });
  await expect(run).toHaveCount(1);
  const [, first, last] = (await run.getAttribute("aria-label"))!.match(
    /(\d+) to (\d+)/,
  )!;
  expect(Number(first)).toBeLessThanOrEqual(Number(blockId));
  expect(Number(last)).toBeGreaterThanOrEqual(Number(blockId));
  await run.click();
  await expect(
    page.locator(`.heatmap-cell[data-block-id="${blockId}"]`),
  ).toHaveClass(/is-in-range/);
  await page.locator(`.heatmap-cell[data-block-id="${blockId}"]`).click();
  await expect(page.locator(".selected-kind-row")).toContainText(
    "overflow block",
  );
  // Searching for the owning column keeps its overflow allocations included.
  await page
    .getByRole("textbox", { name: "Search blocks, tables, or columns" })
    .fill("body");
  await expect(overflow.first()).not.toHaveClass(/is-dimmed/);
  // Logical cells also advertise and highlight indirect storage ownership.
  await page.getByRole("tab", { name: "Logical map", exact: true }).click();
  const logical = page
    .locator(".segment-choice.overflow-allocation-mark")
    .first();
  await expect(logical).toHaveAttribute("aria-label", /overflow allocations/);
  await expect(logical).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".logical-color-legend")).toContainText(
    "Has overflow",
  );
});
