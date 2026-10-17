import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const DEMO = !firebaseConfig.apiKey;
const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.2]; // 최대 220%
const MELON_MOOD = "멜론 차트에서 추가";
const MANUAL_MOOD = "직접 추가한 곡";
const TABS = ["rate", "swap", "history", "melon"];

const $ = (sel) => document.querySelector(sel);

const state = {
  screen: "loading",   // loading | login | denied | seed | app
  user: null,
  songs: [],
  meta: null,
  rounds: [],
  tab: readLocal("usb-tab", "rate"),
  filter: "all",
  mood: "",
  q: "",
  chart: null,
  chartLoadedAt: 0,
};
if (!TABS.includes(state.tab)) state.tab = "rate";

let store; // 데이터 저장소 (Firebase 또는 체험 모드)

/* ================= 공통 도우미 ================= */

function readLocal(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 저장 불가 환경은 무시 */ }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function kst(date, withTime = true) {
  if (!date) return "";
  const p = {};
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const day = `${p.year}.${p.month}.${p.day}`;
  return withTime ? `${day} ${p.hour}:${p.minute}` : day;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function ask({ title, body = "", ok = "확인", cancel = "취소", danger = false }) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = body;
    const okBtn = $("#modal-ok");
    const cancelBtn = $("#modal-cancel");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "danger" : "primary");
    cancelBtn.textContent = cancel;
    modal.hidden = false;
    okBtn.focus();
    const close = (answer) => {
      modal.hidden = true;
      okBtn.onclick = cancelBtn.onclick = modal.onclick = null;
      resolve(answer);
    };
    okBtn.onclick = () => close(true);
    cancelBtn.onclick = () => close(false);
    modal.onclick = (e) => { if (e.target === modal) close(false); };
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/* ================= 곡 비교 (멜론 ↔ 내 목록) ================= */

// 영문/한글 표기가 다른 가수 이름 연결 (update_chart.py 와 같은 목록)
const ARTIST_ALIASES = [
  ["BTS", "방탄소년단"], ["ZICO", "지코"], ["SEVENTEEN", "세븐틴"],
  ["BIGBANG", "빅뱅"], ["BLACKPINK", "블랙핑크"], ["SHINee", "샤이니"],
  ["TXT", "투모로우바이투게더", "TOMORROW X TOGETHER"], ["EXO", "엑소"],
  ["Stray Kids", "스트레이 키즈"], ["ENHYPEN", "엔하이픈"], ["ATEEZ", "에이티즈"],
  ["DAY6", "데이식스"], ["RIIZE", "라이즈"], ["BOYNEXTDOOR", "보이넥스트도어"],
  ["ZEROBASEONE", "제로베이스원"], ["TWS", "투어스"], ["PLAVE", "플레이브"],
  ["TREASURE", "트레저"], ["WINNER", "위너"], ["iKON", "아이콘"],
  ["Wanna One", "워너원"], ["Block B", "블락비"], ["BTOB", "비투비"],
  ["JENNIE", "제니"], ["LISA", "리사"], ["ROSÉ", "로제", "ROSE"],
  ["G-DRAGON", "지드래곤", "GD"], ["Agust D", "어거스트 디", "SUGA", "슈가"],
  ["MINO", "송민호"], ["RM", "알엠"], ["V", "뷔"], ["j-hope", "제이홉"],
  ["정국", "Jung Kook", "JungKook"], ["지민", "Jimin"], ["진", "Jin"],
  ["지수", "JISOO"], ["태민", "TAEMIN"], ["태양", "TAEYANG"],
  ["슈퍼주니어", "SUPER JUNIOR"], ["이승철", "Lee Seung Chul"],
  ["NCT 127", "엔시티 127"], ["NCT DREAM", "엔시티 드림"], ["NCT U", "엔시티 유"],
  ["Bruno Mars", "브루노 마스"],
];

