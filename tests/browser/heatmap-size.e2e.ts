import { expect, test, type Page } from "@playwright/test";
import { BLOCK_SIZE, DATA_START, databaseFixture } from "./fixture";

async function openMap(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Block tile size" }),
  ).toHaveValue("8");
  await expect(page.locator(".heatmap-cell")).toHaveCount(200);
}

async function expectGeometry(page: Page, size: number) {
  await expect
    .poll(
      async () =>
        (await page.locator(".heatmap-cell").first().boundingBox())?.width,
    )
    .toBe(size);
  const cell = (await page.locator(".heatmap-cell").first().boundingBox())!;
  expect(cell.height).toBe(size);
  const columns = Number(
    await page
      .getByRole("grid", { name: "Database block map" })
      .getAttribute("aria-colcount"),
  );
  const hostWidth = await page
    .locator(".block-heatmap")
    .evaluate((node) => node.clientWidth);
  const gap = size < 8 ? 1 : 2;
  expect(columns).toBe(
    Math.max(1, Math.floor((hostWidth - 51 + gap) / (size + gap))),
  );
  expect(
    await page
      .locator(".block-heatmap")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  return columns;
}

test("default tiles are compact squares, fill available width without a 32-column cap and preserve file order", async ({
  page,
}) => {
  await openMap(page);
  const columns = await expectGeometry(page, 8);
  expect(columns).toBeGreaterThan(32);
  expect(
    await page
      .locator(".heatmap-cell")
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute("data-block-id"))),
      ),
  ).toEqual(Array.from({ length: 200 }, (_, i) => i));
  await expect(page.locator(".zoom-buttons")).toHaveCount(0);
  await expect(page.locator(".tile-size-control output")).toHaveText("8 px");
});

test("slider supports all pixel sizes and resizing preserves block selection, byte paging and column-aware keyboard navigation", async ({
  page,
}) => {
  await openMap(page);
  await page.locator('[data-block-id="65"]').click();
  await expect(
    page.getByRole("heading", { name: "Block 65", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("64 byte hexadecimal preview")).toBeVisible();
  await page.getByRole("button", { name: "Next 64 bytes" }).click();
  const offset = `0x${(DATA_START + 65 * BLOCK_SIZE + 64).toString(16).padStart(8, "0")}`;
  await expect(page.locator(".byte-page-toolbar > span")).toHaveText(offset);
  const slider = page.getByRole("slider", { name: "Block tile size" });
  for (const [key, size] of [
    ["Home", 4],
    ["ArrowRight", 5],
    ["End", 24],
    ["ArrowLeft", 23],
  ] as const) {
    await slider.press(key);
    await expect(slider).toHaveValue(String(size));
    const columns = await expectGeometry(page, size);
    await expect(page.locator('[data-block-id="65"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".byte-page-toolbar > span")).toHaveText(offset);
    await expect(slider).toBeFocused();
    await page.locator('[data-block-id="65"]').focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator(`[data-block-id="${Math.min(199, 65 + columns)}"]`),
    ).toBeFocused();
  }
});

test("visible slider follows its value with a stable readout and keyboard focus in both themes", async ({
  page,
}) => {
  await openMap(page);
  const slider = page.getByRole("slider", { name: "Block tile size" });
  const control = page.locator(".tile-size-control");
  const initial = (await slider.boundingBox())!;
  for (const theme of ["light", "dark"]) {
    await page
      .locator(".app-shell")
      .evaluate((node, value) => node.setAttribute("data-theme", value), theme);
    for (const [key, size] of [
      ["Home", 4],
      ["ArrowRight", 5],
      ["End", 24],
    ] as const) {
      await slider.press(key);
      await expect(slider).toHaveValue(String(size));
      await expect(control.locator("output")).toHaveText(`${size} px`);
      // The readout width never moves the track under the pointer.
      const box = (await slider.boundingBox())!;
      expect(box.x).toBeCloseTo(initial.x, 0);
      expect(box.width).toBeCloseTo(initial.width, 0);
      expect(
        await control.evaluate((node) => getComputedStyle(node).outlineStyle),
      ).toBe("solid");
      expect(
        await slider.evaluate((node) => getComputedStyle(node).opacity),
      ).toBe("1");
    }
  }
  await expect(control.locator("span")).toHaveText("Tile size");
});

test("the full inset control accepts pointer input and updates the map", async ({
  page,
}) => {
  await openMap(page);
  const slider = page.getByRole("slider", { name: "Block tile size" });
  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(slider).toHaveValue("14");
  await expectGeometry(page, 14);
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await expect(slider).toHaveValue("24");
  await expectGeometry(page, 24);
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await expect(slider).toHaveValue("4");
  await expectGeometry(page, 4);
});

test.describe("touch slider input", () => {
  test.use({ hasTouch: true });
  test("tapping the inset slider updates the tile size on a phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMap(page);
    const slider = page.getByRole("slider", { name: "Block tile size" });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(slider).toHaveValue("14");
    await expectGeometry(page, 14);
  });
});

test("resizing restores the same keyboard-focused block after regrouping", async ({
  page,
}) => {
  await openMap(page);
  const grid = page.getByRole("grid", { name: "Database block map" });
  const previous = await grid.getAttribute("aria-colcount");
  await page.locator('[data-block-id="150"]').focus();
  await page.setViewportSize({ width: 1300, height: 1000 });
  await expect(grid).not.toHaveAttribute("aria-colcount", previous!);
  await expect(page.locator('[data-block-id="150"]')).toBeFocused();
  const columns = Number(await grid.getAttribute("aria-colcount"));
  await page.keyboard.press("ArrowUp");
  await expect(
    page.locator(`[data-block-id="${150 - columns}"]`),
  ).toBeFocused();
});

test("phone layout fits at both slider endpoints and tiny row labels do not overlap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMap(page);
  const slider = page.getByRole("slider", { name: "Block tile size" });
  for (const [key, size] of [
    ["Home", 4],
    ["End", 24],
  ] as const) {
    await slider.press(key);
    await expectGeometry(page, size);
    const box = (await slider.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const labels = await page
      .locator(".heatmap-row-label")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.textContent?.trim())
          .map((node) => node.getBoundingClientRect().top),
      );
    expect(labels[0]).toBeDefined();
    for (let i = 1; i < labels.length; i++)
      expect(labels[i] - labels[i - 1]).toBeGreaterThanOrEqual(14);
  }
});

test("changing tile size dismisses stale tooltip anchors, and pointer inspection works at 4px", async ({
  page,
}) => {
  await openMap(page);
  await page.locator('[data-block-id="10"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("Block 10");
  await page.getByRole("slider", { name: "Block tile size" }).press("Home");
  await expectGeometry(page, 4);
  await expect(page.locator(".block-heatmap-tooltip")).toHaveCount(0);
  await page.locator('[data-block-id="100"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("Block 100");
  await page.locator('[data-block-id="100"]').click();
  await expect(
    page.getByRole("heading", { name: "Block 100", exact: true }),
  ).toBeVisible();
});
