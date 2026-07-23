/*
 * 音声・自然文入力API (Gemini)
 *
 * 発話テキスト（「ミルク120飲んだ」「30分前にうんち多め」など）をGeminiで
 * 記録JSONに変換する。アプリの🎙ボタンとiPhoneショートカット(Siri)の両方から使う。
 *
 * 必要な環境変数:
 *   APP_TOKEN        ... 同期パスコード（編集用のみ許可）
 *   GEMINI_API_KEY   ... Google AI StudioのAPIキー https://aistudio.google.com/apikey
 *   GEMINI_MODEL     ... 任意。既定は gemini-3.5-flash（廃止時は自動で代替モデルに切替）
 *   KV_REST_API_URL / KV_REST_API_TOKEN ... commitモードで使用（Upstash）
 *
 * POST /api/voice  body: { text, mode?: "parse" | "commit", babyId? }
 *   parse  (既定) → { records: [...], reply }            解釈だけ（アプリが確認画面を出して登録）
 *   commit        → { records: [...], reply, saved: n }  その場でクラウドDBに登録（ショートカット用）
 */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TYPES = [
  "milk", "breast", "expressed", "pump", "frozen", "sleep", "wake", "pee", "poop",
  "bath", "lotion", "temperature", "weight", "height", "medicine", "vaccine",
  "vomit", "burp", "hiccup", "tummy", "walk", "memo", "custom"
];

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-App-Token");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  try {
    if (req.method !== "POST") throw httpError(405, "Method not allowed");
    if (!process.env.APP_TOKEN) throw httpError(500, "APP_TOKEN is not configured");
    // 記録を作る操作なので編集用パスコードのみ（閲覧用・写真用は不可）
    if ((req.headers["x-app-token"] || "") !== process.env.APP_TOKEN) {
      throw httpError(401, "パスコードが違います（編集用の合言葉が必要です）");
    }
    if (!process.env.GEMINI_API_KEY) {
      throw httpError(501, "音声入力を使うには、VercelにGEMINI_API_KEYを設定してください（無料: https://aistudio.google.com/apikey）");
    }

    const body = await readJSON(req);
    const text = String(body.text || "").trim();
    if (!text) throw httpError(400, "テキストが空です");
    if (text.length > 500) throw httpError(400, "テキストが長すぎます");
    const mode = body.mode === "commit" ? "commit" : "parse";
    const babyId = String(body.babyId || "default");

    const parsed = await askGemini(text);
    let records = (parsed.records || [])
      .filter((r) => r && TYPES.includes(String(r.type)))
      .slice(0, 10)
      .map((r) => normalize(r, babyId));
    let reply = String(parsed.reply || "").slice(0, 300);
    if (!records.length && !reply) reply = "うまく聞き取れませんでした。もう一度話してください。";

    if (mode === "commit" && records.length) {
      if (!REDIS_URL || !REDIS_TOKEN) throw httpError(500, "Upstash Redis is not configured");
      const cmds = records.map((r) => ["HSET", `babylog:${babyId}:records`, r.id, JSON.stringify(r)]);
      cmds.push(["SET", `babylog:${babyId}:rev`, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`]);
      await redis(cmds);
      respond(res, 200, { records, reply, saved: records.length });
      return;
    }

    respond(res, 200, { records, reply, saved: 0 });
  } catch (error) {
    const message = error.message || "Server error";
    // replyにも入れておくと、ショートカット（読み上げ）でもエラーが聞こえる
    respond(res, error.statusCode || 500, { error: message, reply: `エラー: ${message}`, records: [], saved: 0 });
  }
};

/** Geminiに発話→記録JSONの変換を頼む */
async function askGemini(text) {
  // 日本時間の現在日時（相対時刻の解決に使う）
  const jst = new Date(Date.now() + 9 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  const today = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
  const nowTime = `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  const dows = ["日", "月", "火", "水", "木", "金", "土"];

  const prompt = `あなたは赤ちゃんのお世話記録アプリの音声入力を解釈するパーサーです。
現在の日本時間: ${today}(${dows[jst.getUTCDay()]}) ${nowTime}

ユーザーの発話を、以下のtypeの記録の配列に変換してください:
- milk=ミルク(amountMl=ml), expressed=搾母乳(amountMl), breast=母乳(leftMin/rightMin=左右の分数。左右不明なら両方に半分ずつ)
- sleep=寝た, wake=起きた, pee=おしっこ, poop=うんち
- bath=お風呂, lotion=保湿, walk=さんぽ, tummy=タミータイム, burp=ゲップ, hiccup=しゃっくり, vomit=吐いた
- temperature=体温(amountMl=°C), weight=体重(amountMl=kg), height=身長(amountMl=cm)
- medicine=くすり(customTitleに薬名), vaccine=予防接種(customTitle), memo=メモ, custom=その他(customTitle)

ルール:
- 時刻: 「30分前」等の相対表現は現在時刻から計算。「さっき」は10分前。指定がなければ現在時刻。分は5分単位に切り捨て。
- 日付: 指定がなければ今日(${today})。「昨日」等は計算する。
- うんちのようす: noteの先頭に 量(少量/少なめ/普通/多め)・かたさ(柔らかめ/普通/硬め)・色(黄色/緑/茶色) のうち言及されたものを「・」区切りで入れる。その他の補足は「｜」の後ろに。
- 発話にない値を創作しない。量が不明なミルクはamountMl=0。
- 1つの発話に複数の記録があれば全部返す。
- replyには登録内容を確認する短い日本語（例:「14:30 ミルク120mlを登録します」）。解釈できなければrecordsを空にして聞き返す。

JSONだけを返す:
{"records":[{"type":"...","date":"YYYY-MM-DD","time":"HH:MM","amountMl":0,"leftMin":0,"rightMin":0,"note":"","customTitle":""}],"reply":"..."}

発話: ${JSON.stringify(text)}`;

  // モデルは新しい順に試す（Googleが古いモデルを廃止しても自動で次に切り替わる）
  const candidates = [process.env.GEMINI_MODEL, "gemini-3.5-flash", "gemini-2.5-flash"]
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
  let data = null;
  let lastError = "";
  for (const model of candidates) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        })
      }
    );
    data = await r.json().catch(() => null);
    if (r.ok) { lastError = ""; break; }
    const msg = (data && data.error && data.error.message) || `Gemini error ${r.status}`;
    lastError = msg;
    data = null;
    // モデルが存在しない/廃止された場合だけ次の候補を試す。それ以外（キー不正・上限など）は即エラー
    const modelGone = r.status === 404 || /not found|no longer available|deprecated|has been (retired|shut ?down)/i.test(msg);
    if (!modelGone) break;
  }
  if (!data) throw httpError(502, `Gemini APIエラー: ${lastError}`);
  const out = data && data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!out) throw httpError(502, "Geminiから応答がありませんでした");
  try {
    return JSON.parse(out);
  } catch (_) {
    // まれにコードブロックで返るので剥がして再挑戦
    const m = String(out).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* fallthrough */ } }
    throw httpError(502, "Geminiの応答を解釈できませんでした");
  }
}

function normalize(r, babyId) {
  const now = new Date().toISOString();
  const time = /^\d{2}:\d{2}$/.test(String(r.time)) ? String(r.time) : "00:00";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? String(r.date) : now.slice(0, 10);
  return {
    id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    babyId,
    date,
    time,
    type: String(r.type),
    amountMl: Number(r.amountMl || 0) || 0,
    leftMin: Number(r.leftMin || 0) || 0,
    rightMin: Number(r.rightMin || 0) || 0,
    note: String(r.note || "").slice(0, 200),
    createdAt: now,
    updatedAt: now,
    customTitle: String(r.customTitle || "").slice(0, 60),
    photo: "",
    deleted: 0
  };
}

async function redis(commands) {
  const response = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw httpError(502, (data && data.error) || `Redis error ${response.status}`);
  return data.map((item) => { if (item.error) throw httpError(502, item.error); return item.result; });
}

async function readJSON(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function respond(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}
