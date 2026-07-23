/* べびログ v2 メインアプリ */
(function () {
  "use strict";
  const P = window.PiyoParser;
  const S = window.Store;
  const TYPES = P.TYPES;
  const $ = (id) => document.getElementById(id);

  const CAT_CHIP = { feed: "var(--chip-feed)", sleep: "var(--chip-sleep)", diaper: "var(--chip-diaper)", care: "var(--chip-care)", health: "var(--chip-health)", memo: "var(--chip-memo)", mom: "var(--chip-feed)" };
  const CAT_DOT = { feed: "var(--c-milk)", sleep: "var(--cat-sleep)", diaper: "var(--cat-pee)", care: "var(--c-health)", health: "var(--c-health)", memo: "var(--ink-3)", mom: "var(--c-expressed)" };
  // 種類単位の上書き（おしっこ・うんちは同じ緑系で、うんちは少し深い緑）
  const TYPE_DOT = { pee: "var(--cat-pee)", poop: "var(--cat-poop)" };
  const dotFor = (type, cat) => TYPE_DOT[type] || CAT_DOT[cat];

  const POOP_ATTRS = {
    量: ["少量", "少なめ", "普通", "多め"],
    かたさ: ["柔らかめ", "普通", "硬め"],
    色: ["黄色", "緑", "茶色"]
  };
  // 旧表記（ぴよログ・過去の記録）も認識するためのエイリアス
  const POOP_ALIAS = { "ちょこっと": "少量", "ふつう": "普通", "やわらかめ": "柔らかめ", "かため": "硬め" };

  // ---------- state ----------
  let currentDate = todayStr();
  let currentView = "log";
  let weekStart = startOfWeek(currentDate);
  let period = "week"; // "week" | "month"
  let monthStart = currentDate.slice(0, 7) + "-01";
  let metric = "feed";
  let editingId = null;
  let sheetType = "milk";
  let toastTimer = null;
  let poopSel = { 量: "", かたさ: "", 色: "" };
  let sheetPhotos = []; // 記録シートに添付中の写真（写真レコードは最大3枚、他は1枚）
  let growthZoom = true; // 成長曲線: true=データがある範囲だけ / false=12か月

  // 数値記録の桁ルール: 体重は10g単位(小数第2位)まで、体温・身長は小数第1位まで
  const VALUE_SPEC = {
    temperature: { dec: 1, step: 0.1, ex: "36.5" },
    weight: { dec: 2, step: 0.01, ex: "4.52" },
    height: { dec: 1, step: 0.1, ex: "52.5" }
  };

  /** photoフィールド（"a.jpg|b.jpg" 形式）を配列に */
  const photoList = (p) => String(p || "").split("|").filter(Boolean);
  const maxPhotos = () => (sheetType === "photo" ? 3 : 1);

  // ---------- utils ----------
  function todayStr() { return toDateStr(new Date()); }
  function toDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  /** 5分単位に切り捨て（21:43 → 21:40） */
  function snap5(d) {
    const t = new Date(d);
    t.setMinutes(Math.floor(t.getMinutes() / 5) * 5, 0, 0);
    return t;
  }
  function toTimeStr(d) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function nowTimeStr() { return toTimeStr(snap5(new Date())); }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T12:00:00");
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }
  function startOfWeek(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return addDays(dateStr, -d.getDay());
  }
  function dowLabel(dateStr) { return "日月火水木金土"[new Date(dateStr + "T12:00:00").getDay()]; }
  function fmtDur(min) {
    if (min < 60) return `${min}分`;
    return `${Math.floor(min / 60)}時間${min % 60 ? (min % 60) + "分" : ""}`;
  }
  function fmtDurShort(min) {
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? String(min % 60) : ""}`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function ts(r) { return new Date(`${r.date}T${r.time}:00`); }
  function minutesBetween(a, b) { return Math.round((b - a) / 60000); }

  // ---------- toast ----------
  function toast(msg, actionLabel, onAction) {
    const el = $("toast"), btn = $("toastAction");
    $("toastMsg").textContent = msg;
    el.hidden = false;
    if (actionLabel && onAction) {
      btn.hidden = false;
      btn.textContent = actionLabel;
      btn.onclick = () => { onAction(); el.hidden = true; };
    } else btn.hidden = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  // ---------- record helpers ----------
  function recordValueText(r) {
    switch (r.type) {
      case "milk": case "expressed": case "pump": case "frozen":
        return r.amountMl ? `${r.amountMl}ml` : "";
      case "breast": {
        const parts = [];
        if (r.leftMin) parts.push(`左${r.leftMin}分`);
        if (r.rightMin) parts.push(`右${r.rightMin}分`);
        return parts.join(" ");
      }
      case "temperature": return r.amountMl ? `${r.amountMl}°C` : "";
      case "weight": return r.amountMl ? `${r.amountMl}kg` : "";
      case "height": return r.amountMl ? `${r.amountMl}cm` : "";
      default: return "";
    }
  }

  function isSleepingAt(when) {
    let last = null;
    for (const r of S.records) {
      if (r.type !== "sleep" && r.type !== "wake") continue;
      const t = ts(r);
      if (t <= when && (!last || t >= ts(last))) last = r;
    }
    return last && last.type === "sleep" ? last : null;
  }

  function lastOfTypes(types, when) {
    let best = null;
    for (const r of S.records) {
      if (!types.includes(r.type)) continue;
      const t = ts(r);
      if (t <= when && (!best || t > ts(best))) best = r;
    }
    return best;
  }

  /** 完了した睡眠ブロック＋進行中の睡眠（寝た〜いま）。日またぎのライブ集計用 */
  function allSleepBlocks() {
    const blocks = P.sleepBlocks(S.records).map((b) => ({ ...b, ongoing: false }));
    const now = new Date();
    const sleeping = isSleepingAt(now);
    if (sleeping) {
      const start = ts(sleeping);
      const minutes = Math.round((now - start) / 60000);
      if (minutes > 0 && minutes < 24 * 60) blocks.push({ start, end: now, minutes, ongoing: true });
    }
    return blocks;
  }

  function sleepMinutesOn(dateStr) {
    const dayStart = new Date(`${dateStr}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    let min = 0;
    for (const b of allSleepBlocks()) {
      const s = Math.max(b.start, dayStart);
      const e = Math.min(b.end, dayEnd);
      if (e > s) min += Math.round((e - s) / 60000);
    }
    return min;
  }

  // ---------- view switching ----------
  function switchView(view) {
    currentView = view;
    ["log", "album", "summary", "settings"].forEach((v) => { $(`view-${v}`).hidden = v !== view; });
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    $("quickRow").style.display = view === "log" ? "" : "none";
    render();
    if (view === "log") scrollTimelineToEnd();
    else window.scrollTo(0, 0);
  }

  /** 写真タイプの表示名: 呼び名があれば「はなの写真」「たろうの写真」、なければ「写真」 */
  function photoLabel() {
    const kana = (S.settings.babyKana || "").trim();
    if (!kana) return "写真";
    return kana.endsWith("の") ? `${kana}写真` : `${kana}の写真`;
  }

  // ---------- render: log ----------
  function render() {
    TYPES.photo.label = photoLabel(); // 種類名は呼び名に追従（タイムライン・その他メニュー・アルバム共通）
    if (currentView === "log") renderLog();
    else if (currentView === "album") renderAlbum();
    else if (currentView === "summary") renderSummary();
    else renderSettings();
  }

  // ---------- render: album (画像タブ) ----------
  function renderAlbum() {
    $("albumTitle").textContent = photoLabel() === "写真" ? "画像" : photoLabel();
    const body = $("albumBody");
    body.innerHTML = albumView();
    body.querySelectorAll(".album-item").forEach((f) =>
      f.addEventListener("click", () => {
        const rec = S.records.find((r) => r.id === f.dataset.rid);
        if (rec) openLightbox(photoList(rec.photo).map(photoSrc), Number(f.dataset.pi || 0), rec.note || "");
      }));
    body.querySelectorAll("[data-albumfilter]").forEach((b) =>
      b.addEventListener("click", () => { albumFilter = b.dataset.albumfilter; renderAlbum(); }));
  }

  function renderLog() {
    const s = S.settings;
    const isToday = currentDate === todayStr();
    const d = new Date(currentDate + "T12:00:00");
    $("dateMain").textContent = isToday ? "今日" : `${d.getMonth() + 1}/${d.getDate()}(${dowLabel(currentDate)})`;
    const age = s.birthday ? P.formatAge(s.birthday, currentDate) : "";
    const genderIcon = s.gender === "girl" ? "👧" : s.gender === "boy" ? "👦" : "";
    $("dateSub").textContent = [isToday ? `${d.getMonth() + 1}/${d.getDate()}(${dowLabel(currentDate)})` : "", s.babyName && age ? `${genderIcon}${s.babyName} ${age}` : ""].filter(Boolean).join("・");
    if (document.activeElement !== $("datePicker")) $("datePicker").value = currentDate;
    renderDaySummary();
    renderTimeline();
    renderQuickRow();
  }

  function renderDaySummary() {
    const day = S.byDate(currentDate);
    const t = P.summarize(day);
    const sleepMin = sleepMinutesOn(currentDate);
    const isToday = currentDate === todayStr();
    const now = new Date();

    // 「何分前か」を漢字で・改行しない長さに（6時間以上は分を省略）。今日以外は表示しない
    const durKanji = (min) => {
      if (min < 60) return `${min}分`;
      const h = Math.floor(min / 60), m = min % 60;
      return h < 6 && m ? `${h}時間${m}分` : `${h}時間`;
    };
    const agoKanji = (r) => {
      if (!r) return "—";
      return `${durKanji(Math.max(minutesBetween(ts(r), now), 0))}前`;
    };
    let feedSub = "", sleepSub = "", peeSub = "", poopSub = "";
    if (isToday) {
      feedSub = agoKanji(lastOfTypes(["milk", "expressed", "breast"], now));
      const sleeping = isSleepingAt(now);
      if (sleeping) {
        sleepSub = `💤 ${durKanji(Math.max(minutesBetween(ts(sleeping), now), 0))}`;
      } else {
        const lastWake = lastOfTypes(["wake"], now);
        sleepSub = lastWake ? `🌞 ${durKanji(Math.max(minutesBetween(ts(lastWake), now), 0))}` : "—";
      }
      peeSub = agoKanji(lastOfTypes(["pee"], now));
      poopSub = agoKanji(lastOfTypes(["poop"], now));
    }

    const metric = (kind, cat, label, value, sub) =>
      `<div class="metric" data-kind="${kind}" style="--cat:${cat}"><span class="m-label">${label}</span><span class="m-value">${value}</span>${sub ? `<span class="m-sub">${esc(sub)}</span>` : ""}</div>`;
    $("daySummary").innerHTML =
      metric("feed", CAT_DOT.feed, "🍼 ミルク", `${t.milkMl + t.expressedMl}<small>ml</small>`, feedSub) +
      metric("sleep", CAT_DOT.sleep, "😴 睡眠", `${Math.floor(sleepMin / 60)}<small>h</small>${sleepMin % 60 ? `${sleepMin % 60}<small>m</small>` : ""}`, sleepSub) +
      metric("pee", TYPE_DOT.pee, "💧 おしっこ", `${t.peeCount}<small>回</small>`, peeSub) +
      metric("poop", TYPE_DOT.poop, "💩 うんち", `${t.poopCount}<small>回</small>`, poopSub);
    $("daySummary").querySelectorAll(".metric").forEach((m) =>
      m.addEventListener("click", () => openDayDetail(m.dataset.kind)));
  }

  /** サマリーカードタップ → その日の詳細モーダル */
  function openDayDetail(kind) {
    const day = S.byDate(currentDate).slice().sort((a, b) => a.time.localeCompare(b.time));
    const t = P.summarize(day);
    const row = (time, text, extra) =>
      `<div class="detail-row"><span class="d-time">${esc(time)}</span><span class="d-text">${esc(text)}</span>${extra ? `<span class="d-extra">${esc(extra)}</span>` : ""}</div>`;
    let title = "", html = "";

    if (kind === "feed") {
      title = "🍼 ごはんの内訳";
      const parts = [];
      if (t.milkCount) parts.push(`ミルク ${t.milkCount}回 ${t.milkMl}ml`);
      if (t.expressedCount) parts.push(`搾母乳 ${t.expressedCount}回 ${t.expressedMl}ml`);
      if (t.breastCount) parts.push(`母乳 ${t.breastCount}回 左${t.leftMin}分/右${t.rightMin}分`);
      const feeds = day.filter((r) => ["milk", "expressed", "breast"].includes(r.type));
      html = `<p class="detail-total">${t.milkMl + t.expressedMl}<small>ml（ミルク＋搾母乳）</small></p>
        <p class="detail-sub">${esc(parts.join("　") || "記録なし")}</p>` +
        feeds.map((r) => row(r.time, TYPES[r.type].label, recordValueText(r))).join("");
    } else if (kind === "sleep") {
      title = "😴 睡眠の内訳";
      const dayStart = new Date(`${currentDate}T00:00:00`);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const blocks = allSleepBlocks()
        .map((b) => ({
          s: new Date(Math.max(b.start, dayStart)),
          e: new Date(Math.min(b.end, dayEnd)),
          live: b.ongoing && b.end <= dayEnd // 進行中で、この日の中に「いま」がある
        }))
        .filter((b) => b.e > b.s);
      const mins = blocks.map((b) => Math.round((b.e - b.s) / 60000));
      const total = mins.reduce((a, m) => a + m, 0);
      const longest = mins.reduce((a, m) => Math.max(a, m), 0);
      html = `<p class="detail-total">${fmtDur(total)}</p>
        <p class="detail-sub">${blocks.length}回${longest ? `・最長 ${fmtDur(longest)}` : ""}</p>` +
        blocks.map((b, i) => row(
          `${toTimeStr(b.s)}〜${b.live ? "" : toTimeStr(b.e)}`,
          fmtDur(mins[i]) + (b.live ? "（睡眠中）" : "")
        )).join("");
    } else {
      const type = kind;
      title = type === "pee" ? "💧 おしっこ" : "💩 うんち";
      const list = day.filter((r) => r.type === type);
      html = `<p class="detail-total">${list.length}<small>回</small></p>` +
        (list.map((r) => row(r.time, r.note || "−")).join("") || `<p class="detail-sub">記録なし</p>`);
    }
    $("detailTitle").textContent = title;
    $("detailBody").innerHTML = html;
    $("detailSheet").showModal();
  }

  /** 写真ライトボックス（複数枚対応: 矢印・スワイプ・ドットで切り替え） */
  let lightboxSrc = "";
  let lightboxList = [];
  let lightboxIdx = 0;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function updateLightbox() {
    lightboxSrc = lightboxList[lightboxIdx] || "";
    $("lightboxImg").src = lightboxSrc;
    const multi = lightboxList.length > 1;
    $("lightboxPrev").hidden = !multi;
    $("lightboxNext").hidden = !multi;
    $("lightboxDots").innerHTML = multi
      ? lightboxList.map((_, i) => `<i class="${i === lightboxIdx ? "on" : ""}"></i>`).join("")
      : "";
  }

  function stepLightbox(delta) {
    if (lightboxList.length < 2) return;
    lightboxIdx = (lightboxIdx + delta + lightboxList.length) % lightboxList.length;
    updateLightbox();
  }

  function openLightbox(srcOrList, idx = 0, caption = "") {
    lightboxList = (Array.isArray(srcOrList) ? srcOrList : [srcOrList]).filter(Boolean);
    if (!lightboxList.length) return;
    lightboxIdx = Math.min(Math.max(idx, 0), lightboxList.length - 1);
    $("lightboxCaption").textContent = caption;
    $("lightboxCaption").hidden = !caption;
    updateLightbox();
    // iOS: Webから写真アプリへ直接保存するAPIが無いため、保存ボタンは共有シートに統合し、
    // 長押し保存の案内を出す（画像長押し→「"写真"に追加」が最短ルート）
    $("lightboxSave").hidden = isIOS;
    $("lightboxHint").hidden = !isIOS;
    // シェア非対応環境ではボタンを隠す
    try {
      const probe = new File([""], "x.jpg", { type: "image/jpeg" });
      $("lightboxShare").hidden = !(navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch (_) { $("lightboxShare").hidden = true; }
    $("photoLightbox").showModal();
  }

  async function lightboxBlob() {
    // シェア・保存はJSでバイトを読むため、同一オリジンのストリーミング配信(?stream=1)を使う
    // （通常の表示は署名付きURLへのリダイレクトでCDNから直接配信される）
    const src = lightboxSrc.startsWith("/api/photo") ? `${lightboxSrc}&stream=1` : lightboxSrc;
    const res = await fetch(src);
    if (!res.ok) throw new Error("写真を取得できませんでした");
    return await res.blob();
  }

  async function saveLightboxPhoto() {
    try {
      const blob = await lightboxBlob();
      const file = new File([blob], `babylog-${currentDate}.jpg`, { type: blob.type || "image/jpeg" });
      // iPhone/iPadでは共有シートの「画像を保存」経由なら写真アプリに入る
      // （ダウンロードだと「ファイル」アプリに行ってしまうため）
      if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
        toast("「画像を保存」を選ぶと写真アプリに保存されます");
        await navigator.share({ files: [file] });
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `babylog-${currentDate}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (err) {
      if (err.name !== "AbortError") toast(`⚠️ ${err.message}`);
    }
  }

  async function shareLightboxPhoto() {
    try {
      const blob = await lightboxBlob();
      const file = new File([blob], `babylog-${currentDate}.jpg`, { type: blob.type || "image/jpeg" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        await saveLightboxPhoto();
      }
    } catch (err) {
      if (err.name !== "AbortError") toast(`⚠️ ${err.message}`);
    }
  }

  function renderTimeline() {
    const day = S.byDate(currentDate).slice().sort((a, b) => a.time.localeCompare(b.time));
    $("timelineEmpty").hidden = day.length > 0;
    // 「前回から何分ぶりか」を計算（日またぎ対応）。授乳はまとめて、おしっこ・うんちはそれぞれ同種で比較
    // 24時間を超えても表示する（うんちが1日以上あくのは普通にあるので）
    const gapMap = new Map();
    const addGaps = (types) => {
      const list = S.records.filter((r) => types.includes(r.type));
      for (let i = 1; i < list.length; i++) {
        const gap = minutesBetween(ts(list[i - 1]), ts(list[i]));
        if (gap > 0) gapMap.set(list[i].id, gap);
      }
    };
    addGaps(["milk", "expressed", "breast"]);
    addGaps(["pee"]);
    addGaps(["poop"]);
    const feedGap = gapMap;
    // 24時間以上は「1日3時間ぶり」形式で
    const fmtGap = (min) => {
      if (min >= 1440) {
        const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
        return `${d}日${h ? h + "時間" : ""}`;
      }
      return fmtDur(min);
    };
    // 前のレコードとの時間差に応じて行間を少し空ける（平方根スケール・上限26px）
    const gapSpace = (min) => (min <= 10 ? 0 : Math.min(26, Math.round(Math.sqrt(min - 10) * 1.9)));
    $("timeline").innerHTML = day.map((r, i) => {
      const t = TYPES[r.type] || TYPES.custom;
      const value = recordValueText(r);
      let dur = "";
      if (r.type === "wake" && r.amountMl) dur = `<span class="tl-dur">${fmtDur(r.amountMl)}寝た</span>`;
      else if (feedGap.has(r.id)) dur = `<span class="tl-gap">${fmtGap(feedGap.get(r.id))}ぶり</span>`;
      const title = r.type === "custom" || r.type === "medicine" ? (r.customTitle || t.label) : t.label;
      const space = i > 0 ? gapSpace(minutesBetween(ts(day[i - 1]), ts(r))) : 0;
      // 写真: 複数枚はサムネを少し重ねて表示、枚数バッジ付き
      const pl = photoList(r.photo);
      const pBase = r.type === "photo" ? 72 : 34;
      const pShown = Math.min(pl.length, 3);
      const photo = pl.length
        ? `<span class="tl-photos" data-id="${esc(r.id)}" style="width:${pBase + (pShown - 1) * 12}px;height:${pBase}px">
            ${pl.slice(0, 3).map((p, pi) => `<img src="${esc(photoSrc(p))}" loading="lazy" alt="写真" style="width:${pBase}px;height:${pBase}px;left:${pi * 12}px;z-index:${3 - pi}">`).join("")}
            ${pl.length > 1 ? `<span class="tl-photo-count">${pl.length}</span>` : ""}
          </span>`
        : "";
      // 同じ時間帯の2件目以降は薄く表示（時間の区切りを見やすく）
      const sameHour = i > 0 && day[i - 1].time.slice(0, 2) === r.time.slice(0, 2);
      const timeLabel = `<span class="tl-time${sameHour ? " minor" : ""}">${r.time}</span>`;
      const dot = dotFor(r.type, t.cat);
      return `<li${space ? ` style="margin-top:${space}px"` : ""}>
        ${timeLabel}
        <span class="tl-rail" style="--dot:${dot}"></span>
        <div class="tl-card" data-id="${esc(r.id)}"${r.type === "photo" && pl.length ? " data-photo-big" : ""} style="--chip:${CAT_CHIP[t.cat]};--cat:${dot}">
          <span class="tl-icon">${t.icon}</span>
          <div class="tl-main">
            <div class="tl-title">${esc(title)} ${value ? `<span class="tl-value">${esc(value)}</span>` : ""} ${dur}</div>
            ${r.note ? `<div class="tl-note">${esc(r.note)}</div>` : ""}
          </div>
          ${photo}
        </div>
      </li>`;
    }).join("");
    $("timeline").querySelectorAll(".tl-card").forEach((card) => {
      card.addEventListener("click", () => openEdit(card.dataset.id));
    });
    drawSleepSpans(day);
    // 写真タップは編集ではなくライトボックスで表示（複数枚はスワイプ/矢印で切り替え）
    $("timeline").querySelectorAll(".tl-photos").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const rec = day.find((r) => r.id === el.dataset.id);
        if (rec) openLightbox(photoList(rec.photo).map(photoSrc), 0, rec.note || "");
      });
    });
  }

  /** 寝る→起きるの間を蛍光ペン風のラインでつなぐ（日をまたぐ睡眠・進行中の睡眠にも対応） */
  function drawSleepSpans(day) {
    const tl = $("timeline");
    tl.querySelectorAll(".sleep-span").forEach((el) => el.remove());
    const lis = [...tl.children].filter((el) => el.tagName === "LI");
    if (!lis.length) return;
    const tlRect = tl.getBoundingClientRect();
    const dotY = (li) => li.querySelector(".tl-rail").getBoundingClientRect().top - tlRect.top + 15; // 丸の中心
    const spans = [];
    const dayStart = new Date(`${currentDate}T00:00:00`);
    // 前日から寝たまま日をまたいだ場合は、いちばん上から線を引く
    let openY = allSleepBlocks().some((b) => b.start < dayStart && b.end > dayStart) ? 0 : null;
    day.forEach((r, i) => {
      if (!lis[i]) return;
      if (r.type === "sleep") openY = dotY(lis[i]);
      else if (r.type === "wake" && openY != null) { spans.push([openY, dotY(lis[i])]); openY = null; }
    });
    // 起きる記録がまだ無い（睡眠中 or 翌日に続く）→ 下に少しはみ出して「続いている」感を出す
    if (openY != null) {
      const endY = lis[lis.length - 1].getBoundingClientRect().bottom - tlRect.top;
      spans.push([openY, endY + 22]);
    }
    const railLeft = lis[0].querySelector(".tl-rail").getBoundingClientRect().left - tlRect.left;
    for (const [y1, y2] of spans) {
      if (y2 - y1 < 8) continue;
      const el = document.createElement("li");
      el.className = "sleep-span";
      el.style.top = `${y1}px`;
      el.style.height = `${y2 - y1}px`;
      el.style.left = `${railLeft - 1}px`;
      tl.appendChild(el);
    }
  }

  function scrollTimelineToEnd() {
    if (currentDate === todayStr()) {
      requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
    } else window.scrollTo(0, 0);
  }

  // ---------- quick row ----------
  function renderQuickRow() {
    if (S.cloud.readonly) {
      $("quickRow").innerHTML = `<p class="readonly-note">👀 閲覧モードで見ています（記録はできません）</p>`;
      return;
    }
    if (S.cloud.photoOnly) {
      $("quickRow").innerHTML = `<p class="readonly-note">📷 写真モード（日付の横の📷から写真を追加できます）</p>`;
      return;
    }
    const sleeping = !!isSleepingAt(new Date());
    const quicks = S.settings.quickTypes.map((k) => {
      if (k === "sleepToggle") {
        return { key: "sleepToggle", icon: sleeping ? "🌞" : "😴", label: sleeping ? "起きた" : "寝た", cls: sleeping ? "sleeping" : "", cat: "sleep" };
      }
      const t = TYPES[k] || TYPES.custom;
      return { key: k, icon: t.icon, label: t.label, cat: t.cat, type: k };
    });
    quicks.push({ key: "other", icon: "➕", label: "その他", cat: "memo" });
    $("quickRow").innerHTML = quicks.map((q) =>
      `<button class="quick ${q.cls || ""}" data-quick="${q.key}" type="button" style="--cat:${dotFor(q.type, q.cat)}"><span class="q-icon">${q.icon}</span><span class="q-label">${q.label}</span></button>`
    ).join("");
    $("quickRow").querySelectorAll(".quick").forEach((b) => b.addEventListener("click", () => quickAction(b.dataset.quick)));
  }

  function quickAction(key) {
    if (key === "other") return openTypeSheet();
    if (key === "sleepToggle") return openSheet(isSleepingAt(new Date()) ? "wake" : "sleep");
    openSheet(key);
  }

  // ---------- record sheet ----------
  function openSheet(type, record) {
    if (S.cloud.readonly) { toast("👀 閲覧用パスコードのため、記録・編集はできません"); return; }
    if (S.cloud.photoOnly && type !== "photo") { toast("📷 この合言葉では写真だけ記録できます"); return; }
    sheetType = type;
    editingId = record ? record.id : null;
    const t = TYPES[type] || TYPES.custom;
    $("sheetBadge").textContent = `${t.icon} ${record ? t.label + "を編集" : t.label}`;
    $("recDate").value = record ? record.date : (currentDate <= todayStr() ? currentDate : todayStr());
    $("recTime").value = record ? record.time : nowTimeStr();
    $("recNote").value = record ? stripPoopAttrs(record) : "";
    $("recDelete").hidden = !record;

    const showAmount = ["milk", "expressed", "pump", "frozen"].includes(type);
    $("secAmount").hidden = !showAmount;
    if (showAmount) {
      $("amountLabel").textContent = `${t.label}の量 (ml)`;
      // 初期量: 設定値 > 前回入力した量 > 100
      const def = Number(S.settings.defaultAmounts[type]) || S.settings.lastAmounts[type] || 100;
      $("recAmount").value = record ? (record.amountMl || "") : def;
    }
    $("secBreast").hidden = type !== "breast";
    if (type === "breast") {
      $("recLeft").value = record ? record.leftMin || 0 : 5;
      $("recRight").value = record ? record.rightMin || 0 : 5;
    }
    const isValue = ["temperature", "weight", "height"].includes(type);
    $("secValue").hidden = !isValue;
    if (isValue) {
      $("valueLabel").textContent = `${t.label} (${t.unit})`;
      $("recValue").step = String(VALUE_SPEC[type].step);
      $("recValue").placeholder = `例: ${VALUE_SPEC[type].ex}`;
      $("recValue").value = record ? record.amountMl || "" : "";
    }
    $("secPoop").hidden = type !== "poop";
    if (type === "poop") {
      poopSel = parsePoopAttrs(record ? record.note : "");
      renderPoopChips();
    }
    const isTitle = ["medicine", "custom", "vaccine"].includes(type);
    $("secTitle").hidden = !isTitle;
    if (isTitle) $("recTitle").value = record ? record.customTitle || "" : "";

    sheetPhotos = record ? photoList(record.photo) : [];
    $("photoStatus").hidden = true;
    recError("");
    renderPhotoPreview();
    renderTimeChips();
    $("recordSheet").showModal();
  }

  // 時刻調整ボタン: 「いま」はリセット、「−5分/−30分」は押すたびに引かれる（日またぎ対応）
  function renderTimeChips() {
    $("timeChips").innerHTML = `
      <button type="button" class="time-btn" data-act="now">いま</button>
      <button type="button" class="time-btn" data-act="shift" data-delta="-5">−5分</button>
      <button type="button" class="time-btn" data-act="shift" data-delta="-30">−30分</button>
      <button type="button" class="time-btn" data-act="shift" data-delta="5">＋5分</button>`;
    $("timeChips").querySelectorAll(".time-btn").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.act === "now") {
        const d = snap5(new Date());
        $("recDate").value = toDateStr(d);
        $("recTime").value = toTimeStr(d);
      } else {
        shiftRecTime(Number(b.dataset.delta));
      }
    }));
  }

  /** いまの入力値から分単位でずらす（日またぎ対応） */
  function shiftRecTime(deltaMin) {
    let d = new Date(`${$("recDate").value}T${$("recTime").value}:00`);
    if (isNaN(d.getTime())) d = snap5(new Date());
    else d.setMinutes(d.getMinutes() + deltaMin);
    $("recDate").value = toDateStr(d);
    $("recTime").value = toTimeStr(d);
  }

  function renderPoopChips() {
    $("poopChips").innerHTML = Object.entries(POOP_ATTRS).map(([group, values]) =>
      `<div class="poop-group"><span class="pg-label">${group}</span><div class="pg-chips">${
        values.map((v) => `<button type="button" class="chip ${poopSel[group] === v ? "active" : ""}" data-g="${group}" data-v="${v}">${v}</button>`).join("")
      }</div></div>`
    ).join("");
    $("poopChips").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
      const g = c.dataset.g;
      poopSel[g] = poopSel[g] === c.dataset.v ? "" : c.dataset.v;
      renderPoopChips();
    }));
  }

  function parsePoopAttrs(note) {
    const sel = { 量: "", かたさ: "", 色: "" };
    const head = String(note || "").split("｜")[0];
    for (const raw of head.split("・")) {
      const part = POOP_ALIAS[raw] || raw;
      for (const [g, values] of Object.entries(POOP_ATTRS)) {
        if (values.includes(part) && !sel[g]) { sel[g] = part; break; }
      }
    }
    return sel;
  }

  function stripPoopAttrs(record) {
    if (record.type !== "poop") return record.note || "";
    const segs = String(record.note || "").split("｜");
    const attrs = parsePoopAttrs(record.note);
    const hasAttrs = Object.values(attrs).some(Boolean);
    return hasAttrs ? segs.slice(1).join("｜") : record.note || "";
  }

  /** 記録シート内にエラーを表示（トーストはモーダルの後ろに隠れて見えないため） */
  function recError(msg) {
    $("recError").textContent = msg;
    $("recError").hidden = !msg;
  }

  function saveSheet(e) {
    e.preventDefault();
    recError("");
    // アップロード中に登録すると写真なしで保存されてしまうため待ってもらう
    if (photoUploading) {
      recError("⏳ 写真をアップロード中です。終わったら登録できます");
      return;
    }
    const type = sheetType;
    const rec = {
      id: editingId || undefined,
      type,
      date: $("recDate").value,
      time: $("recTime").value,
      note: $("recNote").value.trim(),
      amountMl: 0, leftMin: 0, rightMin: 0, customTitle: ""
    };
    if (!rec.date || !rec.time) { recError("⚠️ 日付と時刻を入れてください"); return; }
    if (["milk", "expressed", "pump", "frozen"].includes(type)) rec.amountMl = Number($("recAmount").value || 0);
    if (type === "breast") { rec.leftMin = Number($("recLeft").value || 0); rec.rightMin = Number($("recRight").value || 0); }
    if (["temperature", "weight", "height"].includes(type)) {
      const spec = VALUE_SPEC[type];
      const v = $("recValue").value.trim();
      if (v && !new RegExp(`^\\d+(\\.\\d{1,${spec.dec}})?$`).test(v)) {
        recError(`⚠️ ${TYPES[type].label}は小数第${spec.dec}位まで入力できます（例: ${spec.ex}）`);
        return;
      }
      rec.amountMl = Number(v || 0);
    }
    if (type === "poop") {
      const attrs = ["量", "かたさ", "色"].map((g) => poopSel[g]).filter(Boolean).join("・");
      rec.note = [attrs, rec.note].filter(Boolean).join("｜");
    }
    if (["medicine", "custom", "vaccine"].includes(type)) rec.customTitle = $("recTitle").value.trim();
    if (type === "wake") rec.amountMl = wakeDuration(rec);
    rec.photo = sheetPhotos.join("|");
    const saved = S.upsert(rec);
    $("recordSheet").close();
    if (saved.date !== currentDate && currentView === "log") { currentDate = saved.date; render(); }
    toast(`${TYPES[type].icon} ${editingId ? "更新しました" : "記録しました"}`, "取り消す", () => S.remove(saved.id));
    editingId = null;
  }

  // ---------- 写真 ----------
  /** record.photo → 表示用URL（プライベートBlobは認証つき中継APIを通す） */
  function photoSrc(p) {
    if (!p) return "";
    if (/^https?:/.test(p)) return p; // 旧・公開ストア形式のURL
    return `/api/photo?pathname=${encodeURIComponent(p)}&t=${encodeURIComponent(S.settings.syncToken)}`;
  }

  // 読み込みに失敗した写真のプレースホルダー（無料枠の一時制限・オフライン時など）
  const BROKEN_PHOTO_SVG = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
    '<rect width="96" height="96" rx="14" fill="#888" opacity="0.14"/>' +
    '<text x="48" y="52" font-size="32" text-anchor="middle" opacity="0.55">📷</text>' +
    '<text x="48" y="74" font-size="10" text-anchor="middle" fill="#888">タップで案内</text></svg>'
  );

  /** 写真が表示できないときの案内モーダル（Driveのバックアップへ誘導） */
  function openPhotoErr() {
    const folderId = (S.settings.driveFolderId || "").trim();
    const link = $("photoErrDrive");
    link.hidden = !folderId;
    if (folderId) link.href = `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
    $("photoErrDriveNote").textContent = folderId
      ? "バックアップ済みの写真は、Googleドライブのフォルダからいつでも見られます（家族が開くにはフォルダの共有設定が必要です）。"
      : "設定タブの「写真バックアップ先のDriveフォルダ」を設定しておくと、ここからバックアップの写真を開けます。";
    $("photoErrDialog").showModal();
  }

  function renderPhotoPreview() {
    const wrap = $("photoPreviewWrap");
    wrap.hidden = !sheetPhotos.length;
    wrap.innerHTML = sheetPhotos.map((p, i) => `
      <span class="photo-thumb">
        <img src="${esc(photoSrc(p))}" alt="添付写真" data-pi="${i}">
        <button type="button" class="photo-remove" data-rm="${i}" aria-label="写真を外す">×</button>
      </span>`).join("");
    const max = maxPhotos();
    const full = sheetPhotos.length >= max;
    // 写真レコードは追加式（最大3枚）、他の種類は1枚を差し替え式
    $("recPhotoFile").disabled = sheetType === "photo" && full;
    $("photoBtnLabel").textContent = !sheetPhotos.length
      ? "📷 写真をつける"
      : sheetType === "photo"
        ? (full ? "📷 3枚まで登録できます" : `📷 写真を追加（あと${max - sheetPhotos.length}枚）`)
        : "📷 写真を変更";
  }

  /** 画像を長辺1280pxのJPEGに縮小 */
  function resizeImage(file, maxDim = 1280) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を変換できませんでした"))), "image/jpeg", 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
      img.src = url;
    });
  }

  let photoUploading = false;

  /** アップロード中は登録ボタンを止める（写真なしで保存されるのを防ぐ） */
  function setUploadingUI(on) {
    photoUploading = on;
    const btn = $("recSave");
    btn.disabled = on;
    btn.textContent = on ? "⏳ 写真をアップロード中…" : "登録";
  }

  async function uploadPhoto(file) {
    const status = $("photoStatus");
    status.hidden = false;
    if (!S.settings.syncToken) {
      status.textContent = "⚠️ 写真を使うには設定で同期パスコードを入れてください";
      return;
    }
    setUploadingUI(true);
    try {
      status.textContent = "📤 写真を縮小してアップロード中...";
      const blob = await resizeImage(file);
      const res = await fetch("/api/photo", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-App-Token": S.settings.syncToken },
        body: blob
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `アップロード失敗 (${res.status})`);
      const p = data.pathname || data.url;
      if (sheetType === "photo") {
        if (sheetPhotos.length < maxPhotos()) sheetPhotos.push(p);
      } else {
        sheetPhotos = [p]; // 写真以外は1枚を差し替え
      }
      renderPhotoPreview();
      status.hidden = true;
    } catch (err) {
      status.textContent = `⚠️ ${err.message}`;
    } finally {
      setUploadingUI(false);
    }
  }

  /** 起きる記録の睡眠時間: 直前の「寝る」からの経過分（間に別の起きるが挟まっていれば0） */
  function wakeDuration(rec) {
    const wakeTs = new Date(`${rec.date}T${rec.time}:00`);
    let lastSleep = null, lastWake = null;
    for (const r of S.records) {
      if (r.id === rec.id) continue;
      const t = ts(r);
      if (t > wakeTs) continue;
      if (r.type === "sleep" && (!lastSleep || t > ts(lastSleep))) lastSleep = r;
      if (r.type === "wake" && (!lastWake || t > ts(lastWake))) lastWake = r;
    }
    if (!lastSleep) return 0;
    if (lastWake && ts(lastWake) > ts(lastSleep)) return 0; // すでに起きている
    const min = minutesBetween(ts(lastSleep), wakeTs);
    return min > 0 && min < 24 * 60 ? min : 0;
  }

  function openEdit(id) {
    const rec = S.records.find((r) => r.id === id);
    if (rec) openSheet(rec.type, rec);
  }

  // ---------- type sheet ----------
  const TYPE_SHEET_KEYS = ["photo", "pump", "frozen", "bath", "lotion", "burp", "hiccup", "tummy", "walk", "temperature", "weight", "height", "medicine", "vaccine", "vomit", "memo", "custom"];

  /** 設定の並び順（不正キーは除外し、足りないものは既定順で後ろに補完） */
  function orderedTypeKeys() {
    const saved = (S.settings.typeOrder || []).filter((k) => TYPE_SHEET_KEYS.includes(k));
    return [...saved, ...TYPE_SHEET_KEYS.filter((k) => !saved.includes(k))];
  }

  function openTypeSheet() {
    const keys = orderedTypeKeys();
    $("typeGrid").innerHTML = keys.map((k) =>
      `<button type="button" class="type-cell" data-type="${k}"><span class="q-icon">${TYPES[k].icon}</span><span class="q-label">${TYPES[k].label}</span></button>`
    ).join("");
    $("typeGrid").querySelectorAll(".type-cell").forEach((c) => c.addEventListener("click", () => {
      $("typeSheet").close();
      openSheet(c.dataset.type);
    }));
    $("typeSheet").showModal();
  }

  // ---------- summary ----------
  function weekDays() {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }

  function periodDays() {
    if (period === "month") {
      const [y, m] = monthStart.split("-").map(Number);
      const n = new Date(y, m, 0).getDate();
      return Array.from({ length: n }, (_, i) => `${y}-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
    }
    return weekDays();
  }

  /** 月表示のとき、x軸ラベルを間引く（1,5,10,…日だけ） */
  function showAxisLabel(d, days) {
    if (days.length <= 7) return true;
    const day = Number(d.slice(8, 10));
    return day === 1 || day % 5 === 0;
  }

  function renderSummary() {
    const days = periodDays();
    if (period === "month") {
      const [y, m] = monthStart.split("-").map(Number);
      $("weekLabel").textContent = `${y}年${m}月`;
    } else {
      const s = new Date(weekStart + "T12:00:00");
      const e = new Date(days[6] + "T12:00:00");
      $("weekLabel").textContent = `${s.getMonth() + 1}/${s.getDate()} 〜 ${e.getMonth() + 1}/${e.getDate()}`;
    }
    $("periodSub").textContent = period === "month" ? "月のまとめ" : "週のまとめ";
    if (document.activeElement !== $("weekPicker")) $("weekPicker").value = period === "month" ? monthStart : weekStart;
    document.querySelectorAll("#periodToggle .seg").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
    document.querySelectorAll("#summaryTabs .seg").forEach((b) => b.classList.toggle("active", b.dataset.metric === metric));
    const body = $("summaryBody");
    if (metric === "feed") body.innerHTML = feedChart(days) + feedStatChart(days) + feedTable(days);
    else if (metric === "sleep") body.innerHTML = sleepChart(days) + sleepTrendChart(days);
    else if (metric === "diaper") body.innerHTML = diaperChart(days) + diaperTable(days);
    else body.innerHTML = healthView(days);
    body.querySelectorAll("[data-addtype]").forEach((b) =>
      b.addEventListener("click", () => openSheet(b.dataset.addtype)));
    body.querySelectorAll("[data-growthzoom]").forEach((b) =>
      b.addEventListener("click", () => { growthZoom = b.dataset.growthzoom === "1"; renderSummary(); }));
  }

  // アルバム: 写真つき記録を月ごとのグリッドで一覧。
  // フィルタは「写真」＋実際に写真がある種類だけを動的に表示する。
  let albumFilter = "photo";
  function albumView() {
    const withPhoto = S.records.filter((r) => r.photo).slice().reverse();
    const counts = new Map();
    withPhoto.forEach((r) => counts.set(r.type, (counts.get(r.type) || 0) + photoList(r.photo).length));
    const keys = ["photo", ...[...counts.keys()].filter((k) => k !== "photo").sort((a, b) => counts.get(b) - counts.get(a))];
    if (!keys.includes(albumFilter)) albumFilter = "photo";
    const chips = `<div class="album-filter">${keys.map((k) => {
      const label = k === "photo" ? photoLabel() : `${(TYPES[k] || {}).icon || ""}${(TYPES[k] || {}).label || k}`;
      return `<button type="button" class="chip${albumFilter === k ? " active" : ""}" data-albumfilter="${k}">${label}</button>`;
    }).join("")}</div>`;
    const photos = withPhoto.filter((r) => r.type === albumFilter);
    if (!photos.length) {
      return chips + `<div class="chart-card"><h3 class="chart-title">📷 アルバム</h3>
        <p class="chart-sub">「${esc(photoLabel())}」の登録がまだありません。記録タブの日付横の📷ボタンから追加できます。うんちなどの記録に添付した写真も、登録されるとここに種類ごとのタブで並びます。</p></div>`;
    }
    const byMonth = new Map();
    photos.forEach((r) => {
      const m = r.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      photoList(r.photo).forEach((p, pi) => byMonth.get(m).push({ r, p, pi }));
    });
    return chips + [...byMonth.entries()].map(([m, list]) => {
      const [y, mo] = m.split("-");
      return `<div class="chart-card"><h3 class="chart-title">${y}年${Number(mo)}月</h3>
        <div class="album-grid">${list.map(({ r, p, pi }) => `
          <figure class="album-item" data-rid="${esc(r.id)}" data-pi="${pi}">
            <img src="${esc(photoSrc(p))}" loading="lazy" alt="${esc(r.date)}の写真">
            <figcaption>
              <span class="a-day">${Number(r.date.slice(8, 10))}日</span>
              ${r.note ? `<span class="a-note">${esc(r.note)}</span>` : ""}
            </figcaption>
          </figure>`).join("")}</div></div>`;
    }).join("");
  }

  function dayLabel(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // 食事: 積み上げ棒 (ミルク + 搾母乳)、合計を直接ラベル
  function feedChart(days) {
    const W = 520, H = 240, padL = 14, padR = 14, padT = 26, padB = 34;
    const sums = days.map((d) => P.summarize(S.byDate(d)));
    const max = Math.max(200, ...sums.map((t) => t.milkMl + t.expressedMl));
    const bw = (W - padL - padR) / days.length;
    let bars = "";
    days.forEach((d, i) => {
      const t = sums[i];
      const x = padL + i * bw + bw * 0.18;
      const w = bw * 0.64;
      const hMilk = (t.milkMl / max) * (H - padT - padB);
      const hExp = (t.expressedMl / max) * (H - padT - padB);
      const yMilk = H - padB - hMilk;
      const yExp = yMilk - 2 - hExp;
      const rx = days.length > 7 ? 2 : 4;
      if (t.milkMl) bars += `<rect x="${x}" y="${yMilk}" width="${w}" height="${hMilk}" rx="${rx}" fill="var(--c-milk)"/>`;
      if (t.expressedMl) bars += `<rect x="${x}" y="${yExp}" width="${w}" height="${hExp}" rx="${rx}" fill="var(--c-expressed)"/>`;
      const total = t.milkMl + t.expressedMl;
      if (total && days.length <= 7) bars += `<text x="${x + w / 2}" y="${Math.min(yExp, yMilk) - 6}" text-anchor="middle" class="bar-total">${total}</text>`;
      if (showAxisLabel(d, days)) bars += `<text x="${padL + i * bw + bw / 2}" y="${H - padB + 14}" text-anchor="middle" class="axis-text${d === todayStr() ? '" font-weight="700' : ""}">${days.length > 7 ? Number(d.slice(8, 10)) : dayLabel(d)}</text>`;
      const bm = t.leftMin + t.rightMin;
      if (bm && days.length <= 7) bars += `<text x="${padL + i * bw + bw / 2}" y="${H - padB + 28}" text-anchor="middle" class="axis-text" fill="var(--c-breast)">🤱${bm}分</text>`;
    });
    const baseline = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--line)" stroke-width="1"/>`;
    return `<div class="chart-card">
      <h3 class="chart-title">1日の飲んだ量 (ml)</h3>
      <p class="chart-sub">棒の数字は合計。下段は直接母乳の分数。</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日別の授乳量">${baseline}${bars}</svg>
      <div class="legend">
        <span><i style="background:var(--c-milk)"></i>ミルク</span>
        <span><i style="background:var(--c-expressed)"></i>搾母乳</span>
        <span><i style="background:var(--c-breast)"></i>母乳(分)</span>
      </div>
    </div>`;
  }

  // 食事: 1回あたりの量(棒) × 回数(折れ線)。量は増えて回数は減る、が見える
  function feedStatChart(days) {
    const W = 520, H = 220, padL = 14, padR = 14, padT = 26, padB = 24;
    const sums = days.map((d) => P.summarize(S.byDate(d)));
    const counts = sums.map((t) => t.feedCount);
    const avgs = sums.map((t) => {
      const c = t.milkCount + t.expressedCount;
      return c ? Math.round((t.milkMl + t.expressedMl) / c) : 0;
    });
    const maxC = Math.max(8, ...counts);
    const maxA = Math.max(140, ...avgs);
    const bw = (W - padL - padR) / days.length;
    const yC = (v) => H - padB - (v / maxC) * (H - padT - padB);
    const yA = (v) => H - padB - (v / maxA) * (H - padT - padB);
    const week = days.length <= 7;
    let bars = "", line = "", dots = "";
    const pts = [];
    days.forEach((d, i) => {
      const cx = padL + i * bw + bw / 2;
      if (avgs[i]) {
        const x = padL + i * bw + bw * 0.22;
        bars += `<rect x="${x}" y="${yA(avgs[i])}" width="${bw * 0.56}" height="${H - padB - yA(avgs[i])}" rx="${week ? 4 : 1.5}" fill="var(--c-milk)" opacity="0.45"/>`;
        if (week) bars += `<text x="${cx}" y="${yA(avgs[i]) - 5}" text-anchor="middle" class="bar-label">${avgs[i]}</text>`;
      }
      if (counts[i]) pts.push({ x: cx, y: yC(counts[i]), v: counts[i] });
      if (showAxisLabel(d, days)) bars += `<text x="${cx}" y="${H - padB + 15}" text-anchor="middle" class="axis-text${d === todayStr() ? '" font-weight="700' : ""}">${week ? dayLabel(d) : Number(d.slice(8, 10))}</text>`;
    });
    if (pts.length) {
      line = `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
      dots = pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="${week ? 3.5 : 2}" fill="var(--accent)"/>${week ? `<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" class="bar-label" fill="var(--accent)">${p.v}回</text>` : ""}`).join("");
    }
    const baseline = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--line)" stroke-width="1"/>`;
    return `<div class="chart-card">
      <h3 class="chart-title">1回あたりの量と回数</h3>
      <p class="chart-sub">棒＝ミルク・搾母乳の1回あたりの量、折れ線＝授乳の回数（母乳含む）。棒が伸びて折れ線が下がってくると、一度にたくさん飲めるようになってきたサインです。</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="1回あたりの量と回数">${baseline}${bars}${line}${dots}</svg>
      <div class="legend"><span><i style="background:var(--c-milk);opacity:0.6"></i>1回あたり (ml)</span><span><i style="background:var(--accent)"></i>回数</span></div>
    </div>`;
  }

  function feedTable(days) {
    const rows = days.map((d) => {
      const t = P.summarize(S.byDate(d));
      const cls = d === todayStr() ? ' class="today-row"' : "";
      return `<tr${cls}><td>${dayLabel(d)}(${dowLabel(d)})</td><td>${t.milkMl || "−"}</td><td>${t.expressedMl || "−"}</td><td><b>${t.milkMl + t.expressedMl || "−"}</b></td><td>${t.feedCount || "−"}</td><td>${t.leftMin + t.rightMin || "−"}</td></tr>`;
    }).join("");
    return `<div class="chart-card"><h3 class="chart-title">日別テーブル</h3>
      <table class="stat-table"><thead><tr><th>日付</th><th>ミルク</th><th>搾母乳</th><th>合計ml</th><th>回数</th><th>母乳分</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // 睡眠: 7日 × 24時間 ガント
  function sleepChart(days) {
    const W = 520, H = 430, padL = 30, padR = 12, padT = 10, padB = 48;
    const colW = (W - padL - padR) / days.length;
    const hourH = (H - padT - padB) / 24;
    const blocks = allSleepBlocks(); // 進行中の睡眠もガントに出す
    let grid = "";
    for (let h = 0; h <= 24; h += 3) {
      const y = padT + h * hourH;
      grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
      grid += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" class="axis-text">${h}</text>`;
    }
    let bars = "", labels = "";
    days.forEach((d, i) => {
      const dayStart = new Date(`${d}T00:00:00`);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const x = padL + i * colW + colW * 0.14;
      const w = colW * 0.72;
      let total = 0;
      for (const b of blocks) {
        const s = Math.max(b.start, dayStart);
        const e = Math.min(b.end, dayEnd);
        if (e <= s) continue;
        const mins = Math.round((e - s) / 60000);
        total += mins;
        const y = padT + ((s - dayStart) / 3600000) * hourH;
        const hh = Math.max((mins / 60) * hourH, 2);
        bars += `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="4" fill="var(--c-sleep)"/>`;
      }
      if (showAxisLabel(d, days)) labels += `<text x="${padL + i * colW + colW / 2}" y="${H - padB + 16}" text-anchor="middle" class="axis-text${d === todayStr() ? '" font-weight="700' : ""}">${days.length > 7 ? Number(d.slice(8, 10)) : dayLabel(d)}</text>`;
      if (total && days.length <= 7) labels += `<text x="${padL + i * colW + colW / 2}" y="${H - padB + 32}" text-anchor="middle" class="bar-label">${fmtDurShort(total)}</text>`;
    });
    return `<div class="chart-card">
      <h3 class="chart-title">ねんねの時間帯</h3>
      <p class="chart-sub">縦軸は0〜24時。列の下は睡眠合計。</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日別の睡眠時間帯">${grid}${bars}${labels}</svg>
    </div>`;
  }

  // 睡眠: 合計(棒) × いちばん長いねんね(折れ線)。まとまって寝られるようになってきたかが見える
  function sleepTrendChart(days) {
    const W = 520, H = 220, padL = 14, padR = 14, padT = 26, padB = 24;
    const blocks = allSleepBlocks();
    const totals = [], longests = [];
    for (const d of days) {
      const dayStart = new Date(`${d}T00:00:00`);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      let total = 0, longest = 0;
      for (const b of blocks) {
        const s = Math.max(b.start, dayStart);
        const e = Math.min(b.end, dayEnd);
        if (e <= s) continue;
        const mins = Math.round((e - s) / 60000);
        total += mins;
        longest = Math.max(longest, mins);
      }
      totals.push(total); longests.push(longest);
    }
    const maxT = Math.max(12 * 60, ...totals);
    const bw = (W - padL - padR) / days.length;
    const yT = (v) => H - padB - (v / maxT) * (H - padT - padB);
    const week = days.length <= 7;
    let bars = "", line = "", dots = "";
    const pts = [];
    days.forEach((d, i) => {
      const cx = padL + i * bw + bw / 2;
      if (totals[i]) {
        const x = padL + i * bw + bw * 0.22;
        bars += `<rect x="${x}" y="${yT(totals[i])}" width="${bw * 0.56}" height="${H - padB - yT(totals[i])}" rx="${week ? 4 : 1.5}" fill="var(--c-sleep)" opacity="0.4"/>`;
        if (week) bars += `<text x="${cx}" y="${yT(totals[i]) - 5}" text-anchor="middle" class="bar-label">${fmtDurShort(totals[i])}</text>`;
      }
      if (longests[i]) pts.push({ x: cx, y: yT(longests[i]), v: longests[i] });
      if (showAxisLabel(d, days)) bars += `<text x="${cx}" y="${H - padB + 15}" text-anchor="middle" class="axis-text${d === todayStr() ? '" font-weight="700' : ""}">${week ? dayLabel(d) : Number(d.slice(8, 10))}</text>`;
    });
    if (pts.length) {
      line = `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
      dots = pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="${week ? 3.5 : 2}" fill="var(--accent)"/>${week ? `<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" class="bar-label" fill="var(--accent)">${fmtDurShort(p.v)}</text>` : ""}`).join("");
    }
    const baseline = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--line)" stroke-width="1"/>`;
    return `<div class="chart-card">
      <h3 class="chart-title">睡眠合計と最長ねんね</h3>
      <p class="chart-sub">棒＝1日の睡眠合計、折れ線＝いちばん長く続けて寝た時間。折れ線が伸びてくると、まとまって寝られるようになってきたサインです。</p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="睡眠合計と最長ねんね">${baseline}${bars}${line}${dots}</svg>
      <div class="legend"><span><i style="background:var(--c-sleep);opacity:0.55"></i>合計</span><span><i style="background:var(--accent)"></i>最長ねんね</span></div>
    </div>`;
  }

  // 排泄: グループ棒
  function diaperChart(days) {
    const W = 520, H = 220, padL = 14, padR = 14, padT = 24, padB = 22;
    const sums = days.map((d) => P.summarize(S.byDate(d)));
    const max = Math.max(6, ...sums.map((t) => Math.max(t.peeCount, t.poopCount)));
    const bw = (W - padL - padR) / days.length;
    let bars = "";
    days.forEach((d, i) => {
      const t = sums[i];
      const gx = padL + i * bw;
      const w = bw * 0.28;
      const hPee = (t.peeCount / max) * (H - padT - padB);
      const hPoop = (t.poopCount / max) * (H - padT - padB);
      const rx = days.length > 7 ? 1.5 : 4;
      if (t.peeCount) {
        bars += `<rect x="${gx + bw * 0.16}" y="${H - padB - hPee}" width="${w}" height="${hPee}" rx="${rx}" fill="var(--c-pee)"/>`;
        if (days.length <= 7) bars += `<text x="${gx + bw * 0.16 + w / 2}" y="${H - padB - hPee - 5}" text-anchor="middle" class="bar-label">${t.peeCount}</text>`;
      }
      if (t.poopCount) {
        bars += `<rect x="${gx + bw * 0.16 + w + 2}" y="${H - padB - hPoop}" width="${w}" height="${hPoop}" rx="${rx}" fill="var(--c-poop)"/>`;
        if (days.length <= 7) bars += `<text x="${gx + bw * 0.16 + w + 2 + w / 2}" y="${H - padB - hPoop - 5}" text-anchor="middle" class="bar-label">${t.poopCount}</text>`;
      }
      if (showAxisLabel(d, days)) bars += `<text x="${gx + bw / 2}" y="${H - padB + 15}" text-anchor="middle" class="axis-text${d === todayStr() ? '" font-weight="700' : ""}">${days.length > 7 ? Number(d.slice(8, 10)) : dayLabel(d)}</text>`;
    });
    const baseline = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--line)" stroke-width="1"/>`;
    return `<div class="chart-card">
      <h3 class="chart-title">おむつ回数</h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="日別のおむつ回数">${baseline}${bars}</svg>
      <div class="legend"><span><i style="background:var(--c-pee)"></i>おしっこ</span><span><i style="background:var(--c-poop)"></i>うんち</span></div>
    </div>`;
  }

  function diaperTable(days) {
    const rows = days.map((d) => {
      const t = P.summarize(S.byDate(d));
      const poops = S.byDate(d).filter((r) => r.type === "poop" && r.note).map((r) => r.note.split("｜")[0]).filter(Boolean);
      const cls = d === todayStr() ? ' class="today-row"' : "";
      return `<tr${cls}><td>${dayLabel(d)}(${dowLabel(d)})</td><td>${t.peeCount || "−"}</td><td>${t.poopCount || "−"}</td><td>${esc(poops.join(", "))}</td></tr>`;
    }).join("");
    return `<div class="chart-card"><h3 class="chart-title">日別テーブル</h3>
      <table class="stat-table"><thead><tr><th>日付</th><th>💧</th><th>💩</th><th>うんちのようす</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // 健康: 体温チャート + 体重・身長推移（出生時の値を起点に） + 最近の健康記録
  function healthView(days) {
    const s = S.settings;
    const temps = S.records.filter((r) => r.type === "temperature" && r.amountMl > 0);
    const withBirth = (type, birthValue) => {
      const list = S.records.filter((r) => r.type === type && r.amountMl > 0);
      if (s.birthday && Number(birthValue) > 0) {
        return [{ date: s.birthday, amountMl: Number(birthValue) }, ...list.filter((r) => r.date !== s.birthday)];
      }
      return list;
    };
    const weights = withBirth("weight", s.birthWeight);
    const heights = withBirth("height", s.birthHeight);
    const others = S.records.filter((r) => ["medicine", "vaccine"].includes(r.type)).slice(-15).reverse();
    let html = `<div class="chart-card"><h3 class="chart-title">はかったら記録</h3>
      <div class="btn-row">
        <button class="btn secondary" type="button" data-addtype="weight">⚖️ 体重</button>
        <button class="btn secondary" type="button" data-addtype="height">📏 身長</button>
        <button class="btn secondary" type="button" data-addtype="temperature">🌡️ 体温</button>
      </div>
      <div class="zoom-row">
        <span class="zoom-label">成長曲線の範囲</span>
        <button type="button" class="chip${growthZoom ? " active" : ""}" data-growthzoom="1">いままでの分だけ</button>
        <button type="button" class="chip${!growthZoom ? " active" : ""}" data-growthzoom="0">1歳まで</button>
      </div></div>`;
    html += growthChart("体重 (kg)", "weight", weights, "var(--c-pee)");
    html += growthChart("身長 (cm)", "height", heights, "var(--c-sleep)");
    html += measurementTable(weights, heights, temps);
    html += lineChart("体温 (°C)", temps.filter((r) => days.includes(r.date)).length ? temps.filter((r) => days.includes(r.date)) : temps.slice(-14), (r) => r.amountMl, "°C", 35, 39, "var(--c-health)");
    html += `<div class="chart-card"><h3 class="chart-title">くすり・予防接種など</h3>
      <table class="stat-table"><tbody>${
        others.map((r) => `<tr><td>${dayLabel(r.date)} ${r.time}</td><td>${TYPES[r.type].icon} ${esc(r.customTitle || TYPES[r.type].label)}</td><td>${esc(r.note || "")}</td></tr>`).join("") || `<tr><td>記録なし</td></tr>`
      }</tbody></table></div>`;
    return html;
  }

  /** 計測値の一覧: グラフだけだと正確な値と日付が読み取れないので表でも出す */
  function measurementTable(weights, heights, temps) {
    const rows = [
      ...weights.map((r) => ({ date: r.date, label: "⚖️ 体重", value: `${r.amountMl} kg` })),
      ...heights.map((r) => ({ date: r.date, label: "📏 身長", value: `${r.amountMl} cm` })),
      ...temps.map((r) => ({ date: r.date, label: "🌡️ 体温", value: `${r.amountMl} °C` }))
    ].sort((a, b) => b.date.localeCompare(a.date));
    if (!rows.length) return "";
    const s = S.settings;
    const html = rows.map((r) => {
      const age = s.birthday ? P.formatAge(s.birthday, r.date) : "";
      const isBirth = r.date === s.birthday;
      return `<tr><td>${dayLabel(r.date)}${isBirth ? "（出生時）" : ""}</td><td>${r.label}</td><td><b>${esc(String(r.value))}</b></td><td>${esc(age)}</td></tr>`;
    }).join("");
    return `<div class="chart-card"><h3 class="chart-title">計測の記録</h3>
      <table class="stat-table"><thead><tr><th>日付</th><th>種類</th><th>値</th><th>月齢</th></tr></thead><tbody>${html}</tbody></table></div>`;
  }

  /** 成長曲線: 厚労省系パーセンタイル帯(3〜97)を背景に、計測値をプロット */
  function growthChart(title, kind, records, color) {
    const s = S.settings;
    const G = window.GrowthData;
    const gender = s.gender === "boy" ? "boy" : s.gender === "girl" ? "girl" : "";
    if (!s.birthday) {
      return `<div class="chart-card"><h3 class="chart-title">${esc(title)}</h3><p class="chart-sub">設定で生年月日を入れると成長曲線が表示されます</p></div>`;
    }
    const ageM = (dateStr) => Math.max(0, (new Date(dateStr + "T00:00:00") - new Date(s.birthday + "T00:00:00")) / 86400000 / 30.4375);
    const points = records.map((r) => ({ m: ageM(r.date), v: r.amountMl })).filter((p) => p.v > 0);
    const nowM = ageM(todayStr());
    const dataMax = Math.max(nowM, ...points.map((p) => p.m), 0);
    // ズーム時はデータがある範囲＋少しだけ先を表示（最低2か月分）
    const maxM = growthZoom
      ? Math.max(2, Math.ceil(dataMax * 2) / 2 + 0.5)
      : Math.max(12, Math.ceil(dataMax) + 1);
    const band = gender ? G[gender][kind].filter((row) => row[0] <= maxM + 3) : null;

    const W = 520, H = 260, padL = 40, padR = 18, padT = 12, padB = 26;
    let vMin = Infinity, vMax = -Infinity;
    if (band) band.forEach((row) => { if (row[0] <= maxM + 0.5) { vMin = Math.min(vMin, row[1]); vMax = Math.max(vMax, row[3]); } });
    points.forEach((p) => { vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v); });
    if (!isFinite(vMin)) {
      return `<div class="chart-card"><h3 class="chart-title">${esc(title)}</h3><p class="chart-sub">記録がありません（その他 → ${kind === "weight" ? "体重" : "身長"} から記録できます）</p></div>`;
    }
    const pad = (vMax - vMin) * 0.06 + 0.1;
    vMin -= pad; vMax += pad;
    const x = (m) => padL + (m / maxM) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB);

    // グリッド（月齢）
    let grid = "";
    const step = maxM > 14 ? 3 : 1;
    for (let m = 0; m <= maxM; m += step) {
      grid += `<line x1="${x(m)}" y1="${padT}" x2="${x(m)}" y2="${H - padB}" stroke="var(--line)" stroke-width="1"/>
               <text x="${x(m)}" y="${H - padB + 14}" text-anchor="middle" class="axis-text">${m}</text>`;
    }
    const vStep = (vMax - vMin) > 20 ? 10 : (vMax - vMin) > 8 ? 2 : 1;
    for (let v = Math.ceil(vMin / vStep) * vStep; v <= vMax; v += vStep) {
      grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>
               <text x="${padL - 5}" y="${y(v) + 3}" text-anchor="end" class="axis-text">${v}</text>`;
    }

    // パーセンタイル帯 (3〜97) + 中央値(50)の破線
    let bandSvg = "";
    if (band) {
      const clipped = band.filter((row) => row[0] <= maxM + 0.5);
      if (clipped.length && clipped[clipped.length - 1][0] < maxM) {
        clipped.push([maxM, ...G.at(gender, kind, maxM)]);
      }
      const upper = clipped.map((row) => `${x(Math.min(row[0], maxM)).toFixed(1)},${y(row[3]).toFixed(1)}`);
      const lower = clipped.slice().reverse().map((row) => `${x(Math.min(row[0], maxM)).toFixed(1)},${y(row[1]).toFixed(1)}`);
      bandSvg += `<polygon points="${[...upper, ...lower].join(" ")}" fill="${color}" opacity="0.16"/>`;
      const median = clipped.map((row, i) => `${i ? "L" : "M"}${x(Math.min(row[0], maxM)).toFixed(1)},${y(row[2]).toFixed(1)}`).join(" ");
      bandSvg += `<path d="${median}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.55"/>`;
    }

    // 計測値
    const sorted = points.slice().sort((a, b) => a.m - b.m);
    const path = sorted.map((p, i) => `${i ? "L" : "M"}${x(p.m).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const dots = sorted.map((p) => {
      const nearLeft = x(p.m) < padL + 16;
      return `<circle cx="${x(p.m)}" cy="${y(p.v)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
       <text x="${x(p.m) + (nearLeft ? 7 : 0)}" y="${y(p.v) - 8}" text-anchor="${nearLeft ? "start" : "middle"}" class="bar-label">${p.v}</text>`;
    }).join("");

    const genderNote = gender ? "" : `<p class="chart-sub">⚠️ 設定で性別を入れるとパーセンタイル帯が表示されます</p>`;
    return `<div class="chart-card">
      <h3 class="chart-title">${esc(title)} — 成長曲線</h3>
      <p class="chart-sub">横軸は月齢。帯は3〜97パーセンタイル、破線は中央値（${esc(window.GrowthData.source)}）</p>
      ${genderNote}
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}の成長曲線">${grid}${bandSvg}${sorted.length > 1 ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>` : ""}${dots}</svg>
    </div>`;
  }

  function lineChart(title, records, getVal, unit, fixedMin, fixedMax, color) {
    if (!records.length) {
      return `<div class="chart-card"><h3 class="chart-title">${esc(title)}</h3><p class="chart-sub">記録がありません</p></div>`;
    }
    const W = 520, H = 200, padL = 38, padR = 18, padT = 14, padB = 26;
    const vals = records.map(getVal);
    const min = fixedMin ?? Math.min(...vals) - 0.3;
    const max = fixedMax ?? Math.max(...vals) + 0.3;
    const x = (i) => padL + (records.length === 1 ? (W - padL - padR) / 2 : (i / (records.length - 1)) * (W - padL - padR));
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
    let grid = "";
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = min + ((max - min) / steps) * i;
      grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>
               <text x="${padL - 5}" y="${y(v) + 3}" text-anchor="end" class="axis-text">${v.toFixed(1)}</text>`;
    }
    const path = records.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(getVal(r)).toFixed(1)}`).join(" ");
    const dots = records.map((r, i) =>
      `<circle cx="${x(i)}" cy="${y(getVal(r))}" r="4" fill="${color}"/>
       <text x="${x(i)}" y="${y(getVal(r)) - 8}" text-anchor="middle" class="bar-label">${getVal(r)}</text>
       <text x="${x(i)}" y="${H - padB + 14}" text-anchor="middle" class="axis-text">${dayLabel(r.date)}</text>`
    ).join("");
    return `<div class="chart-card"><h3 class="chart-title">${esc(title)}</h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>${dots}</svg></div>`;
  }

  // ---------- settings ----------
  function renderSettings() {
    const s = S.settings;
    if (document.activeElement !== $("setBabyName")) $("setBabyName").value = s.babyName;
    if (document.activeElement !== $("setBabyKana")) $("setBabyKana").value = s.babyKana || "";
    if (document.activeElement !== $("setBirthday")) $("setBirthday").value = s.birthday;
    if (document.activeElement !== $("setGender")) $("setGender").value = s.gender || "";
    if (document.activeElement !== $("setBirthWeight")) $("setBirthWeight").value = s.birthWeight || "";
    if (document.activeElement !== $("setBirthHeight")) $("setBirthHeight").value = s.birthHeight || "";
    if (document.activeElement !== $("setSyncToken")) $("setSyncToken").value = s.syncToken;
    if (document.activeElement !== $("setSheetUrl")) $("setSheetUrl").value = s.sheetUrl;
    if (document.activeElement !== $("setDriveFolder")) $("setDriveFolder").value = s.driveFolderId || "";
    $("driveFolderHint").textContent = `指定すると、バックアップのたびに写真が「${photoLabel()}」「うんち」など種類ごとのサブフォルダへ保存されます。`;
    if (document.activeElement !== $("setDefMilk")) $("setDefMilk").value = s.defaultAmounts.milk || "";
    if (document.activeElement !== $("setDefExpressed")) $("setDefExpressed").value = s.defaultAmounts.expressed || "";
    renderQuickSelects();
    renderTypeOrderList();
    $("dataCount").textContent = `${S.records.length}件の記録がこの端末に保存されています。`;
    renderCloudStatus();
    applyReadonlyToSettings();
  }

  /** 閲覧・写真モード: 同期パスコード（切り替え用）以外の設定を触れなくする */
  function applyReadonlyToSettings() {
    const ro = !!S.cloud.readonly || !!S.cloud.photoOnly;
    document.querySelectorAll("#view-settings input, #view-settings select, #view-settings textarea, #view-settings button").forEach((el) => {
      if (el.closest("#syncGroup")) return; // パスコード変更と「今すぐ同期」は常に使える
      el.disabled = ro;
    });
    $("readonlyNote").textContent = S.cloud.photoOnly
      ? "📷 写真モードのため、設定の変更はできません（同期パスコードのみ変更できます）"
      : "👀 閲覧モードのため、設定の変更はできません（同期パスコードのみ変更できます）";
    $("readonlyNote").hidden = !ro;
  }

  /** クイック6枠のプルダウン */
  function renderQuickSelects() {
    const wrap = $("quickSelects");
    if (wrap.contains(document.activeElement)) return; // 操作中は再構築しない
    const optionsHtml = (selected) =>
      `<option value="sleepToggle"${selected === "sleepToggle" ? " selected" : ""}>😴 寝た・起きた（トグル）</option>` +
      Object.keys(TYPES).map((k) =>
        `<option value="${k}"${selected === k ? " selected" : ""}>${TYPES[k].icon} ${TYPES[k].label}</option>`).join("");
    wrap.innerHTML = S.settings.quickTypes.map((sel, i) =>
      `<label class="qs-row"><span class="qs-num">${i + 1}</span><select data-qi="${i}">${optionsHtml(sel)}</select></label>`
    ).join("");
  }

  /** 「その他」メニューの並び順リスト */
  function renderTypeOrderList() {
    const keys = orderedTypeKeys();
    $("typeOrderList").innerHTML = keys.map((k, i) =>
      `<div class="order-row">
        <span class="order-label">${TYPES[k].icon} ${TYPES[k].label}</span>
        <button type="button" class="order-up" data-k="${k}" ${i === 0 ? "disabled" : ""} aria-label="上へ">↑</button>
      </div>`).join("");
  }

  function renderCloudStatus() {
    const c = S.cloud;
    const el = $("cloudStatus");
    if (!el) return;
    if (c.status === "off") { el.textContent = "未設定ならこの端末の中だけに保存されます。"; return; }
    const last = c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
    if (c.status === "syncing") el.textContent = "🔄 同期中...";
    else if (c.status === "error") el.textContent = `⚠️ ${c.message}${S.pendingCount ? `（未送信${S.pendingCount}件・自動で再送します）` : ""}`;
    else if (c.readonly) el.textContent = `👀 閲覧モード（見るだけ・記録はできません）${last ? `（最終 ${last}）` : ""}`;
    else if (c.photoOnly) el.textContent = `📷 写真モード（写真の追加だけできます）${last ? `（最終 ${last}）` : ""}`;
    else el.textContent = `✅ 自動同期オン${last ? `（最終 ${last}）` : ""}${S.pendingCount ? ` 未送信${S.pendingCount}件` : ""}`;
  }

  function importTexts(texts) {
    let added = 0, updated = 0, isJson = false;
    for (const text of texts) {
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const data = JSON.parse(trimmed);
          const list = Array.isArray(data) ? data : data.records || [];
          const res = S.merge(list);
          added += res.added; updated += res.updated;
          if (data.settings) S.updateSettings({ babyName: data.settings.babyName || S.settings.babyName, birthday: data.settings.birthday || S.settings.birthday });
          isJson = true;
          continue;
        } catch (_) { /* fallthrough to piyo */ }
      }
      const { records, meta } = P.parse(text, { babyId: S.settings.babyId });
      const res = S.merge(records);
      added += res.added; updated += res.updated;
      const patch = {};
      if (!S.settings.babyName && meta.babyName) patch.babyName = meta.babyName;
      if (!S.settings.birthday && meta.birthday) patch.birthday = meta.birthday;
      if (Object.keys(patch).length) S.updateSettings(patch);
    }
    $("importStatus").textContent = `取り込み完了: 追加 ${added}件 / 更新 ${updated}件${isJson ? "（JSON）" : ""}`;
    toast(`📥 ${added}件を取り込みました`);
    render();
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- swipe ----------
  function bindSwipe(el, onLeft, onRight) {
    let sx = 0, sy = 0, tracking = false;
    el.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; tracking = true;
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      // 横に70px以上、かつ縦スクロールより明確に横方向のときだけ
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        (dx < 0 ? onLeft : onRight)();
      }
    }, { passive: true });
  }

  // ---------- wire up ----------
  function bind() {
    bindSwipe($("view-log"),
      () => { currentDate = addDays(currentDate, 1); render(); window.scrollTo(0, 0); },
      () => { currentDate = addDays(currentDate, -1); render(); window.scrollTo(0, 0); });
    bindSwipe($("view-summary"),
      () => { weekStart = addDays(weekStart, 7); render(); },
      () => { weekStart = addDays(weekStart, -7); render(); });

    $("prevDay").addEventListener("click", () => { currentDate = addDays(currentDate, -1); render(); });
    $("nextDay").addEventListener("click", () => { currentDate = addDays(currentDate, 1); render(); });
    $("headPhoto").addEventListener("click", () => openSheet("photo"));
    // 日付タイトル: 透明の日付入力がタイトルに重なっていて、タップが直接入力に当たる
    // （iOSはこれで確実にネイティブのカレンダーが開く。PCはclick時にshowPickerで補助）
    const assistPicker = (e) => { try { if (e.target.showPicker) e.target.showPicker(); } catch (_) { /* iOSはネイティブで開くので無視 */ } };
    $("datePicker").addEventListener("click", assistPicker);
    $("weekPicker").addEventListener("click", assistPicker);
    $("datePicker").addEventListener("change", () => { if ($("datePicker").value) { currentDate = $("datePicker").value; render(); } });

    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

    const shiftMonth = (delta) => {
      const [y, m] = monthStart.split("-").map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    };
    $("prevWeek").addEventListener("click", () => { period === "month" ? shiftMonth(-1) : (weekStart = addDays(weekStart, -7)); render(); });
    $("nextWeek").addEventListener("click", () => { period === "month" ? shiftMonth(1) : (weekStart = addDays(weekStart, 7)); render(); });
    $("weekPicker").addEventListener("change", () => {
      const v = $("weekPicker").value;
      if (!v) return;
      weekStart = startOfWeek(v);
      monthStart = v.slice(0, 7) + "-01";
      render();
    });
    document.querySelectorAll("#periodToggle .seg").forEach((b) => b.addEventListener("click", () => { period = b.dataset.period; render(); }));
    document.querySelectorAll("#summaryTabs .seg").forEach((b) => b.addEventListener("click", () => { metric = b.dataset.metric; render(); }));

    $("detailClose").addEventListener("click", () => $("detailSheet").close());
    // ライトボックス: ボタン以外をタップで閉じる
    // 写真・ボタン類以外（背景や余白）をタップしたら閉じる。スワイプ中の誤タップで閉じないよう画像は除外
    $("photoLightbox").addEventListener("click", (e) => {
      if (!e.target.closest("#lightboxImg, .lightbox-actions, .lightbox-nav, .lightbox-dots, .lightbox-caption")) {
        $("photoLightbox").close();
      }
    });
    $("lightboxClose").addEventListener("click", () => $("photoLightbox").close());
    $("lightboxSave").addEventListener("click", saveLightboxPhoto);
    $("lightboxShare").addEventListener("click", shareLightboxPhoto);
    if (isIOS) {
      // iOSはシェアボタンが保存も兼ねる（共有シートの「画像を保存」で写真アプリへ）
      $("lightboxShare").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>シェア・保存`;
    }
    $("lightboxPrev").addEventListener("click", (e) => { e.stopPropagation(); stepLightbox(-1); });
    $("lightboxNext").addEventListener("click", (e) => { e.stopPropagation(); stepLightbox(1); });
    // スワイプで前後の写真へ
    let lbTouchX = null;
    $("photoLightbox").addEventListener("touchstart", (e) => { lbTouchX = e.touches[0].clientX; }, { passive: true });
    $("photoLightbox").addEventListener("touchend", (e) => {
      if (lbTouchX == null) return;
      const dx = e.changedTouches[0].clientX - lbTouchX;
      lbTouchX = null;
      if (Math.abs(dx) > 40) stepLightbox(dx < 0 ? 1 : -1);
    }, { passive: true });

    // 写真の読み込み失敗 → プレースホルダーに差し替え（タップでDrive案内モーダル）
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || img.dataset.broken) return;
      const ours = String(img.src || "").includes("/api/photo") ||
        img.closest(".tl-photos, .a-ph, .photo-thumb, #photoLightbox, .d-photos");
      if (!ours) return;
      img.dataset.broken = "1";
      img.src = BROKEN_PHOTO_SVG;
      img.classList.add("photo-broken");
    }, true);
    document.addEventListener("click", (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.dataset.broken) {
        e.preventDefault();
        e.stopPropagation();
        openPhotoErr();
      }
    }, true);
    $("photoErrClose").addEventListener("click", () => $("photoErrDialog").close());

    // モーダルの外側（背景）タップで閉じる
    ["recordSheet", "typeSheet", "welcomeSheet", "detailSheet", "photoErrDialog"].forEach((id) => {
      const dlg = $(id);
      dlg.addEventListener("click", (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) dlg.close();
      });
    });

    $("recordForm").addEventListener("submit", saveSheet);
    $("recPhotoFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) uploadPhoto(file);
      e.target.value = "";
    });
    // 添付プレビュー: ✕で外す、サムネタップでモーダル表示
    $("photoPreviewWrap").addEventListener("click", (e) => {
      const rm = e.target.closest(".photo-remove");
      if (rm) {
        sheetPhotos.splice(Number(rm.dataset.rm), 1);
        renderPhotoPreview();
        return;
      }
      const img = e.target.closest("img[data-pi]");
      if (img) openLightbox(sheetPhotos.map(photoSrc), Number(img.dataset.pi), $("recNote").value.trim());
    });
    $("sheetClose").addEventListener("click", () => $("recordSheet").close());
    $("typeClose").addEventListener("click", () => $("typeSheet").close());
    $("recDelete").addEventListener("click", () => {
      if (!editingId) return;
      const removed = S.remove(editingId);
      $("recordSheet").close();
      editingId = null;
      if (removed) toast("🗑 削除しました", "取り消す", () => S.upsert(removed));
    });
    document.querySelectorAll(".stepper .step[data-delta]").forEach((b) => b.addEventListener("click", () => {
      const input = $(b.dataset.target || "recAmount");
      input.value = Math.max(0, Number(input.value || 0) + Number(b.dataset.delta));
    }));

    $("saveProfile").addEventListener("click", () => {
      S.updateSettings({
        babyName: $("setBabyName").value.trim(),
        babyKana: $("setBabyKana").value.trim(),
        birthday: $("setBirthday").value,
        gender: $("setGender").value,
        birthWeight: $("setBirthWeight").value.trim(),
        birthHeight: $("setBirthHeight").value.trim()
      });
      toast("✅ 保存しました");
    });

    $("importFile").addEventListener("change", async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const texts = await Promise.all(files.map((f) => f.text()));
      importTexts(texts);
      e.target.value = "";
    });
    $("importPaste").addEventListener("click", () => {
      const text = $("importText").value;
      if (!text.trim()) { $("importStatus").textContent = "テキストを貼り付けてください。"; return; }
      importTexts([text]);
      $("importText").value = "";
    });

    $("exportJson").addEventListener("click", () => {
      download(`babylog-backup-${todayStr()}.json`, JSON.stringify({ settings: { babyName: S.settings.babyName, birthday: S.settings.birthday }, records: S.records }, null, 1), "application/json");
    });
    $("exportCsv").addEventListener("click", () => {
      const head = "id,babyId,date,time,type,amountMl,leftMin,rightMin,note,createdAt,updatedAt,customTitle";
      const rows = S.records.map((r) => [r.id, r.babyId, r.date, r.time, r.type, r.amountMl, r.leftMin, r.rightMin, r.note, r.createdAt, r.updatedAt, r.customTitle]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
      download(`babylog-${todayStr()}.csv`, "﻿" + [head, ...rows].join("\n"), "text/csv");
    });
    $("exportTxt").addEventListener("click", () => {
      const dates = [...new Set(S.records.map((r) => r.date))].sort();
      const out = dates.map((d) => P.exportDay(S.records, d, S.settings.babyName, S.settings.birthday)).join("\n\n----------\n");
      download(`babylog-piyostyle-${todayStr()}.txt`, out);
    });

    $("setSyncToken").addEventListener("change", () => {
      S.updateSettings({ syncToken: $("setSyncToken").value.trim() });
    });
    $("toggleToken").addEventListener("click", () => {
      const inp = $("setSyncToken");
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      $("toggleToken").classList.toggle("showing", show);
      $("toggleToken").innerHTML = show
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><line x1="4" y1="4" x2="20" y2="20"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
      $("toggleToken").setAttribute("aria-label", show ? "パスコードを隠す" : "パスコードを表示");
    });
    $("setSheetUrl").addEventListener("change", () => {
      S.updateSettings({ sheetUrl: $("setSheetUrl").value.trim() });
    });
    $("setDriveFolder").addEventListener("change", () => {
      const v = $("setDriveFolder").value.trim();
      const m = v.match(/\/folders\/([A-Za-z0-9_-]+)/);
      const id = m ? m[1] : v;
      S.updateSettings({ driveFolderId: id });
      $("setDriveFolder").value = id;
    });
    $("setDefMilk").addEventListener("change", () => {
      S.updateSettings({ defaultAmounts: { ...S.settings.defaultAmounts, milk: $("setDefMilk").value.trim() } });
    });
    $("setDefExpressed").addEventListener("change", () => {
      S.updateSettings({ defaultAmounts: { ...S.settings.defaultAmounts, expressed: $("setDefExpressed").value.trim() } });
    });
    $("quickSelects").addEventListener("change", (e) => {
      const i = e.target && e.target.dataset ? e.target.dataset.qi : null;
      if (i == null) return;
      const q = [...S.settings.quickTypes];
      q[Number(i)] = e.target.value;
      S.updateSettings({ quickTypes: q });
    });
    $("typeOrderList").addEventListener("click", (e) => {
      const btn = e.target.closest(".order-up");
      if (!btn || btn.disabled) return;
      const keys = orderedTypeKeys();
      const idx = keys.indexOf(btn.dataset.k);
      if (idx > 0) {
        [keys[idx - 1], keys[idx]] = [keys[idx], keys[idx - 1]];
        S.updateSettings({ typeOrder: keys });
      }
    });
    $("syncNow").addEventListener("click", async () => {
      saveSyncSettings();
      if (!S.settings.syncToken) { $("cloudStatus").textContent = "パスコードを入れてください。"; return; }
      try {
        const res = await S.syncNow();
        if (res) toast(`🔄 同期完了（追加${res.added} / 更新${res.updated}）`);
      } catch (err) { /* renderCloudStatus がエラーを表示する */ }
    });

    $("pushSheet").addEventListener("click", async () => {
      if (S.cloud.readonly || S.cloud.photoOnly) { toast("この合言葉では書き出しはできません"); return; }
      saveSyncSettings();
      $("syncStatus").textContent = "バックアップ中...";
      try {
        const res = await S.pushToSheet();
        let msg = `✅ 記録${res.count}件をシートへ`;
        if (res.photos) msg += `、写真${res.photos}枚をDriveへ`;
        msg += "バックアップしました";
        // 新しい写真がなかった場合も「写真側も動いている」ことを伝えて安心させる
        if (res.photos === 0 && !res.photoError && S.settings.driveFolderId) {
          msg += "（写真はすべてDriveに保存済み）";
        }
        if (res.photoError) msg += `\n⚠️ 写真バックアップ: ${res.photoError}`;
        $("syncStatus").textContent = msg;
      } catch (err) { $("syncStatus").textContent = `⚠️ ${err.message}`; }
    });
    $("pullSheet").addEventListener("click", async () => {
      if (!confirm("スプレッドシートの内容をこの端末に取り込みます（ふだんは不要です）。よろしいですか？")) return;
      saveSyncSettings();
      $("syncStatus").textContent = "シートから復元中...";
      try {
        const res = await S.pullFromSheet();
        $("syncStatus").textContent = `✅ 復元しました（追加${res.added}件 / 更新${res.updated}件）`;
      } catch (err) { $("syncStatus").textContent = `⚠️ ${err.message}`; }
    });

    $("wipeData").addEventListener("click", () => {
      if (confirm("この端末の記録をすべて削除します（クラウドや他の端末には影響しません）。よろしいですか？")) {
        S.replaceAll([]);
        toast("すべて削除しました");
        render();
      }
    });

    $("welcomeForm").addEventListener("submit", () => {
      S.updateSettings({ babyName: $("welName").value.trim(), birthday: $("welBirthday").value, gender: $("welGender").value });
      render();
    });
    $("welSkip").addEventListener("click", () => {
      S.updateSettings({ welcomeSkipped: true });
      $("welcomeSheet").close();
      switchView("settings");
    });

    setInterval(() => {
      if (currentView === "log" && currentDate === todayStr() && !$("recordSheet").open) {
        renderDaySummary();
        renderQuickRow();
      }
    }, 30000);
  }

  function saveSyncSettings() {
    S.updateSettings({ syncToken: $("setSyncToken").value.trim(), sheetUrl: $("setSheetUrl").value.trim() });
  }

  // ---------- boot ----------
  S.load();
  bind();
  S.subscribe(render);
  render();
  S.startCloud();
  if (!S.settings.babyName && !S.settings.welcomeSkipped) $("welcomeSheet").showModal();
  scrollTimelineToEnd();
})();
