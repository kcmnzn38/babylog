/*
 * データ層: localStorage 保存 + クラウド自動同期(/api/db) + スプレッドシート書き出し(GAS)
 * スキーマは api/sync.js の "Records" シートと互換。
 * 削除は deleted フラグ(トゥームストーン)で表現し、端末間で削除も同期される。
 */
(function (root) {
  "use strict";

  const RECORDS_KEY = "babylog.records.v2";
  const SETTINGS_KEY = "babylog.settings.v2";
  const PENDING_KEY = "babylog.pending.v1";
  const TOMBSTONE_DAYS = 90;

  const defaultSettings = {
    babyId: "default",
    babyName: "",
    babyKana: "",   // よみがな・呼び名（「◯◯の写真」の表示に使う）
    birthday: "",
    gender: "",
    birthWeight: "",
    birthHeight: "",
    driveFolderId: "",
    syncToken: "",   // クラウド同期(APP_TOKEN)とスプシ書き出し(GASのTOKEN)で共通に使う
    sheetUrl: "",
    lastAmounts: { milk: 120, expressed: 60, pump: 60 },
    defaultAmounts: { milk: "", expressed: "", pump: "", frozen: "" }, // 設定した初期量（空なら前回値）
    quickTypes: ["milk", "breast", "expressed", "sleepToggle", "pee", "poop"], // 下段クイック6枠
    typeOrder: [], // 「その他」メニューの並び順（空なら既定順）
    lastSyncAt: "",
    cloudRev: "",
    cloudSince: 0,       // 差分同期: 受信済みの最大syncedAt（サーバー時刻ms）
    lastFullPullAt: 0,   // 差分同期: 最後に全件を取り直した時刻（1日1回の保険）
    welcomeSkipped: false
  };

  let records = [];   // トゥームストーン含む
  let settings = { ...defaultSettings };
  let pendingIds = new Set();
  const listeners = [];

  // クラウド同期の状態（UI表示用）。readonly=閲覧用 / photoOnly=写真用パスコードで接続中
  const cloud = { status: "off", message: "", lastSyncAt: "", readonly: false, photoOnly: false };
  let pushTimer = null;
  let pollTimer = null;
  let visibilityBound = false;

  function load() {
    try {
      records = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]");
      if (!Array.isArray(records)) records = [];
    } catch (_) { records = []; }
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      settings = {
        ...defaultSettings, ...saved,
        lastAmounts: { ...defaultSettings.lastAmounts, ...(saved.lastAmounts || {}) },
        defaultAmounts: { ...defaultSettings.defaultAmounts, ...(saved.defaultAmounts || {}) },
        quickTypes: Array.isArray(saved.quickTypes) && saved.quickTypes.length === 6 ? saved.quickTypes : [...defaultSettings.quickTypes],
        typeOrder: Array.isArray(saved.typeOrder) ? saved.typeOrder : []
      };
    } catch (_) { settings = { ...defaultSettings }; }
    try {
      pendingIds = new Set(JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"));
    } catch (_) { pendingIds = new Set(); }
    pruneTombstones();
    sortRecords();
  }

  function pruneTombstones() {
    const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86400000).toISOString();
    records = records.filter((r) => !r.deleted || (r.updatedAt || "") > cutoff || pendingIds.has(r.id));
  }

  function persistRecords(silent) {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    if (!silent) emit();
  }
  function persistSettings(silent) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (!silent) emit();
  }
  function persistPending() {
    localStorage.setItem(PENDING_KEY, JSON.stringify([...pendingIds]));
  }

  function sortRecords() {
    records.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || String(a.id).localeCompare(String(b.id)));
  }

  function emit() { listeners.forEach((fn) => fn()); }
  function subscribe(fn) { listeners.push(fn); }

  function newId() {
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function liveRecords() { return records.filter((r) => !r.deleted); }

  function upsert(record) {
    const now = new Date().toISOString();
    const idx = records.findIndex((r) => r.id === record.id);
    const full = {
      babyId: settings.babyId,
      amountMl: 0, leftMin: 0, rightMin: 0, note: "", customTitle: "", photo: "", deleted: 0,
      ...record,
      updatedAt: now
    };
    if (idx >= 0) {
      full.createdAt = records[idx].createdAt || now;
      records[idx] = full;
    } else {
      full.id = full.id || newId();
      full.createdAt = full.createdAt || now;
      records.push(full);
    }
    if (["milk", "expressed", "pump"].includes(full.type) && full.amountMl > 0 && !full.deleted) {
      settings.lastAmounts[full.type] = full.amountMl;
      persistSettings(true);
    }
    sortRecords();
    persistRecords();
    queuePush([full.id]);
    return full;
  }

  /** 削除 = トゥームストーン化（他端末にも削除が伝わる）。戻り値は削除前のコピー */
  function remove(id) {
    const idx = records.findIndex((r) => r.id === id && !r.deleted);
    if (idx < 0) return null;
    const copy = { ...records[idx], deleted: 0 };
    records[idx] = { ...records[idx], deleted: 1, updatedAt: new Date().toISOString() };
    persistRecords();
    queuePush([id]);
    return copy;
  }

  /** import / pull 用: id でマージ（同idは新しいupdatedAtを採用）。deletedも尊重 */
  function merge(incoming, options) {
    const opts = options || {};
    const byId = new Map(records.map((r) => [r.id, r]));
    let added = 0, updated = 0;
    const changedIds = [];
    for (const rec of incoming) {
      if (!rec || !rec.id || !rec.date || !rec.time || !rec.type) continue;
      const normalized = { ...rec, deleted: rec.deleted ? 1 : 0 };
      const existing = byId.get(rec.id);
      if (!existing) {
        byId.set(rec.id, normalized);
        added++;
        changedIds.push(rec.id);
      } else if (String(normalized.updatedAt || "") > String(existing.updatedAt || "")) {
        byId.set(rec.id, normalized);
        updated++;
        changedIds.push(rec.id);
      }
    }
    if (changedIds.length) {
      records = [...byId.values()];
      sortRecords();
      persistRecords();
      if (!opts.fromCloud) queuePush(changedIds);
    }
    return { added, updated };
  }

  function replaceAll(next) {
    records = Array.isArray(next) ? next : [];
    pendingIds = new Set();
    persistPending();
    sortRecords();
    persistRecords();
  }

  function byDate(dateStr) {
    return records.filter((r) => !r.deleted && r.date === dateStr);
  }

  function updateSettings(patch) {
    const tokenChanged = patch.syncToken !== undefined && patch.syncToken !== settings.syncToken;
    settings = { ...settings, ...patch };
    // 合言葉が変わったら同期位置をリセット（別のデータ源に切り替わるため全件取り直す）
    if (tokenChanged) { settings.cloudRev = ""; settings.cloudSince = 0; settings.lastFullPullAt = 0; }
    persistSettings();
    if (tokenChanged) startCloud();
  }

  // ================= クラウド同期 (/api/db) =================

  function cloudEnabled() { return !!settings.syncToken; }

  const PROFILE_KEYS = ["babyName", "babyKana", "birthday", "gender", "birthWeight", "birthHeight", "driveFolderId"];
  function profilePayload() {
    const p = {};
    PROFILE_KEYS.forEach((k) => { p[k] = settings[k] || ""; });
    return p;
  }
  /** 端末側が未設定の項目だけ、受信したプロフィールで埋める */
  function applyProfile(profile) {
    if (!profile) return;
    const patch = {};
    PROFILE_KEYS.forEach((k) => {
      if (!settings[k] && profile[k]) patch[k] = profile[k];
    });
    if (Object.keys(patch).length) { settings = { ...settings, ...patch }; persistSettings(true); }
  }

  function setCloud(status, message) {
    cloud.status = status;
    cloud.message = message || "";
    if (status === "ok") cloud.lastSyncAt = new Date().toISOString();
    emit();
  }

  async function dbRequest(method, body) {
    const headers = { "Content-Type": "application/json", "X-App-Token": settings.syncToken };
    let url = `/api/db?babyId=${encodeURIComponent(settings.babyId)}`;
    if (method === "GET") {
      url += `&rev=${encodeURIComponent(settings.cloudRev || "")}`;
      // 差分同期: 受信済み位置を送ると差分だけ返る。1日1回は全件を取り直す（保険）
      const fullDue = Date.now() - (settings.lastFullPullAt || 0) > 86400000;
      if (settings.cloudSince > 0 && !fullDue) url += `&since=${settings.cloudSince}`;
    }
    const res = await fetch(url, {
      method, headers,
      body: method === "POST" ? JSON.stringify({ babyId: settings.babyId, ...body }) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `同期エラー (${res.status})`);
    return data;
  }

  function queuePush(ids) {
    ids.forEach((id) => pendingIds.add(id));
    persistPending();
    if (!cloudEnabled()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { flushPush().catch(() => {}); }, 1200);
  }

  async function flushPush() {
    if (!cloudEnabled() || !pendingIds.size || cloud.readonly) return;
    const sending = [...pendingIds];
    const batch = records.filter((r) => pendingIds.has(r.id));
    try {
      setCloud("syncing", "同期中...");
      const res = await dbRequest("POST", {
        records: batch,
        profile: profilePayload()
      });
      sending.forEach((id) => pendingIds.delete(id));
      persistPending();
      settings.cloudRev = res.rev;
      persistSettings(true);
      setCloud("ok");
    } catch (err) {
      setCloud("error", err.message);
    }
  }

  async function cloudPull() {
    if (!cloudEnabled()) return null;
    try {
      setCloud("syncing", "同期中...");
      const res = await dbRequest("GET");
      const mode = res.mode || (res.readonly ? "view" : "edit");
      cloud.readonly = mode === "view";
      cloud.photoOnly = mode === "photo";
      if (res.unchanged) {
        setCloud("ok");
        if (pendingIds.size) await flushPush();
        return { added: 0, updated: 0 };
      }
      const result = merge(res.records || [], { fromCloud: true });
      applyProfile(res.profile);
      // 差分同期: 受信済み位置を進める
      let since = Number(settings.cloudSince || 0);
      for (const r of res.records || []) since = Math.max(since, Number(r.syncedAt || 0));
      settings.cloudSince = since;
      // サーバーに無い / こちらの方が新しい記録は送り返す（編集モードのみ）。
      // ※この照合は「全件」が届いたときだけ行う（差分に対してやると全記録を再送してしまう）
      if (!res.delta && !cloud.readonly && !cloud.photoOnly) {
        const serverMap = new Map((res.records || []).map((r) => [r.id, String(r.updatedAt || "")]));
        for (const r of records) {
          const sv = serverMap.get(r.id);
          if (sv === undefined || sv < String(r.updatedAt || "")) pendingIds.add(r.id);
        }
        persistPending();
      }
      if (!res.delta) settings.lastFullPullAt = Date.now();
      settings.cloudRev = res.rev;
      persistSettings(true);
      setCloud("ok");
      if (pendingIds.size) await flushPush();
      return result;
    } catch (err) {
      setCloud("error", err.message);
      return null;
    }
  }

  /** 手動「今すぐ同期」: pull→push */
  async function syncNow() {
    const result = await cloudPull();
    if (result === null && cloud.status === "error") throw new Error(cloud.message);
    return result;
  }

  function startCloud() {
    clearInterval(pollTimer);
    if (!cloudEnabled()) { setCloud("off"); return; }
    cloudPull();
    pollTimer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") cloudPull();
    }, 60000);
    if (!visibilityBound && typeof document !== "undefined") {
      visibilityBound = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && cloudEnabled()) cloudPull();
      });
    }
  }

  // ================= スプレッドシート書き出し (GAS) =================

  function isGasUrl(url) {
    return /^https:\/\/script\.google(?:usercontent)?\.com\//.test(String(url || "").trim());
  }

  async function gasRequest(method, body) {
    const base = settings.sheetUrl.trim();
    let res;
    if (method === "GET") {
      const url = new URL(base);
      url.searchParams.set("token", settings.syncToken);
      url.searchParams.set("babyId", settings.babyId);
      res = await fetch(url.toString(), { method: "GET" });
    } else {
      // Content-Type を text/plain にすると preflight が発生せず GAS で受けられる
      res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ token: settings.syncToken, babyId: settings.babyId, ...body })
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `書き出しエラー (${res.status})`);
    return data;
  }

  async function syncRequest(method, body) {
    if (!settings.sheetUrl) throw new Error("書き出し先URLを入れてください");
    if (isGasUrl(settings.sheetUrl)) return gasRequest(method, body);
    // 旧: サービスアカウント方式(/api/sync)
    const headers = { "Content-Type": "application/json", "X-App-Token": settings.syncToken };
    const params = new URLSearchParams({ babyId: settings.babyId, sheetUrl: settings.sheetUrl });
    const url = method === "GET" ? `/api/sync?${params}` : "/api/sync";
    const res = await fetch(url, {
      method, headers,
      body: method === "POST" ? JSON.stringify({ babyId: settings.babyId, sheetUrl: settings.sheetUrl, ...body }) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `書き出しエラー (${res.status})`);
    return data;
  }

  async function pushToSheet() {
    const data = await syncRequest("POST", {
      records: liveRecords(),
      profile: profilePayload(),
      appUrl: (typeof location !== "undefined" ? location.origin : ""), // GASが写真を取得するときに使う
      driveFolderId: settings.driveFolderId
    });
    updateSettings({ lastSyncAt: new Date().toISOString() });
    return data;
  }

  async function pullFromSheet() {
    const data = await syncRequest("GET");
    const result = merge(data.records || []);
    applyProfile(data.profile);
    updateSettings({ lastSyncAt: new Date().toISOString() });
    return result;
  }

  root.Store = {
    load, subscribe,
    get records() { return liveRecords(); },
    get allRecords() { return records; },
    get settings() { return settings; },
    get cloud() { return cloud; },
    get pendingCount() { return pendingIds.size; },
    upsert, remove, merge, replaceAll, byDate, updateSettings, newId,
    startCloud, cloudPull, syncNow, flushPush,
    pushToSheet, pullFromSheet
  };
})(typeof self !== "undefined" ? self : this);
