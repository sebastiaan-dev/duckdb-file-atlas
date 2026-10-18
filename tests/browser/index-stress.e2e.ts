import { expect, test, type Page } from "@playwright/test";
import { createDemo } from "../../src/lib/demo";
import type {
  FileBlock,
  FileInspection,
  IndexInspection,
} from "../../src/lib/types";
import { databaseFixture, DATA_START } from "./fixture";

/** Renderer stress model; native mask validity is covered by parser tests. */
async function openSyntheticIndex(page: Page, complete: boolean) {
  const size = 262144;
  const slots = 32766;
  const ranges: FileBlock["ranges"] = [
    {
      id: "checksum",
      label: "Checksum",
      offset: DATA_START,
      size: 8,
      kind: "checksum",
    },
    {
      id: "mask",
      label: "Allocator mask",
      offset: DATA_START + 8,
      size: 8,
      kind: "index",
      indexId: "stress",
    },
  ];
  for (let slot = 0; slot < slots; slot++)
    ranges.push({
      id: `slot-${slot}`,
      label: `Slot ${slot}`,
      offset: DATA_START + 16 + slot * 8,
      size: 8,
      kind: slot % 2 ? "unused" : "index",
      indexId: "stress",
    });
  const inspection = createDemo();
  inspection.name = "browser-fixture.duckdb";
  inspection.source = "file";
  inspection.blockSize = size;
  inspection.fileSize = databaseFixture().buffer.length;
  inspection.segments = [];
  inspection.freeList = undefined;
  inspection.blocks = [
    ...inspection.blocks.filter((block) => block.role === "header"),
    {
      id: 0,
      offset: DATA_START,
      size,
      role: "index",
      label: "stress_idx",
      usedBytes: complete ? 131080 : null,
      ranges: complete
        ? ranges
        : [
            ranges[0],
            {
              id: "unknown",
              label: "Incomplete index allocation",
              kind: "unknown",
              offset: DATA_START + 8,
              size: size - 8,
            },
          ],
      segmentIds: [],
      links: [],
      indexIds: ["stress"],
      indexOwners: [{ id: "stress", table: "main.t", name: "stress_idx" }],
    },
  ];
  const index: IndexInspection = {
    id: "stress",
    table: "main.t",
    name: "stress_idx",
    root: "0",
    rootPointer: { packed: "0", nodeType: "EMPTY", typeId: 0, gate: false },
    options: {},
    complete,
    reason: complete ? undefined : "Index range browser work limit exceeded",
    blockIds: [0],
    occupiedBytes: complete ? 131064 : null,
    freeBytes: complete ? 131064 : null,
    maskOverheadBytes: complete ? 8 : null,
    allocationBytes: complete ? size - 8 : null,
    allocators: [
      {
        ordinal: 0,
        nodeType: "NODE7_LEAF",
        segmentSize: 8,
        capacity: slots,
        maskBytes: 8,
        occupiedSlots: slots / 2,
        occupiedBytes: 131064,
        freeBytes: 131064,
        maskOverheadBytes: 8,
        allocationBytes: size - 8,
        buffers: [
          {
            bufferId: 0,
            blockId: 0,
            offset: 0,
            absoluteOffset: DATA_START + 8,
            allocationSize: size - 8,
            segmentCount: slots / 2,
            storedSlots: slots,
            occupiedBytes: 131064,
            freeBytes: 131064,
            hasFreeSpace: true,
            runs: complete
              ? Array.from({ length: slots }, (_, start) => ({
                  start,
                  count: 1,
                  occupied: start % 2 === 0,
                }))
              : [],
          },
        ],
      },
    ],
  };
  inspection.indexes = [index];
  await openIndexModel(page, inspection);
}

/** Exercise the real app/worker result boundary without application test hooks. */
export async function openIndexModel(page: Page, inspection: FileInspection) {
  // A synthetic worker result keeps renderer tests independent of CLI versions.
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
  await expect(page.locator(".index-comparison-row")).toHaveCount(
    Math.min(32, inspection.indexes?.length ?? 0),
  );
}

test("incomplete mask scans never present allocator catalog counts as measured occupancy", async ({
  page,
}) => {
  await openSyntheticIndex(page, false);
  await expect(page.locator(".index-incomplete")).toContainText(
    "work limit exceeded",
  );
  await expect(page.locator(".index-unknown-extent")).toContainText(
    "Unmeasured",
  );
  await expect(page.locator(".index-metrics strong")).toHaveText(["Unknown", "Unknown"]);
  await expect(page.locator(".index-allocator-row")).toHaveCount(0);
  await expect(page.locator(".index-buffer-tile")).toHaveCount(0);
  await expect(page.locator(".index-technical")).not.toHaveAttribute(
    "open",
    "",
  );
});

test("highly fragmented blocks use a bounded SVG strip and progressively reveal range rows", async ({
  page,
}) => {
  await openSyntheticIndex(page, true);
  await page.locator(".index-buffer-tile").first().click();
  await expect(page.locator(".dense-byte-strip")).toBeVisible();
  await expect(page.locator(".byte-strip .byte-range")).toHaveCount(0);
  expect(await page.locator(".dense-byte-strip > path").count()).toBeLessThan(
    5,
  );
  await expect(page.locator(".range-row")).toHaveCount(128);
  await expect(page.locator(".range-load-more")).toContainText(
    "128 of 32,768 ranges",
  );
  expect(await page.locator("*").count()).toBeLessThan(3000);
  await page
    .getByRole("button", { name: "Load more ranges", exact: true })
    .click();
  await expect(page.locator(".range-row")).toHaveCount(256);
  await page.getByRole("tab", { name: "Physical map", exact: true }).click();
  await page.getByLabel("Color blocks by").selectOption("table");
  await expect(page.locator(".dense-byte-strip")).toBeVisible();
  expect(await page.locator(".dense-byte-strip > path").count()).toBeLessThan(
    5,
  );
});
