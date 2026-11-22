import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./env.ts";
import { log } from "./log.ts";

/**
 * Where a browser reports what the content security policy of a page of
 * pigy refused: `PLAN.md` section 16, "Reports of what the policy
 * refuses". The policies say so, `reportTo`, here for the answers of the
 * Worker and in apps/web/public/_headers for the files of the app, and the
 * answers carry `Reporting-Endpoints`, which names the endpoint `csp`.
 *
 * Anybody can send a report: a browser sends it without the session, with
 * the Reporting API without any cookie, and so can anybody else. So it is
 * no more than a line of the log, one for each kind of refusal in a
 * request, which says what was refused and where, and nothing of the
 * person: the directive, the origin of what was blocked and not its path
 * or its query, and the page as a pattern, with its IDs and every word
 * that pigy's own paths do not have taken out. A report about a page that
 * is not pigy's is dropped, and so is everything past what one client may
 * send in a minute, `POLICY_REPORT_LIMITER`, past what all of them may
 * send together, `POLICY_REPORT_TOTAL_LIMITER`, and past what one request
 * may hold. So the lines that anybody can have written are bounded, for
 * the log of the account, whatever they send and from however many
 * addresses: `maxLinesPerRequest` for every request that the second
 * limiter lets through.
 */

/** Under `/api`, which `assets.run_worker_first` sends to the Worker. */
export const policyReportPath = "/api/policy-reports";

/** The name that `Reporting-Endpoints` gives the endpoint. */
const endpointName = "csp";

/**
 * The header that names the endpoint for the Reporting API, which
 * Chromium sends reports to. A path is enough: it is read against the
 * address of the page.
 */
export const reportingEndpoints = `${endpointName}="${policyReportPath}"`;

/**
 * What a policy says of where its reports go: `report-to` for a browser
 * with the Reporting API, which then leaves `report-uri` alone, and
 * `report-uri` for one without, which Firefox is: `PLAN.md` section 16.
 */
export const reportTo = `report-to ${endpointName}; report-uri ${policyReportPath}`;

/**
 * The most bytes of a request that are read. A report is a kilobyte or
 * two, mostly the policy itself, and Chromium sends what has piled up in a
 * minute in one request.
 */
export const maxReportBytes = 64 * 1024;

/** The most reports of one request that are looked at. */
export const maxReportsPerRequest = 20;

/**
 * The most lines that one request writes: the kinds of refusal that it
 * reported most often. What a page refuses comes in a few kinds, and a
 * request that reports more is not worth more lines for that.
 */
export const maxLinesPerRequest = 5;

/**
 * The most segments of the path of a page that a line says. The paths of
 * pigy are shorter, and one that is longer is what somebody typed.
 */
export const maxPageSegments = 8;

/** The types of body that a browser sends reports in. */
const reportTypes = new Set([
  // The Reporting API: a list of reports of every kind.
  "application/reports+json",
  // `report-uri`: one report.
  "application/csp-report",
  // `report-uri` as some browsers have sent it.
  "application/json",
]);

/** A report as the Reporting API has it. */
const reportingApiSchema = z.array(
  z.object({
    type: z.string(),
    body: z
      .object({
        documentURL: z.string().optional(),
        blockedURL: z.string().optional(),
        effectiveDirective: z.string().optional(),
        disposition: z.string().optional(),
      })
      .optional(),
  }),
);

/** A report as `report-uri` has it. */
const reportUriSchema = z.object({
  "csp-report": z.object({
    "document-uri": z.string().optional(),
    "blocked-uri": z.string().optional(),
    "effective-directive": z.string().optional(),
    // What browsers before CSP 3 sent in place of the one before, with
    // the sources of the directive after its name.
    "violated-directive": z.string().optional(),
    disposition: z.string().optional(),
  }),
});

/** What the log is told of one report, before it is made safe. */
type Report = {
  document: string | undefined;
  blocked: string | undefined;
  directive: string | undefined;
  disposition: string | undefined;
};

/** The reports in `body`, in whichever of the two forms it is. */
function reportsOf(body: unknown): Report[] {
  const listed = reportingApiSchema.safeParse(body);
  if (listed.success) {
    return listed.data.flatMap(({ type, body: report }) =>
      type === "csp-violation" && report
        ? [
            {
              document: report.documentURL,
              blocked: report.blockedURL,
              directive: report.effectiveDirective,
              disposition: report.disposition,
            },
          ]
        : [],
    );
  }
  const single = reportUriSchema.safeParse(body);
  if (!single.success) return [];
  const report = single.data["csp-report"];
  return [
    {
      document: report["document-uri"],
      blocked: report["blocked-uri"],
      directive:
        report["effective-directive"] ??
        report["violated-directive"]?.split(" ")[0],
      disposition: report.disposition,
    },
  ];
}

/**
 * The name of a directive, as a policy writes it, or `other`: what a
 * report says is anybody's word.
 */
function directiveOf(directive: string | undefined): string {
  return directive && /^[a-z][a-z-]{0,39}$/.test(directive)
    ? directive
    : "other";
}

/**
 * The keywords that a browser reports in place of an address, for what
 * has none: a script written into the page, `eval`, and the like.
 */
const blockedKeywords = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "trusted-types-policy",
  "trusted-types-sink",
  "data",
  "blob",
  "self",
]);

/**
 * What was blocked, without anything of its address but its origin: a
 * keyword that a browser reports for what has no address, the origin of
 * an address on the web, or the scheme of another, as of an extension of
 * the browser. An address can hold anything after its origin, and the
 * address of a person or of a draft is not for the log.
 */
