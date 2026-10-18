import { expect, test, type Page } from "@playwright/test";
import { createDemo } from "../../src/lib/demo";
import type {
  FileInspection,
  IndexAllocator,
  IndexInspection,
} from "../../src/lib/types";
import { BLOCK_SIZE, databaseFixture, DATA_START } from "./fixture";

test.use({ hasTouch: true });

function allocator(
  ordinal: number,
  nodeType: string,
  size: number,
  count: number,
  occupied: number,
  stored: number,
): IndexAllocator {
  const buffers = Array.from({ length: count }, (_, id) => ({
    bufferId: id,
    blockId: 0,
    offset: id * 100 + ordinal * 50,
    // Deliberately reverse catalog order; graph must sort by physical offset.
    absoluteOffset: DATA_START + (count - id) * 100 + ordinal * 50,
    allocationSize: size * stored + 8,
    segmentCount: occupied,
    storedSlots: stored,
    occupiedBytes: occupied * size,
    freeBytes: (stored - occupied) * size,
    hasFreeSpace: true,
    runs: [],
  }));
  return {
    ordinal,
    nodeType,
    segmentSize: size,
    capacity: 1024,
    maskBytes: 8,
    occupiedSlots: count * occupied,
    occupiedBytes: count * occupied * size,
    freeBytes: count * (stored - occupied) * size,
    maskOverheadBytes: count * 8,
    allocationBytes: count * (stored * size + 8),
    buffers,
  };
}
function modelIndex(
  id: string,
  name: string,
  table: string,
  allocators: IndexAllocator[],
): IndexInspection {
  return {
    id,
    name,
    table,
    root: "0",
    rootPointer: { packed: "0", nodeType: "EMPTY", typeId: 0, gate: false },
    options: {},
    complete: true,
    blockIds: allocators.length ? [0] : [],
    allocators,
    occupiedBytes: allocators.reduce((n, a) => n + a.occupiedBytes, 0),
    freeBytes: allocators.reduce((n, a) => n + a.freeBytes, 0),
    maskOverheadBytes: allocators.reduce((n, a) => n + a.maskOverheadBytes, 0),
    allocationBytes: allocators.reduce((n, a) => n + a.allocationBytes, 0),
  };
}
/** Same synthetic worker-model boundary as index-stress; no application test hooks. */
function graphModel(bufferCount = 1000): FileInspection {
  const inspection = createDemo();
  const wide = Math.floor(bufferCount * 0.6),
    narrow = bufferCount - wide;
  const primary = modelIndex("primary", "large_index", "main.graphs", [
    allocator(0, "WIDE", 16, wide, 1, 4),
    allocator(1, "NARROW", 4, narrow, 3, 4),
    allocator(2, "EMPTY_CLASS", 8, 0, 0, 4),
  ]);
  const small = modelIndex("small", "tiny_index", "main.small", [
    allocator(0, "SMALL", 3, 1, 1, 1),
  ]);
  const zero = modelIndex("zero", "empty_index", "main.empty", []);
  const partial = {
    ...small,
    id: "partial",
    name: "partial_index",
    table: "main.partial",
    complete: false,
    reason: "Index range browser work limit exceeded",
  };
  inspection.indexes = [
    primary,
    small,
    zero,
    partial,
    ...Array.from({ length: 36 }, (_, i) => ({
      ...small,
      id: `extra-${i}`,
      name: `extra_${i}`,
      table: "main.extra",
    })),
  ];
  inspection.name = "browser-fixture.duckdb";
  inspection.source = "file";
  inspection.fileSize = databaseFixture().buffer.length;
  inspection.blockSize = BLOCK_SIZE;
  inspection.segments = [];
  inspection.freeList = undefined;
  inspection.blocks = [
    ...inspection.blocks.filter((block) => block.role === "header"),
    {
      id: 0,
      offset: DATA_START,
      size: BLOCK_SIZE,
      role: "index",
      label: "large_index",
      usedBytes: null,
      ranges: [
        {
          id: "unknown",
          offset: DATA_START,
          size: BLOCK_SIZE,
          kind: "unknown",
          label: "Synthetic index block",
        },
      ],
      segmentIds: [],
      links: [],
      indexIds: ["primary"],
      indexOwners: [
        { id: "primary", table: "main.graphs", name: "large_index" },
      ],
    },
  ];
  return inspection;
}
async function openGraphs(page: Page, bufferCount = 1000) {
  const inspection = graphModel(bufferCount);
  await page.route("**/src/lib/inspection-worker.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage = () => self.postMessage(${JSON.stringify({ inspection })});`,
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.locator(".index-comparison-row")).toHaveCount(32);
}
const row = (page: Page, name: string) =>
  page.locator(".index-comparison-row").filter({ hasText: name });

