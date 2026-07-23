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

const { put, get, issueSignedToken, presignUrl } = require("@vercel/blob");
const { Readable } = require("node:stream");

const MAX_BYTES = 4 * 1024 * 1024;

/*
 * 配信は「署名付きURLへのリダイレクト」方式:
 *   合言葉を確認 → 期限つきの署名付きURLを発行して302で返す
 *   → ブラウザはBlobのCDNから直接ダウンロードする（画像のバイトが関数を通らない）
 * これでFast Origin Transferをほぼ使わない。発行に使う委任トークンは
 * インスタンス内で使い回す（コントロールAPI呼び出しの節約）。
 * 有効期限の関係: 委任7日 > 署名URL5日 > リダイレクトのキャッシュ4日
 * （キャッシュ中に期限切れURLへ飛ばないよう、必ずこの順で短くする）
 */
let signedTokenCache = null; // { token, issuedAt }
async function signedToken() {
  const now = Date.now();
  if (signedTokenCache && now - signedTokenCache.issuedAt < 1.5 * 24 * 3600 * 1000) {
    return signedTokenCache.token;
  }
  const token = await issueSignedToken({
    operations: ["get"],
    validUntil: now + 7 * 24 * 3600 * 1000
  });
  signedTokenCache = { token, issuedAt: now };
  return token;
}

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

      // 既定: 署名付きURLへ302（画像はBlobのCDNから直接配信）。
      // ?stream=1 のときだけ従来どおり関数がバイトを中継する
      // （fetchでバイトを読むシェア・保存機能用。CORSの影響を受けないように）
      const wantStream = String((req.query && req.query.stream) || "") === "1";
      if (!wantStream && typeof issueSignedToken === "function" && typeof presignUrl === "function") {
        try {
          const { presignedUrl } = await presignUrl(await signedToken(), {
            operation: "get",
            pathname,
            access: "private",
            validUntil: Date.now() + 5 * 24 * 3600 * 1000
          });
          res.statusCode = 302;
          res.setHeader("Location", presignedUrl);
          res.setHeader("Cache-Control", "private, max-age=345600"); // 4日（URLの期限5日より短く）
          res.end();
          return;
        } catch (_) {
          // SDKが未対応・発行失敗などは従来のストリーミング配信にフォールバック
        }
      }

      const result = await get(pathname, {
        access: "private",
        ifNoneMatch: req.headers["if-none-match"] || undefined
      });
      if (!result) throw httpError(404, "写真が見つかりません");

      // 写真は一度アップロードしたら変わらない（pathnameが毎回ユニーク）ので、
      // ブラウザには強くキャッシュさせる（max-age=1年+immutable）。
      // ※Vercel公式の推奨に従い、エッジ共有キャッシュ(s-maxage)は使わない
      const CACHE = "private, max-age=31536000, immutable";
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
