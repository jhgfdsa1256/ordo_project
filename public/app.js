(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(2) + " MB" : (n / 1073741824).toFixed(2) + " GB";
// 서버(src/app.js)의 safeTitle과 똑같아야 합니다.
const safeTitle = t => { const s = String(t || "").trim().replace(/[\\/:*?"<>|#%&+\s]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 60); return s || "untitled"; };
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const S = { me: null, usage: null, maxFile: 20 * 1048576, site: "Ordo", view: "library", albums: [], album: null, images: [], cols: ls.get("ordo.cols", 2), quality: ls.get("ordo.q", "high"), pick: null, busy: null, sheet: null, reports: [] };
const app = $("#app");

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const o = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
  if (opts.json !== undefined) { o.headers["content-type"] = "application/json"; o.body = JSON.stringify(opts.json); }
  if (opts.form) o.body = opts.form;
  const r = await fetch(path, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `요청 실패 (${r.status})`); e.status = r.status; throw e; }
  return data;
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }
const fail = e => { if (e && e.status === 401) { S.me = null; render(); } toast(e?.message || "오류가 났습니다"); };

/* ---------- WebP 변환 ---------- */
let canvasWebp = null;
async function canvasCanEncodeWebp() {
  if (canvasWebp !== null) return canvasWebp;
  try { const c = document.createElement("canvas"); c.width = c.height = 2; canvasWebp = await new Promise(r => c.toBlob(b => r(!!b && b.type === "image/webp"), "image/webp", .9)); }
  catch { canvasWebp = false; }
  return canvasWebp;
}
// 아이폰 사파리처럼 브라우저가 WebP를 못 만드는 경우 쓰는 변환기 (jSquash, 처음 한 번만 받음)
let wasmEnc = null;
async function wasmEncoder() {
  if (wasmEnc) return wasmEnc;
  const base = "https://cdn.jsdelivr.net/npm/@jsquash/webp@1.4.0";
  const mod = await import(base + "/encode.js/+esm");
  let wasm;
  try { wasm = await WebAssembly.compileStreaming(fetch(base + "/codec/enc/webp_enc_simd.wasm")); }
  catch { wasm = await WebAssembly.compileStreaming(fetch(base + "/codec/enc/webp_enc.wasm")); }
  await mod.init(wasm);
  wasmEnc = mod.default;
  return wasmEnc;
}
async function decode(file) {
  if ("createImageBitmap" in window) { try { return await createImageBitmap(file); } catch {} }
  return await new Promise((res, rej) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("이미지를 읽지 못했습니다")); im.src = u; });
}
async function toWebp(file, quality) {
  const lossless = quality === "lossless";
  const base = { origName: file.name, origSize: file.size };
  if (file.type === "image/webp") { const bm = await decode(file); return { blob: file, w: bm.width, h: bm.height, ...base }; }
  const bm = await decode(file);
  const w = bm.width || bm.naturalWidth, h = bm.height || bm.naturalHeight;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(bm, 0, 0);
  if (await canvasCanEncodeWebp()) {
    const blob = await new Promise(r => c.toBlob(r, "image/webp", lossless ? 1 : .9));
    if (blob && blob.type === "image/webp") return { blob, w, h, ...base };
  }
  try {
    const enc = await wasmEncoder();
    const buf = await enc(g.getImageData(0, 0, w, h), lossless ? { lossless: 1, quality: 100 } : { quality: 90 });
    return { blob: new Blob([buf], { type: "image/webp" }), w, h, ...base };
  } catch (e) {
    console.warn("WebP 변환 실패, 원본 형식으로 올립니다", e);
    return { blob: file, w, h, ...base, fallback: true };
  }
}

/* ---------- 공통 조각 ---------- */
const logo = () => `<a class="logo" href="/"><i><b></b><b></b><b></b><b></b></i>${esc(S.site)}</a>`;
const header = inner => `<header class="top"><div class="wrap">${inner}</div></header>`;
const fileName = i => `${safeTitle(S.album.title)}_${i + 1}.${S.images[i].ext}`;
const linkOf = i => `${location.origin}/${encodeURIComponent(safeTitle(S.album.title))}_${i + 1}.${S.images[i].ext}`;
async function copy(text, msg) { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast("복사가 막혔습니다. 링크를 길게 눌러 복사하세요"); } }
const gsvg = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

