import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Office documents are converted to PDF on upload.
 *
 * Everything downstream -- page geometry, the text layer, rasterisation,
 * highlight coordinates, the published page image -- is defined in terms of PDF
 * pages. Converting once at the door keeps that true and means a `.docx` is
 * searched, highlighted and published exactly like a scan, rather than every
 * later stage having to know about a second format.
 */
export const OFFICE_EXTENSIONS = ['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp'] as const;

/**
 * Photographs and scans, which become a one-page PDF the same way.
 *
 * These are the formats sharp decodes, which is what normalises them before
 * they are wrapped. HEIC comes off phones and depends on the build's libheif;
 * an image sharp cannot read is reported as such rather than stored unreadable.
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.avif', '.heic', '.heif'] as const;

export const CONVERTIBLE_EXTENSIONS = [...OFFICE_EXTENSIONS, ...IMAGE_EXTENSIONS] as const;
export const ACCEPTED_EXTENSIONS = ['.pdf', ...CONVERTIBLE_EXTENSIONS] as const;

const ACCEPTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/rtf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

const IMAGE_MIME_PREFIX = 'image/';

export const extensionOf = (fileName: string) => path.extname(fileName).toLowerCase();

/** Whether the upload endpoint should accept this file at all. */
export function isAcceptedUpload(fileName: string, mimeType: string) {
  const extension = extensionOf(fileName);
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)
    || ACCEPTED_MIME_TYPES.has(mimeType)
    || mimeType.startsWith(IMAGE_MIME_PREFIX);
}

/**
 * Whether this upload is a picture rather than a document.
 *
 * The MIME type is consulted as well as the extension because a camera roll or
 * a paste can arrive with no filename extension at all.
 */
export function isImageUpload(fileName: string, mimeType = '') {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
    || mimeType.startsWith(IMAGE_MIME_PREFIX);
}

/** Office documents, which go through LibreOffice. Images have their own path. */
export function needsConversion(fileName: string) {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

export class ConversionError extends Error {
  override readonly name = 'ConversionError';
}

/**
 * Converts one office document to PDF, returning the new file's path.
 *
 * LibreOffice is run headless, one document per invocation, with a private
 * profile directory. The profile matters: concurrent runs sharing the default
 * one silently fight over its lock and the second simply produces nothing, so
 * a batch would convert its first file and quietly drop the rest.
 */
export async function convertToPdf(sourcePath: string, originalName: string): Promise<string> {
  const workDir = await mkdtemp(path.join(config.tempDir, 'convert-'));
  const profileDir = path.join(workDir, 'profile');
  // LibreOffice derives the output name from the input's, so the input is given
  // its real extension -- it refuses to guess the format otherwise.
  const inputPath = path.join(workDir, `input${extensionOf(originalName)}`);
  await rename(sourcePath, inputPath).catch(async () => {
    // `rename` fails across devices; the upload's temp dir may be one.
    const { copyFile } = await import('node:fs/promises');
    await copyFile(sourcePath, inputPath);
  });

  try {
    await execFileAsync(config.libreOfficeBin, [
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf', '--outdir', workDir, inputPath,
    ], { timeout: config.conversionTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConversionError(
        'This file needs converting to PDF, but LibreOffice is not installed. '
        + 'Install it with `sudo apt-get install -y libreoffice-writer` (the Docker image already has it), '
        + 'or upload a PDF instead.',
      );
    }
    throw new ConversionError(`Could not convert ${originalName} to PDF: ${(error as Error).message.split('\n')[0]}`);
  }

  // LibreOffice reports success on its exit code even when it has written
  // nothing, so the output is looked for rather than assumed.
  const produced = (await readdir(workDir)).find((name) => name.toLowerCase().endsWith('.pdf'));
  if (!produced) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw new ConversionError(`${originalName} could not be converted to PDF; it may be password protected or damaged.`);
  }

  const producedPath = path.join(workDir, produced);
  const { size } = await stat(producedPath);
  if (!size) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw new ConversionError(`${originalName} converted to an empty PDF.`);
  }
  return producedPath;
}

