import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { config, type OcrScript } from './config.js';
import type { OcrWord } from './types.js';

export type RecognizedLine = {
  text: string;
  confidence: number;
  /** [x, y, width, height], normalised to the page. */
  box: [number, number, number, number];
  /**
   * Where each character of `text` sits across the line box, as a fraction of
   * its width, taken from the timestep the recogniser emitted it at.
   *
   * Absent only if the daemon could not supply it, in which case the caller
   * falls back to spacing words evenly -- which is what this replaced.
   */
  charOffsets?: number[];
};

export class OcrEngineError extends Error {}

let nextRequestId = 1;

/**
 * One PaddleOCR daemon: a Python process holding the PP-OCRv5 models.
 *
 * Loading the three models takes long enough that a process per page would
 * spend most of its life starting up, so a daemon is kept alive and fed one
 * page at a time. It is treated as disposable -- any protocol violation,
 * crash, or timeout retires it and the pool starts a replacement -- because a
 * recogniser that has gone wrong is not worth diagnosing in-band.
 */
class Daemon {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<string, { resolve: (lines: RecognizedLine[]) => void; reject: (error: Error) => void }>();
  private lastStderr: string[] = [];
  private broken = false;

  constructor(private readonly index: number) {}

  private start() {
    const script = path.join(config.pythonDir, 'ppocr_daemon.py');
    const child = spawn(config.pythonBin, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PPOCR_MODEL_DIR: config.ocrModelDir,
        PPOCR_THREADS: String(config.ocrThreadsPerWorker),
        PPOCR_DET_MAX_SIDE: String(config.ocrDetectionMaxSide),
        // Native libraries otherwise size themselves from the Render host,
        // not this container's CPU quota. Dozens of threads fighting over one
        // allotted CPU makes dense pages slower, not faster.
        OMP_NUM_THREADS: String(config.ocrThreadsPerWorker),
        OPENBLAS_NUM_THREADS: String(config.ocrThreadsPerWorker),
        MKL_NUM_THREADS: String(config.ocrThreadsPerWorker),
        NUMEXPR_NUM_THREADS: String(config.ocrThreadsPerWorker),
      },
    });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      // Kept as a short ring buffer so a crash can be explained with the
      // traceback that preceded it rather than a bare exit code.
      this.lastStderr.push(line);
      if (this.lastStderr.length > 20) this.lastStderr.shift();
    });

    const fail = (reason: string) => {
      this.broken = true;
      const error = new OcrEngineError(`${reason}${this.lastStderr.length ? `: ${this.lastStderr.slice(-4).join(' | ')}` : ''}`);
      for (const [, waiter] of this.pending) waiter.reject(error);
      this.pending.clear();
      // A process that dies before it reports itself ready has to fail the
      // startup promise too. Without this the caller waits out the full startup
      // timeout and is then told the engine "did not become ready", which hides
      // the exit code and traceback that say why -- the single least helpful
      // message this class can produce.
      this.readyReject(error);
    };
    child.on('exit', (code, signal) => fail(`The OCR engine stopped (code ${code ?? 'null'}, signal ${signal ?? 'none'})`));
    child.on('error', (error) => fail(`The OCR engine could not be started (${error.message})`));

    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new OcrEngineError(`The OCR engine did not become ready within ${config.ocrStartupTimeoutMs} ms.`)),
        config.ocrStartupTimeoutMs,
      );
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
      this.readyReject = (error) => { clearTimeout(timer); reject(error); };
    });
    return this.ready;
  }

  private readyResolve: () => void = () => undefined;
  private readyReject: (error: Error) => void = () => undefined;

  private handleLine(line: string) {
    let message: { id?: string; ready?: boolean; lines?: RecognizedLine[]; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return; // Non-JSON output is diagnostic noise, not a reply.
    }
    if (message.ready) { this.readyResolve(); return; }
    if (message.id == null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new OcrEngineError(message.error));
    else waiter.resolve(message.lines ?? []);
  }

  async ensureStarted() {
    if (this.broken) throw new OcrEngineError('This OCR engine process has already failed.');
    if (!this.ready) {
      this.start();
      try {
        await this.ready;
      } catch (error) {
        this.broken = true;
        this.readyReject(error as Error);
        throw error;
      }
    }
    return this.ready;
  }

  get isBroken() { return this.broken; }

  async recognize(imagePath: string, maxSide: number, languages: OcrScript[], signal: AbortSignal): Promise<RecognizedLine[]> {
    await this.ensureStarted();
    const id = String(nextRequestId++);
    return new Promise<RecognizedLine[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The page is abandoned and so is the daemon: a request that never
        // came back leaves the protocol out of step for every later page.
        this.dispose();
        reject(new OcrEngineError(`Recognition timed out after ${config.ocrPageTimeoutMs} ms.`));
      }, config.ocrPageTimeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.dispose();
        reject(new OcrEngineError('Cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: (lines) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(lines); },
        reject: (error) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(error); },
      });
      this.child!.stdin.write(`${JSON.stringify({ id, image: imagePath, maxSide, languages })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new OcrEngineError(`Could not reach the OCR engine: ${error.message}`));
      });
    });
  }

  dispose() {
    this.broken = true;
    this.child?.kill('SIGKILL');
  }

  describe() {
    return `daemon#${this.index}`;
  }
}

