import { expect, test } from "@playwright/test";
import { databaseFixture } from "./fixture";

for (const [version, label] of [
  [64, "v1.0.0"],
  [65, "v1.2.0"],
  [66, "v1.3.0"],
  [67, "v1.4.0"],
  [68, "v1.5.0"],
] as const) {
  test(`warns about limited features for ${label} storage even with the summary collapsed`, async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByLabel("Choose a DuckDB database file")
      .setInputFiles(databaseFixture(0, false, 200, version));
    await expect(
      page.getByRole("heading", { name: "browser-fixture.duckdb" }),
    ).toBeVisible();
    const warning = page.getByRole("status", {
      name: "Storage compatibility warning",
    });
    await expect(
      page.getByRole("button", { name: "Expand summary" }),
    ).toBeVisible();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(label);
    await expect(warning).toContainText(
      "Not all inspection features are available",
    );
    await expect(warning).toContainText("segment sizes");
    await expect(warning).toContainText("internal free space");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("tab", { name: "Free list", exact: true }).click();
    await expect(warning).toBeVisible();
    await page.getByRole("button", { name: "Expand summary" }).click();
    await expect(warning).toBeVisible();
    // Replacing the file clears this warning; it isn't a sticky app error.
    await page
      .getByLabel("Choose a DuckDB database file")
      .setInputFiles({ ...databaseFixture(), name: "modern.duckdb" });
    await expect(
      page.getByRole("heading", { name: "modern.duckdb" }),
    ).toBeVisible();
    await expect(warning).toHaveCount(0);
  });
}

test("v2.0 storage has no legacy compatibility warning", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "Storage compatibility warning" }),
  ).toHaveCount(0);
  await page
    .getByLabel("Choose a DuckDB database file")
    .setInputFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Storage compatibility warning" }),
  ).toHaveCount(0);
});
