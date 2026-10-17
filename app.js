import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
// ?demo 를 붙이면 Firebase 대신 이 기기에만 저장하는 체험 모드 (화면 시험용)
const DEMO = !firebaseConfig.apiKey || new URLSearchParams(location.search).has("demo");
const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.2]; // 최대 220%
const MELON_MOOD = "멜론 차트에서 추가";
const SEARCH_MOOD = "검색해서 추가";
const MANUAL_MOOD = "직접 추가한 곡";
const TABS = ["rate", "melon", "search", "swap", "history"];

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
  covers: {},          // 엑셀 곡 id → { img, melonId }
  results: [],         // 음악 검색 결과
  searchQ: "",
  sheet: null,         // 열려 있는 곡 상세 정보
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

/* ================= 곡 정보 도우미 (커버 · 재생 · 멜론 · 가사) ================= */

const icon = (name, cls = "") => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;

function coverOf(s) {
  return s.image || state.covers[s.id]?.img || "";
}
function melonIdOf(s) {
  return s.melonId || s.melonSongId || state.covers[s.id]?.melonId || "";
}
function coverHtml(src, cls = "cover") {
  return src
    ? `<img class="${cls}" loading="lazy" alt="" src="${esc(src)}" onerror="this.outerHTML='<div class=&quot;${cls} ph&quot;>${icon("music").replace(/"/g, "&quot;")}</div>'">`
    : `<div class="${cls} ph">${icon("music")}</div>`;
}
function firstArtist(artist) {
  return String(artist || "").split(",")[0].replace(/\(.*?\)/g, "").trim();
}

