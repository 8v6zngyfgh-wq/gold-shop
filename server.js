


const express = require("express");
const { Bot } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { timingSafeEqual, createHmac, randomUUID } = require("node:crypto");

const requiredEnv = ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const app = express();
app.disable("x-powered-by");
// Render terminates TLS at its edge and forwards the client address.
app.set("trust proxy", 1);

// Baseline browser security headers for the JSON API.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max, scope }) {
  return (req, res, next) => {
    const now = Date.now();
    const address = String(req.ip || req.socket?.remoteAddress || "unknown");
    const key = scope + ":" + address;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (rateLimitBuckets.size > 10000) {
      for (const [entryKey, entry] of rateLimitBuckets) {
        if (now - entry.startedAt >= windowMs) rateLimitBuckets.delete(entryKey);
      }
    }
    if (bucket.count > max) {
      const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
      res.setHeader("Retry-After", String(retrySeconds));
      return res.status(429).json({ error: "Слишком много запросов. Подожди немного и попробуй снова." });
    }
    next();
  };
}

const allowedOrigins = new Set([
  "https://gold-shop-rnph.onrender.com"
]);

app.use((req, res, next) => {
  const origin = req.get("Origin");
  res.vary("Origin");

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data, X-GOLD-Admin-Session");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(!origin || allowedOrigins.has(origin) ? 204 : 403);
  }

  next();
});

app.use(express.json({ limit: "128kb" }));

// Protect every Mini App administration route, including order updates and analytics.
app.use("/api/admin", rateLimit({ windowMs: 60_000, max: 60, scope: "admin" }));

// Lightweight per-IP abuse protection. Limits are scoped by endpoint, not order ID.

const bot = new Bot(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Прокси публичных фотографий: браузер загружает изображения через API GOLD SHOP,
// а сервер получает их из Supabase Storage. Разрешён только публичный Storage этого проекта.
const supabaseStorageOrigin = new URL(process.env.SUPABASE_URL).origin;

app.get("/api/image-proxy", rateLimit({ windowMs: 60_000, max: 180, scope: "image-proxy" }), async (req, res) => {
  try {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
    if (!rawUrl || rawUrl.length > 2048) {
      return res.status(400).json({ error: "Некорректный адрес изображения." });
    }

    const target = new URL(rawUrl);
    if (
      target.origin !== supabaseStorageOrigin ||
      !target.pathname.startsWith("/storage/v1/object/public/")
    ) {
      return res.status(403).json({ error: "Источник изображения не разрешён." });
    }

    const upstream = await fetch(target, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });

    if (!upstream.ok) {
      return res.sendStatus(upstream.status === 404 ? 404 : 502);
    }

    const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(contentType)) {
      return res.status(502).json({ error: "Источник вернул файл, который не является изображением." });
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) {
      return res.status(502).json({ error: "Некорректный размер изображения." });
    }

    res.set({
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff"
    });
    return res.status(200).send(bytes);
  } catch (error) {
    console.error("Image proxy error:", error);
    return res.status(502).json({ error: "Не удалось загрузить фотографию." });
  }
});

const adminSessions = new Map();

const adminIds = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const ORDER_STATUSES = {
  new: "🆕 Новый",
  confirmed: "🟡 Подтверждён",
  shipped: "📦 Отправлен",
  completed: "✅ Завершён",
  cancelled: "❌ Отменён"
};

const DELIVERY_METHODS = {
  pickup: "Самовывоз",
  cdek: "СДЭК",
  post: "Почта России",
  yandex: "Яндекс Доставка"
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAdmin(ctx) {
  return Boolean(ctx.from && adminIds.has(String(ctx.from.id)));
}

function money(value) {
  return new Intl.NumberFormat("ru-RU").format(value) + " ₽";
}

function statusKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        {
          text: "🆕 Новый",
          callback_data: `ord:${orderId}:new`
        },
        {
          text: "🟡 Подтверждён",
          callback_data: `ord:${orderId}:confirmed`
        }
      ],
      [
        {
          text: "📦 Отправлен",
          callback_data: `ord:${orderId}:shipped`
        },
        {
          text: "✅ Завершён",
          callback_data: `ord:${orderId}:completed`
        }
      ],
      [
        {
          text: "❌ Отменён",
          callback_data: `ord:${orderId}:cancelled`
        }
      ]
    ]
  };
}

function formatOrderMessage(order, items) {
  const itemLines = items.map((item) =>
    `• ${item.product_name} / ${item.selected_color} / ${item.selected_size} × ${item.quantity} — ${money(item.unit_price * item.quantity)}`
  );

  const contactLabel =
    order.contact_method === "telegram" ? "Telegram" : "Телефон";
const deliveryLabel =
  DELIVERY_METHODS[order.delivery_method] || "Не указан";
  return [
    "🛍 НОВЫЙ ЗАКАЗ — GOLD SHOP",
    "",
    `Заказ: ${order.id}`,
    "",
    ...itemLines,
    "",
    `Итого: ${money(order.total)}`,
    "",
    `Имя: ${order.customer_name}`,
    `Телефон: ${order.phone}`,
`Email: ${order.email || "—"}`,
    `Город: ${order.city}`,
    `Адрес: ${order.delivery_address}`,
    `Способ доставки: ${deliveryLabel}`,
    `Комментарий: ${order.comment || "—"}`,
    "",
    `Статус: ${ORDER_STATUSES[order.status]}`
  ].join("\n");
}

// Telegram shop entry point

const WEB_APP_URL = (
  process.env.WEB_APP_URL ||
  "https://gold-shop-rnph.onrender.com"
).replace(/\/+$/, "");

