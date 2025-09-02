// learning/learning.js
// Local-first + Firebase Auth/Firestore/Storage sync
// Requires: ../js/firebase.js (exports: app, auth, db, onUserChanged, loginWithEmail, logout)

import {
  app, auth, db, onUserChanged, loginWithEmail, logout,
} from "../js/firebase.js";

import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js";

/* =======================
   STATE & CONST
======================= */
const LS_KEY    = "studyLibrary.v1";       // cache cục bộ
const COLL_NAME = "materials_files";       // users/{uid}/materials_files

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let user = null;
let cloudReady = false;
let unsubItems = null;

let data = loadLocal();                    // { items: [...] }
let filterType = "all";
let searchText = "";
let activeTag  = null;

let selectMode = false;
const selectedIds = new Set();

const storage = getStorage(app);

/* =======================
   THEME (giống materials)
======================= */
// Khởi động theo theme đã lưu
(function restoreTheme() {
  const saved = localStorage.getItem("theme") || "dark";
  document.documentElement.classList.toggle("light", saved === "light");
})();

// Nút đổi theme (nếu tồn tại trong DOM)
$("#toggle-theme")?.addEventListener("click", () => {
  const toLight = !document.documentElement.classList.contains("light");
  document.documentElement.classList.toggle("light", toLight);
  localStorage.setItem("theme", toLight ? "light" : "dark");
});

/* =======================
   AUTH — giống trang chủ
   - Nút chỉ "Đăng nhập/Đăng xuất"
   - Ưu tiên mở dialog #login-dialog (nếu có)
   - Fallback sang prompt() nếu trang chưa có dialog
======================= */
const elsAuth = {
  btn: $("#btn-login"),
  loginDialog: $("#login-dialog"),
  loginForm: $("#login-form"),
  loginEmail: $("#login-email"),
  loginPassword: $("#login-password"),
  loginError: $("#login-error"),
  // tuỳ trang có/không có signup:
  signupDialog: $("#signup-dialog"),
  signupForm: $("#signup-form"),
  signupEmail: $("#signup-email"),
  signupPassword: $("#signup-password"),
  signupPassword2: $("#signup-password2"),
  signupError: $("#signup-error"),
  linkLoginToSignup: $("#login-to-signup"),
  linkSignupToLogin: $("#signup-to-login"),
};

const openDlg = (dlg) =>
  dlg?.showModal?.() ?? (dlg?.setAttribute("open",""), dlg&&(dlg.style.display="block"));

// ✅ Fallback đóng dialog chắc chắn
const closeDlg = (dlg) => {
  if (!dlg) return;
  try {
    if (typeof dlg.close === "function") dlg.close();
    else {
      dlg.removeAttribute("open");
      dlg.style.display = "none";
    }
  } catch {
    dlg.removeAttribute("open");
    dlg.style.display = "none";
  }
};

function setAuthButton(u) {
  if (!elsAuth.btn) return;
  elsAuth.btn.textContent = u ? "Đăng xuất" : "Đăng nhập";
  elsAuth.btn.title = elsAuth.btn.textContent;
  elsAuth.btn.dataset.state = u ? "in" : "out";
}

