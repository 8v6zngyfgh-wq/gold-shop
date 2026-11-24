# GOLD SHOP — Telegram Mini App MVP

This is a front-end MVP/prototype in a REPRESENT-inspired premium streetwear direction.

## Included
- Responsive mobile-first storefront
- Home, catalog, category filters, product details and size selection
- Favorites and cart (stored in browser localStorage)
- Checkout form with manual Telegram-order handoff placeholder
- Online-payment choice shown as a future integration point
- Admin preview screen (not secured; demonstration only)
- Telegram Web App SDK initialization and `sendData` handoff hook

## Important limitations
This package is a visual/interaction prototype, not a production store yet.
It does NOT include a live database, a real Telegram bot, secure admin authentication,
server-side order storage, stock reservation, delivery integrations, or payment processing.
Do not accept real payments or rely on this prototype for real orders.

## Preview
Open `index.html` in a browser. Internet access is needed for the remote product photography
and Telegram Web App SDK.

## Next steps for production
1. Create a Telegram bot with BotFather and configure its token securely on a server.
2. Add a backend and database for products, inventory, customers and orders.
3. Restrict admin actions to the owner's Telegram user ID.
4. Connect the Mini App URL in the bot menu.
5. Implement payment provider checkout and verify payment callbacks server-side.
6. Configure delivery and order notifications.

The visual direction is inspired by premium streetwear ecommerce: bold typography,
monochrome palette, editorial photography, rectangular controls and restrained UI.
It is not a copy of REPRESENT's branding or proprietary assets.
