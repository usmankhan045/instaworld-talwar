import type {WhatsAppEventType, WhatsAppNotificationPlan, WhatsAppShipmentSnapshot} from "./types.server.ts";

const STATUS_EVENTS: Record<string, WhatsAppEventType> = {
  BOOKED: "booking_confirmed",
  BOOKING_IN_PROCESS: "booking_confirmed",
  PICKED_UP: "picked_up",
  IN_TRANSIT: "in_transit",
  ARRIVED_IN_CITY: "arrived_in_city",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERY_FAILED: "delivery_failed",
  DELIVERY_ATTEMPT_FAILED: "delivery_failed",
  ACTION_REQUIRED: "delivery_failed",
  DELIVERED: "delivered",
  RTO_INITIATED: "returned",
  RTO_IN_TRANSIT: "returned",
  RTO_RECEIVED_AT_HUB: "returned",
  RTO_RETURNED_TO_SHIPPER: "returned",
  CANCELLED: "returned",
};

const TEMPLATE_BY_EVENT: Record<WhatsAppEventType, string> = {
  booking_confirmed: "order_booking_confirmed",
  receipt_ready: "order_receipt_ready",
  picked_up: "order_picked_up",
  in_transit: "order_in_transit",
  arrived_in_city: "order_arrived_in_city",
  out_for_delivery: "order_out_for_delivery",
  delivery_failed: "delivery_attempt_failed",
  delivered: "order_delivered",
  returned: "order_returned",
};

function text(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

export function eventForInstaWorldStatus(status: string | null | undefined): WhatsAppEventType | null {
  return STATUS_EVENTS[text(status).toUpperCase()] || null;
}

export function buildNotificationPlan(
  eventType: WhatsAppEventType,
  snapshot: WhatsAppShipmentSnapshot,
): WhatsAppNotificationPlan {
  const common = [
    text(snapshot.recipientName) || "Customer",
    `#${snapshot.orderNumber}`,
    text(snapshot.trackingNumber),
  ];
  const parameters = eventType === "receipt_ready"
    ? [...common, text(snapshot.amountDue), text(snapshot.currencyCode)]
    : eventType === "arrived_in_city"
      ? [...common, text(snapshot.city)]
      : eventType === "delivery_failed"
        ? [...common, text(snapshot.city)]
        : common;

  return {
    eventType,
    templateName: TEMPLATE_BY_EVENT[eventType],
    parameters,
    ...(eventType === "receipt_ready" && snapshot.receiptUrl ? {documentUrl: snapshot.receiptUrl} : {}),
  };
}

export function buildStatusNotificationPlan(
  snapshot: WhatsAppShipmentSnapshot,
): WhatsAppNotificationPlan | null {
  const eventType = eventForInstaWorldStatus(snapshot.status);
  return eventType ? buildNotificationPlan(eventType, snapshot) : null;
}
