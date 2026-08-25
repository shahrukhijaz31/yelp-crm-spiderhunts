import { parseAddressLocation } from "./leadLocation";
import { todayIso } from "./leadUtils";
import type { CallStatus, Lead, LeadSource } from "./types";

/**
 * Sample data. No longer part of any request path — the app reads Postgres now
 * (`lib/leadDb.ts`) — this is a **development fixture**, used by
 * `npm run db:seed -- --demo` to put a realistic spread of statuses, callbacks
 * and booked meetings into a fresh database. The sample CSV cannot do that job:
 * it has only scraper columns, so it seeds a portal where every lead is "Not
 * called" and the Callbacks, Meetings and Reports views are empty.
 *
 * Kept out of `prisma/` deliberately: the callback dates are relative to
 * "today", which only makes sense as generated data, not as a static fixture.
 */

interface MockSeed {
  name: string;
  address: string;
  categories: string[];
  phone: string | null;
  website: string | null;
  rating: number | null;
  owner: string | null;
  status?: CallStatus;
  notes?: string;
  /** Days from today for the callback date; omit for no callback. */
  callbackInDays?: number;
  /** 24-hour `HH:MM` when a slot has actually been booked. */
  meetingTime?: string;
  meetingAttendees?: string;
  meetingNotes?: string;
  /** Days from today the meeting was marked done. */
  completedInDays?: number;
}

