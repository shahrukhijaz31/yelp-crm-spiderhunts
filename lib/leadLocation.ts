/**
 * Where a lead *is*, derived from the one place that information exists.
 *
 * The scrapers do not report a country, a city, or anything else structured
 * about location. They report `address` — one freeform string, formatted by
 * whichever directory produced it — and while the portal only held San
 * Francisco that was enough, because there was nothing to filter between. Runs
 * now come back from the UK and elsewhere, and "show me the UK leads" is not a
 * question `address` can answer: `LIKE '%UK%'` matches a business on Ukiah
 * Street and misses every London row whose address ends in a postcode.
 *
 * So the location is parsed out of the address once, at the moment a lead is
 * written, and stored in two real columns (`leads.country`, `leads.city`) that
 * a `WHERE` and a `GROUP BY` can use. This file is the entire definition of
 * that parse, and it is deliberately pure — no Prisma, no React — so the
 * ingest path, the backfill script and the tests all run the *same* code. A
 * second copy of these rules written in SQL for the backfill would drift from
 * this one on the first fix, and the two would then disagree about which
 * country half the table is in.
 *
 * ---------------------------------------------------------------------------
 * What it parses, and why only the tail
 * ---------------------------------------------------------------------------
 * Not the whole address — only the last comma-separated segment or two. That is
 * where every directory puts the postal code, and a postal code is the one part
 * of an address whose *shape* names the country: `CA 94122` is American,
 * `M1 2AB` is British, `V6B 1A1` is Canadian, `NSW 2000` is Australian. The
 * street line is skipped entirely, which is the point — it is the part that is
 * unstructured, localised and full of words like "London Road" that would fool
 * a substring match.
 *
 * A lead whose address defeats every rule below gets `null` for both fields and
 * lands in the "Unknown" bucket of the filter. That is a visible, countable
 * state on purpose: an address the parser cannot read should be a row somebody
 * can go and look at, not a row quietly filed under the wrong country.
 */

/**
 * The filter value meaning "no country/city could be determined".
 *
 * `"none"` rather than an empty parameter, matching the vocabulary the callback
 * filter already uses (`CALLBACK_RANGE_LABELS.none` — "No callback date"), so
 * the URL reads the same way across filters. Country codes are uppercase and no
 * city normalises to a lowercase word on its own, so it cannot collide with a
 * real value.
 */
export const UNKNOWN_LOCATION = "none";

/**
 * The countries the portal knows how to name, keyed by ISO 3166-1 alpha-2.
 *
 * A closed set, and the same kind of closed set `LEAD_SOURCES` is: this value
 * is filtered on, drawn in a list and written by a parser, so a country the UI
 * has no label for should not be creatable. Anything the rules below cannot
 * place stays `null` instead of inventing a code.
 *
 * The list is the countries the scrapers actually run in plus the ones they
 * plausibly will; adding another is one line here and one pattern below.
 */
export const COUNTRY_LABELS: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  IE: "Ireland",
  AU: "Australia",
  NZ: "New Zealand",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  BE: "Belgium",
  PT: "Portugal",
  CH: "Switzerland",
  AT: "Austria",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  AE: "United Arab Emirates",
  SA: "Saudi Arabia",
  ZA: "South Africa",
  IN: "India",
  PK: "Pakistan",
  SG: "Singapore",
  MY: "Malaysia",
  PH: "Philippines",
  MX: "Mexico",
  BR: "Brazil",
};

/** Every country code the parser may produce, for validating a query string. */
export const LEAD_COUNTRIES = Object.keys(COUNTRY_LABELS);

/** A country code as a human label, or the code itself if it is not known. */
export function countryLabel(code: string | null): string {
  if (code === null || code === UNKNOWN_LOCATION) return "Unknown location";
  return COUNTRY_LABELS[code] ?? code;
}

export interface LeadLocation {
  /** ISO 3166-1 alpha-2, or null when the address did not say. */
  country: string | null;
  /** As written in the address, normalised for case — see {@link normaliseCity}. */
  city: string | null;
}

const NOWHERE: LeadLocation = { country: null, city: null };

// --- country names ----------------------------------------------------------

/**
 * The spellings a directory actually writes at the end of an address.
 *
 * Matched only against the *final* segment, so a name that is also a city or a
 * region would be a problem — which is why the country called Georgia is absent
 * and the US state of that name is reached through `US_STATES` instead.
 */
