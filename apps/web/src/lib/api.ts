import {
  type AddAllowedEmailRequest,
  type AllowedEmail,
  allowedEmailListResponseSchema,
  type ConnectRequest,
  connectResponseSchemaFor,
  type DisconnectResponse,
  disconnectResponseSchema,
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
    /**
     * The field of the request that the message is about, if the API named
     * one: a form shows the message next to that input.
     */
    readonly field: string | undefined = undefined,
  ) {
    super(message);
  }
}

/**
 * A call to the API that got no answer, which `request` throws: see
 * `unanswered`. The message is the browser's.
 */
class Unanswered extends Error {
  constructor(cause: TypeError) {
    super(cause.message, { cause });
  }
}

/**
 * Whether a call to the API failed because no answer came: the device has
 * no connection, or the server cannot be reached from it. Every other
 * failure is an answer, a status that says that something went wrong at
 * the server or a body that is not what the API sends, or a mistake of the
 * app. A connection that comes back cures none of those.
 */
export function unanswered(error: unknown): boolean {
  return error instanceof Unanswered;
}

/**
 * Calls the API and throws an `ApiError` unless it answers with success.
 * When no answer comes, it throws what `unanswered` goes by.
 */
async function request(
  path: string,
  init: {
    method?: string;
    json?: unknown;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(init.json !== undefined && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(init.json),
      }),
      ...(init.signal && { signal: init.signal }),
    });
  } catch (error) {
    // `fetch` fails with a `TypeError` when no answer comes, as the Fetch
    // standard has it, and with nothing else then. The app throws one too,
    // for a mistake in its code, which is why it is told apart here, where
    // it can only be the first. What else `fetch` throws, such as the
    // `AbortError` of a request that was given up, is passed on as it is.
    throw error instanceof TypeError ? new Unanswered(error) : error;
  }
  if (response.ok) return response;

  const body = errorResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  throw new ApiError(
    response.status,
    // The API explains its errors. Anything else in between does not.
    body.data?.message ?? `${method} ${path} returned ${response.status}`,
    body.data?.field,
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

/**
 * Begins to connect an account to a workspace, and returns the address to
 * send the browser to: the consent page of the network, or of a simulated
 * one. A refusal is an `ApiError` with a message for the person, and with
 * the `field` that it is about: `ConnectError` in `@pigy/core` has what
 * each status means. `signal` gives the request up.
 */
export async function beginConnect(
  workspaceId: string,
  connect: ConnectRequest,
  signal: AbortSignal,
): Promise<string> {
  const response = await request(`/api/workspaces/${workspaceId}/connect`, {
    method: "POST",
    json: connect,
    signal,
  });
  // An address that this page may navigate to, and nothing else.
  return connectResponseSchemaFor(location.origin).parse(await response.json())
    .url;
}

/**
 * Disconnects a channel, and answers whether its network took the access
 * back. The channel is gone either way.
 */
export async function disconnectChannel(
  workspaceId: string,
  channelId: string,
): Promise<DisconnectResponse> {
  const response = await request(
    `/api/workspaces/${workspaceId}/channels/${channelId}`,
    { method: "DELETE" },
  );
  return disconnectResponseSchema.parse(await response.json());
}