function norm(text) {
  return String(text ?? "")
    .normalize("NFKC").toLowerCase()
    .normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFC") // é → e, 한글은 그대로
    .replace(/[^0-9a-z가-힣]/g, "");
}

const ALIAS_INDEX = new Map();
for (const group of ARTIST_ALIASES) {
  const keys = new Set(group.map(norm).filter(Boolean));
  for (const k of keys) {
    if (!ALIAS_INDEX.has(k)) ALIAS_INDEX.set(k, new Set());
    keys.forEach((x) => ALIAS_INDEX.get(k).add(x));
  }
}

function titleKeys(title) {
  title = String(title ?? "");
  const keys = new Set([norm(title), norm(title.replace(/\(.*?\)|\[.*?\]/g, ""))]);
  for (const m of title.matchAll(/[(\[](.*?)[)\]]/g)) keys.add(norm(m[1]));
  keys.delete("");
  return keys;
}

function artistKeys(artist) {
  const keys = new Set();
  const names = String(artist ?? "").split(/,|&|\band\b|\bwith\b|\bfeat\.?|\bx\b|×/i);
  for (const name of names) {
    for (const part of name.split(/[()]/)) {
      const k = norm(part);
      if (!k) continue;
      keys.add(k);
      (ALIAS_INDEX.get(k) || []).forEach((x) => keys.add(x));
    }
  }
  return keys;
}

function buildSongIndex(songs) {
  const index = new Map();
  for (const s of songs) {
    const a = artistKeys(s.artist);
    for (const k of titleKeys(s.title)) {
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(a);
    }
  }
  return index;
}

function inMyList(index, title, artist) {
  const a = artistKeys(artist);
  for (const k of titleKeys(title)) {
    for (const cand of index.get(k) || []) {
      for (const x of a) if (cand.has(x)) return true;
    }
  }
  return false;
}

/* ================= 저장소: 체험 모드 (이 기기에만 저장) ================= */

function createDemoStore() {
  const KEY = "usb-demo-data";
  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db) db = { songs: [], meta: null, rounds: [] };

  const emit = () => {
    writeLocal(KEY, JSON.stringify(db));
    onData({ songs: db.songs, meta: db.meta, rounds: db.rounds });
  };
  const now = () => new Date().toISOString();

  return {
    demo: true,
    start() { state.user = { email: "체험 모드" }; emit(); },
    async login() {},
    async logout() {
      if (await ask({ title: "체험 데이터를 지울까요?", body: "이 기기에 저장된 체험용 평가가 모두 지워져요.", ok: "지우기", danger: true })) {
        localStorage.removeItem(KEY);
        location.reload();
      }
    },
    async seed(list) {
      db.songs = list.map((s) => ({ ...s, rating: null, source: "xlsx", createdAt: now() }));
      db.meta = { round: 1, seededAt: now() };
      emit();
    },
    async setRating(id, rating) {
      const s = db.songs.find((x) => x.id === id);
      if (s) Object.assign(s, { rating, ratedBy: "체험 모드", ratedAt: now() });
      emit();
    },
    async addSong(song) {
      db.songs.push({ ...song, id: "d" + Date.now(), rating: null, createdAt: now() });
      emit();
    },
    async completeRound(bad, fromRound) {
      const ids = new Set(bad.map((s) => s.id));
      db.songs = db.songs.filter((s) => !ids.has(s.id));
      db.rounds.push({ id: "r" + Date.now(), fromRound, toRound: fromRound + 1, completedAt: now(), by: "체험 모드", removed: bad.map(removedInfo) });
      db.meta.round = fromRound + 1;
      emit();
    },
  };
}

/* ================= 저장소: Firebase (온라인, 실시간) ================= */

