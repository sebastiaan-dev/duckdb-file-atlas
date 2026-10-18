import { expect, test, type Page } from "@playwright/test";
import { databaseFixture, DATA_START, BLOCK_SIZE } from "./fixture";

type ByteReads = { pending: (() => Promise<void>)[]; hold: boolean };
declare global {
  interface Window {
    byteReads: ByteReads;
  }
}

async function waitForReads(page: Page, count: number) {
  await expect
    .poll(() => page.evaluate(() => window.byteReads.pending.length))
    .toBe(count);
}

async function releaseRead(page: Page, index = 0) {
  await page.evaluate(async (index) => {
    await window.byteReads.pending.splice(index, 1)[0]();
  }, index);
}

async function expectPage(page: Page, offset: number, byte = "00") {
  await expect(page.getByLabel("64 byte hexadecimal preview")).toBeVisible();
  await expect(page.locator(".hex-offset").first()).toHaveText(
    offset.toString(16).padStart(8, "0"),
  );
  await expect(page.locator(".hex-bytes i").first()).toHaveText(byte);
}

test.beforeEach(async ({ page }) => {
  // Hold actual local preview reads, not network requests or React state.
  // The inspection worker remains untouched and still decodes the real file.
  await page.addInitScript(() => {
    window.byteReads = { pending: [], hold: false };
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const bytes = read.call(this);
      if (this.size !== 64 || !window.byteReads.hold) return bytes;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        window.byteReads.pending.push(async () => {
          try {
            resolve(await bytes);
          } catch (error) {
            reject(error);
          }
        });
      });
    };
  });
  await page.goto("/");
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await page.locator('[data-block-id="0"]').click();
  await expectPage(page, DATA_START);
  await page.evaluate(() => {
    window.byteReads.hold = true;
  });
});

test("late page reads cannot replace a newer block's preview", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Next 64 bytes" }).click();
  await waitForReads(page, 1);
  await page.locator('[data-block-id="1"]').click();
  await waitForReads(page, 2);
  await releaseRead(page, 1);
  await expectPage(page, DATA_START + BLOCK_SIZE);
  await releaseRead(page);
  await expectPage(page, DATA_START + BLOCK_SIZE);
});

test("deselection and file replacement invalidate delayed reads for the same block ID", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Next 64 bytes" }).click();
  await waitForReads(page, 1);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByLabel("Choose a DuckDB database file").setInputFiles({
    ...databaseFixture(127),
    name: "replacement.duckdb",
  });
  await expect(
    page.getByRole("heading", { name: "replacement.duckdb" }),
  ).toBeVisible();
  await page.locator('[data-block-id="0"]').click();
  await waitForReads(page, 2);
  await releaseRead(page, 1);
  await expectPage(page, DATA_START, "7f");
  await releaseRead(page);
  await expectPage(page, DATA_START, "7f");
});

test("a failed replacement restores the current selection instead of losing its preview", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Next 64 bytes" }).click();
  await waitForReads(page, 1);
  await page.getByLabel("Choose a DuckDB database file").setInputFiles({
    name: "invalid.duckdb",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await waitForReads(page, 2);
  await releaseRead(page, 1);
  await expectPage(page, DATA_START);
  await releaseRead(page);
  await expectPage(page, DATA_START);
});
