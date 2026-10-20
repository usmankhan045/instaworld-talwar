# WhatsApp automation execution plan

This subsystem is intentionally isolated from the current InstaWorld booking, Shopify fulfillment, and calling-agent flows. It is disabled until the Meta credentials and the final integration gate are configured.

## Target behavior

After a shipment is booked, the app will enqueue a receipt message and status messages for the customer. Each status is sent at most once per shipment and event. The important customer journey is:

1. Booking confirmed: send the InstaWorld receipt/document when a receipt URL is available.
2. Picked up and in transit: keep the customer informed without duplicate messages.
3. Arrived in city: tell the customer the parcel has reached their city and they should be ready.
4. Out for delivery: tell the customer to remain available.
5. Delivery attempt failed: immediately tell the customer that delivery could not be completed because nobody was available, and include the next action or pickup instructions when InstaWorld provides them.
6. Delivered or returned: send the final outcome and stop further delivery reminders.

## Account routing

There are two logical WhatsApp accounts, stored per shop:

- `store`: the existing account for non-food products.
- `food`: the separate account for food orders.

The shipment snapshot carries `accountKey`; the outbox uses that key to select the matching Meta phone-number ID and access token. No message is sent through the other account.

## Current isolated implementation

- `WhatsAppAccount`, `WhatsAppTemplate`, `WhatsAppNotification`, and `WhatsAppWebhookEvent` tables provide account configuration, template mapping, an idempotent outbox, and delivery receipts.
- `app/lib/whatsapp/rules.server.ts` maps InstaWorld statuses to customer events and template names.
- `app/lib/whatsapp/outbox.server.ts` persists notifications before sending, retries transient failures, and prevents duplicate sends.
- `app/routes/api.whatsapp-worker.ts` is a separately protected worker endpoint.
- `app/routes/api.whatsapp-webhook.ts` receives Meta delivery/read/failure callbacks.
- No existing booking or sync route imports this subsystem yet; that is the final integration step after credentials and templates are ready.

## Activation gate

Keep `WHATSAPP_AUTOMATION_ENABLED=false` until all of the following are complete:

1. Create/verify both Meta WhatsApp Business phone numbers.
2. Create and approve the required templates in the correct language(s), including the receipt document header and delivery-failed template.
3. Configure the store and food phone-number IDs, business account IDs, and access tokens.
4. Configure the webhook verify token and Meta webhook subscription.
5. Run the database migration.
6. Connect the booking-complete and InstaWorld status-sync code to `buildStatusNotificationPlan` and `enqueueWhatsAppNotification`.
7. Configure a scheduler to call `/api/whatsapp-worker` with `CRON_SECRET`.
8. Test with internal numbers, then enable the flag.

## Environment contract

```text
WHATSAPP_AUTOMATION_ENABLED=false
WHATSAPP_GRAPH_VERSION=v23.0
WHATSAPP_STORE_PHONE_NUMBER_ID=
WHATSAPP_STORE_BUSINESS_ACCOUNT_ID=
WHATSAPP_STORE_ACCESS_TOKEN=
WHATSAPP_FOOD_PHONE_NUMBER_ID=
WHATSAPP_FOOD_BUSINESS_ACCOUNT_ID=
WHATSAPP_FOOD_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
CRON_SECRET=
```

The access tokens must remain server-side. They must never be exposed to the Shopify extension, browser, logs, or customer messages.

## Final integration contract

The existing booking code should call the isolated enqueue function only after InstaWorld returns a successful booking and a receipt URL (if available). The existing status synchronizer should call it after each newly observed status. The call must pass a normalized snapshot containing the shop, account key, shipment ID, Shopify order ID/number, customer phone, customer name, city, tracking number, status, and optional receipt URL.

The integration must not mark Shopify orders fulfilled until the existing shipment booking succeeds. For combined shipments, the existing source-order fulfillment behavior remains authoritative; WhatsApp only reports the resulting shipment status.

## Failure and safety rules

- Idempotency key: shop + shipment/order + event type.
- Failed Meta sends retry up to five times with backoff, then remain visible as `failed` for operator review.
- Worker claims use a short database lease so two scheduler invocations cannot send the same pending notification concurrently.
- A provider `failed` webhook updates the notification record and does not silently retry a permanently rejected template.
- A delivery-attempt failure is a customer-facing event and must be enqueued immediately on the first confirmed failed attempt.
- Messages are sent only to the phone number stored on the order after normalization/validation by the final integration adapter.
- Each account has its own phone-number ID and access token; there is no shared-token fallback between the store and food accounts.
- Webhook callbacks require Meta's HMAC signature and are scoped by the callback phone-number ID.
- If a template, account, receipt URL, or credential is missing, the notification remains auditable and the shipment flow is not blocked.

## Validation checklist before activation

- Prisma format, validate, generate, migration review.
- Unit tests for every status mapping, receipt document, failed-delivery copy inputs, account routing, idempotency, and retry behavior.
- Typecheck, lint, test suite, and production build.
- Meta webhook verification and signed/expected payload tests.
- End-to-end test for both account keys, receipt delivery, city-arrival update, out-for-delivery update, immediate failed-delivery message, delivered update, duplicate status, and combined Shopify orders.
- Confirm the current booking, calling, and Shopify fulfillment paths behave unchanged with the flag disabled.
