const US_REGION_ENTRIES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"], ["DC", "District of Columbia"],
  ["AS", "American Samoa"], ["GU", "Guam"], ["MP", "Northern Mariana Islands"],
  ["PR", "Puerto Rico"], ["VI", "U.S. Virgin Islands"],
  ["AA", "Armed Forces Americas"], ["AE", "Armed Forces Europe"],
  ["AP", "Armed Forces Pacific"],
] as const;

export const US_POSTAL_REGIONS = US_REGION_ENTRIES.map(([code]) => code);

const REGION_CODE_BY_TOKEN = new Map<string, string>();
for (const [code, name] of US_REGION_ENTRIES) {
  REGION_CODE_BY_TOKEN.set(code, code);
  REGION_CODE_BY_TOKEN.set(name.toUpperCase(), code);
}
REGION_CODE_BY_TOKEN.set("US VIRGIN ISLANDS", "VI");
REGION_CODE_BY_TOKEN.set("VIRGIN ISLANDS", "VI");

export function normalizeUsPostalRegion(value: string | null | undefined): string | null {
  const token = value?.trim().toUpperCase().replace(/\./g, "") ?? "";
  return REGION_CODE_BY_TOKEN.get(token) ?? null;
}

export function isUsPostalRegion(value: string): boolean {
  return normalizeUsPostalRegion(value) !== null;
}
