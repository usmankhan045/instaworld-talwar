# InstaWorld Talwar Project Plan

## 1. Project objective
Build a private custom Shopify app for Talwar Store that integrates Shopify orders with the InstaWorld Merchant API v2. The purpose is to let the merchant manually confirm and book a courier shipment only after personally calling and confirming the customer.

This app must remain a manual process. It must never automatically create shipments on order creation, on webhooks, on status changes, or on order open.

## 2. Required app behavior
When the merchant opens the order action from the Shopify admin order details page:

1. Identify the selected Shopify order using the supported Admin UI extension API.
2. Retrieve the order details using an authenticated Shopify admin method.
3. Display:
   - order number
   - customer name
   - phone
   - delivery address
   - city
   - line items
   - quantities
   - prices
   - payment status
   - amount due
   - calculated declared weight
4. Allow the merchant to review the order and adjust the declared weight before booking.
5. Show a final confirmation step before sending the shipment request.
6. Disable repeat submissions while the booking is in progress.
7. Show a clear success message with the tracking number or a clear error message.

## 3. Business constraints
- The workflow is manual only.
- No automatic booking on order creation, webhook processing, order status updates, or order open.
- The app should not assume extension-provided order data is complete; use supported Shopify admin APIs when needed.
- No secrets are allowed in extension or browser code.
- No real shipment should be created during development testing.

## 4. InstaWorld API requirements
Base URL:
`https://one-be.instaworld.pk/merchant-api/v2`

Authentication:
`Authorization: ******`

The credential is verified with `GET /me` and is a brand-level API key with scopes:
- `shipments:read`
- `shipments:write`
- `settlements:read`

Configured dispatch location ID:
`16917`

Relevant operations:
- `GET /me` for verification
- `GET /locations` if needed
- `GET /cities` for serviceable cities
- `GET /shipments?ref_no=...` for duplicate checks
- `POST /shipments` to create the shipment
- `GET /shipments/{tracking_number}` to retrieve details if needed

Requirements:
- Validate the exact request and response contract from the API.
- Do not invent fields, endpoints, or success conditions.
- Use a stable `ref_no` based on the Shopify order number.
- Use `Idempotency-Key` when creating shipments.
- Check for an existing shipment by `ref_no` before creating a duplicate.
- Handle retries, timeouts, and duplicate clicks carefully.
- If the API returns a confirmed booking failure such as `502 booking_failed`, surface that clearly.
- Never claim a shipment is booked unless the API confirms success.

## 5. Weight rule
Talwar Store sells clothing products.

Default declared weight formula:
`total declared weight = sum of (line-item quantity × 0.8 kg)`

Examples:
- quantity 1 = 0.8 kg
- quantity 2 = 1.6 kg
- quantity 3 = 2.4 kg

Rules:
- Do not multiply by number of distinct line items alone.
- Use each line item’s actual quantity.
- Allow the merchant to adjust the total weight before booking.
- Keep the default configurable for future use.
- Do not require Shopify product weights to be populated.
- Validate final submitted weight is a positive, valid number.

## 6. Payment and COD rules
Handle both COD and prepaid orders safely.

Requirements:
- Inspect the actual financial status and order transactions.
- For COD, use the outstanding amount due from the customer, not blindly the original total.
- For prepaid orders, send the correct prepaid type and amount according to the InstaWorld API spec.
- Account for partial payments, discounts, refunds, and shipping charges when estimating amount due.
- If the amount due cannot be determined safely, block booking and explain why.
- Never change Shopify’s payment status or mark an order paid automatically.
- Verify the actual semantics of InstaWorld `payment.type` and `payment.amount` from the API documentation; do not invent them.

## 7. Customer and address validation
Before creating a shipment, validate required consignee data:

- valid phone number
- valid and serviceable city accepted by InstaWorld
- normalized city name without silently substituting a different destination
- complete delivery address
- required item data including quantity and weight

If required data is missing or malformed, explain the issue and allow the merchant to fix it where appropriate.

## 8. Database and duplicate protection
Use the existing Prisma setup where practical.

Persist booking state against the Shopify order, including:
- Shopify shop identifier
- Shopify order ID and order number
- InstaWorld tracking number
- booking status
- declared weight
- COD or prepaid information
- booking timestamp
- API error details excluding secrets

The design must prevent accidental multiple shipments from duplicate clicks or concurrent requests.

Use:
- a unique constraint on the order identity
- transaction-safe upsert logic where practical
- server-side duplicate checks before sending the shipment request

Do not rely only on the UI button disabling.

Never expose bearer tokens or sensitive customer information in logs.

## 9. Existing project structure and starter-template review
The project is an existing Shopify app built with:
- Shopify CLI
- Shopify React Router app template
- TypeScript
- Preact-based Shopify Admin UI extension
- Prisma database
- npm

Project path:
`~/Projects/instaworld-talwar`

