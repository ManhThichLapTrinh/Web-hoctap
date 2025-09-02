// /materials-web/materials.js — Cloud only (no local save) + điều hướng mượt, không “reload” cây
import { auth, db, onUserChanged, loginWithEmail, signupWithEmail, logout } from "../js/firebase.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

(function () {
  const $ = (s) => document.querySelector(s);

  /* ====== Cloudinary (unsigned) ====== */
  const CLOUD_NAME    = "dwdt9qb0e";
  const UPLOAD_PRESET = "Web_hoctap";
  const CLOUD_FOLDER  = "materials";
  const cloudinaryConfigured = () =>
    CLOUD_NAME && UPLOAD_PRESET && !/YOUR_/.test(CLOUD_NAME + UPLOAD_PRESET);

  async function uploadToCloudinary(file, uid, parentId) {
    if (!cloudinaryConfigured()) throw new Error("Cloudinary chưa cấu hình.");
    const form = new FormData();
    form.append("upload_preset", UPLOAD_PRESET);
    form.append("file", file);
    form.append("folder", `${CLOUD_FOLDER}/${uid}/${parentId || "root"}`);
    const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`;
    const res = await fetch(url, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || "Upload thất bại");
    return { url: data.secure_url, publicId: data.public_id, bytes: data.bytes, format: data.format, resource_type: data.resource_type };
  }

  /* ====== Theme & search ====== */
  (function restoreTheme() {
    const saved = localStorage.getItem("theme") || "dark";
    document.documentElement.classList.toggle("light", saved === "light");
  })();
  $("#toggle-theme")?.addEventListener("click", () => {
    const toLight = !document.documentElement.classList.contains("light");
    document.documentElement.classList.toggle("light", toLight);
    localStorage.setItem("theme", toLight ? "light" : "dark");
  });
  $("#mat-clear-search")?.addEventListener("click", () => {
    const s = $("#mat-search"); if (s) s.value = ""; applySearch();
  });
  $("#mat-search")?.addEventListener("input", applySearch);

  /* ====== Auth dialogs ====== */
  const elsAuth = {
    loginBtn: $("#btn-login"),
    loginDialog: $("#login-dialog"),
    signupDialog: $("#signup-dialog"),
    loginForm: $("#login-form"),
    loginEmail: $("#login-email"),
    loginPassword: $("#login-password"),
    loginError: $("#login-error"),
    loginToSignup: $("#login-to-signup"),
    signupForm: $("#signup-form"),
    signupEmail: $("#signup-email"),
    signupPassword: $("#signup-password"),
    signupPassword2: $("#signup-password2"),
    signupError: $("#signup-error"),
    signupToLogin: $("#signup-to-login"),
  };
  const openDlg = (dlg)=> dlg?.showModal?.() ?? (dlg?.setAttribute("open",""), dlg&&(dlg.style.display="block"));
  const closeDlg = (dlg)=> { try{ dlg?.close?.() ?? (dlg?.removeAttribute("open"), dlg&&(dlg.style.display="none")); }catch{} };

  // ✅ Sửa để giống trang chủ: chỉ "Đăng nhập"/"Đăng xuất", không kèm email
  const setAuthUI = (user)=>{
    if (!elsAuth.loginBtn) return;
    elsAuth.loginBtn.textContent = user ? "Đăng xuất" : "Đăng nhập";
    elsAuth.loginBtn.dataset.state = user ? "in" : "out";
  };

  // ✅ Click nút: đăng xuất (nếu đang đăng nhập) hoặc mở dialog đăng nhập
  elsAuth.loginBtn?.addEventListener("click", async ()=>{
    if (auth.currentUser) {
      await logout();
      // đóng các dialog nếu đang mở
      try { closeDlg(elsAuth.loginDialog); } catch {}
      try { closeDlg(elsAuth.signupDialog); } catch {}
    } else {
      elsAuth.loginError.hidden = true;
      elsAuth.loginError.textContent = "";
      openDlg(elsAuth.loginDialog);
    }
  });

  elsAuth.loginToSignup?.addEventListener("click",(e)=>{ e.preventDefault(); closeDlg(elsAuth.loginDialog); openDlg(elsAuth.signupDialog); });
  elsAuth.signupToLogin?.addEventListener("click",(e)=>{ e.preventDefault(); closeDlg(elsAuth.signupDialog); openDlg(elsAuth.loginDialog); });
  elsAuth.loginForm?.addEventListener("submit", async (e)=>{
    if (e.submitter?.value === "cancel") return; e.preventDefault();
    try { await loginWithEmail(elsAuth.loginEmail.value.trim(), elsAuth.loginPassword.value); closeDlg(elsAuth.loginDialog); }
    catch(err){ elsAuth.loginError.textContent = err?.message || "Không đăng nhập được."; elsAuth.loginError.hidden=false; console.error(err); }
  });
  elsAuth.signupForm?.addEventListener("submit", async (e)=>{
    if (e.submitter?.value === "cancel") return; e.preventDefault();
    if (elsAuth.signupPassword.value !== elsAuth.signupPassword2.value){
      elsAuth.signupError.textContent = "Mật khẩu nhập lại không khớp."; elsAuth.signupError.hidden=false; return;
    }
    try { await signupWithEmail(elsAuth.signupEmail.value.trim(), elsAuth.signupPassword.value); closeDlg(elsAuth.signupDialog); }
    catch(err){ elsAuth.signupError.textContent = err?.message || "Không tạo được tài khoản."; elsAuth.signupError.hidden=false; console.error(err); }
  });

  /* ====== DOM ====== */
  const nodes = {
    tree: $("#mat-tree"),
    crumbs: $("#mat-breadcrumbs"),
    grid: $("#mat-grid"),
    empty: $("#mat-empty"),
    dropzone: $("#mat-dropzone"),
    fileInput: $("#mat-file-input"),
    btnNewFolder: $("#mat-new-folder"),
    tplFolder: $("#mat-tpl-folder"),
    tplFile: $("#mat-tpl-file"),
    dlg: $("#mat-preview-dialog"),
    dlgTitle: $("#mat-preview-title"),
    dlgArea: $("#mat-preview-area"),
    dlgClose: $("#mat-preview-close"),
  };

  /* ====== Firestore paths ====== */
  const COL_FOLDERS = (uid) => collection(db, "users", uid, "materials_folders");
  const COL_FILES   = (uid) => collection(db, "users", uid, "materials_files");

  /* ====== State & helpers ====== */
  let current = "root";
  let folderCache = []; // [{id,name,parentId,...}]
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

  const requireLogin = () => {
    if (!auth.currentUser) {
      alert("Vui lòng đăng nhập để thao tác.");
      return false;
    }
    return true;
  };

  async function ensureRootCloud(uid){
    const ref = doc(COL_FOLDERS(uid), "root");
    const snap = await getDoc(ref);
    if (!snap.exists()){
      await setDoc(ref, { name:"Tất cả tài liệu", parentId:null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
  }

  /* ====== Folder cache (giảm query, dựng cây nhanh) ====== */
  async function rebuildFolderCache(){
    if (!requireLogin()) return;
    await ensureRootCloud(auth.currentUser.uid);
    const docs = await getDocs(COL_FOLDERS(auth.currentUser.uid));
    folderCache = docs.docs.map(d => ({ id: d.id, ...d.data() }));
    // đảm bảo có root (nếu cache ngay sau tạo)
    if (!folderCache.find(f => f.id === "root")) {
      folderCache.push({ id:"root", name:"Tất cả tài liệu", parentId:null });
    }
  }
  const getFolderCached = (id) => id==="root"
    ? (folderCache.find(f=>f.id==="root") || {id:"root", name:"Tất cả tài liệu", parentId:null})
    : folderCache.find(f=>f.id===id) || null;
  const listFoldersCached = (parentId) => folderCache.filter(f => f.parentId === parentId)
                                                    .sort((a,b)=>(a.name||"").localeCompare(b.name||"","vi"));
  function hasDescendantCached(folderId, targetId){
    if(folderId===targetId) return true;
    const stack = [...listFoldersCached(folderId)];
    while (stack.length){
      const x = stack.pop();
      if (x.id === targetId) return true;
      stack.push(...listFoldersCached(x.id));
    }
    return false;
  }

  /* ====== CRUD: Folder (cloud only) ====== */
  async function createFolder(name, parentId=current){
    if (!requireLogin()) return;
    name = (name||"").trim(); if(!name) return;
    await ensureRootCloud(auth.currentUser.uid);
    await addDoc(COL_FOLDERS(auth.currentUser.uid), { name, parentId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await refreshAll(); // cây & lưới
  }
  async function renameFolder(id, newName){
    if (!requireLogin()) return;
    await updateDoc(doc(COL_FOLDERS(auth.currentUser.uid), id), { name:(newName||"").trim(), updatedAt: serverTimestamp() });
    await refreshAll();
  }
  async function deleteFolder(id){
    if (!requireLogin()) return;
    if(!confirm("Xoá thư mục này và toàn bộ nội dung?")) return;
    // xóa đệ quy dựa trên cache để giảm call
    await rebuildFolderCache();
    async function _del(fid){
      for (const ch of listFoldersCached(fid)) await _del(ch.id);
      for (const fl of await listFiles(fid)) await deleteFile(fl.id);
      if (fid !== "root") await deleteDoc(doc(COL_FOLDERS(auth.currentUser.uid), fid));
    }
    await _del(id);
    if(current===id) current="root";
    await refreshAll();
  }

  /* ====== CRUD: File (cloud only) ====== */
  async function addFiles(fileList, parentId=current){
    if (!requireLogin()) return;
    if (!cloudinaryConfigured()){
      alert("Cloudinary chưa cấu hình (CLOUD_NAME, UPLOAD_PRESET). Không thể upload.");
      return;
    }
    await ensureRootCloud(auth.currentUser.uid);
    for (const f of fileList){
      const up = await uploadToCloudinary(f, auth.currentUser.uid, parentId);
      await addDoc(COL_FILES(auth.currentUser.uid), {
        name: f.name, parentId,
        size: up.bytes ?? f.size, mime: f.type || `application/${up.format||'octet-stream'}`,
        cloudinaryUrl: up.url, publicId: up.publicId,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }
    await refreshGridOnly(); // chỉ lưới
  }
  async function renameFile(id, newName){
    if (!requireLogin()) return;
    await updateDoc(doc(COL_FILES(auth.currentUser.uid), id), { name:(newName||"").trim(), updatedAt: serverTimestamp() });
    await refreshGridOnly();
  }
  async function deleteFile(id){
    if (!requireLogin()) return;
    // Chỉ xoá metadata trên Firestore (xoá Cloudinary cần server-side)
    await deleteDoc(doc(COL_FILES(auth.currentUser.uid), id));
    await refreshGridOnly();
  }

  /* ====== Queries (cloud only) ====== */
  async function listFiles(parentId){
    if (!requireLogin()) return [];
    const qy = query(COL_FILES(auth.currentUser.uid), where("parentId","==",parentId));
    const out = (await getDocs(qy)).docs.map(d=>({id:d.id, ...d.data()}));
    return out.sort((a,b)=>(a.name||"").localeCompare(b.name||"","vi"));
  }
  async function getFolder(id){
    // ưu tiên cache
    const c = getFolderCached(id);
    if (c) return c;
    if (!requireLogin()) return null;
    if (id==="root"){
      const s = await getDoc(doc(COL_FOLDERS(auth.currentUser.uid), "root"));
      return s.exists()? { id:"root", ...s.data() } : { id:"root", name:"Tất cả tài liệu", parentId:null };
    }
    const s = await getDoc(doc(COL_FOLDERS(auth.currentUser.uid), id));
    return s.exists()? { id:s.id, ...s.data() } : null;
  }

  /* ====== Move (cloud only) ====== */
  async function moveFolder(id, parent){
    if (!requireLogin()) return;
    if(id===parent) return;
    await rebuildFolderCache();
    if(hasDescendantCached(id, parent)){ alert("Không thể di chuyển vào chính nó."); return; }
    await updateDoc(doc(COL_FOLDERS(auth.currentUser.uid), id), { parentId: parent, updatedAt: serverTimestamp() });
    await refreshAll();
  }
  async function moveFile(id, parent){
    if (!requireLogin()) return;
    await updateDoc(doc(COL_FILES(auth.currentUser.uid), id), { parentId: parent, updatedAt: serverTimestamp() });
    await refreshGridOnly();
  }

  /* ====== Render ====== */
  async function renderTree(){
    nodes.tree.innerHTML = "";
    // dựng dựa trên cache để hạn chế query lồng nhau
    const root = getFolderCached("root");
    async function buildNode(folder){
      const det=document.createElement("details");
      det.dataset.id = folder.id;
      det.open = hasDescendantCached(folder.id, current);

      const sum=document.createElement("summary");
      sum.textContent=folder.name;
      sum.addEventListener("click", (e) => {
        e.preventDefault();

        // Toggle mở/đóng details của thư mục trên CÂY
        const willOpen = !det.open;
        det.open = willOpen;

        if (willOpen) {
          // MỞ: điều hướng vào chính thư mục này (không rebuild cây)
          navigate(folder.id, { push: true, partial: true });
        } else {
          // ĐÓNG: thu gọn toàn bộ nhánh con trên CÂY
          det.querySelectorAll("details[open]").forEach(d => d.open = false);

          // ✅ YÊU CẦU: khi đóng thư mục cha, GRID vẫn hiển thị nội dung của CHA
          current = folder.id;

          // cập nhật URL nhưng KHÔNG mở lại nhánh trong cây
          const u = new URL(location.href);
          u.searchParams.set("folder", current);
          history.pushState({ current }, "", u.toString());

          // render lại CHỈ grid + breadcrumbs, KHÔNG mở lại nhánh ở sidebar
          refreshGridOnly({ skipOpenBranch: true });
        }
      });

      // DnD vào summary
      sum.addEventListener("dragover",(e)=>{ e.preventDefault(); sum.classList.add("drop-target"); });
      sum.addEventListener("dragleave",()=>sum.classList.remove("drop-target"));
      sum.addEventListener("drop", async (e)=>{
        e.preventDefault(); sum.classList.remove("drop-target");
        if (!requireLogin()) return;
        if (e.dataTransfer?.files?.length){ await addFiles(e.dataTransfer.files, folder.id); return; }
        const data=e.dataTransfer.getData("text/plain"); if(!data) return;
        const {kind,id}=JSON.parse(data);
        if(kind==="folder"){ await rebuildFolderCache(); if(hasDescendantCached(id, folder.id)){ alert("Không thể di chuyển vào chính nó."); return; } await moveFolder(id, folder.id); }
        else if(kind==="file"){ await moveFile(id, folder.id); }
      });

      det.appendChild(sum);
      for(const ch of listFoldersCached(folder.id)){ det.appendChild(await buildNode(ch)); }
      return det;
    }
    nodes.tree.appendChild(await buildNode(root));
  }

  async function renderGrid(){
    nodes.grid.innerHTML="";
    const folders = listFoldersCached(current);
    const files   = await listFiles(current);
    nodes.empty.hidden = folders.length + files.length > 0;

    for (const f of folders){
      const node = nodes.tplFolder.content.firstElementChild.cloneNode(true);
      node.dataset.id=f.id;
      node.querySelector("[data-name]").textContent=f.name;
      node.querySelector("[data-meta]").textContent="Thư mục";
      node.querySelector("[data-open]").addEventListener("click", ()=>navigate(f.id, {push:true, partial:true}));
      node.querySelector("[data-rename]").addEventListener("click", async()=>{ const nv=prompt("Tên mới:", f.name); if(nv?.trim()) await renameFolder(f.id, nv); });
      node.querySelector("[data-delete]").addEventListener("click", ()=>deleteFolder(f.id));
      node.addEventListener("click", ()=>{ document.querySelectorAll("#mat-grid .card.selected").forEach(el=>el.classList.remove("selected")); node.classList.add("selected"); });
      attachDrag(node,"folder",f.id);
      nodes.grid.appendChild(node);
    }

    for (const f of files){
      const node = nodes.tplFile.content.firstElementChild.cloneNode(true);
      node.dataset.id=f.id;
      node.querySelector("[data-name]").textContent=f.name;
      node.querySelector("[data-meta]").textContent=`${f.mime||""} • ${fmtSize(f.size)}`;
      node.querySelector("[data-fileicon]").textContent=iconFor(f.name);

      // Xem → sang viewer.html
      node.querySelector("[data-preview]").addEventListener("click", ()=>{
        location.href = `./viewer.html?file=${encodeURIComponent(f.id)}&folder=${encodeURIComponent(current)}`;
      });

      node.querySelector("[data-download]").addEventListener("click", ()=>download(f));
      node.querySelector("[data-rename]").addEventListener("click", async()=>{ const nv=prompt("Tên mới:", f.name); if(nv?.trim()) await renameFile(f.id, nv); });
      node.querySelector("[data-delete]").addEventListener("click", ()=>deleteFile(f.id));
      node.addEventListener("click", ()=>{ document.querySelectorAll("#mat-grid .card.selected").forEach(el=>el.classList.remove("selected")); node.classList.add("selected"); });
      attachDrag(node,"file",f.id);
      nodes.grid.appendChild(node);
    }
  }

  function crumbEl(name, id){
    const s=document.createElement("span"); s.className="crumb";
    if(id){ const a=document.createElement("a"); a.href="#"; a.textContent=name; a.addEventListener("click",(e)=>{ e.preventDefault(); navigate(id, {push:true, partial:true}); }); s.appendChild(a); }
    else { s.textContent=name; }
    return s;
  }
  async function renderCrumbs(){
    nodes.crumbs.innerHTML="";
    const path=[]; let cur=current;
    while(cur){ const f=getFolderCached(cur) || await getFolder(cur); if(!f) break; path.push(f); cur=f.parentId; }
    path.reverse();
    nodes.crumbs.appendChild(crumbEl("Root","root"));
    for(let i=1;i<path.length;i++){ const last=i===path.length-1; nodes.crumbs.appendChild(last?crumbEl(path[i].name,null):crumbEl(path[i].name,path[i].id)); }
  }

  /* ====== Refresh tách nhỏ ====== */
  async function refreshAll(){
    if (!auth.currentUser){
      // khoá UI nếu chưa đăng nhập
      nodes.tree.innerHTML = "";
      nodes.grid.innerHTML = "";
      nodes.crumbs.innerHTML = `<span class="crumb">Vui lòng đăng nhập</span>`;
      nodes.empty.hidden = false;
      return;
    }
    await rebuildFolderCache();        // ⟵ chỉ query 1 lần cho toàn bộ cây
    await renderTree();                // dựng lại cây từ cache
    await renderGrid();                // dựng lưới
    await renderCrumbs();              // breadcrumbs
    applySearch();
  }
  async function refreshGridOnly(opts = {}) {
    if (!auth.currentUser) return;
    await renderGrid();       // grid hiển thị theo "current"
    await renderCrumbs();
    applySearch();
    if (!opts.skipOpenBranch) {
      openBranchInTree(current); // mặc định mở nhánh; khi đóng cha thì skip
    }
  }

  function openBranchInTree(folderId){
    // mở các details theo nhánh hiện tại; không rebuild
    const idPath = [];
    let cur = folderId;
    while(cur){ const f = getFolderCached(cur); if(!f) break; idPath.push(f.id); cur = f.parentId; }
    idPath.forEach(id => { const det = nodes.tree.querySelector(`details[data-id="${id}"]`); if (det) det.open = true; });
  }

  /* ====== Điều hướng (không reload cây) ====== */
  async function navigate(id, {push=false, partial=false} = {}){
    if (!requireLogin()) return;
    current = id || "root";
    if (push) {
      const u = new URL(location.href);
      u.searchParams.set("folder", current);
      history.pushState({ current }, "", u.toString());
    }
    if (partial) await refreshGridOnly();
    else await refreshAll();
  }
  window.addEventListener("popstate", async (e)=>{
    if (!auth.currentUser) return;
    const state = e.state;
    if (state?.current) current = state.current;
    else {
      const u = new URL(location.href);
      current = u.searchParams.get("folder") || "root";
    }
    await refreshGridOnly();
  });

  /* ====== DnD ====== */
  function attachDrag(card, kind, id){
    card.setAttribute("draggable","true");
    card.addEventListener("dragstart",(e)=> e.dataTransfer.setData("text/plain", JSON.stringify({ kind, id })));
  }
  ["dragenter","dragover"].forEach(evt=>{
    nodes.dropzone.addEventListener(evt,(e)=>{ e.preventDefault(); nodes.dropzone.classList.add("dragover"); });
  });
  ["dragleave","drop"].forEach(evt=>{
    nodes.dropzone.addEventListener(evt,()=> nodes.dropzone.classList.remove("dragover"));
  });
  nodes.dropzone.addEventListener("drop", async (e)=>{
    e.preventDefault();
    if (!requireLogin()) return;
    if(e.dataTransfer?.files?.length){ await addFiles(e.dataTransfer.files, current); return; }
    const data=e.dataTransfer.getData("text/plain"); if(!data) return;
    const {kind,id}=JSON.parse(data);
    if(kind==="folder") await moveFolder(id,current); else if(kind==="file") await moveFile(id,current);
  });

  /* ====== Preview & Download (cloud only) ====== */
  const isExt = (re, name)=> re.test((name||"").toLowerCase());

  // === Helpers cho PDF (Cloudinary) ===
  function toRawUpload(url) {
    // Ép /image|video/upload/ -> /raw/upload/ (đúng loại cho PDF)
    try {
      const u = new URL(url);
      u.pathname = u.pathname
        .replace('/image/upload/', '/raw/upload/')
        .replace('/video/upload/', '/raw/upload/');
      return u.toString();
    } catch { return url; }
  }
  function ensurePdfExt(url) {
    // Bảo đảm URL có đuôi .pdf để Content-Type trả về là application/pdf
    try {
      const u = new URL(url);
      if (!/\.pdf$/i.test(u.pathname)) u.pathname += '.pdf';
      return u.toString();
    } catch { return /\.pdf$/i.test(url) ? url : url + '.pdf'; }
  }
  async function headIsPdfOk(url){
    // HEAD để chắc chắn server trả về PDF công khai (không bị ACL)
    try {
      const r = await fetch(url, { method:'HEAD' });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const xerr = r.headers.get('x-cld-error') || '';
      return r.ok && ct.includes('application/pdf') && !/deny|acl/i.test(xerr);
    } catch { return false; }
  }
  function isPdfRecord(rec){
    return /\.pdf$/i.test(rec?.name||'')
        || /application\/pdf/i.test(rec?.mime||'')
        || /\.pdf(\?|#|$)/i.test(rec?.cloudinaryUrl||'');
  }

  async function renderPreviewSide(folderId, activeFileId){
    const side = nodes.dlg.querySelector(".preview-side"); if(!side) return;
    side.innerHTML="";
    const info=getFolderCached(folderId) || await getFolder(folderId);
    const head=document.createElement("div"); head.className="side-head"; head.innerHTML=`<strong>${info?.name||"Thư mục"}</strong>`; side.appendChild(head);
    const list=document.createElement("div"); list.className="side-list"; side.appendChild(list);

    for(const f of listFoldersCached(folderId)){
      const btn=document.createElement("button"); btn.className="side-item"; btn.innerHTML=`<span class="i">📁</span><span class="t">${f.name}</span>`;
      btn.addEventListener("click", ()=>renderPreviewSide(f.id, activeFileId)); list.appendChild(btn);
    }
    for(const fl of await listFiles(folderId)){
      const btn=document.createElement("button"); btn.className="side-item"+(fl.id===activeFileId?" active":""); btn.innerHTML=`<span class="i">${iconFor(fl.name)}</span><span class="t">${fl.name}</span>`;
      btn.addEventListener("click", ()=>preview(fl)); list.appendChild(btn);
      if(fl.id===activeFileId) requestAnimationFrame(()=>btn.scrollIntoView({block:"nearest"}));
    }
  }

  async function preview(rec){
    if (!requireLogin()) return;
    nodes.dlgArea.innerHTML=""; nodes.dlgTitle.textContent=rec.name;
    const split=document.createElement("div"); split.className="preview-split"; split.style.gridTemplateColumns="minmax(0,1fr) 260px";
    const left=document.createElement("div"); left.className="preview-left preview-area"; left.style.padding="0";
    const right=document.createElement("aside"); right.className="preview-side";
    split.appendChild(left); split.appendChild(right); nodes.dlgArea.appendChild(split);

    const playerBody = nodes.dlgArea.parentElement; if(playerBody){ playerBody.style.padding="0"; playerBody.style.overflow="hidden"; }

    const url = rec.cloudinaryUrl; // cloud only
    let el;

    if (isExt(/\.(png|jpe?g|gif|webp|svg)$/, rec.name)){
      el=new Image(); el.src=url; el.style.display="block"; el.style.maxWidth="100%"; el.style.maxHeight="100%"; el.style.objectFit="contain";
      left.appendChild(el);
    }
    else if (isExt(/\.(mp4|webm|mkv|mov)$/, rec.name)){
      el=document.createElement("video"); el.controls=true; el.src=url; el.style.width="100%"; el.style.height="100%";
      left.appendChild(el);
    }
    else if (isExt(/\.(mp3|wav|ogg)$/, rec.name)){
      el=document.createElement("audio"); el.controls=true; el.src=url; el.style.width="100%";
      left.appendChild(el);
    }
    // === PDF (vá) ===
    else if (isPdfRecord(rec)) {
      let pdfUrl = ensurePdfExt(toRawUpload(url));
      const ok = await headIsPdfOk(pdfUrl);

      if (!ok) {
        const wrap = (html) => { const d=document.createElement('div'); d.style.textAlign='center'; d.style.padding='16px'; d.innerHTML=html; return d; };
        left.appendChild(wrap(
          'Không xem được PDF trong trang.<br/>'
          + 'Nguyên nhân thường là file đang ở chế độ <b>Authenticated/Private</b> hoặc không trả về '
          + '<code>Content-Type: application/pdf</code>.<br/>'
          + 'Hãy <b>re-upload bằng preset Public</b> hoặc chuyển asset sang Public bằng Admin API.'
        ));
        left.appendChild(wrap(`<a href="${pdfUrl}" target="_blank" rel="noopener">Mở PDF trong tab mới</a>`));
      } else {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('frameborder','0');
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.src = pdfUrl;
        left.appendChild(iframe);

        const helper = document.createElement('div');
        helper.style.textAlign='center'; helper.style.padding='8px';
        helper.innerHTML = `<a href="${pdfUrl}" target="_blank" rel="noopener">Mở PDF trong tab mới</a>`;
        left.appendChild(helper);
      }
    }
    else {
      el=document.createElement("p"); el.textContent="Không có preview. Hãy tải xuống.";
      left.appendChild(el);
    }

    nodes.dlg.classList.add("dialog--dock"); openDlg(nodes.dlg);
    await renderPreviewSide(rec.parentId || current, rec.id);

    nodes.dlg.addEventListener("close", ()=>{ nodes.dlg.classList.remove("dialog--dock"); if(playerBody){ playerBody.style.padding=""; playerBody.style.overflow=""; } }, { once:true });
  }

  async function download(rec){
    if (!requireLogin()) return;
    const a=document.createElement("a"); a.href = rec.cloudinaryUrl; a.download = rec.name || "download"; document.body.appendChild(a); a.click(); a.remove();
  }
  nodes.dlgClose?.addEventListener("click", ()=>closeDlg(nodes.dlg));

  /* ====== UI actions ====== */
  nodes.btnNewFolder?.addEventListener("click", async ()=>{ const name=prompt("Tên thư mục mới:"); if(name?.trim()) await createFolder(name.trim()); });
  nodes.fileInput?.addEventListener("change", async (e)=>{ const fs=e.target.files; if(fs?.length) await addFiles(fs, current); e.target.value=""; });

  /* ====== Search ====== */
  function applySearch(){
    const q = ($("#mat-search")?.value || "").trim().toLowerCase();
    if (!q){ document.querySelectorAll("#mat-grid .card").forEach(c=>c.hidden=false); nodes.empty.hidden = document.querySelectorAll("#mat-grid .card:not([hidden])").length>0; return; }
    let count=0; document.querySelectorAll("#mat-grid .card").forEach(c=>{
      const name=c.querySelector("[data-name]")?.textContent.toLowerCase() || ""; const show=name.includes(q); c.hidden=!show; if(show) count++;
    }); nodes.empty.hidden = count>0;
  }

  /* ====== Bootstrap ====== */
  function readFolderFromURL(){
    const u = new URL(location.href);
    return u.searchParams.get("folder") || "root";
  }
  onUserChanged(async (user)=>{
    setAuthUI(user);
    current = "root"; // reset khi đổi user
    if (user) {
      // nếu URL có folder thì ưu tiên
      const f = readFolderFromURL();
      current = f || "root";
      await refreshAll();
      // đồng bộ mở nhánh trong cây
      openBranchInTree(current);
      // đẩy state khởi tạo
      const u = new URL(location.href);
      u.searchParams.set("folder", current);
      history.replaceState({ current }, "", u.toString());
    } else {
      await refreshAll();
    }
  });
})();
