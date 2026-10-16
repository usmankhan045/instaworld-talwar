# Talwar Store Automated Order-Confirmation IVR Plan

Status: Implementation in progress — no outbound calls are enabled.

Owner: Talwar Store

Application: `instaworld-talwar`

Last updated: 2026-10-16

## 1. Objective

When a new Shopify website order is received, the app will automatically place a telephone call to the customer. The call will use fixed Urdu recordings for the workflow and dynamically generated audio for the customer name, product name, and complete normalized address.

The customer will confirm the order and then confirm the address using keypad input. Only an order that passes both confirmations will be sent to the existing TCS booking flow.

WhatsApp address collection is intentionally out of scope for the first calling phase. If the customer reports an incorrect address, the order will be held in `address_change_required` state until the later WhatsApp feature or a manual admin process supplies the corrected address.

This is a deterministic IVR, not a conversational AI agent.

## 2. Non-negotiable business rules

- No shipment is booked merely because a Shopify order was created.
- No shipment is booked after an unanswered call.
- No shipment is booked after a cancellation response.
- No shipment is booked when the customer says the address is incorrect.
- No shipment is booked when the call result is ambiguous or incomplete.
- A customer must confirm the order and the address separately.
- A missed call or a call dropped before both confirmations must be retried on
  the same call job, subject to the attempt limit and calling hours.
- Partial keypad input from one attempt must never be combined with a later
  attempt to authorize booking.
- A Shopify order may have only one active call attempt at a time.
- A Shopify order may not create duplicate TCS shipments because of repeated webhooks, worker retries, or duplicate keypad events.
- The exact Shopify order number remains the TCS/booking reference.
- The existing canceled-shipment/rebooking protections remain in force.
- The system must never spoof an unrelated caller ID.
- Outbound calling must remain disabled until the SIP provider, caller ID, audio quality, and DTMF behavior pass the test plan.

## 3. Final architecture

```text
Shopify orders/create webhook
        |
        v
Existing Shopify app + PostgreSQL
        |
        | creates idempotent CallJob
        v
Calling worker / scheduler
        |
        | generates personalized WAV audio
        v
FreePBX + Asterisk on a separate VPS
        |
        | SIP registration or IP-authenticated trunk
        v
SIP termination provider
        |
        v
Pakistani mobile networks
        |
        v
Customer keypad response
        |
        v
Call result webhook/API
        |
        v
Existing TCS booking service
```

### Components

1. Shopify webhook registration for `orders/create`.
2. Prisma models for call jobs and individual attempts.
3. A database-backed queue initially; Redis is not required for the first version.
4. A Node.js/TypeScript calling worker.
5. FreePBX/Asterisk for dialplan, playback, DTMF, hangup, and call events.
6. A SIP termination provider for the actual Pakistani phone network connection.
7. Local Urdu audio generation for variable text only.
8. The existing booking service for TCS booking after confirmation.

## 4. Customer call script and state machine

### Step 1: order greeting

The system generates one personalized audio segment containing the customer name and product name, followed by a fixed recording:

> السلام علیکم [customer name] صاحب/صاحبہ، ٹالور اسٹور سے آپ کا [product name] کا آرڈر موصول ہوا ہے۔

> آرڈر کنفرم کرنے کے لیے ایک دبائیں، منسوخ کرنے کے لیے دو دبائیں۔

The name suffix must be configurable. If gender or a natural suffix is unknown, use a neutral form instead of guessing.

Supported product behavior:

- One product: read the product name and quantity.
- Multiple products: read each product name and quantity in a short list.
- Empty or unsafe product title: use “آپ کا آن لائن آرڈر”.
- Product titles must be passed through a pronunciation/phonetic normalization map before audio generation.

### Step 2: order response

- `1`: set order response to `confirmed`; continue to address playback.
- `2`: set order response to `cancelled`; do not book; end call politely.
- Invalid key: replay the prompt once, then mark `invalid_input` if still invalid.
- No input: replay once; on the second timeout mark the attempt `no_input`.

### Step 3: address playback

The system generates an audio segment containing the complete normalized delivery address and plays it before a fixed confirmation recording:

> آپ کا پتہ ہے: [complete normalized address]۔ اگر پتہ درست ہے تو ایک دبائیں، اگر پتہ تبدیل کرنا ہے تو دو دبائیں۔

The address audio must use the same corrected city/province normalization already used for booking. The final text used for audio must be logged with the call attempt so the admin can verify exactly what was spoken.

