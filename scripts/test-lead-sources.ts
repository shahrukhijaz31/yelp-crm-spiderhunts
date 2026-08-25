import { EXPORT_COLUMN_HEADERS, toExportRows } from "../lib/exportLeads";
import {
  EMPTY_FILTERS,
  describeActiveFilters,
  matchesFilters,
  type LeadFilters,
} from "../lib/filters";
import { buildLeadSearchParams, parseLeadSearchParams } from "../lib/leadQuery";
import { parseLeadsCsv } from "../lib/parseLeadsCsv";
import {
  DEFAULT_LEAD_SOURCE,
  LEAD_SOURCES,
  leadSourceFromUrl,
  parseLeadSource,
  type Lead,
  type LeadSource,
} from "../lib/types";

/**
 * Regression tests for the lead-source column.
 *
 *   npm run test:lead-sources
 *
 * No server and no database, because every claim below is a claim about a pure
 * function: which source a parsed row lands on, whether the filter survives a
 * trip through a query string, and whether the export carries it. The one part
 * that genuinely needs Postgres — the `lead_source` enum and the
 * `WHERE l.source IN (…)` built from it — is exercised by running the app; what
 * is tested here is everything that decides *what goes in that column*, which
 * is where a mislabelled scrape would come from.
 *
 * The precedence rules are the point. A source is resolved per row from three
 * things in a fixed order — the row's `source` cell, the listing URL's host,
 * then the caller's default — and getting that order wrong is not a visible
 * bug. It is a whole scraper run quietly filed under the wrong directory, which
 * nobody notices until someone asks how the Google leads are converting.
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

function lead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    name: "Golden Gate Plumbing",
    address: "1428 Irving St",
    categories: ["Plumbing"],
    phone: "(415) 555-0182",
    website: null,
    rating: 4.5,
    owner: null,
    url: null,
    source: "yelp",
    status: "not_called",
    notes: "",
    callbackDate: null,
    meetingTime: null,
    meetingAttendees: null,
    meetingNotes: "",
    meetingCompletedAt: null,
    country: null,
    city: null,
    ...overrides,
  };
}

/**
 * A one-row CSV holding only the columns a case cares about.
 *
 * The phone is always present because `cleanLeads` drops a row without a
 * dialable number — and a row that vanished would look exactly like a source
 * that failed to resolve.
 */
function csv(columns: Record<string, string>): string {
  const header = ["name", "phone_number", ...Object.keys(columns)];
  const values = header.map((key) => {
    if (key === "name") return "Test Business";
    if (key === "phone_number") return "(415) 555-0182";
    return columns[key] ?? "";
  });
  return `${header.join(",")}\n${values.join(",")}`;
}

function onlyLead(text: string, fallback: LeadSource = DEFAULT_LEAD_SOURCE): Lead {
  const parsed = parseLeadsCsv(text, "test", fallback);
  if (parsed.leads.length !== 1) {
    throw new Error(
      `expected 1 lead, got ${parsed.leads.length} (${parsed.warnings.join("; ")})`,
    );
  }
  return parsed.leads[0];
}

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                             */
/* -------------------------------------------------------------------------- */

function vocabulary(): void {
  section("Reading a source from text and from a URL");

  check("`google` parses", parseLeadSource("google") === "google");
  check("`Google Maps` parses", parseLeadSource("Google Maps") === "google");
  check("` YELP ` parses, trimmed and lowered", parseLeadSource(" YELP ") === "yelp");
  check("`facebook` does not parse", parseLeadSource("facebook") === null);
  check("an empty string does not parse", parseLeadSource("") === null);
  check("a non-string does not parse", parseLeadSource(42) === null);

  check(
    "a Yelp biz URL implies Yelp",
    leadSourceFromUrl("https://www.yelp.com/biz/golden-gate-plumbing") === "yelp",
  );
  check(
    "a Maps place URL implies Google",
    leadSourceFromUrl("https://www.google.com/maps/place/Golden+Gate") === "google",
  );
  check(
    "a localised Maps URL implies Google",
    leadSourceFromUrl("https://www.google.co.uk/maps/place/Some+Shop") === "google",
  );
  check(
    "a Maps short link implies Google",
    leadSourceFromUrl("https://maps.app.goo.gl/abc123") === "google",
  );
  check(
    "the business's own site implies nothing",
    leadSourceFromUrl("https://goldengateplumbing.com") === null,
  );
  check("a non-URL implies nothing", leadSourceFromUrl("call for details") === null);
  check("null implies nothing", leadSourceFromUrl(null) === null);

  // The host is read and the path never is — otherwise a Yelp listing whose
  // slug happens to contain "google" would flip a row.
  check(
    "a Yelp URL mentioning google in its path stays Yelp",
    leadSourceFromUrl("https://www.yelp.com/biz/google-street-cafe") === "yelp",
  );
}