const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united kingdom": "GB",
  uk: "GB",
  "u.k.": "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  canada: "CA",
  ireland: "IE",
  eire: "IE",
  australia: "AU",
  "new zealand": "NZ",
  germany: "DE",
  deutschland: "DE",
  france: "FR",
  spain: "ES",
  espana: "ES",
  "españa": "ES",
  italy: "IT",
  italia: "IT",
  netherlands: "NL",
  "the netherlands": "NL",
  nederland: "NL",
  holland: "NL",
  belgium: "BE",
  portugal: "PT",
  switzerland: "CH",
  schweiz: "CH",
  suisse: "CH",
  austria: "AT",
  osterreich: "AT",
  "österreich": "AT",
  sweden: "SE",
  sverige: "SE",
  norway: "NO",
  norge: "NO",
  denmark: "DK",
  danmark: "DK",
  finland: "FI",
  poland: "PL",
  polska: "PL",
  "united arab emirates": "AE",
  uae: "AE",
  "u.a.e.": "AE",
  "saudi arabia": "SA",
  "south africa": "ZA",
  india: "IN",
  pakistan: "PK",
  singapore: "SG",
  malaysia: "MY",
  philippines: "PH",
  "the philippines": "PH",
  mexico: "MX",
  "méxico": "MX",
  brazil: "BR",
  brasil: "BR",
};

/**
 * The same country names again, as a pattern that matches one at the *end* of a
 * segment rather than as the whole of one.
 *
 * Real scraper output does not put a comma before the country. Production is
 * full of rows like `5440 Royalmount Ave Montreal, QC H4P 1H7 Canada`, where
 * the final segment is `QC H4P 1H7 Canada` — so an exact-match lookup finds no
 * country, every anchored postal pattern fails on the trailing word, and the
 * row falls through every rule. That one missing comma left 42,733 of 45,039
 * live leads unplaced.
 *
 * Longest name first, so `united states` is tried before `us` and the whole
 * name is stripped rather than half of it. The leading `\s` is required: it is
 * what stops `Norfolk` ending in "uk" and `Sunderland` ending in "land".
 */
const TRAILING_COUNTRY = new RegExp(
  "\\s+(" +
    Object.keys(COUNTRY_NAMES)
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")$",
  "i",
);

/**
 * A segment with any trailing country name cut off it, and the country it named.
 *
 * Returns the segment untouched and a null country when it does not end in one.
 */
function splitTrailingCountry(segment: string): {
  country: string | null;
  rest: string;
} {
  const match = TRAILING_COUNTRY.exec(segment);
  if (!match) return { country: null, rest: segment };
  return {
    country: COUNTRY_NAMES[match[1].toLowerCase()] ?? null,
    rest: segment.slice(0, match.index).trim(),
  };
}

// --- regional codes ---------------------------------------------------------

/**
 * US state and territory codes. Needed because `CA 94122` and `NSW 2000` are
 * told apart by *which* letters precede the digits, not by the digits.
 */
const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS " +
    "MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI " +
    "WY AS GU MP PR VI"
  ).split(" "),
);

const CA_PROVINCES = new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "));

const AU_STATES = new Set("NSW VIC QLD SA WA TAS NT ACT".split(" "));

/**
 * Regions that get written where a town would be, and the country each belongs
 * to — British counties and areas, and the Canadian provinces spelled out.
 *
 * These exist because neither directory is consistent with itself about how
 * much of an address to include. `45 Deansgate, Bolton, Greater Manchester BL1
 * 1AA` and `45 Deansgate, Bolton BL1 1AA` are the same shop, and without this
 * list the first is filed under a "town" called Greater Manchester and the
 * second under Bolton — one business, two filter options, neither of which
 * finds the other. The same happens in Canada the moment a row says `Ottawa,
 * Ontario K1A 0A6` rather than `Ottawa, ON K1A 0A6`.
 *
 * So a segment named here is never taken as the town: the parser steps back
 * over it to the segment before (see {@link cityBefore}). It is also enough on
 * its own to name the country, which is what lets `Ottawa, Ontario` — an
 * address with no postal code in it at all — still land in Canada.
 *
 * **Each name is keyed to a country, and the veto only fires when the rest of
 * the address agrees.** Ontario is a province of Canada and also a city in
 * California; Richmond, Windsor and Hull are towns on both sides of the
 * Atlantic. A veto that fired on the name alone would throw away the real town
 * in `Ontario, CA 91761`. One that fires only when the address is already
 * Canadian cannot.
 */