function wireTopbarAuth() {
  elsAuth.btn?.addEventListener("click", async () => {
    if (!user) {
      // Ưu tiên dùng dialog nếu có
      if (elsAuth.loginDialog && elsAuth.loginForm && elsAuth.loginEmail && elsAuth.loginPassword) {
        if (elsAuth.loginError) { elsAuth.loginError.hidden = true; elsAuth.loginError.textContent = ""; }
        openDlg(elsAuth.loginDialog);
      } else {
        // Fallback: prompt
        const email = prompt("Email đăng nhập:"); if (!email) return;
        const pass  = prompt("Mật khẩu:");        if (!pass)  return;
        try { await loginWithEmail(email.trim(), pass); toast("Đăng nhập thành công"); }
        catch (err) { console.warn(err); alert("Đăng nhập thất bại: " + (err?.code || err?.message)); }
      }
    } else {
      try { 
        await logout();
        closeDlg(elsAuth.loginDialog);
        closeDlg(elsAuth.signupDialog);
        toast("Đã đăng xuất");
      } catch(e){ console.warn(e); }
    }
  });

  // Nếu trang có form login/signup thì nối sự kiện để đồng bộ
  elsAuth.linkLoginToSignup?.addEventListener("click", (e) => {
    e.preventDefault(); closeDlg(elsAuth.loginDialog); openDlg(elsAuth.signupDialog);
  });
  elsAuth.linkSignupToLogin?.addEventListener("click", (e) => {
    e.preventDefault(); closeDlg(elsAuth.signupDialog); openDlg(elsAuth.loginDialog);
  });

  elsAuth.loginForm?.addEventListener("submit", async (e) => {
    // Cho phép nút "Huỷ" nếu tồn tại và có value="cancel"
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    try {
      const email = elsAuth.loginEmail?.value?.trim();
      const pass  = elsAuth.loginPassword?.value;
      await loginWithEmail(email, pass);
      // ✅ đóng dialog ngay khi thành công
      closeDlg(elsAuth.loginDialog);
      if (elsAuth.loginError) { elsAuth.loginError.hidden = true; elsAuth.loginError.textContent = ""; }
      toast("Đăng nhập thành công");
    } catch (err) {
      console.error(err);
      if (elsAuth.loginError) {
        elsAuth.loginError.textContent = err?.message || "Không đăng nhập được.";
        elsAuth.loginError.hidden = false;
      } else {
        alert("Không đăng nhập được.");
      }
    }
  });

  elsAuth.signupForm?.addEventListener("submit", async (e) => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    try {
      const pw1 = elsAuth.signupPassword?.value || "";
      const pw2 = elsAuth.signupPassword2?.value || "";
      if (pw1 !== pw2) {
        if (elsAuth.signupError) {
          elsAuth.signupError.textContent = "Mật khẩu nhập lại không khớp.";
          elsAuth.signupError.hidden = false;
        } else {
          alert("Mật khẩu nhập lại không khớp.");
        }
        return;
      }
      const email = elsAuth.signupEmail?.value?.trim();
      // Ghi chú: nếu bạn có hàm signupWithEmail trong firebase.js thì thay loginWithEmail bằng signupWithEmail
      await loginWithEmail(email, pw1);
      closeDlg(elsAuth.signupDialog);
      toast("Tạo tài khoản thành công");
    } catch (err) {
      console.error(err);
      if (elsAuth.signupError) {
        elsAuth.signupError.textContent = err?.message || "Không tạo được tài khoản.";
        elsAuth.signupError.hidden = false;
      } else {
        alert("Không tạo được tài khoản.");
      }
    }
  });
}

/* =======================
   BOOT
======================= */
window.addEventListener("DOMContentLoaded", () => {
  wireTopbarAuth();
  wireToolbar();
  wireAddDialog();

  renderAll();

  onUserChanged(async (u) => {
    user = u || null;
    setAuthButton(user);

    // ✅ Đảm bảo đóng mọi popup đăng nhập/đăng ký khi trạng thái đổi sang đã đăng nhập
    if (user) {
      closeDlg(elsAuth.loginDialog);
      closeDlg(elsAuth.signupDialog);
      elsAuth.loginForm?.reset?.();
      elsAuth.signupForm?.reset?.();
    }

    await subscribeItems();
  });
});

/* =======================
   FIRESTORE ITEMS SUBSCRIBE
======================= */
async function subscribeItems() {
  if (typeof unsubItems === "function") { try{unsubItems();}catch{} unsubItems = null; }

  if (!user) { cloudReady = false; data = loadLocal(); renderAll(); return; }

  try {
    const q = query(collection(db, "users", user.uid, COLL_NAME), orderBy("createdAt", "desc"));
    unsubItems = onSnapshot(q, (snap) => {
      cloudReady = true;
      const items = [];
      snap.forEach((d) => {
        const v = d.data() || {};
        items.push({
          id: d.id,
          title: v.title || "",
          type: v.type || inferType(v.url || ""),
          url: v.url || "",
          tags: Array.isArray(v.tags) ? v.tags : [],
          notes: v.notes || "",
          createdAt: toMillis(v.createdAt),
          updatedAt: toMillis(v.updatedAt),
          ownerId: v.ownerId || user.uid,
          thumb: v.thumb || null,            // thumbnail từ Storage/URL
        });
      });
      data.items = items;
      saveLocal();
      renderAll();
    }, (err) => {
      console.warn("[items sub] ", err);
      cloudReady = false;
      data = loadLocal(); renderAll();
    });
  } catch (e) {
    console.warn("[subscribe items] ", e);
    cloudReady = false;
    data = loadLocal(); renderAll();
  }
}
function toMillis(ts) {
  if (!ts) return Date.now();
  if (typeof ts?.toMillis === "function") return ts.toMillis();
  if (ts?.seconds) return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0)/1e6);
  return Number(ts) || Date.now();
}