/* -------------------------------------------------------------------------- */
/* Precedence: the column, then the URL, then the caller's default            */
/* -------------------------------------------------------------------------- */

function precedence(): void {
  section("Which of the three sources of truth wins");

  check(
    "the `source` column wins over everything",
    onlyLead(csv({ source: "google", url: "https://www.yelp.com/biz/test" }), "yelp")
      .source === "google",
  );

  check(
    "the listing URL wins over the caller's default",
    onlyLead(csv({ url: "https://www.google.com/maps/place/Test" }), "yelp").source ===
      "google",
  );

  check(
    "the caller's default applies when nothing else says",
    onlyLead(csv({ website: "https://example.com" }), "google").source === "google",
  );

  check(
    "with no default given, a bare row is Yelp",
    onlyLead(csv({ website: "https://example.com" })).source === DEFAULT_LEAD_SOURCE,
  );

  /*
   * Why the URL outranks the caller, rather than the other way round: a scraper
   * pushing a whole output folder can include one CSV left over from the other
   * run, and a per-request label would relabel every row in it. A per-row URL
   * cannot.
   */
  check(
    "a stray Yelp file in a Google push keeps its own rows' source",
    onlyLead(csv({ url: "https://www.yelp.com/biz/test" }), "google").source === "yelp",
  );

  check(
    "an unreadable `source` cell falls through rather than throwing",
    onlyLead(
      csv({ source: "facebook", url: "https://www.google.com/maps/place/T" }),
      "yelp",
    ).source === "google",
  );
}

/* -------------------------------------------------------------------------- */
/* Google Maps column names                                                   */
/* -------------------------------------------------------------------------- */

function mapsColumns(): void {
  section("A Google Maps export's own column names");

  const parsed = parseLeadsCsv(
    [
      "title,full_address,main_category,phone,site,average_rating,maps_url",
      "Uptown HVAC,1900 Broadway,Heating,(510) 555-0163,https://uptownhvac.com,3.5,https://www.google.com/maps/place/Uptown+HVAC",
    ].join("\n"),
    "maps",
  );

  check("one row survives", parsed.leads.length === 1, parsed.warnings.join("; "));
  const row = parsed.leads[0];
  check("`title` -> name", row?.name === "Uptown HVAC");
  check("`full_address` -> address", row?.address === "1900 Broadway");
  check("`main_category` -> categories", row?.categories.join() === "Heating");
  check("`site` -> website", row?.website === "https://uptownhvac.com");
  check("`average_rating` -> rating", row?.rating === 3.5);
  check("`maps_url` -> url", row?.url?.includes("/maps/place/") === true);
  // …and because it landed in `url`, the row files itself as Google without the
  // file having said so anywhere.
  check("the row resolves to Google", row?.source === "google");
  check(
    "no column was reported as unrecognised",
    parsed.warnings.length === 0,
    parsed.warnings.join("; "),
  );
}

/* -------------------------------------------------------------------------- */
/* The per-push breakdown                                                     */
/* -------------------------------------------------------------------------- */

function breakdown(): void {
  section("What a push reports about itself");

  const mixed = parseLeadsCsv(
    [
      "name,phone_number,url",
      "A,(415) 555-0101,https://www.yelp.com/biz/a",
      "B,(415) 555-0102,https://www.google.com/maps/place/B",
      "C,(415) 555-0103,https://www.google.com/maps/place/C",
    ].join("\n"),
    "mixed",
    "yelp",
  );

  check("three rows kept", mixed.leads.length === 3);
  check("one Yelp counted", mixed.bySource.yelp === 1, JSON.stringify(mixed.bySource));
  check("two Google counted", mixed.bySource.google === 2, JSON.stringify(mixed.bySource));

  // Every source is a key even at zero, so a caller can index the record
  // without checking for undefined.
  const empty = parseLeadsCsv("name,phone_number\nA,(415) 555-0101", "empty");
  check(
    "every source is a key, at zero when unused",
    LEAD_SOURCES.every((source) => typeof empty.bySource[source] === "number"),
  );

  // Counted after the clean, so it describes what was kept: the second row here
  // is the same business and is dropped as a duplicate.
  const deduped = parseLeadsCsv(
    [
      "name,phone_number,url",
      "A,(415) 555-0101,https://www.google.com/maps/place/A",
      "A,(415) 555-0101,https://www.google.com/maps/place/A",
    ].join("\n"),
    "dupes",
  );
  check(
    "the breakdown counts kept rows, not parsed ones",
    deduped.bySource.google === 1 && deduped.removedDuplicates === 1,
    JSON.stringify(deduped.bySource),
  );
}

