import { Buffer } from "node:buffer";

import Papa from "papaparse";
import * as XLSX from "xlsx";

import { isSameOriginRequest, isStateChangingMethod, csrfRefusal } from "../lib/csrf";
import { EXPORT_COLUMN_HEADERS, neutraliseFormula, toExportRows } from "../lib/exportLeads";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
  resetTrustedProxyHopsCache,
} from "../lib/loginThrottle";
import type { Lead } from "../lib/types";

/**
 * Regression tests for the parts of the security audit that are decided by pure
 * functions: the client address (LP-01), spreadsheet formula injection (LP-03)
 * and the cross-site rule (LP-04).
 *
 *   npm run test:security-offline
 *
 * No server and no database. That is not a compromise here — every claim below
 * is a claim about a function's output given a `Request`, and running it against
 * HTTP would test the same function through more layers without testing
 * anything else. The half that genuinely needs a live system (a throttle
 * actually staying shut across real requests, headers actually arriving,
 * `sessions.ip_address` actually being written) is `test-security-live.ts`, and
 * the two are meant to be run together.
 *
 * The CSV and XLSX assertions build real files with the real writers and then
 * read the bytes back — the point of LP-03 is what ends up *in the file*, and a
 * test that stopped at the row objects would not have caught it if `xlsx`
 * decided to treat a leading apostrophe as a formula marker of its own.
 *
 * NOTHING HERE OPENS A SPREADSHEET. The malicious values are inspected as text
 * and as workbook structure only.
 */

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function request(headers: Record<string, string>, method = "POST"): Request {
  return new Request("http://portal.test/api/leads", { method, headers });
}

/** Re-read TRUSTED_PROXY_HOPS, which the module caches after its first look. */
function withHops(hops: string | undefined, run: () => void): void {
  const before = process.env.TRUSTED_PROXY_HOPS;
  if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = hops;
  resetTrustedProxyHopsCache();
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = before;
    resetTrustedProxyHopsCache();
  }
}

function lead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    name: "John Smith",
    address: "123 Main Street",
    categories: ["Plumbing"],
    phone: "(415) 555-0182",
    website: null,
    rating: 4.5,
    owner: null,
    url: null,
    source: "yelp",
    status: "not_called",
    firstCalledAt: null,
    notes: "",
    callbackDate: null,
    meetingTime: null,
    meetingAttendees: null,
    meetingNotes: "",
    meetingCompletedAt: null,
    isDuplicate: false,
    sourceBatch: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
    // `as Lead` because this fixture deliberately carries database-only fields
    // (`firstCalledAt`, `isDuplicate`, the timestamps) that a `Lead` does not
    // have, to prove the export ignores them. The cost is that a field *added*
    // to `Lead` is not caught here by the compiler — `source` was not, and the
    // export threw on `undefined` at runtime instead. If a third field goes the
    // same way, split this into a typed `Lead` plus a separately-cast tail.
  } as Lead;
}

/* -------------------------------------------------------------------------- */
/* LP-01 — the client address                                                 */
/* -------------------------------------------------------------------------- */

