/** Deterministic randomness + fictional customers (people, companies, addresses). */

/** mulberry32 — small, fast, seedable. */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const api = {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    weighted: <T extends string>(w: Record<T, number>): T => {
      const entries = Object.entries(w) as Array<[T, number]>;
      let r = next() * entries.reduce((s, [, v]) => s + v, 0);
      for (const [k, v] of entries) if ((r -= v) < 0) return k;
      return entries[entries.length - 1]![0];
    },
  };
  return api;
}
export type Rng = ReturnType<typeof rng>;

const FIRST = [
  "Maya",
  "Jonas",
  "Priya",
  "Tomas",
  "Leila",
  "Owen",
  "Nadia",
  "Felix",
  "Ines",
  "Rafael",
  "Hana",
  "Marcus",
  "Saanvi",
  "Elio",
  "Freya",
  "Kofi",
  "Lucia",
  "Arjun",
  "Sofia",
  "Emil",
  "Zara",
  "Theo",
  "Anika",
  "Mateo",
  "Ivy",
  "Rohan",
  "Clara",
  "Idris",
  "Mila",
  "Dev",
  "Astrid",
  "Kenji",
  "Noor",
  "Luca",
  "Esme",
  "Tariq",
  "Yara",
  "Oskar",
  "Kavya",
  "Remy",
];
const LAST = [
  "Okafor",
  "Lindqvist",
  "Raman",
  "Castell",
  "Haddad",
  "Brennan",
  "Petrova",
  "Moreau",
  "Varga",
  "Ashworth",
  "Tanaka",
  "Quill",
  "Iyer",
  "Marchetti",
  "Holm",
  "Mensah",
  "Duarte",
  "Kapoor",
  "Novak",
  "Fairbanks",
  "Rahimi",
  "Calloway",
  "Sundberg",
  "Ferreira",
  "Whitlock",
  "Banerjee",
  "Ostrowski",
  "Delacroix",
  "Achebe",
  "Winslow",
  "Nakamura",
  "Rosen",
  "Talbot",
];
const CO_A = [
  "Bluefin",
  "Copperleaf",
  "Driftwood",
  "Emberline",
  "Foxglove",
  "Granite",
  "Harborview",
  "Ironbark",
  "Juniper",
  "Kestrel",
  "Lanternfish",
  "Meridian",
  "Northwind",
  "Orchard",
  "Pinecrest",
  "Quartz",
  "Riverbend",
  "Saltmarsh",
  "Tidewater",
  "Umbra",
  "Vellum",
  "Willow",
  "Yarrow",
  "Zephyr",
  "Amberly",
  "Birchwood",
  "Cobalt",
  "Dunmore",
  "Evergreen",
  "Fernhill",
];
const CO_B = [
  "Labs",
  "Analytics",
  "Studio",
  "Logistics",
  "Health",
  "Media",
  "Robotics",
  "Foods",
  "Partners",
  "Systems",
  "Works",
  "Retail",
  "Energy",
  "Learning",
  "Travel",
  "Finance",
];

export interface Place {
  line1: string;
  city: string;
  state?: string;
  stateCode?: string;
  postalCode: string;
  country: string;
}

const US: Place[] = [
  {
    line1: "",
    city: "San Francisco",
    state: "California",
    stateCode: "CA",
    postalCode: "94107",
    country: "US",
  },
  {
    line1: "",
    city: "Los Angeles",
    state: "California",
    stateCode: "CA",
    postalCode: "90012",
    country: "US",
  },
  {
    line1: "",
    city: "Brooklyn",
    state: "New York",
    stateCode: "NY",
    postalCode: "11201",
    country: "US",
  },
  {
    line1: "",
    city: "Austin",
    state: "Texas",
    stateCode: "TX",
    postalCode: "78701",
    country: "US",
  },
  {
    line1: "",
    city: "Seattle",
    state: "Washington",
    stateCode: "WA",
    postalCode: "98101",
    country: "US",
  },
  {
    line1: "",
    city: "Denver",
    state: "Colorado",
    stateCode: "CO",
    postalCode: "80202",
    country: "US",
  },
  {
    line1: "",
    city: "Chicago",
    state: "Illinois",
    stateCode: "IL",
    postalCode: "60601",
    country: "US",
  },
  {
    line1: "",
    city: "Boston",
    state: "Massachusetts",
    stateCode: "MA",
    postalCode: "02110",
    country: "US",
  },
];
const IN: Place[] = [
  {
    line1: "",
    city: "Chennai",
    state: "Tamil Nadu",
    stateCode: "TN",
    postalCode: "600002",
    country: "IN",
  },
  {
    line1: "",
    city: "Coimbatore",
    state: "Tamil Nadu",
    stateCode: "TN",
    postalCode: "641001",
    country: "IN",
  },
  {
    line1: "",
    city: "Bengaluru",
    state: "Karnataka",
    stateCode: "KA",
    postalCode: "560001",
    country: "IN",
  },
  {
    line1: "",
    city: "Mumbai",
    state: "Maharashtra",
    stateCode: "MH",
    postalCode: "400001",
    country: "IN",
  },
  {
    line1: "",
    city: "Hyderabad",
    state: "Telangana",
    stateCode: "TG",
    postalCode: "500001",
    country: "IN",
  },
  {
    line1: "",
    city: "Pune",
    state: "Maharashtra",
    stateCode: "MH",
    postalCode: "411001",
    country: "IN",
  },
];
const EU: Place[] = [
  { line1: "", city: "Berlin", postalCode: "10115", country: "DE" },
  { line1: "", city: "Munich", postalCode: "80331", country: "DE" },
  { line1: "", city: "Paris", postalCode: "75002", country: "FR" },
  { line1: "", city: "Amsterdam", postalCode: "1012", country: "NL" },
  { line1: "", city: "Stockholm", postalCode: "111 22", country: "SE" },
  { line1: "", city: "Madrid", postalCode: "28013", country: "ES" },
];
export const REGIONS = { US, IN, EU } as const;
export type Region = keyof typeof REGIONS;

const STREETS = [
  "Harbor St",
  "Maple Ave",
  "Station Rd",
  "Mill Lane",
  "Park Row",
  "Canal St",
  "Hill Rd",
];

export interface Person {
  firstName: string;
  lastName: string;
  company?: string;
  email: string;
  phone?: string;
  address: Place;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** One fictional customer. `n` keeps emails unique across the run. */
export function makePerson(r: Rng, region: Region, n: number, company: boolean): Person {
  const firstName = r.pick(FIRST);
  const lastName = r.pick(LAST);
  const place = { ...r.pick(REGIONS[region]) };
  place.line1 = `${r.int(1, 480)} ${r.pick(STREETS)}`;
  if (company) {
    const co = `${r.pick(CO_A)} ${r.pick(CO_B)}`;
    const domain = `${slug(co)}-${n}.example`;
    return {
      firstName,
      lastName,
      company: co,
      email: `${r.pick(["billing", "finance", "accounts", firstName.toLowerCase()])}@${domain}`,
      address: place,
    };
  }
  return {
    firstName,
    lastName,
    email: `${slug(firstName)}.${slug(lastName)}.${n}@example.com`,
    address: place,
  };
}

/** A checksum-valid GSTIN for a made-up PAN (mod-36 check digit). */
export function gstin(stateNumber: string, pan: string, entity = "1"): string {
  const base = `${stateNumber}${pan}${entity}Z`;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const v = chars.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return base + chars[(36 - (sum % 36)) % 36];
}