const shopKeyboard = {
  inline_keyboard: [
    [{ text: "✦ ОТКРЫТЬ КАТАЛОГ", web_app: { url: WEB_APP_URL } }],
    [{ text: "TELEGRAM-КАНАЛ GOLD SHOP", url: "https://t.me/go1d_sh0p" }],
    [{ text: "❔ ПОМОЩЬ И ИНФОРМАЦИЯ", callback_data: "shop:help" }]
  ]
};

const welcomeText = [
  "<b>G O L D  S H O P</b>",
  "<i>PREMIUM STREETWEAR</i>",
  "",
  "Добро пожаловать в официальный магазин GOLD SHOP.",
  "",
  "Здесь ты можешь:",
  "✦ посмотреть каталог и фотографии",
  "✦ выбрать размер и добавить товар в корзину",
  "✦ оформить заказ и следить за его статусом",
  "",
  "Нажми кнопку ниже, чтобы перейти в магазин."
].join("\n");

const helpText = [
  "<b>ПОМОЩЬ GOLD SHOP</b>",
  "",
  "✦ <b>Каталог</b> — открой магазин кнопкой «Открыть каталог».",
  "✦ <b>Заказ</b> — выбери товар, размер и оформи заявку через корзину.",
  "✦ <b>Оплата</b> — онлайн-оплата пока не подключена. Менеджер отдельно подтвердит наличие, доставку и итоговую сумму до оплаты.",
  "✦ <b>Доставка</b> — доступные варианты отображаются при оформлении. Стоимость и детали подтверждаются отдельно.",
  "✦ <b>Статус заказа</b> — проверь его на сайте или командой /track НОМЕР_ЗАКАЗА ТЕЛЕФОН.",
  "",
  "Новости и обновления магазина публикуются в нашем Telegram-канале."
].join("\n");

bot.command("start", async (ctx) => {
  await ctx.reply(welcomeText, {
    parse_mode: "HTML",
    reply_markup: shopKeyboard
  });
});

bot.command("shop", async (ctx) => {
  await ctx.reply("<b>GOLD SHOP</b> — каталог актуальных товаров:", {
    parse_mode: "HTML",
    reply_markup: shopKeyboard
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(helpText, {
    parse_mode: "HTML",
    reply_markup: shopKeyboard
  });
});

bot.command("delivery", async (ctx) => {
  await ctx.reply(
    "<b>ДОСТАВКА И ОПЛАТА</b>\n\nДоступные способы доставки отображаются при оформлении заказа. Стоимость и сроки менеджер подтвердит отдельно.\n\nОнлайн-оплата пока не подключена. Не переводи деньги до подтверждения заказа и итоговой суммы менеджером.",
    { parse_mode: "HTML", reply_markup: shopKeyboard }
  );
});

bot.command("track", async (ctx) => {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Для безопасности проверь заказ в личном чате с ботом.");
    return;
  }

  const [orderId, ...contactParts] = String(ctx.match || "").trim().split(/\s+/);
  const contact = contactParts.join("").trim();
  if (!UUID_PATTERN.test(orderId || "") || contact.length < 5 || contact.length > 100) {
    await ctx.reply("Формат команды:\n/track НОМЕР_ЗАКАЗА ТЕЛЕФОН_ИЛИ_TELEGRAM\n\nИспользуй номер и контакт, которые указал при оформлении.");
    return;
  }

  try {
    const { data: order, error } = await supabase.from("orders")
      .select("id, phone, contact_method, status, tracking_number, tracking_url, created_at")
      .eq("id", orderId).maybeSingle();
    if (error) throw error;

    const normalize = value => String(value || "").trim().replace(/^@/, "").toLowerCase();
    const supplied = order?.contact_method === "phone"
      ? contact.replace(/\D/g, "")
      : normalize(contact);
    const stored = order?.contact_method === "phone"
      ? String(order?.phone || "").replace(/\D/g, "")
      : normalize(order?.phone);

    if (!order || !supplied || supplied !== stored) {
      await ctx.reply("Заказ не найден. Проверь номер и контакт.");
      return;
    }

    const labels = { new: "Принят", confirmed: "Подтверждён", shipped: "Отправлен", completed: "Завершён", cancelled: "Отменён" };
    const lines = [
      "GOLD SHOP · СТАТУС ЗАКАЗА",
      "",
      "Заказ: " + order.id,
      "Статус: " + (labels[order.status] || order.status),
      order.tracking_number ? "Трек-номер: " + order.tracking_number : "Трек-номер пока не добавлен."
    ];
    if (order.tracking_url) lines.push("Отслеживание: " + order.tracking_url);
    await ctx.reply(lines.join("\n"), { link_preview_options: { is_disabled: true } });
  } catch (error) {
    console.error("Telegram order tracking error:", error);
    await ctx.reply("Не удалось проверить заказ. Попробуй позже.");
  }
});

bot.command("channel", async (ctx) => {
  await ctx.reply("Подписывайся на канал GOLD SHOP — там публикуются новости и обновления магазина.", {
    reply_markup: {
      inline_keyboard: [[{ text: "ОТКРЫТЬ GOLD SHOP", url: "https://t.me/go1d_sh0p" }]]
    }
  });
});

bot.callbackQuery("shop:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(helpText, {
    parse_mode: "HTML",
    reply_markup: shopKeyboard
  });
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("У тебя нет доступа к панели администратора.");
    return;
  }

  await ctx.reply(
    "Панель администратора GOLD SHOP\n\nОткрой управление товарами:",
    {
      reply_markup: {
        inline_keyboard: [[{
          text: "Открыть админ-панель",
          web_app: { url: `${WEB_APP_URL}/admin.html` }
        }], [{
          text: "Последние заказы",
          callback_data: "admin:orders"
        }]]
      }
    }
  );
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("У тебя нет доступа.");
    return;
  }

  try {
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, customer_name, phone, email, contact_method, delivery_method, city, delivery_address, total, status, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!data || !data.length) {
      await ctx.reply("Заказов пока нет.");
      return;
    }

    for (const order of data) {
      const contactLabel =
        order.contact_method === "telegram" ? "Telegram" : "Телефон";
const deliveryLabel =
  DELIVERY_METHODS[order.delivery_method] || "Не указан";
      const message = [
        `Заказ ${order.id}`,
        `Имя: ${order.customer_name}`,
        `Телефон: ${order.phone}`,
`Email: ${order.email || "—"}`,
        `Город: ${order.city}`,
        `Адрес: ${order.delivery_address}`,
        `Способ доставки: ${deliveryLabel}`,
        `Сумма: ${money(Number(order.total))}`,
        `Статус: ${ORDER_STATUSES[order.status] || order.status}`
      ].join("\n");

      await ctx.reply(message, {
        reply_markup: statusKeyboard(order.id)
      });
    }
  } catch (error) {
    console.error("Orders command error:", error);
    await ctx.reply("Не удалось загрузить заказы.");
  }
});