test("graphs link index selection, ranked metrics, allocator filtering and a stable full-file baseline", async ({
  page,
}) => {
  await openGraphs(page);
  await expect(page.locator(".index-buffer-tile")).toHaveCount(1000);
  await expect(
    page.getByRole("button", { name: "Load more buffers", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".index-selected-heading h3")).toHaveText(
    "large_index",
  );
  await expect(page.locator(".index-allocator-row")).toHaveCount(2);
  await expect(page.locator(".index-allocator-row").first()).toContainText(
    "WIDE",
  );
  const axis = await page
    .locator(".index-comparison")
    .getAttribute("data-axis-max");
  const totals = await page.locator(".index-metrics").innerText();
  const tinyWidth = await row(page, "tiny_index")
    .locator(".index-stack")
    .evaluate((node) => (node as HTMLElement).style.width);
  expect(parseFloat(tinyWidth!)).toBeLessThan(0.1);
  const offsets = await page
    .locator(".index-buffer-tile")
    .evaluateAll((nodes) =>
      nodes.map((n) => Number(n.getAttribute("data-offset"))),
    );
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  const wideTile = page
    .locator('.index-buffer-tile[data-allocator="0"]')
    .first();
  const narrowTile = page
    .locator('.index-buffer-tile[data-allocator="1"]')
    .first();
  // Hue encodes node type; fill height encodes occupied / stored slots.
  const encoding = (node: Element) => ({
    color: (node as HTMLElement).style.getPropertyValue("--tile-color"),
    fill: (node as HTMLElement).style.getPropertyValue("--tile-fill"),
  });
  expect(await wideTile.evaluate(encoding)).toEqual({
    color: "var(--node-other-0)",
    fill: "25.0%",
  });
  expect(await narrowTile.evaluate(encoding)).toEqual({
    color: "var(--node-other-1)",
    fill: "75.0%",
  });
  const offset = await wideTile.getAttribute("data-offset");
  const color = await wideTile.evaluate(
    (node) => getComputedStyle(node).backgroundImage,
  );
  await page.getByRole("button", { name: "Slot count", exact: true }).click();
  await expect(page.locator(".index-allocator-row").first()).toContainText(
    "NARROW",
  );
  await page
    .locator(".index-allocator-row")
    .filter({ hasText: "WIDE" })
    .click();
  await expect(
    page.locator('.index-buffer-tile[data-allocator="1"]'),
  ).toHaveCount(0);
  expect(
    await page
      .locator(`.index-buffer-tile[data-offset="${offset}"]`)
      .evaluate((node) => getComputedStyle(node).backgroundImage),
  ).toBe(color);
  await expect(page.locator(".index-buffer-graph")).toContainText(
    "600 of 1,000 buffers",
  );
  await page
    .getByRole("button", { name: "Clear WIDE filter", exact: true })
    .click();
  await expect(
    page.locator('.index-buffer-tile[data-allocator="1"]').first(),
  ).toBeVisible();
  await expect(page.locator(".index-buffer-graph")).toContainText(
    "1,000 buffers",
  );
  // Clicking the active allocator row again also clears the filter.
  const narrowRow = page
    .locator(".index-allocator-row")
    .filter({ hasText: "NARROW" });
  await narrowRow.click();
  await expect(
    page.locator('.index-buffer-tile[data-allocator="0"]'),
  ).toHaveCount(0);
  await narrowRow.click();
  await expect(narrowRow).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.locator('.index-buffer-tile[data-allocator="0"]').first(),
  ).toBeVisible();
  await row(page, "tiny_index").click();
  await expect(page.locator(".index-selected-heading h3")).toHaveText(
    "tiny_index",
  );
  await page.getByLabel("Search indexes or tables").fill("main.graphs");
  await expect(page.locator(".index-comparison-row")).toHaveCount(1);
  await expect(page.locator(".index-selected-heading h3")).toHaveText(
    "tiny_index",
  );
  await expect(page.locator(".index-view")).toContainText(
    "Selected index is hidden by search",
  );
  await expect(page.locator(".index-comparison")).toHaveAttribute(
    "data-axis-max",
    axis!,
  );
  expect(await page.locator(".index-metrics").innerText()).toBe(totals);
  await page.getByLabel("Search indexes or tables").fill("main.small");
  expect(
    await row(page, "tiny_index")
      .locator(".index-stack")
      .evaluate((node) => (node as HTMLElement).style.width),
  ).toBe(tinyWidth);
  await page.getByLabel("Search indexes or tables").fill("missing");
  await expect(page.locator(".index-view")).toContainText("No indexes match");
});

