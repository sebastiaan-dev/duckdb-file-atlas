import { expect, test, type Page } from "@playwright/test";
import { databaseFixture, multiRunFixture } from "./fixture";

async function open(page: Page, file = databaseFixture()) {
  await page.goto("/");
  await page.getByLabel("Choose a DuckDB database file").setInputFiles(file);
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
}

test("the summary starts collapsed to one line, expands, and remembers the choice", async ({
  page,
}) => {
  await open(page);
  const summary = page.getByRole("region", { name: "Database overview" });
  const mapTop = async () =>
    (await page.locator('[data-block-id="0"]').boundingBox())!.y;
  // Collapsed by default: file name, key figures and the role rail remain.
  await expect(summary).not.toContainText("FILE FOOTPRINT");
  await expect(summary.getByRole("heading")).toHaveText(
    "browser-fixture.duckdb",
  );
  await expect(summary).toContainText("Blocks");
  await expect(
    summary.getByRole("img", { name: /storage role/ }),
  ).toBeVisible();
  expect((await summary.boundingBox())!.height).toBeLessThan(60);
  const collapsedTop = await mapTop();

  await page.getByRole("button", { name: "Expand summary" }).click();
  await expect(summary).toContainText("FILE FOOTPRINT");
  await expect(summary.getByLabel("File properties")).toContainText("v69");
  expect(await mapTop()).toBeGreaterThan(collapsedTop + 150);

  await page.reload();
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("button", { name: "Collapse summary" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse summary" }).click();
  await expect(summary).not.toContainText("FILE FOOTPRINT");
});

test("the collapsed notes badge reopens the summary with notes expanded", async ({
  page,
}) => {
  // A physical-only fixture always carries a decoding-coverage note.
  await open(page, databaseFixture(0, true));
  await page.getByRole("button", { name: /^\d+ notes?$/ }).click();
  const notes = page.locator(".inspection-notes");
  await expect(notes).toHaveAttribute("open", "");
  await expect(notes).toContainText("decoding is incomplete");
});

test("the sidebar collapses to a rail with [ and the toolbar button, and remembers it", async ({
  page,
}) => {
  await open(page, multiRunFixture());
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.locator(".checkpoint-card")).toHaveCount(2);
  const before = (await page.locator('[data-block-id="0"]').boundingBox())!.x;

  await page.locator("body").press("[");
  await expect(sidebar.locator(".checkpoint-card")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show sidebar" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect((await sidebar.boundingBox())!.width).toBeLessThanOrEqual(53);
  await expect
    .poll(
      async () => (await page.locator('[data-block-id="0"]').boundingBox())!.x,
    )
    .toBeLessThan(before - 100);
  // The rail still selects checkpoints and shows the active one.
  const active = page.getByRole("button", { name: "Checkpoint 2, Active" });
  await active.click();
  await expect(page.getByLabel("Selection details")).toContainText(
    "newest valid header",
  );

  await page.reload();
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(multiRunFixture());
  await expect(sidebar.locator(".rail-button").first()).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar.locator(".checkpoint-card")).toHaveCount(2);
});

test("typing [ in the search box does not toggle the sidebar", async ({
  page,
}) => {
  await open(page);
  const search = page.getByRole("textbox", {
    name: "Search blocks, tables, or columns",
  });
  await search.fill("[");
  await expect(search).toHaveValue("[");
  await expect(
    page.getByRole("button", { name: "Hide sidebar" }),
  ).toBeVisible();
});

test("on narrow screens the sidebar opens as a dismissible drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await open(page, multiRunFixture());
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0);
  const toggle = page.getByRole("button", { name: "Show sidebar" });
  await toggle.click();
  const drawer = page.getByRole("dialog", { name: "Sidebar" });
  await expect(drawer).toBeFocused();
  await expect(drawer.locator(".checkpoint-card")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(toggle).toBeFocused();
  // Picking a checkpoint closes the drawer and shows its details.
  await toggle.click();
  await drawer.locator(".checkpoint-card").last().click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByLabel("Selection details")).toContainText(
    "newest valid header",
  );
  // The backdrop dismisses it as well.
  await toggle.click();
  await page.mouse.click(700, 450);
  await expect(drawer).toHaveCount(0);
});
