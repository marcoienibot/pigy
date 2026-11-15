import {
  type AddAllowedEmailRequest,
  type AllowedEmail,
  allowedEmailListResponseSchema,
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type MeResponse,
  meResponseSchema,
  type Role,
  type Workspace,
  workspaceListResponseSchema,
} from "@pigy/core";

/** An answer of the API that is not a success. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API and throws an `ApiError` unless it answers with success. */
async function request(
  path: string,
  init: {
    method?: string;
    json?: unknown;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const response = await fetch(path, {
    method,
    ...(init.json !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init.json),
    }),
    ...(init.signal && { signal: init.signal }),
  });
  if (response.ok) return response;

  const body = errorResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  throw new ApiError(
    response.status,
    // The API explains its errors. Anything else in between does not.
    body.data?.message ?? `${method} ${path} returned ${response.status}`,
  );
}

export async function fetchHealth(
  signal: AbortSignal,
): Promise<HealthResponse> {
  const response = await request("/api/health", { signal });
  return healthResponseSchema.parse(await response.json());
}

/** Who is signed in, or null if nobody is. */
export async function fetchMe(
  signal?: AbortSignal,
): Promise<MeResponse | null> {
  try {
    const response = await request("/api/me", { signal });
    return meResponseSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** The workspaces of whoever is signed in. */
export async function fetchWorkspaces(
  signal?: AbortSignal,
): Promise<Workspace[]> {
  const response = await request("/api/workspaces", { signal });
  return workspaceListResponseSchema.parse(await response.json()).workspaces;
}

export async function signOut(): Promise<void> {
  await request("/api/auth/sign-out", { method: "POST" });
}

const allowedEmailsPath = "/api/admin/allowed-emails";

export async function fetchAllowedEmails(
  signal: AbortSignal,
): Promise<AllowedEmail[]> {
  const response = await request(allowedEmailsPath, { signal });
  return allowedEmailListResponseSchema.parse(await response.json())
    .allowedEmails;
}

export async function addAllowedEmail(
  entry: AddAllowedEmailRequest,
): Promise<void> {
  await request(allowedEmailsPath, { method: "POST", json: entry });
}

export async function updateAllowedEmail(
  email: string,
  role: Role,
): Promise<void> {
  await request(`${allowedEmailsPath}/${encodeURIComponent(email)}`, {
    method: "PATCH",
    json: { role },
  });
}

export async function removeAllowedEmail(email: string): Promise<void> {
  await request(`${allowedEmailsPath}/${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
}
