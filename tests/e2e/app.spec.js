const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const fixturePath = path.join(__dirname, 'fixtures', 'test-image.png');
const fixtureBuffer = fs.readFileSync(fixturePath);
const tiffFixturePath = path.join(__dirname, 'fixtures', 'test-image.tiff');
const tiffFixtureBuffer = fs.readFileSync(tiffFixturePath);

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

function makePngUpload(name, { buffer = fixtureBuffer, lastModified = Date.now() } = {}) {
  return {
    name,
    mimeType: 'image/png',
    buffer,
    lastModified,
  };
}

async function enableWatermark(page) {
  await page.locator('label[for="watermark-toggle"]').click();
}

async function enableResize(page) {
  await page.locator('label[for="resize-toggle"]').click();
}

async function enableAIUpscale(page) {
  await page.locator('#workflow-control [data-value="ai-upscale"]').click();
}

async function openWatermarkTab(page, layer) {
  await page.locator(`#watermark-tab-${layer}`).click();
}

async function setRangeValue(page, selector, value) {
  await page.locator(selector).evaluate((input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function mockProcessResponse({
  filename = 'processed.png',
  format = 'PNG',
  watermarked = false,
  watermarkLayers = [],
  backgroundRemoved = false,
  resize = {
    mode: 'original',
    requested_width: null,
    requested_height: null,
    active: false,
    changed: false,
    upscaled: false,
    strategy: 'fit_within_bounds',
  },
} = {}) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      compressed_data: fixtureBuffer.toString('base64'),
      filename,
      warnings: [],
      metadata: {
        original_size: fixtureBuffer.length,
        compressed_size: fixtureBuffer.length,
        original_dimensions: [300, 300],
        final_dimensions: [300, 300],
        compression_ratio: 100,
        format,
        original_format: 'PNG',
        resize,
        background_removed: backgroundRemoved,
        watermarked,
        watermark_layers: watermarkLayers,
        encoding: 'base64',
      },
    }),
  };
}

function makeAIUpscaleJobResult({
  jobId = 'job-1',
  filename = 'upscaled.png',
  modelPreset = 'photo',
  scale = 2,
  format = 'PNG',
  originalDimensions = [300, 300],
  finalDimensions = [originalDimensions[0] * scale, originalDimensions[1] * scale],
  warnings = [],
  workerInstanceId = 'worker-a',
} = {}) {
  const resolvedFormat = String(format).toUpperCase();
  return {
    job_id: jobId,
    status: 'done',
    phase: 'done',
    progress: 100,
    queue_position: null,
    worker_instance_id: workerInstanceId,
    result: {
      filename,
      warnings,
      metadata: {
        original_size: fixtureBuffer.length,
        compressed_size: fixtureBuffer.length + (scale === 4 ? 256 : 128),
        original_dimensions: originalDimensions,
        final_dimensions: finalDimensions,
        compression_ratio: 100,
        format: resolvedFormat,
        original_format: 'PNG',
        workflow: 'ai-upscale',
        upscale: {
          model_preset: modelPreset,
          model_name: modelPreset === 'anime'
            ? 'RealESRGAN_x4plus_anime_6B'
            : (scale === 2 ? 'RealESRGAN_x2plus' : 'RealESRGAN_x4plus'),
          backend_model_name: modelPreset === 'anime'
            ? 'RealESRGAN_x4plus_anime_6B'
            : (scale === 2 ? 'RealESRGAN_x2plus' : 'RealESRGAN_x4plus'),
          requested_scale: scale,
          native_scale: modelPreset === 'anime' ? 4 : scale,
          downscaled_from_native: modelPreset === 'anime' ? scale !== 4 : false,
        },
      },
      artifacts: {
        preview: {
          artifact_id: `${jobId}-preview`,
          filename: `${jobId}-preview.png`,
        },
        download: {
          artifact_id: `${jobId}-download`,
          filename,
        },
      },
    },
  };
}