function render() {
  closeSheet();
  if (!S.me) return renderLogin();
  if (S.view === "album" && S.album) return renderAlbum();
  if (S.view === "admin" && S.me.isAdmin) return renderAdmin();
  S.view = "library"; renderLibrary();
}

/* ---------- 로그인 ---------- */
function renderLogin() {
  const e = new URLSearchParams(location.search).get("login_error");
  app.innerHTML = `<div class="wrap login"><div class="login-card">
    ${logo()}
    <h1>AI 이미지를 앨범 단위로 올리고, 순서대로 링크를 받으세요</h1>
    <p class="muted" style="margin:0">여러 장을 한 번에 올리면 WebP로 변환되고, 앨범 제목과 순서에 따라 <span class="mono">제목_1.webp</span>, <span class="mono">제목_2.webp</span> 링크가 만들어집니다.</p>
    <a class="gbtn" href="/api/auth/login" style="text-decoration:none">${gsvg}Google 계정으로 계속하기</a>
    ${e ? `<p class="err">${esc(e)}</p>` : ""}
  </div></div>`;
}

/* ---------- 보관함 ---------- */
async function loadLibrary() {
  try { const [me, al] = await Promise.all([api("/api/me"), api("/api/albums")]); S.usage = me.usage; S.albums = al.albums; } catch (e) { fail(e); }
}
function renderLibrary() {
  const used = S.usage?.used || 0, quota = S.usage?.quota || 1;
  app.innerHTML = header(`${logo()}<div class="spacer"></div>
      ${S.me.isAdmin ? `<button class="btn" id="adminBtn">신고 관리</button>` : ""}
      <button class="iconbtn" id="logout" aria-label="로그아웃" title="로그아웃">⎋</button>`) +
  `<main class="wrap stack">
    <div class="usage"><div class="row" style="justify-content:space-between"><h2>${esc(S.me.name)}님의 보관함</h2><span class="mono muted" style="font-size:12px">${fmt(used)} / ${fmt(quota)}</span></div>
      <div class="bar"><span style="width:${Math.min(100, used / quota * 100).toFixed(2)}%"></span></div></div>
    <div class="stack" style="gap:6px"><form class="newalbum" id="newForm"><input id="newTitle" placeholder="새 앨범 제목 (예: AA)" maxlength="60" autocomplete="off" aria-describedby="titleHint"><button class="btn primary" type="submit">앨범 만들기</button></form>
    <span class="hint" id="titleHint">제목은 사이트 전체에서 하나만 쓸 수 있습니다. 링크는 <span class="mono">${esc(location.host)}/제목_1.webp</span> 형식이 됩니다.</span></div>
    ${S.albums.length ? `<div class="albums">${S.albums.map(a => `
      <button class="album" data-id="${a.id}">
        <div class="cover">${(a.covers.length >= 4 ? a.covers : a.covers.slice(0, 1)).map(id => `<img alt="" src="/f/${id}" loading="lazy">`).join("")}</div>
        <div class="meta"><b>${esc(a.title)}</b><span class="muted">${a.count}장 · ${fmt(a.size)}${a.hidden ? " · 숨김 처리됨" : ""}</span></div>
      </button>`).join("")}</div>` : `<div class="empty">아직 앨범이 없습니다. 위에서 제목을 정하고 첫 앨범을 만드세요.</div>`}
  </main>`;
  $("#logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); S.me = null; render(); };
  const ab = $("#adminBtn"); if (ab) ab.onclick = () => openAdmin();
  $("#newForm").onsubmit = async e => {
    e.preventDefault(); const t = $("#newTitle").value.trim(); if (!t) { $("#newTitle").focus(); toast("앨범 제목을 입력하세요"); return; }
    try { const r = await api("/api/albums", { method: "POST", json: { title: t } }); await openAlbum(r.album.id); } catch (er) { fail(er); }
  };
  app.querySelectorAll(".album").forEach(b => b.onclick = () => openAlbum(b.dataset.id));
  watchTitle($("#newTitle"), $("#titleHint"));
}
// 제목을 입력하는 동안 쓸 수 있는지 미리 알려줍니다.
function watchTitle(input, hint, except = "") {
  const base = hint.innerHTML; let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer); const v = input.value.trim(); const my = ++seq;
    if (!v) { hint.innerHTML = base; hint.classList.remove("err"); return; }
    timer = setTimeout(async () => {
      try {
        const r = await api(`/api/title-check?title=${encodeURIComponent(v)}&except=${encodeURIComponent(except)}`);
        if (my !== seq) return;
        hint.classList.toggle("err", !r.available);
        hint.innerHTML = r.available
          ? `쓸 수 있는 제목입니다. 링크: <span class="mono">${esc(location.host)}/${esc(r.name)}_1.webp</span>`
          : `<span class="mono">${esc(r.name)}</span> 은(는) 이미 다른 앨범이 쓰고 있습니다. 다른 제목을 입력하세요.`;
      } catch {}
    }, 300);
  });
}