async function createFirebaseStore() {
  const [appMod, authMod, fs] = await Promise.all([
    import(FIREBASE_SDK + "firebase-app.js"),
    import(FIREBASE_SDK + "firebase-auth.js"),
    import(FIREBASE_SDK + "firebase-firestore.js"),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  let db;
  try {
    // 휴대폰에 복사본을 두어 다음부터 빨리 열리고, 인터넷이 잠깐 끊겨도 동작
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }

  const provider = new authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  let unsubs = [];

  authMod.getRedirectResult(auth).catch(showLoginError);

  authMod.onAuthStateChanged(auth, (user) => {
    unsubs.forEach((u) => u());
    unsubs = [];
    state.user = user;
    if (!user) { setScreen("login"); return; }
    setScreen("loading");

    const loaded = { songs: false, meta: false, rounds: false };
    let songs = [], meta = null, rounds = [];
    const push = () => { if (loaded.songs && loaded.meta && loaded.rounds) onData({ songs, meta, rounds }); };
    const fail = (err) => {
      unsubs.forEach((u) => u());
      unsubs = [];
      if (err.code === "permission-denied") {
        showDenied("사용 권한이 없는 계정이에요", `지금 로그인한 계정: ${user.email}<br>허락된 구글 계정으로 다시 로그인해 주세요.`);
      } else {
        showDenied("연결에 문제가 있어요", `잠시 후 다시 시도해 주세요.<br><small>${esc(err.message)}</small>`);
      }
    };
    const opts = { includeMetadataChanges: false };
    unsubs.push(fs.onSnapshot(fs.collection(db, "songs"), opts, (snap) => {
      songs = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
      loaded.songs = true; push();
    }, fail));
    unsubs.push(fs.onSnapshot(fs.doc(db, "meta", "state"), opts, (snap) => {
      meta = snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : null;
      loaded.meta = true; push();
    }, fail));
    unsubs.push(fs.onSnapshot(fs.collection(db, "rounds"), opts, (snap) => {
      rounds = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
      loaded.rounds = true; push();
    }, fail));
  });

  const who = () => auth.currentUser?.email || "";

  return {
    demo: false,
    start() {},
    async login() {
      try {
        await authMod.signInWithPopup(auth, provider);
      } catch (err) {
        if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
          await authMod.signInWithRedirect(auth, provider);
        } else {
          throw err;
        }
      }
    },
    async logout() {
      if (await ask({ title: "로그아웃할까요?", ok: "로그아웃" })) await authMod.signOut(auth);
    },
    async seed(list) {
      const batch = fs.writeBatch(db);
      for (const s of list) {
        batch.set(fs.doc(db, "songs", s.id), { ...s, rating: null, source: "xlsx", createdAt: fs.serverTimestamp() });
      }
      batch.set(fs.doc(db, "meta", "state"), { round: 1, seededAt: fs.serverTimestamp(), seededBy: who() });
      await batch.commit();
    },
    async setRating(id, rating) {
      await fs.updateDoc(fs.doc(db, "songs", id), { rating, ratedBy: who(), ratedAt: fs.serverTimestamp() });
    },
    async addSong(song) {
      await fs.addDoc(fs.collection(db, "songs"), { ...song, rating: null, createdAt: fs.serverTimestamp(), addedBy: who() });
    },
    async completeRound(bad, fromRound) {
      const batch = fs.writeBatch(db);
      bad.forEach((s) => batch.delete(fs.doc(db, "songs", s.id)));
      batch.set(fs.doc(fs.collection(db, "rounds")), {
        fromRound, toRound: fromRound + 1, completedAt: fs.serverTimestamp(), by: who(),
        removed: bad.map(removedInfo),
      });
      batch.update(fs.doc(db, "meta", "state"), { round: fromRound + 1 });
      await batch.commit();
    },
  };
}

function removedInfo(s) {
  return { title: s.title, artist: s.artist, mood: s.mood || "", source: s.source || "" };
}

/* ================= 데이터 → 화면 ================= */

let songIndex = new Map();

function onData({ songs, meta, rounds }) {
  state.songs = [...songs].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.title).localeCompare(b.title));
  state.meta = meta;
  state.rounds = [...rounds].sort((a, b) => (toDate(b.completedAt) || 0) - (toDate(a.completedAt) || 0));
  songIndex = buildSongIndex(state.songs);

  if (!meta && songs.length === 0) { setScreen("seed"); return; }
  setScreen("app");
  renderAll();
}

