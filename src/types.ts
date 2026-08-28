export type OcrWord = {
  id: string;
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** No longer written. Present only on pages stored before it was dropped. */
  blockId?: string;
  lineId?: string;
};

export type HighlightInput = {
  id?: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  source: 'AUTO' | 'MANUAL';
  keyword?: string | null;
  note?: string | null;
};