// Admin status buttons

bot.callbackQuery(/^ord:/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({
      text: "У тебя нет доступа.",
      show_alert: true
    });
    return;
  }

  const [, orderId, status] = ctx.callbackQuery.data.split(":");

  if (!UUID_PATTERN.test(orderId) || !ORDER_STATUSES[status]) {
    await ctx.answerCallbackQuery({
      text: "Некорректные данные заказа.",
      show_alert: true
    });
    return;
  }

  try {
    const { data, error } = await supabase.rpc("change_order_status_and_restore_inventory", {
      p_order_id: orderId,
      p_new_status: status,
      p_actor_telegram_id: ctx.from.id
    });

    if (error) throw error;

    if (!data || !data.order_id) {
      await ctx.answerCallbackQuery({
        text: "Заказ не найден.",
        show_alert: true
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: `Статус изменён: ${ORDER_STATUSES[status]}`
    });
  } catch (error) {
    console.error("Order status update error:", error);
    await ctx.answerCallbackQuery({
      text: "Не удалось изменить статус.",
      show_alert: true
    });
  }
});

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

// API routes

app.get("/", (_req, res) => {
  res.type("text").send("GOLD SHOP API");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gold-shop-backend"
  });
});

// Telegram Mini App admin authentication

function verifyTelegramInitData(initData) {
  if (typeof initData !== "string" || !initData || !process.env.BOT_TOKEN) {
    console.warn("Mini App auth rejected: missing initData or bot token.");
    return null;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!receivedHash || !Number.isFinite(authDate)) {
    console.warn("Mini App auth rejected: missing hash or invalid auth_date.");
    return null;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (authDate > nowSeconds + 30 || nowSeconds - authDate > 5 * 60) {
    console.warn("Mini App auth rejected: initData expired.");
    return null;
  }

  params.delete("hash");
  params.sort();

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();

  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!safeEqual(receivedHash, expectedHash)) {
    console.warn("Mini App auth rejected: Telegram initData hash mismatch.");
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id || !adminIds.has(String(user.id))) {
      console.warn("Mini App auth rejected: Telegram user is not in ADMIN_IDS.");
      return null;
    }
    return user;
  } catch {
    console.warn("Mini App auth rejected: invalid Telegram user payload.");
    return null;
  }
}

app.post("/api/admin/session", rateLimit({ windowMs: 60_000, max: 10, scope: "admin-session" }), (req, res) => {
  const user = verifyTelegramInitData(req.get("X-Telegram-Init-Data"));
  if (!user) {
    return res.status(401).json({ error: "Сессия Telegram устарела. Закрой и заново открой админ-панель через бота." });
  }

  const token = randomUUID() + randomUUID();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  adminSessions.set(token, { user, expiresAt });

  if (adminSessions.size > 1000) {
    const now = Date.now();
    for (const [key, session] of adminSessions) {
      if (session.expiresAt <= now) adminSessions.delete(key);
    }
  }

  res.set("Cache-Control", "no-store, private");
  res.set("Pragma", "no-cache");
  return res.json({ token, expires_at: new Date(expiresAt).toISOString() });
});

function requireMiniAppAdmin(req, res, next) {
  const token = req.get("X-GOLD-Admin-Session");
  const session = typeof token === "string" ? adminSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now() || !adminIds.has(String(session.user?.id))) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: "Сессия администратора истекла. Закрой и заново открой админ-панель через бота." });
  }
  res.set("Cache-Control", "no-store, private");
  res.set("Pragma", "no-cache");
  req.telegramAdmin = session.user;
  next();
}

app.post("/api/address/suggest", rateLimit({ windowMs: 60_000, max: 20, scope: "address-suggest" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  const token = process.env.DADATA_API_TOKEN;
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (query.length < 3 || query.length > 120) {
    return res.status(400).json({ error: "Введи не менее 3 символов адреса." });
  }
  if (!token) {
    return res.status(503).json({ error: "Подсказки адреса пока не подключены. Введи адрес вручную." });
  }
  try {
    const upstream = await fetch("https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": "Token " + token
      },
      body: JSON.stringify({ query, count: 8 }),
      signal: AbortSignal.timeout(5000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("DaData upstream error:", upstream.status);
      return res.status(502).json({ error: "Подсказки адреса временно недоступны. Введи адрес вручную." });
    }
    res.set("Cache-Control", "no-store");
    res.json({ suggestions: (Array.isArray(payload.suggestions) ? payload.suggestions : [])
      .slice(0, 8).map(item => ({ value: String(item.value || "") })).filter(item => item.value) });
  } catch (error) {
    console.error("Address suggestion proxy error:", error);
    res.status(502).json({ error: "Не удалось получить подсказки адреса. Введи адрес вручную." });
  }
});

// Admin product management API

app.get("/api/admin/products", requireMiniAppAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, price, old_price, category, description, images, sizes, variants, is_active, sort_order")
      .order("sort_order", { ascending: true });
    if (error) throw error;
    res.json({ products: data || [] });
  } catch (error) {
    console.error("Admin products API error:", error);
    res.status(500).json({ error: "Не удалось загрузить товары." });
  }
});