### Step 4: address response

- `1`: set address response to `confirmed`; set call result to `order_and_address_confirmed`.
- `2`: set call result to `address_change_required`; do not book.
- Invalid key/no input: replay once, then hold the order for manual review.

### Interrupted call

If the customer does not answer, or the connection drops before both the order
and address have been confirmed in the **same attempt**, record that attempt as
`no_answer` or `dropped` and schedule a new attempt on the existing `CallJob`.
The new call starts again at the greeting and asks both questions. A previous
attempt's partial `1` response is audit history only. A dropped call after a
durably recorded cancellation or incorrect-address response is final for that
decision and must not trigger a retry. A drop after both confirmations have
been durably committed must not trigger a second call or booking.

### Step 5: booking

After the call result is durably saved, the worker invokes the existing TCS booking function using:

- exact Shopify order number as the reference;
- the normalized address;
- existing TCS payload rules;
- existing idempotency and duplicate-shipment checks.

The booking must not happen inside the telephone media session before the confirmation result is committed.

## 5. Order and call statuses

### CallJob status

```text
queued
preparing_audio
ready
calling
answered
order_confirmed
address_confirmed
order_and_address_confirmed
address_change_required
cancelled
no_answer
busy
dropped
failed
invalid_input
manual_review
booking_pending
booking_succeeded
booking_failed
```

### CallAttempt status

```text
created
originated
ringing
answered
completed
no_answer
busy
dropped
failed
```

### TCS booking rule

Only `order_and_address_confirmed` may transition to `booking_pending` and then call the booking service.

## 6. Database design

Add these Prisma models or equivalent fields, keeping existing shipment models intact.

### `CallJob`

Suggested fields:

```text
id
shop
shopifyOrderId
shopifyOrderNumber
customerName
phone
productSummary
normalizedAddress
orderStatus
addressStatus
callStatus
attemptCount
nextAttemptAt
activeLeaseToken
leaseExpiresAt
lastCallAttemptId
bookingAttemptId
confirmedAt
cancelledAt
createdAt
updatedAt
```

Constraints:

- unique `(shop, shopifyOrderId)`;
- index `(shop, callStatus, nextAttemptAt)`;
- index `(shop, phone)` only if operational reporting requires it.

### `CallAttempt`

Suggested fields:

```text
id
callJobId
attemptNumber
asteriskCallId
sipProviderCallId
status
orderChoice
addressChoice
callResult
spokenNameText
spokenProductText
spokenAddressText
audioFileKeys
failureCode
failureMessage
startedAt
answeredAt
completedAt
createdAt
updatedAt
```

Do not store SIP passwords, API keys, or full sensitive payloads in these models.

### Idempotency

- Webhook idempotency key: Shopify webhook event ID when available; otherwise `(shop, shopifyOrderId)`.
- Call job idempotency key: `(shop, shopifyOrderId)`.
- Booking idempotency key: existing booking key based on the exact Shopify order reference.
- Asterisk event processing must be idempotent by provider call ID and event ID.

## 7. Shopify integration

### Webhook

Add an `orders/create` subscription to `shopify.app.toml` and register it through the app’s supported Shopify webhook mechanism.

The webhook handler must:

1. Authenticate the Shopify webhook.
2. Parse only the data needed to create the call job.
3. Upsert one `CallJob` by shop and Shopify order ID.
4. Ignore duplicate delivery of the same event.
5. Return quickly after persistence; it must not wait for the phone call.

The worker will later fetch the full order through the authenticated Shopify Admin API if the webhook payload does not contain complete data.

### Order eligibility

The first version should call only eligible website orders according to the existing Talwar Store rules. It must exclude:

- orders without a usable phone number;
- orders already canceled on Shopify;
- orders already confirmed/booked by the app;
- duplicate order jobs;
- test orders unless explicitly enabled in development mode.

## 8. Personalized audio design

### Fixed recordings

Use human-recorded Urdu WAV files for all fixed instructions:

- greeting transition;
- press 1/2 instruction;
- address confirmation instruction;
- cancellation;
- successful confirmation;
- no-input retry;
- invalid-input retry;
- manual-review/hold message.

Store recordings outside the public web directory. Use telephone-compatible audio, normally mono WAV at the format required by the chosen Asterisk setup.

### Dynamic segments

Generate only these parts dynamically:

- customer name;
- product name and quantity;
- complete normalized address.

