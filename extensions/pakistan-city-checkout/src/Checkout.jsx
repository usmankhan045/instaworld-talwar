import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState} from "preact/hooks";
import {useApplyShippingAddressChange, useBuyerJourneyIntercept, useShippingAddress} from "@shopify/ui-extensions/checkout/preact";
import {isPakistanCity, PAKISTAN_CITIES} from "./pakistanCities";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const shippingAddress = useShippingAddress();
  const applyShippingAddressChange = useApplyShippingAddressChange();
  const [error, setError] = useState("");
  const countryCode = shippingAddress?.countryCode;
  const isPakistan = !countryCode || countryCode === "PK";
  const currentCity = String(shippingAddress?.city || "").trim();

  useBuyerJourneyIntercept(({canBlockProgress}) => {
    if (!isPakistan || isPakistanCity(currentCity) || !canBlockProgress) return {behavior: "allow"};
    return {
      behavior: "block",
      reason: "A valid Pakistan city must be selected",
      errors: [{message: "Choose a city from the Pakistan city list before continuing."}],
    };
  });

  if (!isPakistan) return null;

  async function handleCityChange(event) {
    const city = event.currentTarget.value;
    setError("");
    const result = await applyShippingAddressChange?.({
      type: "updateShippingAddress",
      address: {city, countryCode: "PK"},
    });
    if (result?.type === "error") {
      setError("Shopify could not update the city. Please choose it again.");
    }
  }

  return (
    <s-section heading="Delivery city">
      <s-select
        label="Select your Pakistan city"
        value={isPakistanCity(currentCity) ? currentCity : ""}
        onChange={handleCityChange}
        error={error || (!isPakistanCity(currentCity) && currentCity ? "Please choose a city from this list." : undefined)}
        required
      >
        <s-option value="" disabled>Select a city</s-option>
        {PAKISTAN_CITIES.map((city) => <s-option key={city} value={city}>{city}</s-option>)}
      </s-select>
      <s-text tone="neutral">Choose the city here so your delivery booking uses the correct spelling.</s-text>
    </s-section>
  );
}
