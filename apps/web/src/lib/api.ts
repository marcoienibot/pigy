import {
  type AddAllowedEmailRequest,
  type AllowedEmail,
  type ApiKey,
  allowedEmailListResponseSchema,
  apiKeyListResponseSchema,
  type ConnectRequest,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  connectResponseSchemaFor,
  createApiKeyResponseSchema,
  type DisconnectResponse,
  disconnectResponseSchema,
  errorResponseSchema,
  type HealthResponse,
  healthResponseSchema,
  type LinkCard,
  type LinkCardRequest,
  linkCardResponseSchema,
  type MentionsRequest,
  type MeResponse,
  mentionsResponseSchema,
  meResponseSchema,
  type Network,
  type PushSubscriptionRequest,
  pushConfigResponseSchema,
  pushStateResponseSchema,
  type Role,
  type SandboxFault,
  type SandboxFaults,
  type SandboxFeed,
  type Schedule,
  sandboxFaultsSchema,
  sandboxFeedMarks,
  sandboxFeedSchema,
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
  constructor(message: string, cause: unknown) {
    super(message, { cause });
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
 * How long the server is given to say who is signed in, in milliseconds.
 * A network that leads nowhere, as behind the sign-in page of a hotel,
 * takes a request and never answers it. The browser would wait for
 * minutes, and with it the sign-in page and the start of the app on a
 * device that knows nobody, which show nothing before they have the
 * answer. A server that is there answers in a fraction of this.
 */
export const answerWithinMs = 10_000;

const timer: Schedule = (callback, delayMs) => {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
};

/**
 * Has `ask` call the API, and gives it up when it has not finished after
 * `answerWithinMs`: it then fails as a call that got no answer, see
 * `unanswered`. The time is for all that `ask` does with the signal it is
 * handed, the reading of an answer included, and not for each request.
 * `signal` gives it up before that, and it then fails with what the
 * request fails with, as without this.
 */
export async function answeredInTime<Answer>(
  ask: (signal: AbortSignal) => Promise<Answer>,
  signal?: AbortSignal,
  schedule: Schedule = timer,
): Promise<Answer> {
  const request = new AbortController();
  const giveUp = () => request.abort(signal?.reason);
  if (signal?.aborted) giveUp();
  signal?.addEventListener("abort", giveUp);
  let late = false;
  const cancel = schedule(() => {
    late = true;
    request.abort();
  }, answerWithinMs);
  try {
    return await ask(request.signal);
  } catch (error) {
    throw late
      ? new Unanswered(
          `No answer within ${answerWithinMs / 1000} seconds`,
          error,
        )
      : error;
  } finally {
    cancel();
    signal?.removeEventListener("abort", giveUp);
  }
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
    throw error instanceof TypeError
      ? new Unanswered(error.message, error)
      : error;
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

/**
 * What the simulated world of the sandbox of whoever is signed in has
 * published, by account. Not synced: the world is the networks', and pigy
 * keeps no copy of it.
 */
export async function fetchSandboxFeed(
  signal: AbortSignal,
): Promise<SandboxFeed> {
  // With the marks and the card of each post, which are answered only
  // to whoever asks for them.
  const response = await request(`/api/sandbox/feed?${sandboxFeedMarks}=1`, {
    signal,
  });
  return sandboxFeedSchema.parse(await response.json());
}

const faultsPath = "/api/sandbox/faults";

/** The ways the simulated networks can be made to fail, and what is armed. */
export async function fetchSandboxFaults(
  signal: AbortSignal,
): Promise<SandboxFaults> {
  const response = await request(faultsPath, { signal });
  return sandboxFaultsSchema.parse(await response.json());
}

/**
 * Arms `fault`: the next request of its kind to its network fails that
 * way, once. A fault that the network does not have is refused with an
 * `ApiError` that names its `field`.
 */
export async function armSandboxFault(
  fault: SandboxFault,
): Promise<SandboxFaults> {
  const response = await request(faultsPath, { method: "POST", json: fault });
  return sandboxFaultsSchema.parse(await response.json());
}

/** Disarms every fault of every simulated network. */
export async function disarmSandboxFaults(): Promise<SandboxFaults> {
  const response = await request(faultsPath, { method: "DELETE" });
  return sandboxFaultsSchema.parse(await response.json());
}

const pushPath = "/api/push";

/**
 * The public key that a page subscribes to push messages with, or null
 * for a pigy that is not set up to send any.
 */
export async function fetchPushKey(
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await request(pushPath, { signal });
    return pushConfigResponseSchema.parse(await response.json()).publicKey;
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) return null;
    throw error;
  }
}

/** Whether the server sends push messages to the browser with `endpoint`. */
export async function fetchPushState(
  endpoint: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await request(`${pushPath}/subscription/state`, {
    method: "POST",
    json: { endpoint },
    signal,
  });
  return pushStateResponseSchema.parse(await response.json()).subscribed;
}

/** Hands the server what this browser got when it subscribed. */
export async function savePushSubscription(
  subscription: PushSubscriptionRequest,
): Promise<void> {
  await request(`${pushPath}/subscription`, {
    method: "PUT",
    json: subscription,
  });
}

/** Has the server forget the subscription of this browser. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await request(`${pushPath}/subscription`, {
    method: "DELETE",
    json: { endpoint },
  });
}

/**
 * The card of the link `url`, as pigy would send it with a post of the
 * workspace, or null if the page cannot be read or says nothing of
 * itself. Not synced, and kept nowhere: it is what the page says now.
 */
export async function fetchLinkCard(
  workspaceId: string,
  url: string,
  signal?: AbortSignal,
): Promise<LinkCard | null> {
  const response = await request(`/api/workspaces/${workspaceId}/link-card`, {
    method: "POST",
    json: { url } satisfies LinkCardRequest,
    signal,
  });
  return linkCardResponseSchema.parse(await response.json()).card;
}

/**
 * Which of `names` are accounts of `network`, as a post of the workspace
 * would find them, or null on a network where pigy looks nobody up.
 */
export async function fetchMentioned(
  workspaceId: string,
  network: Network,
  names: string[],
  signal?: AbortSignal,
): Promise<string[] | null> {
  const response = await request(`/api/workspaces/${workspaceId}/mentions`, {
    method: "POST",
    json: { network, names } satisfies MentionsRequest,
    signal,
  });
  return mentionsResponseSchema.parse(await response.json()).known;
}

const apiKeysPath = (workspaceId: string) =>
  `/api/workspaces/${workspaceId}/api-keys`;

/** The keys of the public API that a workspace has, the newest first. */
export async function fetchApiKeys(
  workspaceId: string,
  signal: AbortSignal,
): Promise<ApiKey[]> {
  const response = await request(apiKeysPath(workspaceId), { signal });
  return apiKeyListResponseSchema.parse(await response.json()).apiKeys;
}

/**
 * Makes a key for a workspace. The answer has the key itself, `secret`,
 * which no later answer has again.
 */
export async function createApiKey(
  workspaceId: string,
  key: CreateApiKeyRequest,
): Promise<CreateApiKeyResponse> {
  const response = await request(apiKeysPath(workspaceId), {
    method: "POST",
    json: key,
  });
  return createApiKeyResponseSchema.parse(await response.json());
}

/** Revokes a key: it calls nothing from then on. */
export async function revokeApiKey(
  workspaceId: string,
  keyId: string,
): Promise<void> {
  await request(`${apiKeysPath(workspaceId)}/${keyId}`, { method: "DELETE" });
}
