/**
 * ============================================================================
 * OCR image preprocessing
 * ============================================================================
 * Tesseract's accuracy is heavily dependent on image quality. Three
 * well-established, cheap preprocessing steps measurably improve it on real
 * scans, and are applied here before every OCR call:
 *
 *   1. Upscale small renders. Tesseract wants text tall enough to resolve
 *      character shapes (rule of thumb: ~300 DPI equivalent). A page
 *      rasterized small (a low-resolution scan, or a small embedded image)
 *      gives the recognizer too few pixels per glyph. Upscaling — done while
 *      the image still has continuous grayscale tone, before binarization —
 *      gives the interpolator real information to work with.
 *   2. Grayscale. Color contributes noise, not signal, to text recognition.
 *   3. Binarize with Otsu's method. Otsu picks the black/white threshold
 *      that best separates a bimodal histogram (text vs. background) by
 *      maximizing between-class variance — it adapts per-image instead of
 *      using a fixed cutoff, so it holds up across scans with different
 *      lighting/contrast. This is the single highest-leverage classical
 *      preprocessing step for OCR on real (non-synthetic) documents: it
 *      removes background shading, faint stamps, and paper texture that
 *      would otherwise register as noise.
 *
 * A 3x3 median filter runs on the grayscale image immediately before
 * binarization. This pairing matters: thresholding alone is not robust to
 * speckle noise — tested against a deliberately noisy synthetic image, Otsu
 * alone turned salt-and-pepper speckle into confident-looking BUT WRONG
 * garbage text, which is worse than tesseract's own honest "found nothing"
 * on the same unprocessed image. A median filter suppresses that kind of
 * per-pixel noise while preserving text edges (unlike a mean/box blur, which
 * would soften character edges along with the noise) — the standard pairing
 * with Otsu in classical OCR preprocessing for exactly this reason.
 *
 * All of this runs on pixel data via @napi-rs/canvas — no new dependency,
 * no network, consistent with the rest of this pipeline.
 *
 * Explicitly NOT done here: deskew (rotation correction). It matters for
 * real scans but a naive skew-angle estimate can rotate text further off-axis
 * than it started; documented as a follow-up in the README rather than
 * shipped half-verified. And a 3x3 median filter, tuned against one
 * adversarial test case, is not a substitute for a properly evaluated
 * denoising pipeline — see README "Gaps and limitations".
 * ============================================================================
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';

/** Images narrower than this are upscaled — a proxy for "likely too low-resolution for good OCR". */
const UPSCALE_WIDTH_THRESHOLD = 1500;
/** Upscale factor applied when below the threshold. 2x roughly doubles effective DPI. */
const UPSCALE_FACTOR = 2;

/**
 * A 3x3 median filter: each pixel becomes the median of itself and its 8
 * neighbors. Suppresses isolated speckle noise (a single wrong-value pixel
 * can't survive being replaced by its neighborhood's median) while
 * preserving edges much better than averaging would — the reason it's the
 * standard denoise step ahead of thresholding, rather than a blur.
 *
 * Edge pixels (no full 3x3 neighborhood) are left unchanged — they're a tiny
 * fraction of any real page and not worth the border-handling complexity.
 *
 * @param {Uint8ClampedArray} gray Flat grayscale values, row-major.
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray} A new, filtered array.
 */
const medianFilter3x3 = (gray, width, height) => {
  const out = new Uint8ClampedArray(gray);
  const window = new Uint8ClampedArray(9);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          window[n++] = gray[(y + dy) * width + (x + dx)];
        }
      }
      window.sort();
      out[y * width + x] = window[4]; // median of 9 values
    }
  }
  return out;
};

/**
 * Computes Otsu's threshold from a grayscale histogram: the pixel value
 * (0-255) that maximizes between-class variance between "below" and
 * "above" — i.e. the cutoff that best separates two populations (text and
 * background) if the image is in fact bimodal.
 *
 * @param {Uint32Array} histogram 256-bucket count of grayscale pixel values.
 * @param {number} totalPixels
 * @returns {number} Threshold in [0, 255].
 */
const computeOtsuThreshold = (histogram, totalPixels) => {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let bestThreshold = 0;
  let bestVariance = 0;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;

    const betweenClassVariance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (betweenClassVariance > bestVariance) {
      bestVariance = betweenClassVariance;
      bestThreshold = t;
    }
  }

  return bestThreshold;
};

/**
 * Preprocesses a page image for OCR: conditionally upscale, convert to
 * grayscale, binarize with an Otsu threshold computed from that specific
 * image (so it adapts to each page's own contrast/lighting).
 *
 * @param {Buffer} pngBuffer Raw page image (as produced by pdf-parse's getScreenshot).
 * @returns {Promise<Buffer>} A preprocessed PNG buffer, ready for tesseract.
 */
export const preprocessForOcr = async (pngBuffer) => {
  const image = await loadImage(pngBuffer);

  const scale = image.width < UPSCALE_WIDTH_THRESHOLD ? UPSCALE_FACTOR : 1;
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height); // upscale happens here, on the still-continuous-tone source

  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData; // RGBA, 4 bytes/pixel
  const pixelCount = width * height;
  const gray = new Uint8ClampedArray(pixelCount);

  // Rec. 601 luma weights — standard grayscale conversion for this purpose.
  for (let p = 0, i = 0; p < data.length; p += 4, i++) {
    const g = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
    gray[i] = g;
  }

  const denoised = medianFilter3x3(gray, width, height);

  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixelCount; i++) histogram[denoised[i]] += 1;

  const threshold = computeOtsuThreshold(histogram, pixelCount);

  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    const value = denoised[i] > threshold ? 255 : 0;
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    // alpha (data[p + 3]) left untouched — pages are opaque anyway
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
};