Initial local TTS candidate: Piper Urdu voice model. The final model must be selected only after testing Pakistani names, Roman Urdu, English product titles, house numbers, streets, districts, and provinces.

Audio generation requirements:

- sanitize all input before sending it to TTS;
- limit maximum text length;
- convert phone-number-like sequences and amounts into readable forms;
- apply city/province pronunciation mappings;
- cache by content hash;
- expire old audio files;
- never expose audio files through an unauthenticated public URL;
- keep the exact source text in `CallAttempt` for auditability.

If TTS quality is not acceptable, do not silently use incorrect audio. Pause address confirmation and use the manual-review path until a better voice/model is selected.

## 9. Asterisk/SIP integration

### Asterisk responsibilities

- originate an outbound call;
- pass a signed call-job ID as channel data;
- play fixed and dynamic audio;
- collect DTMF digits with timeouts and retry limits;
- report call lifecycle events;
- hang up cleanly;
- prevent concurrent calls for the same call job.

### App/worker responsibilities

- claim a queued call job with a lease;
- prepare audio;
- request call origination;
- reconcile Asterisk events;
- save DTMF results;
- release or retry leases;
- invoke TCS only after durable confirmation.

### Provider requirements

The SIP provider must support:

- outbound Pakistani mobile termination;
- verified business caller ID or an approved number-hosting arrangement;
- DTMF relay suitable for IVR, preferably RFC 4733/telephone-event;
- SIP registration or static-IP authentication;
- clear billing increments;
- call-detail records;
- route testing across Jazz, Zong, Ufone, and Telenor;
- a documented concurrent-channel limit;
- a lawful, approved automated-order-confirmation use case.

CloudyVoice is a low-cost candidate for testing, but caller-ID presentation and routes are not guaranteed on every destination. A local Pakistani SIP provider remains the quality/caller-ID comparison. No provider is selected for production until the route test passes.

## 10. Retry and failure policy

Suggested defaults, configurable later:

- no answer: retry after 30–60 minutes;
- busy: retry after 15–30 minutes;
- answered but dropped before both confirmations: retry after 10–15 minutes;
- a missed call or a mid-call drop creates a new `CallAttempt` under the same
  `CallJob`; it never creates a second job or shipment;
- technical failure: retry with exponential backoff;
- maximum attempts: 3;
- no calls outside the configured Pakistan business-hours window;
- after maximum attempts: `manual_review`;
- if customer cancels: never retry automatically;
- if customer reports a bad address: do not retry until the address is corrected.
- if the customer already cancelled or both confirmations were durably saved:
  do not redial even if the telephone connection then drops.

Retry jobs must use the same Shopify order identity and must not create a second call while an earlier attempt is still active.

## 11. Booking integration

Reuse the existing TCS booking logic rather than creating a second booking implementation.

Before booking:

1. Load the current call job and latest confirmation attempt.
2. Verify both order and address are confirmed.
3. Re-read the current normalized address and order data.
4. Check whether an active TCS shipment already exists.
5. Use the exact Shopify order number as the reference.
6. Call the existing booking function with its current idempotency protections.
7. Save the TCS result on the call job and existing shipment records.

If booking fails, keep the call confirmation intact and set `booking_failed`; do not call the customer again automatically unless an explicit retry policy is added.

## 12. Admin UI

First release:

- call status on the order booking action or app page;
- last attempt time;
- number of attempts;
- confirmation result;
- spoken address preview;
- booking result;
- retry/manual-review action;
- ability to disable calling globally.

Do not add WhatsApp controls in the first release.

## 13. Security and privacy

- Keep SIP credentials and provider tokens in server environment variables.
- Do not put SIP credentials in Shopify extensions or browser code.
- Authenticate all internal event endpoints.
- Sign or otherwise verify Asterisk/worker callbacks.
- Do not log full phone numbers or addresses unnecessarily.
- Redact secrets from errors and request logs.
- Restrict access to call audio and transcripts/source text.
- Add configurable retention for generated audio and call metadata.
- Use a verified business caller ID and follow the provider’s lawful-use requirements.
- Add a global kill switch before enabling production calls.

## 14. Development phases

### Phase 0 — design and dry-run preparation

- Confirm SIP provider and caller-ID path.
- Confirm the business number to present.
- Record fixed Urdu prompts.
- Select and test local Urdu TTS.
- Add database models and migration.
- Add `orders/create` webhook.
- Add a dry-run call queue.
- Add admin status visibility.

