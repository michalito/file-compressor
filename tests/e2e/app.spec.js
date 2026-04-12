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
  await page.locator('label[for="background-toggle"]').click();

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

test('shows a specific message when processing is rate limited', async ({ page }) => {
  await page.route('**/process', async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.',
        code: 'rate_limit_exceeded',
      }),
    });
  });

  await login(page);
  await uploadFiles(page, makeFiles(1, 'rate-limit'));

  await expect(page.locator('.tile__error')).toContainText(
    'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.'
  );
  await expect(page.locator('.tile__retry-btn')).toBeVisible();
  await expect(page.locator('.toast--warning').filter({
    hasText: 'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.',
  })).toHaveCount(1);
  await expect(page.locator('.toast--warning').filter({
    hasText: 'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.',
  })).toContainText(
    'Rate limit exceeded for image processing. Try again shortly or use Retry Incomplete.'
  );
});

test('closed sidebar is removed from tab order and focus returns to the toggle', async ({ page }) => {
  await login(page);

  const toggle = page.locator('#sidebar-toggle');
  const closeButton = page.locator('#sidebar-close');

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await closeButton.focus();
  await page.keyboard.press('Enter');

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  await page.locator('#theme-toggle').focus();
  await page.keyboard.press('Tab');

  await expect(page.getByRole('link', { name: 'Log out' })).toBeFocused();
  await expect(closeButton).not.toBeFocused();
});

test('mobile sidebar toggles do not overwrite the desktop preference', async ({ page }) => {
  await login(page);

  await page.evaluate(() => {
    localStorage.setItem('compressify_sidebar_open', 'true');
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');

  const toggle = page.locator('#sidebar-toggle');

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    document.querySelector('#sidebar-toggle').click();
  });
  await expect
    .poll(() => page.evaluate(() => document.querySelector('#sidebar-toggle')?.getAttribute('aria-expanded')))
    .toBe('true');

  await page.evaluate(() => {
    document.querySelector('#sidebar-close').click();
  });
  await expect
    .poll(() => page.evaluate(() => document.querySelector('#sidebar-toggle')?.getAttribute('aria-expanded')))
    .toBe('false');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('compressify_sidebar_open')))
    .toBe('true');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('legacy sidebar preference migrates to the new key on desktop load', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('compressify_panel_expanded', 'true');
    localStorage.removeItem('compressify_sidebar_open');
  });

  await login(page);

  const toggle = page.locator('#sidebar-toggle');

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('compressify_panel_expanded')))
    .toBeNull();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('compressify_sidebar_open')))
    .toBe('true');
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.app-layout')?.classList.contains('is-sidebar-transition-disabled')))
    .toBe(false);
});

test('preset aspect ratio unlocks when a resize field is cleared', async ({ page }) => {
  await login(page);

  await page.locator('#resize-mode-control [data-value="custom"]').click();
  await page.getByRole('button', { name: 'Full HD' }).click();

  const widthInput = page.locator('#custom-width');
  const heightInput = page.locator('#custom-height');

  await widthInput.fill('1000');
  await expect(heightInput).toHaveValue('563');

  await heightInput.fill('');
  await heightInput.type('500');
  await expect(widthInput).toHaveValue('1000');
});

test('desktop overflow scroll stays inside the content column when the sidebar is open', async ({ page }) => {
  await login(page);
  await uploadFiles(page, makeFiles(18, 'overflow'));
  await expect(page.locator('.tile')).toHaveCount(18);

  const metrics = await page.evaluate(() => {
    const main = document.querySelector('#main-content');
    const content = document.querySelector('.app-layout__content');
    const sidebar = document.querySelector('#settings-sidebar');
    const header = document.querySelector('.header');
    if (!main || !content || !sidebar || !header) return null;

    content.scrollTop = 240;

    return {
      mainOverflowY: getComputedStyle(main).overflowY,
      contentOverflowY: getComputedStyle(content).overflowY,
      mainScrollTop: main.scrollTop,
      contentScrollTop: content.scrollTop,
      contentScrollHeight: content.scrollHeight,
      contentClientHeight: content.clientHeight,
      contentRight: Math.round(content.getBoundingClientRect().right),
      sidebarLeft: Math.round(sidebar.getBoundingClientRect().left),
      headerBottom: Math.round(header.getBoundingClientRect().bottom),
      sidebarTop: Math.round(sidebar.getBoundingClientRect().top),
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics.mainOverflowY).toBe('hidden');
  expect(metrics.contentOverflowY).toBe('auto');
  expect(metrics.contentScrollHeight).toBeGreaterThan(metrics.contentClientHeight);
  expect(metrics.contentScrollTop).toBeGreaterThan(0);
  expect(metrics.mainScrollTop).toBe(0);
  expect(metrics.contentRight).toBeLessThanOrEqual(metrics.sidebarLeft);
  expect(metrics.sidebarTop).toBe(metrics.headerBottom);
});

test('sidebar keeps a visible thin scrollbar when settings overflow', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.locator('label[for="watermark-toggle"]').click();

  const scrollbar = await page.evaluate(() => {
    const body = document.querySelector('#settings-body');
    const content = document.querySelector('.app-layout__content');
    const rules = [];

    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText === '.sidebar__body') rules.push(rule.cssText);
          if (rule.selectorText === '.app-layout__content') rules.push(rule.cssText);
          if (rule.selectorText === '.sidebar__body::-webkit-scrollbar') rules.push(rule.cssText);
        }
      } catch {
        // Ignore stylesheets that do not expose cssRules.
      }
    }

    return {
      clientHeight: body?.clientHeight ?? 0,
      scrollHeight: body?.scrollHeight ?? 0,
      contentOverflowY: content ? getComputedStyle(content).overflowY : '',
      cssText: rules.join('\n'),
    };
  });

  expect(scrollbar.scrollHeight).toBeGreaterThan(scrollbar.clientHeight);
  expect(scrollbar.contentOverflowY).toBe('auto');
  expect(scrollbar.cssText).toContain('scrollbar-width: thin');
  expect(scrollbar.cssText).toContain('scrollbar-color: var(--color-border) transparent');
  expect(scrollbar.cssText).toContain('width: 8px');
  expect(scrollbar.cssText).not.toContain('display: none');
});

test('mobile sidebar layers stay below modal layers', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const zIndex = await page.evaluate(() => {
    const sidebar = document.querySelector('#settings-sidebar');
    const backdrop = document.querySelector('#sidebar-backdrop');
    const modal = document.querySelector('#crop-modal');
    const modalContent = modal?.querySelector('.modal__content');

    return {
      sidebar: Number(getComputedStyle(sidebar).zIndex),
      backdrop: Number(getComputedStyle(backdrop).zIndex),
      modal: Number(getComputedStyle(modal).zIndex),
      modalContent: Number(getComputedStyle(modalContent).zIndex),
    };
  });

  expect(zIndex.backdrop).toBeLessThan(zIndex.modal);
  expect(zIndex.sidebar).toBeLessThan(zIndex.modalContent);
});
