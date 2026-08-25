import {
  EMPTY_FILTERS,
  collectLocations,
  describeActiveFilters,
  matchesFilters,
  type LeadFilters,
} from "../lib/filters";
import {
  LEAD_COUNTRIES,
  UNKNOWN_LOCATION,
  buildTownIndex,
  countryLabel,
  normaliseCity,
  parseAddressLocation,
} from "../lib/leadLocation";
import { buildLeadSearchParams, parseLeadSearchParams } from "../lib/leadQuery";
import { parseLeadsCsv } from "../lib/parseLeadsCsv";
import { todayIso } from "../lib/leadUtils";
import type { Lead } from "../lib/types";

/**
 * Regression tests for the location filter.
 *
 *   npm run test:lead-location
 *
 * No server and no database: everything that decides *which country a lead is
 * in* is a pure function, and that is the part worth pinning. The SQL half
 * (`WHERE l.country IN (…)`) is exercised by running the app; what is tested
 * here is the parse that decides what goes in the column, which is where a
 * whole country's worth of leads would quietly go missing from.
 *
 * The unhappy cases matter more than the happy ones. A parser that reads
 * `1428 Irving St, San Francisco, CA 94122` correctly is easy; one that refuses
 * to call `1428 Irving St` a city called "1428 Irving St" is the thing that
 * keeps the filter honest, because a wrong city is an option an agent can tick
 * and get the wrong leads from. So most of what follows checks that the parser
 * declines rather than guesses.
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

/** `address → "COUNTRY/City"`, so an expectation reads as one string. */
function place(address: string): string {
  const { country, city } = parseAddressLocation(address);
  return `${country ?? "—"}/${city ?? "—"}`;
}

function expectPlace(address: string, expected: string): void {
  const actual = place(address);
  check(`${address}  →  ${expected}`, actual === expected, actual);
}