function setScreen(name) {
  state.screen = name;
  $("#screen-loading").hidden = name !== "loading";
  $("#screen-login").hidden = name !== "login";
  $("#screen-denied").hidden = name !== "denied";
  $("#screen-seed").hidden = name !== "seed";
  $("#app").hidden = name !== "app";
}

function showDenied(title, html) {
  $("#denied-title").textContent = title;
  $("#denied-msg").innerHTML = html;
  setScreen("denied");
}

function showLoginError(err) {
  if (!err || err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
  const msg = {
    "auth/unauthorized-domain": "이 주소가 Firebase에 등록되지 않았어요. (설정 안내의 ‘승인된 도메인’ 단계를 확인해 주세요)",
    "auth/network-request-failed": "인터넷 연결을 확인해 주세요.",
  }[err.code] || `로그인하지 못했어요. (${err.code || err.message})`;
  const el = $("#login-error");
  el.textContent = msg;
  el.hidden = false;
}

function renderAll() {
  renderHeader();
  renderTabs();
  renderRate();
  renderSwap();
  renderHistory();
  if (state.tab === "melon") renderMelon();
}

const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;

function renderHeader() {
  $("#sub-line").textContent = `USB ${state.meta?.round ?? 1}회차 · ${state.songs.length}곡`;
  $("#demo-banner").hidden = !store?.demo;
  const i = FONT_STEPS.indexOf(currentScale());
  $("#font-down").disabled = i <= 0;
  $("#font-up").disabled = i >= FONT_STEPS.length - 1;
}

function renderTabs() {
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.val === state.tab)));
  document.querySelectorAll("main > section").forEach((s) => { s.hidden = s.dataset.tab !== state.tab; });
}

/* ---------- 1. 평가하기 ---------- */

function moods() {
  return [...new Set(state.songs.map((s) => s.mood).filter(Boolean))];
}

function fillMoodSelect(select, withAll, selected) {
  const list = moods();
  const extra = withAll ? [] : [MANUAL_MOOD].filter((m) => !list.includes(m));
  const html = (withAll ? `<option value="">모든 분위기</option>` : "") +
    [...list, ...extra].map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = selected;
  if (select.value !== selected) select.value = withAll ? "" : (list[0] || MANUAL_MOOD);
}

