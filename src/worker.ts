/**
 * The standalone worker entry point, kept only to fail clearly.
 *
 * This used to be a second Render service reading pages off a queue in
 * Postgres. There is no such queue any more: the workspace is the API process's
 * own memory, so a worker started here would hold an empty one, find nothing to
 * do, and leave every upload waiting forever -- with nothing in the log saying
 * why. Refusing to start says it instead.
 */
console.error(
  'The standalone OCR worker no longer exists. Uploads, the page queue and recognised '
  + 'pages all live in the API process\'s memory, so a separate worker would share none '
  + 'of them. Run `npm start` (or `npm run dev`) and let the worker run inside the API; '
  + 'scale recognition with OCR_CONCURRENCY and the container\'s CPU instead.',
);
process.exit(1);
