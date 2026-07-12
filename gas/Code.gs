/**
 * べびログ スプレッドシート書き出し用 Google Apps Script
 *
 * 書き出すと2枚のシートができます:
 *   「記録」    ... 日本語で見やすく整形した一覧（人間用）
 *   「Records」 ... 生データ（機械用・復元やバックアップに使う）
 *
 * セットアップ（5分・コードの書き換えは不要）:
 * 1. 書き出し先にしたいGoogleスプレッドシートを開く
 * 2. メニュー「拡張機能」→「Apps Script」
 * 3. 左の⚙「プロジェクトの設定」→「「appsscript.json」マニフェスト ファイルを
 *    エディタで表示する」にチェック → appsscript.json を開いて
 *    リポジトリの gas/appsscript.json の中身に丸ごと差し替えて保存
 * 4. コード.gs にこのファイルの中身を全部貼り付けて保存
 * 5. 上の関数選択で「setup」を選んで ▶実行 → 承認画面が出たら
 *    アカウント選択 →「詳細」→「（プロジェクト名）に移動」→ 許可
 * 6. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *    - 次のユーザーとして実行: 自分
 *    - アクセスできるユーザー: 全員
 * 7. 発行された「ウェブアプリのURL」(https://script.google.com/macros/s/.../exec) をコピー
 * 8. アプリの設定タブ「書き出し先URL」にそのURLを入れて「シートへ書き出す」を1回押す
 *    → この初回書き出しで、アプリの合言葉がこのシートのパスコードとして自動登録されます
 *
 * ※コードを変更したら「デプロイ」→「デプロイを管理」→ 編集 → 新バージョン で更新
 *   （「新しいデプロイ」にするとURLが変わってしまうので注意）
 */

// パスコードは空のままでOK（初回の書き出しでアプリの合言葉が自動登録されます）。
// 手動で固定したい場合だけ、ここに合言葉を書いてください。
var TOKEN = "";

// （任意）写真バックアップ先のDriveフォルダID。
// ふつうはアプリの設定「写真バックアップ先のDriveフォルダ」に入れれば足りるので空のままでOK。
// エディタからtestDriveFolderで診断したいときや、GAS側で固定したいときだけ入れる。
var DRIVE_FOLDER_ID = "";

var RAW_SHEET = "Records";
var PRETTY_SHEET = "記録";
var HEADERS = [
  "id", "babyId", "date", "time", "type", "amountMl",
  "leftMin", "rightMin", "note", "createdAt", "updatedAt", "customTitle", "photo"
];
var PRETTY_HEADERS = ["日付", "曜日", "時刻", "種類", "内容", "ようす・メモ", "タイトル", "写真"];

var TYPE_LABEL = {
  milk: "ミルク", breast: "母乳", expressed: "搾母乳", pump: "搾乳", frozen: "母乳冷凍",
  sleep: "寝る", wake: "起きる", pee: "おしっこ", poop: "うんち",
  bath: "お風呂", lotion: "保湿", temperature: "体温", weight: "体重", height: "身長",
  medicine: "くすり", vaccine: "予防接種", vomit: "吐く", burp: "ゲップ",
  hiccup: "しゃっくり", tummy: "タミータイム", walk: "さんぽ", memo: "メモ", custom: "その他"
};

function doGet(e) {
  return respond_(function () {
    checkToken_((e && e.parameter && e.parameter.token) || "");
    var babyId = (e && e.parameter && e.parameter.babyId) || "default";
    var records = readRecords_().filter(function (r) { return r.babyId === babyId; });
    return { records: records, profile: readProfile_() };
  });
}