app.post("/api/admin/products", requireMiniAppAdmin, async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const description = typeof body.description === "string" ? body.description : "";
  const price = Number(body.price);
  const oldPrice = body.old_price === "" || body.old_price === undefined ? null : body.old_price;
  const images = Array.isArray(body.images) ? body.images : [];
  const variants = Array.isArray(body.variants) ? body.variants : [];

  if (name.length < 2 || name.length > 120 || !category || category.length > 40 ||
      !Number.isFinite(price) || price < 0 || price > 100000000 ||
      description.length > 3000 || images.length < 1 || images.length > 20 ||
      images.some(url => typeof url !== "string" || url.length > 1000 || !/^https:\/\//i.test(url)) ||
      !Array.isArray(body.variants) || variants.length < 1 || variants.length > 30) {
    return res.status(400).json({ error: "Проверь название, категорию, цену, описание и фотографии товара." });
  }
  if (oldPrice !== null && (!Number.isFinite(Number(oldPrice)) || Number(oldPrice) < 0 || Number(oldPrice) > 100000000)) {
    return res.status(400).json({ error: "Некорректная старая цена." });
  }

  const seenColors = new Set();
  const allSizes = new Set();
  for (const variant of variants) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant) ||
        typeof variant.color !== "string" || !variant.color.trim() || variant.color.trim().length > 40 ||
        !variant.sizes || typeof variant.sizes !== "object" || Array.isArray(variant.sizes) ||
        !Object.keys(variant.sizes).length || Object.keys(variant.sizes).length > 30) {
      return res.status(400).json({ error: "Проверь цвета и размеры товара." });
    }
    const colorKey = variant.color.trim().toLocaleLowerCase("ru");
    if (seenColors.has(colorKey)) return res.status(400).json({ error: "Цвета товара не должны повторяться." });
    seenColors.add(colorKey);
    for (const [size, quantity] of Object.entries(variant.sizes)) {
      if (!size.trim() || size.length > 30 || !Number.isInteger(quantity) || quantity < 0 || quantity > 9999) {
        return res.status(400).json({ error: "Остаток каждого размера должен быть целым числом от 0 до 9999." });
      }
      allSizes.add(size);
    }
    if (variant.images !== undefined &&
        (!Array.isArray(variant.images) || variant.images.length > 20 ||
         variant.images.some(url => typeof url !== "string" || url.length > 1000 || !/^https:\/\//i.test(url)))) {
      return res.status(400).json({ error: "Фотографии вариантов должны быть HTTPS-ссылками." });
    }
  }

  try {
    const { data: lastProduct, error: lastError } = await supabase.from("products")
      .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    if (lastError) throw lastError;
    const { data, error } = await supabase.from("products").insert({
      slug: "product-" + randomUUID(),
      name, category, description, price,
      old_price: oldPrice === null ? null : Number(oldPrice),
      images, variants, sizes: [...allSizes],
      is_active: body.is_active !== false,
      sort_order: Number(lastProduct?.sort_order || 0) + 1
    }).select("id, name, price, old_price, category, description, images, sizes, variants, is_active, sort_order").single();
    if (error) throw error;
    res.status(201).json({ ok: true, product: data });
  } catch (error) {
    console.error("Admin product creation error:", error);
    res.status(500).json({ error: "Не удалось создать товар. Проверь данные и попробуй ещё раз." });
  }
});