/* ---------- 앨범 ---------- */
async function openAlbum(id) {
  try { const r = await api("/api/albums/" + id); S.album = r.album; S.images = r.images; S.pick = null; S.view = "album"; render(); window.scrollTo(0, 0); }
  catch (e) { fail(e); }
}
async function backToLibrary() { S.view = "library"; S.album = null; S.pick = null; await loadLibrary(); render(); }

function renderAlbum() {
  const a = S.album, n = S.images.length;
  app.innerHTML = header(`<button class="iconbtn" id="back" aria-label="보관함으로">←</button>
      <div class="albumhead" style="flex:1"><input class="titleinput" id="titleIn" value="${esc(a.title)}" maxlength="60" aria-label="앨범 제목"></div>
      <a class="iconbtn" href="/a/${a.id}" target="_blank" rel="noopener" aria-label="공유 페이지 열기" title="공유 페이지" style="text-decoration:none">⤴</a>`) +
  `<main class="wrap stack">
    <div class="row" style="justify-content:space-between"><span class="mono muted" style="font-size:12px">앨범 ID ${a.id} · ${n}장${a.hidden ? " · 관리자가 숨김 처리함" : ""}</span>${S.busy ? `<span class="progress">${esc(S.busy)}</span>` : ""}</div>
    <div class="linkbox"><code>${esc(location.origin + "/a/" + a.id)}</code><button class="btn" id="copyShare">공유 링크</button></div>
    <div class="toolbar">
      <span class="lbl">열</span>
      <div class="seg" role="group" aria-label="열 개수">${[1, 2, 3, 4, 5].map(k => `<button data-cols="${k}" aria-pressed="${S.cols === k}">${k}</button>`).join("")}</div>
      <span class="lbl" style="margin-left:6px">화질</span>
      <select class="sel" id="quality"><option value="high"${S.quality === "high" ? " selected" : ""}>고화질 (90)</option><option value="lossless"${S.quality === "lossless" ? " selected" : ""}>무손실</option></select>
    </div>
    ${n ? `<p class="hint" style="margin:0">사진을 누르고, 옮기고 싶은 자리의 사진을 누르면 그 자리로 이동합니다. ⋯ 버튼은 링크 복사·저장·삭제.</p>
      <div class="grid" id="grid" data-cols="${S.cols}" style="--cols:${S.cols}">${S.images.map((it, i) => `
        <div class="card${S.pick === it.id ? " picked" : S.pick ? " target" : ""}" data-id="${it.id}" tabindex="0" role="button" aria-pressed="${S.pick === it.id}" aria-label="${i + 1}번 사진">
          <div class="ph"><img alt="" src="/f/${it.id}" loading="lazy"></div>
          <span class="num">${i + 1}</span>
          <button class="more" data-more="${it.id}" aria-label="${i + 1}번 사진 메뉴">⋯</button>
          <div class="fn">${esc(fileName(i))}</div>
        </div>`).join("")}</div>`
      : `<div class="empty">이 앨범은 비어 있습니다.<br>아래 <b>사진 추가</b>로 여러 장을 한 번에 올리세요.</div>`}
    <button class="btn danger" id="delAlbum" style="justify-self:start;margin-top:24px">앨범 삭제</button>
  </main>
  ${S.pick ? `<div class="pickbar"><div class="wrap"><b>${S.images.findIndex(x => x.id === S.pick) + 1}번 사진을 옮길 자리의 사진을 누르세요</b><button id="pickCancel">취소</button></div></div>` : ""}
  <div class="bottombar"${S.pick ? " hidden" : ""}><div class="wrap">
    <button class="btn primary" id="addBtn"${S.busy ? " disabled" : ""}>＋ 사진 추가</button>
    <button class="btn" id="zipBtn"${n && !S.busy ? "" : " disabled"}>전체 저장 (ZIP)</button>
  </div></div>`;

  $("#back").onclick = backToLibrary;
  $("#copyShare").onclick = () => copy(location.origin + "/a/" + a.id, "공유 링크를 복사했습니다");
  const ti = $("#titleIn");
  ti.onchange = async () => {
    const v = ti.value.trim(); if (!v || v === a.title) { ti.value = a.title; return; }
    try { await api("/api/albums/" + a.id, { method: "PATCH", json: { title: v } }); a.title = v; toast(`모든 링크가 ${safeTitle(v)}_번호 로 바뀌었습니다`); renderAlbum(); }
    catch (e) { ti.value = a.title; fail(e); }
  };
  app.querySelectorAll("[data-cols]").forEach(b => b.onclick = () => { S.cols = +b.dataset.cols; ls.set("ordo.cols", S.cols); renderAlbum(); });
  $("#quality").onchange = e => { S.quality = e.target.value; ls.set("ordo.q", S.quality); };
  $("#addBtn").onclick = () => $("#fileInput").click();
  $("#zipBtn").onclick = zipAlbum;
  const pc = $("#pickCancel"); if (pc) pc.onclick = () => { S.pick = null; renderAlbum(); };
  const del = $("#delAlbum");
  del.onclick = async () => {
    if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "사진까지 모두 지워집니다. 한 번 더 누르세요"; return; }
    try { await api("/api/albums/" + a.id, { method: "DELETE" }); toast("앨범을 삭제했습니다"); await backToLibrary(); } catch (e) { fail(e); }
  };
  const grid = $("#grid");
  if (grid) {
    grid.querySelectorAll(".card").forEach(c => {
      c.onclick = e => { if (e.target.closest("[data-more]")) return; tapCard(c.dataset.id); };
      c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tapCard(c.dataset.id); } };
    });
    grid.querySelectorAll("[data-more]").forEach(b => b.onclick = e => { e.stopPropagation(); S.pick = null; openSheet(b.dataset.more); });
  }
}

