import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCK_SIZE,
  DATA_START,
  databaseFixture,
  multiRunFixture,
} from "./fixture";

async function openRuns(page: Page, fixture = multiRunFixture()) {
  await page.goto("/");
  await page.getByLabel("Choose a DuckDB database file").setInputFiles(fixture);
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Free list", exact: true }).click();
  await expect(page.locator(".free-run-overview")).toBeVisible();
  await page.locator(".free-run-overview").scrollIntoViewIfNeeded();
}

async function barWidths(page: Page) {
  return page
    .locator(".free-run-overview-bar")
    .evaluateAll((bars) =>
      bars.map((bar) => bar.getBoundingClientRect().width),
    );
}

test("overview positions runs on the file axis and offers a fixed-scale size comparison", async ({
  page,
}) => {
  await openRuns(page);
  const overview = page.locator(".free-run-overview");
  await expect(overview).toHaveAttribute("data-mode", "position");
  await expect(overview).toHaveAttribute("data-scale-max", "66");
  await expect(overview.getByText("Block ID · full file")).toBeVisible();
  const starts = await overview
    .locator(".free-run-overview-bar")
    .evaluateAll((bars) =>
      bars.map((bar) => parseFloat((bar as HTMLElement).style.left)),
    );
  for (const [i, id] of [1, 20, 40, 60].entries())
    expect(starts[i]).toBeCloseTo((id / 66) * 100, 4);
  const bars = page.locator(".free-run-overview-target");
  await expect(bars).toHaveCount(4);
  expect(
    await bars.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-run-start")),
    ),
  ).toEqual(["1", "20", "40", "60"]);
  const widths = await barWidths(page);
  expect(widths[1] / widths[0]).toBeCloseTo(0.5, 2);
  expect(widths[2] / widths[0]).toBeCloseTo(1 / 12, 2);
  expect(widths[3] / widths[0]).toBeCloseTo(0.5, 2);
  await expect(
    overview.locator("[role=table], [role=row], .free-run-values"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Zoom in free runs" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Size", exact: true }).click();
  await expect(overview).toHaveAttribute("data-scale-max", "12");
  await expect(overview.getByText("Run length (blocks)")).toBeVisible();
  await expect(overview.locator(".free-run-overview-count")).toHaveText([
    "12",
    "6",
    "1",
    "6",
  ]);
});

test("provenance filtering retains the full-file scale rather than stretching the remaining run", async ({
  page,
}) => {
  await openRuns(page);
  const before = await barWidths(page);
  await page
    .getByRole("textbox", { name: "Search free block IDs" })
    .fill("implicit");
  await expect(page.locator(".free-run-overview-target")).toHaveCount(1);
  await expect(page.locator(".free-run-overview")).toHaveAttribute(
    "data-scale-max",
    "66",
  );
  const after = await barWidths(page);
  expect(after[0]).toBeCloseTo(before[3], 1);
  await expect(page.locator(".free-run-overview-target")).toHaveAttribute(
    "data-run-start",
    "60",
  );
});

test("hover and keyboard focus expose range, count, bytes and provenance; Enter drills and Back restores focus", async ({
  page,
}) => {
  await openRuns(page);
  const run = page.locator('.free-run-overview-target[data-run-start="20"]');
  await run.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Blocks 20–25");
  await expect(tooltip).toContainText("6 blocks · 96 KiB");
  await expect(tooltip).toContainText("Serialized free list");
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
  await run.focus();
  await expect(tooltip).toBeVisible();
  await expect(run).toHaveAttribute("aria-describedby", /hint/);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Enter");
  const detail = page.locator("svg.free-run-bar");
  await expect(detail).toHaveAttribute("data-run-start", "20");
  await expect(detail).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Zoom in free runs" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to run overview" }).click();
  await expect(run).toBeFocused();
  const implicit = page.locator(
    '.free-run-overview-target[data-run-start="60"]',
  );
  await implicit.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "Outside checkpoint extent (implicit)",
  );
});

test("numeric search reveals its exact block in detail without stealing input focus", async ({
  page,
}) => {
  await openRuns(page);
  const input = page.getByRole("textbox", { name: "Search free block IDs" });
  await input.fill("24");
  const detail = page.locator("svg.free-run-bar");
  await expect(detail).toHaveAttribute("data-blocks-per-tile", "1");
  await expect(detail).toHaveAttribute("aria-label", /Block 24\./);
  await expect(input).toBeFocused();
  await detail.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Block 0024", exact: true }),
  ).toBeVisible();
});