const GB_REGIONS = [
  "bedfordshire", "berkshire", "buckinghamshire", "cambridgeshire", "cheshire",
  "cleveland", "cornwall", "county durham", "cumbria", "derbyshire", "devon",
  "dorset", "durham", "east riding of yorkshire", "east sussex", "essex",
  "gloucestershire", "greater london", "greater manchester", "hampshire",
  "herefordshire", "hertfordshire", "isle of wight", "kent", "lancashire",
  "leicestershire", "lincolnshire", "merseyside", "norfolk", "north yorkshire",
  "northamptonshire", "northumberland", "nottinghamshire", "oxfordshire",
  "rutland", "shropshire", "somerset", "south yorkshire", "staffordshire",
  "suffolk", "surrey", "tyne and wear", "warwickshire", "west berkshire",
  "west midlands", "west sussex", "west yorkshire", "wiltshire",
  "worcestershire",
  // Wales, Scotland and Northern Ireland: the unitary and council areas a Maps
  // address appends in place of an English county.
  "gwynedd", "powys", "ceredigion", "pembrokeshire", "carmarthenshire",
  "monmouthshire", "denbighshire", "flintshire", "conwy", "wrexham",
  "vale of glamorgan", "rhondda cynon taf", "bridgend", "neath port talbot",
  "caerphilly", "torfaen", "blaenau gwent", "merthyr tydfil", "anglesey",
  "isle of anglesey", "aberdeenshire", "angus", "argyll and bute",
  "ayrshire", "east ayrshire", "north ayrshire", "south ayrshire",
  "clackmannanshire", "dumfries and galloway", "dunbartonshire",
  "east dunbartonshire", "west dunbartonshire", "east lothian", "midlothian",
  "west lothian", "falkirk", "fife", "highland", "inverclyde", "moray",
  "perth and kinross", "renfrewshire", "east renfrewshire", "scottish borders",
  "stirling", "orkney", "shetland", "western isles", "lanarkshire",
  "north lanarkshire", "south lanarkshire", "county antrim", "county armagh",
  "county down", "county fermanagh", "county londonderry", "county tyrone",
];

const CA_REGIONS = [
  "alberta", "british columbia", "manitoba", "new brunswick",
  "newfoundland and labrador", "newfoundland", "northwest territories",
  "nova scotia", "nunavut", "ontario", "prince edward island", "quebec",
  "québec province", "saskatchewan", "yukon",
];

const REGIONS: Record<string, string> = {
  ...Object.fromEntries(GB_REGIONS.map((name) => [name, "GB"])),
  ...Object.fromEntries(CA_REGIONS.map((name) => [name, "CA"])),
};

/**
 * The country a segment names by being a region of it, or null.
 *
 * Case- and punctuation-insensitive, because `Co. Antrim` and `County Antrim`
 * are the same place and a directory will write either.
 */
function regionCountry(segment: string): string | null {
  const key = segment.toLowerCase().replace(/\bco\./g, "county").replace(/[.]/g, "").trim();
  return REGIONS[key] ?? null;
}

// --- postal shapes ----------------------------------------------------------
//
// Several of these lead with `(?:(.+?)\s+)??` — an optional group made *lazy*,
// which is not a typo for `?`. A directory may or may not put a comma between
// the town and the postal code, so each shape has to read both `BC V6Z 2X8` and
// `Vancouver BC V6Z 2X8`. A greedy `?` prefers to match that group, so it hands
// `BC` to the town and leaves the province empty; the lazy form tries without a
// town first and only takes one when the rest of the pattern cannot otherwise
// match. That single character is the difference between a filter offering
// "Vancouver" and one offering "BC".

/**
 * `San Francisco, CA 94122` and `CA 94122` alike — the town is optional because
 * a directory may or may not have put a comma between it and the state.
 *
 * The state code is what makes this American, not the five digits: a bare
 * `94122` is a postal code in any number of countries and is handled by
 * {@link BARE_CODE} below, which names no country at all.
 */
