import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState} from "preact/hooks";
import {
  useApplyAttributeChange,
  useApplyShippingAddressChange,
  useAttributeValues,
  useBuyerJourneyIntercept,
  useShippingAddress,
} from "@shopify/ui-extensions/checkout/preact";
import {isPakistanCity, PAKISTAN_CITIES} from "./pakistanCities";

const COURIER_ATTRIBUTE = "delivery_courier";
const COURIERS = ["TCS", "POSTEX"];

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const shippingAddress = useShippingAddress();
  const applyShippingAddressChange = useApplyShippingAddressChange();
  const applyAttributeChange = useApplyAttributeChange();
  const [courierAttribute] = useAttributeValues([COURIER_ATTRIBUTE]);
  const [citySearch, setCitySearch] = useState("");
  const [error, setError] = useState("");
  const countryCode = shippingAddress?.countryCode;
  const isPakistan = !countryCode || countryCode === "PK";
  const currentCity = String(shippingAddress?.city || "").trim();
  const selectedCourier = COURIERS.includes(String(courierAttribute || "")) ? courierAttribute : "";
  const filteredCities = PAKISTAN_CITIES.filter((city) =>
    city.toLowerCase().includes(citySearch.trim().toLowerCase()),
  ).slice(0, 50);

  useBuyerJourneyIntercept(({canBlockProgress}) => {
    if (!isPakistan || (!canBlockProgress && isPakistanCity(currentCity) && selectedCourier)) return {behavior: "allow"};
    if (!canBlockProgress) return {behavior: "allow"};
    const missing = [
      !isPakistanCity(currentCity) ? "a valid Pakistan city" : "",
      !selectedCourier ? "a courier (TCS or PostEx)" : "",
    ].filter(Boolean).join(" and ");
    return {
      behavior: "block",
      reason: "Checkout delivery selections are incomplete",
      errors: [{message: `Choose ${missing} before continuing.`}],
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

  async function handleCourierChange(event) {
    const courier = event.currentTarget.value;
    setError("");
    const result = await applyAttributeChange({
      type: "updateAttribute",
      key: COURIER_ATTRIBUTE,
      value: courier,
    });
    if (result?.type === "error") {
      setError("Shopify could not save the courier choice. Please choose it again.");
    }
  }

  return (
    <s-section heading="Delivery city">
      <s-text-field
        label="Search Pakistan cities"
        value={citySearch}
        placeholder="Type to search for a city"
        onInput={(event) => setCitySearch((/** @type {HTMLInputElement} */ (event.currentTarget)).value)}
      />
      <s-select
        label="Select your Pakistan city"
        value={isPakistanCity(currentCity) ? currentCity : ""}
        onChange={handleCityChange}
        error={error || (!isPakistanCity(currentCity) && currentCity ? "Please choose a city from this list." : undefined)}
        required
      >
        <s-option value="" disabled>Select a city</s-option>
        {filteredCities.map((city) => <s-option key={city} value={city}>{city}</s-option>)}
      </s-select>
      <s-select
        label="Select courier"
        value={selectedCourier}
        onChange={handleCourierChange}
        error={error || (!selectedCourier ? "Please select TCS or PostEx." : undefined)}
        required
      >
        <s-option value="" disabled>Select a courier</s-option>
        <s-option value="TCS">TCS</s-option>
        <s-option value="POSTEX">PostEx</s-option>
      </s-select>
      <s-text tone="neutral">Select both the city and courier. Checkout cannot continue without them.</s-text>
    </s-section>
  );
}