app.patch("/api/admin/products/:id", requireMiniAppAdmin, async (req, res) => {
  const productId = String(req.params.id || "");
  if (!UUID_PATTERN.test(productId)) {
    return res.status(400).json({ error: "Некорректный товар." });
  }

  const body = req.body || {};
  const allowed = ["name", "price", "old_price", "category", "description", "images", "variants", "sizes", "is_active", "sort_order"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({ error: "Нет изменений для сохранения." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "name") &&
      (typeof update.name !== "string" || update.name.trim().length < 2 || update.name.length > 120)) {
    return res.status(400).json({ error: "Проверь название товара." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "price") &&
      (!Number.isFinite(Number(update.price)) || Number(update.price) < 0)) {
    return res.status(400).json({ error: "Некорректная цена." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "old_price") &&
      update.old_price !== null &&
      (!Number.isFinite(Number(update.old_price)) || Number(update.old_price) < 0)) {
    return res.status(400).json({ error: "Некорректная старая цена." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "images") &&
      (!Array.isArray(update.images) || update.images.some(url => typeof url !== "string" || !url.toLowerCase().startsWith("https://")))) {
    return res.status(400).json({ error: "Фотографии должны быть HTTPS-ссылками." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "variants")) {
    if (!Array.isArray(update.variants)) {
      return res.status(400).json({ error: "Некорректные варианты товара." });
    }
    const seenColors = new Set();
    for (const variant of update.variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant) ||
          typeof variant.color !== "string" || !variant.color.trim() ||
          variant.color.trim().length > 40 ||
          !variant.sizes || typeof variant.sizes !== "object" ||
          Array.isArray(variant.sizes) || !Object.keys(variant.sizes).length) {
        return res.status(400).json({ error: "Проверь цвет и размеры товара." });
      }
      const colorKey = variant.color.trim().toLocaleLowerCase("ru");
      if (seenColors.has(colorKey)) {
        return res.status(400).json({ error: "Цвета товара не должны повторяться." });
      }
      seenColors.add(colorKey);
      for (const [size, quantity] of Object.entries(variant.sizes)) {
        if (!size.trim() || size.length > 30 ||
            !Number.isInteger(quantity) || quantity < 0 || quantity > 9999) {
          return res.status(400).json({ error: "Остаток каждого размера должен быть целым числом от 0 до 9999." });
        }
      }
      if (variant.images !== undefined &&
          (!Array.isArray(variant.images) ||
           variant.images.some(url => typeof url !== "string" || !url.toLowerCase().startsWith("https://")))) {
        return res.status(400).json({ error: "Фотографии вариантов должны быть HTTPS-ссылками." });
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(update, "description") &&
      (typeof update.description !== "string" || update.description.length > 3000)) {
    return res.status(400).json({ error: "Описание слишком длинное или имеет неверный формат." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "category") &&
      (typeof update.category !== "string" || update.category.length > 40)) {
    return res.status(400).json({ error: "Некорректная категория товара." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "sort_order")) {
    if (!Number.isInteger(Number(update.sort_order))) {
      return res.status(400).json({ error: "Некорректный порядок товара." });
    }
    update.sort_order = Number(update.sort_order);
  }
  if (Object.prototype.hasOwnProperty.call(update, "is_active") &&
      typeof update.is_active !== "boolean") {
    return res.status(400).json({ error: "Некорректный статус товара." });
  }

  if (typeof update.name === "string") update.name = update.name.trim();
  if (Object.prototype.hasOwnProperty.call(update, "price")) update.price = Number(update.price);
  if (Object.prototype.hasOwnProperty.call(update, "old_price") && update.old_price !== null) update.old_price = Number(update.old_price);

  try {
    const { data, error } = await supabase
      .from("products")
      .update(update)
      .eq("id", productId)
      .select("id, name, price, old_price, category, description, images, sizes, variants, is_active")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Товар не найден." });
    res.json({ ok: true, product: data });
  } catch (error) {
    console.error("Admin product update error:", error);
    res.status(500).json({ error: "Не удалось сохранить товар." });
  }
});


// Admin orders API
app.get("/api/admin/orders", requireMiniAppAdmin, async (_req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, customer_name, phone, email, contact_method, delivery_method, city, delivery_address, comment, total, status, tracking_number, tracking_url, public_order_consent, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    const ids = (orders || []).map(order => order.id);
    let items = [];
    if (ids.length) {
      const { data, error: itemsError } = await supabase
        .from("order_items")
        .select("order_id, product_name, selected_color, selected_size, quantity, unit_price")
        .in("order_id", ids);
      if (itemsError) throw itemsError;
      items = data || [];
    }
    const itemsByOrder = new Map();
    for (const item of items) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
      itemsByOrder.get(item.order_id).push(item);
    }
    res.json({ orders: (orders || []).map(order => ({ ...order, items: itemsByOrder.get(order.id) || [] })) });
  } catch (error) {
    console.error("Admin orders API error:", error);
    res.status(500).json({ error: "Не удалось загрузить заказы." });
  }
});

app.patch("/api/admin/orders/:id", requireMiniAppAdmin, async (req, res) => {
  const orderId = String(req.params.id || "");
  const status = String(req.body?.status || "");
  if (!UUID_PATTERN.test(orderId) || !Object.prototype.hasOwnProperty.call(ORDER_STATUSES, status)) {
    return res.status(400).json({ error: "Некорректный заказ или статус." });
  }
  try {
    const { data, error } = await supabase.rpc("change_order_status_and_restore_inventory", {
      p_order_id: orderId,
      p_new_status: status,
      p_actor_telegram_id: req.telegramAdmin.id
    });
    if (error) {
      if (String(error.message || "").includes("Order not found")) {
        return res.status(404).json({ error: "Заказ не найден." });
      }
      if (String(error.message || "").includes("Cancelled orders cannot be reopened")) {
        return res.status(409).json({ error: "Отменённый заказ нельзя автоматически открыть повторно." });
      }
      throw error;
    }
    if (!data || !data.order_id) return res.status(404).json({ error: "Заказ не найден." });
    res.json({ ok: true, order: { id: data.order_id, status: data.status, unchanged: Boolean(data.unchanged) } });
  } catch (error) {
    console.error("Admin order status API error:", error);
    res.status(500).json({ error: "Не удалось изменить статус заказа." });
  }
});

// Admin analytics API
app.get("/api/admin/analytics", requireMiniAppAdmin, async (req, res) => {
  const requestedDays = Number(req.query.days || 30);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  try {
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const { data: allOrders, error: ordersError } = await supabase
      .from("orders")
      .select("id, created_at, total, status")
      .gte("created_at", from.toISOString())
      .order("created_at", { ascending: true })
      .limit(2000);
    if (ordersError) throw ordersError;

    const orders = allOrders || [];
    const activeOrders = orders.filter(order => order.status !== "cancelled");
    const orderValue = activeOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const averageOrder = activeOrders.length ? orderValue / activeOrders.length : 0;
    const statusCounts = { new: 0, confirmed: 0, shipped: 0, completed: 0, cancelled: 0 };
    for (const order of orders) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, order.status)) statusCounts[order.status]++;
    }

    const dailyMap = new Map();
    for (let offset = days - 1; offset >= 0; offset--) {
      const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
      const key = date.toISOString().slice(0, 10);
      dailyMap.set(key, { date: key, orders: 0, amount: 0 });
    }
    for (const order of activeOrders) {
      const key = new Date(order.created_at).toISOString().slice(0, 10);
      const bucket = dailyMap.get(key);
      if (bucket) {
        bucket.orders++;
        bucket.amount += Number(order.total || 0);
      }
    }

    const orderIds = activeOrders.map(order => order.id);
    let topProducts = [];
    if (orderIds.length) {
      const { data: items, error: itemsError } = await supabase
        .from("order_items")
        .select("order_id, product_name, quantity, unit_price")
        .in("order_id", orderIds)
        .limit(10000);
      if (itemsError) throw itemsError;
      const productMap = new Map();
      for (const item of items || []) {
        const name = item.product_name || "Товар";
        const current = productMap.get(name) || { name, quantity: 0, amount: 0 };
        current.quantity += Number(item.quantity || 0);
        current.amount += Number(item.quantity || 0) * Number(item.unit_price || 0);
        productMap.set(name, current);
      }
      topProducts = [...productMap.values()]
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5);
    }

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("variants, is_active")
      .eq("is_active", true);
    if (productsError) throw productsError;
    let stockUnits = 0;
    let lowStockProducts = 0;
    let outOfStockProducts = 0;
    for (const product of products || []) {
      const count = (Array.isArray(product.variants) ? product.variants : [])
        .reduce((sum, variant) => sum + Object.values(variant.sizes || {})
          .reduce((subtotal, quantity) => subtotal + Math.max(0, Number(quantity) || 0), 0), 0);
      stockUnits += count;
      if (count === 0) outOfStockProducts++;
      else if (count <= 2) lowStockProducts++;
    }

    res.json({
      days,
      ordersCount: orders.length,
      activeOrdersCount: activeOrders.length,
      orderValue,
      averageOrder,
      statuses: statusCounts,
      daily: [...dailyMap.values()],
      topProducts,
      inventory: { stockUnits, lowStockProducts, outOfStockProducts }
    });
  } catch (error) {
    console.error("Admin analytics API error:", error);
    res.status(500).json({ error: "Не удалось загрузить статистику." });
  }
});

// Products API

app.get("/api/products", rateLimit({ windowMs: 60_000, max: 120, scope: "products" }), async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select(
        "id, name, slug, description, price, old_price, category, images, sizes, variants"
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.json({
      products: data || []
    });
  } catch (error) {
    console.error("Products API error:", error);

    res.status(500).json({
      error: "Не удалось загрузить товары."
    });
  }
});

