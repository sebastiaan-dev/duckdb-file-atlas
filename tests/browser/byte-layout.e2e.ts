import { expect, test, type Page } from "@playwright/test";
import { databaseFixture, manifestFixture } from "./fixture";

async function openBlock(page: Page, withManifest = false) {
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture(0, withManifest));
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  if (withManifest) {
    await page
      .getByLabel("Choose a semantic manifest JSON file")
      .setInputFiles(manifestFixture());
    await page.getByRole("tab", { name: "Physical map", exact: true }).click();
  }
  await page.locator('[data-block-id="0"]').click();
  await expect(
    page.getByLabel("Proportional byte ranges within block"),
  ).toBeVisible();
  await expect(page.getByLabel("Byte layout color mode")).toHaveCount(0);
}

const backgrounds = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).background),
    );

test("the main color selector updates the byte strip and range-list swatches without painting unknown bytes", async ({
  page,
}) => {
  await openBlock(page, true);
  const mode = page.getByLabel("Color blocks by");
  const ranges = page.locator(".range-list");
  await expect(page.locator(".byte-range-legend")).toHaveCount(0);
  const baseline = await backgrounds(page, ".byte-range.range-segment");
  expect(baseline[0]).toBe(baseline[1]);
  const unknown = await backgrounds(page, ".byte-range.range-unknown");
  for (const value of ["table", "column", "compression"]) {
    await mode.selectOption(value);
    await expect(ranges).toContainText("main.example.value0");
    await expect(ranges).toContainText("main.example.value1");
    const bars = await backgrounds(page, ".byte-range.range-segment");
    expect(bars).toEqual(
      await backgrounds(page, ".range-swatch.range-segment"),
    );
    if (value === "column") expect(bars[0]).not.toBe(bars[1]);
    else expect(bars[0]).toBe(bars[1]);
    expect(await backgrounds(page, ".byte-range.range-unknown")).toEqual(
      unknown,
    );
    await expect(ranges).toContainText("Checksum");
    await expect(page.getByLabel("64 byte hexadecimal preview")).toBeVisible();
  }
  for (const value of ["utilization", "fragmentation"]) {
    await mode.selectOption(value);
    const fill = await page
      .locator('[data-block-id="0"]')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(
      await page
        .locator(".byte-range.range-segment")
        .evaluateAll((nodes) =>
          nodes.map((node) => getComputedStyle(node).backgroundColor),
        ),
    ).toEqual([fill, fill]);
    expect(await backgrounds(page, ".byte-range.range-segment")).toEqual(
      await backgrounds(page, ".range-swatch.range-segment"),
    );
    expect(await backgrounds(page, ".byte-range.range-unknown")).toEqual(
      unknown,
    );
  }
  await mode.selectOption("role");
  expect(await backgrounds(page, ".byte-range.range-segment")).toEqual(
    baseline,
  );
});

test("a whole free block is visibly colored and labelled reusable in every mode and theme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBlock(page);
  for (const theme of ["light", "dark"]) {
    await page
      .locator(".app-shell")
      .evaluate((node, value) => node.setAttribute("data-theme", value), theme);
    for (const value of [
      "role",
      "table",
      "column",
      "compression",
      "utilization",
      "fragmentation",
    ]) {
      await page.getByLabel("Color blocks by").selectOption(value);
      await expect(page.locator(".range-list")).toContainText(
        "Free block data",
      );
      const bar = await backgrounds(page, ".byte-range.range-unused");
      expect(bar).toEqual(
        await backgrounds(page, ".range-swatch.range-unused"),
      );
      expect(bar[0]).not.toBe((await backgrounds(page, ".byte-strip"))[0]);
    }
  }
});