function renderRate() {
  const songs = state.songs;
  const good = songs.filter((s) => s.rating === "good").length;
  const bad = songs.filter((s) => s.rating === "bad").length;
  const none = songs.length - good - bad;
  const pct = (n) => (songs.length ? (n / songs.length) * 100 : 0);

  const stat = (label, n, color) =>
    `<div class="stat" style="--c:${color}"><span class="stat-label">${label}</span><b>${n}</b></div>`;
  $("#summary").innerHTML =
    stat("좋음", good, "var(--good)") + stat("별로", bad, "var(--bad)") + stat("미평가", none, "var(--none)");
  $("#bar").innerHTML = [[good, "var(--good)"], [bad, "var(--bad)"], [none, "var(--none)"]]
    .filter(([n]) => n > 0)
    .map(([n, c]) => `<span style="width:${pct(n)}%;background:${c}"></span>`).join("");
  $("#progress-note").textContent = `${songs.length}곡 중 ${good + bad}곡 평가 완료 · ${Math.round(pct(good + bad))}%`;

  document.querySelectorAll("#filter-chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.val === state.filter)));
  fillMoodSelect($("#mood-select"), true, state.mood);
  state.mood = $("#mood-select").value;
  renderRateList();
}

function renderRateList() {
  const q = norm(state.q);
  const list = state.songs.filter((s) => {
    if (state.filter === "none" && s.rating) return false;
    if (state.filter !== "all" && state.filter !== "none" && s.rating !== state.filter) return false;
    if (state.mood && s.mood !== state.mood) return false;
    if (q && !norm(s.title + s.artist).includes(q)) return false;
    return true;
  });
  $("#rate-count").textContent = `${list.length}곡`;
  $("#rate-list").innerHTML = list.length
    ? list.map(songCard).join("")
    : `<li class="empty">조건에 맞는 곡이 없어요.</li>`;
}

function songCard(s) {
  const isNew = s.source && s.source !== "xlsx";
  return `<li>
    <div class="song-t">${esc(s.title)}${isNew ? `<span class="badge-new">새 곡</span>` : ""}</div>
    <div class="song-a">${esc(s.artist)}${s.mood ? `<span class="dot">·</span>${esc(s.mood)}` : ""}</div>
    <div class="vote">
      <button class="good" data-act="rate" data-id="${esc(s.id)}" data-val="good" aria-pressed="${s.rating === "good"}">${icon("up")}좋음</button>
      <button class="bad" data-act="rate" data-id="${esc(s.id)}" data-val="bad" aria-pressed="${s.rating === "bad"}">${icon("down")}별로</button>
    </div>
  </li>`;
}

/* ---------- 2. 교체하기 ---------- */

function badSongs() {
  return state.songs.filter((s) => s.rating === "bad");
}

function renderSwap() {
  const bad = badSongs();
  $("#bad-count").textContent = bad.length;
  $("#bad-list").innerHTML = bad.length
    ? bad.map((s, i) => `<li class="row">
        <span class="idx">${i + 1}</span>
        <div class="row-main"><div class="song-t">${esc(s.title)}</div><div class="song-a">${esc(s.artist)}</div></div>
        <button class="text-btn" data-act="rate" data-id="${esc(s.id)}" data-val="bad">취소</button>
      </li>`).join("")
    : `<li class="empty">‘별로’로 표시한 곡이 없어요.</li>`;
  $("#copy-bad").disabled = bad.length === 0;
  $("#complete-btn").disabled = bad.length === 0;
  const addMood = $("#add-mood");
  fillMoodSelect(addMood, false, addMood.value || MANUAL_MOOD);
}

/* ---------- 3. 기록 ---------- */

function renderHistory() {
  const round = state.meta?.round ?? 1;
  $("#current-state").innerHTML =
    `<b>USB ${round}회차</b>` +
    `<span class="muted">목록 ${state.songs.length}곡 · 교체 ${state.rounds.length}번</span>`;

  $("#round-list").innerHTML = state.rounds.length
    ? state.rounds.map((r, i) => `<details class="round-card" ${i === 0 ? "open" : ""}>
        <summary>
          <div>
            <div class="round-no">${r.fromRound}회차 → ${r.toRound}회차</div>
            <div class="round-meta">${esc(kst(toDate(r.completedAt), false))} · ${r.removed?.length || 0}곡 뺌</div>
          </div>
          ${icon("chev")}
        </summary>
        <ul class="list">
          ${(r.removed || []).map((s, j) => `<li class="row"><span class="idx">${j + 1}</span>
            <div class="row-main"><div class="song-t">${esc(s.title)}</div><div class="song-a">${esc(s.artist)}${s.mood ? `<span class="dot">·</span>${esc(s.mood)}` : ""}</div></div></li>`).join("")}
        </ul>
        <div class="round-foot">${esc(kst(toDate(r.completedAt)))} · ${esc(r.by || "")}</div>
      </details>`).join("")
    : `<div class="card empty">아직 교체한 기록이 없어요.</div>`;

  $("#account-line").innerHTML = store?.demo
    ? "체험 모드예요. (Firebase 설정 후 구글 로그인으로 바뀝니다)"
    : `로그인한 계정: <b>${esc(state.user?.email || "")}</b>`;
  $("#logout-btn").textContent = store?.demo ? "체험 데이터 지우기" : "로그아웃";
}

/* ---------- 4. 멜론 차트 ---------- */

async function loadChart(force = false) {
  if (!force && state.chart && Date.now() - state.chartLoadedAt < 5 * 60 * 1000) return;
  try {
    const r = await fetch("data/latest.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    state.chart = await r.json();
    state.chartLoadedAt = Date.now();
  } catch {
    if (!state.chart) $("#chart-updated").textContent = "차트를 불러오지 못했어요. 잠시 후 다시 열어 주세요.";
    return;
  }
  if (state.tab === "melon") renderMelon();
}

function changeHtml(c) {
  if (!c) return "";
  if (c.type === "new") return `<span class="chg new">NEW</span>`;
  if (c.type === "up") return `<span class="chg up">▲${c.amount}</span>`;
  if (c.type === "down") return `<span class="chg down">▼${c.amount}</span>`;
  return `<span class="chg same">−</span>`;
}

function renderMelon() {
  const chart = state.chart;
  if (!chart) { loadChart(); return; }
  $("#chart-updated").textContent =
    `마지막 갱신: ${kst(new Date(chart.updated_at))}` + (chart.chart_time ? ` · 멜론 ${chart.chart_time.split(" ")[1]} 차트` : "");
  $("#chart-list").innerHTML = chart.songs.map((s, i) => {
    const mine = inMyList(songIndex, s.title, s.artist);
    return `<li class="chart-row">
      <a class="chart-link" href="${esc(s.url)}" target="_blank" rel="noopener">
        <div class="rank"><span class="n">${s.rank}</span>${changeHtml(s.change)}</div>
        <img class="cover" loading="lazy" alt="" src="${esc(s.image)}">
        <div class="chart-info"><div class="song-t">${esc(s.title)}</div><div class="song-a">${esc(s.artist)}</div></div>
      </a>
      ${mine
        ? `<span class="in-usb">${icon("check")}내 USB</span>`
        : `<button class="add-btn" data-act="melon-add" data-idx="${i}">${icon("plus")}담기</button>`}
    </li>`;
  }).join("");
}

/* ================= 동작 ================= */

function currentScale() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--scale")) || 1;
  return FONT_STEPS.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), 1);
}

