# Deployment Guide — InstaWorld Booking on Vercel + Neon PostgreSQL

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
| `INSTAWORLD_CREDENTIALS_ENCRYPTION_KEY` | A random 32-byte base64 or 64-character hex key | Encrypts InstaWorld API keys saved from the dashboard; keep stable and private |
| `SHOPIFY_API_KEY` | Shopify Partners → App → API credentials | **Must not be empty** |
| `SHOPIFY_API_SECRET` | Shopify Partners → App → API credentials | **Must not be empty** |
| `SHOPIFY_APP_URL` | `https://instaworld.barriovibe.com` | **Must equal the production Vercel URL exactly** — the Admin UI Extension uses this URL as its fetch base |
| `SCOPES` | `read_orders,read_products` | Required because booking reads product metafields from order line items |
| `APP_CONTACT_EMAIL` | Your support email | Used in the address verification service user agent |
| `GEOCODE_MAPS_API_KEY` | geocode.maps.co | **Required for strict production address verification**; do not leave blank in Vercel |

Do not add an InstaWorld API key or location ID to Vercel. Each Shopify store
connects its own API key from **App → Accounts** after installation. The server
detects the account identity, pickup locations, and available couriers, then
stores the key encrypted and all retrieved data scoped to that shop.

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

- [ ] Set **all** environment variables in Vercel dashboard — especially `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL=https://instaworld.barriovibe.com` (blank values cause HTTP 500 on every request)
- [ ] Deploy app to Vercel (`git push` or Vercel CLI)
- [ ] Run `npx prisma migrate deploy` manually (see above)
- [ ] Verify Neon console shows all 6 tables: `Session`, `OrderBooking`, `Shipment`, `ShipmentOrder`, `BookingAttempt`, `OrderReservation`
- [ ] Install the Shopify app on a development store to confirm auth/session works
- [ ] Run `npm run deploy` (or `shopify app deploy`) to upload the extension bundle to Shopify's CDN
- [ ] In Shopify Partners dashboard, confirm the extension version is **Active**
- [ ] Open a test order in the Shopify Admin and verify the **InstaWorld Booking** action button appears
- [ ] Open **App → Accounts** and connect the installed store's own InstaWorld API key
- [ ] Confirm `GEOCODE_MAPS_API_KEY` is set — bookings are blocked when an address cannot be verified

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

## Store-scoped InstaWorld credentials

`INSTAWORLD_CREDENTIALS_ENCRYPTION_KEY` is an application encryption secret. It
does not grant access to any courier account. Keep the same value across deploys
so saved merchant keys remain decryptable. Every courier request requires an
account record whose `shop` matches the authenticated Shopify shop.

---

## Admin UI Extension Authentication

The `instaworld-booking` Admin UI Extension communicates with the app server (Vercel) by:

1. **Calling `shopify.auth.idToken()`** — the Shopify platform issues a signed OIDC ID token for the current merchant session.
2. **Sending `Authorization: Bearer <token>`** on every `fetch` request to `/api/instaworld-orders` and `/api/instaworld-booking`.
3. **Server-side validation** — `authenticate.admin(request)` in `@shopify/shopify-app-react-router` validates the ID token signature using Shopify's public JWKS. No code changes are needed on the server side.

> **Why not `window.location.origin`?**  
> Inside the Admin extension sandbox, `window.location` reflects the extension CDN origin (e.g. `https://cdn.shopify.com`), **not** the Vercel app URL. All fetch calls must target `https://instaworld.barriovibe.com` directly.

> **Why not `shopify.sessionToken()`?**  
> The `sessionToken()` method does not exist in `@shopify/ui-extensions` 2026.x. The correct API is `shopify.auth.idToken()`, which returns a Promise resolving to a JWT string or `null`.
