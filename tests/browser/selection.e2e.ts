import { expect, test, type Page } from "@playwright/test";
import { databaseFixture, manifestFixture, DATA_START } from "./fixture";

async function openDatabase(page: Page, physicalOnly = false) {
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture(0, physicalOnly));
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
}

async function expectPreview(page: Page, offset: number) {
  await expect(page.getByLabel("64 byte hexadecimal preview")).toBeVisible();
  await expect(page.locator(".byte-page-toolbar > span")).toHaveText(
    `0x${offset.toString(16).padStart(8, "0")}`,
  );
  await expect(
    page.getByRole("button", { name: "Next 64 bytes" }),
  ).toBeEnabled();
}

async function freeRuns(page: Page) {
  await openDatabase(page);
  await page.getByRole("tab", { name: "Free list", exact: true }).click();
  const bar = page.getByRole("button", { name: /^Free run 0–199,/ });
  await expect(bar).toBeVisible();
  await bar.scrollIntoViewIfNeeded();
  await bar.click();
  const detail = page.locator("svg.free-run-bar");
  await expect(detail).toBeVisible();
  return detail;
}

async function individualRuns(page: Page) {
  const bar = await freeRuns(page);
  const zoom = page.getByRole("button", {
    name: "Zoom in free runs",
    exact: true,
  });
  while (await zoom.isEnabled()) await zoom.click();
  await expect(bar).toHaveAttribute("data-blocks-per-tile", "1");
  return bar;
}

test("pointer focus does not move a scrolled free-run tile before hit testing", async ({
  page,
}) => {
  const bar = await individualRuns(page);
  await page.locator(".free-run-chart-scroll").evaluate((node) => {
    node.scrollLeft = 500;
  });
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 604, box.y + 7);
  await expect(page.getByRole("tooltip")).toContainText("Block 60");
  await page.mouse.click(box.x + 604, box.y + 7);
  await expect(
    page.getByRole("heading", { name: "Block 0060", exact: true }),
  ).toBeVisible();
  await expectPreview(page, DATA_START + 60 * 16384);
});

test.describe("touch input", () => {
  test.use({ hasTouch: true });

  test("tapping a scrolled free-run tile inspects that tile", async ({
    page,
  }) => {
    const bar = await individualRuns(page);
    await page.locator(".free-run-chart-scroll").evaluate((node) => {
      node.scrollLeft = 500;
    });
    const box = (await bar.boundingBox())!;
    await page.touchscreen.tap(box.x + 604, box.y + 7);
    await expect(
      page.getByRole("heading", { name: "Block 0060", exact: true }),
    ).toBeVisible();
  });
});

test("keyboard focus reveals the active tile and arrow/Home/End navigation still works", async ({
  page,
}) => {
  const bar = await individualRuns(page);
  await page.locator(".free-run-chart-scroll").evaluate((node) => {
    node.scrollLeft = 500;
  });
  // The disabled zoom-in button is skipped by Tab.
  await page.getByRole("button", { name: "Fit", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(bar).toBeFocused();
  await expect
    .poll(() =>
      page
        .locator(".free-run-chart-scroll")
        .evaluate((node) => node.scrollLeft),
    )
    .toBe(0);
  await page.keyboard.press("End");
  await expect(bar).toHaveAttribute("aria-label", /Block 199\./);
  await expect
    .poll(() =>
      page
        .locator(".free-run-chart-scroll")
        .evaluate((node) => node.scrollLeft),
    )
    .toBeGreaterThan(500);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Block 0001", exact: true }),
  ).toBeVisible();
});

test("grouped pointer tiles expand at the clicked group and retain keyboard activation", async ({
  page,
}) => {
  const bar = await freeRuns(page);
  while (Number(await bar.getAttribute("data-blocks-per-tile")) > 2)
    await page
      .getByRole("button", { name: "Zoom in free runs", exact: true })
      .click();
  await expect(bar).toHaveAttribute("data-blocks-per-tile", "2");
  await page.locator(".free-run-chart-scroll").evaluate((node) => {
    node.scrollLeft = 100;
  });
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + 204, box.y + 7);
  await expect(bar).toHaveAttribute("data-blocks-per-tile", "1");
  await expect(bar).toBeFocused();
  await expect(bar).toHaveAttribute("aria-label", /Block 40\./);
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("heading", { name: "Block 0040", exact: true }),
  ).toBeVisible();
});

test("reselecting a block preserves its byte page and paging controls", async ({
  page,
}) => {
  await openDatabase(page);
  const block = page.locator('[data-block-id="0"]');
  await block.click();
  await expectPreview(page, DATA_START);
  await page.getByRole("button", { name: "Next 64 bytes" }).click();
  await expectPreview(page, DATA_START + 64);
  await block.click();
  await expectPreview(page, DATA_START + 64);
  await page.getByRole("button", { name: "Previous 64 bytes" }).click();
  await expectPreview(page, DATA_START);
});

test("checkpoint reselect and raw-header inspection preserve a loaded preview", async ({
  page,
}) => {
  await openDatabase(page);
  const checkpoint = page.locator(".checkpoint-card").first();
  await checkpoint.click();
  // Exercise the completed hidden header read as well as repeated selection;
  // no timing sleeps are needed after an observable preview/page has loaded.
  await page.getByRole("button", { name: "Inspect raw header page" }).click();
  await expectPreview(page, 4096);
  await page.getByRole("button", { name: "Next 64 bytes" }).click();
  await expectPreview(page, 4160);
  await checkpoint.click();
  await checkpoint.click();
  await page.getByRole("button", { name: "Inspect raw header page" }).click();
  await expectPreview(page, 4160);
});

test("repeated segment selection and segment-to-block transitions reload the correct offset", async ({
  page,
}) => {
  await openDatabase(page, true);
  await page
    .getByLabel("Choose a semantic manifest JSON file")
    .setInputFiles(manifestFixture());
  const segment = page.locator(".segment-choice").first();
  await expect(segment).toBeVisible();
  await segment.click();
  await segment.click();
  await page.locator(".physical-link-card").click();
  await expectPreview(page, DATA_START);
  await page.locator(".owner-row").last().click();
  await page.locator(".physical-link-card").click();
  await expectPreview(page, DATA_START);
});
