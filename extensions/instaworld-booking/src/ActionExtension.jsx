import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";

/**
 * Production Vercel app URL.  All extension→app fetch calls must target this
 * origin — `window.location.origin` inside the Admin extension sandbox resolves
 * to the extension CDN origin, not the app server.
 */
const APP_URL = "https://app.talwarstore.com";

function formatMoney(amount, currency) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(2)} ${currency || ""}`.trim();
}

/**
 * Retrieve a Shopify OIDC ID token and return an `Authorization` header object.
 * The server validates this token in `authenticate.admin(request)`.
 * Throws if the platform cannot issue a token so that callers surface the error
 * rather than making an unauthenticated request.
 */
async function getAuthHeaders() {
  const token = await shopify.auth.idToken();
  if (!token) {
    throw new Error("Unable to obtain an authentication token. Please reload the page.");
  }
  return {Authorization: `Bearer ${token}`};
}

async function readApiResponse(response, fallbackMessage) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {message: text || fallbackMessage};
  }

  if (!response.ok) {
    const stage = payload.stage ? `${payload.stage}: ` : "";
    const code = payload.code ? ` [${payload.code}]` : "";
    const suggestion = payload.suggestedAddress
      ? ` Suggested provider result: ${payload.suggestedAddress}`
      : "";
    const error = new Error(`${stage}${payload.message || fallbackMessage}${suggestion}${code} (HTTP ${response.status})`);
    error.orderNumber = payload.orderNumber || Object.values(payload.orderNumbers || {})[0] || "";
    throw error;
  }
  return payload;
}

/**
 * Extension entry point.
 *
 * Must be a plain (non-async) default export.  The Shopify CLI build shim wraps
 * it as `shopify.extend("admin.order-details.action.render", (...args) => extension(...args))`.
 * An async default export returns a Promise to `shopify.extend`, which does not
 * await it, so the extension may not register reliably.  Render is synchronous
 * in remote-dom; async is unnecessary and harmful here.
 */
export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const {close, data} = shopify;
  const currentOrderId = data?.selected?.[0]?.id;
  const [selectedOrderIds, setSelectedOrderIds] = useState(currentOrderId ? [currentOrderId] : []);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [combined, setCombined] = useState(null);
  const [verifiedAddress, setVerifiedAddress] = useState(null);
  const [loading, setLoading] = useState(Boolean(currentOrderId));
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [cityWarning, setCityWarning] = useState("");

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
      const authHeaders = await getAuthHeaders();
      const response = await fetch(`${APP_URL}/api/instaworld-orders`, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders},
        body: JSON.stringify({orderIds}),
      });
      const payload = await readApiResponse(response, "The selected orders cannot be combined.");
      if (payload.orders) {
        setSelectedOrders(payload.orders);
        setCombined(null);
        setVerifiedAddress(null);
        return;
      }
      setSelectedOrders(payload.combined.orders || []);
      setCombined(payload.combined);
      setVerifiedAddress(payload.verifiedAddress || null);
      // Weight is always fixed at 0.8 kg
      setCityWarning(payload.cityWarning || "");
    } catch (previewError) {
      const orderNumber = previewError?.orderNumber || selectedOrders.find((order) => order.id === currentOrderId)?.orderNumber;
      setError(`${orderNumber ? `Order #${orderNumber}: ` : ""}${previewError instanceof Error ? previewError.message : "Unable to validate this order."}`);
      setCombined(null);
      setVerifiedAddress(null);
    } finally {
      setLoading(false);
    }
  }

  async function searchOrders() {
    if (search.trim().length < 2) return;
    setSearching(true);
    setError("");
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch(
        `${APP_URL}/api/instaworld-orders?q=${encodeURIComponent(search.trim())}`,
        {headers: {...authHeaders}},
      );
      const payload = await readApiResponse(response, "Order search failed.");
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
    if (selectedOrderIds.length < 1) {
      setError("No order selected.");
      return;
    }

    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch(`${APP_URL}/api/instaworld-booking`, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders},
        // Weight is always fixed at 0.8 kg
        body: JSON.stringify({orderIds: selectedOrderIds, declaredWeight: 0.8}),
      });
      const payload = await readApiResponse(response, "Booking failed.");
      if (!payload.success) throw new Error(payload?.message || "Booking failed.");
      setMessage(`Shipment booked successfully. Tracking number: ${payload.trackingNumber}`);
    } catch (bookingError) {
      const orderNumber = bookingError?.orderNumber || selectedOrders.find((order) => order.id === currentOrderId)?.orderNumber;
      setError(`${orderNumber ? `Order #${orderNumber}: ` : ""}${bookingError instanceof Error ? bookingError.message : "Booking failed."}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <s-admin-action>
      <s-stack direction="block" gap="base">
        <s-text type="strong">Confirm &amp; Book InstaWorld</s-text>
        <s-text>
          Select one or more compatible orders. No shipment is created until you confirm.
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
            <s-text>Standard weight: 0.8 kg (fixed)</s-text>
            {verifiedAddress && (
              <s-text>
                Verified address ({verifiedAddress.source}): {verifiedAddress.formattedAddress}
              </s-text>
            )}
          </>
        )}

        {cityWarning && <s-banner tone="warning">{cityWarning}</s-banner>}
        {error && <s-banner tone="critical">{error}</s-banner>}
        {message && <s-banner tone="success">{message}</s-banner>}
      </s-stack>

      <s-button
        slot="primary-action"
        onClick={bookShipment}
        loading={submitting}
        disabled={submitting || loading || selectedOrderIds.length < 1 || !combined}
      >
        {submitting ? "Booking…" : "Confirm & Book InstaWorld"}
      </s-button>
      <s-button slot="secondary-actions" onClick={close}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}
