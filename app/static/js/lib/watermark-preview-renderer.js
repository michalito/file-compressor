import {
  getImageWatermarkMetrics,
  getPreviewDrawRect,
  getTextWatermarkFontPx,
  getTextWatermarkMargin,
  getTiledWatermarkSpacing,
  getWatermarkPosition,
} from './watermark-layout.js';
import { getWatermarkFontFamily } from './watermark.js';

function measureTextStamp(text, fontPx) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontPx}px "${getWatermarkFontFamily()}"`;
  const metrics = ctx.measureText(text);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontPx * 0.8);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontPx * 0.2);
  const width = Math.ceil(metrics.width);
  const height = ascent + descent;

  return {
    width,
    height,
    ascent,
    descent,
    stampWidth: width + fontPx,
    stampHeight: height + fontPx,
  };
}

function clampSampleRect(drawRect, x, y, width, height) {
  const sx = Math.max(drawRect.x, x);
  const sy = Math.max(drawRect.y, y);
  const sw = Math.max(1, Math.min(drawRect.x + drawRect.width, x + width) - sx);
  const sh = Math.max(1, Math.min(drawRect.y + drawRect.height, y + height) - sy);

  return { x: sx, y: sy, width: sw, height: sh };
}

function getAverageLuminance(ctx, rect) {
  const imageData = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
  let total = 0;
  const pixels = imageData.data;
  const count = Math.max(1, pixels.length / 4);

  for (let index = 0; index < pixels.length; index += 4) {
    total += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
  }

  return total / count;
}

function getAutoTextColor(ctx, drawRect, position, sampleWidth, sampleHeight, margin) {
  let sampleRect;

  if (position === 'tiled' || position === 'center') {
    const centerWidth = Math.max(sampleWidth, Math.floor(drawRect.width / 4));
    const centerHeight = Math.max(sampleHeight, Math.floor(drawRect.height / 4));
    sampleRect = clampSampleRect(
      drawRect,
      drawRect.x + Math.floor((drawRect.width - centerWidth) / 2),
      drawRect.y + Math.floor((drawRect.height - centerHeight) / 2),
      centerWidth,
      centerHeight,
    );
  } else {
    const sampleX = position.includes('right')
      ? drawRect.x + drawRect.width - margin - sampleWidth
      : drawRect.x + margin;
    const sampleY = position.includes('bottom')
      ? drawRect.y + drawRect.height - margin - sampleHeight
      : drawRect.y + margin;
    sampleRect = clampSampleRect(drawRect, sampleX, sampleY, sampleWidth, sampleHeight);
  }

  const luminance = getAverageLuminance(ctx, sampleRect);
  return luminance < 128 ? [255, 255, 255] : [0, 0, 0];
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function rotateCanvas(sourceCanvas, angle) {
  if (angle === 0) return sourceCanvas;

  const radians = angle * Math.PI / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const rotated = document.createElement('canvas');
  rotated.width = Math.ceil(sourceCanvas.width * cos + sourceCanvas.height * sin);
  rotated.height = Math.ceil(sourceCanvas.width * sin + sourceCanvas.height * cos);

  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);

  return rotated;
}

function createTextStamp(text, fontPx, colorRgb, opacity, measurement = measureTextStamp(text, fontPx)) {
  const canvas = document.createElement('canvas');
  canvas.width = measurement.stampWidth;
  canvas.height = measurement.stampHeight;

  const ctx = canvas.getContext('2d');
  ctx.font = `${fontPx}px "${getWatermarkFontFamily()}"`;
  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'geometricPrecision';

  const tx = Math.floor((canvas.width - measurement.width) / 2);
  const baseline = Math.floor((canvas.height - measurement.height) / 2) + measurement.ascent;
  const shadowOffset = Math.max(1, Math.floor(fontPx / 20));
  const shadowRgb = colorRgb[0] === 255 && colorRgb[1] === 255 && colorRgb[2] === 255
    ? [0, 0, 0]
    : [255, 255, 255];

  ctx.fillStyle = rgba(shadowRgb, opacity * 0.5);
  ctx.fillText(text, tx + shadowOffset, baseline + shadowOffset);
  ctx.fillStyle = rgba(colorRgb, opacity);
  ctx.fillText(text, tx, baseline);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    measurement,
  };
}

function createImageStamp(image, maxSide, opacity) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = opacity;
  ctx.drawImage(image, 0, 0, width, height);

  return {
    canvas,
    width,
    height,
  };
}

function getExplicitTextColor(color) {
  return color === 'white' ? [255, 255, 255] : [0, 0, 0];
}

function resolveTextColor(ctx, drawRect, textLayer, sampleWidth, sampleHeight, margin) {
  if (textLayer.color === 'auto') {
    return getAutoTextColor(ctx, drawRect, textLayer.position, sampleWidth, sampleHeight, margin);
  }

  return getExplicitTextColor(textLayer.color);
}

function drawTiledStamp(ctx, drawRect, canvas, tileDensity) {
  const spacing = getTiledWatermarkSpacing(canvas.width, canvas.height, tileDensity);

  for (let row = 0, y = -canvas.height; y < drawRect.height + canvas.height; y += spacing.y, row += 1) {
    const xOffset = Math.floor(spacing.x / 2) * (row % 2);
    for (let x = -canvas.width + xOffset; x < drawRect.width + canvas.width; x += spacing.x) {
      ctx.drawImage(canvas, drawRect.x + x, drawRect.y + y);
    }
  }
}

function drawTextLayer(ctx, drawRect, textLayer) {
  if (!textLayer?.enabled) return;

  const fontPx = getTextWatermarkFontPx(drawRect.width, drawRect.height, textLayer.size);
  const margin = getTextWatermarkMargin(fontPx);
  const opacity = textLayer.opacity / 100;
  const measurement = measureTextStamp(textLayer.value, fontPx);
  const fillRgb = resolveTextColor(
    ctx,
    drawRect,
    textLayer,
    Math.min(drawRect.width / 3, textLayer.value.length * fontPx),
    fontPx * 2,
    margin,
  );

  if (textLayer.position === 'tiled') {
    const stamp = createTextStamp(textLayer.value, fontPx, fillRgb, opacity, measurement);
    drawTiledStamp(ctx, drawRect, rotateCanvas(stamp.canvas, textLayer.angle), textLayer.tileDensity);
    return;
  }

  if (textLayer.angle === 0) {
    const shadowOffset = Math.max(1, Math.floor(fontPx / 20));
    const shadowRgb = fillRgb[0] === 255 && fillRgb[1] === 255 && fillRgb[2] === 255
      ? [0, 0, 0]
      : [255, 255, 255];
    const position = getWatermarkPosition(
      textLayer.position,
      drawRect.width,
      drawRect.height,
      measurement.width,
      measurement.height,
      margin,
    );
    const x = drawRect.x + position.x;
    const y = drawRect.y + position.y + measurement.ascent;

    ctx.font = `${fontPx}px "${getWatermarkFontFamily()}"`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgba(shadowRgb, opacity * 0.5);
    ctx.fillText(textLayer.value, x + shadowOffset, y + shadowOffset);
    ctx.fillStyle = rgba(fillRgb, opacity);
    ctx.fillText(textLayer.value, x, y);
    return;
  }

  const stamp = createTextStamp(textLayer.value, fontPx, fillRgb, opacity, measurement);
  const rotated = rotateCanvas(stamp.canvas, textLayer.angle);
  const position = getWatermarkPosition(
    textLayer.position,
    drawRect.width,
    drawRect.height,
    rotated.width,
    rotated.height,
    margin,
  );
  ctx.drawImage(rotated, drawRect.x + position.x, drawRect.y + position.y);
}

function drawImageLayer(ctx, drawRect, layer, image) {
  if (!layer?.enabled || !image) return;

  const { maxSide, margin } = getImageWatermarkMetrics(drawRect.width, drawRect.height, layer.size);
  const stamp = createImageStamp(image, maxSide, layer.opacity / 100);
  const rotated = rotateCanvas(stamp.canvas, layer.angle);

  if (layer.position === 'tiled') {
    drawTiledStamp(ctx, drawRect, rotated, layer.tileDensity);
    return;
  }

  const position = getWatermarkPosition(
    layer.position,
    drawRect.width,
    drawRect.height,
    rotated.width,
    rotated.height,
    margin,
  );
  ctx.drawImage(rotated, drawRect.x + position.x, drawRect.y + position.y);
}

export function renderWatermarkPreviewCanvas(canvas, image, watermark, assets = {}) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const drawRect = getPreviewDrawRect(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
    canvas.width,
    canvas.height,
  );
  ctx.drawImage(image, drawRect.x, drawRect.y, drawRect.width, drawRect.height);

  drawTextLayer(ctx, drawRect, watermark.text);
  drawImageLayer(ctx, drawRect, watermark.logo, assets.logoImage);
  drawImageLayer(ctx, drawRect, watermark.qr, assets.qrImage);

  return drawRect;
}