Relevant project entries:
- app server and auth in [app/shopify.server.ts](/Users/usmankhan/projects/instaworld-talwar/app/shopify.server.ts)
- Prisma schema in [prisma/schema.prisma](/Users/usmankhan/projects/instaworld-talwar/prisma/schema.prisma)
- extension config in [extensions/instaworld-booking/shopify.extension.toml](/Users/usmankhan/projects/instaworld-talwar/extensions/instaworld-booking/shopify.extension.toml)
- extension entry in [extensions/instaworld-booking/src/ActionExtension.jsx](/Users/usmankhan/projects/instaworld-talwar/extensions/instaworld-booking/src/ActionExtension.jsx)
- Shopify app config in [shopify.app.toml](/Users/usmankhan/projects/instaworld-talwar/shopify.app.toml)

The starter code must be replaced with a real manual booking action flow; template demo behavior is not acceptable.

## 10. Required configuration checks
The app config must be reviewed and corrected relative to the official Shopify docs and current API usage.

Requirements:
- Shopify app config should be aligned with the actual required shop scopes and API version.
- Access scopes should include the permissions needed to read orders and submit order-related operations.
- The webhooks section should use `2026-10` where required.
- Redirect URLs and auth config should remain valid for the app.

The project config must not be replaced wholesale; it should be preserved and corrected minimally.

## 11. Implementation plan
### A. Update Shopify app configuration
- Validate `shopify.app.toml` against current Shopify requirements.
- Set or confirm API version `2026-10`.
- Confirm access scopes include the required order permissions.
- Keep the app’s embedded app configuration and redirect auth URLs valid.

### B. Preserve current app architecture
- Keep the existing React Router app structure and Shopify app auth setup.
- Keep Prisma session storage and Shopify authentication intact.
- Avoid unnecessary dependency upgrades.

### C. Replace template extension behavior
- Replace the starter product-focused action extension with an order review + shipping booking flow.
- Use the `admin.order-details.action.render` target.
- Read the selected order from the extension context and fetch the complete valid order from Shopify.

### D. Build booking review UI
- Show a summary of order information.
- Render line items and prices.
- Compute the default declared weight rule.
- Allow editing of the declared weight.
- Add a final confirmation step.
- Disable duplicate submission while running.

### E. Build secure backend booking endpoint
- Create a server route that receives the order booking request from the extension.
- Validate the shipment request payload.
- Check for duplicate booking records.
- Require the server-side API key.
- If live mode is off, return a safe development-mode success/failure simulation without real shipment creation.
- If live mode is on, send the real request to the InstaWorld API.

### F. Persist booking records
- Add Prisma model for order booking state.
- Use unique constraint on shop + order id.
- Record tracking number, status, weight, payment type, amount due, and API error messages.

### G. Validate and test
- Run `npm run typecheck`.
- Run Prisma generate/migration commands as needed.
- Ensure the app builds without TypeScript errors.
- Verify the extension still loads in the correct admin order action target.

## 12. Security and production safeguards
- Keep API credentials in environment variables, not in browser code.
- Never log bearer tokens or sensitive shipment payloads.
- Use server-side validation for all order and shipment data.
- Reject malformed or unsafe requests.
- Do not automatically fulfill or mark orders paid.
- Do not create shipments automatically.

## 13. Future extensibility
The system should be designed so it can later support:
- configurable default declared weight per store
- better city validation with an InstaWorld city lookup
- richer payment validation and settlement information
- shipment status tracking after booking
- admin dashboard reporting for past bookings and failures

## 14. Final implementation outcome expected
A merchant can open an order in Shopify Admin, choose the custom “Confirm & Book InstaWorld” action, review the order details, adjust the declared weight if necessary, confirm the shipment, and receive a clear success or failure result without creating duplicate bookings or exposing API secrets.

## 15. Files created or updated during implementation
- [shopify.app.toml](/Users/usmankhan/projects/instaworld-talwar/shopify.app.toml)
- [app/shopify.server.ts](/Users/usmankhan/projects/instaworld-talwar/app/shopify.server.ts)
- [extensions/instaworld-booking/shopify.extension.toml](/Users/usmankhan/projects/instaworld-talwar/extensions/instaworld-booking/shopify.extension.toml)
- [extensions/instaworld-booking/src/ActionExtension.jsx](/Users/usmankhan/projects/instaworld-talwar/extensions/instaworld-booking/src/ActionExtension.jsx)
- [app/routes/api.instaworld-booking.ts](/Users/usmankhan/projects/instaworld-talwar/app/routes/api.instaworld-booking.ts)
- [prisma/schema.prisma](/Users/usmankhan/projects/instaworld-talwar/prisma/schema.prisma)
- [prisma/migrations/20261014000000_add_order_booking/migration.sql](/Users/usmankhan/projects/instaworld-talwar/prisma/migrations/20261014000000_add_order_booking/migration.sql)
- [PROJECT_PLAN.md](/Users/usmankhan/projects/instaworld-talwar/PROJECT_PLAN.md)
