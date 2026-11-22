import type { Network } from "@pigy/core";
import type { Json } from "@pigy/providers";
import { type Vault, VaultError } from "../vault.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";

/**
 * The credentials of a channel on their way between an adapter and where
 * they are stored. This is the only code that seals them and the only code
 * that opens them: whoever stores what an adapter handed out seals it
 * here, and whoever is about to call an adapter opens it here, in the call
 * and for the call. That is the route that connects an account, the route
 * that disconnects one, the steps of the publishing workflow, and the
 * object of a workspace where it renews an access by its timer.
 *
 * In the clear, credentials exist in memory only, between these functions
 * and an adapter. They are in no log, no error, no answer, no sync message
 * and no state of a workflow: what crosses any of those is the sealed text.
 */

/** Whose credentials they are: an account of a network. */
type AccountOf = { network: Network; accountId: string };

/**
 * What the sealed credentials of a channel belong to: the account, in its
 * workspace. Sealed for one, they do not open for another.
 */
function context(
  workspace: WorkspaceIdentity,
  { network, accountId }: AccountOf,
): string[] {
  return ["channel", workspace.id, network, accountId];
}

/** Seals what an adapter handed out for `account` of `workspace`. */
export function sealCredentials(
  vault: Vault,
  workspace: WorkspaceIdentity,
  account: AccountOf,
  credentials: Json,
): Promise<string> {
  return vault.seal(context(workspace, account), credentials);
}

/**
 * The credentials that a channel of `workspace` holds for `account`, for an
 * adapter to be called with. The adapter checks them against its own
 * schema. Throws a `VaultError`, whose message holds no secret, if the
 * channel has none or they do not open: they were sealed with a key that
 * is gone, or for another account.
 */
export async function openCredentials(
  vault: Vault,
  workspace: WorkspaceIdentity,
  account: AccountOf,
  sealed: string | null,
): Promise<Json> {
  if (sealed === null) throw new VaultError("The channel has no credentials");
  return (await vault.open(context(workspace, account), sealed)) as Json;
}
