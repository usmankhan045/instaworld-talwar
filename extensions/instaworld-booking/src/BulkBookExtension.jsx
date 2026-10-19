import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useState} from "preact/hooks";

const APP_URL = "https://instaworld.barriovibe.com";

class ApiError extends Error {
  /** @type {string[]} */
  orderNumbers = [];
  orderNumber = "";
}

async function getAuthHeaders() {
  const token = await shopify.auth.idToken();
  if (!token) throw new Error("Unable to obtain an authentication token. Please reload the page.");
  return {Authorization: `Bearer ${token}`};
}

/**
 * @param {Response} response
 * @param {string} fallbackMessage
 * @param {number[]} allowedErrorStatuses
 */
async function readApiResponse(response, fallbackMessage, allowedErrorStatuses = []) {
  const text = await response.text();
  /** @type {any} */
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {message: text || fallbackMessage};
  }

  if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
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
    throw error;
  }
  return payload;
}

export default function extension() {
  render(<BulkBookExtension />, document.body);
}

function BulkBookExtension() {
  const {close, data} = shopify;
  const selectedOrders = data?.selected ?? [];
  const orderIds = selectedOrders.map((o) => o.id);

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  // results: Array<{ orderId, orderNumber, status: "pending"|"booked"|"skipped"|"error", trackingNumber?, message? }>
  const [results, setResults] = useState(
    selectedOrders.map((o) => ({
      orderId: o.id,
      orderNumber: "Order number unavailable",
      status: "pending",
    })),
  );

  function updateResult(orderId, patch) {
    setResults((prev) => prev.map((r) => (r.orderId === orderId ? {...r, ...patch} : r)));
  }

  async function bookAll() {
    setRunning(true);
    let authHeaders;
    try {
      authHeaders = await getAuthHeaders();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Authentication failed.";
      setResults((prev) => prev.map((r) => ({...r, status: "error", message: `Authentication: ${message}`})));
      setRunning(false);
      setDone(true);
      return;
    }

    for (const orderId of orderIds) {
      updateResult(orderId, {status: "booking"});
      try {
        // Step 1: preview — get combined data + city check
        const previewRes = await fetch(`${APP_URL}/api/instaworld-orders`, {
          method: "POST",
          headers: {"Content-Type": "application/json", ...authHeaders},
          body: JSON.stringify({orderIds: [orderId]}),
        });
        const previewPayload = await readApiResponse(previewRes, "Order preview failed.", [409]);

        // 409 = already booked
        if (previewRes.status === 409) {
          const existing = previewPayload?.existing?.[0];
          updateResult(orderId, {
            status: "skipped",
            orderNumber: previewPayload?.existing?.[0]?.shopifyOrderNumber || "Order number unavailable",
            message: `This order is already booked (shipment #${existing?.shipmentId ?? "unknown"}).`,
          });
          continue;
        }

        // City not serviceable?
        if (previewPayload.cityWarning) {
          updateResult(orderId, {
            status: "skipped",
            orderNumber: previewPayload.combined?.orders?.[0]?.orderNumber || "Order number unavailable",
            message: previewPayload.cityWarning,
          });
          continue;
        }

        const combined = previewPayload.combined;
        if (!combined) {
          updateResult(orderId, {status: "error", message: "Could not load this order’s details."});
          continue;
        }

        const orderNumber = combined.orders?.[0]?.orderNumber || "Order number unavailable";
        updateResult(orderId, {orderNumber});

        // Step 2: book
        const bookRes = await fetch(`${APP_URL}/api/instaworld-booking`, {
          method: "POST",
          headers: {"Content-Type": "application/json", ...authHeaders},
          body: JSON.stringify({
            orderIds: [orderId],
            declaredWeight: 0.8,
          }),
        });
        const bookPayload = await readApiResponse(bookRes, "Booking failed.");

        if (!bookPayload.success) {
          updateResult(orderId, {
            orderNumber,
            status: "error",
            message: bookPayload?.message || "Booking failed.",
          });
        } else {
          updateResult(orderId, {
            orderNumber,
            status: "booked",
            trackingNumber: bookPayload.trackingNumber,
          });
        }
      } catch (err) {
        const orderNumber = err instanceof ApiError ? err.orderNumber : "";
        updateResult(orderId, {
          ...(orderNumber ? {orderNumber} : {}),
          status: "error",
          message: err instanceof Error ? err.message : "Unexpected error while processing this order.",
        });
      }
    }

    setRunning(false);
    setDone(true);
  }

  const booked = results.filter((r) => r.status === "booked").length;
  const errors = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return (
    <s-admin-action>
      <s-stack direction="block" gap="base">
        <s-text type="strong">
          Book {orderIds.length} order{orderIds.length !== 1 ? "s" : ""} via InstaWorld
        </s-text>

        {!running && !done && (
          <s-text>
            Each order will be checked and booked individually. Already-booked or non-serviceable
            orders will be skipped automatically.
          </s-text>
        )}

        {/* Per-order status list */}
        <s-stack direction="block" gap="base">
          {results.map((r) => (
            <s-stack key={r.orderId} direction="inline" gap="base">
              <s-text>
                {statusIcon(r.status)} #{r.orderNumber}
                {r.status === "booking" ? " — booking…" : ""}
                {r.status === "booked" ? ` — ✓ Booked (${r.trackingNumber})` : ""}
                {r.status === "skipped" ? ` — Skipped: ${r.message}` : ""}
              </s-text>
              {r.status === "error" && (
                <s-banner tone="critical">
                  Order #{r.orderNumber}: {r.message}
                </s-banner>
              )}
            </s-stack>
          ))}
        </s-stack>

        {done && (
          <s-banner tone={errors > 0 ? "critical" : skipped > 0 ? "warning" : "success"}>
            {errors > 0 ? "Attention required — " : ""}Done — {booked} booked, {skipped} skipped, {errors} failed.
          </s-banner>
        )}
      </s-stack>

      {!done && (
        <s-button
          slot="primary-action"
          onClick={bookAll}
          loading={running}
          disabled={running || orderIds.length === 0}
        >
          {running ? "Booking…" : `Book ${orderIds.length} Order${orderIds.length !== 1 ? "s" : ""}`}
        </s-button>
      )}
      <s-button slot="secondary-actions" onClick={close}>
        {done ? "Close" : "Cancel"}
      </s-button>
    </s-admin-action>
  );
}

function statusIcon(status) {
  switch (status) {
    case "pending":
      return "○";
    case "booking":
      return "⟳";
    case "booked":
      return "✓";
    case "skipped":
      return "—";
    case "error":
      return "✗";
    default:
      return "?";
  }
}
