import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { renderPageImage } from './render.js';

export type HighlightBox = { x: number; y: number; width: number; height: number };

/**
 * Renders one page and paints the given highlights onto it.
 *
 * Published images are what a reader ends up looking at, so they are rasterised
 * separately from the recognition path and at a different size: recognition
 * wants resolution, this wants a file small enough to open over a phone
 * connection. The long edge is capped and the result written as JPEG.
 *
 * The highlights are drawn as one SVG overlay composited in a single pass,
 * rather than by manipulating pixels, so the marks stay crisp at any scale and
 * the translucent fill behaves the same way it does in the viewer.
 */
export async function renderHighlightedPage(options: {
  pdfPath: string;
  pageNumber: number;
  workDir: string;
  boxes: HighlightBox[];
  signal: AbortSignal;
}) {
  const { pdfPath, pageNumber, workDir, boxes, signal } = options;

  const rasterPath = await renderPageImage(
    pdfPath,
    pageNumber,
    path.join(workDir, `publish-${pageNumber}-${Date.now()}`),
    config.mediaImages.dpi,
    signal,
    // Colour, not the grayscale the recogniser uses: this one is read by people.
    { grayscale: false },
  );

  try {
    const image = sharp(rasterPath, { limitInputPixels: 512 * 1024 * 1024 });
    const meta = await image.metadata();
    const sourceWidth = meta.width ?? 0;
    const sourceHeight = meta.height ?? 0;
    if (!sourceWidth || !sourceHeight) throw new Error('The rendered page has no dimensions.');

    // Scale first, then draw, so the overlay is generated at final size and the
    // marks are not resampled along with the page.
    //
    // The overlay is sized from what the resize actually produced, not from what
    // was asked for. `fit: 'inside'` preserves the source aspect ratio, and
    // rounding each requested side independently nudges that ratio, so the
    // result can come back a pixel or two shorter than requested -- at which
    // point compositing an overlay built to the requested size fails outright
    // with "Image to composite must have same dimensions or smaller". Typical
    // page proportions are unaffected, which is what makes it so easy to miss.
    const scale = Math.min(1, config.mediaImages.maxEdge / Math.max(sourceWidth, sourceHeight));
    const { data: resized, info } = await image
      .resize(Math.max(1, Math.round(sourceWidth * scale)), Math.max(1, Math.round(sourceHeight * scale)), { fit: 'inside' })
      .toBuffer({ resolveWithObject: true });

    if (!boxes.length) {
      return sharp(resized).jpeg({ quality: config.mediaImages.jpegQuality, mozjpeg: true }).toBuffer();
    }

    const width = info.width;
    const height = info.height;

    const rectangles = boxes.map((box) => {
      // Boxes are page-relative; a little padding keeps descenders and the
      // final letter inside the mark.
      const padX = box.width * 0.02;
      const padY = box.height * 0.18;
      const x = Math.max(0, (box.x - padX)) * width;
      const y = Math.max(0, (box.y - padY)) * height;
      const w = Math.min(1, box.width + padX * 2) * width;
      const h = Math.min(1, box.height + padY * 2) * height;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" `
        + 'rx="2" fill="#FACC15" fill-opacity="0.38" stroke="#EAB308" stroke-opacity="0.85" stroke-width="1.5"/>';
    }).join('');

    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangles}</svg>`,
    );

    return await sharp(resized)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: config.mediaImages.jpegQuality, mozjpeg: true })
      .toBuffer();
  } finally {
    await rm(rasterPath, { force: true }).catch(() => undefined);
  }
}