function changeFont(dir) {
  const i = FONT_STEPS.indexOf(currentScale()) + dir;
  if (i < 0 || i >= FONT_STEPS.length) return;
  const scale = FONT_STEPS[i];
  document.documentElement.style.setProperty("--scale", scale);
  writeLocal("usb-font-scale", String(scale));
  renderHeader();
  toast(`글자 크기 ${Math.round(scale * 100)}%`);
}

function switchTab(tab) {
  state.tab = tab;
  writeLocal("usb-tab", tab);
  renderTabs();
  window.scrollTo(0, 0);
  if (tab === "melon") { renderMelon(); loadChart(); }
}

async function run(action, okMsg) {
  try {
    await action();
    if (okMsg) toast(okMsg);
  } catch (err) {
    console.error(err);
    toast(err.code === "permission-denied" ? "권한이 없어 저장하지 못했어요." : "저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
}

async function onAction(btn) {
  const act = btn.dataset.act;
  if (act === "font") return changeFont(Number(btn.dataset.dir));
  if (act === "tab") return switchTab(btn.dataset.val);
  if (act === "reload") return location.reload();
  if (act === "login" || act === "relogin") {
    $("#login-error").hidden = true;
    if (act === "relogin" && !store.demo) {
      const { getAuth, signOut } = await import(FIREBASE_SDK + "firebase-auth.js");
      await signOut(getAuth());
      return;
    }
    return store.login().catch(showLoginError);
  }
  if (act === "logout") return store.logout();

  if (act === "seed") {
    btn.disabled = true;
    btn.textContent = "넣는 중…";
    try {
      const list = await (await fetch("seed_songs.json", { cache: "no-store" })).json();
      await store.seed(list);
      toast(`${list.length}곡을 넣었어요`);
    } catch (err) {
      console.error(err);
      toast("곡목록을 넣지 못했어요. 다시 시도해 주세요.");
      btn.disabled = false;
      btn.textContent = "곡목록 넣기";
    }
    return;
  }

  if (act === "filter") {
    state.filter = btn.dataset.val;
    renderRate();
    return;
  }

  if (act === "rate") {
    const song = state.songs.find((s) => s.id === btn.dataset.id);
    if (!song) return;
    const next = song.rating === btn.dataset.val ? null : btn.dataset.val; // 다시 누르면 취소
    return run(() => store.setRating(song.id, next));
  }

  if (act === "copy-bad") {
    const bad = badSongs();
    const text = `엄마 노래 USB ${state.meta?.round ?? 1}회차 - 별로 곡 ${bad.length}곡\n` +
      bad.map((s, i) => `${i + 1}. ${s.title} - ${s.artist}`).join("\n");
    toast((await copyText(text)) ? "목록을 복사했어요" : "복사하지 못했어요");
    return;
  }

  if (act === "complete") {
    const bad = badSongs();
    if (!bad.length) return;
    const round = state.meta?.round ?? 1;
    const ok = await ask({
      title: "교체를 완료할까요?",
      body: `<p>‘별로’ 곡 <b>${bad.length}곡</b>을 목록에서 빼고<br>USB를 <b>${round + 1}회차</b>로 올립니다.</p>` +
        `<p class="muted">뺀 곡은 ‘기록’ 탭에서 볼 수 있어요.</p>`,
      ok: "교체 완료",
      danger: true,
    });
    if (ok) await run(() => store.completeRound(bad, round), `USB ${round + 1}회차가 되었어요`);
    return;
  }

  if (act === "melon-add") {
    const s = state.chart?.songs[Number(btn.dataset.idx)];
    if (!s) return;
    const ok = await ask({
      title: "내 목록에 추가할까요?",
      body: `<p><b>${esc(s.title)}</b><br><span class="muted">${esc(s.artist)}</span></p>`,
      ok: "추가",
    });
    if (ok) {
      await run(() => store.addSong({
        title: s.title, artist: s.artist, mood: MELON_MOOD, source: "melon",
        melonSongId: s.song_id || "", order: nextOrder(),
      }), "내 목록에 추가했어요");
    }
  }
}

function nextOrder() {
  return state.songs.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  onAction(btn);
});

$("#search").addEventListener("input", (e) => { state.q = e.target.value; renderRateList(); });
$("#mood-select").addEventListener("change", (e) => { state.mood = e.target.value; renderRateList(); });

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements; // form.title 은 폼 자체 속성이라 elements 로 접근
  const title = f.title.value.trim();
  const artist = f.artist.value.trim();
  if (!title || !artist) return;
  if (inMyList(songIndex, title, artist)) {
    const again = await ask({ title: "이미 목록에 있는 곡 같아요", body: `<p>${esc(title)} - ${esc(artist)}</p><p>그래도 추가할까요?</p>`, ok: "추가" });
    if (!again) return;
  }
  await run(() => store.addSong({ title, artist, mood: f.mood.value || MANUAL_MOOD, source: "manual", order: nextOrder() }), "목록에 추가했어요");
  f.title.value = "";
  f.artist.value = "";
});

// 앱을 다시 볼 때 차트 새로 확인
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.tab === "melon") loadChart();
});

/* ================= 시작 ================= */

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

(async () => {
  try {
    store = DEMO ? createDemoStore() : await createFirebaseStore();
    store.start();
  } catch (err) {
    console.error(err);
    showDenied("앱을 시작하지 못했어요", `인터넷 연결을 확인하고 다시 시도해 주세요.<br><small>${esc(err.message)}</small>`);
  }
  try {
    const seed = await (await fetch("seed_songs.json")).json();
    $("#seed-count").textContent = seed.length;
  } catch { /* 숫자 표시만 못 함 */ }
})();