/* =======================
   LOCAL STORAGE
======================= */
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { items: [] };
    const obj = JSON.parse(raw);
    return (obj && Array.isArray(obj.items)) ? obj : { items: [] };
  } catch {
    localStorage.removeItem(LS_KEY);
    return { items: [] };
  }
}
function saveLocal() { localStorage.setItem(LS_KEY, JSON.stringify(data)); }

/* =======================
   TOOLBAR
======================= */
function wireToolbar() {
  // Bộ lọc All/Video/Doc
  $$(".seg__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".seg__btn").forEach(b => { b.classList.remove("is-active"); b.setAttribute("aria-selected","false"); });
      btn.classList.add("is-active"); btn.setAttribute("aria-selected","true");
      filterType = btn.dataset.type;
      renderList();
    });
  });

  // Tìm kiếm (quét cả notes)
  $("#learning-search")?.addEventListener("input", (e) => {
    searchText = (e.target.value || "").trim().toLowerCase();
    renderList();
  });
  $("#learning-clear-search")?.addEventListener("click", () => {
    const el = $("#learning-search"); if (el) el.value = "";
    searchText = ""; renderList(); el?.focus();
  });

  // Nút mở popup thêm
  $("#open-add")?.addEventListener("click", () => {
    $("#add-dialog")?.showModal();
    setTimeout(() => $("#f-title")?.focus(), 0);
  });

  // Chế độ chọn
  $("#btn-select")?.addEventListener("click", () => {
    selectMode = !selectMode;
    $("#btn-select").textContent = selectMode ? "✅ Đang chọn" : "☑ Chọn";
    if (!selectMode) selectedIds.clear();
    updateSelectionUI();
  });

  // Sửa/Xoá
  $("#btn-edit")?.addEventListener("click", () => {
    if (selectedIds.size !== 1) return alert("Chọn đúng 1 mục để sửa.");
    editItemPrompt([...selectedIds][0]);
  });
  $("#btn-delete")?.addEventListener("click", async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Xoá ${selectedIds.size} mục đã chọn?`)) return;
    const ids = [...selectedIds];
    for (const id of ids) await deleteItem(id, { confirm: false });
    selectedIds.clear(); updateSelectionUI();
  });
}

/* =======================
   ADD DIALOG (title + url + tags + notes + thumb)
======================= */
function wireAddDialog() {
  const dlg  = $("#add-dialog");
  const form = $("#add-form");

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#f-title").value.trim();
    const url   = $("#f-url").value.trim();
    const tags  = $("#f-tags").value.split(",").map(s => s.trim()).filter(Boolean);
    const notes = ($("#f-notes")?.value || "").trim();

    // NEW: thumbnail inputs
    const fileInput = $("#f-thumb-file");
    const urlInput  = $("#f-thumb-url");
    const file = fileInput?.files?.[0] || null;
    const thumbUrlCandidate = (urlInput?.value || "").trim();

    if (!title || !url) return;
    const type  = inferType(url);

    // CLOUD FIRST
    if (cloudReady && user) {
      try {
        // 1) tạo doc trước, có thể chưa có thumb
        const ref = await addDoc(collection(db, "users", user.uid, COLL_NAME), {
          title, type, url, tags, notes,
          ownerId: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // 2) xử lý ảnh
        let finalThumb = null;
        if (file) {
          finalThumb = await uploadThumbToStorage(file, user.uid, ref.id);
        } else if (thumbUrlCandidate) {
          finalThumb = thumbUrlCandidate;
        }

        if (finalThumb) {
          await updateDoc(ref, { thumb: finalThumb, updatedAt: serverTimestamp() });
        }

        dlg.close(); form.reset();
        return;
      } catch (err) {
        console.warn("[addDoc/upload thumb] ", err);
        // rơi xuống local
      }
    }

    // LOCAL FALLBACK
    const now = Date.now();
    let thumb = null;
    if (file) {
      thumb = await readFileAsDataURL(file);  // base64 lưu local
    } else if (thumbUrlCandidate) {
      thumb = thumbUrlCandidate;
    }

    const item = { id: uid(), title, type, url, tags, notes, thumb, createdAt: now, updatedAt: now, ownerId: user?.uid || null };
    data.items.unshift(item);
    saveLocal(); renderAll();
    form.reset(); dlg.close();
  });
}

async function uploadThumbToStorage(file, uid, docId) {
  // Chuẩn hoá tên file
  const cleanName = (file.name || "thumb").replace(/[^\w\.-]+/g, "_").toLowerCase();
  const path = `users/${uid}/materials_thumbs/${docId}_${Date.now()}_${cleanName}`;
  const sref = storageRef(storage, path);
  const snap = await uploadBytes(sref, file, { contentType: file.type || "image/*" });
  const url = await getDownloadURL(snap.ref);
  return url;
}

/* =======================
   RENDER
======================= */
function renderAll() {
  renderTagCloud();
  renderList();
  toggleEmpty();
  updateSelectionUI();
}
function toggleEmpty() { $("#empty-hint").hidden = data.items.length > 0; }

function updateSelectionUI() {
  $$("#item-list .list-item").forEach(row => row.classList.toggle("is-selected", selectedIds.has(row.dataset.id)));
  const n = selectedIds.size, total = data.items.length;
  if ($("#btn-edit"))   $("#btn-edit").disabled   = !(n === 1);
  if ($("#btn-delete")) $("#btn-delete").disabled = n === 0;
  $("#learning-count").textContent = n > 0 ? `${n}/${total} mục đã chọn` : `${total} mục`;
}

function renderTagCloud() {
  const cloud = $("#tag-cloud"); cloud.innerHTML = "";
  const tagCount = new Map();
  data.items.forEach(it => (it.tags || []).forEach(t => tagCount.set(t, (tagCount.get(t)||0) + 1)));
  const tags = [...tagCount.entries()].sort((a,b)=> b[1]-a[1]).map(([t])=>t);

  if (tags.length === 0) { cloud.innerHTML = `<span class="muted">Chưa có tag nào.</span>`; return; }

  tags.forEach(tag => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tag" + (activeTag === tag ? " is-active" : "");
    el.textContent = `#${tag}`;
    el.addEventListener("click", () => { activeTag = (activeTag === tag ? null : tag); renderAll(); });
    cloud.appendChild(el);
  });

  const clear = document.createElement("button");
  clear.type = "button"; clear.className = "tag"; clear.textContent = "Clear";
  clear.style.marginLeft = "auto";
  clear.addEventListener("click", () => { activeTag = null; renderAll(); });
  cloud.appendChild(clear);
}