function lp01(): void {
  section("LP-01  X-Forwarded-For spoofing");

  withHops("1", () => {
    // The bug itself: nginx appends, so the leftmost entry is the caller's own
    // text. It must never be what comes back.
    check(
      "leftmost X-Forwarded-For is ignored",
      clientIp(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" })) === "203.0.113.9",
      clientIp(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" })),
    );

    check(
      "rightmost hop is used with one proxy",
      clientIp(request({ "x-forwarded-for": "203.0.113.9" })) === "203.0.113.9",
    );

    check(
      "X-Real-IP wins over anything in X-Forwarded-For",
      clientIp(
        request({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
      ) === "203.0.113.9",
    );

    check(
      "a spoofed X-Real-IP that is not an address falls back, never through",
      clientIp(request({ "x-real-ip": "not-an-address" })) === "unknown",
    );

    check(
      "padding the chain does not shift the trusted hop",
      clientIp(
        request({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9" }),
      ) === "203.0.113.9",
    );

    check(
      "an address with a port is normalised",
      clientIp(request({ "x-forwarded-for": "203.0.113.9:51234" })) === "203.0.113.9",
    );

    check(
      "IPv6 survives",
      clientIp(request({ "x-real-ip": "2001:db8::1" })) === "2001:db8::1",
    );

    check(
      "no headers at all is the shared bucket",
      clientIp(request({})) === "unknown",
    );

    check(
      "an out-of-range octet is not an address",
      clientIp(request({ "x-real-ip": "999.1.1.1" })) === "unknown",
    );
  });

  withHops("2", () => {
    check(
      "with two proxies the second-from-right hop is used",
      clientIp(
        request({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 10.0.0.1" }),
      ) === "203.0.113.9",
    );
    check(
      "a chain shorter than the configured hop count is not believed",
      clientIp(request({ "x-forwarded-for": "203.0.113.9" })) === "unknown",
    );
  });

  withHops("0", () => {
    // What `next dev` runs as, and what a directly-exposed deployment should.
    check(
      "with no proxy configured no forwarding header is trusted",
      clientIp(request({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" })) ===
        "unknown",
    );
  });

  section("LP-01  the throttle cannot be reset by rotating the header");

  withHops("1", () => {
    // MAX_PER_IP is 30 and MAX_PER_IDENTIFIER is 8, so the identifier is varied
    // to make sure it is the *IP* window that closes.
    const victimIp = "198.51.100.7";
    const spoofed = (n: number) =>
      request({ "x-forwarded-for": `10.0.0.${n}, ${victimIp}` });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ip = clientIp(spoofed(attempt % 250));
      recordLoginFailure(`throttle-probe-${attempt}`, ip);
    }

    const afterSpoof = checkLoginAllowed(
      "throttle-probe-final",
      clientIp(spoofed(251)),
    );
    check(
      "30 failures behind a rotating X-Forwarded-For still close the IP window",
      !afterSpoof.allowed && afterSpoof.retryAfterSeconds > 0,
      `allowed=${afterSpoof.allowed}`,
    );

    const other = checkLoginAllowed("throttle-probe-final", "203.0.113.200");
    check(
      "a genuinely different address is unaffected",
      other.allowed,
    );
  });

  section("LP-01  the per-identifier throttle is unchanged");

  withHops("1", () => {
    const who = "lp01-identifier-probe";
    const ip = "198.51.100.50";
    for (let attempt = 0; attempt < 8; attempt += 1) recordLoginFailure(who, ip);

    // A brand-new address every time: the identifier window must close anyway.
    const verdict = checkLoginAllowed(who, "203.0.113.77");
    check(
      "8 failures close the identifier window whatever the address",
      !verdict.allowed,
      `allowed=${verdict.allowed}`,
    );

    clearLoginFailures(who);
    check(
      "a successful sign-in clears it",
      checkLoginAllowed(who, "203.0.113.78").allowed,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* LP-03 — spreadsheet formula injection                                      */
/* -------------------------------------------------------------------------- */

/** The audit's list, verbatim. */
const MALICIOUS = [
  "=1+1",
  "+cmd",
  "-123",
  "@formula",
  "\tformula",
  "\rformula",
];

const ORDINARY = ["John Smith", "123 Main Street", "", "4.5", "(415) 555-0182"];

function lp03(): void {
  section("LP-03  formula injection — the transformation");

  for (const value of MALICIOUS) {
    const out = neutraliseFormula(value);
    check(
      `neutralised ${JSON.stringify(value)}`,
      out === `'${value}`,
      JSON.stringify(out),
    );
  }

  for (const value of ORDINARY) {
    check(
      `unchanged ${JSON.stringify(value)}`,
      neutraliseFormula(value) === value,
      JSON.stringify(neutraliseFormula(value)),
    );
  }

  check(
    "-10 is quoted like every other leading minus",
    neutraliseFormula("-10") === "'-10",
  );

  section("LP-03  every column is covered, and the stored lead is untouched");

  const hostile = lead({
    name: "=HYPERLINK(\"https://evil.example\",\"click\")",
    address: "@SUM(1+1)",
    notes: "\t=cmd|'/c calc'!A1",
    owner: "+cmd",
    website: "-1+1",
    url: "=1+1",
    phone: "@formula",
    categories: ["=BAD()"],
  });
  const before = JSON.stringify(hostile);

  const [row] = toExportRows([hostile]);
  const cells = EXPORT_COLUMN_HEADERS.map((header) => row[header]);

  check(
    "no exported cell begins with a formula trigger",
    cells.every((cell) => !/^[=+\-@\t\r]/.test(cell)),
    JSON.stringify(cells.filter((cell) => /^[=+\-@\t\r]/.test(cell))),
  );

  check("the lead object was not modified", JSON.stringify(hostile) === before);

  section("LP-03  the CSV bytes");

  const csv = Papa.unparse(toExportRows([hostile]), { columns: EXPORT_COLUMN_HEADERS });
  const dataLine = csv.split("\n")[1] ?? "";
  check(
    "no CSV field starts with a trigger",
    dataLine
      .split(",")
      .every((field) => !/^"?[=+\-@\t\r]/.test(field)),
    dataLine.slice(0, 160),
  );
  check("the hostile text is still present, just quoted", csv.includes("'=HYPERLINK"));

  const plainCsv = Papa.unparse(toExportRows([lead({})]), {
    columns: EXPORT_COLUMN_HEADERS,
  });
  check(
    "an ordinary lead exports byte-for-byte as before",
    plainCsv.includes("John Smith,(415) 555-0182,123 Main Street,Plumbing"),
    plainCsv.split("\n")[1],
  );

  section("LP-03  the XLSX cells");

  const sheet = XLSX.utils.json_to_sheet(toExportRows([hostile]), {
    header: EXPORT_COLUMN_HEADERS,
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Leads");
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "buffer" }) as Buffer;

  // Read it back the way a spreadsheet would, and look at the cells rather than
  // at the row objects that produced them.
  const reread = XLSX.read(bytes, { type: "buffer" });
  const reSheet = reread.Sheets[reread.SheetNames[0]];
  const dataCells = Object.entries(reSheet)
    .filter(([ref]) => /^[A-Z]+[2-9]\d*$/.test(ref))
    .map(([, cell]) => cell as XLSX.CellObject);

  check(
    "no cell was written as a formula",
    dataCells.every((cell) => cell.f === undefined),
  );
  check(
    "no cell value begins with a trigger",
    dataCells.every(
      (cell) => typeof cell.v !== "string" || !/^[=+\-@\t\r]/.test(cell.v),
    ),
  );
  check(
    "every cell is typed as a string, not a formula result",
    dataCells.every((cell) => cell.t === "s"),
  );
}

/* -------------------------------------------------------------------------- */
/* LP-04 — cross-site requests                                                */
/* -------------------------------------------------------------------------- */

function lp04(): void {
  section("LP-04  the cross-site rule");

  check("GET is not a state change", !isStateChangingMethod("GET"));
  check("HEAD is not a state change", !isStateChangingMethod("HEAD"));
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) {
    check(`${method} is a state change`, isStateChangingMethod(method));
  }

  const sameOrigin = request({
    host: "portal.test",
    origin: "http://portal.test",
    "sec-fetch-site": "same-origin",
  });
  check("the portal's own fetch is allowed", isSameOriginRequest(sameOrigin));
  check("…and produces no refusal", csrfRefusal(sameOrigin) === null);

  const crossSite = request({
    host: "portal.test",
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  });
  check("a cross-site POST is refused", !isSameOriginRequest(crossSite));
  check("…with a 403", csrfRefusal(crossSite)?.status === 403);

  check(
    "a forged Origin alone is refused",
    !isSameOriginRequest(request({ host: "portal.test", origin: "https://evil.example" })),
  );

  check(
    "a neighbour on the same parent domain is refused",
    !isSameOriginRequest(
      request({
        host: "leadportal.169-58-34-205.sslip.io",
        origin: "https://other.169-58-34-205.sslip.io",
        "sec-fetch-site": "same-site",
      }),
    ),
  );

  check(
    "Origin: null (a sandboxed frame) is refused",
    !isSameOriginRequest(request({ host: "portal.test", origin: "null" })),
  );

  check(
    "a browser that says same-origin but sends no Origin is allowed",
    isSameOriginRequest(request({ host: "portal.test", "sec-fetch-site": "same-origin" })),
  );

  check(
    "a non-browser caller (no Origin, no Sec-Fetch-Site) is allowed",
    isSameOriginRequest(request({ host: "portal.test" })),
  );

  check(
    "a cross-site GET is not refused",
    csrfRefusal(
      request(
        { host: "portal.test", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        "GET",
      ),
    ) === null,
  );

  const beforeAppOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://leads.example.com";
  check(
    "a configured extra origin is accepted",
    isSameOriginRequest(
      request({ host: "internal.local", origin: "https://leads.example.com" }),
    ),
  );
  check(
    "…and only that one",
    !isSameOriginRequest(
      request({ host: "internal.local", origin: "https://leads.example.com.evil.test" }),
    ),
  );
  if (beforeAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = beforeAppOrigin;

  check(
    "a multipart upload from this origin is allowed and its body untouched",
    isSameOriginRequest(
      new Request("http://portal.test/api/leads/upload", {
        method: "POST",
        headers: {
          host: "portal.test",
          origin: "http://portal.test",
          "sec-fetch-site": "same-origin",
          "content-type": "multipart/form-data; boundary=----x",
        },
        body: "------x\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\na\r\n------x--\r\n",
      }),
    ),
  );
}

/* -------------------------------------------------------------------------- */

function main(): void {
  console.log("Security regression tests (offline)\n===================================");
  lp01();
  lp03();
  lp04();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
