import { z } from "zod";

/**
 * The two worlds every user has. `live` posts to the real networks. `sandbox`
 * is for trying things out, against simulated networks.
 */
export const environments = ["live", "sandbox"] as const;

export const environmentSchema = z.enum(environments);

export type Environment = z.infer<typeof environmentSchema>;

/** One user's data in one environment. */
export const workspaceSchema = z.object({
  id: z.string().min(1),
  environment: environmentSchema,
});

export type Workspace = z.infer<typeof workspaceSchema>;

/**
 * Response of `GET /api/workspaces`: the workspaces of whoever asks, one per
 * environment, `live` first.
 */
export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