test("explicit drill transfers keyboard focus even while a numeric search remains active", async ({
  page,
}) => {
  await openRuns(page);
  const input = page.getByRole("textbox", { name: "Search free block IDs" });
  await input.fill("24");
  await expect(page.locator("svg.free-run-bar")).toBeVisible();
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Back to run overview" }).click();
  const run = page.locator('.free-run-overview-target[data-run-start="20"]');
  await expect(run).toBeFocused();
  await page.keyboard.press("Enter");
  const detail = page.locator("svg.free-run-bar");
  await expect(detail).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(detail).toHaveAttribute("aria-label", /Block 25\./);
});

test("detail tooltip follows the measured scale on narrow screens and after resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRuns(page, databaseFixture());
  await page.locator(".free-run-overview-target").click();
  const detail = page.locator("svg.free-run-bar");
  await expect(detail).toBeFocused();
  const expectCurrentGroup = async () => {
    const grouping = Number(await detail.getAttribute("data-blocks-per-tile"));
    await expect(page.getByRole("tooltip")).toContainText(
      `Blocks 0–${grouping - 1}`,
    );
    await expect(page.getByRole("tooltip")).toContainText(
      `${grouping} blocks · click to expand`,
    );
  };
  await expectCurrentGroup();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await expect(detail).not.toHaveAttribute("data-blocks-per-tile", "32");
  await expectCurrentGroup();
});

test("a one-block run still drills before inspecting and fits a narrow viewport in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRuns(page, databaseFixture(0, false, 1));
  const run = page.locator(".free-run-overview-target");
  await expect(run).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    await page
      .locator(".app-shell")
      .evaluate((node, value) => node.setAttribute("data-theme", value), theme);
    expect(
      await page
        .locator(".free-run-overview")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const box = (await run.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThan(390);
    await run.focus();
    await expect(page.getByRole("tooltip")).toContainText("1 block · 16 KiB");
  }
  await run.click();
  await expect(
    page.getByRole("heading", { name: "Block 0000", exact: true }),
  ).toHaveCount(0);
  await page.locator("svg.free-run-bar").press("Enter");
  await expect(
    page.getByRole("heading", { name: "Block 0000", exact: true }),
  ).toBeVisible();
});

test("multi-run proportions and labels remain contained at phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRuns(page);
  const widths = await barWidths(page);
  expect(widths[1] / widths[0]).toBeCloseTo(0.5, 2);
  expect(
    await page
      .locator(".free-run-overview")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(page.locator(".free-run-overview-count")).toHaveText([
    "12",
    "6",
    "1",
    "6",
  ]);
});

test("100,000 blocks use one continuous overview bar and constant-size patterned detail", async ({
  page,
}) => {
  // A sparse file exercises a real upload at the discovery limit without
  // allocating or transmitting 1.6 GB through Playwright's Buffer transport.
  const dir = await mkdtemp(join(tmpdir(), "atlas-free-runs-"));
  try {
    const path = join(dir, "huge-run.duckdb");
    await writeFile(
      path,
      databaseFixture(0, false, 1).buffer.subarray(0, DATA_START),
    );
    await truncate(path, DATA_START + 100_000 * BLOCK_SIZE);
    await page.goto("/");
    await page.getByLabel("Choose a DuckDB database file").setInputFiles(path);
    await expect(
      page.getByRole("heading", { name: "huge-run.duckdb" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Free list", exact: true }).click();
    const run = page.locator(".free-run-overview-target");
    await expect(run).toHaveCount(1);
    await expect(page.locator(".free-run-overview-count")).toHaveText(
      "100,000",
    );
    await run.click();
    const detail = page.locator("svg.free-run-bar");
    await expect(detail.locator("pattern")).toHaveCount(1);
    await expect(detail.locator("rect")).toHaveCount(3);
    while (
      await page.getByRole("button", { name: "Zoom in free runs" }).isEnabled()
    )
      await page.getByRole("button", { name: "Zoom in free runs" }).click();
    await expect(detail).toHaveAttribute("data-blocks-per-tile", "1");
    await detail.focus();
    await page.keyboard.press("End");
    await expect(detail).toHaveAttribute("aria-label", /Block 99999\./);
    await expect(detail.locator("rect")).toHaveCount(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
