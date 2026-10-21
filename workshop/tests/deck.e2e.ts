import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page, path = '/') {
  await page.goto(path);
  await page.waitForFunction(() => (window as any).workshopDeck?.isReady());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
}

test('bundled deck has local assets, all slides, notes, and no page errors', async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  const failed: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:5184') external.push(request.url());
  });
  page.on('response', response => { if (response.status() >= 400) failed.push(response.url()); });
  await ready(page);
  const slides = page.locator('.slides > section');
  await expect(slides).toHaveCount(49);
  expect(await slides.evaluateAll(nodes => nodes.every(node =>
    node.id && (node.querySelector('aside.notes')?.textContent?.length ?? 0) > 100,
  ))).toBe(true);
  expect(new Set(await slides.evaluateAll(nodes => nodes.map(node => node.id))).size).toBe(49);
  await expect(page.locator('.present h1')).toHaveText('Inside a DuckDB file');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.present h1')).toHaveCSS('color', 'rgb(13, 13, 13)');
  await expect(page.locator('#title')).toHaveCSS('background-image', /linear-gradient/);
  await expect(page.locator('section.chapter-slide')).toHaveCount(6);
  await expect(page.locator('.slide-footer')).toHaveCount(48);
  expect(await page.locator('img').evaluateAll(images => images.every(image =>
    (image as HTMLImageElement).naturalWidth > 0,
  ))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('25px "JetBrains Mono"'))).toBe(true);
  const licenseUrl = await page.locator('link[rel="license"]').getAttribute('href');
  const license = await page.request.get(new URL(licenseUrl!, page.url()).href);
  expect(license.ok()).toBe(true);
  expect(await license.text()).toContain('SIL OPEN FONT LICENSE');
  // Notes must not leak into audience content.
  await expect(page.locator('#title aside.notes')).toBeHidden();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  expect(failed).toEqual([]);
});

test('keyboard navigation, stable deep links, overview, highlighted SQL', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/puzzle$/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.reveal')).toHaveClass(/overview/);
  await page.keyboard.press('Escape');
  await ready(page, '/#/sql-tools');
  await expect(page.locator('.present h2')).toHaveText('Ask the engine first');
  await expect(page.locator('#sql-tools code .hljs-keyword').first()).toBeVisible();
  await expect(page.locator('#sql-tools code .hljs-keyword').first()).toHaveCSS('color', 'rgb(112, 190, 255)');
  await page.reload();
  await expect(page.locator('section.present')).toHaveAttribute('id', 'sql-tools');
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 720 }]) {
  test(`all audience content fits at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await ready(page);
    const overflow = await page.evaluate(async () => {
      const deck = (window as any).workshopDeck;
      const failures: string[] = [];
      for (let i = 0; i < deck.getTotalSlides(); i++) {
        deck.slide(i);
        deck.layout();
        await new Promise(requestAnimationFrame);
        const slide = deck.getCurrentSlide() as HTMLElement;
        const bounds = slide.getBoundingClientRect();
        const source = slide.querySelector('.source')?.getBoundingClientRect();
        const footer = slide.querySelector('.slide-footer')?.getBoundingClientRect();
        const contentEnd = source?.top ?? (footer ? footer.top - 20 * deck.getScale() : bounds.bottom);
        for (const child of Array.from(slide.children) as HTMLElement[]) {
          if (child.matches('aside.notes, script, style') || !child.getClientRects().length) continue;
          const rect = child.getBoundingClientRect();
          if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight - 18) {
            failures.push(`${slide.id}: ${child.tagName} outside viewport (${JSON.stringify(rect.toJSON())})`);
          }
          if (!child.matches('.source, .slide-footer') && rect.bottom > contentEnd + 1) {
            failures.push(`${slide.id}: ${child.tagName} overlaps source/footer area`);
          }
          if (child.scrollWidth > child.clientWidth + 2) failures.push(`${slide.id}: horizontal content overflow`);
        }
        if (bounds.height > 900 * deck.getScale() + 2) failures.push(`${slide.id}: exceeds design height`);
      }
      return failures;
    });
    expect(overflow).toEqual([]);
  });
}

test('speaker popup opens with notes', async ({ page }) => {
  await ready(page);
  const popupPromise = page.waitForEvent('popup');
  await page.keyboard.press('s');
  const popup = await popupPromise;
  await expect(popup.locator('.speaker-controls-notes .value')).toContainText('Welcome.', { timeout: 15000 });
  await popup.close();
});

test('print mode has one audience slide per page', async ({ page }) => {
  await ready(page, '/?print-pdf');
  await expect(page.locator('.pdf-page')).toHaveCount(49);
  await expect(page.locator('.pdf-page .slide-footer')).toHaveCount(48);
  await expect(page.locator('html')).toHaveClass(/print-pdf/);
  await expect(page.locator('#title aside.notes')).toBeHidden();
});