function lead(overrides: Partial<Lead>): Lead {
  return {
    id: "lead-1",
    name: "Golden Gate Plumbing",
    address: "1428 Irving St, San Francisco, CA 94122",
    categories: ["Plumbing"],
    phone: "(415) 555-0182",
    website: null,
    rating: 4.5,
    owner: null,
    url: null,
    source: "yelp",
    country: "US",
    city: "San Francisco",
    status: "not_called",
    notes: "",
    callbackDate: null,
    meetingTime: null,
    meetingAttendees: null,
    meetingNotes: "",
    meetingCompletedAt: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

function unitedStates(): void {
  section("United States");
  expectPlace("1428 Irving St, San Francisco, CA 94122", "US/San Francisco");
  expectPlace("5600 3rd St, San Francisco, CA 94124-1234", "US/San Francisco");
  expectPlace("100 Congress Ave, Austin, TX", "US/Austin");
  expectPlace("1 Infinite Loop, Cupertino, CA 95014, USA", "US/Cupertino");
  expectPlace("742 Evergreen Terrace, Springfield, IL 62704, United States", "US/Springfield");
  // A ZIP with no state in front is still unmistakably a US ZIP.
  expectPlace("12 Main St, Dayton, 45402", "—/Dayton");
}

function unitedKingdom(): void {
  section("United Kingdom");
  // Google Maps puts town and postcode in one segment, no comma between them.
  expectPlace("12 High St, Manchester M1 2AB", "GB/Manchester");
  expectPlace("221B Baker St, London NW1 6XE, UK", "GB/London");
  // Other exports give the postcode its own segment; the town is then before it.
  expectPlace("221B Baker St, London, NW1 6XE", "GB/London");
  expectPlace("The Shard, 32 London Bridge St, London, SE1 9SG, United Kingdom", "GB/London");
  expectPlace("1 Queen St, Stoke-on-Trent ST1 1AA", "GB/Stoke-on-Trent");
  expectPlace("Unit 4, Trafford Centre, Manchester, M17 8AA, UK", "GB/Manchester");
  expectPlace("123 Oxford St, Soho, London W1D 2JA", "GB/London");
  expectPlace("1 Market Pl, Kingston upon Hull HU1 1AA", "GB/Kingston upon Hull");
  // A postcode written without its space is still a postcode.
  expectPlace("12 High St, Manchester M12AB", "GB/Manchester");
  // Country named, postcode absent: half an answer is still an answer.
  expectPlace("14 Grafton Way, Leeds, England", "GB/Leeds");

  section("United Kingdom — all four nations");
  expectPlace("5 Princes St, Edinburgh EH2 2AN, UK", "GB/Edinburgh");
  expectPlace("77 Sauchiehall St, Glasgow G2 3DH", "GB/Glasgow");
  expectPlace("Cardiff CF10 1BH", "GB/Cardiff");
  expectPlace("10 Donegall Sq, Belfast BT1 5GS, UK", "GB/Belfast");

  /*
   * The county trap, and the reason `REGIONS` exists.
   *
   * The same shop is written both with and without its county depending on the
   * run, and a parser that took the segment before the postcode would file the
   * two under different "towns" — Bolton and Greater Manchester — leaving one
   * business as two filter options, neither of which finds the other.
   */
  section("United Kingdom — counties are stepped over, not filtered by");
  expectPlace("45 Deansgate, Bolton, Greater Manchester BL1 1AA", "GB/Bolton");
  expectPlace(
    "45 Deansgate, Bolton, Greater Manchester, BL1 1AA, United Kingdom",
    "GB/Bolton",
  );
  expectPlace("12 High St, London, Greater London, SW1A 1AA, United Kingdom", "GB/London");
  expectPlace("8 Church Rd, Birmingham, West Midlands B1 1AA", "GB/Birmingham");
  expectPlace("3 Sea View, Brighton, East Sussex BN1 1AA, UK", "GB/Brighton");
  expectPlace("22 Mill Ln, Leeds, West Yorkshire, LS1 1AA", "GB/Leeds");
  // Both spellings of the same address agree, which is the whole point.
  check(
    "with and without the county land on the same town",
    place("45 Deansgate, Bolton, Greater Manchester BL1 1AA") ===
      place("45 Deansgate, Bolton BL1 1AA"),
    `${place("45 Deansgate, Bolton, Greater Manchester BL1 1AA")} vs ${place("45 Deansgate, Bolton BL1 1AA")}`,
  );
}

function canada(): void {
  section("Canada");
  expectPlace("1 Dundas St E, Toronto, ON M5B 2R8", "CA/Toronto");
  expectPlace("5 Jasper Ave NW, Edmonton, AB T5J 0R2, Canada", "CA/Edmonton");
  expectPlace("1 Portage Ave, Winnipeg, MB R3C 0G8", "CA/Winnipeg");
  expectPlace("300 8 Ave SW, Calgary, AB T2P 1C5, Canada", "CA/Calgary");
  expectPlace("1 Water St, St. John's, NL A1C 1A1", "CA/St. John's");
  expectPlace("Suite 200, 100 King St W, Toronto, ON M5X 1A9, Canada", "CA/Toronto");
  // A postal code with no province in front of it, and one with no space in it.
  expectPlace("10 Yonge St, Toronto, M5E 1R4", "CA/Toronto");
  expectPlace("10 Yonge St, Toronto ON M5E1R4", "CA/Toronto");
  // Accents survive the case normalisation rather than being flattened.
  expectPlace("275 Rue Notre-Dame E, Montréal, QC H2Y 1C6, Canada", "CA/Montréal");
  expectPlace("1 Rue du Petit-Champlain, Québec City, QC G1K 4H4", "CA/Québec City");

  section("Canada — the province is never the town");
  // Spelled out rather than abbreviated.
  expectPlace("1 Wellington St, Ottawa, Ontario K1A 0A6", "CA/Ottawa");
  expectPlace("999 Robson St, Vancouver, British Columbia V6Z 2X8", "CA/Vancouver");
  // No postal code at all: the province alone still names the country.
  expectPlace("1 Wellington St, Ottawa, ON", "CA/Ottawa");
  expectPlace("1 Wellington St, Ottawa, Ontario", "CA/Ottawa");
  check(
    "abbreviated and spelled-out provinces land on the same town",
    place("1 Wellington St, Ottawa, ON K1A 0A6") ===
      place("1 Wellington St, Ottawa, Ontario K1A 0A6"),
    `${place("1 Wellington St, Ottawa, ON K1A 0A6")} vs ${place("1 Wellington St, Ottawa, Ontario K1A 0A6")}`,
  );

  /*
   * The reason the region veto is keyed to a country instead of firing on the
   * name alone. Ontario is a province of Canada and a city in California; if
   * `Ontario` were refused as a town everywhere, this address would lose its
   * real town and fall back to the street.
   */
  check(
    "Ontario, California is still a town called Ontario",
    place("1 Mall Dr, Ontario, CA 91761") === "US/Ontario",
    place("1 Mall Dr, Ontario, CA 91761"),
  );
}

function elsewhere(): void {
  section("Elsewhere");
  expectPlace("999 Robson St, Vancouver, BC V6Z 2X8", "CA/Vancouver");
  expectPlace("100 Queen St W, Toronto, ON M5H 2N2, Canada", "CA/Toronto");
  expectPlace("200 George St, Sydney NSW 2000", "AU/Sydney");
  expectPlace("Level 3, 20 Bridge St, Sydney, NSW 2000, Australia", "AU/Sydney");
  expectPlace("5 Dawson St, Dublin, D02 X285", "IE/Dublin");
  expectPlace("Prinsengracht 263, 1016 GV Amsterdam, Netherlands", "NL/Amsterdam");
  // Continental "code then city" with no country named: the town is readable,
  // the country is not, and the parser says exactly that rather than guessing.
  expectPlace("Rue de Rivoli 12, 75001 Paris", "—/Paris");
  expectPlace("Friedrichstrasse 43, 10117 Berlin, Germany", "DE/Berlin");
}

/**
 * The shape almost every live address actually has, and the corpus that reads
 * it. See `TownIndex` in `lib/leadLocation.ts`.
 */
function runOnAddresses(): void {
  section("Run-on addresses — the comma is before the province, not the town");

  // Learned from the rows that spell their town out as its own segment.
  const towns = buildTownIndex(
    [
      "Calgary", "Vancouver", "Ottawa", "Brossard", "Gatineau", "La Prairie",
      "Richmond Hill", "Niagara Falls", "Thunder Bay", "Montreal",
    ].map((city) => ({ country: "CA", city })),
  );
  const towns2 = buildTownIndex(
    ["Manchester", "London", "Stoke-on-Trent"].map((city) => ({
      country: "GB",
      city,
    })),
  );

  function expectWith(index: ReturnType<typeof buildTownIndex>, address: string, expected: string) {
    const { country, city } = parseAddressLocation(address, index);
    const actual = `${country ?? "—"}/${city ?? "—"}`;
    check(`${address}  →  ${expected}`, actual === expected, actual);
  }

  // The country was already right without the corpus; the town was not.
  check(
    "without the corpus the country is still read",
    place("3909 Macleod Trail SE Calgary, AB T2G 2R4 Canada") === "CA/—",
    place("3909 Macleod Trail SE Calgary, AB T2G 2R4 Canada"),
  );

  expectWith(towns, "3909 Macleod Trail SE Calgary, AB T2G 2R4 Canada", "CA/Calgary");
  expectWith(towns, "595 W 8th Avenue Vancouver, BC V5Z 1C6 Canada", "CA/Vancouver");
  expectWith(towns, "62 Barrette Street Ottawa, ON K1L 8B3 Canada", "CA/Ottawa");
  expectWith(towns, "8650 Taschereau Blvd Brossard, QC J4X 1C2 Canada", "CA/Brossard");
  expectWith(
    towns,
    "1080 Mainland Street Unit 413 Vancouver, BC V6B 2T4 Canada",
    "CA/Vancouver",
  );
  expectWith(
    towns,
    "101 Rue Saint-Jean-Bosco Bureaux A-1330 Gatineau, QC J8Y 3G5 Canada",
    "CA/Gatineau",
  );

  /*
   * Multi-word towns, which are the whole reason the match is longest-first and
   * not "the last word". Splitting on the final token would invent towns called
   * Hill, Falls and Bay, each an option an agent could tick.
   */
  section("Run-on addresses — multi-word towns are not truncated");
  expectWith(towns, "90 Taschereau Blvd La Prairie, QC J5R 1S8 Canada", "CA/La Prairie");
  expectWith(towns, "12 Yonge Street Richmond Hill, ON L4C 1A1 Canada", "CA/Richmond Hill");
  expectWith(towns, "5 Clifton Hill Niagara Falls, ON L2G 3N5 Canada", "CA/Niagara Falls");
  expectWith(towns, "1 Water St Thunder Bay, ON P7B 1A1 Canada", "CA/Thunder Bay");

  section("Run-on addresses — the corpus recognises, it never invents");
  // No such town has ever been spelled out, so none is produced.
  expectWith(towns, "44 Unknownville Road Nowheretown, ON K0A 1A0 Canada", "CA/—");
  // A town known in Canada does not leak into a British address, or the reverse.
  expectWith(towns2, "12 High St Manchester M1 2AB, UK", "GB/Manchester");
  expectWith(towns, "12 High St Manchester M1 2AB, UK", "GB/—");
  expectWith(towns2, "3909 Macleod Trail SE Calgary, AB T2G 2R4 Canada", "CA/—");

  // A comma-separated town is believed on its own terms and never overridden.
  expectWith(towns, "1 Wellington St, Nowheretown, ON K1A 0A6", "CA/Nowheretown");

  section("Run-on addresses — the trailing country with no comma before it");
  // The fault that left 42,733 of 45,039 live leads unplaced.
  expectPlace("4213 Rue Drolet Montreal, QC H2W 2L7 Canada", "CA/—");
  expectPlace("12 High St, Manchester M1 2AB United Kingdom", "GB/Manchester");
  check(
    "an unparsed postal segment never becomes a town",
    place("5440 Royalmount Ave Montreal, QC H4P 1H7 Canada").split("/")[1] === "—",
    place("5440 Royalmount Ave Montreal, QC H4P 1H7 Canada"),
  );
}

function refusals(): void {
  section("Refusing to guess");
  // A street line alone is not a city, however much it looks like a segment.
  expectPlace("1428 Irving St", "—/—");
  expectPlace("221B Baker Street", "—/—");
  expectPlace("Suite 400", "—/—");
  expectPlace("", "—/—");
  // A ZIP with nothing before it names a country and no town.
  expectPlace("94122", "—/—");
  check("a missing address parses to nothing", place(null as unknown as string) === "—/—");

  // The veto also applies to the segment *before* a postal tail: an address
  // with a ZIP but no town must not promote the street to a city.
  expectPlace("1428 Irving St, CA 94122", "US/—");
}

function casing(): void {
  section("City casing");
  check("SHOUTING is title-cased", normaliseCity("SAN FRANCISCO") === "San Francisco");
  check("lowercase is title-cased", normaliseCity("san francisco") === "San Francisco");
  check(
    "the two spellings collapse to one option",
    normaliseCity("SAN FRANCISCO") === normaliseCity("san francisco"),
  );
  check("hyphens keep their capitals", normaliseCity("stoke-on-trent") === "Stoke-on-Trent");
  check("apostrophes do too", normaliseCity("king's lynn") === "King's Lynn");
  check("initialisms are left alone", normaliseCity("NYC") === "NYC");
  check("a bare number is not a city", normaliseCity("94122") === null);
  check("blank is not a city", normaliseCity("   ") === null);
}

function vocabulary(): void {
  section("Vocabulary");
  check("every country code is two uppercase letters", LEAD_COUNTRIES.every((code) => /^[A-Z]{2}$/.test(code)));
  check(
    "the unknown sentinel cannot collide with a country code",
    !LEAD_COUNTRIES.includes(UNKNOWN_LOCATION),
    UNKNOWN_LOCATION,
  );
  check("a code renders as a name", countryLabel("GB") === "United Kingdom");
  check("null renders as Unknown location", countryLabel(null) === "Unknown location");
  check(
    "so does the sentinel",
    countryLabel(UNKNOWN_LOCATION) === "Unknown location",
  );
}

function filtering(): void {
  section("Filtering");
  const today = todayIso();
  const sf = lead({ country: "US", city: "San Francisco" });
  const manchester = lead({ id: "l2", country: "GB", city: "Manchester" });
  const nowhere = lead({ id: "l3", country: null, city: null });

  function withFilters(overrides: Partial<LeadFilters>): LeadFilters {
    return { ...EMPTY_FILTERS, ...overrides };
  }

  check(
    "no location filter shows every lead, placed or not",
    [sf, manchester, nowhere].every((row) => matchesFilters(row, EMPTY_FILTERS, today)),
  );

  const uk = withFilters({ countries: ["GB"] });
  check("a country narrows to it", matchesFilters(manchester, uk, today));
  check("and excludes the others", !matchesFilters(sf, uk, today));
  check(
    "an unplaced lead is not swept into a country it was never given",
    !matchesFilters(nowhere, uk, today),
  );

  const unknown = withFilters({ countries: [UNKNOWN_LOCATION] });
  check("Unknown location finds the unplaced lead", matchesFilters(nowhere, unknown, today));
  check("and nothing else", !matchesFilters(sf, unknown, today));

  const both = withFilters({ countries: ["GB", UNKNOWN_LOCATION] });
  check(
    "Unknown sits alongside real countries rather than replacing them",
    matchesFilters(manchester, both, today) && matchesFilters(nowhere, both, today),
  );

  const town = withFilters({ cities: ["Manchester"] });
  check("a town narrows to it", matchesFilters(manchester, town, today));
  check("and excludes the others", !matchesFilters(sf, town, today));

  // The groups AND, like every other pair in the rail.
  const contradiction = withFilters({ countries: ["US"], cities: ["Manchester"] });
  check(
    "country and town are ANDed, so a contradiction matches nothing",
    !matchesFilters(manchester, contradiction, today) &&
      !matchesFilters(sf, contradiction, today),
  );
}

function options(): void {
  section("Option lists");
  const leads = [
    lead({ country: "US", city: "San Francisco" }),
    lead({ id: "l2", country: "US", city: "San Francisco" }),
    lead({ id: "l3", country: "US", city: "Oakland" }),
    lead({ id: "l4", country: "GB", city: "Manchester" }),
    lead({ id: "l5", country: null, city: null }),
  ];
  const { countries, cities } = collectLocations(leads);

  check(
    "countries are counted and ordered by size",
    countries[0]?.code === "US" && countries[0]?.count === 3,
    JSON.stringify(countries),
  );
  check(
    "the unplaced lead is counted, not dropped",
    countries.some((entry) => entry.code === UNKNOWN_LOCATION && entry.count === 1),
    JSON.stringify(countries),
  );
  check(
    "towns carry the country they were counted under",
    cities.find((entry) => entry.name === "Manchester")?.country === "GB",
    JSON.stringify(cities),
  );
  check(
    "a repeated town is one option with a count of two",
    cities.filter((entry) => entry.name === "San Francisco").length === 1 &&
      cities.find((entry) => entry.name === "San Francisco")?.count === 2,
    JSON.stringify(cities),
  );
}

function queryString(): void {
  section("Query string");
  const query = parseLeadSearchParams(new URLSearchParams(), "2026-08-25");
  const round = (filters: Partial<LeadFilters>) =>
    parseLeadSearchParams(
      buildLeadSearchParams({
        ...query,
        filters: { ...EMPTY_FILTERS, ...filters },
      }),
      "2026-08-25",
    ).filters;

  const trip = round({ countries: ["GB", UNKNOWN_LOCATION], cities: ["Manchester", "Leeds"] });
  check(
    "countries survive the round trip",
    trip.countries.join(",") === `GB,${UNKNOWN_LOCATION}`,
    trip.countries.join(","),
  );
  check(
    "towns survive it too",
    trip.cities.join(",") === "Manchester,Leeds",
    trip.cities.join(","),
  );

  const hostile = parseLeadSearchParams(
    new URLSearchParams("country=XX&country=GB&country=us&city=&city=Leeds"),
    "2026-08-25",
  ).filters;
  check(
    "an unknown country code is dropped, not queried for",
    hostile.countries.join(",") === "GB",
    hostile.countries.join(","),
  );
  check(
    "a blank city is a stray separator, not a filter",
    hostile.cities.join(",") === "Leeds",
    hostile.cities.join(","),
  );

  const flood = new URLSearchParams();
  for (let index = 0; index < 500; index += 1) flood.append("city", `Town ${index}`);
  check(
    "a flood of towns is capped rather than turned into a 500-element IN list",
    parseLeadSearchParams(flood, "2026-08-25").filters.cities.length === 200,
  );

  const chips = describeActiveFilters({
    ...EMPTY_FILTERS,
    countries: ["GB"],
    cities: ["Manchester"],
  });
  check(
    "each location constraint gets its own clearable chip",
    chips.some((chip) => chip.id === "country:GB" && chip.label === "United Kingdom") &&
      chips.some((chip) => chip.id === "city:Manchester"),
    chips.map((chip) => chip.id).join(", "),
  );
}

function importing(): void {
  section("Import");
  const csv = [
    "name,address,phone_number",
    '"Manchester Plumbers","12 High St, Manchester M1 2AB","0161 555 0182"',
    '"Golden Gate Plumbing","1428 Irving St, San Francisco, CA 94122","(415) 555-0182"',
  ].join("\n");

  const { leads } = parseLeadsCsv(csv, "sample");
  const uk = leads.find((row) => row.name === "Manchester Plumbers");
  const us = leads.find((row) => row.name === "Golden Gate Plumbing");

  check(
    "a UK row is placed on import, with no new CSV column",
    uk?.country === "GB" && uk?.city === "Manchester",
    `${uk?.country}/${uk?.city}`,
  );
  check(
    "and so is a US one, from the same file",
    us?.country === "US" && us?.city === "San Francisco",
    `${us?.country}/${us?.city}`,
  );
}

/* -------------------------------------------------------------------------- */

function main(): void {
  console.log("Lead location regression tests\n==============================");
  unitedStates();
  unitedKingdom();
  canada();
  elsewhere();
  runOnAddresses();
  refusals();
  casing();
  vocabulary();
  filtering();
  options();
  queryString();
  importing();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
