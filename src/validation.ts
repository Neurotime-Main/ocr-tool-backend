import { z } from 'zod';

export const highlightSchema = z.object({
  id: z.string().optional(),
  pageNumber: z.number().int().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  opacity: z.number().min(0.05).max(1),
  source: z.enum(['AUTO', 'MANUAL']),
  keyword: z.string().max(250).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
}).refine((value) => value.x + value.width <= 1.001 && value.y + value.height <= 1.001, {
  message: 'Highlight must fit inside the page.',
});

export const highlightListSchema = z.object({
  highlights: z.array(highlightSchema).max(50000),
});

export const documentIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(30),
});

export const documentSearchSchema = documentIdsSchema.extend({
  keywords: z.array(z.string().trim().min(1).max(250)).min(1).max(100),
});

export const findingSchema = z.object({
  fileName: z.string().min(1).max(500),
  pageNumber: z.number().int().positive(),
  title: z.string().max(1000),
  keyword: z.string().max(250),
  matchedText: z.string().max(1000),
  context: z.string().max(4000),
  source: z.enum(['AUTO', 'MANUAL']),
  note: z.string().max(1000),
  confidence: z.number().min(0).max(100).nullable(),
});

export const findingsReportSchema = z.object({
  findings: z.array(findingSchema).max(100000),
});
