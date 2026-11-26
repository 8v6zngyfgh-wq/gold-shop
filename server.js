


const express = require("express");
const { Bot } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { timingSafeEqual, createHmac } = require("node:crypto");

const requiredEnv = ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const app = express();
app.disable("x-powered-by");

const allowedOrigins = new Set([
  "https://gold-shop-rnph.onrender.com"
]);

app.use((req, res, next) => {
  const origin = req.get("Origin");
  res.vary("Origin");

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(!origin || allowedOrigins.has(origin) ? 204 : 403);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

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
    `${contactLabel}: ${order.phone}`,
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
  inline_keyboard: [[
    {
      text: "Открыть GOLD SHOP",
      web_app: { url: WEB_APP_URL }
    }
  ]]
};

// Telegram commands

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Добро пожаловать в GOLD SHOP.\n\nОткрой каталог, выбери товар и оформи заказ прямо здесь.",
    { reply_markup: shopKeyboard }
  );
});

bot.command("shop", async (ctx) => {
  await ctx.reply(
    "Каталог GOLD SHOP:",
    { reply_markup: shopKeyboard }
  );
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
        "id, customer_name, phone, contact_method, delivery_method, city, delivery_address, total, status, created_at"
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
        `${contactLabel}: ${order.phone}`,
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
    const { data, error } = await supabase
      .from("orders")
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", orderId)
      .select("id")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
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
    return null;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!receivedHash || !Number.isFinite(authDate)) return null;
  if (Math.abs(Date.now() / 1000 - authDate) > 60 * 60 * 24) return null;

  params.delete("hash");
  params.delete("signature");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();

  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!safeEqual(receivedHash, expectedHash)) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id || !adminIds.has(String(user.id))) return null;
    return user;
  } catch {
    return null;
  }
}

function requireMiniAppAdmin(req, res, next) {
  const user = verifyTelegramInitData(req.get("X-Telegram-Init-Data"));
  if (!user) {
    return res.status(401).json({ error: "Нет доступа. Открой панель из Telegram-бота." });
  }
  req.telegramAdmin = user;
  next();
}

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
      (!Array.isArray(update.images) || update.images.some(url => typeof url !== "string" || !/^https:\\/\\//i.test(url)))) {
    return res.status(400).json({ error: "Фотографии должны быть HTTPS-ссылками." });
  }
  if (Object.prototype.hasOwnProperty.call(update, "variants") &&
      !Array.isArray(update.variants)) {
    return res.status(400).json({ error: "Некорректные варианты товара." });
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

// Products API

app.get("/api/products", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select(
        "id, name, slug, description, price, old_price, category, images, sizes, variants"
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) throw error;

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

// Create order API

app.post("/api/orders", async (req, res) => {
  let createdOrderId = null;

  try {
    const body = req.body || {};

    const customerName = String(body.customer_name || "").trim();
const contactMethod = String(body.contact_method || "").trim();
const deliveryMethod = String(body.delivery_method || "").trim();
const contact = String(body.contact || "").trim();
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
        contact_method: contactMethod,
        delivery_method: deliveryMethod,
        city,
        delivery_address: deliveryAddress,
        comment,
        status: "new",
        total
      })
      .select("id, customer_name, phone, contact_method, delivery_method, city, delivery_address, comment, status, total")
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

app.post("/telegram/webhook", async (req, res) => {
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
    console.log("Telegram shop menu button configured.");
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