function renderList() {
  const list = $("#item-list");
  list.innerHTML = ""; list.className = "";

  let items = data.items.slice();
  if (filterType !== "all") items = items.filter(it => it.type === filterType);

  // Tìm kiếm gồm cả notes
  if (searchText) {
    items = items.filter(it => {
      const hay = (
        (it.title || "") + " " +
        (it.tags || []).join(" ") + " " +
        (it.url  || "") + " " +
        (it.notes|| "")
      ).toLowerCase();
      return hay.includes(searchText);
    });
  }

  if (activeTag) items = items.filter(it => (it.tags || []).includes(activeTag));

  if (items.length === 0) { list.innerHTML = `<li class="empty">Không có mục phù hợp.</li>`; return; }

  for (const it of items) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.dataset.id = it.id;

    // THUMB
    const thumb = document.createElement("div");
    thumb.className = "list-thumb";
    const bg = inferThumb(it);
    if (bg) thumb.style.backgroundImage = `url("${bg}")`; else thumb.textContent = it.type === "video" ? "🎬" : "📄";
    thumb.addEventListener("click", (e) => { e.stopPropagation(); if (selectMode) toggleSelect(it.id); });

    // MAIN
    const main = document.createElement("div");
    main.className = "list-main";

    // TIÊU ĐỀ (CHỈ điểm mở link)
    const h = document.createElement("h4");
    h.className = "item-title";
    const a = document.createElement("a");
    a.href = it.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = it.title || "(Không tiêu đề)";
    a.addEventListener("click", (e) => { e.stopPropagation(); });
    h.appendChild(a);
    main.appendChild(h);

    // GHI CHÚ ngay dưới tiêu đề
    if (it.notes) {
      const notes = document.createElement("p");
      notes.className = "item-notes";
      notes.textContent = trimNotes(it.notes);
      main.appendChild(notes);
    }

    // TAGS
    const tags = document.createElement("div");
    tags.className = "item-tags";
    (it.tags || []).forEach(t => {
      const span = document.createElement("span"); span.className = "tag"; span.textContent = `#${t}`;
      span.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); activeTag = t; renderAll(); });
      tags.appendChild(span);
    });
    if ((it.tags || []).length) main.appendChild(tags);

    // Click lên item: chỉ phục vụ chọn/bỏ chọn khi có selectMode
    li.addEventListener("click", () => { if (selectMode) toggleSelect(it.id); });

    if (selectedIds.has(it.id)) li.classList.add("is-selected");

    li.appendChild(thumb);
    li.appendChild(main);
    list.appendChild(li);
  }

  updateSelectionUI();
}

