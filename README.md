# APRIA — apparel catalogue and enquiry site

Responsive APRIA storefront with searchable and sortable products, category filters, browser-saved favourites, size/colour variants, an editable quote list, bulk/private-label enquiry forms, and buyer FAQs. The Node.js backend stores enquiries as JSON lines when self-hosted, or durably in Cloudflare D1 when deployed there.

The catalogue also includes a browser-saved shopping bag and INR checkout. Checkout amounts are recalculated on the server from the catalogue, orders are created through Razorpay, and payment signatures, UPI method, and captured status are verified before an order is marked paid. Checkout is configured for UPI only and stays disabled until Razorpay credentials are configured.

## Live free deployment

APRIA is published on Cloudflare Workers at [apria-apparel.bellbottom184.workers.dev](https://apria-apparel.bellbottom184.workers.dev/). Enquiries are stored in the Cloudflare D1 database `apria`.

## Run locally

Requires Node.js 18 or newer. No runtime dependencies are needed.

```sh
npm start
```

Open `http://localhost:3000`. The site binds to `0.0.0.0` and uses `PORT` when supplied. Enquiries are saved in `data/enquiries.jsonl`.

The opening garment film lives in `public/media/`. It plays muted once in the hero, includes a poster fallback, and has controls for pausing, replaying and enabling sound. It stays paused automatically when reduced motion is enabled.

### Admin portal

The local portal is at `http://localhost:3000/admin`. Before the first owner setup, copy `.env.example` to `.env` and set two independent random values for `ADMIN_SETUP_TOKEN` and `ADMIN_SESSION_SECRET` (each at least 32 characters). Keep `.env` private and restart the server. Open `/admin/setup` once to create the owner account; setup then closes. Sign in at `/admin`.

The initial catalogue is copied into `data/admin-data.json` the first time the local server starts with the portal code. Existing local enquiries and Razorpay orders are imported into that portal store, while their original files remain in place. The new store contains customer contact and delivery details; keep the `data/` directory private and back it up securely. Local data and Cloudflare D1 are independent.

All existing product variants begin with zero stock. The owner enters real counts under **Catalogue & stock** before a variant can be added to the shopping bag. Staff accounts are created by the owner; a temporary password is shown once and must be changed at first sign-in. Customer enquiries and unpaid order requests appear in **Requests**; there are no email notifications. Verified payment state is read-only in the portal, and refunds remain in Razorpay.

## Free Cloudflare deployment

The Cloudflare setup serves the site on Workers and stores enquiries in a D1 database. Cloudflare's free Workers plan includes up to 100,000 D1 writes per day and 5 GB total D1 storage; service limits can change, so review the [current D1 limits](https://developers.cloudflare.com/d1/platform/pricing/) before launch.

1. Install Node.js and npm locally, then authenticate to your own Cloudflare account:

   ```sh
   npx wrangler login
   ```

2. Use the APRIA D1 database already named in `wrangler.jsonc`. If you are deploying this to a different Cloudflare account, create a D1 database and replace that binding's ID with the new one:

   ```sh
   npx wrangler d1 create apria
   ```

   Copy the returned database ID into `wrangler.jsonc`. Do not create a second database for an existing deployment.

3. Apply every migration, including `0003_admin_portal.sql`, and deploy:

   ```sh
   npx wrangler d1 migrations apply apria --remote
   npx wrangler deploy
   ```

   Wrangler prints the public `workers.dev` URL when deployment completes. Add `WHATSAPP_NUMBER` (international digits including the country code) under `vars` in `wrangler.jsonc`, then deploy again. Leave it blank to direct the WhatsApp button to the enquiry form.

4. Configure two independent random Worker secrets, `ADMIN_SETUP_TOKEN` and `ADMIN_SESSION_SECRET`, each at least 32 characters. Use Cloudflare **Settings → Variables and Secrets**; do not put them in `wrangler.jsonc`. Visit `https://<your-worker>/admin/setup` once to create the owner. Production portal data is stored in the bound D1 database and is separate from the local `data/` directory. Existing D1 enquiries and payment orders are retained when the portal migration runs. The managed catalogue is seeded from `public/products.json` on first access; set actual stock in the portal before accepting orders.

The Wrangler project is defined in `wrangler.jsonc`; the Worker API is in `worker.js`; `admin-worker.mjs` provides the D1-backed portal; and D1 migrations create enquiry, payment-order, catalogue, stock and portal tables. `public/` contains the public website assets. To create a dashboard-editor bundle, run `node scripts/build-dashboard-worker.js`; the generated source is written under the ignored `work/` folder.

### Enable Razorpay checkout

For local development, add Razorpay **Test Mode** key values to `.env`. `.env` is ignored by Git. Set the flat delivery fee in the admin portal (or `SHIPPING_FEE_PAISE` before the first local store initialization); `5000` means ₹50.

For a Cloudflare Worker, add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` as Worker **Secrets** in Settings → Variables and Secrets, then deploy the Worker. Never put these values in `wrangler.jsonc`, frontend code, or source control. Apply all D1 migrations, including the admin portal migration, before enabling checkout. On a Wrangler-managed deployment, run `npx wrangler d1 migrations apply apria --remote`; for a dashboard deployment, apply each unapplied migration SQL file in order in the D1 database console.

Use Razorpay Test Mode first and complete a test checkout. Before accepting live payments, replace the sample catalogue with APRIA's approved products, prices and delivery policy, enter accurate stock, and configure Razorpay automatic payment capture. Only then use Razorpay Live Mode keys. Razorpay credentials are required for checkout to accept payments; without them, the checkout can save an order request for APRIA to follow up, and clearly states that no payment was taken.

## Docker option

For any Docker-capable host, build and run:

```sh
docker build -t apria .
docker run --rm -p 3000:3000 -e WHATSAPP_NUMBER=919876543210 -v apria-data:/app/data apria
```

Attach persistent storage at `/app/data`; hosted container filesystems can be temporary. Set a health check to `GET /api/health` and configure HTTPS at the provider.

## API

- `GET /api/health` — health check.
- `GET /api/config` — public configuration (WhatsApp number only).
- `GET /api/payment/config` — public checkout availability, publishable Razorpay key ID and delivery fee.
- `GET /api/products` — active managed catalogue, including available stock by size and colour.
- `POST /api/enquiries` — validates and stores an enquiry. Body fields: `name`, `email`, `type` (`product`, `bulk`, `private-label`, or `general`), `message`, and optional `phone`, `company`, `items`.
- `POST /api/checkout/orders` — validates an Indian delivery address and catalogue variants, calculates the amount server-side, creates and stores a Razorpay order.
- `POST /api/checkout/verify` — verifies the Razorpay signature and checks the provider's payment amount, order and capture status.
- `POST /api/order-requests` — saves a structured unpaid retail order request when online payments are disabled.
- `/api/admin/*` — authenticated owner/staff portal API for the dashboard, enquiries, order requests, payment orders, catalogue, stock, users, settings and activity log.

## Before launch

Replace sample product descriptions, specifications, prices, and stock images with APRIA's actual products; enter verified size/colour stock; set the official WhatsApp number; and add real business contact and privacy details. Prices are indicative catalogue prices; bulk pricing is confirmed after enquiry. The portal supports manual fulfilment updates and payment visibility. It does not process refunds, send notifications, or connect to a shipping provider.