async function mockAIUpscaleService(page, {
  health = {
    enabled: true,
    healthy: true,
    state: 'ready',
    backend: 'torch-cpu',
    worker_instance_id: 'worker-a',
    started_at: '2026-04-13T10:00:00+00:00',
    reason: 'AI upscaling service ready',
    details: { cached_models: [], cpu_threads: 4 },
  },
  jobs = [],
  previewBuffer = fixtureBuffer,
  downloadArtifactBuffer = fixtureBuffer,
  downloadAllBody = Buffer.from('zipdata'),
} = {}) {
  const state = {
    healthCount: 0,
    createBodies: [],
    createCount: 0,
    pollCounts: new Map(),
    cancelledJobIds: [],
    deletedJobIds: [],
    deletedJobHeaders: [],
    previewArtifactIds: [],
    downloadArtifactIds: [],
    downloadAllBodies: [],
  };
  const jobConfigs = new Map();

  await page.route('**/ai-upscale/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (pathname === '/ai-upscale/health') {
      state.healthCount += 1;
      const { httpStatus = 200, ...body } = health;
      await route.fulfill({
        status: httpStatus,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
      return;
    }

    if (pathname === '/ai-upscale/jobs' && method === 'POST') {
      const nextIndex = state.createCount;
      const config = jobs[nextIndex] || {};
      const jobId = config.id || `job-${nextIndex + 1}`;
      state.createCount += 1;
      state.createBodies.push(request.postData() || '');
      const createStatus = config.createHttpStatus || 202;

      if (createStatus >= 400) {
        await route.fulfill({
          status: createStatus,
          contentType: 'application/json',
          body: JSON.stringify({
            error: config.createError || `AI upscale create failed (${createStatus})`,
            ...(config.createResponse || {}),
          }),
        });
        return;
      }

      jobConfigs.set(jobId, {
        ...config,
        sequence: config.sequence || [
          { job_id: jobId, status: 'processing' },
          makeAIUpscaleJobResult({ jobId, ...(config.result || {}) }),
        ],
      });

      await route.fulfill({
        status: createStatus,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: jobId,
          status: config.initialStatus || 'queued',
          phase: config.initialPhase || 'queued',
          progress: config.initialProgress || 0,
          queue_position: config.initialQueuePosition || 1,
          worker_instance_id: health.worker_instance_id || 'worker-a',
          ...(config.createResponse || {}),
        }),
      });
      return;
    }

    const cancelMatch = pathname.match(/^\/ai-upscale\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const [, jobId] = cancelMatch;
      state.cancelledJobIds.push(jobId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ job_id: jobId, status: 'cancelled' }),
      });
      return;
    }

    const jobMatch = pathname.match(/^\/ai-upscale\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const [, jobId] = jobMatch;

      if (method === 'DELETE') {
        state.deletedJobIds.push(jobId);
        state.deletedJobHeaders.push(request.headers());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ job_id: jobId, status: 'deleted' }),
        });
        return;
      }

      if (method === 'GET') {
        const config = jobConfigs.get(jobId) || {
          sequence: [makeAIUpscaleJobResult({ jobId })],
        };
        const pollCount = state.pollCounts.get(jobId) || 0;
        state.pollCounts.set(jobId, pollCount + 1);
        const sequence = config.sequence || [];
        const payload = sequence[Math.min(pollCount, Math.max(sequence.length - 1, 0))];
        const status = payload?.httpStatus || 200;
        const { httpStatus, ...body } = payload || makeAIUpscaleJobResult({ jobId });
        void httpStatus;

        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
        return;
      }
    }

    const previewMatch = pathname.match(/^\/ai-upscale\/artifacts\/([^/]+)\/preview$/);
    if (previewMatch && method === 'GET') {
      state.previewArtifactIds.push(previewMatch[1]);
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: previewBuffer,
      });
      return;
    }

    const downloadMatch = pathname.match(/^\/ai-upscale\/artifacts\/([^/]+)\/download$/);
    if (downloadMatch && method === 'GET') {
      state.downloadArtifactIds.push(downloadMatch[1]);
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: downloadArtifactBuffer,
      });
      return;
    }

    if (pathname === '/ai-upscale/download-all' && method === 'POST') {
      state.downloadAllBodies.push(request.postData() || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/zip',
        body: downloadAllBody,
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unhandled AI upscaling route: ${method} ${pathname}` }),
    });
  });

  return state;
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

test('logo watermark preview renders and request includes the uploaded logo', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'watermarked.png',
      watermarked: true,
      watermarkLayers: ['logo'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await openWatermarkTab(page, 'logo');
  await page.locator('#watermark-logo-file').setInputFiles(makePngUpload('brand.png'));
  await page.locator('#watermark-logo-position-control [data-value="tiled"]').click();
  await setRangeValue(page, '#watermark-logo-density-slider', 8);

  await expect(page.locator('#watermark-tab-logo-status')).toHaveText('Ready');

  await uploadFiles(page, makeFiles(1, 'logo-preview'));
  await waitForDoneCount(page, 1);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="watermark_logo"');
  expect(capturedRequests[0]).toContain('filename="brand.png"');
  expect(capturedRequests[0]).toContain('name="watermark_logo_position"');
  expect(capturedRequests[0]).toContain('\r\n\r\ntiled\r\n');
  expect(capturedRequests[0]).toContain('name="watermark_logo_tile_density"');
  expect(capturedRequests[0]).toContain('\r\n\r\n8\r\n');

  await expect(page.locator('#watermark-preview-source-name')).toHaveText('logo-preview-1.png');
  await expect(page.locator('#watermark-preview-state')).toHaveClass(/is-hidden/);
});

test('tab status chips update and controls persist when switching tabs', async ({ page }) => {
  await login(page);
  await enableWatermark(page);

  await page.locator('#watermark-text').fill('Status');
  await expect(page.locator('#watermark-tab-text-status')).toHaveText('Ready');

  await openWatermarkTab(page, 'logo');
  await page.locator('#watermark-logo-file').setInputFiles(makePngUpload('status-logo.png'));
  await expect(page.locator('#watermark-tab-logo-status')).toHaveText('Ready');

  await openWatermarkTab(page, 'qr');
  await page.locator('#watermark-qr-url').fill('not-a-url');
  await expect(page.locator('#watermark-tab-qr-status')).toHaveText('Invalid');
  await expect(page.locator('#watermark-qr-error')).toContainText('Use an absolute http:// or https:// URL.');

  await openWatermarkTab(page, 'text');
  await expect(page.locator('#watermark-text')).toHaveValue('Status');

  await openWatermarkTab(page, 'logo');
  await expect(page.locator('#watermark-logo-filename')).toHaveText('status-logo.png');
});

test('multiple watermark layers send independent text and logo transforms', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'stacked.png',
      watermarked: true,
      watermarkLayers: ['text', 'logo'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Stacked');
  await page.locator('#watermark-text-position-control [data-value="bottom-left"]').click();
  await setRangeValue(page, '#watermark-text-angle-slider', 15);

  await openWatermarkTab(page, 'logo');
  await page.locator('#watermark-logo-file').setInputFiles(makePngUpload('stacked-logo.png'));
  await page.locator('#watermark-logo-position-control [data-value="top-right"]').click();
  await setRangeValue(page, '#watermark-logo-opacity-slider', 80);

  await uploadFiles(page, makeFiles(1, 'stacked'));
  await waitForDoneCount(page, 1);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="watermark_text"');
  expect(capturedRequests[0]).toContain('Stacked');
  expect(capturedRequests[0]).toContain('name="watermark_text_position"');
  expect(capturedRequests[0]).toContain('\r\n\r\nbottom-left\r\n');
  expect(capturedRequests[0]).toContain('name="watermark_text_angle"');
  expect(capturedRequests[0]).toContain('\r\n\r\n15\r\n');
  expect(capturedRequests[0]).toContain('name="watermark_logo"');
  expect(capturedRequests[0]).toContain('filename="stacked-logo.png"');
  expect(capturedRequests[0]).toContain('name="watermark_logo_position"');
  expect(capturedRequests[0]).toContain('\r\n\r\ntop-right\r\n');
  expect(capturedRequests[0]).toContain('name="watermark_logo_opacity"');
  expect(capturedRequests[0]).toContain('\r\n\r\n80\r\n');
});

test('qr watermark validates URLs and sends generated png data with per-layer transforms', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'qr.png',
      watermarked: true,
      watermarkLayers: ['qr'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await openWatermarkTab(page, 'qr');

  const qrInput = page.locator('#watermark-qr-url');
  await qrInput.fill('not-a-url');
  await expect(page.locator('#watermark-qr-error')).toContainText('Use an absolute http:// or https:// URL.');
  await expect(page.locator('#watermark-tab-qr-status')).toHaveText('Invalid');

  await qrInput.fill('https://example.com/watermark');
  await expect(page.locator('#watermark-qr-error')).toHaveClass(/is-hidden/);
  await expect(page.locator('#watermark-tab-qr-status')).toHaveText('Ready');

  await page.locator('#watermark-qr-position-control [data-value="tiled"]').click();
  await setRangeValue(page, '#watermark-qr-density-slider', 7);

  await uploadFiles(page, makeFiles(1, 'qr'));
  await waitForDoneCount(page, 1);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="watermark_qr_url"');
  expect(capturedRequests[0]).toContain('https://example.com/watermark');
  expect(capturedRequests[0]).toContain('name="watermark_qr_image"');
  expect(capturedRequests[0]).toContain('filename="watermark-qr.png"');
  expect(capturedRequests[0]).toContain('name="watermark_qr_position"');
  expect(capturedRequests[0]).toContain('\r\n\r\ntiled\r\n');
  expect(capturedRequests[0]).toContain('name="watermark_qr_tile_density"');
  expect(capturedRequests[0]).toContain('\r\n\r\n7\r\n');
});

test('changing text layer controls updates the preview canvas without processing', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'preview.png',
      watermarked: true,
      watermarkLayers: ['text'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Preview');
  await uploadFiles(page, makeFiles(1, 'preview'));
  await waitForDoneCount(page, 1);

  const before = await page.locator('#watermark-preview-canvas').evaluate((canvas) => canvas.toDataURL());
  await setRangeValue(page, '#watermark-text-opacity-slider', 85);

  await expect.poll(
    () => page.locator('#watermark-preview-canvas').evaluate(
      (canvas, previousDataUrl) => canvas.toDataURL() === previousDataUrl,
      before,
    ),
  ).toBe(false);
  expect(capturedRequests).toHaveLength(1);
});

test('pending watermark slider edits flush before processing starts', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'flush-watermark.png',
      watermarked: true,
      watermarkLayers: ['text'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Immediate');
  await page.locator('#watermark-text-opacity-slider').evaluate((input) => {
    input.value = '85';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await uploadFiles(page, makeFiles(1, 'flush-watermark'));
  await waitForDoneCount(page, 1);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="watermark_text_opacity"');
  expect(capturedRequests[0]).toContain('\r\n\r\n85\r\n');
});

test('text-only transform changes do not add logo or qr request fields', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'text-only.png',
      watermarked: true,
      watermarkLayers: ['text'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Only Text');
  await page.locator('#watermark-text-position-control [data-value="top-left"]').click();
  await setRangeValue(page, '#watermark-text-size-slider', 9);

  await uploadFiles(page, makeFiles(1, 'text-only'));
  await waitForDoneCount(page, 1);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="watermark_text_position"');
  expect(capturedRequests[0]).not.toContain('name="watermark_logo"');
  expect(capturedRequests[0]).not.toContain('name="watermark_logo_position"');
  expect(capturedRequests[0]).not.toContain('name="watermark_qr_url"');
  expect(capturedRequests[0]).not.toContain('name="watermark_qr_position"');
});

test('changing the logo file after processing exposes re-process', async ({ page }) => {
  await page.route('**/process', async (route) => {
    await route.fulfill(mockProcessResponse({
      filename: 'reprocess.png',
      watermarked: true,
      watermarkLayers: ['logo'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await openWatermarkTab(page, 'logo');
  await page.locator('#watermark-logo-file').setInputFiles(makePngUpload('logo-a.png', { lastModified: 1 }));
  await uploadFiles(page, makeFiles(1, 'reprocess'));
  await waitForDoneCount(page, 1);

  await expect(page.getByRole('button', { name: 'Re-process' })).toBeHidden();

  await page.locator('#watermark-logo-file').setInputFiles(makePngUpload('logo-b.png', { lastModified: 2 }));
  await expect(page.getByRole('button', { name: 'Re-process' })).toBeVisible();
});

test('preview keeps rendering valid layers when another enabled layer is invalid', async ({ page }) => {
  const capturedRequests = [];

  await page.route('**/process', async (route) => {
    capturedRequests.push(route.request().postData() || '');
    await route.fulfill(mockProcessResponse({
      filename: 'mixed.png',
      watermarked: true,
      watermarkLayers: ['text'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Valid');
  await openWatermarkTab(page, 'qr');
  await page.locator('#watermark-qr-url').fill('not-a-url');
  await uploadFiles(page, makeFiles(1, 'mixed'));
  await waitForDoneCount(page, 1);

  await expect(page.locator('#watermark-qr-error')).toContainText('Use an absolute http:// or https:// URL.');
  await expect(page.locator('#watermark-preview-state')).toHaveClass(/is-hidden/);

  expect(capturedRequests).toHaveLength(1);
  expect(capturedRequests[0]).toContain('name="watermark_text"');
  expect(capturedRequests[0]).not.toContain('name="watermark_qr_url"');
  expect(capturedRequests[0]).not.toContain('name="watermark_qr_image"');
});

test('clicking a tile changes the watermark preview source', async ({ page }) => {
  await page.route('**/process', async (route) => {
    await route.fulfill(mockProcessResponse({
      filename: 'source.png',
      watermarked: true,
      watermarkLayers: ['text'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Source');
  await uploadFiles(page, makeFiles(2, 'source'));
  await waitForDoneCount(page, 2);

  await expect(page.locator('#watermark-preview-source-name')).toHaveText('source-1.png');
  await page.locator('.tile__preview').nth(1).click();
  await expect(page.locator('#watermark-preview-source-name')).toHaveText('source-2.png');
});

test('unsupported browser preview formats show a fallback message', async ({ page }) => {
  await page.route('**/process', async (route) => {
    await route.fulfill(mockProcessResponse({
      filename: 'unsupported.png',
      watermarked: true,
      watermarkLayers: ['text'],
    }));
  });

  await login(page);
  await enableWatermark(page);
  await page.locator('#watermark-text').fill('Fallback');
  await uploadFiles(page, [{
    name: 'unsupported.tiff',
    mimeType: 'image/tiff',
    buffer: tiffFixtureBuffer,
  }]);

  await expect(page.locator('#watermark-preview-state')).toContainText(
    'This format can\'t render in your browser.'
  );
});

test('legacy shared watermark settings migrate into per-layer tabs', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('compressify_settings', JSON.stringify({
      compress: { mode: 'lossless', outputFormat: 'auto', quality: null },
      resize: { mode: 'original', width: null, height: null },
      background: { enabled: false },
      watermark: {
        enabled: true,
        text: 'Legacy',
        color: 'black',
        position: 'top-left',
        opacity: 65,
        size: 9,
        angle: 20,
        tileDensity: 7,
      },
    }));
  });

  await login(page);

  await expect(page.locator('#watermark-toggle')).toBeChecked();
  await expect(page.locator('#watermark-text')).toHaveValue('Legacy');
  await expect(page.locator('#watermark-tab-text-status')).toHaveText('Ready');

  await expect(page.locator('#watermark-text-position-control [data-value="top-left"]')).toHaveClass(/is-selected/);
  await expect(page.locator('#watermark-text-opacity-slider')).toHaveValue('65');
  await expect(page.locator('#watermark-text-size-slider')).toHaveValue('9');
  await expect(page.locator('#watermark-text-angle-slider')).toHaveValue('20');

  await openWatermarkTab(page, 'logo');
  await expect(page.locator('#watermark-logo-position-control [data-value="top-left"]')).toHaveClass(/is-selected/);
  await expect(page.locator('#watermark-logo-opacity-slider')).toHaveValue('65');
  await expect(page.locator('#watermark-logo-size-slider')).toHaveValue('9');
  await expect(page.locator('#watermark-logo-angle-slider')).toHaveValue('20');

  await openWatermarkTab(page, 'qr');
  await expect(page.locator('#watermark-qr-position-control [data-value="top-left"]')).toHaveClass(/is-selected/);
  await expect(page.locator('#watermark-qr-opacity-slider')).toHaveValue('65');
  await expect(page.locator('#watermark-qr-size-slider')).toHaveValue('9');
  await expect(page.locator('#watermark-qr-angle-slider')).toHaveValue('20');
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

test('preset aspect ratio persists when a resize field is cleared and refilled', async ({ page }) => {
  await login(page);

  await enableResize(page);
  await page.getByRole('button', { name: 'Full HD' }).click();

  const widthInput = page.locator('#custom-width');
  const heightInput = page.locator('#custom-height');

  // Ratio is locked at 16:9 from the Full HD preset
  await widthInput.fill('1000');
  await expect(heightInput).toHaveValue('563');

  // Clearing and retyping height keeps ratio locked — width recalculates
  await heightInput.fill('');
  await heightInput.type('500');
  await expect(widthInput).toHaveValue('889');
});

test('4K preset populates resize bounds and keeps aspect ratio locked', async ({ page }) => {
  await login(page);

  await enableResize(page);
  await page.getByRole('button', { name: '4K' }).click();

  await expect(page.locator('#custom-width')).toHaveValue('3840');
  await expect(page.locator('#custom-height')).toHaveValue('2160');
  await expect(page.locator('#aspect-ratio-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('resize presets upscale smaller images within bounds and show the correct badge', async ({ page }) => {
  await login(page);

  await enableResize(page);
  await page.getByRole('button', { name: 'Full HD' }).click();
  await uploadFiles(page, makeFiles(1, 'upscale'));
  await waitForDoneCount(page, 1);

  await expect(page.locator('.tile__final-dimensions')).toHaveText('1440 x 1080');
  await expect(page.locator('.tile__status-badges')).toContainText('Upscaled');
});

test('resize summary reflects width-only and height-only bounds', async ({ page }) => {
  await login(page);

  await enableResize(page);
  const widthInput = page.locator('#custom-width');
  const heightInput = page.locator('#custom-height');

  await widthInput.fill('1200');
  await expect(page.locator('#settings-summary')).toContainText('Fit width 1200px');

  await widthInput.fill('');
  await heightInput.fill('900');
  await expect(page.locator('#settings-summary')).toContainText('Fit height 900px');
});

test('clicking static setting rows toggles them without using the switch', async ({ page }) => {
  await login(page);

  const resizeTitle = page.locator('[data-section="resize"] .sidebar__section-title');
  await resizeTitle.click();
  await expect(page.locator('#resize-toggle')).toBeChecked();
  await expect(page.locator('#custom-size-section')).toHaveAttribute('aria-hidden', 'false');
  await resizeTitle.click();
  await expect(page.locator('#resize-toggle')).not.toBeChecked();
  await expect(page.locator('#custom-size-section')).toHaveAttribute('aria-hidden', 'true');

  const backgroundTitle = page.locator('[data-section="background"] .sidebar__section-title');
  await backgroundTitle.click();
  await expect(page.locator('#background-toggle')).toBeChecked();
  await backgroundTitle.click();
  await expect(page.locator('#background-toggle')).not.toBeChecked();

  const watermarkTitle = page.locator('[data-section="watermark"] .sidebar__section-title');
  await watermarkTitle.click();
  await expect(page.locator('#watermark-toggle')).toBeChecked();
  await watermarkTitle.click();
  await expect(page.locator('#watermark-toggle')).not.toBeChecked();
});

test('invalid resize input blocks auto-processing until fixed', async ({ page }) => {
  let processRequests = 0;
  await page.route('**/process', async (route) => {
    processRequests += 1;
    await route.continue();
  });

  await login(page);
  await enableResize(page);
  await page.locator('#custom-width').fill('400.5');

  await expect(page.locator('#resize-error')).toContainText('whole-number width');

  await uploadFiles(page, makeFiles(1, 'invalid-resize'));
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect.poll(() => processRequests).toBe(0);
  await expect(page.locator('.toast--warning').filter({
    hasText: 'whole-number width',
  })).toHaveCount(1);

  await page.locator('#custom-width').fill('400');
  await waitForDoneCount(page, 1);
  await expect.poll(() => processRequests).toBe(1);
});

test('toggle off and on restores the last valid custom resize and lock state', async ({ page }) => {
  await login(page);

  await enableResize(page);
  await page.getByRole('button', { name: 'Full HD' }).click();
  await expect(page.locator('#aspect-ratio-toggle')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('label[for="resize-toggle"]').click();
  await page.locator('label[for="resize-toggle"]').click();

  await expect(page.locator('#custom-width')).toHaveValue('1920');
  await expect(page.locator('#custom-height')).toHaveValue('1080');
  await expect(page.locator('#aspect-ratio-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('reload restores explicit resize lock state instead of inferring it from dimensions', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('compressify_settings', JSON.stringify({
      compress: { mode: 'lossless', outputFormat: 'auto', quality: null },
      resize: { mode: 'custom', width: 1200, height: 800, locked: false },
      background: { enabled: false },
      watermark: { enabled: false },
    }));
  });

  await login(page);

  await expect(page.locator('#resize-toggle')).toBeChecked();
  await expect(page.locator('#custom-width')).toHaveValue('1200');
  await expect(page.locator('#custom-height')).toHaveValue('800');
  await expect(page.locator('#aspect-ratio-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('workflow switch preserves optimize and AI upscale settings separately', async ({ page }) => {
  await mockAIUpscaleService(page);
  await login(page);

  await page.locator('#compression-mode-control [data-value="web"]').click();
  await page.locator('#format-control [data-value="webp"]').click();
  await setRangeValue(page, '#quality-slider', 74);
  await enableResize(page);
  await page.locator('#custom-width').fill('1200');
  await page.locator('#custom-height').fill('');

  await expect(page.locator('#settings-summary')).toContainText('Balanced');
  await expect(page.locator('#settings-summary')).toContainText('WebP');
  await expect(page.locator('#settings-summary')).toContainText('Q74');
  await expect(page.locator('#settings-summary')).toContainText('Fit width 1200px');

  await enableAIUpscale(page);
  await expect(page.locator('#ai-upscale-status')).toContainText('ready');
  await expect(page.locator('[data-section="compression"]')).toBeHidden();
  await expect(page.locator('[data-section="ai-upscale"]')).toBeVisible();

  await page.locator('#ai-model-control [data-value="anime"]').click();
  await page.locator('#ai-scale-control [data-value="4"]').click();
  await page.locator('#ai-format-control [data-value="webp"]').click();
  await setRangeValue(page, '#ai-quality-slider', 88);

  await expect(page.locator('#settings-summary')).toContainText('AI Upscale');
  await expect(page.locator('#settings-summary')).toContainText('Anime');
  await expect(page.locator('#settings-summary')).toContainText('4x');
  await expect(page.locator('#settings-summary')).toContainText('WebP');
  await expect(page.locator('#settings-summary')).toContainText('Q88');

  await page.locator('#workflow-control [data-value="optimize"]').click();
  await expect(page.locator('[data-section="compression"]')).toBeVisible();
  await expect(page.locator('#compression-mode-control [data-value="web"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#format-control [data-value="webp"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#quality-slider')).toHaveValue('74');
  await expect(page.locator('#custom-width')).toHaveValue('1200');
  await expect(page.locator('#custom-height')).toHaveValue('');

  await enableAIUpscale(page);
  await expect(page.locator('#ai-model-control [data-value="anime"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ai-scale-control [data-value="4"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ai-format-control [data-value="webp"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ai-quality-slider')).toHaveValue('88');
});

test('AI upscale uploads poll jobs, hide crop controls, and reprocess with new settings', async ({ page }) => {
  const aiMock = await mockAIUpscaleService(page, {
    jobs: [
      {
        id: 'job-1',
        result: { filename: 'upscaled-1.png', modelPreset: 'photo', scale: 2, format: 'PNG' },
      },
      {
        id: 'job-2',
        result: { filename: 'upscaled-2.png', modelPreset: 'photo', scale: 2, format: 'PNG' },
      },
      {
        id: 'job-3',
        result: { filename: 'upscaled-1.jpg', modelPreset: 'photo', scale: 4, format: 'JPEG' },
      },
      {
        id: 'job-4',
        result: { filename: 'upscaled-2.jpg', modelPreset: 'photo', scale: 4, format: 'JPEG' },
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await expect(page.locator('#ai-upscale-status')).toContainText('ready');

  await uploadFiles(page, makeFiles(2, 'ai-upscale'));
  await waitForDoneCount(page, 2);

  expect(aiMock.createBodies).toHaveLength(2);
  expect(aiMock.createBodies[0]).toMatch(/name="model_preset";?[^\r\n]*\r\n\r\nphoto\r\n/);
  expect(aiMock.createBodies[0]).toMatch(/name="scale";?[^\r\n]*\r\n\r\n2\r\n/);
  expect(aiMock.createBodies[0]).toMatch(/name="output_format";?[^\r\n]*\r\n\r\npng\r\n/);
  expect(aiMock.createBodies[0]).not.toContain('name="quality"');

  await expect(page.locator('.tile').first().locator('.tile__status-badges')).toContainText('AI Upscaled');
  await expect(page.locator('.tile').first().locator('.tile__status-badges')).toContainText('x2');
  await expect(page.locator('.tile').first().locator('.tile__crop-btn')).toBeHidden();
  await expect(page.locator('.tile').first().locator('.tile__image')).toHaveAttribute(
    'src',
    /\/ai-upscale\/artifacts\/job-1-preview\/preview/,
  );

  await page.locator('#ai-scale-control [data-value="4"]').click();
  await page.locator('#ai-format-control [data-value="jpeg"]').click();
  await expect(page.getByRole('button', { name: 'Re-process' })).toBeVisible();

  await page.getByRole('button', { name: 'Re-process' }).click();
  await expect.poll(() => aiMock.deletedJobIds.length).toBe(2);
  await expect.poll(() => aiMock.createCount).toBe(4);
  await waitForDoneCount(page, 2);
  expect(aiMock.deletedJobHeaders).toHaveLength(2);
  aiMock.deletedJobHeaders.forEach((headers) => {
    expect(headers['x-csrftoken']).toBeTruthy();
  });

  await expect(page.locator('.tile').first().locator('.tile__status-badges')).toContainText('x4');
  await expect(page.locator('.tile').first().locator('.tile__status-badges')).toContainText('→ JPEG');

  await page.getByRole('button', { name: 'Download All' }).click();
  await expect.poll(() => aiMock.downloadAllBodies.length).toBe(1);
});

test('AI upscale downloads a single artifact result', async ({ page }) => {
  const aiMock = await mockAIUpscaleService(page, {
    jobs: [
      {
        id: 'job-single-download',
        result: { filename: 'single-download.png', modelPreset: 'photo', scale: 2, format: 'PNG' },
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await uploadFiles(page, makeFiles(1, 'ai-single-download'));
  await waitForDoneCount(page, 1);

  await page.locator('.tile').first().locator('.tile__download-btn').click();
  await expect.poll(() => aiMock.downloadArtifactIds).toEqual(['job-single-download-download']);
});

test('AI upscale health shows bootstrapping copy while the worker is starting', async ({ page }) => {
  await mockAIUpscaleService(page, {
    health: {
      enabled: true,
      healthy: false,
      state: 'starting',
      backend: 'torch-cpu',
      reason: 'Preloading AI upscaling models into memory…',
      details: { cached_models: [], cpu_threads: 4 },
    },
  });

  await login(page);
  await enableAIUpscale(page);

  await expect(page.locator('#ai-upscale-status')).toContainText('Preloading AI upscaling models');
});

test('AI upscale auto-recovers when the worker finishes booting after the first health check', async ({ page }) => {
  const health = {
    enabled: true,
    healthy: false,
    state: 'starting',
    backend: 'torch-cpu',
    worker_instance_id: null,
    started_at: null,
    reason: 'Preloading AI upscaling models into memory…',
    details: { cached_models: [], cpu_threads: 4 },
  };
  const aiMock = await mockAIUpscaleService(page, {
    health,
    jobs: [
      {
        id: 'job-after-startup',
        result: { filename: 'job-after-startup.png', scale: 2 },
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await uploadFiles(page, makeFiles(1, 'ai-starting'));

  await expect(page.locator('#ai-upscale-status')).toContainText('Preloading AI upscaling models');
  await expect.poll(() => aiMock.createCount).toBe(0);

  Object.assign(health, {
    healthy: true,
    state: 'ready',
    worker_instance_id: 'worker-ready',
    started_at: '2026-04-13T10:05:00+00:00',
    reason: 'AI upscaling service ready',
  });

  await expect.poll(() => aiMock.createCount, { timeout: 10_000 }).toBe(1);
  await waitForDoneCount(page, 1);
  await expect(page.locator('#ai-upscale-status')).toContainText('AI upscaling service ready');
});

test('AI upscale stops retrying health checks after the configured retry budget', async ({ page }) => {
  await page.addInitScript(() => {
    window.__AI_UPSCALE_HEALTH_RETRY_DELAYS_MS = [20, 20, 20];
    window.__AI_UPSCALE_HEALTH_MAX_RETRIES = 3;
  });

  const aiMock = await mockAIUpscaleService(page, {
    health: {
      enabled: true,
      healthy: false,
      state: 'starting',
      backend: 'torch-cpu',
      reason: 'Preloading AI upscaling models into memory…',
      details: { cached_models: [], cpu_threads: 4 },
    },
  });

  await login(page);
  await enableAIUpscale(page);

  await expect(page.locator('#ai-upscale-status')).toContainText('taking too long', { timeout: 10_000 });
  const settledCount = aiMock.healthCount;
  await page.waitForTimeout(200);
  expect(aiMock.healthCount).toBe(settledCount);
});

test('AI upscale tiles surface queue and progress text from polling', async ({ page }) => {
  const aiMock = await mockAIUpscaleService(page, {
    jobs: [
      {
        id: 'job-progress',
        sequence: [
          { job_id: 'job-progress', status: 'queued', phase: 'queued', progress: 0, queue_position: 2 },
          { job_id: 'job-progress', status: 'processing', phase: 'running', progress: 42, queue_position: null },
          makeAIUpscaleJobResult({ jobId: 'job-progress', filename: 'job-progress.png', scale: 2 }),
        ],
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await uploadFiles(page, makeFiles(1, 'ai-progress'));

  await expect(page.locator('.tile__progress-text')).toContainText('Queued');
  await expect(page.locator('.tile__progress-text')).toContainText('position 2');
  await expect(page.locator('.tile__progress-text')).toContainText('42%', { timeout: 10_000 });
  await waitForDoneCount(page, 1);

  expect(aiMock.pollCounts.get('job-progress')).toBe(3);
  await page.waitForTimeout(2200);
  expect(aiMock.pollCounts.get('job-progress')).toBe(3);
});

test('AI upscale marks stalled jobs retryable when progress stops changing', async ({ page }) => {
  await page.addInitScript(() => {
    window.__AI_UPSCALE_STALL_TIMEOUT_MS = 250;
  });

  const aiMock = await mockAIUpscaleService(page, {
    jobs: [
      {
        id: 'job-stalled',
        sequence: [
          {
            job_id: 'job-stalled',
            status: 'processing',
            phase: 'running',
            progress: 18,
            queue_position: null,
            worker_instance_id: 'worker-a',
            updated_at: 1,
          },
        ],
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await uploadFiles(page, makeFiles(1, 'ai-stalled'));

  await expect(page.locator('.tile__progress-text')).toContainText('18%');
  await expect(page.locator('.tile__error')).toContainText('stopped making progress', { timeout: 10_000 });
  await expect(page.locator('.tile__retry-btn')).toBeVisible();
  expect(aiMock.pollCounts.get('job-stalled')).toBeGreaterThanOrEqual(2);
});

test('AI upscale marks jobs retryable when the worker restarts mid-poll', async ({ page }) => {
  const health = {
    enabled: true,
    healthy: true,
    state: 'ready',
    backend: 'torch-cpu',
    worker_instance_id: 'worker-a',
    started_at: '2026-04-13T10:00:00+00:00',
    reason: 'AI upscaling service ready',
    details: { cached_models: [], cpu_threads: 4 },
  };
  const aiMock = await mockAIUpscaleService(page, {
    health,
    jobs: [
      {
        id: 'job-restart',
        createResponse: { worker_instance_id: 'worker-a' },
        sequence: [
          { job_id: 'job-restart', status: 'processing', phase: 'running', progress: 15, worker_instance_id: 'worker-a' },
          { httpStatus: 404, error: 'Job not found.' },
        ],
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await uploadFiles(page, makeFiles(1, 'ai-restart'));

  await expect(page.locator('.tile__progress-text')).toContainText('15%');
  health.worker_instance_id = 'worker-b';
  health.started_at = '2026-04-13T10:05:00+00:00';

  await expect(page.locator('.tile__error')).toContainText('worker restarted during processing', { timeout: 10_000 });
  await expect(page.locator('.tile__retry-btn')).toBeVisible();
  expect(aiMock.pollCounts.get('job-restart')).toBeGreaterThanOrEqual(2);
});

test('AI upscale keeps jobs retryable when the worker restart window returns 503s', async ({ page }) => {
  const health = {
    enabled: true,
    healthy: true,
    state: 'ready',
    backend: 'torch-cpu',
    worker_instance_id: 'worker-a',
    started_at: '2026-04-13T10:00:00+00:00',
    reason: 'AI upscaling service ready',
    details: { cached_models: [], cpu_threads: 4 },
  };
  const aiMock = await mockAIUpscaleService(page, {
    health,
    jobs: [
      {
        id: 'job-restart-503',
        createResponse: { worker_instance_id: 'worker-a' },
        sequence: [
          { job_id: 'job-restart-503', status: 'processing', phase: 'running', progress: 21, worker_instance_id: 'worker-a' },
          { httpStatus: 503, error: 'AI upscaling service is unavailable.' },
        ],
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await uploadFiles(page, makeFiles(1, 'ai-restart-503'));

  await expect(page.locator('.tile__progress-text')).toContainText('21%');
  Object.assign(health, {
    httpStatus: 503,
    healthy: false,
    state: 'starting',
    worker_instance_id: null,
    started_at: null,
    reason: 'AI upscaling service is unavailable.',
  });

  await expect(page.locator('.tile__error')).toContainText('worker restarted during processing', { timeout: 10_000 });
  await expect(page.locator('.tile__retry-btn')).toBeVisible();
  expect(aiMock.pollCounts.get('job-restart-503')).toBeGreaterThanOrEqual(2);
});

test('AI upscale shows a friendly memory-limit message for oversized jobs', async ({ page }) => {
  await mockAIUpscaleService(page, {
    jobs: [
      {
        createHttpStatus: 409,
        createResponse: {
          code: 'memory_budget_exceeded',
          estimated_peak_bytes: 926563636,
          memory_limit_bytes: 2147483648,
          memory_soft_limit_bytes: 926102323,
          projected_output: { width: 12800, height: 12800, pixels: 163840000 },
          suggested_scale: 2,
        },
      },
    ],
  });

  await login(page);
  await enableAIUpscale(page);
  await page.locator('#ai-scale-control [data-value="4"]').click();
  await uploadFiles(page, makeFiles(1, 'ai-memory'));

  await expect(page.locator('.tile__error')).toContainText('too large for AI upscaling on the current server', { timeout: 10_000 });
  await expect(page.locator('.tile__error')).toContainText('Try 2x instead.');
  await expect(page.locator('.tile__retry-btn')).toBeVisible();
});

test('AI upscale cancel marks work as cancelled and retry incomplete completes the batch', async ({ page }) => {
  const stalledJobs = [{
    id: 'slow-1',
    sequence: [
      { job_id: 'slow-1', status: 'processing' },
    ],
  }];
  const retryJobs = Array.from({ length: 7 }, (_, index) => ({
    id: `retry-${index + 1}`,
    result: { filename: `retry-${index + 1}.png`, modelPreset: 'photo', scale: 2, format: 'PNG' },
  }));

  const aiMock = await mockAIUpscaleService(page, {
    jobs: [...stalledJobs, ...retryJobs],
  });

  await login(page);
  await enableAIUpscale(page);

  await uploadFiles(page, makeFiles(7, 'ai-cancel'));
  await expect.poll(() => aiMock.createCount).toBe(1);
  expect(aiMock.createCount).toBe(1);
  await page.locator('#cancel-batch').click();

  await expect(page.locator('.badge--cancelled').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Retry Incomplete' })).toBeVisible();
  await expect.poll(() => aiMock.cancelledJobIds.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Retry Incomplete' }).click();
  await waitForDoneCount(page, 7);
  await expect.poll(() => aiMock.createCount).toBe(8);
});

test('AI upscale disabled health shows a clear reason and blocks auto-processing', async ({ page }) => {
  const aiMock = await mockAIUpscaleService(page, {
    health: {
      enabled: true,
      healthy: false,
      reason: 'AI upscaling worker is missing required Real-ESRGAN models.',
    },
  });

  await login(page);
  await enableAIUpscale(page);

  await expect(page.locator('#ai-upscale-status')).toContainText('missing required Real-ESRGAN models');
  await expect(page.locator('#settings-summary')).toContainText('Unavailable');

  await uploadFiles(page, makeFiles(1, 'ai-disabled'));

  await expect(page.locator('.tile')).toHaveCount(1);
  await expect.poll(() => aiMock.createCount).toBe(0);
  await expect(page.locator('.toast--warning').filter({
    hasText: 'AI upscaling worker is missing required Real-ESRGAN models.',
  })).toHaveCount(1);
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
