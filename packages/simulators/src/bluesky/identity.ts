import { gatewayError, json, text } from "./http.ts";
import { accountByHandle, type BlueskyAccount, type State } from "./state.ts";

/**
 * How an account is found in a simulated world: the handle leads to the
 * DID, and the DID to the document that names the server of the account.
 * After the atproto specifications "Handle" and "DID", and the
 * documentation of the two services that take part without being
 * Bluesky's: the directory of `did:plc`, https://web.plc.directory, and
 * Cloudflare's DNS over HTTPS with JSON,
 * https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/.
 */

/** The directory that keeps the documents of `did:plc`. */
export const plcDirectoryHost = "plc.directory";

/** The resolver that answers DNS queries over HTTPS. */
export const dnsResolverHost = "cloudflare-dns.com";

// The numbers that the DNS has for a TXT record and for its answers.
const txtType = 16;
const noError = 0;
const noSuchName = 3;

/** The document of the DID of `account`, as "DID" of atproto has it. */
function didDocument(account: BlueskyAccount) {
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
      "https://w3id.org/security/suites/secp256k1-2019/v1",
    ],
    id: account.id,
    alsoKnownAs: [`at://${account.domain}`],
    verificationMethod: [
      {
        id: `${account.id}#atproto`,
        type: "Multikey",
        controller: account.id,
        // No repository is signed here, so the key is nobody's.
        publicKeyMultibase: "zQ3shunBKsXixLxKtC5qeSG9E4J5RkGN57im31pcTzbNQnm5w",
      },
    ],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: `https://${account.pds}`,
      },
    ],
  };
}

/** Answers a request with what an identity lookup can suffer from. */
function faulted(state: State, respond: () => Response): Response {
  const fault = state.takeFault(
    "identity",
    ["rate-limit", "server-error", "lost-response"],
    false,
  );
  if (fault === "server-error") return gatewayError();
  if (fault === "rate-limit") {
    return json(429, { message: "Too Many Requests" }, { "Retry-After": "60" });
  }
  const response = respond();
  if (fault === "lost-response") {
    throw new TypeError(
      "The simulated Bluesky lost its answer on the way back",
    );
  }
  return response;
}

/** `GET https://plc.directory/<did>`: the document of a `did:plc`. */
export function plcDirectory(state: State, request: Request, url: URL) {
  if (request.method !== "GET") return json(404, { message: "Not Found" });
  return faulted(state, () => {
    const did = decodeURIComponent(url.pathname.slice(1));
    const account = did.startsWith("did:plc:")
      ? state.accounts.get(did)
      : undefined;
    return account
      ? json(200, didDocument(account), {
          "Content-Type": "application/did+ld+json; charset=utf-8",
        })
      : json(404, { message: `DID not registered: ${did}` });
  });
}

/**
 * `GET https://cloudflare-dns.com/dns-query`: a DNS query, answered as
 * JSON. The simulated DNS has the records that atproto looks for and no
 * others: `_atproto.<handle>` with the DID, for the accounts whose handle
 * leads to them that way.
 */
export function dnsQuery(state: State, request: Request, url: URL): Response {
  if (request.method !== "GET" || url.pathname !== "/dns-query") {
    return text(404, "Not Found");
  }
  // GUESS: the documentation says to send this header, and not what
  // happens without it.
  if (!(request.headers.get("Accept") ?? "").includes("application/dns-json")) {
    return text(400, "Invalid query.");
  }
  const name = url.searchParams.get("name");
  if (!name) return json(400, { error: "Missing query name." });
  const type = url.searchParams.get("type") ?? "A";
  if (type.toUpperCase() !== "TXT" && type !== String(txtType)) {
    // What is not simulated is refused, not answered as if there were no
    // such record.
    return json(400, {
      error: `The simulated resolver answers TXT queries only, not ${type}.`,
    });
  }
  return faulted(state, () => {
    const queried = name.toLowerCase().replace(/\.$/, "");
    const question = [{ name: queried, type: txtType }];
    const flags = { TC: false, RD: true, RA: true, AD: false, CD: false };
    const owner = queried.startsWith("_atproto.")
      ? accountByHandle(state, queried.slice("_atproto.".length))
      : undefined;
    if (owner?.resolution === "dns") {
      return json(
        200,
        {
          Status: noError,
          ...flags,
          Question: question,
          Answer: [
            {
              name: queried,
              type: txtType,
              TTL: 300,
              // A TXT record is quoted in the answer.
              data: `"did=${owner.id}"`,
            },
          ],
        },
        { "Content-Type": "application/dns-json" },
      );
    }
    // A name that exists without such a record, or no such name.
    return json(
      200,
      { Status: owner ? noError : noSuchName, ...flags, Question: question },
      { "Content-Type": "application/dns-json" },
    );
  });
}

/**
 * `GET https://<handle>/.well-known/atproto-did`: the DID of a handle, as
 * the host of the handle says it.
 */
export function handleFile(state: State, account: BlueskyAccount): Response {
  return faulted(state, () => text(200, account.id));
}

/** `GET https://<host>/.well-known/did.json`: the document of a `did:web`. */
export function webDidDocument(state: State, account: BlueskyAccount) {
  return faulted(state, () => json(200, didDocument(account)));
}
