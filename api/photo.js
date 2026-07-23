/*
 * 写真アップロード/配信API (Vercel Blob・プライベートストア)
 *
 * セットアップ:
 *   VercelのStorageでBlobストアを「Private」で作成し、babylogプロジェクトに接続する
 *   （認証はVercelが自動で設定。APP_TOKENは既存のものを使用）
 *
 * POST /api/photo                     (body: JPEGバイナリ, X-App-Token 必須)
 *   → { pathname: "babylog/xxxx.jpg" }
 * GET  /api/photo?pathname=...&t=<パスコード>
 *   → 画像本体をストリーミング（<img>から使うためトークンはクエリでも可）
 */

const { put, get } = require("@vercel/blob");
const { Readable } = require("node:stream");

const MAX_BYTES = 4 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-App-Token");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  try {
    if (!process.env.APP_TOKEN) throw httpError(500, "APP_TOKEN is not configured");
    // 編集用と写真用(APP_TOKEN_PHOTO)は閲覧+アップロード、閲覧用(APP_TOKEN_VIEW)は閲覧のみ
    const token = req.headers["x-app-token"] || (req.query && req.query.t) || "";
    const isEdit = token === process.env.APP_TOKEN;
    const isPhoto = !!process.env.APP_TOKEN_PHOTO && token === process.env.APP_TOKEN_PHOTO;
    const isView = !!process.env.APP_TOKEN_VIEW && token === process.env.APP_TOKEN_VIEW;
    if (!isEdit && !isPhoto && !isView) throw httpError(401, "パスコードが違います");

    if (req.method === "POST") {
      if (!isEdit && !isPhoto) throw httpError(403, "閲覧用パスコードでは写真を追加できません");
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw httpError(413, "写真が大きすぎます");
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw httpError(400, "写真データがありません");

      const key = `babylog/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.jpg`;
      const blob = await put(key, buffer, {
        access: "private",
        contentType: "image/jpeg"
      });
      respondJson(res, 200, { pathname: blob.pathname });
      return;
    }

    if (req.method === "GET") {
      const pathname = String((req.query && req.query.pathname) || "");
      if (!pathname) throw httpError(400, "pathnameがありません");

      const result = await get(pathname, {
        access: "private",
        ifNoneMatch: req.headers["if-none-match"] || undefined
      });
      if (!result) throw httpError(404, "写真が見つかりません");

      // 写真は一度アップロードしたら変わらない（pathnameが毎回ユニーク）ので、
      // 強くキャッシュして転送量とBlob読み取りを節約する:
      //   max-age=1年+immutable ... 各端末は再ダウンロードも再確認もしない
      //   s-maxage=1日 ... Vercelのエッジにも1日キャッシュ（家族の初回表示もオリジンまで来ない）
      // ※URLに合言葉が入るためキャッシュキーは合言葉ごとに分かれる。合言葉を変えた場合も最長1日で消える
      const CACHE = "public, max-age=31536000, s-maxage=86400, immutable";
      if (result.statusCode === 304) {
        res.setHeader("ETag", result.blob.etag);
        res.setHeader("Cache-Control", CACHE);
        res.statusCode = 304;
        res.end();
        return;
      }
      if (result.statusCode !== 200) throw httpError(404, "写真が見つかりません");

      res.setHeader("Content-Type", result.blob.contentType || "image/jpeg");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("ETag", result.blob.etag);
      res.setHeader("Cache-Control", CACHE);
      res.statusCode = 200;
      Readable.fromWeb(result.stream).pipe(res);
      return;
    }

    throw httpError(405, "Method not allowed");
  } catch (error) {
    respondJson(res, error.statusCode || 500, { error: error.message || "Server error" });
  }
};

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function respondJson(res, statusCode, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}
