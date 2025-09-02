// /materials-web/viewer.js — bỏ Google Docs Viewer; PDF iframe + Office via Microsoft Viewer
import { auth, db, onUserChanged, loginWithEmail, logout } from "../js/firebase.js";
import {
  collection, doc, getDoc, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const $  = (s)=>document.querySelector(s);

/* ========== Theme toggle ========== */
(function restoreTheme() {
  const saved = localStorage.getItem("theme") || "dark";
  document.documentElement.classList.toggle("light", saved === "light");
})();
$("#toggle-theme")?.addEventListener("click", () => {
  const toLight = !document.documentElement.classList.contains("light");
  document.documentElement.classList.toggle("light", toLight);
  localStorage.setItem("theme", toLight ? "light" : "dark");
});

/* ========== Params ========== */
const params   = new URLSearchParams(location.search);
let fileId     = params.get("file");
let folderHint = params.get("folder");

/* ========== Auth dialog ========== */
const elsAuth = {
  loginBtn: $("#btn-login"),
  loginDialog: $("#login-dialog"),
  loginForm: $("#login-form"),
  loginEmail: $("#login-email"),
  loginPassword: $("#login-password"),
  loginError: $("#login-error"),
};
const openDlg = (dlg)=> dlg?.showModal?.();
const closeDlg = (dlg)=> { try{ dlg?.close?.(); }catch{} };
const setAuthUI = (user)=>{
  if (!elsAuth.loginBtn) return;
  elsAuth.loginBtn.textContent = user ? (user.email || "Đăng xuất") : "Đăng nhập";
  elsAuth.loginBtn.dataset.state = user ? "in" : "out";
};
elsAuth.loginBtn?.addEventListener("click", async ()=>{
  if (auth.currentUser) await logout();
  else { elsAuth.loginError.hidden = true; elsAuth.loginError.textContent=""; openDlg(elsAuth.loginDialog); }
});
elsAuth.loginForm?.addEventListener("submit", async (e)=>{
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  try {
    await loginWithEmail(elsAuth.loginEmail.value.trim(), elsAuth.loginPassword.value);
    closeDlg(elsAuth.loginDialog);
  } catch(err){
    elsAuth.loginError.textContent = err?.message || "Không đăng nhập được.";
    elsAuth.loginError.hidden = false;
  }
});

/* ========== Firestore paths ========== */
const COL_FOLDERS = (uid) => collection(db, "users", uid, "materials_folders");
const COL_FILES   = (uid) => collection(db, "users", uid, "materials_files");

/* ========== Helpers ========== */
const fmtSize = (n)=>{ if(n==null) return ""; const u=["B","KB","MB","GB"]; let i=0,x=n; while(x>=1024&&i<u.length-1){x/=1024;i++;} return `${x.toFixed(x>=100?0:x>=10?1:2)} ${u[i]}`; };
const iconFor = (name) => {
  const n = (name||"").toLowerCase();
  if(/\.(png|jpe?g|gif|webp|svg)$/.test(n)) return '🖼️';
  if(/\.(mp4|webm|mkv|mov)$/.test(n)) return '🎞️';
  if(/\.(mp3|wav|ogg)$/.test(n)) return '🎵';
  if(/\.pdf$/.test(n)) return '📕';
  if(/\.(pptx?|key)$/.test(n)) return '📽️';
  if(/\.(docx?|pages)$/.test(n)) return '📘';
  if(/\.(xlsx?|numbers|csv)$/.test(n)) return '📊';
  return '📄';
};
const badgeFor = (mime, name)=>{
  const n=(name||"").toLowerCase();
  if(/\.(png|jpe?g|gif|webp|svg)$/.test(n)) return "Ảnh";
  if(/\.(mp4|webm|mkv|mov)$/.test(n)) return "Video";
  if(/\.(mp3|wav|ogg)$/.test(n)) return "Audio";
  if(/\.pdf$/.test(n)) return "PDF";
  if(/\.(pptx?|key)$/.test(n)) return "Slide";
  if(/\.(docx?|pages)$/.test(n)) return "Word";
  if(/\.(xlsx?|numbers|csv)$/.test(n)) return "Bảng";
  if(/\.(txt|md)$/.test(n)) return "Text";
  return (mime||"Khác").split("/")[1]?.toUpperCase?.() || "Khác";
};
const isTextMime = (mime) =>
  /^(text\/|application\/(json|xml|javascript))/.test(mime || "");

/* ====== Fallback mở tab ====== */
function openExternalLink(url){
  const p = document.createElement("p");
  p.style.textAlign="center"; p.style.padding="16px"; p.style.color="var(--muted)";
  p.innerHTML = `Không xem trực tiếp được. <a href="${url}" target="_blank" rel="noopener">Mở tab mới</a>`;
  return p;
}

/* ========== Data fetchers ========== */
async function getFile(uid, id){
  const snap = await getDoc(doc(COL_FILES(uid), id));
  return snap.exists()? { id:snap.id, ...snap.data() } : null;
}
async function getFolder(uid, id){
  if (id === "root") {
    const s = await getDoc(doc(COL_FOLDERS(uid), "root"));
    return s.exists()? { id:"root", ...s.data() } : { id:"root", name:"Tất cả tài liệu", parentId:null };
  }
  const s = await getDoc(doc(COL_FOLDERS(uid), id));
  return s.exists()? { id:s.id, ...s.data() } : null;
}
async function listSiblings(uid, parentId){
  const qy = query(COL_FILES(uid), where("parentId","==",parentId));
  const ds = await getDocs(qy);
  return ds.docs.map(d=>({id:d.id, ...d.data()}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||"","vi"));
}

/* ========== Render ========== */
async function renderViewer(user){
  const mount = $("#viewer"); const noPrev = $("#no-preview");
  mount.innerHTML = ""; noPrev.hidden = true;

  if (!user) { $("#file-title").textContent = "Vui lòng đăng nhập để xem tệp"; return; }
  if (!fileId) { $("#file-title").textContent = "Thiếu tham số file"; return; }

  // Lấy record file
  const rec = await getFile(user.uid, fileId);
  if (!rec) { $("#file-title").textContent = "Không tìm thấy tệp"; return; }

  // Folder & back link
  const parentId = rec.parentId || "root";
  if (!folderHint) folderHint = parentId;
  const back = $("#btn-back");
  if (back) back.href = `./materials.html?folder=${encodeURIComponent(folderHint)}`;

  // Header & meta
  $("#file-title").textContent = rec.name || "Tệp";
  $("#file-mime").textContent  = rec.mime || "—";
  $("#file-size").textContent  = fmtSize(rec.size) || "—";
  const folder = await getFolder(user.uid, parentId);
  $("#folder-name").textContent = folder?.name || "—";

  // Siblings
  const siblings = await listSiblings(user.uid, parentId);
  const sibList = $("#sibling-list");
  sibList.innerHTML = "";
  let activeIndex = siblings.findIndex(s => s.id === rec.id);
  for (const s of siblings){
    const a = document.createElement("a");
    a.href = `./viewer.html?file=${encodeURIComponent(s.id)}&folder=${encodeURIComponent(parentId)}`;
    a.className = "sibling";
    a.innerHTML = `
      <span class="i">${iconFor(s.name)}</span>
      <span class="t" title="${s.name}">${s.name}</span>
      <span class="badge">${badgeFor(s.mime, s.name)}</span>
    `;
    if (s.id === rec.id) a.classList.add("active");
    sibList.appendChild(a);
  }

  // Prev/Next
  function go(delta){
    if (!siblings.length) return;
    activeIndex = siblings.findIndex(s => s.id === rec.id);
    let to = activeIndex + delta;
    if (to < 0) to = siblings.length - 1;
    if (to >= siblings.length) to = 0;
    const target = siblings[to];
    location.href = `./viewer.html?file=${encodeURIComponent(target.id)}&folder=${encodeURIComponent(parentId)}`;
  }
  $("#btn-prev")?.addEventListener("click", ()=>go(-1));
  $("#btn-next")?.addEventListener("click", ()=>go(1));
  window.addEventListener("keydown",(e)=>{
    if (e.key === "ArrowLeft" || e.key.toLowerCase() === "k") go(-1);
    if (e.key === "ArrowRight"|| e.key.toLowerCase() === "j") go(1);
  });

  // Download
  $("#btn-download")?.addEventListener("click", ()=>{
    const a=document.createElement("a");
    a.href = rec.cloudinaryUrl; a.download = rec.name || "download";
    document.body.appendChild(a); a.click(); a.remove();
  });

  /* ====== Preview (không dùng Google Docs Viewer) ====== */
  const url  = rec.cloudinaryUrl;
  const name = (rec.name || "").toLowerCase();
  const mime = (rec.mime || "").toLowerCase();

  function mountEl(el){ mount.innerHTML=""; mount.appendChild(el); }

  // Ảnh
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(name) || mime.startsWith("image/")){
    const img = new Image();
    img.decoding = "async"; img.loading = "eager"; img.referrerPolicy = "no-referrer";
    img.onerror = ()=> mountEl(openExternalLink(url));
    img.src = url;
    return mountEl(img);
  }

  // Video
  if (/\.(mp4|webm|mkv|mov)$/.test(name) || mime.startsWith("video/")){
    const v = document.createElement("video");
    v.controls = true; v.playsInline = true; v.preload = "metadata";
    v.onerror = ()=> mountEl(openExternalLink(url));
    v.src = url;
    return mountEl(v);
  }

  // Audio
  if (/\.(mp3|wav|ogg)$/.test(name) || mime.startsWith("audio/")){
    const a = document.createElement("audio");
    a.controls = true; a.onerror = ()=> mountEl(openExternalLink(url));
    a.src = url;
    mount.style.placeItems = "start";
    a.style.width = "100%"; a.style.height = "auto";
    return mountEl(a);
  }

  // PDF: nhúng trực tiếp bằng iframe; nếu lỗi, gợi ý mở tab
  if (name.endsWith(".pdf") || mime === "application/pdf"){
    const iframe = document.createElement("iframe");
    iframe.setAttribute("frameborder","0");
    // Một số trình duyệt không phát sinh 'error' cho iframe; kèm fallback nút mở tab
    iframe.src = url + "#toolbar=1&navpanes=0&scrollbar=1";
    mountEl(iframe);
    // Thêm link phụ dưới iframe để mở tab mới
    const helper = document.createElement("div");
    helper.style.textAlign="center"; helper.style.padding="8px";
    helper.innerHTML = `<a href="${url}" target="_blank" rel="noopener">Mở PDF trong tab mới</a>`;
    mount.appendChild(helper);
    return;
  }

  // Text (txt/md/csv/json/xml/html/css/js/ts): thử fetch; nếu CORS chặn thì “mở tab”
  if (/\.(txt|md|csv|json|xml|html|css|js|ts)$/.test(name) || isTextMime(mime)){
    try{
      const r = await fetch(url, { method: "GET", mode: "cors" });
      if (!r.ok) throw 0;
      const text = await r.text();
      const pre = document.createElement("pre");
      pre.style.width="100%"; pre.style.height="100%"; pre.style.overflow="auto";
      pre.textContent = text;
      return mountEl(pre);
    }catch{
      return mountEl(openExternalLink(url));
    }
  }

  // Office (docx/xlsx/pptx): dùng Microsoft Office Viewer (cho phép embed)
  if (/\.(docx?|xlsx?|pptx?)$/.test(name)){
    const office = document.createElement("iframe");
    office.setAttribute("frameborder","0");
    office.src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
    // Nếu vẫn lỗi, thêm link mở tab
    office.onerror = ()=> { mount.innerHTML=""; mount.appendChild(openExternalLink(url)); };
    return mountEl(office);
  }

  // Khác: gợi ý mở tab
  mountEl(openExternalLink(url));
}

/* ========== Bootstrap ========== */
onUserChanged(async (user)=>{
  setAuthUI(user);
  const back = $("#btn-back");
  if (back && folderHint) back.href = `./materials.html?folder=${encodeURIComponent(folderHint)}`;
  await renderViewer(user);
});