function doPost(e) {
  return respond_(function () {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    checkToken_(body.token || "");
    var babyId = body.babyId || "default";
    var incoming = (body.records || [])
      .filter(function (r) { return r && r.id && r.date && r.time && r.type && !r.deleted; })
      .map(function (r) { return normalize_(r, babyId); });
    var others = readRecords_().filter(function (r) { return r.babyId !== babyId; });
    var all = others.concat(incoming).sort(function (a, b) {
      var ka = a.babyId + " " + a.date + " " + a.time;
      var kb = b.babyId + " " + b.date + " " + b.time;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    writeRecords_(all);
    var photoName = photoLabel_(body.profile);
    writePretty_(all, photoName);
    if (body.profile) writeProfile_(body.profile);
    var photos = 0, photoError = "";
    try {
      // フォルダIDはアプリの設定から届く値を優先（無ければこのファイルの定数）
      photos = backupPhotos_(incoming, body.appUrl || "", String(body.driveFolderId || DRIVE_FOLDER_ID || ""), photoName);
    } catch (err) {
      // 写真バックアップの失敗で書き出し全体は止めないが、理由はアプリに返す
      photoError = String(err && err.message ? err.message : err);
    }
    return { count: incoming.length, photos: photos, photoError: photoError };
  });
}

// ---------- 初期設定 ----------

/**
 * 初期設定（エディタから1回だけ実行する）:
 * シート・Drive・外部通信の権限をまとめて承認するための関数です。
 * ▶実行して、承認画面が出たら: アカウント選択 →「詳細」→「（プロジェクト名）に移動」→ 許可
 */
function setup() {
  SpreadsheetApp.getActive().getName();                                        // シートの読み書き
  DriveApp.getRootFolder();                                                    // Drive（写真バックアップ用）
  UrlFetchApp.fetch("https://www.google.com/generate_204", { muteHttpExceptions: true }); // 外部通信（写真取得用）
  Logger.log("OK: 承認が完了しました。あとは「デプロイ」→「新しいデプロイ」→ ウェブアプリ で公開してURLをアプリに入れるだけです。");
}

// ---------- Google Driveへの写真バックアップ ----------

/**
 * 動作テスト（エディタから実行する用）:
 * 1. 上の DRIVE_FOLDER_ID にフォルダIDを入れて保存
 * 2. エディタ上部の関数選択で「testDriveFolder」を選んで ▶実行
 * 3. 承認画面が出たら: アカウント選択 →「詳細」→「（プロジェクト名）に移動」→ 許可
 * 4. 下の実行ログに「OK: フォルダ「◯◯」を開けました」と出れば成功
 */
function testDriveFolder() {
  if (!DRIVE_FOLDER_ID) throw new Error("先に DRIVE_FOLDER_ID にフォルダIDを入れてください");
  var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  // 書き込みも試す（写真の保存先になるサブフォルダを作ってみる）
  var name = photoLabel_(null);
  var sub = getOrCreateFolder_(folder, name);
  // 外部通信（写真をアプリから取得するのに使う）も試す
  UrlFetchApp.fetch("https://www.google.com/generate_204", { muteHttpExceptions: true });
  Logger.log("OK: フォルダ「" + folder.getName() + "」を開けて、「" + name + "」フォルダ作成と外部通信もできました。写真バックアップが使えます。");
}

function backupPhotos_(records, appUrl, folderId, photoName) {
  if (!folderId) return 0;
  var parent;
  try {
    parent = DriveApp.getFolderById(folderId);
    parent.getName(); // アクセスできるかここで確認
  } catch (err) {
    throw new Error("Driveフォルダを開けません（エディタからtestDriveFolderを実行して承認が必要かも）: " +
      String(err && err.message ? err.message : err));
  }
  var folders = {}; // 種類ラベル → Folder
  var saved = 0, tried = 0, lastErr = "";
  outer:
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var paths = photoPaths_(r);
    if (!paths.length) continue;
    var label = r.type === "photo" ? (photoName || "写真") : (TYPE_LABEL[r.type] || r.type);
    if (!folders[label]) folders[label] = getOrCreateFolder_(parent, label);
    for (var j = 0; j < paths.length; j++) {
      var path = paths[j];
      var name = driveName_(r, path);
      if (folders[label].getFilesByName(name).hasNext()) continue; // 保存済みはスキップ
      var url = /^https?:/.test(path)
        ? path
        : appUrl + "/api/photo?pathname=" + encodeURIComponent(path) + "&t=" + encodeURIComponent(activeToken_());
      if (!/^https?:/.test(url)) continue;
      tried++;
      try {
        var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (resp.getResponseCode() !== 200) {
          lastErr = "写真の取得に失敗 (HTTP " + resp.getResponseCode() + ")";
          continue;
        }
        folders[label].createFile(resp.getBlob().setName(name));
        saved++;
        if (saved >= 40) break outer; // 1回の実行上限（タイムアウト回避。残りは翌日に持ち越し）
      } catch (err) { lastErr = String(err && err.message ? err.message : err); }
    }
  }
  // 1枚も保存できず、全部失敗していたら理由を報告
  if (!saved && tried && lastErr) throw new Error(lastErr);
  return saved;
}

/** 写真の表示名: よみがなが設定されていれば「はなの写真」「たろうの写真」、なければ「写真」 */
function photoLabel_(profile) {
  var kana = String((profile && profile.babyKana) || "").trim();
  if (!kana) {
    var saved = readProfile_();
    kana = String((saved && saved.babyKana) || "").trim();
  }
  if (!kana) return "写真";
  return kana.slice(-1) === "の" ? kana + "写真" : kana + "の写真";
}

/** photoフィールド（"a.jpg|b.jpg" 形式・複数枚対応）を配列に */
function photoPaths_(r) {
  return String(r.photo || "").split("|").filter(function (p) { return p; });
}

/** Driveに保存するときのファイル名（「記録」シートの写真列と同じ名前になる） */
function driveName_(r, path) {
  return r.date + "_" + String(r.time).replace(":", "") + "_" + hash8_(path) + ".jpg";
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function hash8_(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

// ---------- 日本語シート ----------

function writePretty_(records, photoName) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(PRETTY_SHEET);
  if (!sheet) sheet = ss.insertSheet(PRETTY_SHEET, 0);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, PRETTY_HEADERS.length).setValues([PRETTY_HEADERS]).setFontWeight("bold");
  if (!records.length) return;
  var dows = ["日", "月", "火", "水", "木", "金", "土"];
  var rows = records.map(function (r) {
    var d = new Date(r.date + "T00:00:00");
    return [
      r.date.replace(/-/g, "/"),
      isNaN(d.getTime()) ? "" : dows[d.getDay()],
      r.time,
      r.type === "photo" ? (photoName || "写真") : (TYPE_LABEL[r.type] || r.type),
      describe_(r),
      r.note || "",
      r.customTitle || "",
      // Driveに保存されるファイル名と同じ（見返し用・複数枚はカンマ区切り）
      photoPaths_(r).map(function (p) { return driveName_(r, p); }).join(", ")
    ];
  });
  var range = sheet.getRange(2, 1, rows.length, PRETTY_HEADERS.length);
  range.setNumberFormat("@");
  range.setValues(rows);
  sheet.setFrozenRows(1);
}

function describe_(r) {
  switch (r.type) {
    case "milk": case "expressed": case "pump": case "frozen":
      return r.amountMl ? r.amountMl + "ml" : "";
    case "breast": {
      var parts = [];
      if (r.leftMin) parts.push("左" + r.leftMin + "分");
      if (r.rightMin) parts.push("右" + r.rightMin + "分");
      return parts.join(" ");
    }
    case "wake": {
      if (!r.amountMl) return "";
      var h = Math.floor(r.amountMl / 60), m = r.amountMl % 60;
      return (h ? h + "時間" : "") + m + "分寝た";
    }
    case "temperature": return r.amountMl ? r.amountMl + "°C" : "";
    case "weight": return r.amountMl ? r.amountMl + "kg" : "";
    case "height": return r.amountMl ? r.amountMl + "cm" : "";
    default: return "";
  }
}

// ---------- 生データシート ----------

function respond_(fn) {
  var payload;
  try {
    payload = fn();
  } catch (err) {
    payload = { error: String(err && err.message ? err.message : err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/** いま有効なパスコード（コードに書いたTOKEN → 無ければ初回に自動登録されたもの） */
function activeToken_() {
  if (TOKEN && TOKEN !== "koko-wo-kakikaeru") return TOKEN;
  return PropertiesService.getScriptProperties().getProperty("token") || "";
}

function checkToken_(token) {
  var stored = activeToken_();
  if (stored) {
    if (token !== stored) throw new Error("パスコードが違います");
    return;
  }
  // 初回: 届いた合言葉をこのシートのパスコードとして登録する
  if (!token) throw new Error("パスコードが空です（アプリの設定で同期パスコードを入れてください）");
  PropertiesService.getScriptProperties().setProperty("token", String(token));
}

function sheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(RAW_SHEET);
  if (!sheet) sheet = ss.insertSheet(RAW_SHEET);
  var head = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (head.join("|") !== HEADERS.join("|")) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sheet;
}

function readRecords_() {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return values
    .filter(function (row) { return row[0]; })
    .map(function (row) {
      return {
        id: String(row[0]),
        babyId: String(row[1] || "default"),
        date: normalizeDate_(row[2]),
        time: normalizeTime_(row[3]),
        type: String(row[4] || "memo"),
        amountMl: Number(row[5] || 0),
        leftMin: Number(row[6] || 0),
        rightMin: Number(row[7] || 0),
        note: String(row[8] || ""),
        createdAt: String(row[9] || ""),
        updatedAt: String(row[10] || ""),
        customTitle: String(row[11] || ""),
        photo: String(row[12] || "")
      };
    });
}

function writeRecords_(records) {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, HEADERS.length).clearContent();
  if (!records.length) return;
  var rows = records.map(function (r) {
    return HEADERS.map(function (key) { return r[key] != null ? r[key] : ""; });
  });
  var range = sheet.getRange(2, 1, rows.length, HEADERS.length);
  range.setNumberFormat("@");
  range.setValues(rows);
}

function normalize_(r, babyId) {
  var now = new Date().toISOString();
  return {
    id: String(r.id),
    babyId: babyId,
    date: String(r.date),
    time: String(r.time),
    type: String(r.type),
    amountMl: Number(r.amountMl || 0),
    leftMin: Number(r.leftMin || 0),
    rightMin: Number(r.rightMin || 0),
    note: String(r.note || ""),
    createdAt: String(r.createdAt || now),
    updatedAt: String(r.updatedAt || now),
    customTitle: String(r.customTitle || ""),
    photo: String(r.photo || "")
  };
}

function readProfile_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("profile");
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}

function writeProfile_(profile) {
  var clean = {
    babyName: String(profile.babyName || ""),
    babyKana: String(profile.babyKana || ""),
    birthday: String(profile.birthday || ""),
    gender: String(profile.gender || ""),
    birthWeight: String(profile.birthWeight || ""),
    birthHeight: String(profile.birthHeight || "")
  };
  if (clean.babyName || clean.birthday) {
    PropertiesService.getScriptProperties().setProperty("profile", JSON.stringify(clean));
  }
}

function normalizeDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "").replace(/\//g, "-");
}

function normalizeTime_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "HH:mm");
  }
  var s = String(v || "");
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? (("0" + m[1]).slice(-2) + ":" + m[2]) : s;
}
