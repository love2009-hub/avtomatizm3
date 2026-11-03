// Vercel Serverless Function: POST /api/send-telegram
// Secrets are configured in Vercel Project Settings -> Environment Variables.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_BODY_BYTES = 12 * 1024;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;

// Best-effort in-memory rate limit. Serverless instances may have separate counters.
const requestLog = new Map();

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "unknown";
  return ip.slice(0, 100);
}

function isRateLimited(key) {
  const now = Date.now();
  const entry = requestLog.get(key);
  if (!entry || now - entry.start >= WINDOW_MS) {
    requestLog.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

function clean(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, message: "Метод не поддерживается." });
  }

  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    return sendJson(res, 415, { success: false, message: "Ожидается JSON-запрос." });
  }

  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return sendJson(res, 413, { success: false, message: "Слишком большой запрос." });
  }

  if (isRateLimited(getClientKey(req))) {
    return sendJson(res, 429, { success: false, message: "Слишком много попыток. Попробуйте через минуту." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {
      return sendJson(res, 400, { success: false, message: "Некорректный формат данных." });
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, { success: false, message: "Некорректные данные формы." });
  }

  // Honeypot: silently accept automated submissions without forwarding them.
  if (clean(body.website, 200)) {
    return sendJson(res, 200, { success: true });
  }

  const name = clean(body.name, 100);
  const contact = clean(body.contact, 200);
  const task = clean(body.task, 3000);

  if (!name || !contact || !task) {
    return sendJson(res, 400, { success: false, message: "Заполните все обязательные поля." });
  }
  if (name.length < 2 || contact.length < 3 || task.length < 5) {
    return sendJson(res, 400, { success: false, message: "Проверьте корректность заполнения полей." });
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    return sendJson(res, 500, { success: false, message: "Сервер ещё не настроен. Попробуйте позже." });
  }

  const message =
    "🔔 НОВАЯ ЗАЯВКА С САЙТА\n\n" +
    "👤 Имя: " + name + "\n" +
    "📬 Контакт: " + contact + "\n" +
    "📝 Задача: " + task;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const telegramResponse = await fetch(
      "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          disable_web_page_preview: true
        }),
        signal: controller.signal
      }
    );

    const telegramResult = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !telegramResult || telegramResult.ok !== true) {
      // Never return Telegram's raw response, bot token, or secrets to the browser.
      return sendJson(res, 502, { success: false, message: "Telegram временно не принял заявку. Попробуйте позже." });
    }

    return sendJson(res, 200, { success: true });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    return sendJson(res, timedOut ? 504 : 502, {
      success: false,
      message: timedOut ? "Истекло время ожидания. Попробуйте ещё раз." : "Не удалось отправить заявку. Попробуйте позже."
    });
  } finally {
    clearTimeout(timeout);
  }
};
