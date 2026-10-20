export type WhatsAppAccountKey = "store" | "food";

export type WhatsAppEventType =
  | "booking_confirmed"
  | "receipt_ready"
  | "picked_up"
  | "in_transit"
  | "arrived_in_city"
  | "out_for_delivery"
  | "delivery_failed"
  | "delivered"
  | "returned";

export type WhatsAppShipmentSnapshot = {
  shop: string;
  accountKey: WhatsAppAccountKey;
  shipmentId?: string;
  shopifyOrderId?: string;
  orderNumber: string;
  recipientPhone: string;
  recipientName?: string | null;
  trackingNumber?: string | null;
  receiptUrl?: string | null;
  amountDue?: number | null;
  currencyCode?: string | null;
  city?: string | null;
  status?: string | null;
};

export type WhatsAppNotificationPlan = {
  eventType: WhatsAppEventType;
  templateName: string;
  parameters: string[];
  documentUrl?: string;
};
