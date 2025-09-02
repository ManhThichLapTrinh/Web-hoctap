// /app.js
// Frontend: UI + Auth + Firestore CRUD (realtime)

import {
  auth,
  db,
  onUserChanged,
  loginWithEmail,
  signupWithEmail,
  logout,
} from "./js/firebase.js";

import {
  collection, addDoc, doc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// ---------- State ----------
let items = [];
let unsub = null;
let theme = loadTheme();
let authBusy = false; // chặn mở dialog khi đang xử lý auth

// ⬇️ Giới hạn preview trên TRANG CHỦ (3 mục mỗi khối)
const HOMEPAGE_PREVIEW_LIMIT = 3;

// ---------- (ĐÃ VÔ HIỆU HÓA i18n) ----------
// Luôn dùng tiếng Việt. Không đọc/ghi localStorage, không đổi <html lang>, không đổi summary.
const TEXT_VI = {
  searchPh: "Tìm theo tiêu đề hoặc #tag...",
  login: "Đăng nhập",
  logout: "Đăng xuất",
  video: "Video",
  doc: "Tài liệu",
  overview: "Tổng quan",
  videosTab: "Video",
  docsTab: "Tài liệu",
  uploadsTab: "Tải lên",
  emptyVideo: "Chưa có video. Nhấn “Đăng nhập” để thêm nhé!",
  emptyDoc: "Chưa có tài liệu. Nhấn “Đăng nhập” để thêm nhé!",
  see: "Xem",
  confirmDelete: "Xoá mục này?",
  needLogin: "Bạn cần đăng nhập.",
};
function getLang(){ return "vi"; }
function setLang(_){ /* no-op */ }
function t(key){ return TEXT_VI[key] ?? key; }

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  console.log("[KhoHocTap] app.js loaded");

  const els = collectEls();
  wireTopbar(els);
  wireAuthDialogs(els);
  wireEditor(els);
  wirePlayer(els);

  // Mobile drawer & FAB
  wireMobileUX(els);

  applyTheme(theme);

  // Giữ nút Ngôn ngữ trên menu nhưng vô hiệu hoá hành vi
  setupLanguageUI(els);

  // Auth state -> UI + subscribe data
  onUserChanged((user) => {
    setAuthUI(els, user);
    renderProfile(user);

    if (user) {
      ensureDialogClose(els.loginDialog);
      ensureDialogClose(els.signupDialog);
      if (els.loginError)  { els.loginError.hidden  = true; els.loginError.textContent  = ""; }
      if (els.signupError) { els.signupError.hidden = true; els.signupError.textContent = ""; }
    }

    if (typeof unsub === "function") { unsub(); unsub = null; }
    if (user) {
      unsub = subscribeMyItems(user.uid, els);
    } else {
      items = [];
      renderAll(els, items);
    }
  });

  // Search
  els.search?.addEventListener("input", () => applySearch(els));
  els.clearSearch?.addEventListener("click", () => {
    if (!els.search) return;
    els.search.value = "";
    applySearch(els);
  });

  // Sidebar highlight
  setupSidebarActive();
  mobileSidebar();
});

// ---------- DOM helpers ----------
function q(id){ return document.getElementById(id); }
function collectEls(){
  const els = {
    // Topbar
    search: q("search"),
    clearSearch: q("clear-search"),
    toggleTheme: q("toggle-theme"),
    loginBtn: q("btn-login"),
    // Lists
    videoList: q("video-list"),
    videoEmpty: q("video-empty"),
    docList: q("doc-list"),
    docEmpty: q("doc-empty"),
    // Editor
    dialog: q("edit-dialog"),
    form: q("edit-form"),
    dialogTitle: q("dialog-title"),
    type: q("type"),
    title: q("title"),
    url: q("url"),
    tags: q("tags"),
    editingId: q("editing-id"),
    cardTpl: document.getElementById("card-template"),
    // Player
    playerDialog: q("player-dialog"),
    playerClose: q("player-close"),
    playerTitle: q("player-title"),
    videoPlayer: q("video-player"),
    // Auth dialogs
    loginDialog: q("login-dialog"),
    loginForm: q("login-form"),
    loginEmail: q("login-email"),
    loginPassword: q("login-password"),
    loginError: q("login-error"),
    loginToSignup: q("login-to-signup"),
    signupDialog: q("signup-dialog"),
    signupForm: q("signup-form"),
    signupEmail: q("signup-email"),
    signupPassword: q("signup-password"),
    signupPassword2: q("signup-password2"),
    signupError: q("signup-error"),
    signupToLogin: q("signup-to-login"),
    // Profile header
    profileHeader: q("profile-header"),
    profileName: q("profile-name"),
    profileAvatar: q("profile-avatar"),
    profileFallback: q("profile-avatar-fallback"),
    // Language menu
    langGroup: q("lang-group"),
    // Mobile-specific
    sidebar: document.querySelector(".sidebar"),
    btnOpenSidebar: q("btn-open-sidebar"),
    fab: q("fab-upload"),
  };

  Object.entries(els).forEach(([k,v])=>{
    if (!v && k !== "fab") console.warn("[KhoHocTap] Missing element:", k);
  });
  return els;
}

