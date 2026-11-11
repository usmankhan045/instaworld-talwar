import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useRef, useState} from "preact/hooks";
import {getApiClient} from "./api-client";

class ApiError extends Error {
  /** @type {string[]} */
  orderNumbers = [];
  orderNumber = "";
  /** @type {string[]} */
  blockedOrderIds = [];
}

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
/**
 * @param {Response} response
 * @param {string} fallbackMessage
 * @returns {Promise<any>}
 */
async function readApiResponse(response, fallbackMessage) {
  const text = await response.text();
  /** @type {any} */
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {message: text || fallbackMessage};
  }

  if (!response.ok) {
    const messages = {
      ADDRESS_CITY_MISMATCH: "City mismatch: the order city and address city do not match. Check the city and address.",
      ADDRESS_NOT_FOUND: "Address not found. Add a road, village, sector, or nearby landmark.",
      ADDRESS_AMBIGUOUS: "Address needs more detail. Add a road, sector, village, or nearby landmark.",
      ADDRESS_VERIFICATION_UNAVAILABLE: "Address verification is temporarily unavailable. Try again shortly.",
      POSTAL_CODE_MISMATCH: "The city matches, but the postal code needs checking.",
    };
    const rawMessage = String(payload.message || fallbackMessage)
      .replace(/^[^:]{2,80} failed:\s*/i, "")
      .replace(/\s*\[[A-Z_]+\]\s*\(HTTP \d+\)$/i, "");
    const orderNumbers = Array.isArray(payload.orderNumbers)
      ? payload.orderNumbers
      : Object.values(payload.orderNumbers || {});
    const error = new ApiError(messages[payload.code] || rawMessage);
    error.orderNumbers = [...new Set([payload.orderNumber, ...orderNumbers].filter(Boolean))];
    error.orderNumber = error.orderNumbers[0] || "";
    error.blockedOrderIds = Array.isArray(payload.blockedOrderIds) ? payload.blockedOrderIds : [];
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
  const [relatedOrders, setRelatedOrders] = useState([]);
  const [combined, setCombined] = useState(null);
  const [addressOrderId, setAddressOrderId] = useState("");
  const [verifiedAddress, setVerifiedAddress] = useState(null);
  const [addressValid, setAddressValid] = useState(false);
  const [loading, setLoading] = useState(Boolean(currentOrderId));
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [cityWarning, setCityWarning] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [matchingOrdersLoading, setMatchingOrdersLoading] = useState(false);
  const relatedRequestId = useRef(0);

  useEffect(() => {
    if (!currentOrderId) {
      setLoading(false);
      setError("No order was selected.");
      return;
    }
    refreshPreview([currentOrderId]);
  }, [currentOrderId]);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const {appUrl, authHeaders} = await getApiClient();
      const response = await fetch(`${appUrl}/api/instaworld-accounts`, {
        headers: {...authHeaders},
        cache: "no-store",
      });
      const payload = await readApiResponse(response, "Unable to load InstaWorld accounts.");
      const availableAccounts = payload.accounts || [];
      setAccounts(availableAccounts);
      setAccountId((current) => current
        || availableAccounts.find((account) => account.isDefault)?.id
        || availableAccounts[0]?.id
        || "");
    } catch (accountError) {
      setError(accountError instanceof Error ? accountError.message : "Unable to load InstaWorld accounts.");
    } finally {
      setAccountsLoading(false);
    }
  }

  async function refreshPreview(
    orderIds,
    chosenAddressOrderId = addressOrderId,
    chosenAccountId = accountId,
  ) {
    relatedRequestId.current += 1;
    setMatchingOrdersLoading(false);
    setRelatedOrders([]);
    setLoading(true);
    setError("");
    try {
      const {appUrl, authHeaders} = await getApiClient();
      const response = await fetch(`${appUrl}/api/instaworld-orders`, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders},
        body: JSON.stringify({orderIds, accountId: chosenAccountId || undefined,
          addressOrderId: chosenAddressOrderId || undefined}),
      });
      const payload = await readApiResponse(response, "The selected orders cannot be combined.");
      if (payload.orders) {
        setSelectedOrders(payload.orders);
        setCombined(null);
        setVerifiedAddress(null);
        setAddressValid(false);
        setRelatedOrders([]);
        return;
      }
      setSelectedOrders(payload.combined.orders || []);
      setCombined(payload.combined);
      setVerifiedAddress(payload.verifiedAddress || null);
      setAddressValid(!payload.addressError);
      setError(payload.addressError || "");
      setRelatedOrders([]);
      if (payload.accounts) {
        setAccounts(payload.accounts);
        setAccountId((current) => current
          || payload.accounts.find((account) => account.isDefault)?.id
          || payload.accounts[0]?.id
          || "");
      }
      // Weight is always fixed at 0.8 kg
      setCityWarning(payload.cityWarning || "");
      loadRelatedOrders(orderIds, chosenAccountId);
    } catch (previewError) {
      const apiError = previewError instanceof ApiError ? previewError : null;
      const orderNumbers = apiError?.orderNumbers || [];
      const blockedOrderIds = apiError?.blockedOrderIds || [];
      if (blockedOrderIds.length > 0) {
        setSelectedOrderIds((current) => current.filter((id) => !blockedOrderIds.includes(id)));
        setSelectedOrders((current) => current.filter((order) => !blockedOrderIds.includes(order.id)));
        setResults((current) => current.filter((order) => !blockedOrderIds.includes(order.id)));
        setRelatedOrders((current) => current.filter((order) => !blockedOrderIds.includes(order.id)));
        setAddressOrderId((current) => blockedOrderIds.includes(current) ? "" : current);
      }
      const orderNumber = apiError?.orderNumber || selectedOrders.find((order) => order.id === currentOrderId)?.orderNumber;
      if (orderNumber) setSelectedOrders((current) => current.some((order) => order.id === currentOrderId)
        ? current : [{id: currentOrderId, orderNumber}, ...current]);
      const orderLabel = orderNumbers.length > 1
        ? `Orders ${orderNumbers.map((number) => `#${number}`).join(", ")}: `
        : orderNumber
          ? `Order #${orderNumber}: `
          : "";
      setError(`${orderLabel}${previewError instanceof Error ? previewError.message : "Unable to validate this order."}`);
      if (blockedOrderIds.length === 0) {
        setCombined(null);
        setVerifiedAddress(null);
        setAddressValid(false);
        setRelatedOrders([]);
      }
      relatedRequestId.current += 1;
      setMatchingOrdersLoading(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadRelatedOrders(orderIds, chosenAccountId = accountId) {
    const requestId = relatedRequestId.current + 1;
    relatedRequestId.current = requestId;
    setMatchingOrdersLoading(true);
    try {
      const {appUrl, authHeaders} = await getApiClient();
      const response = await fetch(`${appUrl}/api/instaworld-orders`, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders},
        body: JSON.stringify({orderIds, accountId: chosenAccountId || undefined, mode: "related"}),
      });
      const payload = await readApiResponse(response, "Matching order search failed.");
      if (relatedRequestId.current === requestId) {
        setRelatedOrders(payload.relatedOrders || []);
      }
    } catch {
      // Suggestions are optional. Selection and booking retain their own
      // authoritative validation and must not be blocked by discovery failure.
      if (relatedRequestId.current === requestId) setRelatedOrders([]);
    } finally {
      if (relatedRequestId.current === requestId) setMatchingOrdersLoading(false);
    }
  }

  async function searchOrders() {
    if (search.trim().length < 2) return;
    setSearching(true);
    setError("");
    try {
      const {appUrl, authHeaders} = await getApiClient();
      const response = await fetch(
        `${appUrl}/api/instaworld-orders?q=${encodeURIComponent(search.trim())}`,
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
    const nextAddressOrderId = addressOrderId === orderId ? "" : addressOrderId;
    setAddressOrderId(nextAddressOrderId);
    setSelectedOrders((current) => current.filter((order) => order.id !== orderId));
    refreshPreview(nextIds, nextAddressOrderId);
  }

  async function bookShipment(chosenAccountId = accountId) {
    if (selectedOrderIds.length < 1) {
      setError("No order selected.");
      return;
    }

    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const {appUrl, authHeaders} = await getApiClient();
      const response = await fetch(`${appUrl}/api/instaworld-booking`, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders},
        // Weight is always fixed at 0.8 kg
        body: JSON.stringify({orderIds: selectedOrderIds, declaredWeight: 0.8,
          accountId: chosenAccountId || undefined, addressOrderId: combined?.addressOrderId}),
      });
      const payload = await readApiResponse(response, "Booking failed.");
      if (!payload.success) {
        const bookingFailure = new ApiError(payload?.message || "Booking failed.");
        bookingFailure.orderNumbers = Array.isArray(payload.orderNumbers)
          ? payload.orderNumbers
          : Object.values(payload.orderNumbers || {});
        bookingFailure.orderNumber = payload.orderNumber || bookingFailure.orderNumbers[0] || "";
        throw bookingFailure;
      }
      setMessage(`Shipment booked successfully. Tracking number: ${payload.trackingNumber}`);
    } catch (bookingError) {
      const apiError = bookingError instanceof ApiError ? bookingError : null;
      const orderNumbers = apiError?.orderNumbers || [];
      const orderNumber = apiError?.orderNumber || selectedOrders.find((order) => order.id === currentOrderId)?.orderNumber;
      const orderLabel = orderNumbers.length > 1
        ? `Orders ${orderNumbers.map((number) => `#${number}`).join(", ")}: `
        : orderNumber
          ? `Order #${orderNumber}: `
          : "";
      setError(`${orderLabel}${bookingError instanceof Error ? bookingError.message : "Booking failed."}`);
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

        {accountsLoading && <s-text>Loading connected InstaWorld accounts…</s-text>}
        {!accountsLoading && accounts.length === 0 && (
          <s-banner tone="critical">No InstaWorld account is connected. Connect an account before booking.</s-banner>
        )}

        <s-stack direction="inline" gap="base">
          <s-search-field
            label="Search orders"
            labelAccessibilityVisibility="exclusive"
            value={search}
            placeholder="Search by order number"
            onInput={(event) => setSearch(event.currentTarget.value)}
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
              #{selectedOrders.find((order) => order.id === orderId)?.orderNumber || "Order number unavailable"}
              {index === 0 ? " (current order)" : ""}
            </s-text>
            {index > 0 && <s-button onClick={() => removeOrder(orderId)}>Remove</s-button>}
          </s-stack>
        ))}

        {matchingOrdersLoading && <s-text>Finding other matching orders…</s-text>}
        {relatedOrders.length > 0 && (
          <>
            <s-text type="strong">Other matching orders</s-text>
            <s-text>Add another matching order to include it in this single shipment. Compatibility will be checked before booking.</s-text>
            {relatedOrders.map((order) => (
              <s-button key={order.id} onClick={() => addOrder(order)} disabled={selectedOrderIds.includes(order.id)}>
                Add order #{order.orderNumber}
              </s-button>
            ))}
          </>
        )}

        {loading && <s-text>Validating selected orders…</s-text>}
        {combined?.orders?.length > 1 && (
          <>
            <s-select
              label="Delivery address for the combined shipment"
              value={combined.addressOrderId}
              onChange={(event) => {
                const nextAddressOrderId = event.currentTarget.value;
                setAddressOrderId(nextAddressOrderId);
                refreshPreview(selectedOrderIds, nextAddressOrderId);
              }}
            >
              {combined.addressOptions.map((option) => (
                <s-option key={option.orderId} value={option.orderId}>
                  Order #{option.orderNumber}: {[option.address.address1, option.address.city].filter(Boolean).join(", ")}
                </s-option>
              ))}
            </s-select>
            {(combined.addressesDiffer || combined.recipientDetailsDiffer) && (
              <s-banner tone="warning">These orders have different delivery or recipient details. Check the selected address, name and phone before booking.</s-banner>
            )}
          </>
        )}
        {combined?.orders?.length > 1 && (
          <>
            <s-text type="strong">Combined review</s-text>
            {combined.orders.map((order) => (
              <s-text key={order.id}>
                Order #{order.orderNumber} — {order.paymentStatus || order.displayFinancialStatus}
              </s-text>
            ))}
            <s-text>Recipient: {combined.consignee?.name || "—"}</s-text>
            <s-text>Phone: {combined.consignee?.phone || "—"}</s-text>
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
                Shopify address (verify manually): {verifiedAddress.formattedAddress}
              </s-text>
            )}
          </>
        )}

        {cityWarning && <s-banner tone="warning">{cityWarning}</s-banner>}
        {error && <s-banner tone="critical">{error}</s-banner>}
        {message && <s-banner tone="success">{message}</s-banner>}

        {accounts.length > 1 && (
          <>
            <s-text type="strong">Choose the InstaWorld account for this booking</s-text>
            <s-stack direction="inline" gap="base">
              {accounts.map((account) => (
                <s-button
                  key={account.id}
                  variant={account.isDefault ? "primary" : "secondary"}
                  onClick={() => bookShipment(account.id)}
                  loading={submitting}
                  disabled={submitting || loading || selectedOrderIds.length < 1 || !combined || !addressValid}
                >
                  {submitting ? "Booking…" : `Book with ${account.name}`}
                </s-button>
              ))}
            </s-stack>
          </>
        )}
      </s-stack>

      {accounts.length === 1 && (
        <s-button
          slot="primary-action"
          onClick={() => bookShipment(accounts[0].id)}
          loading={submitting}
          disabled={submitting || loading || accountsLoading || selectedOrderIds.length < 1 || !combined || !addressValid}
        >
          {submitting ? "Booking…" : `Book with ${accounts[0].name}`}
        </s-button>
      )}
      <s-button slot="secondary-actions" onClick={close}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}