test("known zero stays selectable and partial catalog data never becomes measured graphs", async ({
  page,
}) => {
  await openGraphs(page);
  await row(page, "empty_index").click();
  await expect(row(page, "empty_index")).toContainText("0 B");
  await expect(row(page, "empty_index")).toContainText("Empty / inlined");
  await expect(page.locator(".index-selection")).toContainText(
    "Measured zero persisted allocator storage",
  );
  await expect(page.locator(".index-buffer-tile")).toHaveCount(0);
  await row(page, "partial_index").click();
  await expect(row(page, "partial_index")).toContainText("Unknown");
  await expect(page.locator(".index-incomplete")).toContainText(
    "work limit exceeded",
  );
  await expect(page.locator(".index-allocator-row")).toHaveCount(0);
  await expect(page.locator(".index-buffer-tile")).toHaveCount(0);
  await expect(page.locator(".index-coverage")).toContainText(
    "39 of 40 indexes completely measured",
  );
  await page.locator(".index-technical summary").click();
  await expect(page.locator(".index-technical")).toContainText("Root: 0");
  await expect(page.locator(".index-raw-buffers")).toHaveCount(0);
  await page.locator(".index-technical .link-chip").click();
  await expect(page.getByLabel("Selection details")).toContainText(
    "Index ownership",
  );
});

test("buffer keyboard navigation, one reusable tooltip, touch picking, and file replacement", async ({
  page,
}) => {
  await openGraphs(page);
  const tiles = page.locator(".index-buffer-tile");
  await expect(page.locator(".index-buffer-tile[tabindex='0']")).toHaveCount(1);
  await tiles.first().focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "/ 4 slots",
  );
  await tiles.first().press("ArrowRight");
  await expect(tiles.nth(1)).toBeFocused();
  await page.setViewportSize({ width: 1300, height: 1000 });
  await expect(tiles.nth(1)).toBeFocused();
  const columns = await page
    .locator(".index-buffer-grid")
    .evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length,
    );
  await tiles.nth(1).press("ArrowDown");
  await expect(tiles.nth(1 + columns)).toBeFocused();
  await tiles.nth(1 + columns).press("ArrowUp");
  await expect(tiles.nth(1)).toBeFocused();
  await tiles.nth(1).press("ArrowLeft");
  await expect(tiles.first()).toBeFocused();
  await tiles.first().press("End");
  await expect(tiles.last()).toBeFocused();
  await tiles.last().press("Enter");
  await expect(page.getByLabel("Selection details")).toContainText(
    "large_index",
  );
  await expect(
    page.getByRole("tab", { name: "Indexes", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await tiles.last().press("Home");
  await expect(tiles.first()).toBeFocused();
  await tiles.first().press("Space");
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await tiles.nth(1).tap();
  await expect(tiles.nth(1)).toHaveAttribute("aria-pressed", "true");
  await row(page, "tiny_index").click();
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles({ ...databaseFixture(), name: "replacement.duckdb" });
  await page.getByRole("tab", { name: "Indexes", exact: true }).click();
  await expect(page.locator(".index-selected-heading h3")).toHaveText(
    "large_index",
  );
});

test("100k-buffer model has bounded initial DOM, progressive tiles and progressive comparison rows", async ({
  page,
}) => {
  await openGraphs(page, 100000);
  await expect(page.locator(".index-buffer-tile")).toHaveCount(256);
  await expect(page.locator(".index-buffer-graph")).toContainText(
    "100,000 buffers",
  );
  expect(await page.locator("*").count()).toBeLessThan(1800);
  await page
    .getByRole("button", { name: "Load more buffers", exact: true })
    .click();
  await expect(page.locator(".index-buffer-tile")).toHaveCount(512);
  await page
    .getByRole("button", { name: "Load more indexes", exact: true })
    .click();
  await expect(page.locator(".index-comparison-row")).toHaveCount(40);
  expect(await page.locator("*").count()).toBeLessThan(2200);
  await page.locator(".index-technical summary").click();
  await expect(page.locator(".index-raw-buffers .link-chip")).toHaveCount(32);
});

test("desktop two-column and phone stacked graphs fit both themes with a fixed ramp", async ({
  page,
}) => {
  await openGraphs(page);
  for (const width of [1400, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page
        .locator(".app-shell")
        .evaluate(
          (node, value) => node.setAttribute("data-theme", value),
          theme,
        );
      const columns = await page
        .locator(".index-linked-graphs")
        .evaluate(
          (node) =>
            getComputedStyle(node).gridTemplateColumns.split(" ").length,
        );
      expect(columns).toBe(width === 1400 ? 2 : 1);
      const viewportFits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(viewportFits).toBe(true);
      const wide = await page
        .locator('.index-buffer-tile[data-allocator="0"]')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundImage);
      const narrow = await page
        .locator('.index-buffer-tile[data-allocator="1"]')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundImage);
      expect(wide).not.toBe(narrow);
      await page
        .locator(".index-allocator-row")
        .filter({ hasText: "WIDE" })
        .click();
      expect(
        await page
          .locator(".index-buffer-tile")
          .first()
          .evaluate((node) => getComputedStyle(node).backgroundImage),
      ).toBe(wide);
      await page
        .getByRole("button", { name: "Clear WIDE filter", exact: true })
        .click();
    }
  }
});
