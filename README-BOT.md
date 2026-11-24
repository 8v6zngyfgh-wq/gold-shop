# GOLD SHOP backend

These backend files are added alongside the existing static storefront. The current `index.html` is intentionally left unchanged.

## Included

- Express API server with `/health` and `/api/products`
- Telegram bot using grammY
- Telegram webhook endpoint protected by Telegram's secret-token header
- `/start`, `/id`, and restricted `/admin` commands
- Initial Supabase schema for products and orders

This is the first backend foundation, not a finished ordering or admin system. Product editing, order creation, delivery integrations, and payments still need to be implemented and tested.

## 1. Create the database tables

In Supabase, open SQL Editor and run `db/schema.sql`.

RLS is enabled on all tables and no public policies are created. The server uses the Supabase secret key. Keep that key on the server only; never put it in `index.html` or browser code.

## 2. Configure Render

Create a separate **Web Service** from this same GitHub repository. Do not change the existing static site's settings.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Instance type: Free (if available)

Render supplies `PORT` and `RENDER_EXTERNAL_URL` automatically.

Add these environment variables in the Render service settings:

- `BOT_TOKEN` — token from BotFather
- `WEBHOOK_SECRET` — random secret of at least 32 characters using only letters, numbers, underscores, and hyphens
- `SUPABASE_URL` — Project URL from Supabase
- `SUPABASE_SECRET_KEY` — Supabase secret key (server only)
- `ADMIN_IDS` — comma-separated Telegram numeric user IDs

Do not commit real tokens or keys to GitHub and do not send them in chat.

## 3. Get your Telegram ID

After the service is deployed and the bot token is configured, send `/id` to the bot. Add the returned numeric ID to `ADMIN_IDS` in Render, then redeploy.

## 4. Important notes

- The existing static storefront is not modified by these backend files.
- Keep the existing Render static service's publish directory and settings unchanged.
- Free services may sleep when idle, so the first request can be delayed.
- Online payments are not implemented. Do not collect card details in this app.
- Before accepting real orders, implement and test server-side validation, order creation, stock checks, and admin workflows.
