import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { config } from './config.js';
import type { ExtractedPage } from './pdfText.js';

const execFileAsync = promisify(execFile);

export class MissingToolError extends Error {}

const MISSING_BINARY_HELP: Record<string, string> = {
  pdftoppm: "The PDF page renderer (Poppler) is not installed. Install it with 'sudo apt-get install -y poppler-utils' (macOS: 'brew install poppler'), then restart the worker. A container gets it from the Dockerfile.",
};

function describeToolFailure(tool: string, error: unknown) {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return error;
  return new MissingToolError(MISSING_BINARY_HELP[tool] ?? `The '${tool}' binary is not on PATH.`);
}

/**
 * Rasterisation DPI for one page.
 *
 * Very large page boxes would otherwise turn into images several times bigger
 * than a 300 DPI A4 scan, which costs seconds per page in both Poppler and the
 * recogniser without adding readable detail.
 */
export function renderDpiForPage(page: Pick<ExtractedPage, 'width' | 'height'>) {
  const squareInches = (page.width / 72) * (page.height / 72);
  if (!Number.isFinite(squareInches) || squareInches <= 0) return config.renderDpi;
  const budgetDpi = Math.floor(Math.sqrt(config.maxRenderPixels / squareInches));
  return Math.max(config.minRenderDpi, Math.min(config.renderDpi, budgetDpi));
}

/**
 * Renders one PDF page to a grayscale JPEG.
 *
 * The format is the reason this is fast. Poppler's PNG writer spends most of
 * its time in zlib: on a broadsheet page at 195 DPI it took 7.8 s against 0.5 s
 * for the same raster as JPEG, so encoding -- not rasterising, and not
 * recognition -- was the single largest cost in the old pipeline. Nothing reads
 * these files but the recogniser, which downsamples them anyway, so lossless
 * output bought nothing.
 */
export async function renderPageImage(
  pdfPath: string,
  pageNumber: number,
  outputBase: string,
  dpi: number,
  signal: AbortSignal,
) {
  try {
    await execFileAsync('pdftoppm', [
      '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
      '-r', String(dpi),
      '-gray',
      '-jpeg', '-jpegopt', `quality=${config.renderJpegQuality}`,
      pdfPath, outputBase,
    ], { maxBuffer: 8 * 1024 * 1024, signal, timeout: config.renderTimeoutMs });
  } catch (error) {
    if (signal.aborted) throw error;
    throw describeToolFailure('pdftoppm', error);
  }
  return `${outputBase}.jpg`;
}

/** Reads width and height from a JPEG's frame header without decoding it. */
export async function jpegDimensions(imagePath: string) {
  const handle = await open(imagePath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 512 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.readUInt16BE(0) !== 0xFFD8) throw new Error('Rendered page is not a valid JPEG image.');
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xFF) { offset += 1; continue; }
      const marker = buffer[offset + 1]!;
      // SOF0..SOF15, skipping the four markers in that range that carry no frame.
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    throw new Error('Rendered page has no JPEG frame header.');
  } finally {
    await handle.close();
  }
}

export async function checkRenderer() {
  try {
    const { stdout, stderr } = await execFileAsync('pdftoppm', ['-v'], { timeout: 10_000 });
    return { ok: true, detail: (stderr || stdout).split(/\r?\n/)[0]?.trim() || 'pdftoppm' };
  } catch (error) {
    return {
      ok: false,
      detail: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? MISSING_BINARY_HELP.pdftoppm!
        : (error as Error).message,
    };
  }
}