// 유튜브 뮤직에서 듣기: 안드로이드는 앱을 바로 열고, 앱이 없거나 PC면 웹으로
function playSong(title, artist) {
  const q = encodeURIComponent(`${String(title).replace(/\(.*?\)/g, "").trim()} ${firstArtist(artist)}`);
  const web = `https://music.youtube.com/search?q=${q}`;
  if (/Android/i.test(navigator.userAgent)) {
    location.href = `intent://music.youtube.com/search?q=${q}#Intent;scheme=https;package=com.google.android.apps.youtube.music;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  } else {
    window.open(web, "_blank", "noopener");
  }
}

function melonUrl(s) {
  const id = melonIdOf(s);
  return id
    ? `https://www.melon.com/song/detail.htm?songId=${encodeURIComponent(id)}`
    : `https://www.melon.com/search/total/index.htm?q=${encodeURIComponent(`${s.title} ${firstArtist(s.artist)}`)}`;
}

// 멜론 검색창의 추천 검색 (JSONP)
let jsonpSeq = 0;
function melonSearch(query) {
  return new Promise((resolve, reject) => {
    const cb = `__melon${Date.now()}_${++jsonpSeq}`;
    const script = document.createElement("script");
    const done = () => { clearTimeout(timer); delete window[cb]; script.remove(); };
    const timer = setTimeout(() => { done(); reject(new Error("timeout")); }, 10000);
    window[cb] = (data) => { done(); resolve(data); };
    script.onerror = () => { done(); reject(new Error("network")); };
    script.src = `https://www.melon.com/search/keyword/index.json?jscallback=${cb}&query=${encodeURIComponent(query)}`;
    document.head.appendChild(script);
  });
}

// 가사: LRCLIB(무료 공개 가사 저장소)에서 찾기
const lyricsCache = new Map();
async function fetchLyrics(title, artist) {
  const key = `${title}|${artist}`;
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  const t = String(title).replace(/\(.*?\)|\[.*?\]/g, "").trim() || title;
  const a = firstArtist(artist);
  const tk = titleKeys(title), ak = artistKeys(artist);
  const urls = [
    `https://lrclib.net/api/search?track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`,
    `https://lrclib.net/api/search?q=${encodeURIComponent(`${t} ${a}`)}`,
  ];
  let found = null;
  for (const url of urls) {
    try {
      const list = await (await fetch(url)).json();
      const withText = (list || []).filter((x) => x.plainLyrics);
      const titleOk = (x) => [...titleKeys(x.trackName)].some((k) => tk.has(k));
      const artistOk = (x) => [...artistKeys(x.artistName)].some((k) => ak.has(k));
      found = withText.find((x) => titleOk(x) && artistOk(x)) || withText.find(titleOk) || null;
    } catch { /* 다음 방법 */ }
    if (found) break;
  }
  const result = found ? found.plainLyrics.trim() : null;
  lyricsCache.set(key, result);
  return result;
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
  if (state.tab === "search") renderSearch();
  if (state.sheet) renderSheet();
}

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

function renderRate() {
  const songs = state.songs;
  const good = songs.filter((s) => s.rating === "good").length;
  const bad = songs.filter((s) => s.rating === "bad").length;
  const none = songs.length - good - bad;
  const pct = (n) => (songs.length ? (n / songs.length) * 100 : 0);

  $("#hero-k").textContent = `USB ${state.meta?.round ?? 1}회차 · ${songs.length}곡 평가`;
  $("#hero-big").innerHTML = `${Math.round(pct(good + bad))}%<small>완료</small>`;
  $("#bar").innerHTML = [[good, "#ffffff"], [bad, "#ffd0d0"]]
    .filter(([n]) => n > 0)
    .map(([n, c]) => `<span style="width:${pct(n)}%;background:${c}"></span>`).join("");
  $("#summary").innerHTML =
    `<div><b>${good}</b>좋음</div><div><b>${bad}</b>별로</div><div><b>${none}</b>미평가</div>`;

  document.querySelectorAll("#filter-chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.val === state.filter)));

  const list = moods();
  if (state.mood && !list.includes(state.mood)) state.mood = "";
  const moodHtml = [["", "모든 분위기"], ...list.map((m) => [m, m])]
    .map(([v, label]) => `<button class="chip" data-act="mood" data-val="${esc(v)}" aria-pressed="${state.mood === v}">${esc(label)}</button>`).join("");
  if ($("#mood-chips").dataset.html !== moodHtml) {
    $("#mood-chips").innerHTML = moodHtml;
    $("#mood-chips").dataset.html = moodHtml;
  }
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
    ? list.map(songRow).join("")
    : `<li class="empty">조건에 맞는 곡이 없어요.</li>`;
}

function songRow(s) {
  const isNew = s.source && s.source !== "xlsx";
  const id = esc(s.id);
  return `<li class="song">
    <div class="row">
      <div data-act="detail" data-kind="list" data-id="${id}" style="cursor:pointer">${coverHtml(coverOf(s))}</div>
      <div class="meta" data-act="detail" data-kind="list" data-id="${id}">
        <div class="t">${esc(s.title)}${isNew ? `<span class="badge new">새 곡</span>` : ""}</div>
        <div class="a">${esc(s.artist)}${s.mood ? `<span class="dot">·</span>${esc(s.mood)}` : ""}</div>
      </div>
      <button class="play" data-act="play" data-kind="list" data-id="${id}" aria-label="듣기">${icon("play", "fill")}</button>
    </div>
    <div class="vote">
      <button class="good" data-act="rate" data-id="${id}" data-val="good" aria-pressed="${s.rating === "good"}">${icon("up")}좋음</button>
      <button class="bad" data-act="rate" data-id="${id}" data-val="bad" aria-pressed="${s.rating === "bad"}">${icon("down")}별로</button>
    </div>
  </li>`;
}

/* ---------- 2. 멜론 차트 ---------- */

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

// 차트·검색 결과 한 줄 (내 목록 곡이 아닌 것)
function extRow(s, kind, i, rankHtml = "") {
  const mine = inMyList(songIndex, s.title, s.artist);
  return `<li class="song">
    <div class="row">
      ${rankHtml}
      <div data-act="detail" data-kind="${kind}" data-idx="${i}" style="cursor:pointer">${coverHtml(s.image)}</div>
      <div class="meta" data-act="detail" data-kind="${kind}" data-idx="${i}">
        <div class="t">${esc(s.title)}</div>
        <div class="a">${esc(s.artist)}${kind === "search" && s.album ? `<span class="dot">·</span>${esc(s.album)}` : ""}</div>
      </div>
      <div class="acts">
        <button class="play" data-act="play" data-kind="${kind}" data-idx="${i}" aria-label="듣기">${icon("play", "fill")}</button>
        ${mine
          ? `<span class="icon-btn on" title="내 USB에 있어요" aria-label="내 USB에 있어요">${icon("check")}</span>`
          : `<button class="icon-btn" data-act="add-ext" data-kind="${kind}" data-idx="${i}" aria-label="내 목록에 담기">${icon("plus")}</button>`}
      </div>
    </div>
  </li>`;
}

function chartSong(i) {
  const s = state.chart?.songs[i];
  return s && { title: s.title, artist: s.artist, album: s.album, image: s.image, melonId: s.song_id, url: s.url };
}

function renderMelon() {
  const chart = state.chart;
  if (!chart) { loadChart(); return; }
  $("#chart-time").textContent = chart.chart_time ? `${chart.chart_time.split(" ")[1]} 기준` : "실시간";
  $("#chart-updated").textContent = `마지막 갱신 ${kst(new Date(chart.updated_at))} · ▶ 누르면 유튜브 뮤직에서 들어요`;
  $("#chart-list").innerHTML = chart.songs.map((_, i) => {
    const s = chartSong(i);
    const rank = `<div class="rank ${chart.songs[i].rank <= 3 ? "top" : ""}"><span class="n">${chart.songs[i].rank}</span>${changeHtml(chart.songs[i].change)}</div>`;
    return extRow(s, "chart", i, rank);
  }).join("");
}

/* ---------- 3. 음악 검색 ---------- */

function recentSearches() {
  try { return JSON.parse(readLocal("usb-recent", "[]")) || []; } catch { return []; }
}

function renderSearch() {
  const recent = recentSearches();
  $("#recent").innerHTML = !state.results.length && recent.length
    ? `<span class="muted" style="width:100%;font-size:.85rem">최근 검색</span>` +
      recent.map((q) => `<button class="chip" data-act="recent" data-val="${esc(q)}">${esc(q)}</button>`).join("")
    : "";
  if (!state.searchQ) {
    $("#search-list").innerHTML = `<li class="empty">듣고 싶은 곡이나 가수를 검색해 보세요.<br>▶ 를 누르면 유튜브 뮤직에서 들을 수 있어요.</li>`;
    return;
  }
  $("#search-list").innerHTML = state.results.length
    ? state.results.map((s, i) => extRow(s, "search", i)).join("")
    : `<li class="empty">‘${esc(state.searchQ)}’ 검색 결과가 없어요.</li>`;
}

let searchTimer;
async function runSearch(q, save = false) {
  q = q.trim();
  state.searchQ = q;
  if (!q) { state.results = []; renderSearch(); return; }
  try {
    const data = await melonSearch(q);
    if (state.searchQ !== q) return; // 더 최근 검색이 있으면 무시
    state.results = (data.SONGCONTENTS || []).map((x) => ({
      title: x.SONGNAME, artist: x.ARTISTNAME, album: x.ALBUMNAME,
      image: String(x.ALBUMIMG || "").replace(/\/resize\/\d+/, "/resize/240"), melonId: x.SONGID,
    }));
  } catch {
    state.results = [];
    toast("검색하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (save) {
    const recent = [q, ...recentSearches().filter((x) => x !== q)].slice(0, 8);
    writeLocal("usb-recent", JSON.stringify(recent));
  }
  renderSearch();
}

/* ---------- 4. 교체하기 ---------- */

function badSongs() {
  return state.songs.filter((s) => s.rating === "bad");
}

function renderSwap() {
  const bad = badSongs();
  $("#bad-count").textContent = bad.length;
  $("#bad-list").innerHTML = bad.length
    ? bad.map((s, i) => `<li class="song"><div class="row">
        <span class="idx">${i + 1}</span>
        ${coverHtml(coverOf(s))}
        <div class="meta" data-act="detail" data-kind="list" data-id="${esc(s.id)}"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}</div></div>
        <button class="text-btn" data-act="rate" data-id="${esc(s.id)}" data-val="bad">취소</button>
      </div></li>`).join("")
    : `<li class="empty">‘별로’로 표시한 곡이 없어요.<br>평가 탭에서 뺄 곡에 ‘별로’를 눌러 주세요.</li>`;
  $("#copy-bad").disabled = bad.length === 0;
  $("#complete-btn").disabled = bad.length === 0;

  const sel = $("#add-mood");
  const list = moods();
  const opts = [...list, ...[MANUAL_MOOD].filter((m) => !list.includes(m))];
  const html = opts.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  if (sel.dataset.html !== html) {
    const prev = sel.value || MANUAL_MOOD;
    sel.innerHTML = html;
    sel.dataset.html = html;
    sel.value = opts.includes(prev) ? prev : MANUAL_MOOD;
  }
}

/* ---------- 5. 기록 ---------- */

function renderHistory() {
  const round = state.meta?.round ?? 1;
  $("#current-state").innerHTML =
    `<div class="num">${round}</div><div><b>지금은 USB ${round}회차</b><br>` +
    `<span class="muted">목록 ${state.songs.length}곡 · 지금까지 교체 ${state.rounds.length}번</span></div>`;

  $("#round-list").innerHTML = state.rounds.length
    ? state.rounds.map((r, i) => `<details class="round" ${i === 0 ? "open" : ""}>
        <summary>
          <div>
            <div class="rn">${r.fromRound}회차 → ${r.toRound}회차</div>
            <div class="a">${esc(kst(toDate(r.completedAt)))} · ${r.removed?.length || 0}곡 뺌</div>
          </div>
          ${icon("chev")}
        </summary>
        <ul class="songs">
          ${(r.removed || []).map((s, j) => `<li class="song"><div class="row"><span class="idx">${j + 1}</span>
            <div class="meta" style="cursor:default"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}${s.mood ? `<span class="dot">·</span>${esc(s.mood)}` : ""}</div></div></div></li>`).join("")}
        </ul>
      </details>`).join("")
    : `<p class="empty">아직 교체한 기록이 없어요.</p>`;

  $("#account-line").innerHTML = store?.demo
    ? `<span class="muted">체험 모드예요. 이 기기에만 저장돼요.</span>`
    : `<span class="muted">로그인한 계정</span><br><b>${esc(state.user?.email || "")}</b>`;
  $("#logout-btn").textContent = store?.demo ? "체험 데이터 지우기" : "로그아웃";
}

/* ---------- 곡 상세 시트 (재생 · 가사 · 멜론 · 평가/담기) ---------- */

function songFor(kind, id, idx) {
  if (kind === "list") {
    const s = state.songs.find((x) => x.id === id);
    return s && { ...s, image: coverOf(s), melonId: melonIdOf(s), kind };
  }
  if (kind === "chart") return chartSong(Number(idx)) && { ...chartSong(Number(idx)), kind };
  if (kind === "search") return state.results[Number(idx)] && { ...state.results[Number(idx)], kind };
  return null;
}

function openSheet(song) {
  state.sheet = { ...song, lyrics: undefined, lyricsOpen: false };
  renderSheet();
  $("#sheet-bg").hidden = false;
  $("#sheet").scrollTop = 0;
  history.pushState({ sheet: true }, ""); // 뒤로가기 버튼으로 닫기
}

function closeSheet(fromPop = false) {
  if (!state.sheet) return;
  state.sheet = null;
  $("#sheet-bg").hidden = true;
  if (!fromPop && history.state?.sheet) history.back();
}

function renderSheet() {
  let s = state.sheet;
  if (!s) return;
  // 내 목록 곡은 최신 평가 상태를 반영
  const listSong = s.kind === "list" ? state.songs.find((x) => x.id === s.id) : null;
  if (s.kind === "list" && !listSong) { closeSheet(); return; }
  const mine = s.kind === "list" || inMyList(songIndex, s.title, s.artist);

  let lyricsHtml = "";
  if (s.lyricsOpen) {
    lyricsHtml = s.lyrics === undefined
      ? `<div class="lyrics muted">가사를 찾는 중…</div>`
      : s.lyrics
        ? `<div class="lyrics">${esc(s.lyrics)}</div><div class="lyrics-src">가사 출처: LRCLIB</div>`
        : `<div class="lyrics muted">가사를 찾지 못했어요. 아래 ‘멜론에서 보기’를 누르면 멜론에서 가사를 볼 수 있어요.</div>`;
  }

  $("#sheet").innerHTML = `
    <div class="grab"></div>
    <button class="icon-btn sheet-close" data-act="close-sheet" aria-label="닫기">${icon("x")}</button>
    ${coverHtml(s.image, "big-cover")}
    <h3>${esc(s.title)}</h3>
    <div class="s-artist">${esc(s.artist)}${s.album ? `<span class="dot" style="margin:0 6px;color:var(--text-3)">·</span>${esc(s.album)}` : ""}</div>
    <div class="s-badges">${mine ? `<span class="pill">${icon("check")}내 USB</span>` : ""}</div>
    <button class="btn-play" data-act="sheet-play">${icon("play", "fill")}유튜브 뮤직으로 듣기</button>
    <div class="sheet-grid">
      <button class="btn" data-act="sheet-lyrics">${icon("lyrics")}${s.lyricsOpen ? "가사 접기" : "가사 보기"}</button>
      <a class="btn" href="${esc(melonUrl(s))}" target="_blank" rel="noopener">${icon("out")}멜론에서 보기</a>
    </div>
    ${listSong ? `<div class="vote" style="margin-top:8px">
        <button class="good" data-act="rate" data-id="${esc(listSong.id)}" data-val="good" aria-pressed="${listSong.rating === "good"}">${icon("up")}좋음</button>
        <button class="bad" data-act="rate" data-id="${esc(listSong.id)}" data-val="bad" aria-pressed="${listSong.rating === "bad"}">${icon("down")}별로</button>
      </div>`
      : mine ? "" : `<button class="btn block" style="margin-top:8px" data-act="sheet-add">${icon("plus")}내 목록에 담기</button>`}
    ${lyricsHtml}
  `;
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
  if (tab === "search") renderSearch();
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

function nextOrder() {
  return state.songs.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
}

async function addExternal(s, kind) {
  if (!s) return;
  if (inMyList(songIndex, s.title, s.artist)) { toast("이미 내 목록에 있어요"); return; }
  const ok = await ask({
    title: "내 목록에 담을까요?",
    body: `<p><b>${esc(s.title)}</b><br>${esc(s.artist)}</p>`,
    ok: "담기",
  });
  if (!ok) return;
  await run(() => store.addSong({
    title: s.title, artist: s.artist, mood: kind === "chart" ? MELON_MOOD : SEARCH_MOOD,
    source: kind === "chart" ? "melon" : "search",
    image: s.image || "", melonId: s.melonId || "", order: nextOrder(),
  }), "내 목록에 담았어요");
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

  if (act === "filter") { state.filter = btn.dataset.val; renderRate(); return; }
  if (act === "mood") {
    state.mood = btn.dataset.val;
    document.querySelectorAll("#mood-chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.val === state.mood)));
    renderRateList();
    return;
  }

  if (act === "rate") {
    const song = state.songs.find((s) => s.id === btn.dataset.id);
    if (!song) return;
    const next = song.rating === btn.dataset.val ? null : btn.dataset.val; // 다시 누르면 취소
    return run(() => store.setRating(song.id, next));
  }

  if (act === "play") {
    const s = songFor(btn.dataset.kind, btn.dataset.id, btn.dataset.idx);
    if (s) playSong(s.title, s.artist);
    return;
  }
  if (act === "detail") {
    const s = songFor(btn.dataset.kind, btn.dataset.id, btn.dataset.idx);
    if (s) openSheet(s);
    return;
  }
  if (act === "add-ext") return addExternal(songFor(btn.dataset.kind, null, btn.dataset.idx), btn.dataset.kind);

  if (act === "close-sheet") return closeSheet();
  if (act === "sheet-play") return state.sheet && playSong(state.sheet.title, state.sheet.artist);
  if (act === "sheet-add") return state.sheet && addExternal(state.sheet, state.sheet.kind);
  if (act === "sheet-lyrics") {
    const s = state.sheet;
    if (!s) return;
    s.lyricsOpen = !s.lyricsOpen;
    renderSheet();
    if (s.lyricsOpen && s.lyrics === undefined) {
      const text = await fetchLyrics(s.title, s.artist);
      if (state.sheet === s) { s.lyrics = text; renderSheet(); }
    }
    return;
  }

  if (act === "recent") {
    $("#music-q").value = btn.dataset.val;
    return runSearch(btn.dataset.val, true);
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
        `<p>뺀 곡은 ‘기록’ 탭에서 볼 수 있어요.</p>`,
      ok: "교체 완료",
      danger: true,
    });
    if (ok) await run(() => store.completeRound(bad, round), `USB ${round + 1}회차가 되었어요`);
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  onAction(btn);
});

$("#sheet-bg").addEventListener("click", (e) => { if (e.target.id === "sheet-bg") closeSheet(); });
window.addEventListener("popstate", () => closeSheet(true));

$("#search").addEventListener("input", (e) => { state.q = e.target.value; renderRateList(); });

$("#music-q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => runSearch(q), 400);
});
$("#music-search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  $("#music-q").blur(); // 휴대폰 키보드 내리기
  runSearch($("#music-q").value, true);
});

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

fetch("covers.json")
  .then((r) => (r.ok ? r.json() : {}))
  .then((c) => { state.covers = c || {}; if (state.screen === "app") renderAll(); })
  .catch(() => {});

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