async function saveOrder(prev, msg) {
  try { await api(`/api/albums/${S.album.id}/order`, { method: "PUT", json: { ids: S.images.map(x => x.id) } }); toast(msg); }
  catch (e) { S.images = prev; fail(e); if (e.status === 409) return openAlbum(S.album.id); }
}
async function moveImage(from, to, msg) {
  if (from === to || from < 0 || to < 0) return;
  const prev = S.images.slice(); const [m] = S.images.splice(from, 1); S.images.splice(to, 0, m);
  renderAlbum(); await saveOrder(prev, msg || `${from + 1}번 → ${to + 1}번으로 이동, 번호를 다시 매겼습니다`); renderAlbum();
}
function tapCard(id) {
  if (S.busy) return;
  if (!S.pick) { S.pick = id; return renderAlbum(); }
  if (S.pick === id) { S.pick = null; return renderAlbum(); }
  const from = S.images.findIndex(x => x.id === S.pick), to = S.images.findIndex(x => x.id === id);
  S.pick = null; moveImage(from, to);
}

/* ---------- 사진 메뉴 ---------- */
function closeSheet() { document.querySelectorAll(".scrim,.sheet").forEach(n => n.remove()); S.sheet = null; }
function openSheet(id) {
  closeSheet(); const i = S.images.findIndex(x => x.id === id); if (i < 0) return; const it = S.images[i], n = S.images.length;
  S.sheet = id;
  const scrim = document.createElement("div"); scrim.className = "scrim"; scrim.onclick = closeSheet;
  const sh = document.createElement("div"); sh.className = "sheet"; sh.setAttribute("role", "dialog"); sh.setAttribute("aria-label", `${i + 1}번 사진`);
  const saved = it.ext === "webp" && it.orig_size > it.size ? ` <span class="muted">(원본 ${fmt(it.orig_size)}, ${Math.round((1 - it.size / it.orig_size) * 100)}% 절감)</span>` : "";
  sh.innerHTML = `<div class="wrap">
    <div class="grab"></div>
    <div class="row" style="justify-content:space-between"><b class="mono">${esc(fileName(i))}</b><button class="iconbtn" id="shClose" aria-label="닫기">✕</button></div>
    <div class="preview"><img alt="" src="/f/${it.id}"></div>
    <div class="linkbox"><code>${esc(linkOf(i))}</code><button class="btn primary" id="shCopy">복사</button></div>
    <div class="stack" style="gap:8px"><h2>순서 이동 (현재 ${i + 1} / ${n})</h2>
      <div class="movegrid">
        <button class="btn" data-mv="first"${i === 0 ? " disabled" : ""}>⇤ 맨 앞</button>
        <button class="btn" data-mv="-1"${i === 0 ? " disabled" : ""}>← 앞</button>
        <button class="btn" data-mv="1"${i === n - 1 ? " disabled" : ""}>뒤 →</button>
        <button class="btn" data-mv="last"${i === n - 1 ? " disabled" : ""}>맨 뒤 ⇥</button>
      </div>
      <form class="goto" id="gotoForm"><input id="gotoN" type="number" inputmode="numeric" min="1" max="${n}" placeholder="${i + 1}" aria-label="이동할 번호"><button class="btn" type="submit">번으로 이동</button></form>
    </div>
    <dl class="facts">
      <dt>크기</dt><dd>${it.w || "?"}×${it.h || "?"}</dd>
      <dt>용량</dt><dd>${fmt(it.size)}${saved}</dd>
      <dt>원래 이름</dt><dd>${esc(it.orig_name || "-")}</dd>
    </dl>
    <div class="row"><a class="btn" href="${esc(linkOf(i))}" download="${esc(fileName(i))}" style="flex:1;text-decoration:none">이 사진 저장</a><button class="btn danger" id="shDel" style="flex:1">삭제</button></div>
  </div>`;
  document.body.append(scrim, sh);
  $("#shClose").onclick = closeSheet;
  $("#shCopy").onclick = () => copy(linkOf(i), "링크를 복사했습니다");
  const go = async to => { to = Math.max(0, Math.min(n - 1, to)); closeSheet(); await moveImage(i, to, `${to + 1}번으로 이동했습니다`); openSheet(id); };
  sh.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => { const v = b.dataset.mv; go(v === "first" ? 0 : v === "last" ? n - 1 : i + +v); });
  $("#gotoForm").onsubmit = e => { e.preventDefault(); const v = parseInt($("#gotoN").value, 10); if (!v || v < 1 || v > n) { toast(`1부터 ${n} 사이 번호를 입력하세요`); return; } go(v - 1); };
  const del = $("#shDel");
  del.onclick = async () => {
    if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "한 번 더 눌러 삭제"; return; }
    try { await api("/api/images/" + id, { method: "DELETE" }); S.images.splice(i, 1); closeSheet(); toast("삭제했습니다. 뒤 번호가 하나씩 당겨졌습니다"); renderAlbum(); }
    catch (e) { fail(e); }
  };
}