function blockedOf(blocked: string | undefined): string {
  // An empty one is what browsers before CSP 3 said for inline.
  if (!blocked) return "inline";
  if (blockedKeywords.has(blocked)) return blocked;
  let url: URL;
  try {
    url = new URL(blocked);
  } catch {
    return "other";
  }
  return /^(https?|wss?):$/.test(url.protocol) ? url.origin : url.protocol;
}

/**
 * The words that pigy's own paths are made of: the screens of the app and
 * the pages that the Worker answers with. A path is logged with these and
 * with nothing else: whatever is not among them, and is no ID, may be
 * something that somebody typed into an address, and is written `:other`.
 * A screen that is added later shows as `:other` until it is added here,
 * which costs a word in a log and nothing else.
 */
const pathWords = new Set([
  // The app.
  "about",
  "access",
  "api",
  "calendar",
  "channels",
  "failures",
  "inbox",
  "invite-only",
  "queue",
  "record",
  "schedule",
  "sent",
  "settings",
  "share",
  "sign-in",
  "simulator",
  // The Worker.
  "authorize",
  "connect",
  "docs",
  "google",
  "network",
  "oauth",
  "sim",
  "v1",
  // The bytes of images, which are no page: their policy is asked only of
  // an image that is opened by itself in a tab, which `sandbox` gives an
  // origin of its own. A signed link has its signature in the query, which
  // is never written.
  "images",
  "media",
  "media-links",
  "original",
  "sandbox",
  "thumbnail",
  "variants",
  "workspaces",
]);

/** An ID that pigy makes: a UUID, or a long string of hex digits. */
const idPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,64})$/i;

/**
 * The page that a report is about, as a pattern of its path: the words of
 * pigy's own paths, `:id` for an ID, and `:other` for whatever else, and
 * no more than `maxPageSegments` of them, with `…` for the rest. No query
 * and no fragment. A host of a simulated network in the path of its page
 * is `:other` too: it names a network and nobody, but it is no word of
 * pigy's, and the page says that it is a simulated one anyway.
 */
export function pageOf(url: URL): string {
  const all = url.pathname.split("/").slice(1);
  const segments = all
    .slice(0, maxPageSegments)
    .map((segment) =>
      segment === "" || pathWords.has(segment)
        ? segment
        : idPattern.test(segment)
          ? ":id"
          : ":other",
    );
  if (all.length > maxPageSegments) segments.push("…");
  return `/${segments.join("/")}`;
}

/**
 * Who a client is, for the limiter that counts its requests, from the
 * address that Cloudflare says the request comes from: an address of
 * IPv4 as it is, and of an address of IPv6 the first 64 bits, the network
 * of one connection, whose owner has every address in it and would be a
 * new client with each. It is used for nothing else and written nowhere.
 * Cloudflare sets the header on every request that reaches the Worker. A
 * request without it, in development and in the tests, is counted with
 * every other such request.
 */
export function clientOf(address: string | null): string {
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  // An address of IPv4 that is written as one of IPv6.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail] = address.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? front
      : [
          ...front,
          ...Array.from(
            { length: Math.max(0, 8 - front.length - back.length) },
            () => "0",
          ),
          ...back,
        ];
  const network = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":");
  return `${network}::/64`;
}

/**
 * The body of `request` as text, or null if it is larger than
 * `maxReportBytes`: it is read no further than that.
 */
async function boundedText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxReportBytes) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxReportBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Under `/api`: takes the reports of a browser, and answers 204 whatever
 * became of them, unless it could not read them. No session and no
 * `Origin` are asked for: a browser sends neither with the Reporting API.
 */
export function policyReportRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post(policyReportPath.slice("/api".length), async (c) => {
    const type = c.req
      .header("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!type || !reportTypes.has(type)) return c.body(null, 415);
    // Before the body is read: a client that sends too much is not worth
    // reading, and neither are all of them together past what the log is
    // to hold of them.
    const client = await c.env.POLICY_REPORT_LIMITER.limit({
      key: clientOf(c.req.header("CF-Connecting-IP") ?? null),
    });
    if (!client.success) return c.body(null, 429);
    const total = await c.env.POLICY_REPORT_TOTAL_LIMITER.limit({
      key: "all",
    });
    if (!total.success) return c.body(null, 429);
    const text = await boundedText(c.req.raw);
    if (text === null) return c.body(null, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.body(null, 400);
    }

    const { origin } = new URL(c.req.url);
    // The same refusal on the same page is said once, with how often.
    const lines = new Map<
      string,
      {
        directive: string;
        blocked: string;
        page: string;
        disposition: string;
        count: number;
      }
    >();
    for (const report of reportsOf(body).slice(0, maxReportsPerRequest)) {
      let document: URL;
      try {
        document = new URL(report.document ?? "");
      } catch {
        continue;
      }
      // A page of another site, whose browser was told to report here.
      if (document.origin !== origin) continue;
      const line = {
        directive: directiveOf(report.directive),
        blocked: blockedOf(report.blocked),
        page: pageOf(document),
        disposition: report.disposition === "report" ? "report" : "enforce",
      };
      const key = JSON.stringify(line);
      const seen = lines.get(key);
      if (seen) seen.count += 1;
      else lines.set(key, { ...line, count: 1 });
    }
    // The kinds that came most often, if there are more of them than a
    // request writes.
    const written = [...lines.values()]
      .sort((one, other) => other.count - one.count)
      .slice(0, maxLinesPerRequest);
    for (const line of written) {
      log.warn(
        "policy",
        "The content security policy refused something on a page",
        line,
      );
    }
    return c.body(null, 204);
  });

  return app;
}