// Public trust, shipment history and order tracking
app.get("/api/public/shipments", rateLimit({ windowMs: 60_000, max: 30, scope: "public-shipments" }), async (_req, res) => {
  try {
    const { data: orders, error } = await supabase.from("orders")
      .select("id, city, delivery_method, status, tracking_number, tracking_url, created_at")
      .eq("public_order_consent", true).in("status", ["shipped", "completed"])
      .not("tracking_number", "is", null).order("created_at", { ascending: false }).limit(30);
    if (error) throw error;
    const ids = (orders || []).map(o => o.id);
    let items = [];
    if (ids.length) {
      const { data, error: itemsError } = await supabase.from("order_items")
        .select("order_id, product_name").in("order_id", ids);
      if (itemsError) throw itemsError;
      items = data || [];
    }
    const byOrder = new Map();
    for (const item of items) {
      if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
      byOrder.get(item.order_id).push(item.product_name);
    }
    res.set("Cache-Control", "public, max-age=60");
    res.json({ shipments: (orders || []).map(o => ({
      code: String(o.id).slice(0, 8).toUpperCase(), city: o.city,
      delivery_method: o.delivery_method, status: o.status,
      
      created_at: o.created_at, items: byOrder.get(o.id) || []
    })) });
  } catch (error) {
    console.error("Public shipments API error:", error);
    res.status(503).json({ error: "История отправок временно недоступна." });
  }
});

app.get("/api/public/reviews", rateLimit({ windowMs: 60_000, max: 30, scope: "public-reviews" }), async (_req, res) => {
  try {
    const { data, error } = await supabase.from("customer_reviews")
      .select("id, display_name, review_text, photo_urls, created_at")
      .eq("is_published", true).eq("publication_consent", true)
      .order("created_at", { ascending: false }).limit(30);
    if (error) throw error;
    res.set("Cache-Control", "public, max-age=60");
    res.json({ reviews: data || [] });
  } catch (error) {
    console.error("Public reviews API error:", error);
    res.status(503).json({ error: "Отзывы временно недоступны." });
  }
});