// ---------- Theme ----------
function loadTheme(){ return localStorage.getItem("theme") || "dark"; }
function applyTheme(mode){
  document.documentElement.classList.toggle("light", mode === "light");
  localStorage.setItem("theme", mode);
}

// ---------- Wire topbar ----------
function wireTopbar(els){
  els.toggleTheme?.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme(theme);
  });

  // Nút Đăng nhập / Đăng xuất (duy nhất)
  els.loginBtn?.addEventListener("click", async () => {
    try {
      if (auth.currentUser) {
        await logout();
        ensureDialogClose(els.loginDialog);
        ensureDialogClose(els.signupDialog);
      } else {
        openLogin(els);
      }
    } catch (e) {
      console.error("loginBtn click error:", e);
    }
  });
}

// ---------- Auth UI & dialogs ----------
function setAuthUI(els, user){
  if (!els.loginBtn) return;
  if (user) {
    els.loginBtn.textContent = "Đăng xuất";
    els.loginBtn.dataset.state = "logged-in";
    if (els.profileHeader) els.profileHeader.hidden = false;
  } else {
    els.loginBtn.textContent = "Đăng nhập";
    els.loginBtn.dataset.state = "logged-out";
    if (els.profileHeader) els.profileHeader.hidden = true;
  }
  applyLanguageToUI(els);
}

function ensureDialogOpen(dlg){
  if (!dlg) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else { dlg.setAttribute("open", ""); dlg.style.display = "block"; }
}
function ensureDialogClose(dlg){
  if (!dlg) return;
  try {
    if (typeof dlg.close === "function") dlg.close();
    else { dlg.removeAttribute("open"); dlg.style.display = "none"; }
  } catch {}
}

function wireAuthDialogs(els){
  // Chuyển Login -> Signup
  els.loginToSignup?.addEventListener("click", (e) => {
    e.preventDefault();
    if (auth.currentUser || authBusy) return;
    ensureDialogClose(els.loginDialog);
    openSignup(els);
  });

  // Chuyển Signup -> Login
  els.signupToLogin?.addEventListener("click", (e) => {
    e.preventDefault();
    if (auth.currentUser || authBusy) return;
    ensureDialogClose(els.signupDialog);
    openLogin(els);
  });

  // Submit Login
  els.loginForm?.addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    if (authBusy) return;
    authBusy = true;

    const email = els.loginEmail?.value.trim() || "";
    const pwd   = els.loginPassword?.value || "";
    try {
      await loginWithEmail(email, pwd);
      ensureDialogClose(els.loginDialog);
      if (els.loginError) { els.loginError.hidden = true; els.loginError.textContent = ""; }
    } catch (err) {
      if (els.loginError) {
        els.loginError.textContent = err?.message || "Không đăng nhập được.";
        els.loginError.hidden = false;
      }
      console.error("login error:", err);
    } finally {
      setTimeout(()=> { authBusy = false; }, 0);
    }
  });

  // Submit Signup
  els.signupForm?.addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    if (authBusy) return;
    authBusy = true;

    const email = els.signupEmail?.value.trim() || "";
    const p1 = els.signupPassword?.value || "";
    const p2 = els.signupPassword2?.value || "";
    if (p1 !== p2) {
      if (els.signupError) { els.signupError.textContent = "Mật khẩu nhập lại không khớp."; els.signupError.hidden = false; }
      authBusy = false;
      return;
    }
    try {
      await signupWithEmail(email, p1);
      ensureDialogClose(els.signupDialog);
      if (els.signupError) { els.signupError.hidden = true; els.signupError.textContent = ""; }
    } catch (err) {
      if (els.signupError) {
        els.signupError.textContent = err?.message || "Không tạo được tài khoản.";
        els.signupError.hidden = false;
      }
      console.error("signup error:", err);
    } finally {
      setTimeout(()=> { authBusy = false; }, 0);
    }
  });
}

