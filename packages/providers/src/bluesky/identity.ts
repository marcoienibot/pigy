import { z } from "zod";
import { publicHost, publicOrigin } from "../host.ts";

/**
 * Who an account of atproto is and where it lives, written from the
 * specifications "Handle" and "DID" at https://atproto.com/specs. A handle
 * is a domain name, and leads to a DID: by a TXT record of the DNS, or by
 * a file that the host of the handle serves. The DID leads to a document,
 * kept by the directory of `did:plc` or by the host of a `did:web`, which
 * names the server that keeps the account, its PDS. The document has to
 * claim the handle in turn, or the handle is not the account's.
 */

// Top-level domains that a handle may not have: "Handle", "Additional
// Non-Syntax Restrictions". `.test` is not among them: it is for
// development, and it is what the simulated accounts have.
const disallowedTlds = [
  "alt",
  "arpa",
  "example",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
];

/**
 * The handle in what a person typed, in the form that atproto compares
 * them in, or null if it is none. A leading "@" is taken off, as people
 * write one. A handle is a host that pigy asks for its DID, so it has to
 * be a public one too.
 */
export function parseHandle(typed: string): string | null {
  const handle = typed.trim().replace(/^@/, "").toLowerCase();
  if (
    handle.length > 253 ||
    !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(
      handle,
    )
  ) {
    return null;
  }
  const tld = handle.slice(handle.lastIndexOf(".") + 1);
  return disallowedTlds.includes(tld) ? null : publicHost(handle);
}

/** A DID of a method that atproto blesses, or null. */
export function parseDid(value: string): string | null {
  if (/^did:plc:[a-z2-7]{24}$/.test(value)) return value;
  // A did:web of atproto names a host, with no port and no path.
  const web = /^did:web:([a-z0-9.-]+)$/.exec(value)?.[1];
  return web && parseHandle(web) === web ? value : null;
}

/** The address of the document of `did`, which `parseDid` has taken. */
export function didDocumentUrl(did: string, plcDirectory: string): string {
  return did.startsWith("did:web:")
    ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
    : `https://${plcDirectory}/${did}`;
}

/** The DID in the TXT records of `_atproto.<handle>`, as the DNS has them. */
export const dnsAnswerSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

// The type of a TXT record.
const txt = 16;

/**
 * The DIDs that the TXT records in `answer` name. A record of atproto
 * says "did=<DID>". The resolver quotes the text of a record, and splits a
 * long one into quoted pieces.
 */
export function didsInAnswer(answer: z.infer<typeof dnsAnswerSchema>) {
  return (answer.Answer ?? [])
    .filter(({ type }) => type === txt)
    .map(({ data }) => data.replace(/^"|"$/g, "").replaceAll('" "', ""))
    .filter((text) => text.startsWith("did="))
    .map((text) => text.slice("did=".length));
}

/** What pigy reads of a DID document. */
export const didDocumentSchema = z.object({
  id: z.string(),
  alsoKnownAs: z.array(z.string()).optional(),
  service: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        serviceEndpoint: z.unknown(),
      }),
    )
    .optional(),
});

/**
 * The address of the PDS that a DID document names, or null. It has to be
 * the HTTPS address of a public host: requests with the account's tokens
 * go there, and whoever controls the account writes the document.
 */
export function pdsOf(
  document: z.infer<typeof didDocumentSchema>,
): string | null {
  const service = document.service?.find(
    ({ id, type }) =>
      (id === "#atproto_pds" || id === `${document.id}#atproto_pds`) &&
      type === "AtprotoPersonalDataServer",
  );
  return publicOrigin(service?.serviceEndpoint);
}

/** Whether a DID document claims `handle` for its account. */
export function claims(
  document: z.infer<typeof didDocumentSchema>,
  handle: string,
): boolean {
  return (document.alsoKnownAs ?? []).some(
    (name) => name.toLowerCase() === `at://${handle}`,
  );
}