app.get("/api/orders/:id", rateLimit({ windowMs: 10 * 60_000, max: 15, scope: "order-lookup" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  const orderId = String(req.params.id || "");
  const contact = String(req.query.contact || "").trim();
  if (!UUID_PATTERN.test(orderId) || contact.length < 5 || contact.length > 100) {
    return res.status(400).json({ error: "Укажи номер заказа и контакт, который использовался при оформлении." });
  }
  try {
    const { data: order, error } = await supabase.from("orders")
      .select("id, customer_name, phone, contact_method, delivery_method, city, status, total, tracking_number, tracking_url, created_at")
      .eq("id", orderId).maybeSingle();
    if (error) throw error;
    const normalizeContact = value => String(value || "").trim().replace(/^@/, "").toLowerCase();
    const suppliedContact = order?.contact_method === "phone"
      ? contact.replace(/\D/g, "")
      : normalizeContact(contact);
    const storedContact = order?.contact_method === "phone"
      ? String(order.phone || "").replace(/\D/g, "")
      : normalizeContact(order?.phone);
    if (!order || !suppliedContact || suppliedContact !== storedContact) {
      return res.status(404).json({ error: "Заказ не найден. Проверь номер и контакт." });
    }
    const { data: items, error: itemsError } = await supabase.from("order_items")
      .select("product_name, selected_color, selected_size, quantity").eq("order_id", orderId);
    if (itemsError) throw itemsError;
    res.set("Cache-Control", "no-store");
    // The phone is used only to verify ownership; never echo it in the public response.
    const { phone: _verifiedPhone, ...publicOrder } = order;
    res.json({ order: { ...publicOrder, items: items || [] } });
  } catch (error) {
    console.error("Order lookup API error:", error);
    res.status(503).json({ error: "Не удалось проверить заказ. Попробуй позже." });
  }
});

app.patch("/api/admin/orders/:id/tracking", requireMiniAppAdmin, async (req, res) => {
  const orderId = String(req.params.id || "");
  const trackingNumber = String(req.body?.tracking_number || "").trim();
  const trackingUrl = String(req.body?.tracking_url || "").trim();
  if (!UUID_PATTERN.test(orderId) || trackingNumber.length > 100 || trackingUrl.length > 500) {
    return res.status(400).json({ error: "Проверь номер и ссылку отслеживания." });
  }
  if (trackingUrl && !/^https:\/\//i.test(trackingUrl)) {
    return res.status(400).json({ error: "Ссылка отслеживания должна начинаться с https://." });
  }
  try {
    const { data, error } = await supabase.from("orders")
      .update({ tracking_number: trackingNumber || null, tracking_url: trackingUrl || null })
      .eq("id", orderId).select("id, tracking_number, tracking_url").maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Заказ не найден." });
    res.json({ ok: true, tracking: data });
  } catch (error) {
    console.error("Save tracking error:", error);
    res.status(500).json({ error: "Не удалось сохранить трек-номер." });
  }
});

app.post("/api/admin/reviews", rateLimit({ windowMs: 60_000, max: 10, scope: "admin-reviews" }), requireMiniAppAdmin, async (req, res) => {
  const orderId = String(req.body?.order_id || "");
  const displayName = String(req.body?.display_name || "").trim();
  const reviewText = String(req.body?.review_text || "").trim();
  const photoUrls = Array.isArray(req.body?.photo_urls) ? req.body.photo_urls : [];
  const consent = req.body?.publication_consent === true;
  if (!UUID_PATTERN.test(orderId) || displayName.length < 2 || displayName.length > 60 ||
      reviewText.length < 10 || reviewText.length > 1200 || photoUrls.length > 5 ||
      photoUrls.some(u => typeof u !== "string" || !/^https:\/\//i.test(u) || u.length > 1000) || !consent) {
    return res.status(400).json({ error: "Проверь отзыв, HTTPS-ссылки на фото и согласие покупателя." });
  }
  try {
    const { data: order, error: orderError } = await supabase.from("orders")
      .select("id, status").eq("id", orderId).maybeSingle();
    if (orderError) throw orderError;
    if (!order || order.status !== "completed") {
      return res.status(409).json({ error: "Отзыв можно подтвердить только по завершённому заказу." });
    }
    const { data: existingReview, error: existingReviewError } = await supabase
      .from("customer_reviews").select("id").eq("order_id", orderId).maybeSingle();
    if (existingReviewError) throw existingReviewError;
    if (existingReview) return res.status(409).json({ error: "Для этого заказа отзыв уже опубликован." });
    const { data, error } = await supabase.from("customer_reviews").insert({
      order_id: orderId, display_name: displayName, review_text: reviewText,
      photo_urls: photoUrls, publication_consent: true, is_published: true
    }).select("id").single();
    if (error) throw error;
    res.status(201).json({ ok: true, review_id: data.id });
  } catch (error) {
    console.error("Publish review error:", error);
    res.status(500).json({ error: "Не удалось опубликовать отзыв." });
  }
});

// Create order API

app.post("/api/orders", rateLimit({ windowMs: 10 * 60_000, max: 10, scope: "create-order" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  let createdOrderId = null;

  try {
    const body = req.body || {};

    const customerName = String(body.customer_name || "").trim();
const contactMethod = String(body.contact_method || "").trim();
const deliveryMethod = String(body.delivery_method || "").trim();
const contact = String(body.contact || "").trim();
const email = String(body.email || "").trim().toLowerCase();
const city = String(body.city || "").trim();
const deliveryAddress = String(body.delivery_address || "").trim();
const comment = String(body.comment || "").trim();
const requestedItems = body.items;

    if (customerName.length < 2 || customerName.length > 80) {
      return res.status(400).json({
        error: "Проверь имя. Нужно от 2 до 80 символов."
      });
    }

    if (!["telegram", "phone"].includes(contactMethod)) {
      return res.status(400).json({
        error: "Выбери корректный способ связи."
      });
    }
if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  return res.status(400).json({ error: "Укажи корректную электронную почту." });
}
if (!Object.prototype.hasOwnProperty.call(DELIVERY_METHODS, deliveryMethod)) {
  return res.status(400).json({
    error: "Выбери корректный способ доставки."
  });
}

if (contactMethod === "telegram") {
      const username = contact.replace(/^@/, "");

      if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) {
        return res.status(400).json({
          error: "Проверь Telegram username."
        });
      }
    } else {
      const digits = contact.replace(/\D/g, "");

      if (digits.length < 10 || digits.length > 15) {
        return res.status(400).json({
          error: "Проверь номер телефона."
        });
      }
    }

    if (city.length < 2 || city.length > 100) {
      return res.status(400).json({
        error: "Укажи корректный город."
      });
    }

    if (deliveryAddress.length < 3 || deliveryAddress.length > 500) {
      return res.status(400).json({
        error: "Укажи адрес доставки или пункт выдачи."
      });
    }

    if (comment.length > 500) {
      return res.status(400).json({
        error: "Комментарий слишком длинный."
      });
    }

    if (
      !Array.isArray(requestedItems) ||
      requestedItems.length < 1 ||
      requestedItems.length > 20
    ) {
      return res.status(400).json({
        error: "Корзина пуста или содержит слишком много позиций."
      });
    }

    const normalizedItems = [];

    for (const item of requestedItems) {
      const productId = String(item?.id || "").trim();
      const color = String(item?.color || "").trim();
      const size = String(item?.size || "").trim();
      const quantity = Number(item?.qty);

      if (
        !UUID_PATTERN.test(productId) ||
        !color || color.length > 40 ||
        !size ||
        size.length > 30 ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        return res.status(400).json({
          error: "В корзине обнаружены некорректные товары."
        });
      }

      normalizedItems.push({
        product_id: productId,
        selected_color: color,
        selected_size: size,
        quantity
      });
    }

    const productIds = [
      ...new Set(normalizedItems.map((item) => item.product_id))
    ];

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, name, price, variants, is_active")
      .in("id", productIds);

    if (productsError) throw productsError;

    const productById = new Map(
      (products || []).map((product) => [product.id, product])
    );

    const orderItems = [];
    let total = 0;
    for (const item of normalizedItems) {
      const product = productById.get(item.product_id);
      if (!product || !product.is_active) return res.status(400).json({error:"Один из товаров больше недоступен."});
      const variant = (Array.isArray(product.variants)?product.variants:[]).find(v=>String(v.color||"").trim()===item.selected_color);
      const available = Number(variant?.sizes?.[item.selected_size] || 0);
      if (!variant || !Number.isInteger(available) || available < item.quantity) return res.status(409).json({error:`Недостаточно остатка: ${product.name}, ${item.selected_color}, размер ${item.selected_size}. Доступно: ${Math.max(0,available)} шт.`});
    }
    for (const item of normalizedItems) {
      const product = productById.get(item.product_id);
      const unitPrice = Number(product.price);

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error(`Invalid price for product ${product.id}`);
      }

      total += unitPrice * item.quantity;

      orderItems.push({
        product_id: product.id,
        product_name: product.name,
        selected_color: item.selected_color,
        selected_size: item.selected_size,
        quantity: item.quantity,
        unit_price: unitPrice
      });
    }

    
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        customer_name: customerName,
        phone: contact,
        email,
        contact_method: contactMethod,
        delivery_method: deliveryMethod,
        city,
        delivery_address: deliveryAddress,
        comment,
        public_order_consent: body.public_order_consent === true,
        status: "new",
        total
      })
      .select("id, customer_name, phone, email, contact_method, delivery_method, city, delivery_address, comment, status, total")
      .single();


    if (orderError) throw orderError;

    createdOrderId = order.id;

    const itemsToInsert = orderItems.map((item) => ({
      ...item,
      order_id: order.id
    }));

    const { error: itemsError } = await supabase
      .from("order_items")
      .insert(itemsToInsert);

    if (itemsError) {
      await supabase.from("orders").delete().eq("id", order.id);
      createdOrderId = null;
      throw itemsError;
    }
    const { error: reserveError } = await supabase.rpc("reserve_product_variants", {
      p_items: normalizedItems.map(item => ({product_id:item.product_id,color:item.selected_color,size:item.selected_size,quantity:item.quantity}))
    });
    if (reserveError) {
      await supabase.from("orders").delete().eq("id", order.id);
      createdOrderId = null;
      if (String(reserveError.message||"").toLowerCase().includes("insufficient")) return res.status(409).json({error:"Остаток изменился во время оформления. Обнови страницу и попробуй снова."});
      throw reserveError;
    }
    const notification = formatOrderMessage(
      { ...order, total: Number(order.total) },
      orderItems
    );

    const notifications = await Promise.allSettled(
      [...adminIds].map((adminId) =>
        bot.api.sendMessage(adminId, notification, {
          reply_markup: statusKeyboard(order.id)
        })
      )
    );

    notifications.forEach((result) => {
      if (result.status === "rejected") {
        console.error("Admin notification failed:", result.reason);
      }
    });

    return res.status(201).json({
      ok: true,
      order_id: order.id,
      total: Number(order.total),
      message: "Заказ успешно оформлен."
    });
  } catch (error) {
    console.error("Create order API error:", error);

    if (createdOrderId) {
      await supabase.from("orders").delete().eq("id", createdOrderId);
    }

    return res.status(500).json({
      error: "Не удалось сохранить заказ. Попробуй ещё раз."
    });
  }
});