Exit condition: a test Shopify order creates exactly one call job and produces the exact personalized name/product/address text without placing a call.

### Phase 1 — call workflow without booking

- Install FreePBX/Asterisk in a test environment.
- Connect a test SIP trunk.
- Place calls only to internal/test numbers.
- Verify fixed audio, dynamic audio, DTMF, timeouts, retries, and event reconciliation.
- Save all call results.

Exit condition: test calls produce correct `confirmed`, `cancelled`, `address_change_required`, `no_answer`, and `failed` results.

### Phase 2 — call-to-booking gate

- Enable TCS booking only for confirmed test orders.
- Verify exact Shopify references.
- Verify duplicate webhook/call/event behavior.
- Test booking failures and retries.

Exit condition: only fully confirmed test orders are booked, and no order creates duplicate shipments.

### Phase 3 — controlled production pilot

- Enable a small allowlist of phone numbers/orders.
- Test calls across all available Pakistan mobile networks.
- Monitor answer rate, audio quality, DTMF reliability, call duration, and booking accuracy.
- Compare SIP provider routes and costs.

Exit condition: provider and IVR meet the agreed quality thresholds for a full rollout.

### Phase 4 — production rollout

- Enable calls for eligible website orders.
- Keep the kill switch available.
- Monitor failures and manual-review queue daily.
- Add WhatsApp address collection only after the call workflow is stable.

## 15. Testing plan

### Automated tests

- duplicate Shopify webhook creates one call job;
- duplicate worker claim cannot create two active calls;
- customer order cancellation never books TCS;
- address problem never books TCS;
- both confirmations trigger exactly one booking;
- duplicate DTMF event is harmless;
- duplicate booking callback is harmless;
- exact Shopify order number remains the reference;
- canceled/rebooked TCS/InstaWorld records retain existing rebooking behavior;
- city/province normalization used in spoken text matches booking payload;
- TTS input is sanitized and bounded.

### Manual tests

- Jazz number;
- Zong number;
- Ufone number;
- Telenor number;
- weak-signal customer;
- busy/no-answer customer;
- invalid keypad input;
- customer hangs up after order confirmation;
- customer misses the first call and answers the scheduled retry;
- customer drops before order choice, after order `1`, and during address
  playback; each case retries and asks both questions again;
- customer drops just after address `1` is durably saved; no retry or duplicate
  booking occurs;
- customer reports incorrect address;
- multiple products;
- Urdu name and English product name;
- long address with district and province;
- repeated canceled/rebooked order.

## 16. Production acceptance criteria

The feature is ready only when:

- a new eligible Shopify order creates one call job;
- the system places the call automatically;
- personalized name, product, and address audio are correct;
- fixed Urdu recordings are understandable;
- keypad responses are reliable;
- no-answer and cancellation paths do not book;
- incorrect-address paths do not book;
- confirmed orders book through the existing TCS service;
- duplicate events do not create duplicate calls or shipments;
- the business caller ID displays correctly on tested networks;
- the kill switch stops new calls;
- all tests and type checking pass;
- provider costs and billing increments are verified from call-detail records.

## 17. Immediate next implementation order

Progress as of 2026-10-16: steps 1–6 are implemented. Phase 1 host preparation
for step 7 is in `infra/asterisk/`. A test VPS, fixed recordings, and SIP trunk
are still needed to run the live Asterisk checks. The call worker remains in
dry-run mode.

1. Add `CallJob` and `CallAttempt` Prisma models.
2. Add the migration and test fixtures.
3. Add the Shopify `orders/create` webhook.
4. Add the database-backed call worker in dry-run mode.
5. Add personalized call payload/audio preparation.
6. Add the admin call-status view.
7. Install and configure test Asterisk/FreePBX.
8. Add SIP provider adapter and provider-independent call interface.
9. Test calls without booking.
10. Connect the confirmed result to the existing TCS booking function.
11. Run the controlled pilot.
12. Enable production calls only after acceptance criteria pass.

## 18. Explicitly out of scope for the first release

- WhatsApp address collection;
- speech recognition;
- conversational AI;
- free-form spoken address correction;
- payment collection by telephone;
- automatic order cancellation inside Shopify;
- automated calls outside configured business hours;
- carrier selection based on customer network;
- automatic caller-ID spoofing;
- replacing the existing TCS booking implementation.

