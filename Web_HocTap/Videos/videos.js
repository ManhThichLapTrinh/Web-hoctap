// /videos/videos.js — Public gallery (ai cũng xem) + Firebase Auth/Firestore sync + IndexedDB blobs + Cloudinary upload
// YÊU CẦU: trang có #btn-login, #login-dialog, #signup-dialog và các form/inputs tương ứng.
// Firestore Rules: 
//   - /videos_public/*  -> allow read: if true; create/update/delete: ownerId == request.auth.uid
//   - /users/{uid}/videos/* -> private backup của chủ sở hữu (tùy chọn)

/* =========================
 * IMPORTS (ESM)
 * ========================= */
import { auth, db, onUserChanged, loginWithEmail, signupWithEmail, logout } from "../js/firebase.js";
import {
  collection, doc, setDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp,
  getDocs, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

/* =========================
 * GLOBAL helpers (dùng cả ngoài IIFE)
 * ========================= */
function toggleNoScroll(lock){
  document.documentElement.classList.toggle('no-scroll', !!lock);
  document.body.classList.toggle('no-scroll', !!lock);
}

(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  /* =========================
   * THEME
   * ========================= */
  (function restoreTheme() {
    const saved = localStorage.getItem("theme") || "dark";
    if (saved === "light") document.documentElement.classList.add("light");
  })();
  $("#toggle-theme")?.addEventListener("click", () => {
    const toLight = !document.documentElement.classList.contains("light");
    document.documentElement.classList.toggle("light", toLight);
    localStorage.setItem("theme", toLight ? "light" : "dark");
    setTopbarHeightVar();
  });

  function setTopbarHeightVar(){
    const tb = document.querySelector('.topbar');
    const h = tb ? tb.offsetHeight : 56;
    document.documentElement.style.setProperty('--topbar-h', h + 'px');
  }
  setTopbarHeightVar();
  window.addEventListener('resize', setTopbarHeightVar);

  /* =========================
   * AUTH (Firebase)
   * ========================= */
  const loginBtn      = $("#btn-login");
  const loginDialog   = $("#login-dialog");
  const signupDialog  = $("#signup-dialog");
  const loginError    = $("#login-error");
  const signupError   = $("#signup-error");

  const elsAuth = {
    loginForm: $("#login-form"),
    loginEmail: $("#login-email"),
    loginPassword: $("#login-password"),
    loginToSignup: $("#login-to-signup"),
    signupForm: $("#signup-form"),
    signupEmail: $("#signup-email"),
    signupPassword: $("#signup-password"),
    signupPassword2: $("#signup-password2"),
    signupToLogin: $("#signup-to-login"),
  };

  const openDlg  = (dlg)=> dlg?.showModal?.();
  const closeDlg = (dlg)=> { try { dlg?.close?.(); } catch {} };

  // ❗ Sửa để giống trang chính: KHÔNG hiển thị email, chỉ "Đăng nhập"/"Đăng xuất"
  function setAuthUI(user){
    if (!loginBtn) return;
    loginBtn.textContent = user ? "Đăng xuất" : "Đăng nhập";
    loginBtn.dataset.state = user ? "in" : "out";
  }

  loginBtn?.addEventListener("click", async ()=>{
    if (auth.currentUser) { if (confirm("Đăng xuất?")) await logout(); }
    else { loginError.hidden = true; loginError.textContent=""; openDlg(loginDialog); }
  });
  elsAuth.loginToSignup?.addEventListener("click", (e)=>{ e.preventDefault(); closeDlg(loginDialog); openDlg(signupDialog); });
  elsAuth.signupToLogin?.addEventListener("click", (e)=>{ e.preventDefault(); closeDlg(signupDialog); openDlg(loginDialog); });

  elsAuth.loginForm?.addEventListener("submit", async (e)=>{
    if (e.submitter?.value === "cancel") return; e.preventDefault();
    try { await loginWithEmail(elsAuth.loginEmail.value.trim(), elsAuth.loginPassword.value); closeDlg(loginDialog); }
    catch(err){ loginError.textContent = err?.message || "Không đăng nhập được."; loginError.hidden=false; console.error(err); }
  });
  elsAuth.signupForm?.addEventListener("submit", async (e)=>{
    if (e.submitter?.value === "cancel") return; e.preventDefault();
    if (elsAuth.signupPassword.value !== elsAuth.signupPassword2.value){
      signupError.textContent="Mật khẩu nhập lại không khớp."; signupError.hidden=false; return;
    }
    try { await signupWithEmail(elsAuth.signupEmail.value.trim(), elsAuth.signupPassword.value); closeDlg(signupDialog); }
    catch(err){ signupError.textContent = err?.message || "Không tạo được tài khoản."; signupError.hidden=false; console.error(err); }
  });

  /* =========================
   * Cloudinary (unsigned)
   * ========================= */
  const CLOUD_NAME    = "dwdt9qb0e";   // <— chỉnh đúng của bạn
  const UPLOAD_PRESET = "Web_hoctap";  // <— chỉnh đúng của bạn
  const CLOUD_FOLDER  = "videos";
  const cloudinaryConfigured = () =>
    CLOUD_NAME && UPLOAD_PRESET && !/YOUR_/.test(CLOUD_NAME + UPLOAD_PRESET);

  async function uploadToCloudinary(file, uid) {
    if (!cloudinaryConfigured()) throw new Error("Cloudinary chưa cấu hình.");
    const form = new FormData();
    form.append("upload_preset", UPLOAD_PRESET);
    form.append("file", file);
    form.append("folder", `${CLOUD_FOLDER}/${uid}`);
    const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`;
    const res = await fetch(url, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "Upload thất bại");
    return {
      cloudUrl: data.secure_url,
      publicId: data.public_id,
      bytes: data.bytes,
      format: data.format,
      resourceType: data.resource_type,
      duration: data.duration
    };
  }
  function cloudinaryVideoThumb(publicId) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/so_1/${publicId}.jpg`;
  }

  /* =========================
   * IndexedDB (đổi tên biến: idb để không đè Firestore db)
   * ========================= */
  const DB_NAME = "videosDB.v1";
  const ST_VIDEOS = "videos";
  let idb; // <— KHÔNG dùng tên 'db' ở đây

  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = (e) => {
        const _idb = e.target.result;
        if (!_idb.objectStoreNames.contains(ST_VIDEOS)) {
          const s = _idb.createObjectStore(ST_VIDEOS, { keyPath: "id" });
          s.createIndex("createdAt", "createdAt");
          s.createIndex("title", "title");
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const tx   = (names, mode = "readonly") => idb.transaction(names, mode);
  const pify = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const done = (t)   => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const uid  = () => Math.random().toString(36).slice(2, 10);
  const nowISO = () => new Date().toISOString();
  const toISO = (x) => {
    try { if (x && typeof x.toDate === "function") return x.toDate().toISOString(); } catch {}
    return typeof x === "string" ? x : nowISO();
  };

  /* =========================
   * DOM refs
   * ========================= */
  const nodes = {
    grid: $("#vid-grid"),
    empty: $("#vid-empty"),
    count: $("#vid-count"),
    drop: $("#vid-dropzone"),
    fileInput: $("#vid-file-input"),
    openAdd: $("#vid-open-add"),
    cardTpl: $("#vid-card-template"),
    toggleDelete: $("#btn-toggle-delete"),

    search: $("#vid-search"),
    clearSearch: $("#vid-clear-search"),

    editDialog: $("#vid-edit-dialog"),
    editForm: $("#vid-edit-form"),
    dialogTitle: $("#vid-dialog-title"),
    title: $("#vid-title"),
    url: $("#vid-url"),
    tags: $("#vid-tags"),
    editingId: $("#vid-editing-id"),

    // theater
    theaterDialog: $('#vid-theater-dialog'),
    theaterPlayer: $('#theater-player'),
    theaterList:   $('#theater-list'),
    theaterTitle:  $('#theater-title'),
    theaterNote:   $('#theater-note'),
    noteStatus:    $('#note-status'),
  };

  /* =========================
   * State & helpers
   * ========================= */
  let deleteMode = false;
  let noteTimer = null;
  let currentObjectURL = null;
  let currentVideo = null;

  function parseTags(s) {
    return (s || "")
      .split(/\s+/).map((t) => t.trim()).filter(Boolean)
      .map((t) => (t.startsWith("#") ? t : "#" + t));
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("vi-VN", { year: "numeric", month: "short", day: "2-digit" });
  }

  // URL helpers
  function isYouTube(u){ return /(youtube\.com|youtu\.be|m\.youtube\.com)/i.test(u||''); }
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
  function ytEmbed(u, { autoplay = true, mute = true } = {}) {
    const id = youTubeId(u);
    if (!id) return null;
    const qs = new URLSearchParams({
      autoplay: autoplay ? 1 : 0,
      mute: mute ? 1 : 0,
      rel: 0,
      modestbranding: 1,
      playsinline: 1
    });
    return `https://www.youtube.com/embed/${id}?${qs.toString()}`;
  }
  function isVimeo(u){ return /vimeo\.com/i.test(u||''); }
  function vimeoEmbed(u){
    try{ const url = new URL(u); const m = url.pathname.match(/\/(\d+)/); return m ? `https://player.vimeo.com/video/${m[1]}` : null; }
    catch{ return null; }
  }
  function normalizeDirectVideoURL(u){
    if (!u) return u;
    try{
      const url = new URL(u);
      if (url.hostname.includes('drive.google.com')){
        const m = url.pathname.match(/\/file\/d\/([^/]+)\//);
        if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
      }
    }catch{}
    return u;
  }
  function youTubeThumb(u) {
    const id = youTubeId(u);
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
  }

  async function grabFrameFromBlob(blob, atSec = 1) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.src = URL.createObjectURL(blob);
      const cleanup = () => URL.revokeObjectURL(video.src);

      video.addEventListener("loadeddata", () => {
        const to = Math.min(atSec, video.duration || atSec);
        const onSeeked = () => {
          try {
            const canvas = document.createElement("canvas");
            const w = video.videoWidth || 640;
            const h = video.videoHeight || 360;
            const maxW = 640;
            const scale = Math.min(1, maxW / w);
            canvas.width = Math.floor(w * scale);
            canvas.height = Math.floor(h * scale);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataURL = canvas.toDataURL("image/jpeg", 0.8);
            cleanup(); resolve(dataURL);
          } catch (err) { cleanup(); reject(err); }
        };
        video.currentTime = to || 0;
        video.addEventListener("seeked", onSeeked, { once: true });
      }, { once: true });

      video.addEventListener("error", () => { cleanup(); reject(new Error("load video error")); }, { once: true });
    });
  }

  async function saveThumb(id, thumb) {
    const t = tx([ST_VIDEOS], "readwrite");
    const s = t.objectStore(ST_VIDEOS);
    const cur = await pify(s.get(id));
    if (!cur) return;
    cur.thumb = thumb;
    cur.updatedAt = nowISO();
    s.put(cur);
    await done(t);
  }
  async function ensureThumb(v) {
    if (v.thumb) return v.thumb;
    if (v.publicId) {
      const img = cloudinaryVideoThumb(v.publicId);
      await saveThumb(v.id, img);
      return img;
    }
    if (v.type === "file" && v.blob) {
      try {
        const dataURL = await grabFrameFromBlob(v.blob, 1);
        await saveThumb(v.id, dataURL);
        return dataURL;
      } catch { return null; }
    }
    if (v.type === "url" && v.url) {
      if (isYouTube(v.url)) {
        const img = youTubeThumb(v.url);
        if (img) { await saveThumb(v.id, img); return img; }
      }
    }
    return null;
  }

  /* =========================
   * FIRESTORE: PUBLIC & PRIVATE
   * ========================= */
  const COL_PUBLIC = collection(db, "videos_public");           // ai cũng xem
  const COL_VIDEOS = (uid) => collection(db, "users", uid, "videos"); // riêng từng user (tuỳ chọn)

  let unsubPublic = null;
  let unsubCloud  = null;

  function handleFsError(err, where=""){
    if (err?.code === "permission-denied") {
      console.warn("[Videos] permission-denied @", where, err);
      alert("Không có quyền với dữ liệu video trên đám mây.\nHãy kiểm tra Firestore Rules.");
    } else {
      console.error("[Videos] Firestore error @", where, err);
    }
  }

  async function applyCloudDocToLocal(docId, data){
    const t = tx([ST_VIDEOS], "readwrite");
    const s = t.objectStore(ST_VIDEOS);
    const cur = await pify(s.get(docId));

    const mapped = {
      id: docId,
      title: data.title ?? cur?.title ?? "",
      type:  data.type  ?? cur?.type  ?? "url",
      url:   data.url   ?? cur?.url   ?? "",
      tags:  Array.isArray(data.tags) ? data.tags : (cur?.tags || []),
      thumb: data.thumb ?? cur?.thumb ?? null,
      note:  data.note  ?? cur?.note  ?? "",
      cloudUrl: data.cloudUrl ?? cur?.cloudUrl ?? "",
      publicId: data.publicId ?? cur?.publicId ?? "",
      ownerId: data.ownerId ?? cur?.ownerId ?? null,
      size:  cur?.size ?? null,
      mime:  cur?.mime ?? null,
      blob:  cur?.blob ?? null, // blob chỉ local
      createdAt: toISO(data.createdAt) || cur?.createdAt || nowISO(),
      updatedAt: toISO(data.updatedAt) || nowISO(),
      _dirty: false
    };
    s.put(mapped);
    await done(t);
  }

  // Subscribe công khai: ai cũng xem được
  async function subscribePublicVideos(){
    if (unsubPublic) { try{unsubPublic();}catch{}; unsubPublic=null; }
    unsubPublic = onSnapshot(
      query(COL_PUBLIC, orderBy("updatedAt","desc")),
      async (snap)=>{
        const jobs = [];
        snap.docChanges().forEach(ch=>{
          if (ch.type === "removed") {
            jobs.push((async()=>{
              const t = tx([ST_VIDEOS], "readwrite");
              t.objectStore(ST_VIDEOS).delete(ch.doc.id);
              await done(t);
            })());
          } else {
            jobs.push(applyCloudDocToLocal(ch.doc.id, ch.doc.data()));
          }
        });
        await Promise.all(jobs);
        await render();
      },
      (err)=> handleFsError(err, "onSnapshot(videos_public)")
    );
  }

  // (Tuỳ chọn) subscribe bộ sưu tập riêng tư của chính mình
  async function subscribeCloudVideos(){
    if (unsubCloud) { try{unsubCloud();}catch{}; unsubCloud=null; }
    const user = auth.currentUser;
    if (!user) return;

    unsubCloud = onSnapshot(
      query(COL_VIDEOS(user.uid), orderBy("updatedAt","desc")),
      async (snap)=>{
        const jobs = [];
        snap.docChanges().forEach(ch=>{
          if (ch.type === "removed") {
            jobs.push((async()=>{
              const t = tx([ST_VIDEOS], "readwrite");
              t.objectStore(ST_VIDEOS).delete(ch.doc.id);
              await done(t);
            })());
          } else {
            jobs.push(applyCloudDocToLocal(ch.doc.id, ch.doc.data()));
          }
        });
        await Promise.all(jobs);
        await render();
      },
      (err)=> handleFsError(err, "onSnapshot(users/*/videos)")
    );
  }

  // Kéo 1 lượt private (tuỳ chọn)
  async function initialCloudPull(uid){
    try {
      const snap = await getDocs(COL_VIDEOS(uid)); // không orderBy
      for (const d of snap.docs){
        await applyCloudDocToLocal(d.id, d.data());
      }
      await render();
    } catch (err) {
      handleFsError(err, "initialCloudPull/getDocs");
    }
  }
  async function backfillUpdatedAt(uid){
    try {
      const snap = await getDocs(COL_VIDEOS(uid));
      const jobs = [];
      for (const d of snap.docs){
        const data = d.data();
        if (!data.updatedAt){
          jobs.push(updateDoc(doc(COL_VIDEOS(uid), d.id), { updatedAt: serverTimestamp() }));
        }
      }
      if (jobs.length) await Promise.all(jobs);
    } catch (err) {
      console.warn("[Videos] backfillUpdatedAt warn:", err?.message || err);
    }
  }

  // Đẩy các bản ghi offline lên cloud + MIRROR sang public
  async function pushDirtyToCloud() {
    const user = auth.currentUser;
    if (!user) return;
    const t = tx([ST_VIDEOS], "readonly");
    const all = await pify(t.objectStore(ST_VIDEOS).getAll());

    for (const v of all) {
      if (!v._dirty) continue;

      try {
        let cloudUrl = v.cloudUrl || "";
        let publicId = v.publicId || "";

        // Nếu là file & có blob & chưa có cloudUrl -> upload Cloudinary
        if (v.type === "file" && v.blob && cloudinaryConfigured() && !cloudUrl) {
          const up = await uploadToCloudinary(v.blob, user.uid);
          cloudUrl = up.cloudUrl; publicId = up.publicId;

          const t2 = tx([ST_VIDEOS], "readwrite"); const s2=t2.objectStore(ST_VIDEOS);
          const cur = await pify(s2.get(v.id));
          if (cur) {
            cur.cloudUrl = cloudUrl;
            cur.publicId = publicId;
            cur.size = up.bytes ?? cur.size;
            cur.updatedAt = nowISO();
            s2.put(cur);
          }
          await done(t2);

          try { await saveThumb(v.id, cloudinaryVideoThumb(publicId)); } catch {}
        }

        // Ghi vào private
        await setDoc(doc(COL_VIDEOS(user.uid), v.id), {
          ownerId: user.uid,
          title: v.title || "",
          type: v.type || "url",
          url: v.type === "url" ? (v.url || "") : "",
          tags: Array.isArray(v.tags) ? v.tags : [],
          thumb: v.thumb || null,
          note: v.note || "",
          cloudUrl: cloudUrl || null,
          publicId: publicId || null,
          size: v.size || null,
          mime: v.mime || null,
          createdAt: v.createdAt ? new Date(v.createdAt) : serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });

        // MIRROR sang public
        await setDoc(doc(COL_PUBLIC, v.id), {
          ownerId: user.uid,
          title: v.title || "",
          type: v.type || "url",
          url: v.type === "url" ? (v.url || "") : "",
          tags: Array.isArray(v.tags) ? v.tags : [],
          thumb: v.thumb || null,
          note: v.note || "",
          cloudUrl: cloudUrl || null,
          publicId: publicId || null,
          size: v.size || null,
          mime: v.mime || null,
          createdAt: v.createdAt ? new Date(v.createdAt) : serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });

        const t3 = tx([ST_VIDEOS], "readwrite"); const s3=t3.objectStore(ST_VIDEOS);
        const cur2 = await pify(s3.get(v.id)); if (cur2){ cur2._dirty=false; s3.put(cur2); } await done(t3);

      } catch (e) {
        handleFsError(e, "pushDirtyToCloud");
      }
    }
  }

  /* =========================
   * CRUD (local + cloud + public)
   * ========================= */
  async function getById(id) {
    const t = tx([ST_VIDEOS]);
    return await pify(t.objectStore(ST_VIDEOS).get(id));
  }
  async function listAll() {
    const t = tx([ST_VIDEOS]);
    const s = t.objectStore(ST_VIDEOS);
    const arr = await pify(s.getAll());
    return arr.sort((a, b) =>
      (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)
    );
  }

  async function addFiles(fileList) {
    // Cảnh báo nếu chưa login
    if (!auth.currentUser) {
      if (!window.__warnedNoLogin) {
        alert("Bạn đang thêm khi chưa đăng nhập. Dữ liệu sẽ chỉ lưu ở máy này cho tới khi bạn đăng nhập lại trên máy này để đồng bộ lên cloud.");
        window.__warnedNoLogin = true;
      }
    }

    const t = tx([ST_VIDEOS], "readwrite");
    const s = t.objectStore(ST_VIDEOS);
    const ids = [];
    for (const f of fileList) {
      const rec = {
        id: uid(),
        title: f.name.replace(/\.(mp4|webm|mkv|mov)$/i, ""),
        type: "file",
        tags: [],
        createdAt: nowISO(),
        updatedAt: nowISO(),
        size: f.size,
        mime: f.type || "video/mp4",
        blob: f,
        thumb: null,
        note: "",
        _dirty: !auth.currentUser,
        _syncedMeta: false,
        cloudUrl: "",
        publicId: "",
        ownerId: auth.currentUser?.uid || null
      };
      s.put(rec); ids.push(rec.id);
    }
    await done(t);

    // tạo thumbnail tạm từ blob
    for (const id of ids) {
      const v = await getById(id);
      if (v?.blob) {
        try { const dataURL = await grabFrameFromBlob(v.blob, 1); await saveThumb(v.id, dataURL); }
        catch {}
      }
    }

    // Nếu đã đăng nhập & cấu hình Cloudinary -> upload + sync Firestore + mirror public
    if (auth.currentUser && cloudinaryConfigured()) {
      const user = auth.currentUser;
      for (const id of ids) {
        const v = await getById(id);
        try {
          const up = await uploadToCloudinary(v.blob, user.uid);

          // update local
          const t2 = tx([ST_VIDEOS], "readwrite"); const s2 = t2.objectStore(ST_VIDEOS);
          const cur = await pify(s2.get(v.id));
          if (cur) {
            cur.cloudUrl = up.cloudUrl;
            cur.publicId = up.publicId;
            cur.size = up.bytes ?? cur.size;
            cur.updatedAt = nowISO();
            cur.ownerId = user.uid;
            cur._dirty = false;
            cur._syncedMeta = true;
            s2.put(cur);
          }
          await done(t2);

          // thay thumbnail bằng frame Cloudinary
          try { await saveThumb(v.id, cloudinaryVideoThumb(up.publicId)); } catch {}

          // Firestore (private)
          await setDoc(doc(COL_VIDEOS(user.uid), v.id), {
            ownerId: user.uid,
            title: cur?.title || v.title,
            type: "file",
            url: "",
            tags: cur?.tags || [],
            thumb: cur?.thumb || null,
            note: cur?.note || "",
            cloudUrl: up.cloudUrl,
            publicId: up.publicId,
            size: cur?.size || up.bytes || null,
            mime: cur?.mime || null,
            createdAt: new Date(cur?.createdAt || v.createdAt),
            updatedAt: serverTimestamp()
          }, { merge: true });

          // MIRROR: public
          await setDoc(doc(COL_PUBLIC, v.id), {
            ownerId: user.uid,
            title: cur?.title || v.title,
            type: "file",
            url: "",
            tags: cur?.tags || [],
            thumb: cur?.thumb || null,
            note: cur?.note || "",
            cloudUrl: up.cloudUrl,
            publicId: up.publicId,
            size: cur?.size || up.bytes || null,
            mime: cur?.mime || null,
            createdAt: new Date(cur?.createdAt || v.createdAt),
            updatedAt: serverTimestamp()
          }, { merge: true });

        } catch (err) {
          handleFsError(err, "addFiles/upload+sync");
          const t3 = tx([ST_VIDEOS], "readwrite"); const s3=t3.objectStore(ST_VIDEOS);
          const cur = await pify(s3.get(v.id)); if (cur){ cur._dirty = true; s3.put(cur); } await done(t3);
        }
      }
    } else if (auth.currentUser) {
      // nếu chưa cấu hình Cloudinary: ít nhất sync metadata + mirror public
      const user = auth.currentUser;
      for (const id of ids) {
        const v = await getById(id);
        try {
          await setDoc(doc(COL_VIDEOS(user.uid), v.id), {
            ownerId: user.uid,
            title: v.title, type: "file", url: "", tags: v.tags || [],
            thumb: v.thumb || null, note: v.note || "",
            createdAt: new Date(v.createdAt), updatedAt: serverTimestamp()
          }, { merge: true });

          await setDoc(doc(COL_PUBLIC, v.id), {
            ownerId: user.uid,
            title: v.title, type: "file", url: "", tags: v.tags || [],
            thumb: v.thumb || null, note: v.note || "",
            createdAt: new Date(v.createdAt), updatedAt: serverTimestamp()
          }, { merge: true });

          const t2 = tx([ST_VIDEOS], "readwrite"); const s2=t2.objectStore(ST_VIDEOS);
          const cur = await pify(s2.get(v.id)); if (cur){ cur._dirty=false; cur._syncedMeta=true; s2.put(cur); } await done(t2);
        } catch (err) { handleFsError(err, "addFiles/syncMeta"); }
      }
    }

    await render();
  }

  async function upsertLink(payload) {
    // Cảnh báo nếu chưa login
    if (!auth.currentUser) {
      if (!window.__warnedNoLogin) {
        alert("Bạn đang thêm khi chưa đăng nhập. Dữ liệu sẽ chỉ lưu ở máy này cho tới khi bạn đăng nhập lại trên máy này để đồng bộ lên cloud.");
        window.__warnedNoLogin = true;
      }
    }

    // Local
    const t = tx([ST_VIDEOS], "readwrite");
    const s = t.objectStore(ST_VIDEOS);
    let id = payload.id || uid();
    const now = nowISO();

    const prev = payload.id ? await pify(s.get(payload.id)) : null;
    const next = {
      id,
      title: (payload.title || "").trim() || payload.url || "Video",
      type: "url",
      url: payload.url,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      thumb: prev?.thumb || null,
      note:  prev?.note  || "",
      cloudUrl: prev?.cloudUrl || "",
      publicId: prev?.publicId || "",
      ownerId: auth.currentUser?.uid || prev?.ownerId || null,
      _dirty: !auth.currentUser
    };
    s.put(next);
    await done(t);

    // nếu YouTube -> lưu thumb nhanh
    if (next.url && isYouTube(next.url)) {
      const img = youTubeThumb(next.url);
      if (img) await saveThumb(id, img);
    }

    // Cloud + Public
    if (auth.currentUser) {
      try {
        await setDoc(doc(COL_VIDEOS(auth.currentUser.uid), id), {
          ownerId: auth.currentUser.uid,
          title: next.title, type: next.type, url: next.url,
          tags: next.tags, thumb: next.thumb || null, note: next.note || "",
          cloudUrl: next.cloudUrl || null, publicId: next.publicId || null,
          createdAt: prev?.createdAt ? new Date(prev.createdAt) : serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(COL_PUBLIC, id), {
          ownerId: auth.currentUser.uid,
          title: next.title, type: next.type, url: next.url,
          tags: next.tags, thumb: next.thumb || null, note: next.note || "",
          cloudUrl: next.cloudUrl || null, publicId: next.publicId || null,
          createdAt: prev?.createdAt ? new Date(prev.createdAt) : serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });

        const t2 = tx([ST_VIDEOS], "readwrite"); const s2=t2.objectStore(ST_VIDEOS);
        const cur = await pify(s2.get(id)); if (cur){ cur._dirty=false; s2.put(cur); } await done(t2);
      } catch (err) { handleFsError(err, "upsertLink/setDoc"); }
    }

    await render();
  }

  async function deleteVideo(id) {
    if (!confirm("Xoá video này?")) return;
    // Local
    const t = tx([ST_VIDEOS], "readwrite");
    t.objectStore(ST_VIDEOS).delete(id);
    await done(t);
    // Cloud (private + public — chỉ chủ sở hữu xoá được ở public theo rules)
    if (auth.currentUser) {
      try { 
        await deleteDoc(doc(COL_VIDEOS(auth.currentUser.uid), id));
        await deleteDoc(doc(COL_PUBLIC, id));
      }
      catch (err){ handleFsError(err, "deleteVideo/deleteDoc"); }
    }
    await render();
  }

  async function saveNote(id, noteText){
    // Local
    const t = tx([ST_VIDEOS], 'readwrite');
    const s = t.objectStore(ST_VIDEOS);
    const cur = await pify(s.get(id));
    if (!cur) return;
    cur.note = noteText || '';
    cur.updatedAt = nowISO();
    if (!auth.currentUser) cur._dirty = true;
    s.put(cur);
    await done(t);

    // Cloud + Public
    if (auth.currentUser) {
      try {
        await setDoc(doc(COL_VIDEOS(auth.currentUser.uid), id), {
          note: noteText || '', updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(COL_PUBLIC, id), {
          note: noteText || '', updatedAt: serverTimestamp()
        }, { merge: true });

        const t2 = tx([ST_VIDEOS], "readwrite"); const s2=t2.objectStore(ST_VIDEOS);
        const c2 = await pify(s2.get(id)); if (c2){ c2._dirty=false; s2.put(c2); } await done(t2);
      } catch (err){ handleFsError(err, "saveNote/setDoc"); }
    }
  }

  /* =========================
   * RENDER GRID
   * ========================= */
  async function render() {
    const all = await listAll();
    const q = (nodes.search?.value || "").trim().toLowerCase();
    const filtered = !q ? all : all.filter((v) => {
      const hay = `${v.title} ${(v.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });

    nodes.grid.innerHTML = "";
    nodes.empty.hidden = filtered.length > 0;
    if (nodes.count) nodes.count.textContent = `${filtered.length} video`;

    for (const v of filtered) {
      const thumbUrl = await ensureThumb(v).catch(() => null);

      const card = nodes.cardTpl.content.firstElementChild.cloneNode(true);
      card.dataset.id = v.id;
      card.__video = v;

      card.querySelector("[data-title]").textContent = v.title;
      const meta = card.querySelector("[data-meta]");
      const tagsText = (v.tags || []).join(" ");
      meta.textContent = `${fmtDate(v.updatedAt || v.createdAt)}${tagsText ? " • " + tagsText : ""}`;

      const thumbBox = card.querySelector(".vid-thumb");
      if (thumbUrl) { thumbBox.style.backgroundImage = `url("${thumbUrl}")`; }
      else { thumbBox.style.backgroundImage = ""; }

      // Chế độ xoá: CHỈ cho phép xoá nếu bạn là chủ (ownerId = currentUser.uid)
      const delBtn = card.querySelector(".btn-del");
      const canDelete = deleteMode && auth.currentUser && (v.ownerId === auth.currentUser.uid);
      card.classList.toggle("show-delete", canDelete);
      if (delBtn) delBtn.hidden = !canDelete;

      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "video", id: v.id }));
      });

      nodes.grid.appendChild(card);
    }
  }

  /* =========================
   * EVENT DELEGATION (Delete + Play)
   * ========================= */
  nodes.grid?.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete], .btn-del");
    if (del) {
      e.preventDefault(); e.stopPropagation();
      const card = del.closest("[data-id]");
      const id = card?.dataset.id;
      if (id) deleteVideo(id);
      return;
    }

    const play = e.target.closest("[data-play]");
    if (play) {
      e.preventDefault(); e.stopPropagation();
      const card = play.closest("[data-id]");
      const v = card?.__video;
      if (v) openTheater(v);
      return;
    }
  });

  /* =========================
   * TOGGLE DELETE MODE
   * ========================= */
  nodes.toggleDelete?.addEventListener("click", () => {
    deleteMode = !deleteMode;
    nodes.toggleDelete.classList.toggle("active", deleteMode);
    // render lại để áp dụng quyền xoá theo ownerId
    render();
  });

  /* =========================
   * ADD LINK DIALOG
   * ========================= */
  nodes.openAdd?.addEventListener("click", () => {
    nodes.editingId.value = "";
    nodes.dialogTitle.textContent = "Thêm video";
    nodes.title.value = "";
    nodes.url.value = "";
    nodes.tags.value = "";
    nodes.editDialog?.showModal();
  });
  nodes.editForm?.addEventListener("submit", async (e) => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    const id = nodes.editingId.value || undefined;
    const title = nodes.title.value.trim();
    const url = nodes.url.value.trim();
    const tags = parseTags(nodes.tags.value);
    if (!title) return;
    if (!url) { alert("Hãy nhập liên kết video hoặc dùng nút Tải lên."); return; }
    await upsertLink({ id, title, url, tags, type: "url" });
    nodes.editDialog?.close();
  });

  /* =========================
   * UPLOAD & DRAGDROP
   * ========================= */
  nodes.fileInput?.addEventListener("change", async (e) => {
    const fs = e.target.files;
    if (fs?.length) await addFiles(fs);
    e.target.value = "";
  });
  ["dragenter", "dragover"].forEach((evt) => {
    nodes.drop?.addEventListener(evt, (e) => { e.preventDefault(); nodes.drop.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach((evt) => {
    nodes.drop?.addEventListener(evt, (e) => { if (evt !== "drop") nodes.drop.classList.remove("dragover"); });
  });
  nodes.drop?.addEventListener("drop", async (e) => {
    e.preventDefault(); nodes.drop.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) { await addFiles(e.dataTransfer.files); return; }
    const text = e.dataTransfer.getData("text/plain");
    if (text && /^https?:\/\//i.test(text)) {
      nodes.editingId.value = "";
      nodes.dialogTitle.textContent = "Thêm video";
      nodes.title.value = text;
      nodes.url.value = text;
      nodes.tags.value = "";
      nodes.editDialog?.showModal();
    }
  });

  /* =========================
   * SEARCH
   * ========================= */
  function applySearch() { render(); }
  nodes.search?.addEventListener("input", applySearch);
  nodes.clearSearch?.addEventListener("click", () => { nodes.search.value = ""; applySearch(); });

  /* =========================
   * THEATER (docked)
   * ========================= */
  function clearTheaterPlayer(){
    if (currentObjectURL){
      try { URL.revokeObjectURL(currentObjectURL); } catch {}
      currentObjectURL = null;
    }
    nodes.theaterPlayer.innerHTML = '';
  }

  function tokenize(title){
    return (title||'').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu,' ').split(/\s+/).filter(Boolean);
  }
  function jaccard(a,b){
    const A = new Set(a), B = new Set(b);
    const inter = [...A].filter(x=>B.has(x)).length;
    const uni = new Set([...A, ...B]).size || 1;
    return inter/uni;
  }
  function extractNumberTrail(title){
    const m = (title||'').match(/(\d+)\s*$/);
    return m ? parseInt(m[1],10) : null;
  }

  async function buildRecommendations(video){
    const all = await listAll();
    const others = all.filter(v => v.id !== video.id);
    const baseTokens = tokenize(video.title);
    const baseNum = extractNumberTrail(video.title);

    const scored = [];
    for (const v of others){
      const tks = tokenize(v.title);
      const num = extractNumberTrail(v.title);
      let score = jaccard(baseTokens, tks);
      if (baseNum != null && num != null){
        const diff = Math.abs(baseNum - num);
        score += Math.max(0, 1 - Math.min(diff, 5) / 5);
      }
      const thumb = await ensureThumb(v).catch(()=>null);
      scored.push({ v, s: score, t: tks, thumb });
    }
    scored.sort((a,b)=> b.s - a.s || (b.v.updatedAt||b.v.createdAt).localeCompare(a.v.updatedAt||a.v.createdAt));
    return scored.slice(0, 30);
  }

  async function loadIntoTheater(video){
    currentVideo = video;
    clearTheaterPlayer();

    // --- Player ---
    if (video.type === 'file') {
      if (video.cloudUrl) {
        const el = document.createElement('video');
        el.controls = true; el.playsInline = true; el.preload = 'metadata'; el.src = video.cloudUrl;
        nodes.theaterPlayer.appendChild(el);
        el.play().catch(()=>{});
      } else if (video.blob){
        const url = URL.createObjectURL(video.blob);
        currentObjectURL = url;
        const el = document.createElement('video');
        el.controls = true; el.playsInline = true; el.src = url;
        nodes.theaterPlayer.appendChild(el);
        el.play().catch(()=>{});
      } else {
        const p = document.createElement('p');
        p.textContent = 'Video chưa có link đám mây và không còn blob cục bộ.'; 
        p.style.color = 'var(--muted)'; nodes.theaterPlayer.appendChild(p);
      }
    } else if (video.type === 'url' && video.url){
      const u = video.url.trim();
      if (isYouTube(u)){
        const src = ytEmbed(u, { autoplay: true, mute: true });
        if (src){
          const el = document.createElement('iframe');
          el.src = src; el.allowFullscreen = true;
          el.setAttribute('allow','accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
          el.referrerPolicy = 'origin-when-cross-origin';
          nodes.theaterPlayer.appendChild(el);
        }
      } else if (isVimeo(u)){
        const src = vimeoEmbed(u);
        if (src){
          const el = document.createElement('iframe');
          el.src = src; el.allowFullscreen = true;
          el.setAttribute('allow','autoplay; fullscreen; picture-in-picture');
          el.referrerPolicy = 'origin-when-cross-origin';
          nodes.theaterPlayer.appendChild(el);
        }
      } else {
        const direct = normalizeDirectVideoURL(u);
        const el = document.createElement('video');
        el.controls = true; el.playsInline = true; el.preload = 'metadata'; el.src = direct;
        nodes.theaterPlayer.appendChild(el);
      }
    } else {
      const p = document.createElement('p');
      p.textContent = 'Không thể phát video này.'; p.style.color = 'var(--muted)';
      nodes.theaterPlayer.appendChild(p);
    }

    // --- Tiêu đề & Ghi chú ---
    nodes.theaterTitle.textContent = video.title || 'Video';
    nodes.theaterNote.value = video.note || '';
    nodes.noteStatus.textContent = '';
    nodes.theaterNote.oninput = ()=>{
      nodes.noteStatus.textContent = 'Đang lưu…';
      clearTimeout(noteTimer);
      const text = nodes.theaterNote.value;
      const vid = currentVideo?.id;
      noteTimer = setTimeout(async ()=>{
        if (!vid) return;
        await saveNote(vid, text);
        if (currentVideo && currentVideo.id === vid){
          nodes.noteStatus.textContent = 'Đã lưu';
        }
      }, 400);
    };

    // --- Danh sách gợi ý ---
    const recs = await buildRecommendations(video);
    nodes.theaterList.innerHTML = '';
    for (const { v, thumb } of recs){
      const item = document.createElement('div');
      item.className = 'theater-item';
      item.dataset.id = v.id;
      if (v.id === video.id) item.classList.add('active');

      const th = document.createElement('div');
      th.className = 'theater-thumb';
      if (thumb) th.style.backgroundImage = `url("${thumb}")`;

      const meta = document.createElement('div'); meta.className = 'theater-meta';
      const title = document.createElement('p'); title.className = 'theater-title'; title.textContent = v.title;
      const sub = document.createElement('div'); sub.className = 'theater-sub';
      const num = extractNumberTrail(v.title);
      sub.textContent = `${fmtDate(v.updatedAt||v.createdAt)}${num!=null ? ` • #${num}`:''}`;

      meta.appendChild(title); meta.appendChild(sub);
      item.appendChild(th); item.appendChild(meta);
      nodes.theaterList.appendChild(item);
    }
  }

  async function openTheater(video){
    await loadIntoTheater(video);
    nodes.theaterDialog.showModal();
    toggleNoScroll(true);
  }

  nodes.theaterDialog?.addEventListener('close', () => { clearTheaterPlayer(); toggleNoScroll(false); });
  nodes.theaterDialog?.addEventListener('cancel', () => { clearTheaterPlayer(); toggleNoScroll(false); });

  nodes.theaterList?.addEventListener('click', async (e)=>{
    const item = e.target.closest('.theater-item');
    if (!item) return;
    const id = item.dataset.id;
    const v = await getById(id);
    if (v){
      await loadIntoTheater(v);
    }
  });

  /* =========================
   * BOOT
   * ========================= */
  openDB()
    .then(async (d) => { idb = d; await render(); })
    .catch((err) => {
      console.error("IndexedDB open error:", err);
      nodes.grid.innerHTML = "";
      nodes.empty.hidden = false;
      if (nodes.count) nodes.count.textContent = "0 video";
    });

  onUserChanged(async (user)=>{
    setAuthUI(user);

    // ✅ luôn hiển thị PUBLIC cho tất cả (kể cả khách)
    await subscribePublicVideos();

    // (tuỳ chọn) nếu muốn xem cả private của mình: bật 3 dòng dưới
    // if (user) {
    //   await initialCloudPull(user.uid);
    //   await subscribeCloudVideos();
    // }

    // nếu đăng nhập: đẩy bản offline lên & mirror public
    if (user) { await pushDirtyToCloud(); }
    else {
      if (unsubCloud) { try{unsubCloud();}catch{}; unsubCloud=null; }
    }

    await render();
  });
})();

/* =========================
 * Lock body scroll khi mở theater dialog
 * ========================= */
(function(){
  const dlg = document.getElementById('vid-theater-dialog');
  if (!dlg) return;
  if (dlg.open) toggleNoScroll(true);
  dlg.addEventListener('close', ()=> toggleNoScroll(false));
  dlg.addEventListener('cancel', ()=> toggleNoScroll(false));
})();

/* =========================
 * Live URL Preview (YouTube thumbnail)
 * ========================= */
(function(){
  const urlInput = document.getElementById('vid-url');
  const titleInput = document.getElementById('vid-title');
  const box = document.getElementById('url-preview');
  const img = document.getElementById('url-preview-img');
  const provider = document.getElementById('url-preview-provider');
  const title = document.getElementById('url-preview-title');
  if(!urlInput || !box) return;

  function youTubeIdLight(u){
    try{
      const s = u.trim();
      const m = s.match(/(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{11})/);
      return m ? m[1] : null;
    }catch{return null;}
  }
  function update(){
    const u = urlInput.value.trim();
    const id = youTubeIdLight(u);
    if (id){
      img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      provider.textContent = "YouTube";
      title.textContent = titleInput?.value || "(chưa có tiêu đề)";
      box.hidden = false;
    }else{
      box.hidden = true;
    }
  }
  urlInput.addEventListener('input', update);
  titleInput?.addEventListener('input', update);
  update();
})();

/* =========================
 * Unmute overlay for YouTube player (optional)
 * ========================= */
(function(){
  const dlg = document.getElementById('vid-theater-dialog');
  const playerBox = document.getElementById('theater-player');
  const unmuteBtn = document.getElementById('unmute-btn'); // nếu không có element này -> bỏ qua
  if (!playerBox || !unmuteBtn) return;

  function isYouTubeIframe(el){
    return el && el.tagName === 'IFRAME' && /youtube\.com\/embed\//.test(el.src);
  }
  function currentIframe(){ return playerBox?.querySelector('iframe'); }

  const observer = new MutationObserver(() => {
    const ifr = currentIframe();
    unmuteBtn.hidden = !isYouTubeIframe(ifr);
  });
  observer.observe(playerBox, { childList:true });

  function ytCommand(iframe, command, args=""){
    try{
      iframe.contentWindow.postMessage(JSON.stringify({
        event: "command",
        func: command,
        args: Array.isArray(args) ? args : [args]
      }), "*");
    }catch(e){ /* noop */ }
  }

  unmuteBtn?.addEventListener('click', () => {
    const ifr = currentIframe();
    if (!ifr) return;
    ytCommand(ifr, "unMute");
    ytCommand(ifr, "setVolume", 100);
    ytCommand(ifr, "playVideo");
    unmuteBtn.hidden = true;
  });

  dlg?.addEventListener('close', () => { unmuteBtn.hidden = true; });
})();
