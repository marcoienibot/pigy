import { z } from "zod";

/** Body of every error response of the API. */
export const errorResponseSchema = z.object({
  /** Name of the error, for example `NotFoundError`. Clients branch on it. */
  error: z.string().min(1),
  /** Explanation for people. It never carries internal details. */
  message: z.string().min(1),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
