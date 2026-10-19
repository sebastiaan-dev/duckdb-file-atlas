import { expect, test, type Page } from "@playwright/test";
import { databaseFixture } from "./fixture";
import { readFile } from "node:fs/promises";

const WASM_ASSET = /cdn\.jsdelivr\.net\/npm\/@duckdb\/duckdb-wasm@/;

type WorkerCounts = { created: number; terminated: number };

async function trackWorkers(page: Page) {
  await page.addInitScript(() => {
    const state = { created: 0, terminated: 0 };
    (window as typeof window & { tpchWorkers: WorkerCounts }).tpchWorkers =
      state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.created++;
      }
      override terminate() {
        if (!this.stopped) {
          this.stopped = true;
          state.terminated++;
        }
        super.terminate();
      }
    };
  });
  return () =>
    page.evaluate(
      () =>
        (window as typeof window & { tpchWorkers: WorkerCounts }).tpchWorkers,
    );
}

// These intentionally use the real, pinned CDN runtime/extension. Run with
// network access; a mocked worker cannot verify a checkpointed database export.
for (const scale of [0.01, 0.1, 1]) {
  test(`generates, downloads and opens a real v1.5.0 TPC-H database at SF ${scale}`, async ({
    page,
  }) => {
    test.skip(
      process.env.TPCH_BROWSER_NETWORK !== "1",
      "Set TPCH_BROWSER_NETWORK=1 to download and run the real runtime/extension",
    );
    test.setTimeout(180_000);
    const counts = await trackWorkers(page);
    const runtimeRequests: string[] = [];
    page.on("request", (request) => {
      if (WASM_ASSET.test(request.url())) runtimeRequests.push(request.url());
    });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Generate TPC-H", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("TPC-H scale factor")).toHaveValue("1");
    expect(runtimeRequests).toEqual([]);
    await page.getByLabel("TPC-H scale factor").selectOption(String(scale));

    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    const downloadLink = page.getByRole("link", { name: "Download .duckdb" });
    await expect(downloadLink).toBeVisible({ timeout: 150_000 });
    expect(await counts()).toEqual({ created: 1, terminated: 1 });
    expect(runtimeRequests.length).toBeGreaterThan(0);
    expect(
      runtimeRequests.every((url) => url.includes("@1.33.1-dev65.0/")),
    ).toBe(true);

    const downloaded = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`tpch-sf${scale}.duckdb`);
    const bytes = await readFile((await download.path())!);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    expect(bytes.subarray(8, 12).toString()).toBe("DUCK");
    expect(bytes.readBigUInt64LE(12)).toBe(68n);
    // The compatibility version lives in each checkpoint header, not at byte 12.
    expect(bytes.readBigUInt64LE(4096 + 56)).toBe(7n);
    expect(bytes.readBigUInt64LE(8192 + 56)).toBe(7n);

    await page.getByRole("button", { name: "Open generated sample" }).click();
    await expect(
      page.getByRole("heading", { name: `tpch-sf${scale}.duckdb` }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Physical map" })).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Storage compatibility warning" }),
    ).toContainText("v1.5.0");
    await expect(page.locator(".app-shell")).not.toHaveClass(/is-landing/);
    await expect(page.locator(".app-shell")).toHaveCSS(
      "background-image",
      "none",
    );
    // Exercise the native reader, not merely a successful WASM export/header.
    await expect(page.locator(".side-tables > button")).toHaveCount(8);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("tab", { name: "Logical map", exact: true }).click();
    await expect(
      page.locator('[data-logical-table="main.lineitem"]'),
    ).toBeVisible();
    expect(await page.locator(".segment-choice").count()).toBeGreaterThan(100);
    await page.getByRole("button", { name: "Expand summary" }).click();
    await page.locator(".inspection-notes summary").click();
    await expect(page.locator(".inspection-notes")).not.toContainText(
      "decoding is incomplete",
    );
    await expect(page.locator(".inspection-notes")).toContainText(
      "byte sizes are absent",
    );
  });
}

test("cancels a runtime download and can retry", async ({ page }) => {
  test.setTimeout(180_000);
  const counts = await trackWorkers(page);
  // Keep the CDN worker download pending. Cancelling must not wait for it.
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const routePattern = "**/duckdb-browser-*.worker.js";
  await page.route(routePattern, async (route) => {
    await blocked;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel generation" }),
    ).toBeVisible();
    await expect.poll(counts).toEqual({ created: 1, terminated: 0 });
    await page.getByRole("button", { name: "Cancel generation" }).click();
    await expect.poll(counts).toEqual({ created: 1, terminated: 1 });
    await expect(page.getByRole("status")).toContainText(
      "Generation cancelled",
    );
    await expect(
      page.getByRole("link", { name: "Download .duckdb" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    await expect.poll(counts).toEqual({ created: 2, terminated: 1 });
    await page.getByRole("button", { name: "Cancel generation" }).click();
    await expect.poll(counts).toEqual({ created: 2, terminated: 2 });
  } finally {
    release();
  }
});

test("opening a local file during generation releases the generator worker", async ({
  page,
}) => {
  const counts = await trackWorkers(page);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/duckdb-browser-*.worker.js", async (route) => {
    await blocked;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Generate TPC-H", exact: true })
      .click();
    await expect.poll(counts).toEqual({ created: 1, terminated: 0 });
    await page
      .getByLabel("Choose a DuckDB database file")
      .setInputFiles(databaseFixture());
    await expect(
      page.getByRole("heading", { name: "browser-fixture.duckdb" }),
    ).toBeVisible();
    await expect(page.locator(".tpch-generator")).toHaveCount(0);
    // Both the generation worker and the completed inspection worker are gone.
    await expect.poll(counts).toEqual({ created: 2, terminated: 2 });
  } finally {
    release();
  }
});

test("failed runtime downloads show actionable errors", async ({ page }) => {
  const counts = await trackWorkers(page);
  await page.route("**/duckdb-browser-*.worker.js", (route) => route.abort());
  await page.goto("/");
  await page
    .getByRole("button", { name: "Generate TPC-H", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("cdn.jsdelivr.net", {
    timeout: 30_000,
  });
  await expect(page.getByRole("alert")).toContainText("SF 0.01");
  expect(await counts()).toEqual({ created: 1, terminated: 1 });
  await expect(
    page.getByRole("button", { name: "Generate TPC-H", exact: true }),
  ).toBeEnabled();
});
