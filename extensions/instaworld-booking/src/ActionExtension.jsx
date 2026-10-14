import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";

const DEFAULT_WEIGHT_PER_QUANTITY = 0.8;

function formatMoney(amount, currency) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(2)} ${currency || ""}`.trim();
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const {close, data} = shopify;
  const currentOrderId = data?.selected?.[0]?.id;
  const [selectedOrderIds, setSelectedOrderIds] = useState(currentOrderId ? [currentOrderId] : []);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [combined, setCombined] = useState(null);
  const [declaredWeight, setDeclaredWeight] = useState("");
  const [loading, setLoading] = useState(Boolean(currentOrderId));
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!currentOrderId) {
      setLoading(false);
      setError("No order was selected.");
      return;
    }
    refreshPreview([currentOrderId]);
  }, [currentOrderId]);

  async function refreshPreview(orderIds) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${window.location.origin}/api/instaworld-orders`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({orderIds}),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || "The selected orders cannot be combined.");
      }
      if (payload.orders) {
        setSelectedOrders(payload.orders);
        setCombined(null);
        return;
      }
      setSelectedOrders(payload.combined.orders || []);
      setCombined(payload.combined);
      setDeclaredWeight(String(payload.combined.defaultWeight));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Unable to validate orders.");
      setCombined(null);
    } finally {
      setLoading(false);
    }
  }

  async function searchOrders() {
    if (search.trim().length < 2) return;
    setSearching(true);
    setError("");
    try {
      const response = await fetch(
        `${window.location.origin}/api/instaworld-orders?q=${encodeURIComponent(search.trim())}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || "Order search failed.");
      setResults(payload.orders || []);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Order search failed.");
    } finally {
      setSearching(false);
    }
  }

  function addOrder(order) {
    if (selectedOrderIds.includes(order.id)) return;
    const nextIds = [...selectedOrderIds, order.id];
    setSelectedOrderIds(nextIds);
    setResults([]);
    setSelectedOrders((current) => [...current, order]);
    refreshPreview(nextIds);
  }

  function removeOrder(orderId) {
    if (orderId === currentOrderId) return;
    const nextIds = selectedOrderIds.filter((id) => id !== orderId);
    setSelectedOrderIds(nextIds);
    refreshPreview(nextIds);
  }

  async function bookShipment() {
    const numericWeight = Number(declaredWeight);
    if (selectedOrderIds.length < 2) {
      setError("Select at least one additional compatible order.");
      return;
    }
    if (!Number.isFinite(numericWeight) || numericWeight <= 0) {
      setError("Declared weight must be a positive number.");
      return;
    }

    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${window.location.origin}/api/instaworld-booking`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({orderIds: selectedOrderIds, declaredWeight: numericWeight}),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload?.message || "Booking failed.");
      }
      setMessage(`Shipment booked successfully. Tracking number: ${payload.trackingNumber}`);
    } catch (bookingError) {
      setError(bookingError instanceof Error ? bookingError.message : "Booking failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <s-admin-action>
      <s-stack direction="block" gap="base">
        <s-text type="strong">Confirm & Book InstaWorld</s-text>
        <s-text>
          Select two or more compatible orders. No shipment is created until you confirm.
        </s-text>

        <s-stack direction="inline" gap="base">
          <input
            type="search"
            value={search}
            placeholder="Search by order number"
            onInput={(event) => setSearch(event.target.value)}
          />
          <s-button onClick={searchOrders} loading={searching} disabled={searching}>
            Search
          </s-button>
        </s-stack>

        {results.map((order) => (
          <s-button key={order.id} onClick={() => addOrder(order)} disabled={selectedOrderIds.includes(order.id)}>
            #{order.orderNumber} {order.cancelledAt ? "(cancelled)" : ""}
          </s-button>
        ))}

        <s-text type="strong">Selected source orders</s-text>
        {selectedOrderIds.map((orderId, index) => (
          <s-stack key={orderId} direction="inline" gap="base">
            <s-text>
              #{selectedOrders.find((order) => order.id === orderId)?.orderNumber || orderId}
              {index === 0 ? " (current order)" : ""}
            </s-text>
            {index > 0 && <s-button onClick={() => removeOrder(orderId)}>Remove</s-button>}
          </s-stack>
        ))}

        {loading && <s-text>Validating selected orders…</s-text>}
        {combined?.orders?.length > 1 && (
          <>
            <s-text type="strong">Combined review</s-text>
            {combined.orders.map((order) => (
              <s-text key={order.id}>
                Order #{order.orderNumber} — {order.paymentStatus || order.displayFinancialStatus}
              </s-text>
            ))}
            <s-text>Recipient: {combined.consignee?.name || "—"}</s-text>
            <s-text>
              Destination: {[combined.consignee?.address1, combined.consignee?.city, combined.consignee?.zip]
                .filter(Boolean)
                .join(", ") || "—"}
            </s-text>
            <s-text>Total quantity: {combined.totalQuantity}</s-text>
            {combined.items.map((item) => (
              <s-text key={item.key}>
                {item.title} × {item.quantity}
              </s-text>
            ))}
            <s-text>
              Payment: {formatMoney(combined.payment?.amountDue, combined.payment?.currencyCode)} ({combined.payment?.treatment})
            </s-text>
            <label style={{display: "grid", gap: "4px"}}>
              <span>Declared weight (kg; default {DEFAULT_WEIGHT_PER_QUANTITY} kg per quantity)</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={declaredWeight}
                onInput={(event) => setDeclaredWeight(event.target.value)}
              />
            </label>
          </>
        )}

        {error && <s-banner tone="critical">{error}</s-banner>}
        {message && <s-banner tone="success">{message}</s-banner>}
      </s-stack>

      <s-button
        slot="primary-action"
        onClick={bookShipment}
        loading={submitting}
        disabled={submitting || loading || selectedOrderIds.length < 2 || !combined}
      >
        {submitting ? "Booking…" : "Confirm & Book InstaWorld"}
      </s-button>
      <s-button slot="secondary-actions" onClick={close}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}
