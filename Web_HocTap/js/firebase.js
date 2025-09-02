// /js/firebase.js
// Firebase qua CDN ESM: Auth + Firestore (memory-only cache) + Storage
// (Analytics được TẮT khi dev để tránh lỗi "process is not defined")

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  initializeFirestore,
  memoryLocalCache, // chỉ dùng cache bộ nhớ (không IndexedDB)
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js";

// ⚠️ storageBucket phải là <project-id>.appspot.com
const firebaseConfig = {
  apiKey: "AIzaSyDDBRttn992TonAxcNF9aveuYKbv3bD-mI",
  authDomain: "web-hoctap-c8cf3.firebaseapp.com",
  projectId: "web-hoctap-c8cf3",
  storageBucket: "web-hoctap-c8cf3.appspot.com",
  messagingSenderId: "90923990002",
  appId: "1:90923990002:web:17befb29195091dd3fc96b",
  measurementId: "G-HZCYSLX4QZ",
};

// --- Init core services ---
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Firestore: KHÔNG lưu cục bộ → memoryLocalCache()
export const db = initializeFirestore(app, { localCache: memoryLocalCache() });

// Storage: upload thumbnail, getDownloadURL, ...
export const storage = getStorage(app, { bucket: firebaseConfig.storageBucket });

// Duy trì phiên đăng nhập (localStorage cho Auth)
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("Auth persistence:", err?.code || err);
});

/* ===== Analytics: tắt khi dev để tránh 'process is not defined' =====
   Muốn bật lại chỉ khi deploy HTTPS:
   - Đổi ENABLE_ANALYTICS thành true
   - Site chạy trên HTTPS (không bật ở localhost/127.0.0.1)
*/
const ENABLE_ANALYTICS = false; // <- bật true khi deploy HTTPS

(async function initAnalytics() {
  if (!ENABLE_ANALYTICS) return;
  try {
    const isHttps = location.protocol === "https:";
    if (!isHttps || !firebaseConfig.measurementId) return;

    // Dynamic import để không gây lỗi trong môi trường dev
    const { getAnalytics, isSupported } =
      await import("https://www.gstatic.com/firebasejs/10.12.4/firebase-analytics.js");

    if (await isSupported()) getAnalytics(app);
  } catch (e) {
    console.warn("[Analytics disabled]", e?.message || e);
  }
})();

/* ===== Auth helpers ===== */
export const onUserChanged = (cb) => onAuthStateChanged(auth, cb);

export const loginWithEmail = (email, password) =>
  signInWithEmailAndPassword(auth, email, password).then((r) => r.user);

export const signupWithEmail = (email, password) =>
  createUserWithEmailAndPassword(auth, email, password).then((r) => r.user);

export const logout = () => signOut(auth);