/**
 * A fixed pool of daemons handed out one page at a time.
 *
 * Sizing is by CPU: recognition is compute bound, so more daemons than cores
 * only makes the same pages finish later. A daemon that dies is replaced on its
 * next use rather than eagerly, so a worker with nothing to do holds no
 * processes it is not using.
 */
class DaemonPool {
  private daemons: Array<Daemon | undefined> = [];
  private idleTimers: Array<NodeJS.Timeout | undefined> = [];
  private idle: number[] = [];
  private waiting: Array<(index: number) => void> = [];

  constructor(size: number) {
    this.daemons = new Array(size).fill(undefined);
    this.idle = Array.from({ length: size }, (_value, index) => index);
  }

  private async acquire(): Promise<number> {
    const free = this.idle.pop();
    if (free !== undefined) return free;
    return new Promise<number>((resolve) => this.waiting.push(resolve));
  }

  private release(index: number) {
    const waiter = this.waiting.shift();
    if (waiter) waiter(index);
    else this.idle.push(index);
  }

  async run(imagePath: string, maxSide: number, languages: OcrScript[], signal: AbortSignal) {
    const index = await this.acquire();
    this.cancelIdleTimer(index);
    try {
      let daemon = this.daemons[index];
      if (!daemon || daemon.isBroken) {
        daemon = new Daemon(index);
        this.daemons[index] = daemon;
      }
      try {
        return await daemon.recognize(imagePath, maxSide, languages, signal);
      } catch (error) {
        // Retire a daemon that failed, so the slot comes back clean. The page
        // itself is retried by the queue, on a fresh process.
        if (daemon.isBroken) this.daemons[index] = undefined;
        throw error;
      }
    } finally {
      this.scheduleIdleShutdown(index);
      this.release(index);
    }
  }

  private cancelIdleTimer(index: number) {
    const timer = this.idleTimers[index];
    if (timer) {
      clearTimeout(timer);
      this.idleTimers[index] = undefined;
    }
  }

  /**
   * Releases a slot's daemon once it has gone unused for a while.
   *
   * Most pages in these documents are read from the PDF's own text layer and
   * never reach the recogniser, so a pool that ran once and then idled was
   * holding several hundred megabytes each for work that had already finished
   * -- memory the document reader needs, on a container that does not have it
   * spare. Restarting is cheap enough that keeping them warm is not worth it.
   */
  private scheduleIdleShutdown(index: number) {
    this.cancelIdleTimer(index);
    const timer = setTimeout(() => {
      this.idleTimers[index] = undefined;
      this.daemons[index]?.dispose();
      this.daemons[index] = undefined;
    }, config.ocrIdleTimeoutMs);
    // Must not keep the process alive on its own account.
    timer.unref?.();
    this.idleTimers[index] = timer;
  }