/** `YYYY-MM-DD`, `offsetDays` from today, in local time. */
function isoOffsetDays(offsetDays: number): string {
  const [year, month, day] = todayIso().split("-").map(Number);
  const date = new Date(year, month - 1, day + offsetDays);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Which directory a fixture lead pretends to have come from.
 *
 * Every third one is Google, so a seeded database exercises the Source filter,
 * the row badge and the export column instead of showing one value everywhere —
 * a fixture where every lead is Yelp would look identical whether the source
 * column worked or not. Deterministic rather than random for the usual reason:
 * two people running the seed should be looking at the same portal.
 */
function seedSource(index: number): LeadSource {
  return index % 3 === 0 ? "google" : "yelp";
}

/** The listing URL a lead of that source would actually carry. */
function listingUrl(source: LeadSource, name: string): string {
  return source === "google"
    ? `https://www.google.com/maps/place/${encodeURIComponent(name)}`
    : `https://www.yelp.com/biz/${slugify(name)}-san-francisco`;
}

const SEEDS: MockSeed[] = [
  {
    name: "Golden Gate Plumbing Co.",
    address: "1428 Irving St, San Francisco, CA 94122",
    categories: ["Plumbing", "Water Heater Installation"],
    phone: "(415) 555-0182",
    website: "https://goldengateplumbing.com",
    rating: 4.5,
    owner: "Marcus Delgado",
    status: "interested",
    notes: "Owner answered directly. Wants a quote for a 5-van fleet wrap. Send deck by Friday.",
    callbackInDays: 0,
    meetingTime: "10:30",
    meetingAttendees: "Marcus Delgado (owner), Priya from ops",
    meetingNotes: "Bring the fleet-wrap deck and last quarter's case study.",
  },
  {
    name: "Sunset Auto Body",
    address: "2201 Taraval St, San Francisco, CA 94116",
    categories: ["Auto Repair", "Body Shops"],
    phone: "(415) 555-0143",
    website: "https://sunsetautobody.net",
    rating: 4.0,
    owner: "Rina Patel",
    status: "voicemail",
    notes: "Left VM with the front desk. Best time to reach is before 10am.",
    callbackInDays: 0,
  },
  {
    name: "Mission Taqueria",
    address: "3120 24th St, San Francisco, CA 94110",
    categories: ["Mexican", "Restaurants", "Tacos"],
    phone: "(415) 555-0117",
    website: null,
    rating: 4.5,
    owner: null,
    status: "no_answer",
    notes: "Rang out twice. No website — good fit for the starter package.",
    callbackInDays: -2,
  },
  {
    name: "Bayview Dental Group",
    address: "5600 3rd St, San Francisco, CA 94124",
    categories: ["Dentists", "General Dentistry"],
    phone: "(415) 555-0166",
    website: "https://bayviewdentalgroup.com",
    rating: 3.5,
    owner: "Dr. Alan Whitfield",
    status: "not_interested",
    notes: "Already under contract with another agency through next year.",
  },
  {
    name: "Nob Hill Dry Cleaners",
    address: "1050 California St, San Francisco, CA 94108",
    categories: ["Dry Cleaning", "Laundry Services"],
    phone: null,
    website: null,
    rating: 4.0,
    owner: null,
    notes: "",
  },
  {
    name: "Presidio Landscaping",
    address: "88 Lincoln Blvd, San Francisco, CA 94129",
    categories: ["Landscaping", "Tree Services"],
    phone: "(415) 555-0198",
    website: "https://presidiolandscaping.co",
    rating: 5.0,
    owner: "Tomas Vega",
    status: "interested",
    notes: "Very warm. Asked for pricing tiers in writing.",
    callbackInDays: 2,
    meetingTime: "14:00",
    meetingAttendees: "Tomas Vega (owner)",
  },
  {
    name: "Castro Barber Lounge",
    address: "440 Castro St, San Francisco, CA 94114",
    categories: ["Barbers", "Men's Hair Salons"],
    phone: "(415) 555-0122",
    website: null,
    rating: 4.5,
    owner: "Devon Marsh",
    status: "no_answer",
    notes: "",
    callbackInDays: -1,
    meetingTime: "13:30",
    meetingAttendees: "Devon Marsh",
    meetingNotes: "Ran through pricing. Wants to think it over for a week.",
    completedInDays: -1,
  },
  {
    name: "Richmond HVAC Services",
    address: "3822 Geary Blvd, San Francisco, CA 94118",
    categories: ["Heating & Air Conditioning", "HVAC"],
    phone: "(415) 555-0154",
    website: "https://richmondhvac.com",
    rating: 4.0,
    owner: "Sylvia Okonkwo",
    status: "voicemail",
    notes: "Mailbox full on first attempt, VM left on second.",
    callbackInDays: 3,
  },
  {
    name: "Marina Pet Grooming",
    address: "2145 Chestnut St, San Francisco, CA 94123",
    categories: ["Pet Groomers", "Pet Services"],
    phone: "(415) 555-0131",
    website: "https://marinapetgrooming.com",
    rating: 4.5,
    owner: null,
  },
  {
    name: "SoMa Print & Sign",
    address: "755 Brannan St, San Francisco, CA 94103",
    categories: ["Printing Services", "Signmaking"],
    phone: "(415) 555-0109",
    website: "https://somaprintsign.com",
    rating: 3.5,
    owner: "Hector Nunez",
    status: "do_not_call",
    notes: "Asked to be removed from all call lists. Do not contact again.",
  },
  {
    name: "Pacific Heights Yoga",
    address: "2020 Fillmore St, San Francisco, CA 94115",
    categories: ["Yoga", "Fitness & Instruction"],
    phone: "(415) 555-0177",
    website: "https://pacheightsyoga.com",
    rating: 5.0,
    owner: "Ayesha Kaur",
    status: "not_called",
    notes: "",
    callbackInDays: 0,
  },
  {
    name: "Chinatown Herbal Pharmacy",
    address: "728 Grant Ave, San Francisco, CA 94108",
    categories: ["Herbs & Spices", "Traditional Chinese Medicine"],
    phone: "(415) 555-0163",
    website: null,
    rating: 4.0,
    owner: null,
  },
  {
    name: "Golden Gate Plumbing",
    address: "1428 Irving Street, San Francisco, CA 94122",
    categories: ["Plumbing"],
    phone: "(415) 555-0182",
    website: "https://goldengateplumbing.com",
    rating: 4.5,
    owner: "Marcus Delgado",
    notes: "",
  },
  {
    name: "Haight Street Records",
    address: "1601 Haight St, San Francisco, CA 94117",
    categories: ["Vinyl Records", "Music & DVDs"],
    phone: "(415) 555-0140",
    website: "https://haightstreetrecords.com",
    rating: 4.5,
    owner: "Priya Raman",
    status: "no_answer",
    notes: "Store opens at noon, call after.",
  },
  {
    name: "Excelsior Family Bakery",
    address: "4501 Mission St, San Francisco, CA 94112",
    categories: ["Bakeries", "Desserts"],
    phone: "(415) 555-0128",
    website: null,
    rating: 4.5,
    owner: "Luisa Ferreira",
    status: "interested",
    notes: "Interested but wants to talk to her business partner first.",
    callbackInDays: 1,
    meetingTime: "09:15",
    meetingAttendees: "Luisa Ferreira and her partner",
    meetingNotes: "Partner makes the final call — keep the pitch short.",
  },
  {
    name: "Potrero Hill Physical Therapy",
    address: "1200 18th St, San Francisco, CA 94107",
    categories: ["Physical Therapy", "Sports Medicine"],
    phone: "(415) 555-0191",
    website: "https://potrerohillpt.com",
    rating: 4.0,
    owner: null,
  },
  {
    name: "Noe Valley Wine Shop",
    address: "3900 24th St, San Francisco, CA 94114",
    categories: ["Beer, Wine & Spirits"],
    phone: "(415) 555-0119",
    website: "https://noevalleywine.com",
    rating: 4.5,
    owner: "Gregor Halvorsen",
    status: "bad_number",
    notes: "Number is disconnected. Try the website contact form instead.",
  },
  {
    name: "Tenderloin Tailoring",
    address: "610 Larkin St, San Francisco, CA 94109",
    categories: ["Sewing & Alterations"],
    phone: "555-0173",
    website: null,
    rating: 3.5,
    owner: null,
    notes: "",
  },
  {
    name: "Inner Sunset Veterinary",
    address: "1300 9th Ave, San Francisco, CA 94122",
    categories: ["Veterinarians", "Emergency Pet Hospital"],
    phone: "(415) 555-0185",
    website: "https://innersunsetvet.com",
    rating: 4.0,
    owner: "Dr. Meera Chandra",
    status: "voicemail",
    notes: "",
    callbackInDays: 5,
  },
  {
    name: "Dogpatch Coffee Roasters",
    address: "2455 3rd St, San Francisco, CA 94107",
    categories: ["Coffee & Tea", "Cafes"],
    phone: "(415) 555-0136",
    website: "https://dogpatchroasters.com",
    rating: 4.5,
    owner: "Ivan Petrov",
  },
  {
    name: "Glen Park Locksmith",
    address: "2830 Diamond St, San Francisco, CA 94131",
    categories: ["Keys & Locksmiths"],
    phone: "(415) 555-0147",
    website: null,
    rating: 4.0,
    owner: null,
    status: "not_interested",
    notes: "One-man shop, says he's already at capacity.",
  },
  {
    name: "West Portal Optometry",
    address: "115 West Portal Ave, San Francisco, CA 94127",
    categories: ["Optometrists", "Eyewear & Opticians"],
    phone: "(415) 555-0158",
    website: "https://westportaloptometry.com",
    rating: 4.5,
    owner: "Dr. Nathan Pierce",
    status: "no_answer",
    notes: "",
    callbackInDays: -4,
  },
  {
    name: "Bernal Heights Hardware",
    address: "331 Cortland Ave, San Francisco, CA 94110",
    categories: ["Hardware Stores"],
    phone: null,
    website: "https://bernalhardware.com",
    rating: 4.5,
    owner: null,
    notes: "No phone on the listing — check the website for a number.",
  },
  {
    name: "Japantown Sushi Bar",
    address: "1737 Post St, San Francisco, CA 94115",
    categories: ["Sushi Bars", "Japanese", "Restaurants"],
    phone: "(415) 555-0193",
    website: "https://japantownsushibar.com",
    rating: 4.0,
    owner: "Kenji Aoyama",
  },
  {
    name: "Outer Sunset Surf Shop",
    address: "3809 Noriega St, San Francisco, CA 94122",
    categories: ["Surf Shop", "Sporting Goods"],
    phone: "(415) 555-0126",
    website: null,
    rating: 5.0,
    owner: "Cody Braithwaite",
    status: "interested",
    notes: "Wants a follow-up after their busy season. Mention the seasonal discount.",
    callbackInDays: 7,
    meetingTime: "16:45",
  },
  {
    name: "Financial District Legal Group",
    address: "580 California St, San Francisco, CA 94104",
    categories: ["Business Law", "Lawyers"],
    phone: "(415) 555-0102",
    website: "https://fidilegal.com",
    rating: 3.5,
    owner: "Karen Whitmore",
    status: "do_not_call",
    notes: "Legal dept asked to be removed.",
  },
  {
    name: "Visitacion Valley Auto Glass",
    address: "2500 Bayshore Blvd, San Francisco, CA 94134",
    categories: ["Auto Glass Services", "Windshield Installation"],
    phone: "(415) 555-0143",
    website: null,
    rating: 4.0,
    owner: null,
    notes: "",
  },
  {
    name: "Cole Valley Florist",
    address: "901 Cole St, San Francisco, CA 94117",
    categories: ["Florists", "Gift Shops"],
    phone: "(415) 555-0114",
    website: "https://colevalleyflorist.com",
    rating: 4.5,
    owner: "Anaïs Lemoine",
    status: "voicemail",
    notes: "",
    callbackInDays: -3,
  },
  {
    name: "Portola Roofing & Gutters",
    address: "2680 San Bruno Ave, San Francisco, CA 94134",
    categories: ["Roofing", "Gutter Services"],
    phone: "(415) 555-0170",
    website: "https://portolaroofing.com",
    rating: 4.0,
    owner: "Sam Okafor",
    status: "bad_number",
    notes: "Reached a fax tone.",
  },
  {
    name: "Lower Haight Bike Repair",
    address: "500 Haight St, San Francisco, CA 94117",
    categories: ["Bikes", "Bike Repair/Maintenance"],
    phone: "(415) 555-0159",
    website: null,
    rating: 4.5,
    owner: null,
  },
  {
    name: "Twin Peaks Cleaning Services",
    address: "150 Portola Dr, San Francisco, CA 94131",
    categories: ["Home Cleaning", "Office Cleaning"],
    phone: "(415) 555-0148",
    website: "https://twinpeakscleaning.com",
    rating: 3.5,
    owner: "Rosa Jimenez",
    status: "not_called",
    notes: "",
    callbackInDays: 0,
  },
  {
    name: "Embarcadero Event Catering",
    address: "1 Ferry Building, San Francisco, CA 94111",
    categories: ["Caterers", "Event Planning & Services"],
    phone: "(415) 555-0107",
    website: "https://embarcaderocatering.com",
    rating: 4.5,
    owner: "Bianca Rossi",
    status: "no_answer",
    notes: "Tried the main line and the mobile. Try again Monday.",
  },
  {
    name: "Alamo Square Photography",
    address: "1250 Fulton St, San Francisco, CA 94117",
    categories: ["Photographers", "Session Photography"],
    phone: null,
    website: null,
    rating: 5.0,
    owner: "Theo Lindqvist",
    notes: "Listing has no phone and no site. Low priority.",
  },
  {
    name: "Ingleside Tire & Brake",
    address: "1490 Ocean Ave, San Francisco, CA 94112",
    categories: ["Tires", "Auto Repair"],
    phone: "(415) 555-0121",
    website: "https://inglesidetire.com",
    rating: 4.0,
    owner: "Darnell Hughes",
  },
  {
    name: "North Beach Pizzeria",
    address: "601 Columbus Ave, San Francisco, CA 94133",
    categories: ["Pizza", "Italian", "Restaurants"],
    phone: "(415) 555-0135",
    website: "https://northbeachpizzeria.com",
    rating: 4.5,
    owner: null,
    status: "interested",
    notes: "Manager was enthusiastic but the owner makes the call. Owner in Tuesdays and Thursdays.",
    callbackInDays: 1,
    meetingTime: "11:00",
    meetingAttendees: "Store manager, owner joining by phone",
  },
];

export function getMockLeads(): Lead[] {
  return SEEDS.map((seed, index) => {
    const source = seedSource(index);
    return {
      id: `mock-${String(index + 1).padStart(3, "0")}`,
      name: seed.name,
      address: seed.address,
      categories: seed.categories,
      phone: seed.phone,
      website: seed.website,
      rating: seed.rating,
      owner: seed.owner,
      url: listingUrl(source, seed.name),
      source,
      // Parsed rather than written into the seeds: the fixture should exercise
      // the same derivation a scraped row goes through, so a demo database
      // shows the Location filter behaving exactly as production does.
      ...parseAddressLocation(seed.address),
      status: seed.status ?? "not_called",
      notes: seed.notes ?? "",
      callbackDate:
        seed.callbackInDays === undefined ? null : isoOffsetDays(seed.callbackInDays),
      meetingTime: seed.meetingTime ?? null,
      meetingAttendees: seed.meetingAttendees ?? null,
      meetingNotes: seed.meetingNotes ?? "",
      meetingCompletedAt:
        seed.completedInDays === undefined ? null : isoOffsetDays(seed.completedInDays),
    };
  });
}