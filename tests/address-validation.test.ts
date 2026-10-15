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
    address,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ADDRESS_CITY_MISMATCH");
});

test("rejects a postal-code mismatch", () => {
  const result = validateGeocodeCandidate(
    {
      ...lahoreCandidate,
      address: {...lahoreCandidate.address, postcode: "54000"},
    },
    address,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "POSTAL_CODE_MISMATCH");
});

test("rejects a city-only or incomplete geocoder result instead of guessing", () => {
  const result = validateGeocodeCandidate(
    {
      display_name: "Lahore, Punjab, Pakistan",
      address: {city: "Lahore", state: "Punjab", country: "Pakistan", country_code: "pk"},
    },
    address,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ADDRESS_AMBIGUOUS");
});

test("rejects a nearby result that does not contain the supplied street or house evidence", () => {
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

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ADDRESS_AMBIGUOUS");
});

test("rejects a result that cannot confirm the supplied postal code", () => {
  const result = validateGeocodeCandidate(
    {
      ...lahoreCandidate,
      address: {...lahoreCandidate.address, postcode: undefined},
    },
    address,
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "POSTAL_CODE_MISMATCH");
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