/* =======================
   CRUD
======================= */
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

async function editItemPrompt(id) {
  const it = data.items.find(x => x.id === id);
  if (!it) return;

  const title = prompt("Tiêu đề:", it.title); if (title == null) return;
  const url   = prompt("URL:", it.url);       if (url   == null) return;
  const tagsStr  = prompt("Tags (phân tách dấu phẩy):", (it.tags || []).join(",")); if (tagsStr == null) return;
  const notesStr = prompt("Ghi chú:", it.notes || "");                               if (notesStr == null) return;
  // Cho phép cập nhật thumb qua URL nhanh
  const thumbStr = prompt("URL hình (để trống giữ nguyên):", it.thumb || "");       if (thumbStr == null) return;

  const updated = {
    title: title.trim() || it.title,
    url: url.trim(),
    type: inferType(url.trim()),
    tags: tagsStr.split(",").map(s => s.trim()).filter(Boolean),
    notes: notesStr.trim(),
    ...(thumbStr.trim() ? { thumb: thumbStr.trim() } : {}),
  };

  if (cloudReady && user && !isLocalId(it.id)) {
    try {
      await updateDoc(doc(db, "users", user.uid, COLL_NAME, it.id), { ...updated, updatedAt: serverTimestamp() });
      return; // snapshot sẽ cập nhật
    } catch (err) { console.warn("[updateDoc] ", err); }
  }

  Object.assign(it, updated, { updatedAt: Date.now() });
  saveLocal(); renderAll();
}

async function deleteItem(id, opts = { confirm: true }) {
  if (opts.confirm && !confirm("Xoá mục này?")) return;
  if (cloudReady && user && !isLocalId(id)) {
    try { await deleteDoc(doc(db, "users", user.uid, COLL_NAME, id)); return; }
    catch (err) { console.warn("[deleteDoc] ", err); }
  }
  data.items = data.items.filter(x => x.id !== id);
  selectedIds.delete(id);
  saveLocal(); renderAll();
}

function isLocalId(id) { return id.length !== 20; } // Firestore id thường 20 ký tự

/* =======================
   HELPERS
======================= */
function inferType(url = "") {
  const u = url.toLowerCase();
  const isYT = !!parseYouTubeId(url);
  const isVidExt = /\.(mp4|webm|ogg)(\?.*)?$/.test(u);
  return (isYT || isVidExt) ? "video" : "doc";
}
function inferThumb(it) {
  if (it.thumb) return it.thumb;                                   // 1) dùng ảnh người dùng
  const yt = parseYouTubeId(it.url || "");
  if (yt) return `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;     // 2) YouTube thumb
  try {
    const u = new URL(it.url);                                     // 3) favicon
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`;
  } catch {
    return null;
  }
}
function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/embed\/([^\/\?]+)/); if (m) return m[1];
    }
  } catch {}
  return null;
}
function toggleSelect(id){ if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); updateSelectionUI(); }
function trimNotes(txt = "") { const s = txt.replace(/\s+/g, " ").trim(); return s.length > 160 ? s.slice(0,157) + "…" : s; }
function toast(msg) {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position:"fixed", right:"12px", bottom:"12px", zIndex:9999,
    background:"#151923", color:"#e6e6e6", border:"1px solid #2a3242",
    borderRadius:"10px", padding:"10px 12px"
  });
  el.textContent = msg; document.body.appendChild(el); setTimeout(()=>el.remove(), 2200);
}
async function readFileAsDataURL(file){
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