const US_ZIP = /^(?:(.+?)\s+)??([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$/;

/** `M1 2AB`, `SW1A 1AA`, `EC1V 9NR` — anywhere in the segment, not anchored. */
const UK_POSTCODE = /\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/;

/** `Vancouver BC V6Z 2X8`, `BC V6Z 2X8`, `V6Z 2X8`. */
const CA_POSTAL = /^(?:(.+?)\s+)??(?:([A-Za-z]{2})\s+)?[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;

/** `Sydney NSW 2000`, `NSW 2000` — the state code is what makes it Australian. */
const AU_POSTCODE = /^(?:(.+?)\s+)??([A-Za-z]{2,3})\s+\d{4}$/;

/** `Dublin D02 X285`, `D02 X285` — the Irish Eircode. */
const IE_EIRCODE = /^(?:(.+?)\s+)??[A-Za-z]\d{2}\s?[A-Za-z0-9]{4}$/;

/** `1016 GV Amsterdam`, `1012 AB` — four digits, two letters, then the town. */
const NL_POSTCODE = /^\d{4}\s?[A-Za-z]{2}(?:\s+(.+))?$/;

/** `10115 Berlin`, `75001 Paris` — continental "code then city". */
const CODE_THEN_CITY = /^\d{4,6}\s+(.+)$/;

/** `Barcelona 08001` — the same pair the other way round. */
const CITY_THEN_CODE = /^(.+?)\s+\d{4,6}$/;

/**
 * A postal code and nothing else.
 *
 * Names no country on purpose. Four to six digits is the shape of a postal code
 * almost everywhere, and the one thing it cannot tell you is *where* — so this
 * rule only says "that segment was the postcode, so the town is the one before
 * it", which is true regardless of country.
 */
const BARE_CODE = /^\d{4,6}(?:-\d{4})?$/;

// --- text helpers -----------------------------------------------------------

/** Comma-separated parts of an address, trimmed, with the empties dropped. */
function splitSegments(address: string): string[] {
  return address
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part !== "");
}

/**
 * Words that stay lowercase inside a city name, so `Stratford-upon-Avon` is not
 * turned into `Stratford-Upon-Avon`. Never applied to the very first word.
 */
const PARTICLES = new Set(
  "on upon of the and de del la le les du des sur am an der den bei op aan".split(" "),
);

/** `manchester` -> `Manchester`. Only the first letter; the rest is left alone. */
function capitalise(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/**
 * A city name with its case normalised, so two spellings of one town are one
 * entry in the filter list rather than two.
 *
 * `SAN FRANCISCO` and `san francisco` both become `San Francisco`, which is the
 * whole reason this exists: a filter that offers the same town twice, with the
 * leads split between the two, is worse than no filter at all.
 *
 * The awkward case is the initialism. `Washington DC` should keep its `DC` and
 * `NYC` should stay `NYC`, but `SAN FRANCISCO` must not keep its `SAN` — and
 * from a single word there is no telling those apart. So the decision is made
 * from the whole string rather than word by word: a value that still contains a
 * lowercase letter is trusted to have meant its capitals, and one that is
 * entirely uppercase is title-cased outright, unless it is a single short token
 * that can only be an initialism.
 */
export function normaliseCity(value: string): string | null {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:'"-]+|[\s.,;:'"-]+$/g, "")
    .trim();
  if (cleaned === "") return null;
  // A bare number is a postal fragment the rules above failed to strip, not a
  // place — better nothing than a city called "94122".
  if (/^\d+$/.test(cleaned)) return null;

  const shouting = cleaned === cleaned.toUpperCase();
  // `NYC`, `LA` — the only shape an all-caps value can have and still be a name.
  if (shouting && /^[A-Z]{2,3}$/.test(cleaned)) return cleaned;

  const words = cleaned.split(" ").map((word, wordIndex) => {
    // Mixed-case input is trusted about its own capitals: `Washington DC`.
    if (!shouting && /^[A-Z]{2,3}$/.test(word)) return word;

    // Hyphenated parts are capitalised individually, so `stoke-on-trent` reads
    // correctly — and the particle rule applies inside them too, which is the
    // only way `-on-` stays lowercase while `-Trent` does not.
    return word
      .split("-")
      .map((part, partIndex) => {
        const lower = part.toLowerCase();
        if ((wordIndex > 0 || partIndex > 0) && PARTICLES.has(lower)) return lower;
        return capitalise(lower);
      })
      .join("-");
  });

  return words.join(" ");
}

/**
 * Does this segment look like the street line rather than the town?
 *
 * Used as a veto, never as a positive test: when the rules below would pick a
 * segment as the city, this stops them picking `1428 Irving St` for an address
 * that simply never named its town. A wrong city is worse than no city — it is
 * a filter option an agent can select and get the wrong leads from.
 */
function looksLikeStreet(segment: string): boolean {
  if (/^\d/.test(segment)) return true;
  if (/^(suite|ste|unit|apt|apartment|floor|fl|po box|p\.o\. box)\b/i.test(segment)) {
    return true;
  }
  return /\b(st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|hwy|highway|pkwy|parkway|terrace|close|crescent|walk)\.?$/i.test(
    segment,
  );
}

/**
 * That segment as a city, unless it is plainly the street or a region.
 *
 * `country` is what the rest of the address implies, and it is what makes the
 * region veto safe: `Ontario` is refused as a town in a Canadian address and
 * accepted in an American one. Pass null when nothing has named a country yet —
 * a region is then still refused, since it is not a town in any reading.
 */
function cityFrom(segment: string | undefined, country: string | null): string | null {
  if (segment === undefined) return null;
  if (looksLikeStreet(segment)) return null;
  /*
   * A town name has no digits in it.
   *
   * This is the guard that stops the last-resort branch of the parse turning an
   * unrecognised postal segment into a "town". Without it `QC H4P 1H7 Canada`
   * became a city called `QC H4p 1h7 Canada`, and a filter offering thousands
   * of those is worse than one offering none — an agent can tick it, get a
   * meaningless slice of the worklist, and have nothing on screen to say why.
   *
   * Safe against every rule above, because each one hands over a candidate with
   * the postal code already removed: the UK rule cuts it out, and the anchored
   * patterns capture the town in a group of their own.
   */
  if (/\d/.test(segment)) return null;
  const region = regionCountry(segment);
  if (region !== null && (country === null || region === country)) return null;
  return normaliseCity(segment);
}

/**
 * Walking backwards from the postal tail for the town.
 *
 * Not simply "the segment before": an address may put a county between the town
 * and the postcode (`…, Bolton, Greater Manchester, BL1 1AA`), and stopping at
 * the first segment would file that shop under a county. So regions are stepped
 * over, and the search stops the moment it reaches the street line — everything
 * before *that* is a unit or a building name, never a town, and walking past it
 * is how a parser ends up offering "Suite 200" as a place to filter by.
 *
 * Three segments is the reach. Enough for town + county, and short enough that
 * an unusual address cannot drag the search up into the front of the string.
 */
function cityBefore(before: string[], country: string | null): string | null {
  const floor = Math.max(0, before.length - 3);
  for (let index = before.length - 1; index >= floor; index -= 1) {
    const segment = before[index];
    if (looksLikeStreet(segment)) return null;
    const city = cityFrom(segment, country);
    if (city !== null) return city;
  }
  return null;
}

// --- the tail ---------------------------------------------------------------

interface TailReading {
  country: string | null;
  /** The city read out of the tail itself, when it carried one. */
  city: string | null;
  /** Whether the segment *before* the tail is the city. */
  usePrevious: boolean;
  /** False when nothing in the tail was recognised as postal at all. */
  matched: boolean;
}

const NO_MATCH: TailReading = {
  country: null,
  city: null,
  usePrevious: false,
  matched: false,
};

/**
 * The last segment of an address, read as a postal tail.
 *
 * Ordered most specific first. Every rule either names a country outright or
 * says where the city is — usually the segment before, because `…, San
 * Francisco, CA 94122` puts them in that order, and occasionally inside the
 * tail itself, because `…, Manchester M1 2AB` does not.
 */
function readTail(tail: string): TailReading {
  /** A rule that found the town inside the tail, or says it is the one before. */
  const placed = (country: string | null, city: string | null): TailReading => ({
    country,
    city,
    usePrevious: city === null,
    matched: true,
  });

  // Canada before the US: both can carry a two-letter regional code, and the
  // letter-digit-letter body is the half that tells them apart.
  const canadian = CA_POSTAL.exec(tail);
  if (canadian && (!canadian[2] || CA_PROVINCES.has(canadian[2].toUpperCase()))) {
    return placed("CA", cityFrom(canadian[1], "CA"));
  }

  const american = US_ZIP.exec(tail);
  if (american && US_STATES.has(american[2].toUpperCase())) {
    return placed("US", cityFrom(american[1], "US"));
  }

  // A bare regional code with no postal code at all — `…, Ottawa, ON` and
  // `…, Austin, TX`. Canada first, and the two sets do not overlap, so neither
  // country can be reached through the other's code.
  if (/^[A-Za-z]{2}$/.test(tail)) {
    const code = tail.toUpperCase();
    if (CA_PROVINCES.has(code)) return placed("CA", null);
    if (US_STATES.has(code)) return placed("US", null);
  }

  /*
   * A region spelled out, and nothing else — `…, Ottawa, Ontario`, `…, Brighton,
   * East Sussex`. It names the country outright and says the town is the
   * segment before, which is the whole of what an address with no postal code
   * in it can be made to give up.
   */
  const region = regionCountry(tail);
  if (region !== null) return placed(region, null);

  const australian = AU_POSTCODE.exec(tail);
  if (australian && AU_STATES.has(australian[2].toUpperCase())) {
    return placed("AU", cityFrom(australian[1], "AU"));
  }

  /*
   * The UK, and the one rule that cuts the postcode *out of* the tail rather
   * than matching around it.
   *
   * Google Maps writes British addresses as `12 High St, Manchester M1 2AB` —
   * town and postcode in one segment, no comma between them — so the postcode
   * is removed and whatever words are left are the town. When the segment is
   * the postcode alone (`…, Manchester, M1 2AB`, which is how other exports
   * write it) there is nothing left, and the city is the segment before.
   *
   * It cannot be anchored the way the rules above are, because a British
   * postcode has a space in the middle and a town name has spaces around it —
   * there is no prefix/suffix split that finds it. Hence the cut.
   */
  const british = UK_POSTCODE.exec(tail);
  if (british) {
    const rest =
      tail.slice(0, british.index) + tail.slice(british.index + british[0].length);
    return placed("GB", cityFrom(rest.replace(/\s+/g, " ").trim() || undefined, "GB"));
  }

  const irish = IE_EIRCODE.exec(tail);
  if (irish) return placed("IE", cityFrom(irish[1], "IE"));

  const dutch = NL_POSTCODE.exec(tail);
  if (dutch) return placed("NL", cityFrom(dutch[1], "NL"));

  /*
   * A numeric postal code with no country signature in it.
   *
   * Continental Europe and much of the rest of the world writes four to six
   * digits that look identical from country to country, so these rules find the
   * *city* and leave the country to whatever the address named explicitly. That
   * is the honest answer: `75001 Paris` is only French because it says Paris,
   * and guessing from the digit count would file Berlin under France.
   */
  if (BARE_CODE.test(tail)) return placed(null, null);

  const codeFirst = CODE_THEN_CITY.exec(tail);
  if (codeFirst) return placed(null, cityFrom(codeFirst[1], null));

  const codeLast = CITY_THEN_CODE.exec(tail);
  if (codeLast) return placed(null, cityFrom(codeLast[1], null));

  return NO_MATCH;
}

// --- the parse --------------------------------------------------------------

/**
 * A freeform address as a country and a city.
 *
 * Both fields are independent: an address may yield a country and no city
 * (`…, USA` alone), a city and no country (`75001 Paris` with nothing after
 * it), both, or neither. Nothing here ever guesses one from the other.
 */
export function parseAddressLocation(address: string | null | undefined): LeadLocation {
  if (typeof address !== "string") return NOWHERE;
  const segments = splitSegments(address);
  if (segments.length === 0) return NOWHERE;

  /*
   * 1. An explicit country name at the end wins over every shape below — a run
   *    that says "United Kingdom" is not guessing, and neither are we.
   *
   *    Taken two ways, because the directories write it both ways. It may be a
   *    segment of its own (`…, SE1 9SG, United Kingdom`), in which case the
   *    segment goes; or it may be tacked onto the postal segment with no comma
   *    (`…, QC H4P 1H7 Canada`), in which case only those words go and what is
   *    left is still the postal tail, to be read as one below.
   */
  let country: string | null = null;
  const last = segments[segments.length - 1];
  const named = COUNTRY_NAMES[last.toLowerCase()];
  if (named) {
    country = named;
    segments.pop();
  } else {
    const trailing = splitTrailingCountry(last);
    if (trailing.country) {
      country = trailing.country;
      if (trailing.rest === "") segments.pop();
      else segments[segments.length - 1] = trailing.rest;
    }
  }
  if (segments.length === 0) return { country, city: null };

  // 2. The postal tail: the country's signature, and usually where the city is.
  const tail = readTail(segments[segments.length - 1]);
  if (tail.country && !country) country = tail.country;

  if (tail.matched) {
    const city = tail.usePrevious
      ? cityBefore(segments.slice(0, -1), country)
      : tail.city;
    return { country, city };
  }

  /*
   * 3. No postal code anywhere. The last segment is then the best candidate for
   *    the town — `Blue Bottle, 1 Ferry Building, San Francisco` — vetoed when
   *    it is obviously still the street, which is the case a one-line address
   *    like `1428 Irving St` falls into.
   */
  return { country, city: cityFrom(segments[segments.length - 1], country) };
}