  async shutdown() {
    for (const timer of this.idleTimers) if (timer) clearTimeout(timer);
    this.idleTimers = [];
    for (const daemon of this.daemons) daemon?.dispose();
    this.daemons = [];
  }
}

let pool: DaemonPool | undefined;

export function ocrPool() {
  pool ??= new DaemonPool(config.ocrConcurrency);
  return pool;
}

export async function shutdownOcrEngine() {
  await pool?.shutdown();
  pool = undefined;
}

/**
 * Splits a recognised line into word boxes.
 *
 * PP-OCR reports a box per text line rather than per word, while the viewer,
 * the keyword matcher and the Excel report all address words. Character counts
 * are the only proportional information the line offers, so each word is given
 * the slice of the line its characters occupy -- accurate enough to highlight,
 * and identical in shape to what the PDF text path produces.
 */
/**
 * Turns a recognised line into one box per word.
 *
 * The line box covers the whole strip the detector found, so each word's share
 * of it has to be worked out. `charOffsets` gives the centre of every
 * character, so a word's edges are the midpoints between its own outermost
 * characters and their neighbours -- the gap between two words is split evenly
 * between them, which is where a reader would put the boundary too.
 *
 * Dividing the strip by character count instead, as this did before, assumes
 * every letter is the same width. It is not: on a line beginning with wide
 * capitals every following word is estimated too far left, which is exactly the
 * drift that showed up as highlights sitting beside their word rather than on
 * it.
 */
export function lineToWords(line: RecognizedLine, pageNumber: number, lineIndex: number): OcrWord[] {
  const [lineX, lineY, lineWidth, lineHeight] = line.box;
  const tokens = [...line.text.matchAll(/\S+/g)];
  if (!tokens.length) return [];

  const centres = line.charOffsets?.length === line.text.length ? line.charOffsets : undefined;
  const totalCharacters = Math.max(line.text.length, 1);

  const edges = (first: number, last: number) => {
    if (!centres) {
      // No positions from the recogniser: fall back to even spacing.
      return [first / totalCharacters, (last + 1) / totalCharacters] as const;
    }
    const before = first > 0 ? centres[first - 1]! : undefined;
    const after = last + 1 < centres.length ? centres[last + 1]! : undefined;
    const head = centres[first]!;
    const tail = centres[last]!;
    // At the ends of the line there is no neighbour to split the gap with, so
    // the word is extended by half its own average character width instead.
    const ownHalf = Math.max((tail - head) / Math.max(last - first, 1), 0) / 2;
    return [
      before === undefined ? Math.max(0, head - ownHalf) : (before + head) / 2,
      after === undefined ? Math.min(1, tail + ownHalf) : (tail + after) / 2,
    ] as const;
  };

  return tokens.map((token, tokenIndex) => {
    const first = token.index ?? 0;
    const [start, end] = edges(first, first + token[0].length - 1);
    return {
      id: `p${pageNumber}-ocr-${lineIndex}-${tokenIndex}`,
      text: token[0],
      confidence: line.confidence,
      x: lineX + lineWidth * start,
      y: lineY,
      width: Math.max(lineWidth * (end - start), 0.0005),
      height: lineHeight,
      lineId: `p${pageNumber}-ocr-${lineIndex}`,
    };
  });
}

/**
 * Confirms the recognition engine can start and load its models. The health
 * endpoint gates a Render deploy, so an image built without the models fails
 * that deploy instead of failing on every page the first worker picks up.
 */
let engineCheck: Promise<{ ok: boolean; detail: string }> | undefined;

export function checkOcrEngine() {
  engineCheck ??= (async () => {
    const daemon = new Daemon(-1);
    try {
      await daemon.ensureStarted();
      return { ok: true, detail: `PaddleOCR PP-OCRv5 (ONNX Runtime, ${config.ocrConcurrency} worker${config.ocrConcurrency === 1 ? '' : 's'})` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    } finally {
      daemon.dispose();
    }
  })();
  return engineCheck;
}
