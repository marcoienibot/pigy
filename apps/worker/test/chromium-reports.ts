/**
 * Reports of a refusal of the content security policy, as the Chromium of
 * the end-to-end tests made them for the built app, version 156: the
 * script that e2e/tests/policy-reports.spec.ts writes into the sign-in
 * page. Taken from that test as they were, with the address of the app
 * that the test ran at replaced by `origin`, so that the Worker tests
 * hold the endpoint to what a real browser sends and not only to what the
 * tests write by hand.
 */

/** The policy of the app shell that the page had, as the report has it. */
const policy =
  "default-src 'none'; script-src 'self' 'sha256-mY1SGblzAV/KYi1YqD0a6LZFFcXdHBlaYC3c2WGBUxc='; style-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' 'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY='; img-src 'self' https:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/**
 * What Chromium sends to the endpoint of `report-to`: a list, in the
 * envelope of the Reporting API, around the body that it queued. The test
 * read the body from DevTools, where Chromium queues it and, at an
 * address that is not HTTPS, never sends it: the envelope is the one that
 * the Reporting API describes, with the fields that Chromium fills.
 */
export const chromiumReportingApi = (origin: string) =>
  JSON.stringify([
    {
      age: 0,
      type: "csp-violation",
      url: `${origin}/sign-in`,
      user_agent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36",
      body: {
        blockedURL: "inline",
        columnNumber: 19,
        disposition: "enforce",
        documentURL: `${origin}/sign-in`,
        effectiveDirective: "script-src-elem",
        lineNumber: 4,
        originalPolicy: `${policy}; report-to csp; report-uri /api/policy-reports`,
        referrer: "",
        sample: "",
        statusCode: 200,
      },
    },
  ]);

/**
 * What Chromium sent to `report-uri` where the policy had no `report-to`,
 * as `application/csp-report`: the body of the request, as it was.
 */
export const chromiumReportUri = (origin: string) =>
  JSON.stringify({
    "csp-report": {
      "document-uri": `${origin}/sign-in`,
      referrer: "",
      "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem",
      "original-policy": `${policy}; report-uri /api/policy-reports`,
      disposition: "enforce",
      "blocked-uri": "inline",
      "line-number": 4,
      "column-number": 19,
      "status-code": 200,
      "script-sample": "",
    },
  });
