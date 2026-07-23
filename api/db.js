/*
 * クラウド同期API (Vercel + Upstash Redis)
 *
 * 必要な環境変数:
 *   APP_TOKEN ... アプリの「同期パスコード」と同じ値
 *   KV_REST_API_URL / KV_REST_API_TOKEN
 *     （VercelのStorageでUpstash(Redis)を接続すると自動で入る。
 *       UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN でも可）
 *
 * GET  /api/db?babyId=default&rev=<手元のrev>&since=<手元の最新syncedAt>
 *   → 変更なし: { rev, unchanged: true }
 *   → 変更あり(since付き): { rev, records: [差分のみ], delta: true, profile }
 *   → 変更あり(sinceなし・旧クライアント): { rev, records: [全件], profile }
 * POST /api/db  body: { babyId, records: [...], profile? }
 *   → { rev, count }   (idごとにupsert。deleted:true はトゥームストーン)
 *
 * 差分同期: 書き込み時にサーバー時刻 syncedAt を各記録へ刻む。
 * クライアントは受信済みの最大syncedAtを since に入れて送ると差分だけ返る
 * （端末の時計に依存しないので、オフライン明けの古いupdatedAtの記録も取りこぼさない）。
 */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-App-Token");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  try {
    if (!process.env.APP_TOKEN) throw httpError(500, "APP_TOKEN is not configured");
    if (!REDIS_URL || !REDIS_TOKEN) throw httpError(500, "Upstash Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
    // 権限: 編集用(APP_TOKEN)=読み書き / 写真用(APP_TOKEN_PHOTO・任意)=閲覧＋写真のみ /
    //       閲覧用(APP_TOKEN_VIEW・任意)=読み取りのみ
    const token = req.headers["x-app-token"] || "";
    const isEdit = token === process.env.APP_TOKEN;
    const isPhoto = !!process.env.APP_TOKEN_PHOTO && token === process.env.APP_TOKEN_PHOTO;
    const isView = !!process.env.APP_TOKEN_VIEW && token === process.env.APP_TOKEN_VIEW;
    if (!isEdit && !isPhoto && !isView) throw httpError(401, "パスコードが違います");
    const mode = isEdit ? "edit" : isPhoto ? "photo" : "view";

    if (req.method === "GET") {
      const babyId = String(req.query.babyId || "default");
      const clientRev = String(req.query.rev || "");
      const since = Number(req.query.since || 0) || 0;
      const rev = (await redis([["GET", key(babyId, "rev")]]))[0] || "0";
      if (clientRev && clientRev === rev) {
        respond(res, 200, { rev, unchanged: true, readonly: !isEdit, mode });
        return;
      }
      const [values, profileRaw] = await redis([
        ["HVALS", key(babyId, "records")],
        ["GET", key(babyId, "profile")]
      ]);
      let records = (values || []).map((v) => { try { return JSON.parse(v); } catch (_) { return null; } }).filter(Boolean);
      // since付き → 差分だけ返す（5秒の重なりを持たせてインスタンス間の時計差を吸収。マージは冪等なので重複は無害）
      const delta = since > 0;
      if (delta) records = records.filter((r) => Number(r.syncedAt || 0) > since - 5000);
      respond(res, 200, { rev, records, delta, profile: safeParse(profileRaw), readonly: !isEdit, mode });
      return;
    }

    if (req.method === "POST") {
      if (isView) throw httpError(403, "閲覧用パスコードでは記録を変更できません");
      const body = await readJSON(req);
      const babyId = String(body.babyId || "default");
      let incoming = (body.records || []).filter((r) => r && r.id && r.date && r.time && r.type);
      // 写真用パスコードは「写真」の記録だけ受け付ける
      if (isPhoto) incoming = incoming.filter((r) => String(r.type) === "photo");

      // LWW: 既存よりupdatedAtが新しいものだけ書く
      const ids = incoming.map((r) => String(r.id));
      let toWrite = incoming;
      if (ids.length) {
        const existing = await redis([["HMGET", key(babyId, "records"), ...ids]]);
        toWrite = incoming.filter((r, i) => {
          const cur = safeParse(existing[0] ? existing[0][i] : null);
          // 写真用は、既存レコードが「写真」以外なら上書き不可（idの偽装対策）
          if (isPhoto && cur && String(cur.type) !== "photo") return false;
          return !cur || String(r.updatedAt || "") >= String(cur.updatedAt || "");
        });
      }
      const cmds = [];
      const syncedAt = Date.now(); // 差分同期用のサーバー側の受信時刻
      for (const r of toWrite) cmds.push(["HSET", key(babyId, "records"), String(r.id), JSON.stringify(normalize(r, babyId, syncedAt))]);
      const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      cmds.push(["SET", key(babyId, "rev"), rev]);
      if (isEdit && body.profile && (body.profile.babyName || body.profile.birthday)) {
        cmds.push(["SET", key(babyId, "profile"), JSON.stringify({
          babyName: String(body.profile.babyName || ""),
          babyKana: String(body.profile.babyKana || ""),
          birthday: String(body.profile.birthday || ""),
          gender: String(body.profile.gender || ""),
          birthWeight: String(body.profile.birthWeight || ""),
          birthHeight: String(body.profile.birthHeight || ""),
          driveFolderId: String(body.profile.driveFolderId || "")
        })]);
      }
      // 500コマンドずつパイプライン実行
      for (let i = 0; i < cmds.length; i += 500) await redis(cmds.slice(i, i + 500));
      respond(res, 200, { rev, count: toWrite.length });
      return;
    }

    respond(res, 405, { error: "Method not allowed" });
  } catch (error) {
    respond(res, error.statusCode || 500, { error: error.message || "Server error" });
  }
};

function key(babyId, part) { return `babylog:${babyId}:${part}`; }

function normalize(r, babyId, syncedAt) {
  return {
    id: String(r.id),
    babyId,
    date: String(r.date),
    time: String(r.time),
    type: String(r.type),
    amountMl: Number(r.amountMl || 0),
    leftMin: Number(r.leftMin || 0),
    rightMin: Number(r.rightMin || 0),
    note: String(r.note || ""),
    createdAt: String(r.createdAt || ""),
    updatedAt: String(r.updatedAt || ""),
    customTitle: String(r.customTitle || ""),
    photo: String(r.photo || ""),
    deleted: r.deleted ? 1 : 0,
    syncedAt: Number(syncedAt || r.syncedAt || 0)
  };
}

/** Upstash RESTパイプライン: [["GET","k"],["HVALS","h"]] → 各コマンドの結果配列 */
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