// Webhook security

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

// Telegram webhook

app.post("/telegram/webhook", rateLimit({ windowMs: 60_000, max: 120, scope: "telegram-webhook" }), async (req, res) => {
  const expectedSecret = process.env.WEBHOOK_SECRET;
  const receivedSecret = req.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (!expectedSecret || !safeEqual(receivedSecret, expectedSecret)) {
    console.warn("Webhook request rejected: invalid secret.");
    return res.sendStatus(401);
  }

  try {
    console.log("Telegram update received:", req.body?.update_id);

    await bot.handleUpdate(req.body);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook update error:", error);
    return res.sendStatus(500);
  }
});

// Server startup

const port = Number(process.env.PORT) || 10000;

const server = app.listen(port, "0.0.0.0", async () => {
  console.log(`GOLD SHOP backend listening on port ${port}`);

  try {
    await bot.init();

    console.log(
      `Telegram bot initialized: @${bot.botInfo.username}`
    );

    await bot.api.setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "Магазин",
        web_app: { url: WEB_APP_URL }
      }
    });
    await bot.api.setMyCommands([
      { command: "start", description: "Главное меню GOLD SHOP" },
      { command: "shop", description: "Открыть каталог магазина" },
      { command: "help", description: "Помощь и ответы на вопросы" },
      { command: "delivery", description: "Доставка и оплата" },
      { command: "track", description: "Проверить статус заказа" },
      { command: "channel", description: "Наш Telegram-канал" }
    ]);
    console.log("Telegram shop menu button and commands configured.");
  } catch (error) {
    console.error("Failed to initialize Telegram bot:", error);
    return;
  }

  const baseUrl = (
    process.env.WEBHOOK_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
  ).replace(/\/+$/, "");

  if (!baseUrl) {
    console.warn(
      "Webhook URL is not configured; Telegram webhook was not registered."
    );
    return;
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.warn(
      "WEBHOOK_SECRET is missing; Telegram webhook was not registered."
    );
    return;
  }

  try {
    await bot.api.setWebhook(
      `${baseUrl}/telegram/webhook`,
      {
        secret_token: process.env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"]
      }
    );

    console.log("Telegram webhook registered.");
  } catch (error) {
    console.error("Failed to register Telegram webhook:", error);
  }
});

// Graceful shutdown

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
