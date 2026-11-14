import { z } from "zod";

/** Response of `GET /api/health`. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  /** ID of the deployed Worker version. */
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
