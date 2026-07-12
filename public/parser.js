/*
 * ぴよログ エクスポートテキストのパーサー / 書き出し
 * ブラウザ(window.PiyoParser)とNode(module.exports)の両方で動く。
 *
 * レコードスキーマ（Google Sheets "Records" シートと互換）:
 *   id, babyId, date(YYYY-MM-DD), time(HH:MM), type,
 *   amountMl(数値: ml / 体温°C / 体重kg / 起きる=直前睡眠分),
 *   leftMin, rightMin, note, createdAt, updatedAt, customTitle
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiyoParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 既知の型定義。key = type文字列（シートに保存される値）
  const TYPES = {
    milk:        { label: "ミルク",   icon: "🍼", cat: "feed" },
    breast:      { label: "母乳",     icon: "🤱", cat: "feed" },
    expressed:   { label: "搾母乳",   icon: "🥛", cat: "feed" },
    pump:        { label: "搾乳",     icon: "🫙", cat: "mom" },
    frozen:      { label: "母乳冷凍", icon: "🧊", cat: "mom" },
    sleep:       { label: "寝る",     icon: "😴", cat: "sleep" },
    wake:        { label: "起きる",   icon: "🌞", cat: "sleep" },
    pee:         { label: "おしっこ", icon: "💧", cat: "diaper" },
    poop:        { label: "うんち",   icon: "💩", cat: "diaper" },
    bath:        { label: "お風呂",   icon: "🛁", cat: "care" },
    lotion:      { label: "保湿",     icon: "🧴", cat: "care" },
    temperature: { label: "体温",     icon: "🌡️", cat: "health", unit: "°C" },
    weight:      { label: "体重",     icon: "⚖️", cat: "health", unit: "kg" },
    height:      { label: "身長",     icon: "📏", cat: "health", unit: "cm" },
    medicine:    { label: "くすり",   icon: "💊", cat: "health" },
    vaccine:     { label: "予防接種", icon: "💉", cat: "health" },
    vomit:       { label: "吐く",     icon: "🤮", cat: "health" },
    burp:        { label: "ゲップ",   icon: "😤", cat: "care" },
    hiccup:      { label: "しゃっくり", icon: "😯", cat: "care" },
    tummy:       { label: "タミータイム", icon: "🐢", cat: "care" },
    walk:        { label: "さんぽ",   icon: "🚶", cat: "care" },
    photo:       { label: "写真", icon: "📷", cat: "memo" },
    memo:        { label: "メモ",     icon: "📝", cat: "memo" },
    custom:      { label: "その他",   icon: "⭐", cat: "memo" }
  };

  const MEDICINES = [
    "マグミット", "ジクロフェナク", "リオナ", "K2シロップ",
    "カロナール", "ビフィズス菌", "ワクチン"
  ];

  const SUMMARY_PREFIX = /^(母乳合計|ミルク合計|搾母乳合計|睡眠合計|おしっこ合計|うんち合計|のみもの合計|離乳食合計|搾乳合計)/;
  const DATE_LINE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(?:\(([月火水木金土日])\))?\s*$/;
  const BABY_LINE = /^(.+?)\s*\((\d+)(?:歳(\d+))?か月(\d+)日\)\s*$/;
  const TIME_LINE = /^(\d{1,2}):(\d{2})(.*)$/;

  function pad(n) { return String(n).padStart(2, "0"); }

  function parseEventBody(event, note) {
    const r = { type: "custom", amountMl: 0, leftMin: 0, rightMin: 0, customTitle: "", note: note || "" };
    let m;

    if ((m = event.match(/^ミルク(?:\s+(\d+)\s*ml)?/))) {
      r.type = "milk"; r.amountMl = Number(m[1] || 0); return r;
    }
    if ((m = event.match(/^搾母乳(?:\s+(\d+)\s*ml)?/))) {
      r.type = "expressed"; r.amountMl = Number(m[1] || 0); return r;
    }
    if ((m = event.match(/^搾乳(?:\s+(\d+)\s*ml)?/))) {
      r.type = "pump"; r.amountMl = Number(m[1] || 0); return r;
    }
    if (event.startsWith("母乳冷凍")) {
      r.type = "frozen";
      const inBody = event.match(/(\d+)\s*ml/) || (note || "").match(/(\d+)/);
      r.amountMl = Number(inBody ? inBody[1] : 0);
      if (inBody && note && note.match(/^\d+\s*(ml)?$/)) r.note = "";
      return r;
    }
    if (event.startsWith("母乳")) {
      r.type = "breast";
      const left = event.match(/左\s*(\d+)\s*分/);
      const right = event.match(/右\s*(\d+)\s*分/);
      r.leftMin = Number(left ? left[1] : 0);
      r.rightMin = Number(right ? right[1] : 0);
      return r;
    }
    if (event.startsWith("おしっこ")) { r.type = "pee"; return r; }
    if (event.startsWith("うんち")) {
      r.type = "poop";
      const attrs = event.match(/\(([^)]*)\)/);
      if (attrs) {
        const clean = attrs[1].replace(/[()]/g, "").split("/").filter(Boolean).join("・");
        r.note = r.note ? `${clean}｜${r.note}` : clean;
      }
      return r;
    }
    if (event.startsWith("寝る")) { r.type = "sleep"; return r; }
    if (event.startsWith("起きる")) {
      r.type = "wake";
      const dur = event.match(/\((?:(\d+)時間)?(\d+)分\)/);
      if (dur) r.amountMl = Number(dur[1] || 0) * 60 + Number(dur[2] || 0);
      else if (/\(\s*!\s*\)/.test(event)) r.note = r.note ? `覚醒中｜${r.note}` : "覚醒中";
      return r;
    }
    if ((m = event.match(/^体温\s*([\d.]+)/))) { r.type = "temperature"; r.amountMl = Number(m[1]); return r; }
    if ((m = event.match(/^体重\s*([\d.]+)/))) { r.type = "weight"; r.amountMl = Number(m[1]); return r; }
    if ((m = event.match(/^身長\s*([\d.]+)/))) { r.type = "height"; r.amountMl = Number(m[1]); return r; }
    if (event.startsWith("お風呂")) { r.type = "bath"; return r; }
    if (event.startsWith("保湿")) { r.type = "lotion"; return r; }
    if (event.startsWith("ゲップ")) { r.type = "burp"; return r; }
    if (event.startsWith("しゃっくり")) { r.type = "hiccup"; return r; }
    if (event.startsWith("タミータイム")) { r.type = "tummy"; return r; }
    if (event.startsWith("さんぽ") || event.startsWith("散歩")) { r.type = "walk"; return r; }
    if (event.startsWith("吐く") || event.startsWith("吐き戻し")) { r.type = "vomit"; return r; }
    if (event.startsWith("予防接種")) {
      r.type = "vaccine";
      const paren = event.match(/\(([^)]*)\)/);
      if (paren) r.note = r.note ? `${paren[1]}｜${r.note}` : paren[1];
      return r;
    }
    if (event.startsWith("メモ")) {
      r.type = "memo";
      const rest = event.replace(/^メモ\s*/, "");
      if (rest) r.note = r.note ? `${rest}｜${r.note}` : rest;
      return r;
    }
    if (MEDICINES.some((name) => event.startsWith(name))) {
      r.type = "medicine"; r.customTitle = event; return r;
    }
    r.type = "custom";
    r.customTitle = event;
    return r;
  }

  /** ぴよログのエクスポートテキスト全体をパースする */
  function parse(text, options) {
    const opts = options || {};
    const babyId = opts.babyId || "default";
    const nowIso = opts.nowIso || new Date().toISOString();
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");

    const records = [];
    const meta = { babyName: "", birthday: "", days: 0, skipped: [] };
    let currentDate = "";
    let lastRecord = null;
    let afterSummary = false;
    const idCounts = Object.create(null);

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      const trimmed = line.trim();
      if (!trimmed) { lastRecord = null; continue; }
      if (trimmed.startsWith("【ぴよログ】")) continue;
      if (/^-{4,}$/.test(trimmed)) { currentDate = ""; afterSummary = false; lastRecord = null; continue; }

      let m;
      if ((m = trimmed.match(DATE_LINE))) {
        currentDate = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
        meta.days += 1;
        afterSummary = false;
        lastRecord = null;
        continue;
      }
      if (currentDate && (m = trimmed.match(BABY_LINE))) {
        if (!meta.babyName) meta.babyName = m[1].trim();
        if (!meta.birthday && meta.babyName === m[1].trim()) {
          const years = m[3] !== undefined ? Number(m[2]) : 0;
          const months = m[3] !== undefined ? Number(m[3]) : Number(m[2]);
          const days = Number(m[4]);
          meta.birthday = subtractAge(currentDate, years, months, days);
        }
        continue;
      }
      if (SUMMARY_PREFIX.test(trimmed)) { afterSummary = true; lastRecord = null; continue; }

      if ((m = line.match(TIME_LINE)) && currentDate) {
        const time = `${pad(m[1])}:${m[2]}`;
        const body = m[3].replace(/^\s+/, "");
        const parts = body.split(/\s{3,}/).map((p) => p.trim()).filter(Boolean);
        const event = parts[0] || "";
        const note = parts.slice(1).join(" ");
        if (!event) continue;
        const parsed = parseEventBody(event, note);
        const key = `${currentDate}|${time}|${parsed.type}|${parsed.customTitle}`;
        idCounts[key] = (idCounts[key] || 0) + 1;
        const record = {
          id: `piyo-${currentDate}-${time.replace(":", "")}-${parsed.type}${idCounts[key] > 1 ? "-" + idCounts[key] : ""}${parsed.customTitle ? "-" + hashStr(parsed.customTitle) : ""}`,
          babyId,
          date: currentDate,
          time,
          type: parsed.type,
          amountMl: parsed.amountMl,
          leftMin: parsed.leftMin,
          rightMin: parsed.rightMin,
          note: parsed.note,
          createdAt: nowIso,
          updatedAt: nowIso,
          customTitle: parsed.customTitle
        };
        records.push(record);
        lastRecord = record;
        continue;
      }

      // 時刻で始まらない行: 直前レコードのメモ続き
      if (lastRecord && !afterSummary) {
        lastRecord.note = lastRecord.note ? `${lastRecord.note} ${trimmed}` : trimmed;
        continue;
      }
      meta.skipped.push(trimmed);
    }

    return { records, meta };
  }

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36).slice(0, 6);
  }

  /** date から (years歳)months か月 days日 を引いて誕生日を推定 */
  function subtractAge(dateStr, years, months, days) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    let date = new Date(Date.UTC(y, mo - 1, d));
    date.setUTCDate(date.getUTCDate() - days);
    let total = (date.getUTCFullYear() * 12 + date.getUTCMonth()) - (years * 12 + months);
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(Math.floor(total / 12), total % 12, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
  }

  /** 月齢表示 "1か月13日" */
  function formatAge(birthday, dateStr) {
    if (!birthday) return "";
    const [by, bm, bd] = birthday.split("-").map(Number);
    const [y, m, d] = dateStr.split("-").map(Number);
    let months = (y * 12 + (m - 1)) - (by * 12 + (bm - 1));
    let days = d - bd;
    if (days < 0) {
      months -= 1;
      const prevLast = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
      days += prevLast;
    }
    if (months < 0) return "";
    const yearsPart = Math.floor(months / 12);
    const monthsPart = months % 12;
    return yearsPart > 0 ? `${yearsPart}歳${monthsPart}か月${days}日` : `${monthsPart}か月${days}日`;
  }

  /** ぴよログ風テキストで1日分を書き出す */
  function exportDay(records, dateStr, babyName, birthday) {
    const dow = "日月火水木金土"[new Date(dateStr + "T00:00:00").getDay()];
    const dayRecords = records
      .filter((r) => r.date === dateStr)
      .sort((a, b) => a.time.localeCompare(b.time));
    const lines = [];
    lines.push(`${dateStr.replace(/-/g, "/")}(${dow})`);
    if (babyName) lines.push(`${babyName} (${formatAge(birthday, dateStr)})`);
    lines.push("");
    for (const r of dayRecords) {
      lines.push(`${r.time}   ${describeRecord(r)}${r.note ? "   " + r.note : ""}`);
    }
    lines.push("");
    const totals = summarize(dayRecords);
    lines.push(`母乳合計　　   左 ${totals.leftMin}分 / 右 ${totals.rightMin}分`);
    lines.push(`ミルク合計　   ${totals.milkCount}回 ${totals.milkMl}ml`);
    if (totals.expressedCount) lines.push(`搾母乳合計     ${totals.expressedCount}回 ${totals.expressedMl}ml`);
    lines.push(`睡眠合計　　   ${Math.floor(totals.sleepMin / 60)}時間${totals.sleepMin % 60}分`);
    lines.push(`おしっこ合計   ${totals.peeCount}回`);
    lines.push(`うんち合計　   ${totals.poopCount}回`);
    return lines.join("\n");
  }

  function describeRecord(r) {
    const t = TYPES[r.type] || TYPES.custom;
    switch (r.type) {
      case "milk": case "expressed": case "pump": case "frozen":
        return `${t.label} ${r.amountMl}ml`;
      case "breast": {
        const parts = [];
        if (r.leftMin) parts.push(`左 ${r.leftMin}分`);
        if (r.rightMin) parts.push(`右 ${r.rightMin}分`);
        return `母乳 ${parts.join(" / ") || "0分"}`;
      }
      case "wake": {
        if (r.amountMl > 0) return `起きる (${Math.floor(r.amountMl / 60)}時間${r.amountMl % 60}分)`;
        return "起きる";
      }
      case "temperature": return `体温 ${r.amountMl}°C`;
      case "weight": return `体重 ${r.amountMl}kg`;
      case "height": return `身長 ${r.amountMl}cm`;
      case "medicine": case "custom": return r.customTitle || t.label;
      default: return t.label;
    }
  }

  /** 日毎サマリー集計 */
  function summarize(dayRecords) {
    const s = {
      milkCount: 0, milkMl: 0,
      expressedCount: 0, expressedMl: 0,
      pumpCount: 0, pumpMl: 0,
      leftMin: 0, rightMin: 0, breastCount: 0,
      sleepMin: 0, peeCount: 0, poopCount: 0,
      feedMl: 0, feedCount: 0
    };
    for (const r of dayRecords) {
      switch (r.type) {
        case "milk": s.milkCount++; s.milkMl += r.amountMl; break;
        case "expressed": s.expressedCount++; s.expressedMl += r.amountMl; break;
        case "pump": s.pumpCount++; s.pumpMl += r.amountMl; break;
        case "breast": s.breastCount++; s.leftMin += r.leftMin; s.rightMin += r.rightMin; break;
        case "wake": s.sleepMin += r.amountMl; break;
        case "pee": s.peeCount++; break;
        case "poop": s.poopCount++; break;
      }
    }
    s.feedMl = s.milkMl + s.expressedMl;
    s.feedCount = s.milkCount + s.expressedCount + s.breastCount;
    return s;
  }

  /**
   * 睡眠ブロック復元: 寝る→次の起きる をペアにする。
   * 日をまたぐ睡眠にも対応するため、全レコードを時系列で走査する。
   * 戻り値: [{start: Date, end: Date, minutes}]
   */
  function sleepBlocks(records) {
    const events = records
      .filter((r) => r.type === "sleep" || r.type === "wake")
      .map((r) => ({ ...r, ts: new Date(`${r.date}T${r.time}:00`) }))
      .sort((a, b) => a.ts - b.ts || (a.type === "sleep" ? -1 : 1));
    const blocks = [];
    let sleepStart = null;
    for (const e of events) {
      if (e.type === "sleep") {
        sleepStart = e.ts;
      } else if (e.type === "wake") {
        let start = sleepStart;
        if (!start && e.amountMl > 0) start = new Date(e.ts.getTime() - e.amountMl * 60000);
        if (start && e.ts > start) {
          const minutes = Math.round((e.ts - start) / 60000);
          if (minutes > 0 && minutes < 24 * 60) blocks.push({ start, end: e.ts, minutes });
        }
        sleepStart = null;
      }
    }
    return blocks;
  }

  return { TYPES, parse, exportDay, summarize, sleepBlocks, formatAge, subtractAge, describeRecord };
});
