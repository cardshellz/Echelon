/** Pure country identity normalization shared by shipping and returns.
 * Unknown values remain unknown; callers must never default them to a country. */
// Full ISO 3166-1 alpha-2 set — the authoritative allowlist for 2-letter input.
export const ISO_COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET",
  "FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
  "HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
  "JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ",
  "LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM",
  "PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ",
  "TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ",
  "UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
] as const;
export type CountryCode = typeof ISO_COUNTRY_CODES[number];
const ISO2_CODES: ReadonlySet<string> = new Set(ISO_COUNTRY_CODES);

// Non-ISO 2-letter aliases real channels store. "UK" is the big one: it is NOT
// the ISO2 code for the United Kingdom ("GB" is) and ShipStation rejects it.
const COUNTRY_ALIAS_2: Readonly<Record<string, CountryCode>> = {
  UK: "GB",
};

const COUNTRY_NAME_TO_ISO2: Readonly<Record<string, CountryCode>> = {
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "u.s.a.": "US",
  "u.s.": "US",
  "puerto rico": "PR",
  "guam": "GU",
  "u.s. virgin islands": "VI",
  "us virgin islands": "VI",
  "american samoa": "AS",
  "northern mariana islands": "MP",
  "canada": "CA",
  "united kingdom": "GB",
  "great britain": "GB",
  "britain": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "northern ireland": "GB",
  "uk": "GB",
  "australia": "AU",
  "new zealand": "NZ",
  "ireland": "IE",
  "germany": "DE",
  "deutschland": "DE",
  "france": "FR",
  "spain": "ES",
  "italy": "IT",
  "netherlands": "NL",
  "the netherlands": "NL",
  "holland": "NL",
  "belgium": "BE",
  "switzerland": "CH",
  "austria": "AT",
  "sweden": "SE",
  "norway": "NO",
  "denmark": "DK",
  "finland": "FI",
  "iceland": "IS",
  "poland": "PL",
  "portugal": "PT",
  "greece": "GR",
  "czech republic": "CZ",
  "czechia": "CZ",
  "hungary": "HU",
  "romania": "RO",
  "bulgaria": "BG",
  "croatia": "HR",
  "slovakia": "SK",
  "slovenia": "SI",
  "estonia": "EE",
  "latvia": "LV",
  "lithuania": "LT",
  "luxembourg": "LU",
  "cyprus": "CY",
  "malta": "MT",
  "japan": "JP",
  "china": "CN",
  "hong kong": "HK",
  "hong kong sar china": "HK",
  "hong kong sar": "HK",
  "macau": "MO",
  "macao": "MO",
  "macao sar china": "MO",
  "south korea": "KR",
  "korea, republic of": "KR",
  "republic of korea": "KR",
  "singapore": "SG",
  "taiwan": "TW",
  "taiwan, province of china": "TW",
  "india": "IN",
  "pakistan": "PK",
  "bangladesh": "BD",
  "sri lanka": "LK",
  "nepal": "NP",
  "mexico": "MX",
  "brazil": "BR",
  "argentina": "AR",
  "chile": "CL",
  "colombia": "CO",
  "peru": "PE",
  "ecuador": "EC",
  "uruguay": "UY",
  "venezuela": "VE",
  "panama": "PA",
  "guatemala": "GT",
  "costa rica": "CR",
  "dominican republic": "DO",
  "united arab emirates": "AE",
  "uae": "AE",
  "saudi arabia": "SA",
  "qatar": "QA",
  "kuwait": "KW",
  "bahrain": "BH",
  "oman": "OM",
  "jordan": "JO",
  "lebanon": "LB",
  "israel": "IL",
  "turkey": "TR",
  "turkiye": "TR",
  "russia": "RU",
  "russian federation": "RU",
  "ukraine": "UA",
  "egypt": "EG",
  "morocco": "MA",
  "nigeria": "NG",
  "kenya": "KE",
  "ghana": "GH",
  "south africa": "ZA",
  "philippines": "PH",
  "malaysia": "MY",
  "thailand": "TH",
  "indonesia": "ID",
  "vietnam": "VN",
  "viet nam": "VN",
  // common ISO 3166-1 alpha-3 codes that occasionally leak through
  // ("usa" → US is already covered above)
  "can": "CA",
  "gbr": "GB",
  "aus": "AU",
  "deu": "DE",
  "fra": "FR",
  "nld": "NL",
};

