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
  await expect(page.locator("#landing-privacy")).toContainText(
    "never uploaded",
  );

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

for (const theme of ["light", "dark"] as const) {
  test(`mosaic and dark cards are confined to the landing screen (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("atlas-theme", value),
      theme,
    );
    const image = page.waitForResponse((response) =>
      response.url().includes("calm-greek-nature-mosaic"),
    );
    await page.goto("/");
    expect((await image).ok()).toBe(true);
    const shell = page.locator(".app-shell");
    await expect(shell).toHaveClass(/is-landing/);
    await expect(shell).toHaveCSS(
      "background-image",
      /calm-greek-nature-mosaic/,
    );
    await expect(page.locator(".landing-dropzone")).toHaveCSS(
      "border-radius",
      "26px",
    );
    await expect(page.locator(".landing-dropzone")).toHaveCSS(
      "border-style",
      "solid",
    );
    // Keyboard focus has a visible outline, independent of the saved theme.
    await page.locator(".landing-dropzone").focus();
    await expect(page.locator(".landing-dropzone")).toHaveCSS(
      "outline-style",
      "solid",
    );
    await page
      .getByLabel("Choose a DuckDB database file")
      .setInputFiles(databaseFixture());
    await expect(
      page.getByRole("heading", { name: "browser-fixture.duckdb" }),
    ).toBeVisible();
    await expect(shell).not.toHaveClass(/is-landing/);
    await expect(shell).toHaveCSS("background-image", "none");
    await expect(shell).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".landing-card")).toHaveCount(0);
    await expect(page.locator(".brand-lockup > strong")).toHaveCSS(
      "color",
      theme === "light" ? "rgb(32, 32, 36)" : "rgb(237, 237, 240)",
    );
    // A failed replacement must not turn the existing workspace into a landing page.
    await page.getByLabel("Choose a DuckDB database file").setInputFiles({
      name: "bad.duckdb",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("bad"),
    });
    await expect(page.getByRole("alert")).toContainText("truncated");
    await expect(shell).toHaveCSS("background-image", "none");
  });
}

test("landing cards fit a phone without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".landing-dropzone")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate TPC-H", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const upload = (await page.locator(".landing-dropzone").boundingBox())!;
  const generator = (await page.locator(".tpch-generator").boundingBox())!;
  expect(upload.x).toBeGreaterThanOrEqual(0);
  expect(generator.x + generator.width).toBeLessThanOrEqual(390);
  expect(generator.x).toBe(upload.x);
  expect(generator.width).toBe(upload.width);
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
