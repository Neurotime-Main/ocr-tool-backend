import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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

/** Formats decoded directly as images by the OCR preparation path. */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.avif', '.heic', '.heif'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.3gp'] as const;

export const CONVERTIBLE_EXTENSIONS = [...OFFICE_EXTENSIONS, ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] as const;
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
const VIDEO_MIME_PREFIX = 'video/';

export const extensionOf = (fileName: string) => path.extname(fileName).toLowerCase();

/** Whether the upload endpoint should accept this file at all. */
export function isAcceptedUpload(fileName: string, mimeType: string) {
  const extension = extensionOf(fileName);
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)
    || ACCEPTED_MIME_TYPES.has(mimeType)
    || mimeType.startsWith(IMAGE_MIME_PREFIX)
    || mimeType.startsWith(VIDEO_MIME_PREFIX);
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

export function isVideoUpload(fileName: string, mimeType = '') {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
    || mimeType.startsWith(VIDEO_MIME_PREFIX);
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

export type ExtractedVideoFrames = {
  workDir: string;
  framesDir: string;
  frames: string[];
  frameIntervalSeconds: number;
};

let activeVideoConversions = 0;
const videoConversionWaiters: Array<() => void> = [];

async function acquireVideoConversionSlot() {
  if (activeVideoConversions >= config.videoConversionConcurrency) {
    await new Promise<void>((resolve) => videoConversionWaiters.push(resolve));
  }
  activeVideoConversions += 1;
  return () => {
    activeVideoConversions -= 1;
    videoConversionWaiters.shift()?.();
  };
}

/** Extract exactly one OCR image at each configured interval (one second by default). */
async function extractVideoFramesUnlocked(sourcePath: string, originalName: string): Promise<ExtractedVideoFrames> {
  const workDir = await mkdtemp(path.join(config.tempDir, 'video-'));
  const framesDir = path.join(workDir, 'frames');
  await mkdir(framesDir);

  try {
    let duration: number;
    try {
      const { stdout } = await execFileAsync(config.ffprobeBin, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sourcePath,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      duration = Number(stdout.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConversionError('This file is a video, but FFmpeg is not installed. Use the Docker image or install ffmpeg.');
      }
      throw new ConversionError(`Could not inspect ${originalName}: ${(error as Error).message.split('\n')[0]}`);
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ConversionError(`${originalName} does not report a valid video duration.`);
    }
    const interval = config.videoFrameIntervalSeconds;
    const expectedFrames = Math.ceil(duration / interval);
    if (expectedFrames > config.videoMaxFrames) {
      const allowedSeconds = config.videoMaxFrames * interval;
      const allowedDuration = allowedSeconds >= 60
        ? `about ${Math.floor(allowedSeconds / 60)} minutes`
        : `about ${allowedSeconds} seconds`;
      throw new ConversionError(
        `${originalName} is too long for ${1 / interval} frame/second OCR `
        + `(${expectedFrames} frames; maximum ${config.videoMaxFrames}, ${allowedDuration}).`,
      );
    }

    await execFileAsync(config.ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
      // `min(iw/ih, cap)` prevents small videos from being enlarged just to be
      // shrunk again by Paddle's detector.
      '-vf', `fps=1/${interval}:start_time=0,scale=w='min(${config.videoMaxEdge},iw)':h='min(${config.videoMaxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-frames:v', String(config.videoMaxFrames), '-q:v', '2', '-pix_fmt', 'yuvj444p',
      path.join(framesDir, 'frame-%06d.jpg'),
    ], { timeout: config.videoConversionTimeoutMs, maxBuffer: 8 * 1024 * 1024 });

    const frames = (await readdir(framesDir))
      .filter((name) => name.endsWith('.jpg'))
      .sort()
      .map((name) => path.join(framesDir, name));
    if (!frames.length) throw new ConversionError(`${originalName} contains no readable video frames.`);
    return { workDir, framesDir, frames, frameIntervalSeconds: interval };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ConversionError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConversionError('Video OCR requires FFmpeg. Use the project Docker image or install ffmpeg locally.');
    }
    throw new ConversionError(`Could not read ${originalName} as a video: ${(error as Error).message.split('\n')[0]}`);
  }
}

export async function extractVideoFrames(sourcePath: string, originalName: string): Promise<ExtractedVideoFrames> {
  const release = await acquireVideoConversionSlot();
  try {
    return await extractVideoFramesUnlocked(sourcePath, originalName);
  } finally {
    release();
  }
}

/** Packages already-recognised images for the existing page viewer and publisher. */
export async function imagesToPdfDirectory(imagesDir: string, outputPath: string) {
  try {
    await execFileAsync(config.pythonBin, [
      path.join(config.pythonDir, 'images_to_pdf.py'), imagesDir, outputPath, String(config.renderDpi),
    ], { timeout: config.videoConversionTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const { size } = await stat(outputPath);
    if (!size) throw new ConversionError('The viewer PDF was empty.');
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new ConversionError(`Could not prepare the viewer document: ${(error as Error).message.split('\n')[0]}`);
  }
  return outputPath;
}

export async function checkVideoConverter() {
  try {
    const { stdout, stderr } = await execFileAsync(config.ffmpegBin, ['-version'], { timeout: 10_000 });
    return { ok: true, detail: (stdout || stderr).split(/\r?\n/)[0]?.trim() || 'ffmpeg' };
  } catch (error) {
    return {
      ok: false,
      detail: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'not installed; video uploads will not work'
        : (error as Error).message.split('\n')[0] ?? 'unavailable',
    };
  }
}

let imageCheck: Promise<{ ok: boolean; detail: string }> | undefined;

/** Whether recognised visual pages can be packaged for the viewer/publisher. */
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
