/**
 * Delivery-address pass-through.
 *
 * Address correctness is confirmed manually with the customer. The Shopify
 * address therefore remains the sole source of truth and no external geocoder
 * or map validation runs during preview or booking. InstaWorld city
 * normalization/serviceability remains a separate step in the booking flow.
 */

export type DeliveryAddressInput = {
  address1: string | null | undefined;
  address2?: string | null | undefined;
  city: string | null | undefined;
  province?: string | null | undefined;
  zip?: string | null | undefined;
  country?: string | null | undefined;
  countryCode?: string | null | undefined;
};

export type VerifiedAddress = {
  formattedAddress: string;
  city: string;
  province: string | null;
  postalCode: string | null;
  source: "shopify";
  confidence: "provided";
};

export type AddressVerificationResult = {
  ok: true;
  verifiedAddress: VerifiedAddress;
};

function originalAddress(input: DeliveryAddressInput): string {
  return [
    input.address1,
    input.address2,
    input.city,
    input.province,
    input.zip,
    input.country || "Pakistan",
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
}

/** Preserve the merchant-provided Shopify address without network validation. */
export async function verifyDeliveryAddress(
  input: DeliveryAddressInput,
): Promise<AddressVerificationResult> {
  return {
    ok: true,
    verifiedAddress: {
      formattedAddress: originalAddress(input),
      city: String(input.city ?? "").trim(),
      province: input.province?.trim() || null,
      postalCode: input.zip?.trim() || null,
      source: "shopify",
      confidence: "provided",
    },
  };
}

/** Kept for callers that use the legacy helper; manual verification never blocks. */
export async function verifyAddressCity(
  _address: string | null | undefined,
  _selectedCity: string | null | undefined,
): Promise<null> {
  return null;
}
