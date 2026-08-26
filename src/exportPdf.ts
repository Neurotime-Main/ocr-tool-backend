import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import type { HighlightInput } from './types.js';

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '');
  const value = /^[0-9a-f]{6}$/i.test(normalized) ? normalized : 'FDE047';
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

export async function addHighlightsToPdf(filePath: string, highlights: HighlightInput[]) {
  const pdf = await PDFDocument.load(await readFile(filePath));
  const pages = pdf.getPages();

  for (const highlight of highlights) {
    const page = pages[highlight.pageNumber - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const color = hexToRgb(highlight.color);
    page.drawRectangle({
      x: highlight.x * width,
      y: height - (highlight.y + highlight.height) * height,
      width: highlight.width * width,
      height: highlight.height * height,
      color: rgb(color.r, color.g, color.b),
      opacity: highlight.opacity,
      borderWidth: 0,
    });
  }

  return Buffer.from(await pdf.save());
}
