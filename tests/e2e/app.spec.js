const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const fixturePath = path.join(__dirname, 'fixtures', 'test-image.png');
const fixtureBuffer = fs.readFileSync(fixturePath);

function makeFiles(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index + 1}.png`,
    mimeType: 'image/png',
    buffer: fixtureBuffer,
  }));
}

async function login(page) {
  await page.goto('/login');
  await page.locator('#password').fill('test-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
}

async function uploadFiles(page, files) {
  await page.locator('#file-input').setInputFiles(files);
}

async function waitForDoneCount(page, count) {
  await expect(page.locator('.tile.is-done')).toHaveCount(count, { timeout: 30_000 });
}

test('redirects to login on session expiry during API actions', async ({ page, context }) => {
  await login(page);
  await uploadFiles(page, makeFiles(1, 'session'));
  await waitForDoneCount(page, 1);

  await context.clearCookies();
  await page.locator('.tile__download-btn').click();

  await expect(page).toHaveURL(/\/login$/);
});

test('reloads the app when an authenticated request hits an expired CSRF token', async ({ page }) => {
  await login(page);
  await uploadFiles(page, makeFiles(1, 'csrf'));
  await waitForDoneCount(page, 1);

  await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) {
      meta.setAttribute('content', 'stale-token');
    }
  });

  await page.locator('.tile__download-btn').click();
  await page.waitForLoadState('networkidle');

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(page.locator('.tile')).toHaveCount(0);
});

test('queues files added during an active batch instead of leaving them pending', async ({ page }) => {
  await login(page);

  await page.route('**/process', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });

  await uploadFiles(page, makeFiles(6, 'initial'));
  await expect(page.locator('#batch-progress')).toBeVisible();
  await expect(page.locator('.tile')).toHaveCount(6);

  await uploadFiles(page, makeFiles(2, 'later'));
  await expect(page.locator('.tile')).toHaveCount(8);
  await waitForDoneCount(page, 8);

  await expect(page.locator('.badge--cancelled')).toHaveCount(0);
});

test('cancel marks incomplete work as cancelled and retry completes it', async ({ page }) => {
  await login(page);

  await page.route('**/process', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });

  await uploadFiles(page, makeFiles(7, 'cancel'));
  await expect(page.locator('#batch-progress')).toBeVisible();
  await page.locator('#cancel-batch').click();

  await expect(page.locator('.badge--cancelled').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Retry Incomplete' })).toBeVisible();

  await page.getByRole('button', { name: 'Retry Incomplete' }).click();
  await waitForDoneCount(page, 7);
});

test('keeps crop dimensions stable after viewport resize', async ({ page }) => {
  await login(page);
  await uploadFiles(page, makeFiles(1, 'crop'));
  await waitForDoneCount(page, 1);

  await page.locator('.tile__crop-btn').click();
  await expect(page.locator('#crop-modal')).toBeVisible();
  await page.getByRole('radio', { name: '1:1' }).check();
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.locator('.tile__final-dimensions')).toHaveText('300 x 300');
});

test('downloads ZIP files without any CDN dependency', async ({ page }) => {
  await page.route('https://cdnjs.cloudflare.com/**', async (route) => {
    await route.abort();
  });

  await login(page);
  await uploadFiles(page, makeFiles(2, 'zip'));
  await waitForDoneCount(page, 2);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download All' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('processed_images.zip');
});

test('background removal locks compression controls and sends the flag', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        compressed_data: fixtureBuffer.toString('base64'),
        filename: 'subject.png',
        warnings: [],
        metadata: {
          original_size: fixtureBuffer.length,
          compressed_size: fixtureBuffer.length,
          original_dimensions: [300, 300],
          final_dimensions: [300, 300],
          compression_ratio: 100,
          format: 'PNG',
          original_format: 'PNG',
          background_removed: true,
          watermarked: false,
          encoding: 'base64',
        },
      }),
    });
  });

  await login(page);
  await page.locator('#background-toggle').check({ force: true });

  await expect(page.locator('#compression-mode-control [data-value="lossless"]')).toBeDisabled();
  await expect(page.locator('#format-control [data-value="png"]')).toBeDisabled();
  await expect(page.locator('#quality-slider-group')).toHaveClass(/is-hidden/);

  await uploadFiles(page, makeFiles(1, 'bg'));
  await waitForDoneCount(page, 1);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="remove_background"');
  expect(capturedRequests[0]).toContain('\r\n\r\n1\r\n');

  await expect(page.locator('.tile__final-format')).toHaveText('PNG');
  await expect(page.locator('.tile__status-badges')).toContainText('BG removed');
});
