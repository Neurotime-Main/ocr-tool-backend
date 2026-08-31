import { prisma } from './src/db.ts';

// Pages abandoned when the server was restarted for benchmarking. The attempt
// never actually ran, so it is given back rather than counted against the page.
const { count } = await prisma.ocrPage.updateMany({
  where: { status: 'PROCESSING', document: { queueNamespace: 'development' } },
  data: { status: 'PENDING', lockedBy: null, startedAt: null, attempts: { decrement: 1 } },
});
console.log(`released ${count} pages`);
await prisma.$disconnect();
