export function getPreviewDrawRect(sourceWidth, sourceHeight, canvasWidth, canvasHeight) {
  const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  return {
    x: Math.round((canvasWidth - width) / 2),
    y: Math.round((canvasHeight - height) / 2),
    width,
    height,
  };
}

export function getWatermarkPosition(position, width, height, itemWidth, itemHeight, margin) {
  const positions = {
    'bottom-right': { x: width - itemWidth - margin, y: height - itemHeight - margin },
    'bottom-left': { x: margin, y: height - itemHeight - margin },
    'top-right': { x: width - itemWidth - margin, y: margin },
    'top-left': { x: margin, y: margin },
    center: { x: Math.round((width - itemWidth) / 2), y: Math.round((height - itemHeight) / 2) },
  };

  return positions[position] || positions['bottom-right'];
}

export function getTextWatermarkFontPx(width, height, relativeSize) {
  return Math.max(12, Math.floor(Math.min(width, height) * relativeSize * 0.5 / 100));
}

export function getTextWatermarkMargin(fontPx) {
  return Math.floor(fontPx * 0.75);
}

export function getImageWatermarkMetrics(width, height, relativeSize) {
  const minSide = Math.min(width, height);

  return {
    maxSide: Math.max(24, Math.round(minSide * relativeSize * 1.2 / 100)),
    margin: Math.max(12, Math.round(minSide * 0.02)),
  };
}

export function getTiledWatermarkSpacing(stampWidth, stampHeight, tileDensity) {
  const spacingMult = 4.0 - (tileDensity - 1) * (2.9 / 9);

  return {
    x: Math.max(stampWidth + 1, Math.floor(stampWidth * spacingMult)),
    y: Math.max(stampHeight + 1, Math.floor(stampHeight * spacingMult)),
  };
}
