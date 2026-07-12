/*
 * 毎日のスプレッドシート自動書き出し (Vercel Cron から呼ばれる)
 *
 * 必要な環境変数:
 *   APP_TOKEN         ... アプリの同期パスコード
 *   CRON_SECRET       ... Vercel Cronの認証用（APP_TOKENと同じ値でOK）
 *   SHEET_WEBAPP_URL  ... Apps ScriptのウェブアプリURL (https://script.google.com/macros/s/.../exec)
 *   KV_REST_API_URL / KV_REST_API_TOKEN ... Upstash Redis（自動設定）
 *
 * vercel.json の crons で毎日 18:00 UTC (=日本時間 3:00) に実行される。
 * 手動実行も可: GET /api/export に X-App-Token ヘッダを付ける。
 */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    authorize(req);
    if (!REDIS_URL || !REDIS_TOKEN) throw httpError(500, "Upstash Redis is not configured");
    if (!process.env.SHEET_WEBAPP_URL) throw httpError(500, "SHEET_WEBAPP_URL is not configured");

    const babyId = String((req.query && req.query.babyId) || "default");
    const [values, profileRaw] = await redis([
      ["HVALS", `babylog:${babyId}:records`],
      ["GET", `babylog:${babyId}:profile`]
    ]);
    const records = (values || [])
      .map((v) => { try { return JSON.parse(v); } catch (_) { return null; } })
      .filter((r) => r && !r.deleted)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const profile = safeParse(profileRaw);
    const gasRes = await fetch(process.env.SHEET_WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: process.env.APP_TOKEN,
        babyId,
        records,
        profile: profile || undefined,
        appUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
        driveFolderId: (profile && profile.driveFolderId) || ""
      }),
      redirect: "follow"
    });
    const gasData = await gasRes.json().catch(() => ({}));
    if (!gasRes.ok || gasData.error) throw httpError(502, gasData.error || `GAS error ${gasRes.status}`);

    respond(res, 200, { exported: records.length, sheet: gasData });
  } catch (error) {
    respond(res, error.statusCode || 500, { error: error.message || "Server error" });
  }
};

function authorize(req) {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok =
    (process.env.CRON_SECRET && bearer === process.env.CRON_SECRET) ||
    (process.env.APP_TOKEN && bearer === process.env.APP_TOKEN) ||
    (process.env.APP_TOKEN && req.headers["x-app-token"] === process.env.APP_TOKEN);
  if (!ok) throw httpError(401, "Unauthorized");
}

async function redis(commands) {
  const response = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw httpError(502, (data && data.error) || `Redis error ${response.status}`);
  return data.map((item) => {
    if (item.error) throw httpError(502, item.error);
    return item.result;
  });
}

function safeParse(v) { try { return v ? JSON.parse(v) : null; } catch (_) { return null; } }

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function respond(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}
