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

/**
 * Which of `workspaces`, those of whoever is signed in, an app shows: the
 * one that the first of `choices` names which is the ID of one of them.
 * The choices are what the app remembers of what the person chose, the one
 * that counts most first. A choice that names none of the workspaces is
 * passed over: it is somebody else's, who used the device before.
 *
 * Somebody who has never chosen starts in the sandbox, where nothing they
 * try reaches a real network. Undefined only for a person without
 * workspaces, which nobody is.
 */
export function workspaceToShow(
  workspaces: readonly Workspace[],
  choices: readonly (string | null | undefined)[],
): Workspace | undefined {
  for (const choice of choices) {
    const chosen = workspaces.find(({ id }) => id === choice);
    if (chosen) return chosen;
  }
  return (
    workspaces.find(({ environment }) => environment === "sandbox") ??
    workspaces[0]
  );
}
