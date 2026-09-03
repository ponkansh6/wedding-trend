import { z } from "zod";

/**
 * Stage 1: topics-only LLM Schema
 * Input: { id: opaque record id, title: verbatim, slice: memory-only max 1500 chars }
 * Output: { id, topics: 0-4 short noun phrases }
 */

const TopicItemSchema = z
  .string()
  .min(2)
  .max(10)
  .refine((t) => !/[0-9０-９]/u.test(t), { message: "トピックに数字を含めない" });

export const TopicExtractionItemSchema = z.object({
  id: z.string().min(1),
  topics: z.array(z.unknown()).transform((arr) =>
    arr
      .map((t) => {
        const parsed = TopicItemSchema.safeParse(t);
        return parsed.success ? parsed.data : null;
      })
      .filter((t): t is string => t !== null)
      .slice(0, 4),
  ),
});

export type TopicExtractionItem = z.infer<typeof TopicExtractionItemSchema>;

export const TopicExtractionBatchResponseSchema = z.object({
  items: z.array(TopicExtractionItemSchema),
});

export type TopicExtractionBatchResponse = z.infer<typeof TopicExtractionBatchResponseSchema>;
