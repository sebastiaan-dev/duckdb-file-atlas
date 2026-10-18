import { expect, test } from "@playwright/test";
import { databaseFixture } from "./fixture";

test("the first screen is a file picker, not example data", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Inspect a DuckDB database file" }),
  ).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveCount(
    0,
  );
  await expect(page.getByText(/never uploaded/)).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Drop a \.duckdb file here/ }).click();
  await (await chooser).setFiles(databaseFixture());
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Physical map" })).toBeVisible();
});

test("dropping a file on the landing area opens it", async ({ page }) => {
  await page.goto("/");
  const { buffer, name } = databaseFixture();
  const transfer = await page.evaluateHandle(
    ({ bytes, name }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], name));
      return data;
    },
    { bytes: [...buffer], name },
  );
  const zone = page.locator(".landing-dropzone");
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(page.getByText("Drop to inspect")).toBeVisible();
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page.getByRole("heading", { name: "browser-fixture.duckdb" }),
  ).toBeVisible();
});

test("an unreadable file shows the error on the landing screen", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Choose a DuckDB database file").setInputFiles({
    name: "not-a-database.duckdb",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByRole("alert")).toContainText(/truncated/);
  await expect(
    page.getByRole("heading", { name: "Inspect a DuckDB database file" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
