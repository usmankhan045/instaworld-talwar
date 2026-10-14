# Deployment Guide — instaworld-talwar on Vercel + Neon PostgreSQL

## Prerequisites

- Neon project created with a **pooled** connection string (`DATABASE_URL`) and a **direct** connection string (`DIRECT_DATABASE_URL`).
- Vercel project linked to this repository.
- All Shopify credentials available.

> ⚠️ **Never commit credentials**. Add them only through Vercel's environment variable UI or CLI.

---

## Environment Variables (Vercel Dashboard → Settings → Environment Variables)

Set these for all environments (Production, Preview, Development):

> ⚠️ **Every variable below must have a real, non-empty value in Vercel.**  
> `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL` are passed directly to  
> `shopifyApp()` at startup. If any of these are blank or missing, **every request throws  
> a configuration error** and Vercel logs an "Application Error" (HTTP 500) on the initial  
> page load and on any fetch the Admin UI Extension makes to the app server.

| Variable | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Neon → Connection Details → Pooled URL | Used by Prisma for query execution (via connection pooling) |
| `DIRECT_DATABASE_URL` | Neon → Connection Details → Direct URL | Used by Prisma Migrate; bypasses pooler for DDL |
| `SHOPIFY_API_KEY` | Shopify Partners → App → API credentials | **Must not be empty** |
| `SHOPIFY_API_SECRET` | Shopify Partners → App → API credentials | **Must not be empty** |
| `SHOPIFY_APP_URL` | `https://app.talwarstore.com` | **Must equal the production Vercel URL exactly** — the Admin UI Extension hardcodes this URL as its fetch base; any mismatch will cause extension API calls to fail |
| `SCOPES` | `read_orders` | |
| `INSTAWORLD_API_KEY` | InstaWorld merchant portal | |
| `INSTAWORLD_BASE_URL` | `https://one-be.instaworld.pk/merchant-api/v2` | Default is already set in .env.example |
| `INSTAWORLD_LOCATION_ID` | InstaWorld merchant portal | |
| `INSTAWORLD_ENABLE_LIVE` | **`false`** | **Keep disabled** until API contract is verified |
| `INSTAWORLD_CONTRACT_CONFIRMED` | **`false`** | **Keep disabled** |
| `INSTAWORLD_IDEMPOTENCY_CONFIRMED` | **`false`** | **Keep disabled** |
| `INSTAWORLD_REF_PREFIX` | Per InstaWorld contract | |
| `INSTAWORLD_REF_MAX_LENGTH` | Per InstaWorld contract | |
| `INSTAWORLD_REF_PATTERN` | Per InstaWorld contract | |
| `INSTAWORLD_COD_PAYMENT_TYPE` | Per InstaWorld contract | |
| `INSTAWORLD_PREPAID_PAYMENT_TYPE` | Per InstaWorld contract | |

---

## Database Migration — Controlled Manual Step

> ⚠️ **Migrations are intentionally NOT part of the automatic Vercel build.**
> This prevents accidental schema changes on every deploy.

Run migrations manually using the Vercel CLI **after** deploying a new release:

```bash
# 1. Pull production environment variables locally (one-time setup)
vercel env pull .env.local

# 2. Apply pending migrations against the Neon database
#    (uses DIRECT_DATABASE_URL from .env.local)
npx dotenv -e .env.local -- npx prisma migrate deploy
```

Or, if you have credentials in your local `.env`:

```bash
npx prisma migrate deploy
```

### What `prisma migrate deploy` does
- Reads `prisma/migrations/migration_lock.toml` and refuses to run if provider is not `postgresql`.
- Compares the `_prisma_migrations` table in Neon against local migration files.
- Applies only **new, unapplied** migrations in order — never re-runs applied ones.
- Does NOT auto-generate migrations or modify the schema file.

---

## Vercel Build Configuration

The Vercel build command should be:

```
npm run build
```

Which runs `react-router build`. This does **not** run migrations.

The `setup` script (`prisma generate`) is run implicitly via the `postinstall` lifecycle if needed, or you can add it as a pre-build step:

```
npm run setup && npm run build
```

**Do not add `npm run db:migrate` to the Vercel build command.** Migrations must be run deliberately.

---

## First Deploy Checklist

- [ ] Set **all** environment variables in Vercel dashboard — especially `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL=https://app.talwarstore.com` (blank values cause HTTP 500 on every request)
- [ ] Deploy app to Vercel (`git push` or Vercel CLI)
- [ ] Run `npx prisma migrate deploy` manually (see above)
- [ ] Verify Neon console shows all 6 tables: `Session`, `OrderBooking`, `Shipment`, `ShipmentOrder`, `BookingAttempt`, `OrderReservation`
- [ ] Install the Shopify app on a development store to confirm auth/session works
- [ ] Run `npm run deploy` (or `shopify app deploy`) to upload the extension bundle to Shopify's CDN
- [ ] In Shopify Partners dashboard, confirm the extension version is **Active**
- [ ] Open a test order in the Shopify Admin and verify the **InstaWorld Booking** action button appears
- [ ] Confirm `INSTAWORLD_ENABLE_LIVE=false` — no live shipments should be created

---

## Docker (local / staging)

The `docker-start` script handles generate + migrate + serve automatically:

```bash
npm run docker-start
# equivalent to: prisma generate && prisma migrate deploy && react-router-serve
```

This is safe for Docker because the container has full `DATABASE_URL` access at start time.

---

## Session Storage

`PrismaSessionStorage` (from `@shopify/shopify-app-session-storage-prisma@11.0.1`) uses the **same** `PrismaClient` instance as the application (`app/db.server.ts`). Both connect through `DATABASE_URL`. There is no separate session database connection.

---

## InstaWorld Safety Gates

All live-booking safety gates are **disabled by default** and must be explicitly enabled in the environment:

```
INSTAWORLD_ENABLE_LIVE=false           # master switch
INSTAWORLD_CONTRACT_CONFIRMED=false    # requires API contract verification
INSTAWORLD_IDEMPOTENCY_CONFIRMED=false # requires idempotency test with InstaWorld
```

Do not enable these until the merchant API contract has been verified and a controlled live test has been authorized.

---

## Admin UI Extension Authentication

The `instaworld-booking` Admin UI Extension communicates with the app server (Vercel) by:

1. **Calling `shopify.auth.idToken()`** — the Shopify platform issues a signed OIDC ID token for the current merchant session.
2. **Sending `Authorization: Bearer <token>`** on every `fetch` request to `/api/instaworld-orders` and `/api/instaworld-booking`.
3. **Server-side validation** — `authenticate.admin(request)` in `@shopify/shopify-app-react-router` validates the ID token signature using Shopify's public JWKS. No code changes are needed on the server side.

> **Why not `window.location.origin`?**  
> Inside the Admin extension sandbox, `window.location` reflects the extension CDN origin (e.g. `https://cdn.shopify.com`), **not** the Vercel app URL. All fetch calls must target `https://app.talwarstore.com` directly.

> **Why not `shopify.sessionToken()`?**  
> The `sessionToken()` method does not exist in `@shopify/ui-extensions` 2026.x. The correct API is `shopify.auth.idToken()`, which returns a Promise resolving to a JWT string or `null`.
