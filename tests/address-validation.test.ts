import assert from "node:assert/strict";
import test from "node:test";

import {
  validateGeocodeCandidate,
  type DeliveryAddressInput,
} from "../app/lib/address-validation.server.ts";

const address: DeliveryAddressInput = {
  address1: "House 12, Main Boulevard Gulberg",
  city: "Lahore",
  province: "Punjab",
  zip: "54660",
  country: "Pakistan",
  countryCode: "PK",
};

const lahoreCandidate = {
  display_name: "House 12, Main Boulevard, Gulberg, Lahore, Punjab, Pakistan",
  address: {
    house_number: "12",
    road: "Main Boulevard",
    suburb: "Gulberg",
    city: "Lahore",
    state: "Punjab",
    postcode: "54660",
    country: "Pakistan",
    country_code: "pk",
  },
};

test("accepts a street-level result in the requested city and returns the verified address", () => {
  const result = validateGeocodeCandidate(lahoreCandidate, address);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verifiedAddress.city, "Lahore");
    assert.equal(result.verifiedAddress.postalCode, "54660");
    assert.match(result.verifiedAddress.formattedAddress, /Gulberg/);
  }
});

test("rejects a verified address that belongs to a different city", () => {
  const result = validateGeocodeCandidate(
    {
      ...lahoreCandidate,
      display_name: "House 12, Main Boulevard, Gulberg, Karachi, Pakistan",
      address: {...lahoreCandidate.address, city: "Karachi"},
    },
    {...address, address1: "House 12, Main Boulevard Gulberg, Karachi"},
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ADDRESS_CITY_MISMATCH");
});

test("does not reject an incomplete local address because a geocoder chose another nearby area", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Peshawar, Pakistan",
      address: {
        city: "Peshawar",
        country: "Pakistan",
        country_code: "pk",
      },
    },
    {
      address1: "House 13, G-11 Sector 3",
      city: "Islamabad",
      country: "Pakistan",
      countryCode: "PK",
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.verifiedAddress.warning || "", /different nearby area/);
});

test("keeps a city explicitly named in the customer address when the provider chooses a nearby area", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "University Road, Mardan, Pakistan",
      address: {
        road: "University Road",
        city: "Mardan",
        country: "Pakistan",
        country_code: "pk",
      },
    },
    {
      address1: "Near Peshawar University GT Road Peshawar",
      city: "Peshawar",
      country: "Pakistan",
      countryCode: "PK",
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verifiedAddress.city, "Peshawar");
    assert.match(result.verifiedAddress.warning || "", /original customer address/);
  }
});

test("does not let a matching district override a city explicitly named in the address", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Peshawar, Charsadda District, Pakistan",
      address: {
        city: "Peshawar",
        county: "Charsadda District",
        country: "Pakistan",
        country_code: "pk",
      },
    },
    {...address, city: "Charsadda"},
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.verifiedAddress.warning || "", /different nearby area/);
});

test("keeps a city-matched address when the provider has a broader postal code", () => {
  const result = validateGeocodeCandidate(
    {
      ...lahoreCandidate,
      address: {...lahoreCandidate.address, postcode: "54000"},
    },
    address,
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verifiedAddress.postalCode, "54660");
    assert.match(result.verifiedAddress.warning || "", /postal code/);
  }
});

test("accepts a city-only geocoder result without guessing the street address", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Lahore, Punjab, Pakistan",
      address: {city: "Lahore", state: "Punjab", country: "Pakistan", country_code: "pk"},
    },
    address,
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verifiedAddress.formattedAddress, "House 12, Main Boulevard Gulberg, Lahore, Punjab, 54660, Pakistan");
    assert.match(result.verifiedAddress.warning || "", /original customer address/);
  }
});

test("keeps a city-matched nearby result as a warning without replacing the address", () => {
  const result = validateGeocodeCandidate(
    {
      ...lahoreCandidate,
      display_name: "House 99, Canal Road, Lahore, Punjab, Pakistan",
      address: {
        ...lahoreCandidate.address,
        house_number: "99",
        road: "Canal Road",
        suburb: undefined,
      },
    },
    address,
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.verifiedAddress.warning || "", /broader/);
    assert.match(result.verifiedAddress.formattedAddress, /House 12/);
  }
});

test("keeps a city-matched result when the provider has no postal code", () => {
  const result = validateGeocodeCandidate(
    {
      ...lahoreCandidate,
      address: {...lahoreCandidate.address, postcode: undefined},
    },
    address,
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.verifiedAddress.warning || "", /postal code/);
});

test("accepts a rural landmark address without inventing a street address", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Tarnab, Charsadda, Khyber Pakhtunkhwa, Pakistan",
      address: {
        village: "Tarnab",
        county: "Charsadda",
        state: "Khyber Pakhtunkhwa",
        country: "Pakistan",
        country_code: "pk",
      },
    },
    {
      address1: "Village Nawan Kali, P.O. Tarnab, near Al-Rehman Shop",
      city: "Charsadda",
      province: "Khyber Pakhtunkhwa",
      zip: "24600",
      country: "Pakistan",
      countryCode: "PK",
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verifiedAddress.confidence, "locality");
    assert.match(result.verifiedAddress.formattedAddress, /Nawan Kali/);
    assert.equal(result.verifiedAddress.postalCode, "24600");
  }
});

test("accepts a city-matched landmark even when the map result is broad", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Madina General Store, Islamabad, Pakistan",
      address: {
        shop: "Madina General Store",
        city: "Islamabad",
        country: "Pakistan",
        country_code: "pk",
      },
    },
    {
      address1: "Near Madina General Store",
      city: "Islamabad",
      country: "Pakistan",
      countryCode: "PK",
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verifiedAddress.city, "Islamabad");
    assert.match(result.verifiedAddress.warning || "", /original customer address/);
  }
});

test("accepts a repeated shop name when sector clues also match", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Madina General Store, Sector 3, G-11, Islamabad, Pakistan",
      address: {
        shop: "Madina General Store",
        suburb: "G-11",
        city: "Islamabad",
        country: "Pakistan",
        country_code: "pk",
      },
    },
    {
      address1: "Near Madina General Store, Sector 3, G-11",
      city: "Islamabad",
      country: "Pakistan",
      countryCode: "PK",
    },
  );

  assert.equal(result.ok, true);
});

test("matches an Urdu provider city to the English Shopify city", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "G-11, اسلام آباد, پاکستان",
      address: {
        suburb: "G-11",
        city: "اسلام آباد",
        country: "پاکستان",
        country_code: "pk",
      },
    },
    {
      address1: "House 13, G-11 Sector 3",
      city: "Islamabad",
      country: "Pakistan",
      countryCode: "PK",
    },
  );

  assert.equal(result.ok, true);
});