function openLogin(els){
  if (auth.currentUser || authBusy) return;
  if (!els.loginDialog) return;
  if (els.loginError) { els.loginError.hidden = true; els.loginError.textContent = ""; }
  els.loginEmail && (els.loginEmail.value = "");
  els.loginPassword && (els.loginPassword.value = "");
  ensureDialogOpen(els.loginDialog);
  setTimeout(()=> els.loginEmail?.focus(), 0);
}
function openSignup(els){
  if (auth.currentUser || authBusy) return;
  if (!els.signupDialog) return;
  if (els.signupError) { els.signupError.hidden = true; els.signupError.textContent = ""; }
  els.signupEmail && (els.signupEmail.value = "");
  els.signupPassword && (els.signupPassword.value = "");
  els.signupPassword2 && (els.signupPassword2.value = "");
  ensureDialogOpen(els.signupDialog);
  setTimeout(()=> els.signupEmail?.focus(), 0);
}

// ---------- Editor ----------
function wireEditor(els){
  els.form?.addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    const payload = {
      id:   els.editingId.value || undefined,
      type: els.type.value,
      title: (els.title.value || "").trim(),
      url:   (els.url.value || "").trim(),
      tags:  parseTags(els.tags.value),
    };
    if (!payload.title || !payload.url) return;
    await upsertItem(payload);
    ensureDialogClose(els.dialog);
  });
}
function openEditor(els, item){
  if (!auth.currentUser){
    alert(t("needLogin"));
    openLogin(els);
    return;
  }
  if (item) {
    els.dialogTitle.textContent = "Sửa mục";
    els.editingId.value = item.id;
    els.type.value = item.type;
    els.title.value = item.title || "";
    els.url.value = item.url || "";
    els.tags.value = (item.tags || []).join(" ");
  } else {
    els.dialogTitle.textContent = "Thêm mục";
    els.editingId.value = "";
    els.type.value = "video";
    els.title.value = "";
    els.url.value = "";
    els.tags.value = "";
  }
  ensureDialogOpen(els.dialog);
  setTimeout(()=> els.title?.focus(), 0);
}

// ---------- Player ----------
function wirePlayer(els){
  els.playerClose?.addEventListener("click", () => closePlayer(els));
  els.playerDialog?.addEventListener("close", () => closePlayer(els));
}
function openPlayer(els, item){
  els.playerTitle.textContent = item.title || t("see");
  const isYT = /youtu\.be|youtube\.com/i.test(item.url || "");
  if (isYT) { window.open(item.url, "_blank", "noopener"); return; }
  els.videoPlayer.src = item.url || "";
  ensureDialogOpen(els.playerDialog);
}
function closePlayer(els){
  try { els.videoPlayer.pause?.(); } catch {}
  els.videoPlayer.removeAttribute("src");
  ensureDialogClose(els.playerDialog);
}

/* ===========================
   TỪ ĐÂY TRỞ XUỐNG: CHỈNH SỬA
   =========================== */

// ►► Điều hướng sang Videos + mở Theater video
function goToVideosTheater(item){
  const url = new URL("./Videos/videos.html", window.location.href);
  url.searchParams.set("open", item.id);
  window.location.href = url.toString();
}

// ---------- Render ----------
// State RIÊNG cho dữ liệu trang chủ (từ Videos & Materials)
let videosData = [];
let docsData   = [];
let unsubVideos = null;
let unsubDocs   = null;

