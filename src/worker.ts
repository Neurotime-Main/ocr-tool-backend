/**
 * Standalone OCR worker entry point.
 *
 * Started by the `markwise-worker` Render service. It shares this image and
 * this codebase with the API but serves no HTTP: it only reads pages off the
 * queue. Scaling recognition is therefore a matter of raising this service's
 * instance count or CPU, with no effect on API latency.
 */
import { runWorkerService } from './ocrWorker.js';

await runWorkerService();