/** Explicit compatibility aliases; ambiguous geographic names are excluded. */
export const COUNTRY_CODE_ALIASES: Readonly<Record<string, CountryCode>> = Object.freeze({
  ...COUNTRY_NAME_TO_ISO2,
  uk: "GB",
});

export function isCountryCode(input: unknown): input is CountryCode {
  return typeof input === "string" && ISO2_CODES.has(input);
}

export function normalizeCountryToIso2(input: unknown): CountryCode | null {
  if (typeof input !== "string") return null;
  // Strip diacritics so recognized aliases such as "México"/"Türkiye" match.
  // NFD splits an accented char into base + combining mark, then we drop the
  // Combining Diacritical Marks block (U+0300..U+036F). Done with a charCode
  // filter rather than a \p{Diacritic} regex so it needs no /u flag (which this
  // tsconfig target rejects).
  const cleaned = Array.from(input.normalize("NFD"))
    .filter((ch) => { const c = ch.charCodeAt(0); return c < 0x0300 || c > 0x036f; })
    .join("")
    .trim();
  if (cleaned.length === 0) return null;

  // 2-letter input: accept only real ISO2 codes (after the alias map). A bogus
  // 2-letter value (e.g. "XX") returns null rather than being POSTed verbatim.
  if (/^[A-Za-z]{2}$/.test(cleaned)) {
    const upper = cleaned.toUpperCase();
    const aliased = COUNTRY_ALIAS_2[upper] ?? upper;
    return isCountryCode(aliased) ? aliased : null;
  }

  const name = cleaned.toLowerCase();
  // Dictionary prototype names are not country aliases.
  return Object.prototype.hasOwnProperty.call(COUNTRY_NAME_TO_ISO2, name)
    ? COUNTRY_NAME_TO_ISO2[name] : null;
}

/** Safe classification only: raw address values must not enter error messages. */
export class CountryCodeValidationError extends Error {
  readonly status = 400;
  readonly field = "country";
  constructor(readonly code: "ORDER_COUNTRY_INVALID" | "ORDER_COUNTRY_REQUIRED" = "ORDER_COUNTRY_INVALID") {
    super(code === "ORDER_COUNTRY_REQUIRED"
      ? "A recognized destination country is required before shipping."
      : "Choose a recognized country or provide its two-letter country code.");
    this.name = "CountryCodeValidationError";
  }
}

/** Storage accepts an explicitly missing country, never an invented default. */
export function parseCountryCode(input: unknown): CountryCode | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string" || input.length > 100) throw new CountryCodeValidationError();
  if (input.trim() === "") return null;
  const code = normalizeCountryToIso2(input);
  if (code === null) throw new CountryCodeValidationError();
  return code;
}

/** A carrier request cannot use the optional-country storage contract. */
export function requireCountryCode(input: unknown): CountryCode {
  const code = parseCountryCode(input);
  if (code === null) throw new CountryCodeValidationError("ORDER_COUNTRY_REQUIRED");
  return code;
}

/** A supplied provider code is authoritative. An invalid code cannot fall back
 * to a plausible display name; that would conceal contradictory source data. */
export function resolveProviderCountryCode(code: unknown, name: unknown): CountryCode | null {
  const codeMissing = code === null || code === undefined || (typeof code === "string" && code.trim() === "");
  return parseCountryCode(codeMissing ? name : code);
}
