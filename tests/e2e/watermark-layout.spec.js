const path = require('path');
const { test, expect } = require('@playwright/test');

const contract = require(path.join(__dirname, '..', 'fixtures', 'watermark-layout-contract.json'));

test('frontend watermark layout helpers stay aligned with the shared layout contract', async ({ page }) => {
  await page.goto('/login');

  const actual = await page.evaluate(async (layoutContract) => {
    const {
      getTextWatermarkFontPx,
      getTextWatermarkMargin,
      getImageWatermarkMetrics,
      getTiledWatermarkSpacing,
      getWatermarkPosition,
    } = await import('/static/js/lib/watermark-layout.js');

    return {
      textFontCases: layoutContract.textFontCases.map((caseDef) => {
        const fontPx = getTextWatermarkFontPx(caseDef.width, caseDef.height, caseDef.size);
        return {
          name: caseDef.name,
          fontPx,
          margin: getTextWatermarkMargin(fontPx),
        };
      }),
      imageCases: layoutContract.imageCases.map((caseDef) => {
        const metrics = getImageWatermarkMetrics(caseDef.width, caseDef.height, caseDef.size);
        return {
          name: caseDef.name,
          maxSide: metrics.maxSide,
          margin: metrics.margin,
        };
      }),
      tileCases: layoutContract.tileCases.map((caseDef) => {
        const spacing = getTiledWatermarkSpacing(
          caseDef.stampWidth,
          caseDef.stampHeight,
          caseDef.tileDensity,
        );
        return {
          name: caseDef.name,
          spacingX: spacing.x,
          spacingY: spacing.y,
        };
      }),
      positionCases: layoutContract.positionCases.map((caseDef) => {
        const position = getWatermarkPosition(
          caseDef.position,
          caseDef.imgW,
          caseDef.imgH,
          caseDef.stampW,
          caseDef.stampH,
          caseDef.margin,
        );
        return {
          name: caseDef.name,
          x: position.x,
          y: position.y,
        };
      }),
    };
  }, contract);

  expect(actual).toEqual({
    textFontCases: contract.textFontCases.map(({ name, fontPx, margin }) => ({ name, fontPx, margin })),
    imageCases: contract.imageCases.map(({ name, maxSide, margin }) => ({ name, maxSide, margin })),
    tileCases: contract.tileCases.map(({ name, spacingX, spacingY }) => ({ name, spacingX, spacingY })),
    positionCases: contract.positionCases.map(({ name, x, y }) => ({ name, x, y })),
  });
});