/* ---------- 업로드 ---------- */
$("#fileInput").onchange = async e => {
  const files = [...e.target.files]; e.target.value = "";
  if (!files.length || !S.album) return;
  const albumId = S.album.id; let ok = 0, fallback = 0;
  for (let k = 0; k < files.length; k++) {
    S.busy = `올리는 중 ${k + 1} / ${files.length}`; if (S.album?.id === albumId) renderAlbum();
    try {
      const r = await toWebp(files[k], S.quality);
      if (r.blob.size > S.maxFile) throw new Error(`${files[k].name}: 변환 후에도 ${fmt(S.maxFile)}를 넘어서 올릴 수 없습니다`);
      if (r.fallback) fallback++;
      const fd = new FormData();
      const ext = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" }[r.blob.type] || "bin";
      fd.append("file", r.blob, "upload." + ext);
      fd.append("w", r.w); fd.append("h", r.h); fd.append("origName", r.origName); fd.append("origSize", r.origSize);
      const res = await api(`/api/albums/${albumId}/images`, { method: "POST", form: fd });
      if (S.album?.id === albumId) S.images.push(res.image);
      ok++;
    } catch (er) { toast(er.message || `${files[k].name}을(를) 올리지 못했습니다`); if (er.status === 413 || er.status === 507 || er.status === 401) break; }
  }
  S.busy = null; if (S.album?.id === albumId) renderAlbum();
  if (ok) toast(fallback ? `${ok}장 올림. ${fallback}장은 WebP 변환이 안 돼 원래 형식으로 올렸습니다` : `${ok}장을 WebP로 올렸습니다`);
};

