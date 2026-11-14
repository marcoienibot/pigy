import { z } from "zod";

/**
 * The names an error response can carry. They are Buffer's, like the rest of
 * the public API.
 */
export const errorNameSchema = z.enum([
  "InvalidInputError",
  "NotFoundError",
  "UnauthorizedError",
  "LimitReachedError",
  "UnexpectedError",
]);

export type ErrorName = z.infer<typeof errorNameSchema>;

/** Body of every error response of the API. */
export const errorResponseSchema = z.object({
  /** Clients branch on it. */
  error: errorNameSchema,
  /** Explanation for people. It never carries internal details. */
  message: z.string().min(1),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
