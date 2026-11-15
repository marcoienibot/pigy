import { z } from "zod";

/** The networks pigy publishes to. */
export const networks = ["bluesky", "linkedin", "mastodon", "threads"] as const;

export const networkSchema = z.enum(networks);

export type Network = z.infer<typeof networkSchema>;
