import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config, ocrScriptsForLanguage } from './config.js';
import { ocrPool, type RecognizedLine } from './ocrEngine.js';
import { repairRecognizedLines } from './azerbaijani.js';

/**
 * Reading one image and returning its text, with nothing else attached.
 *
 * This is the second thing this service does. The document side of the app owns
 * a whole lifecycle -- an upload is stored, split into pages, queued, recognised
 * by a worker, searched for keywords, highlighted and published -- and that
 * machinery exists because a person is going to come back to those pages later.
 *
 * A caller that just wants the words out of one picture needs none of it. The
 * Instagram scraper hands over a post image, waits, and writes the answer to its
 * own files; a document row, a queue entry and an object in the bucket would all
 * be rubbish left behind after the reply was sent. So this path shares exactly
 * one thing with the document pipeline -- the pool of recognition daemons, which
 * is the expensive part worth sharing -- and touches no database and no storage.
 *
 * Sharing the pool also means the two uses cannot swamp the machine between
 * them: a request here waits for a free recogniser the same way a queued page
 * does, rather than starting processes of its own alongside a running batch.
 */

export type RecognizedImageLine = {
  text: string;
  /** How sure the recogniser is, as a percentage (0-100). */
  confidence: number;
  /** [x, y, width, height], as fractions of the image. */
  box: [number, number, number, number];
};

export type RecognizedImage = {
  text: string;
  lines: RecognizedImageLine[];
  wordCount: number;
  languages: string;
  image: { width: number; height: number };
  durationMs: number;
};

/**
 * Puts recognised lines into the order a person would read them.
 *
 * The detector returns boxes in whatever order it found them, which on a poster
 * or a post image is not top-to-bottom: a caption underneath can arrive before
 * the headline above it, and the joined text then reads as a shuffled list. So
 * the lines are sorted down the image, and lines sitting side by side on the
 * same row are sorted left to right within it.
 *
 * "The same row" has to be a tolerance rather than an equality, because two
 * words of one line rarely share a pixel-exact top edge. Half the line's height
 * is the usual rule and holds up on these images.
 */
/**
 * Groups the detected boxes into the rows a reader would see.
 *
 * The detector finds boxes, not sentences: a single line of a poster often
 * arrives as three separate boxes, and a caption laid over an image can arrive
 * as a dozen. Emitting one output line per box turns an ordinary sentence into
 * a column of fragments, which is most of why extracted captions read as
 * gibberish even when every word in them is right.
 *
 * So boxes whose vertical centres sit within half a line height of each other
 * are one row, ordered left to right and joined with a space; rows are ordered
 * top to bottom. Grouping is done by walking the boxes in vertical order rather
 * than by a comparator, because "same row" is not transitive -- a chain of
 * boxes each slightly lower than the last would sort inconsistently.
 */
function intoRows(lines: RecognizedLine[]) {
  const byTop = [...lines].sort((a, b) => (a.box[1] + a.box[3] / 2) - (b.box[1] + b.box[3] / 2));
  const rows: RecognizedLine[][] = [];
  let current: RecognizedLine[] = [];
  let anchor = 0;
  let anchorHeight = 0;

  for (const line of byTop) {
    const centre = line.box[1] + line.box[3] / 2;
    const height = Math.max(line.box[3], 1e-6);
    if (current.length && Math.abs(centre - anchor) > Math.max(anchorHeight, height) / 2) {
      rows.push(current);
      current = [];
    }
    if (!current.length) {
      anchor = centre;
      anchorHeight = height;
    }
    current.push(line);
  }
  if (current.length) rows.push(current);

  return rows.map((row) => [...row].sort((a, b) => a.box[0] - b.box[0]));
}

export class ImageRecognitionError extends Error {
  override readonly name = 'ImageRecognitionError';
}

/**
 * Prepares a picture for the recogniser.
 *
 * Phone and social images arrive rotated by EXIF, occasionally with an alpha
 * channel, and sometimes far larger than anything the detector will look at.
 * Normalising here means the daemon only ever sees an ordinary upright JPEG,
 * exactly as it does for a rasterised PDF page.
 *
 * Colour is kept, unlike the PDF path which renders grey: a scanned page is
 * black on white, but a post image is as likely to be pale text over a
 * photograph, where the colour channels carry some of the contrast.
 */
async function normalise(sourcePath: string, workDir: string, originalName: string) {
  const target = path.join(workDir, 'image.jpg');
  const image = sharp(sourcePath, { limitInputPixels: 512 * 1024 * 1024, animated: false });

  const metadata = await image.metadata().catch(() => undefined);
  const longestEdge = Math.max(metadata?.width ?? 0, metadata?.height ?? 0);
  if (!longestEdge) {
    throw new ImageRecognitionError(`${originalName} is not an image this service can read.`);
  }

  // `toFile` reports what it actually wrote; `fit: inside` lands a pixel or two
  // under the requested cap, so the written size is the one to trust.
  const info = await image
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({
      width: longestEdge > config.imageMaxEdge ? config.imageMaxEdge : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: config.imageJpegQuality, mozjpeg: true })
    .toFile(target);

  return { target, width: info.width, height: info.height };
}

/**
 * Reads every line of text in one image file.
 *
 * `sourcePath` is consumed, not kept: the caller owns it and is free to delete
 * it as soon as this resolves.
 */
export async function recognizeImageFile(
  sourcePath: string,
  originalName: string,
  languages: string,
  signal: AbortSignal,
): Promise<RecognizedImage> {
  const startedAt = Date.now();
  const workDir = await mkdtemp(path.join(config.tempDir, 'recognize-'));

  try {
    const { target, width, height } = await normalise(sourcePath, workDir, originalName);
    // Asking the detector for more than the picture holds only costs time.
    const maxSide = Math.min(config.ocrDetectionMaxSide, Math.max(width, height));
    // The Latin model cannot emit a lowercase schwa, so Azerbaijani comes back
    // with its commonest letter missing until this puts it back.
    const lines: RecognizedLine[] = repairRecognizedLines(
      await ocrPool().run(target, maxSide, ocrScriptsForLanguage(languages), signal),
      languages,
    );

    const rows = intoRows(lines);
    const ordered = rows.flat();
    const text = rows
      .map((row) => row.map((line) => line.text.trim()).filter(Boolean).join(' '))
      .filter(Boolean)
      .join('\n');
    return {
      text,
      lines: ordered.map((line) => ({
        text: line.text,
        confidence: line.confidence,
        box: line.box.map((value) => Number(value.toFixed(5))) as [number, number, number, number],
      })),
      wordCount: text.split(/\s+/).filter(Boolean).length,
      languages,
      image: { width, height },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
