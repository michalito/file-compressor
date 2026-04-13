import QRCode from '../vendor/qrcode.bundle.js';

const QR_SIZE = 512;
const WATERMARK_FONT_FAMILY = 'Compressify Watermark';
const WATERMARK_FONT_URL = '/static/fonts/Inter-SemiBold.ttf';

let fontLoadPromise = null;

export function validateWatermarkQrUrl(url) {
  const value = (url || '').trim();
  if (!value) {
    return { valid: false, error: 'Enter an absolute http:// or https:// URL.' };
  }

  if (value.length > 2048) {
    return { valid: false, error: 'QR URL must be 2048 characters or fewer.' };
  }

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      return { valid: false, error: 'Use an absolute http:// or https:// URL.' };
    }

    return { valid: true, error: null, url: parsed.toString() };
  } catch {
    return { valid: false, error: 'Use an absolute http:// or https:// URL.' };
  }
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to generate QR code image.'));
      }
    }, type);
  });
}

export async function generateWatermarkQrBlob(url) {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, url, {
    width: QR_SIZE,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: {
      dark: '#000000ff',
      light: '#00000000',
    },
  });

  return canvasToBlob(canvas, 'image/png');
}

export async function ensureWatermarkFont() {
  if (document.fonts?.check?.(`16px "${WATERMARK_FONT_FAMILY}"`)) {
    return WATERMARK_FONT_FAMILY;
  }

  if (!fontLoadPromise) {
    const font = new FontFace(WATERMARK_FONT_FAMILY, `url(${WATERMARK_FONT_URL})`);
    fontLoadPromise = font.load().then((loadedFont) => {
      document.fonts.add(loadedFont);
      return WATERMARK_FONT_FAMILY;
    }).catch((error) => {
      console.error('Failed to load watermark font:', error);
      fontLoadPromise = null;
      return WATERMARK_FONT_FAMILY;
    });
  }

  return fontLoadPromise;
}

export function getWatermarkFontFamily() {
  return WATERMARK_FONT_FAMILY;
}