/* ---------- ZIP ---------- */
async function zipAlbum() {
  if (!window.JSZip) { toast("ZIP 도구를 불러오지 못했습니다. 새로고침 후 다시 시도하세요"); return; }
  S.busy = "ZIP 만드는 중"; renderAlbum();
  try {
    const z = new JSZip();
    for (let i = 0; i < S.images.length; i++) { const r = await fetch("/f/" + S.images[i].id); z.file(fileName(i), await r.blob()); }
    const blob = await z.generateAsync({ type: "blob" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = safeTitle(S.album.title) + ".zip";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch { toast("ZIP을 만들지 못했습니다"); }
  S.busy = null; renderAlbum();
}

/* ---------- 관리자 ---------- */
async function openAdmin() {
  try { S.reports = (await api("/api/admin/reports")).reports; S.view = "admin"; render(); } catch (e) { fail(e); }
}
function renderAdmin() {
  app.innerHTML = header(`<button class="iconbtn" id="back" aria-label="보관함으로">←</button><b style="flex:1">신고 관리</b>`) +
  `<main class="wrap stack"><p class="hint" style="margin:0">처리하지 않은 신고 ${S.reports.length}건</p>
   ${S.reports.length ? `<div class="adminlist">${S.reports.map(r => `<div class="adminitem">
      <div class="row" style="justify-content:space-between"><b>${esc(r.reason)}</b><span class="mono muted" style="font-size:12px">${new Date(r.created).toLocaleString("ko-KR")}</span></div>
      <div style="font-size:14px;min-width:0;overflow-wrap:anywhere">앨범: <a href="/a/${esc(r.album_id)}" target="_blank" rel="noopener">${esc(r.title || "(삭제됨)")}</a> · 올린 사람 ${esc(r.owner || "-")}${r.hidden ? ' · <span class="chip">숨김</span>' : ""}</div>
      ${r.detail ? `<div class="muted" style="font-size:14px;overflow-wrap:anywhere">${esc(r.detail)}</div>` : ""}
      <div class="row"><button class="btn danger" data-hide="${esc(r.album_id)}" data-v="${r.hidden ? 0 : 1}">${r.hidden ? "숨김 해제" : "앨범 숨기기"}</button><button class="btn" data-resolve="${esc(r.id)}">처리 완료</button></div>
    </div>`).join("")}</div>` : `<div class="empty">처리할 신고가 없습니다.</div>`}</main>`;
  $("#back").onclick = backToLibrary;
  app.querySelectorAll("[data-hide]").forEach(b => b.onclick = async () => { try { await api(`/api/admin/albums/${b.dataset.hide}/hide`, { method: "POST", json: { hidden: b.dataset.v === "1" } }); toast(b.dataset.v === "1" ? "앨범을 숨겼습니다. 링크가 더 이상 열리지 않습니다" : "숨김을 해제했습니다"); openAdmin(); } catch (e) { fail(e); } });
  app.querySelectorAll("[data-resolve]").forEach(b => b.onclick = async () => { try { await api(`/api/admin/reports/${b.dataset.resolve}/resolve`, { method: "POST" }); openAdmin(); } catch (e) { fail(e); } });
}

document.addEventListener("keydown", e => { if (e.key === "Escape") { if (S.sheet) closeSheet(); else if (S.pick) { S.pick = null; renderAlbum(); } } });

async function boot() {
  try {
    const me = await api("/api/me");
    S.me = me.user; S.usage = me.usage; if (me.maxFile) S.maxFile = me.maxFile; if (me.siteName) { S.site = me.siteName; document.title = me.siteName + " 이미지 호스팅"; }
    if (S.me) { if (location.search) history.replaceState(null, "", "/"); await loadLibrary(); }
  } catch (e) { app.innerHTML = `<main class="wrap" style="padding-block:48px"><h1>서버에 연결하지 못했습니다</h1><p class="muted">${esc(e.message)}</p></main>`; return; }
  render();
}
boot();
})();
