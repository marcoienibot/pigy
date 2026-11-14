import { type HealthResponse, healthResponseSchema } from "@pigy/core";

export async function fetchHealth(
  signal: AbortSignal,
): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) {
    throw new Error(`GET /api/health returned ${response.status}`);
  }
  return healthResponseSchema.parse(await response.json());
}