/**
 * Wraps an uploaded photo or scan in a single-page PDF.
 *
 * The image is normalised first: rotated upright from its EXIF orientation
 * (phone cameras record sideways pixels), flattened onto white so a
 * transparent PNG does not recognise as black-on-black, capped on its longest
 * edge, and encoded as JPEG. Then img2pdf embeds that JPEG as-is -- no
 * re-encoding, and a page sized so rendering it back at the same DPI reproduces
 * the original pixels exactly, neither upscaled nor thrown away.
 *
 * LibreOffice can also open an image, but it re-encodes it and forces the
 * result onto a Letter page, which shrinks a tall scan and costs detail. This
 * path is also about four times faster.
 */
export async function imageToPdf(sourcePath: string, originalName: string): Promise<string> {
  const workDir = await mkdtemp(path.join(config.tempDir, 'image-'));
  const normalised = path.join(workDir, 'page.jpg');
  const output = path.join(workDir, 'page.pdf');

  try {
    const image = sharp(sourcePath, { limitInputPixels: 512 * 1024 * 1024, animated: false });
    const metadata = await image.metadata();
    const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    if (!longestEdge) {
      throw new ConversionError(`${originalName} is not an image this service can read.`);
    }

    await image
      .rotate()
      .flatten({ background: '#ffffff' })
      // `fit: inside` with only one dimension caps the longest edge whichever
      // way round the picture is. Past this, extra pixels cost recognition time
      // without revealing more text.
      .resize({
        width: longestEdge > config.imageMaxEdge ? config.imageMaxEdge : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: config.imageJpegQuality, mozjpeg: true })
      .toFile(normalised);

    await execFileAsync(config.pythonBin, [
      path.join(config.pythonDir, 'image_to_pdf.py'), normalised, output, String(config.renderDpi),
    ], { timeout: config.conversionTimeoutMs, maxBuffer: 4 * 1024 * 1024 });

    const { size } = await stat(output);
    if (!size) throw new ConversionError(`${originalName} produced an empty PDF.`);
    return output;
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ConversionError) throw error;
    throw new ConversionError(
      `Could not read ${originalName} as an image: ${(error as Error).message.split('\n')[0]}`,
    );
  }
}

/** Replaces the extension so a converted upload is recorded as the PDF it became. */
export function pdfNameFor(originalName: string) {
  const extension = extensionOf(originalName);
  return (CONVERTIBLE_EXTENSIONS as readonly string[]).includes(extension)
    ? `${originalName.slice(0, -extension.length)}.pdf`
    : originalName;
}

let imageCheck: Promise<{ ok: boolean; detail: string }> | undefined;

/**
 * Whether an uploaded photo can be wrapped in a PDF.
 *
 * Separate from the LibreOffice check because it is a different dependency
 * failing for a different reason: img2pdf lives in the Python environment, so a
 * virtualenv built before it was added passes every other check and then fails
 * only when someone uploads a picture.
 */
export function checkImageConverter() {
  imageCheck ??= execFileAsync(config.pythonBin, ['-c', 'import img2pdf, PIL; print(img2pdf.__version__)'], { timeout: 30_000 })
    .then(({ stdout }) => ({ ok: true, detail: `img2pdf ${stdout.trim()}` }))
    .catch((error: unknown) => ({
      ok: false,
      detail: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'the Python interpreter in PYTHON_BIN was not found'
        : (error as Error).message.split('\n').filter(Boolean).at(-1) ?? 'unavailable',
    }));
  return imageCheck;
}

let converterCheck: Promise<{ ok: boolean; detail: string }> | undefined;

export function checkConverter() {
  converterCheck ??= execFileAsync(config.libreOfficeBin, ['--version'], { timeout: 30_000 })
    .then(({ stdout, stderr }) => ({ ok: true, detail: (stdout || stderr).split(/\r?\n/)[0]?.trim() || 'libreoffice' }))
    .catch((error: unknown) => ({
      ok: false,
      detail: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'not installed; only PDF uploads will work'
        : (error as Error).message.split('\n')[0] ?? 'unavailable',
    }));
  return converterCheck;
}