// Helpers sort/thời gian + đọc limit từ HTML
function tsOf(item){
  try{
    const t = item?.updatedAt || item?.createdAt;
    if (!t) return 0;
    if (typeof t.toMillis === "function") return t.toMillis();
    if (typeof t.toDate === "function")   return t.toDate().getTime();
    return new Date(t).getTime() || 0;
  }catch{ return 0; }
}
function sortByNewest(arr){ return [...arr].sort((a,b)=> tsOf(b) - tsOf(a)); }
function homeLimitFrom(el, fallback){
  const n = Number(el?.dataset?.homeLimit);
  return Number.isFinite(n) && n>0 ? n : fallback;
}

/* ===== Helpers để làm VIDEO CARD giống trang Videos ===== */
function youTubeId(u){
  try{
    const url = new URL(u);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    const shorts = url.pathname.match(/\/shorts\/([^/?#]+)/);
    if (shorts) return shorts[1];
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const embed = url.pathname.match(/\/embed\/([^/?#]+)/);
    if (embed) return embed[1];
  }catch{}
  return null;
}
function youTubeThumb(u){
  const id = youTubeId(u);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}
function pickVideoThumb(item){
  const fromDoc = item?.thumb;
  if (fromDoc) return fromDoc;
  const yt = youTubeThumb(item?.url || "");
  if (yt) return yt;
  return "./images/video-placeholder.jpg";
}

/**
 * Tạo video card giống trang Videos.
 * - Nếu có <template id="vid-card-template"> → dùng template này (đúng UI).
 * - Nếu không có → fallback tạo markup tương thích class .vid-card/.vid-thumb.
 */
function buildVideoCardLikeVideosPage(els, item){
  const tpl = document.getElementById("vid-card-template");
  const thumbUrl = pickVideoThumb(item);
  const titleTxt = item.title || "(Không có tiêu đề)";
  const metaTxt  = `${fmtDate(item.updatedAt || item.createdAt)}${(item.tags?.length? " • " + item.tags.join(" ") : "")}`;

  if (tpl?.content?.firstElementChild){
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;

    // điền title/meta
    node.querySelector("[data-title]")?.replaceChildren(document.createTextNode(titleTxt));
    node.querySelector("[data-meta]")?.replaceChildren(document.createTextNode(metaTxt));

    // thumbnail dạng background
    const thumbBox = node.querySelector(".vid-thumb");
    if (thumbBox) {
      thumbBox.style.backgroundImage = `url("${thumbUrl}")`;
      // (tuỳ chọn) click thumbnail cũng đi đến theater
      thumbBox.addEventListener("click", (e)=>{ e.preventDefault(); goToVideosTheater(item); });
    }

    // actions
    const playBtn = node.querySelector("[data-play]");
    const delBtn  = node.querySelector("[data-delete]");
    const openA   = node.querySelector("[data-open]");

    if (openA) {
      openA.href = item.url || "#";
      openA.target = "_blank"; openA.rel = "noopener";
    }
    if (playBtn){
      playBtn.addEventListener("click", (e)=> {
        e.preventDefault();
        goToVideosTheater(item);   // ⬅️ chuyển trang + mở theater
      });
    }
    if (delBtn){
      delBtn.addEventListener("click", async (e)=>{
        e.preventDefault();
        if (!confirm(t("confirmDelete"))) return;
        await deleteItem(item.id); // vẫn xoá theo items nếu bạn đang dùng CRUD cũ
      });
    }

    return node;
  }

  // Fallback: tạo markup tương thích CSS trang Videos
  const card = document.createElement("article");
  card.className = "vid-card";
  card.dataset.id = item.id;
  card.innerHTML = `
    <div class="vid-thumb" style="background-image:url('${thumbUrl}')"></div>
    <div class="vid-meta">
      <h3 class="vid-title" data-title></h3>
      <div class="vid-sub" data-meta></div>
    </div>
    <div class="vid-actions">
      <button class="btn btn-ghost" data-play type="button">▶ Xem</button>
      <a class="btn btn-ghost" data-open target="_blank" rel="noopener">🔗 Mở</a>
      <button class="btn btn-danger" data-delete type="button">🗑 Xoá</button>
    </div>
  `;
  card.querySelector("[data-title]").textContent = titleTxt;
  card.querySelector("[data-meta]").textContent  = metaTxt;

  card.querySelector(".vid-thumb")?.addEventListener("click", (e)=>{ e.preventDefault(); goToVideosTheater(item); });
  card.querySelector("[data-play]")?.addEventListener("click", (e)=>{ e.preventDefault(); goToVideosTheater(item); });
  const openA = card.querySelector("[data-open]");
  if (openA) openA.href = item.url || "#";
  card.querySelector("[data-delete]")?.addEventListener("click", async (e)=>{
    e.preventDefault();
    if (!confirm(t("confirmDelete"))) return;
    await deleteItem(item.id);
  });

  return card;
}

// (ĐỔI) renderAll: bỏ dùng mảng "items" để hiển thị home
function renderAll(els, _dataIgnored){
  renderHomeFromSeparateSources(els);
}

// Render trang chủ từ videosData + docsData
function renderHomeFromSeparateSources(els){
  const videos = sortByNewest(videosData);
  const docs   = sortByNewest(docsData);

  const vh = document.getElementById("video-heading");
  const dh = document.getElementById("doc-heading");
  if (vh) vh.textContent = t("video");
  if (dh) dh.textContent = t("doc");
  if (els.videoEmpty) els.videoEmpty.textContent = t("emptyVideo");
  if (els.docEmpty)   els.docEmpty.textContent   = t("emptyDoc");
  const search = document.getElementById("search");
  if (search) search.placeholder = t("searchPh");

  const vLimit = homeLimitFrom(els.videoList, HOMEPAGE_PREVIEW_LIMIT);
  const dLimit = homeLimitFrom(els.docList,   HOMEPAGE_PREVIEW_LIMIT);

  renderList(els, els.videoList, els.videoEmpty, videos, true,  vLimit);
  renderList(els, els.docList,   els.docEmpty,   docs,   false, dLimit);
}

function renderList(els, container, emptyEl, arr, isVideo, limit = 0){
  if (!container || !emptyEl) return;
  container.innerHTML = "";

  const data = (limit && limit > 0) ? arr.slice(0, limit) : arr;
  emptyEl.hidden = data.length !== 0;

  if (isVideo){
    // ► VIDEO: dùng card giống trang Videos
    data.forEach(item => {
      const node = buildVideoCardLikeVideosPage(els, item);
      container.appendChild(node);
    });
    return;
  }

  // ► DOCS: giữ nguyên như trước, dùng #card-template
  const tpl = els.cardTpl?.content?.firstElementChild;
  if (!tpl) return;

  data.forEach(item => {
    const node = tpl.cloneNode(true);
    node.querySelector("[data-type]").textContent = "TÀI LIỆU";
    node.querySelector("[data-title]").textContent = item.title || "(Không có tiêu đề)";
    node.querySelector("[data-date]").textContent = fmtDate(item.updatedAt || item.createdAt);
    node.querySelector("[data-tags]").innerHTML = (item.tags || []).map(tag => `<code>${tag}</code>`).join(" ");

    const openA = node.querySelector("[data-open]");
    const editBtn = node.querySelector("[data-edit]");
    const delBtn = node.querySelector("[data-delete]");

    if (openA) openA.href = item.url || "#";
    editBtn?.addEventListener("click", () => openEditor(els, item));
    delBtn?.addEventListener("click", async () => {
      if (!confirm(t("confirmDelete"))) return;
      await deleteItem(item.id);
    });

    container.appendChild(node);
  });
}

// ---------- Search ----------
// Gộp 2 nguồn: videosData + docsData
function applySearch(els){
  const q = els.search?.value?.trim() || "";
  const all = [...videosData, ...docsData];
  const filtered = all.filter(i => matchQuery(i, q));
  const videos = filtered.filter(i => i.type === "video");
  const docs   = filtered.filter(i => i.type === "doc");
  // Khi tìm kiếm: hiển thị đầy đủ
  renderList(els, els.videoList, els.videoEmpty, videos, true);
  renderList(els, els.docList,   els.docEmpty,   docs,   false);
}
function parseTags(s){
  return (s || "")
    .split(/\s+/).map(t => t.trim()).filter(Boolean)
    .map(t => (t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`));
}
function matchQuery(item, q){
  if (!q) return true;
  const hay = `${item.title || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}
function fmtDate(ts){
  try {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("vi-VN", { year: "numeric", month: "short", day: "2-digit" });
  } catch { return ""; }
}

// ---------- Firestore ----------
// GIỮ NGUYÊN phần items cũ
const colRef = (uid) => collection(db, `users/${uid}/items`);

/**
 * Realtime subscribe với fallback:
 * - Mặc định dùng orderBy("createdAt","desc")
 * - Nếu Firestore báo "requires an index" (failed-precondition) thì tự fallback
 *   sang query KHÔNG sắp xếp để vẫn hiển thị dữ liệu.
 */
function subscribeMyItems(uid, els){
  let innerUnsub = null;

  const handleSnap = (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`[items] ${items.length}`, items);
    if (els.search?.value?.trim()) applySearch(els);
    else renderAll(els, items); // renderAll đã chuyển sang 2 nguồn riêng
  };

  const start = (useFallback = false) => {
    if (innerUnsub) innerUnsub();
    const qy = useFallback
      ? query(colRef(uid)) // không orderBy -> không cần composite index
      : query(colRef(uid), orderBy("createdAt","desc"));
    innerUnsub = onSnapshot(qy, handleSnap, (err) => {
      console.error("onSnapshot error:", err);
      // Thiếu index => dùng fallback
      if (err?.code === "failed-precondition" && !useFallback) {
        console.warn("[Firestore] Thiếu index cho orderBy(createdAt). Đang fallback sang query không sắp xếp.");
        start(true);
      }
    });
  };

  start(false);
  // trả về hàm huỷ
  return () => { if (innerUnsub) innerUnsub(); };
}

// (MỚI) Collection riêng cho Videos & Materials
const videosCol = (uid) => collection(db, `users/${uid}/videos`);
const docsCol   = (uid) => collection(db, `users/${uid}/materials_files`);

// (MỚI) Chuẩn hoá dữ liệu hiển thị
function normalizeVideo(id, d){
  return {
    id,
    type: "video",
    title: d.title || d.name || "(Không có tiêu đề)",
    url: d.url || d.cloudUrl || d.link || "",
    thumb: d.thumb || null,
    tags: Array.isArray(d.tags) ? d.tags : [],
    createdAt: d.createdAt || d.created_at || Date.now(),
    updatedAt: d.updatedAt || d.updated_at || d.createdAt || Date.now(),
  };
}
function normalizeDoc(id, d){
  return {
    id,
    type: "doc",
    title: d.title || d.name || "(Không có tiêu đề)",
    url: d.url || d.link || "",
    tags: Array.isArray(d.tags) ? d.tags : [],
    createdAt: d.createdAt || d.created_at || Date.now(),
    updatedAt: d.updatedAt || d.updated_at || d.createdAt || Date.now(),
  };
}

// (MỚI) Subscribe VIDEOS từ users/{uid}/videos (fallback: items[type=video])
function subscribeVideos(uid, onChange){
  let innerUnsub = null;

  const start = (useFallback=false)=>{
    if (innerUnsub) innerUnsub();
    const col = useFallback ? colRef(uid) : videosCol(uid);
    const qy = query(col, orderBy("createdAt","desc"));
    innerUnsub = onSnapshot(qy, (snap)=>{
      let arr = snap.docs.map(d=> ({ id:d.id, ...d.data() }));
      if (useFallback) arr = arr.filter(x=> x.type === "video");
      onChange(arr.map(x=> normalizeVideo(x.id, x)));
    }, (err)=>{
      console.warn("[videos] onSnapshot err:", err?.code, err?.message);
      if (!useFallback) start(true);
    });
  };

  start(false);
  return ()=> innerUnsub && innerUnsub();
}

// (MỚI) Subscribe DOCS từ users/{uid}/materials_files (fallback: items[type=doc])
function subscribeDocs(uid, onChange){
  let innerUnsub = null;

  const start = (useFallback=false)=>{
    if (innerUnsub) innerUnsub();
    const col = useFallback ? colRef(uid) : docsCol(uid);
    const qy = query(col, orderBy("createdAt","desc"));
    innerUnsub = onSnapshot(qy, (snap)=>{
      let arr = snap.docs.map(d=> ({ id:d.id, ...d.data() }));
      if (useFallback) arr = arr.filter(x=> x.type === "doc");
      onChange(arr.map(x=> normalizeDoc(x.id, x)));
    }, (err)=>{
      console.warn("[docs] onSnapshot err:", err?.code, err?.message);
      if (!useFallback) start(true);
    });
  };

  start(false);
  return ()=> innerUnsub && innerUnsub();
}

// (MỚI) Lắng nghe auth RIÊNG để mở 2 nguồn Videos & Docs dùng cho home
onUserChanged((user) => {
  if (typeof unsubVideos === "function") { unsubVideos(); unsubVideos = null; }
  if (typeof unsubDocs   === "function") { unsubDocs();   unsubDocs   = null; }

  const els = collectEls();

  if (user) {
    unsubVideos = subscribeVideos(user.uid, (arr)=>{
      videosData = arr;
      renderHomeFromSeparateSources(els);
      if (els.search?.value?.trim()) applySearch(els);
    });
    unsubDocs = subscribeDocs(user.uid, (arr)=>{
      docsData = arr;
      renderHomeFromSeparateSources(els);
      if (els.search?.value?.trim()) applySearch(els);
    });
  } else {
    videosData = [];
    docsData = [];
    renderHomeFromSeparateSources(els);
  }
});

// ---------- CRUD (GIỮ NGUYÊN theo items) ----------
async function addItem({ type, title, url, tags }){
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Bạn cần đăng nhập.");
  await addDoc(colRef(uid), {
    ownerId: uid,
    type, title, url, tags: tags || [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

async function updateItem(id, { type, title, url, tags }){
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Bạn cần đăng nhập.");
  await updateDoc(doc(db, `users/${uid}/items/${id}`), {
    type, title, url, tags: tags || [],
    updatedAt: serverTimestamp(),
  });
}

async function deleteItem(id){
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Bạn cần đăng nhập.");
  await deleteDoc(doc(db, `users/${uid}/items/${id}`));
}

// ---------- Language UI (đã vô hiệu hoá hành vi) ----------
function setupLanguageUI(els){
  document.querySelectorAll('.submenu a[data-lang]').forEach(a=>{
    a.addEventListener("click", (e)=>{
      e.preventDefault();
      e.stopPropagation();
    });
    a.classList.remove("active");
    a.setAttribute("aria-disabled", "true");
    a.style.pointerEvents = "none";
    a.style.opacity = "0.6";
  });

  applyLanguageToUI(els);
}
function applyLanguageToUI(els){
  els.search && (els.search.placeholder = t("searchPh"));
  const vh = document.getElementById("video-heading");
  const dh = document.getElementById("doc-heading");
  if (vh) vh.textContent = t("video");
  if (dh) dh.textContent = t("doc");
  els.videoEmpty && (els.videoEmpty.textContent = t("emptyVideo"));
  els.docEmpty && (els.docEmpty.textContent   = t("emptyDoc"));
  if (els.loginBtn) els.loginBtn.textContent = auth.currentUser ? t("logout") : t("login");
  const tabBar = document.querySelector(".profile__tabs");
  if (tabBar){
    const setText = (sel, txt) => {
      const el = tabBar.querySelector(sel);
      if (el) el.textContent = txt;
    };
    setText('[data-tab="overview"]', t("overview"));
    setText('[data-tab="videos"]',   t("videosTab"));
    setText('[data-tab="docs"]',     t("docsTab"));
    setText('[data-tab="uploads"]',  t("uploadsTab"));
  }
}

// ---------- Mobile UX (drawer + FAB mở đăng nhập) ----------
function wireMobileUX(els){
  els.btnOpenSidebar?.addEventListener("click", (e) => {
    e.stopPropagation();
    els.sidebar?.classList.add("open");
  });
  els.sidebar?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (els.sidebar?.classList.contains("open")) els.sidebar.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.sidebar?.classList.contains("open")) els.sidebar?.classList.remove("open");
  });

  // FAB: đăng nhập hoặc mở Editor khi đã login
  els.fab?.addEventListener("click", (e) => {
    e.preventDefault();
    if (auth.currentUser) {
      openEditor(els);
    } else {
      openLogin(els);
    }
  });
}

// ---------- (giữ nguyên để tương thích chỗ gọi cũ) ----------
function restoreLangUI(){ /* không dùng nữa */ }

// ===== Profile header =====
function shortNameFromEmail(email = "") {
  const name = (email.split("@")[0] || "").replace(/[._-]+/g, " ");
  if (!name) return "Người dùng";
  return name.split(" ").filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
function renderProfile(user){
  const header = document.getElementById("profile-header");
  const nameEl = document.getElementById("profile-name");
  const imgEl  = document.getElementById("profile-avatar");
  const fbEl   = document.getElementById("profile-avatar-fallback");

  if (!header || !nameEl || !imgEl || !fbEl) return;

  if (user) {
    const display = user.displayName || shortNameFromEmail(user.email || "") || "Người dùng";
    nameEl.textContent = display;

    if (user.photoURL) {
      imgEl.src = user.photoURL;
      imgEl.style.display = "block";
      fbEl.style.display = "none";
    } else {
      imgEl.removeAttribute("src");
      imgEl.style.display = "none";
      fbEl.textContent = display.trim().charAt(0).toUpperCase();
      fbEl.style.display = "flex";
    }
    header.hidden = false;
  } else {
    header.hidden = true;
  }
}

// Tabs cuộn tới section
document.querySelector(".profile__tabs")?.addEventListener("click", (e)=>{
  const btn = e.target.closest(".pill");
  if (!btn) return;
  document.querySelectorAll(".profile__tabs .pill").forEach(x=>x.classList.toggle("is-active", x===btn));

  const tab = btn.dataset.tab;
  if (tab === "overview") {
    document.getElementById("home-view")?.scrollIntoView({behavior:"smooth", block:"start"});
  } else if (tab === "videos") {
    document.getElementById("video-heading")?.scrollIntoView({behavior:"smooth", block:"start"});
  } else if (tab === "docs") {
    document.getElementById("doc-heading")?.scrollIntoView({behavior:"smooth", block:"start"});
  } else if (tab === "uploads") {
    const els = collectEls();
    if (auth.currentUser) openEditor(els);
    else openLogin(els);
  }
});

// ===== Sidebar active highlight & hành vi =====
function setupSidebarActive(){
  const links = Array.from(document.querySelectorAll(".sidebar__nav a"));
  if (!links.length) return;

  const here = location.pathname.replace(/\/+$/, "");
  let matched = false;
  for (const a of links) {
    try{
      const href = new URL(a.getAttribute("href"), location.origin).pathname.replace(/\/+$/, "");
      if (href && href !== "#" && here.endsWith(href)) {
        a.classList.add("active");
        a.setAttribute("aria-current","page");
        matched = true;
      } else {
        a.classList.remove("active");
        a.removeAttribute("aria-current");
      }
    }catch{ /* ignore */ }
  }
  if (!matched) document.getElementById("nav-home")?.classList.add("active");

  links.forEach(a=>{
    a.addEventListener("click", () => {
      links.forEach(x=>{ x.classList.remove("active"); x.removeAttribute("aria-current"); });
      a.classList.add("active");
      a.setAttribute("aria-current","page");
      document.body.classList.remove("sidebar-open");
      document.documentElement.classList.remove("no-scroll");
    });
  });
}

// ===== Mobile open/close sidebar với overlay =====
function mobileSidebar(){
  const btnOpen = document.getElementById("btn-open-sidebar");
  const sidebar = document.querySelector(".sidebar");
  if (!btnOpen || !sidebar) return;

  let overlay = document.getElementById("sidebar-overlay");
  if (!overlay){
    overlay = document.createElement("div");
    overlay.id = "sidebar-overlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.35);
      opacity:0; pointer-events:none; transition:opacity .2s; z-index:49;
    `;
    document.body.appendChild(overlay);
  }

  function openSide(){
    document.body.classList.add("sidebar-open");
    document.documentElement.classList.add("no-scroll");
    overlay.style.opacity = "1";
    overlay.style.pointerEvents = "auto";
  }
  function closeSide(){
    document.body.classList.remove("sidebar-open");
    document.documentElement.classList.remove("no-scroll");
    overlay.style.opacity = "0";
    overlay.style.pointerEvents = "none";
  }

  btnOpen.addEventListener("click", openSide);
  overlay.addEventListener("click", closeSide);
  window.addEventListener("keydown", (e)=>{ if(e.key==="Escape") closeSide(); });
}