/* -------------------------------------------------------------------------- */
/* The filter                                                                 */
/* -------------------------------------------------------------------------- */

function filtering(): void {
  section("Filtering by source");

  const yelpLead = lead({ source: "yelp" });
  const googleLead = lead({ source: "google" });
  const today = "2026-08-24";

  check(
    "an empty list means every source",
    matchesFilters(yelpLead, EMPTY_FILTERS, today) &&
      matchesFilters(googleLead, EMPTY_FILTERS, today),
  );

  const onlyGoogle: LeadFilters = { ...EMPTY_FILTERS, sources: ["google"] };
  check("Google only keeps Google", matchesFilters(googleLead, onlyGoogle, today));
  check("Google only drops Yelp", !matchesFilters(yelpLead, onlyGoogle, today));

  const both: LeadFilters = { ...EMPTY_FILTERS, sources: [...LEAD_SOURCES] };
  check(
    "ticking every source is the same as ticking none",
    matchesFilters(yelpLead, both, today) && matchesFilters(googleLead, both, today),
  );

  // One chip per ticked source, each carrying the filter set with just that one
  // cleared — which is what lets the toolbar's × work without knowing shapes.
  const chips = describeActiveFilters({ ...EMPTY_FILTERS, sources: ["yelp", "google"] });
  check(
    "two sources produce two chips",
    chips.length === 2,
    chips.map((chip) => chip.id).join(", "),
  );
  check(
    "clearing one chip leaves the other source",
    chips[0]?.next.sources.join() === "google",
    JSON.stringify(chips[0]?.next.sources),
  );
}

/* -------------------------------------------------------------------------- */
/* The query string                                                           */
/* -------------------------------------------------------------------------- */

function queryString(): void {
  section("Surviving a trip through the URL");

  const base = parseLeadSearchParams(new URLSearchParams(), "2026-08-24");

  const written = buildLeadSearchParams({
    ...base,
    filters: { ...base.filters, sources: ["google"] },
  });
  check("a ticked source is written", written.getAll("source").join() === "google");
  check(
    "an unticked source writes nothing",
    buildLeadSearchParams(base).getAll("source").length === 0,
  );

  check(
    "and reads back identically",
    parseLeadSearchParams(written, "2026-08-24").filters.sources.join() === "google",
  );

  check(
    "two sources round-trip as a list",
    parseLeadSearchParams(
      new URLSearchParams("source=yelp&source=google"),
      "2026-08-24",
    ).filters.sources.join() === "yelp,google",
  );

  // The query string is hostile input: it names a known directory or it is
  // dropped, never passed through to a `WHERE`.
  const hostile = parseLeadSearchParams(
    new URLSearchParams("source=facebook&source=google&source="),
    "2026-08-24",
  );
  check(
    "an unknown source is dropped rather than queried for",
    hostile.filters.sources.join() === "google",
    JSON.stringify(hostile.filters.sources),
  );
}

/* -------------------------------------------------------------------------- */
/* The export                                                                 */
/* -------------------------------------------------------------------------- */

function exporting(): void {
  section("Carrying the source out of the app");

  check(
    "there is a Source column",
    EXPORT_COLUMN_HEADERS.includes("Source"),
    EXPORT_COLUMN_HEADERS.join(", "),
  );
  check(
    "the listing column is no longer named for Yelp",
    EXPORT_COLUMN_HEADERS.includes("Listing URL") &&
      !EXPORT_COLUMN_HEADERS.includes("Yelp URL"),
    EXPORT_COLUMN_HEADERS.join(", "),
  );

  const [row] = toExportRows([
    lead({ source: "google", url: "https://www.google.com/maps/place/T" }),
  ]);
  check(
    "the cell says Google Maps, not `google`",
    row?.Source === "Google Maps",
    String(row?.Source),
  );
  check(
    "the listing URL travels with it",
    row?.["Listing URL"] === "https://www.google.com/maps/place/T",
    String(row?.["Listing URL"]),
  );
}

/* -------------------------------------------------------------------------- */

function main(): void {
  console.log("Lead source regression tests\n============================");
  vocabulary();
  precedence();
  mapsColumns();
  breakdown();
  filtering();
  queryString();
  exporting();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
