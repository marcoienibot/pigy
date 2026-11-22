import { fromBase64Url, toBase64Url } from "@pigy/core";
import type { Bindings } from "../env.ts";
import { contentImageKey } from "./keys.ts";

/**
 * The links at which a network fetches an image of a post from pigy.
 * Threads takes no bytes: it is told an address and fetches the image
 * itself, without a session. So pigy serves it at a link that is signed
 * and expires. PLAN.md section 16 has it.
 *
 * A link is a capability: whoever has it gets the image until it
 * expires. So it is made when a step is about to hand it to the network,
 * and is kept nowhere: not in the progress of a delivery, not in the
 * result of a step, not in a log. It names one file of one image of one
 * workspace and the time at which it ends, and is signed over exactly
 * those: another image, another file of the image or a later time is
 * another signature.
 *
 * The key that signs is made of the keys that seal credentials,
 * `CREDENTIAL_KEYS`, so a pigy that can publish can sign, with nothing
 * else to set up. A link lasts minutes, so replacing those keys ends at
 * most the links of the deliveries that are under way, which fail and
 * can be tried again.
 */

/** How long a link is good for, in milliseconds: a quarter of an hour. */
export const mediaLinkLifetimeMs = 15 * 60 * 1000;

/** The path that the links are served under, which a session is not asked at. */
export const mediaLinkPath = "/api/media-links";

const encoder = new TextEncoder();

async function signingKey(configured: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`pigy media links\0${configured}`),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** What a signature is over: everything that the link says. */
const signedText = (workspaceId: string, image: string, expires: number) =>
  encoder.encode(`${workspaceId}\n${image}\n${expires}`);

/** What signs and checks the links of a deployment. */
export type MediaLinks = {
  /**
   * A link to the image that `image` names in `workspaceId`, the `id` of
   * an image of a `PostContent`, at the app at `origin`, good from `now`
   * for `mediaLinkLifetimeMs`.
   */
  sign(
    origin: string,
    workspaceId: string,
    image: string,
    now: Date,
  ): Promise<string>;
  /**
   * The key in the bucket of the image that the link `url` leads to, or
   * undefined if the link is not one that this pigy signed, or has
   * expired by `now`, or names nothing that is published.
   */
  check(url: URL, now: Date): Promise<string | undefined>;
};

/**
 * The links of a deployment whose keys for credentials are `configured`,
 * as the vault is made with them: see `vaultFor` and `vaultWithoutRequest`
 * of src/vault.ts for which those are.
 */
export function mediaLinks(configured: string): MediaLinks {
  const key = signingKey(configured);
  return {
    async sign(origin, workspaceId, image, now) {
      const expires = now.getTime() + mediaLinkLifetimeMs;
      const signature = await crypto.subtle.sign(
        "HMAC",
        await key,
        signedText(workspaceId, image, expires),
      );
      const url = new URL(`${mediaLinkPath}/${workspaceId}/${image}`, origin);
      url.searchParams.set("expires", String(expires));
      url.searchParams.set("signature", toBase64Url(signature));
      return url.href;
    },
    async check(url, now) {
      if (!url.pathname.startsWith(`${mediaLinkPath}/`)) return undefined;
      const [workspaceId = "", ...rest] = url.pathname
        .slice(mediaLinkPath.length + 1)
        .split("/");
      const image = rest.join("/");
      const expires = Number(url.searchParams.get("expires"));
      const signature = fromBase64Url(url.searchParams.get("signature") ?? "");
      if (!Number.isSafeInteger(expires) || !signature) return undefined;
      // Compared by the platform, in a time that does not depend on how
      // much of the signature is right.
      const signed = await crypto.subtle.verify(
        "HMAC",
        await key,
        signature,
        signedText(workspaceId, image, expires),
      );
      if (!signed || now.getTime() >= expires) return undefined;
      return contentImageKey(workspaceId, image);
    },
  };
}

/**
 * The links of this deployment for a request, or for work that no
 * request stands behind: `configured` is `CREDENTIAL_KEYS`, or what
 * stands in for it where the caller may use that. Undefined without
 * keys.
 */
export function mediaLinksWith(
  env: Bindings,
  developmentKeys: string | undefined,
): MediaLinks | undefined {
  const configured = env.CREDENTIAL_KEYS ?? developmentKeys;
  return configured === undefined ? undefined : mediaLinks(configured);
}
