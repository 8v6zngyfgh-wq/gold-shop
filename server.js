const express = require("express");
const { Bot } = require("grammy");
const { createClient } = require("@supabase/supabase-js");
const { timingSafeEqual } = require("node:crypto");

const requiredEnv = ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const bot = new Bot(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const adminIds = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

function isAdmin(ctx) {
  return Boolean(ctx.from && adminIds.has(String(ctx.from.id)));
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Добро пожаловать в GOLD SHOP! Каталог и оформление заказов скоро будут доступны здесь."
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

  await ctx.reply("Доступ администратора подтверждён. Управление товарами подключим следующим этапом.");
});

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

app.get("/", (_req, res) => {
  res.type("text").send("GOLD SHOP API");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gold-shop-backend" });
});

// Public product feed. The Supabase secret key stays on this server.
app.get("/api/products", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, slug, description, price, old_price, category, images, sizes, stock")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) throw error;
    res.json({ products: data || [] });
  } catch (error) {
    console.error("Products API error:", error);
    res.status(500).json({ error: "Не удалось загрузить товары." });
  }
});

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/telegram/webhook", async (req, res) => {
  const expectedSecret = process.env.WEBHOOK_SECRET;
  const receivedSecret = req.get("X-Telegram-Bot-Api-Secret-Token");

  if (!expectedSecret || !safeEqual(receivedSecret, expectedSecret)) {
    return res.sendStatus(401);
  }

  try {
    await bot.handleUpdate(req.body);
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook update error:", error);
    return res.sendStatus(500);
  }
});

const port = Number(process.env.PORT) || 10000;
const server = app.listen(port, "0.0.0.0", async () => {
  console.log(`GOLD SHOP backend listening on port ${port}`);

  const baseUrl = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "")
    .replace(/\/+$/, "");

  if (!baseUrl) {
    console.warn("Webhook URL is not configured; Telegram webhook was not registered.");
    return;
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.warn("WEBHOOK_SECRET is missing; Telegram webhook was not registered.");
    return;
  }

  try {
    await bot.api.setWebhook(`${baseUrl}/telegram/webhook`, {
      secret_token: process.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"]
    });
    console.log("Telegram webhook registered.");
  } catch (error) {
    console.error("Failed to register Telegram webhook:", error);
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
