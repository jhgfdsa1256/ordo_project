// Ordo 서버 (Cloudflare Worker)
// 필요한 연결(wrangler.jsonc): DB (D1 데이터베이스)
// 사진 저장소: BUCKET (R2 버킷) 또는 S3_* 환경 변수 5개 (src/storage.js 참고)
// 필요한 환경 변수: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// 선택 환경 변수: ADMIN_EMAILS, USER_QUOTA_MB, TOTAL_QUOTA_GB, MAX_FILE_MB, CACHE_SECONDS, SITE_NAME

import { getStore } from "./storage.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT, name TEXT, created INTEGER, banned INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, slug TEXT, created INTEGER, updated INTEGER, hidden INTEGER DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS albums_slug ON albums(slug)`,
  `CREATE INDEX IF NOT EXISTS albums_user ON albums(user_id)`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, album_id TEXT, user_id TEXT, pos INTEGER, ext TEXT, mime TEXT, size INTEGER, w INTEGER, h INTEGER, orig_name TEXT, orig_size INTEGER, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS images_album ON images(album_id, pos)`,
  `CREATE INDEX IF NOT EXISTS images_user ON images(user_id)`,
  `CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, album_id TEXT, reason TEXT, detail TEXT, created INTEGER, resolved INTEGER DEFAULT 0)`,
];

const ALLOWED = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
const REASONS = ["불법 촬영물·성적 착취물", "저작권 침해", "개인정보 노출", "기타"];
const SESSION_DAYS = 30;

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  schemaReady = true;
}

/* ---------- helpers ---------- */
export const safeTitle = t => {
  const s = String(t || "").trim().replace(/[\\/:*?"<>|#%&+\s]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 60);
  return s || "untitled";
};
// 사이트 전체에서 제목이 겹치는지 볼 때 쓰는 값 (대소문자 구분 없음)
export const slugOf = t => safeTitle(t).toLowerCase();
// 공개 사진 주소: /제목_번호.확장자
const IMG_RE = /^\/([^/]+)_(\d{1,5})\.(webp|png|jpg|gif)$/i;
const dupMsg = t => `"${safeTitle(t)}" 제목은 이미 다른 앨범이 쓰고 있습니다. 다른 제목을 입력하세요.`;
const isUniqueErr = e => /UNIQUE|constraint/i.test(String(e && (e.message || e)));
const rid = (n = 10) => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(n));
  let s = ""; for (const x of r) s += a[x % a.length]; return s;
};
const now = () => Date.now();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
const limits = env => ({
  user: num(env.USER_QUOTA_MB, 500) * 1048576,
  total: num(env.TOTAL_QUOTA_GB, 9.5) * 1073741824,
  file: num(env.MAX_FILE_MB, 20) * 1048576,
  cache: Math.round(num(env.CACHE_SECONDS, 60)),
});
const siteName = env => env.SITE_NAME || "Ordo";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
const err = (status, message) => json({ error: message }, status);

function cookies(req) {
  const out = {}; const h = req.headers.get("cookie") || "";
  for (const part of h.split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
}
function sameOrigin(req) {
  const o = req.headers.get("origin"); if (!o) return true;
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}
const isAdmin = (env, user) => !!user && (env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).includes((user.email || "").toLowerCase());

async function currentUser(req, env) {
  const sid = cookies(req).ordo_sid; if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ? AND u.banned = 0`
  ).bind(await sha256(sid), now()).first();
  return row || null;
}
async function newSession(env, userId) {
  const token = rid(40);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)`).bind(await sha256(token), userId, now() + SESSION_DAYS * 864e5).run();
  return token;
}
async function usedBytes(env, userId) {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(size),0) AS s FROM images WHERE user_id = ?`).bind(userId).first();
  return r ? Number(r.s) : 0;
}
async function ownAlbum(env, user, id) {
  return await env.DB.prepare(`SELECT * FROM albums WHERE id = ? AND user_id = ?`).bind(id, user.id).first();
}
async function albumImages(env, albumId) {
  const r = await env.DB.prepare(`SELECT id, ext, size, w, h, orig_name, orig_size FROM images WHERE album_id = ? ORDER BY pos, created`).bind(albumId).all();
  return r.results || [];
}
const publicLink = (origin, album, i, img) => `${origin}/${encodeURIComponent(safeTitle(album.title))}_${i + 1}.${img.ext}`;

/* ---------- router ---------- */
export async function handle(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const isImg = IMG_RE.test(p);
  if (!p.startsWith("/api/") && !p.startsWith("/f/") && !p.startsWith("/a/") && !isImg) return null;
  const store = getStore(env);
  if (!env.DB || !store) return err(500, "서버 설정이 끝나지 않았습니다. DB(D1)와 사진 저장소(R2 BUCKET 또는 S3 설정)를 확인하세요.");
  env = { ...env, STORE: store };
  await ensureSchema(env);
  try {
    if (isImg) return await serveByName(req, env, p);
    if (p.startsWith("/f/")) return await serveById(req, env, p);
    if (p.startsWith("/a/")) return await sharePage(req, env, p);
    return await api(req, env, url);
  } catch (e) {
    console.error(e);
    return err(500, "처리 중 오류가 났습니다. 잠시 후 다시 시도하세요.");
  }
}

async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  if (m !== "GET" && !sameOrigin(req)) return err(403, "다른 사이트에서 온 요청은 받을 수 없습니다.");

  /* auth */
  if (p === "/api/auth/login" && m === "GET") return login(req, env, url);
  if (p === "/api/auth/callback" && m === "GET") return callback(req, env, url);
  if (p === "/api/auth/dev-login" && m === "POST") return devLogin(req, env, url);
  if (p === "/api/auth/logout" && m === "POST") {
    const sid = cookies(req).ordo_sid;
    if (sid) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(sid)).run();
    return json({ ok: true }, 200, { "set-cookie": cookie("ordo_sid", "", 0) });
  }
  if (p === "/api/report" && m === "POST") return report(req, env);

  const user = await currentUser(req, env);
  if (p === "/api/me" && m === "GET") {
    if (!user) return json({ user: null });
    const L = limits(env);
    return json({ user: { name: user.name, email: user.email, isAdmin: isAdmin(env, user) }, usage: { used: await usedBytes(env, user.id), quota: L.user }, maxFile: L.file, siteName: siteName(env) });
  }
  if (!user) return err(401, "로그인이 필요합니다.");

  /* albums */
  if (p === "/api/albums" && m === "GET") {
    const r = await env.DB.prepare(
      `SELECT a.id, a.title, a.updated, a.hidden, COUNT(i.id) AS count, COALESCE(SUM(i.size),0) AS size
       FROM albums a LEFT JOIN images i ON i.album_id = a.id WHERE a.user_id = ? GROUP BY a.id ORDER BY a.updated DESC`
    ).bind(user.id).all();
    const albums = r.results || [];
    for (const a of albums) {
      const c = await env.DB.prepare(`SELECT id FROM images WHERE album_id = ? ORDER BY pos, created LIMIT 4`).bind(a.id).all();
      a.covers = (c.results || []).map(x => x.id);
    }
    return json({ albums });
  }
  if (p === "/api/albums" && m === "POST") {
    const body = await req.json().catch(() => ({}));
    const title = String(body.title || "").trim().slice(0, 60);
    if (!title) return err(400, "앨범 제목을 입력하세요.");
    const id = rid(8), t = now(), slug = slugOf(title);
    if (await env.DB.prepare(`SELECT id FROM albums WHERE slug = ?`).bind(slug).first()) return err(409, dupMsg(title));
    try { await env.DB.prepare(`INSERT INTO albums (id, user_id, title, slug, created, updated) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, user.id, title, slug, t, t).run(); }
    catch (e) { if (isUniqueErr(e)) return err(409, dupMsg(title)); throw e; }
    return json({ album: { id, title } }, 201);
  }

  if (p === "/api/title-check" && m === "GET") {
    const t = url.searchParams.get("title") || "", except = url.searchParams.get("except") || "";
    const row = await env.DB.prepare(`SELECT id FROM albums WHERE slug = ? AND id != ?`).bind(slugOf(t), except).first();
    return json({ name: safeTitle(t), available: !row });
  }

  let mm;
  if ((mm = p.match(/^\/api\/albums\/([a-z0-9]+)$/))) {
    const album = await ownAlbum(env, user, mm[1]);
    if (!album) return err(404, "앨범을 찾을 수 없습니다.");
    if (m === "GET") return json({ album: { id: album.id, title: album.title, hidden: !!album.hidden }, images: await albumImages(env, album.id) });
    if (m === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const title = String(body.title || "").trim().slice(0, 60);
      if (!title) return err(400, "앨범 제목을 입력하세요.");
      const slug = slugOf(title);
      if (await env.DB.prepare(`SELECT id FROM albums WHERE slug = ? AND id != ?`).bind(slug, album.id).first()) return err(409, dupMsg(title));
      try { await env.DB.prepare(`UPDATE albums SET title = ?, slug = ?, updated = ? WHERE id = ?`).bind(title, slug, now(), album.id).run(); }
      catch (e) { if (isUniqueErr(e)) return err(409, dupMsg(title)); throw e; }
      return json({ ok: true, title });
    }
    if (m === "DELETE") {
      const imgs = await albumImages(env, album.id);
      for (let i = 0; i < imgs.length; i += 900) await env.STORE.delete(imgs.slice(i, i + 900).map(x => "img/" + x.id));
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM images WHERE album_id = ?`).bind(album.id),
        env.DB.prepare(`DELETE FROM albums WHERE id = ?`).bind(album.id),
      ]);
      return json({ ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/albums\/([a-z0-9]+)\/images$/)) && m === "POST") return upload(req, env, user, mm[1]);
  if ((mm = p.match(/^\/api\/albums\/([a-z0-9]+)\/order$/)) && m === "PUT") {
    const album = await ownAlbum(env, user, mm[1]);
    if (!album) return err(404, "앨범을 찾을 수 없습니다.");
    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const current = (await albumImages(env, album.id)).map(x => x.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every(id => current.includes(id)))
      return err(409, "다른 곳에서 앨범이 바뀌었습니다. 새로고침 후 다시 시도하세요.");
    const stmts = ids.map((id, i) => env.DB.prepare(`UPDATE images SET pos = ? WHERE id = ? AND album_id = ?`).bind(i + 1, id, album.id));
    stmts.push(env.DB.prepare(`UPDATE albums SET updated = ? WHERE id = ?`).bind(now(), album.id));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/images\/([a-z0-9]+)$/)) && m === "DELETE") {
    const img = await env.DB.prepare(`SELECT id, album_id FROM images WHERE id = ? AND user_id = ?`).bind(mm[1], user.id).first();
    if (!img) return err(404, "사진을 찾을 수 없습니다.");
    await env.STORE.delete("img/" + img.id);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM images WHERE id = ?`).bind(img.id),
      env.DB.prepare(`UPDATE albums SET updated = ? WHERE id = ?`).bind(now(), img.album_id),
    ]);
    return json({ ok: true });
  }

  /* admin */
  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(env, user)) return err(403, "관리자만 쓸 수 있습니다.");
    if (p === "/api/admin/reports" && m === "GET") {
      const r = await env.DB.prepare(
        `SELECT r.id, r.album_id, r.reason, r.detail, r.created, a.title, a.hidden, u.email AS owner
         FROM reports r LEFT JOIN albums a ON a.id = r.album_id LEFT JOIN users u ON u.id = a.user_id
         WHERE r.resolved = 0 ORDER BY r.created DESC LIMIT 200`
      ).all();
      return json({ reports: r.results || [] });
    }
    if ((mm = p.match(/^\/api\/admin\/albums\/([a-z0-9]+)\/hide$/)) && m === "POST") {
      const body = await req.json().catch(() => ({}));
      await env.DB.prepare(`UPDATE albums SET hidden = ? WHERE id = ?`).bind(body.hidden ? 1 : 0, mm[1]).run();
      return json({ ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/reports\/([a-z0-9]+)\/resolve$/)) && m === "POST") {
      await env.DB.prepare(`UPDATE reports SET resolved = 1 WHERE id = ?`).bind(mm[1]).run();
      return json({ ok: true });
    }
  }
  return err(404, "없는 주소입니다.");
}

/* ---------- Google login ---------- */
function login(req, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return err(500, "구글 로그인 키(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)가 설정되지 않았습니다.");
  const state = rid(24);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + "/api/auth/callback", response_type: "code",
    scope: "openid email profile", state, prompt: "select_account",
  });
  return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?" + q, "set-cookie": cookie("ordo_state", state, 600) } });
}
async function callback(req, env, url) {
  const back = (msg) => new Response(null, { status: 302, headers: { location: "/?login_error=" + encodeURIComponent(msg), "set-cookie": cookie("ordo_state", "", 0) } });
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (!code || !state || state !== cookies(req).ordo_state) return back("로그인 확인에 실패했습니다. 다시 시도하세요.");
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + "/api/auth/callback", grant_type: "authorization_code" }),
  });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.id_token) return back("구글에서 로그인 정보를 받지 못했습니다.");
  // id_token은 구글 서버에서 TLS로 직접 받은 값이라 서명 검증 없이 내용 확인만 합니다.
  let claims; try { claims = JSON.parse(b64urlDecode(tok.id_token.split(".")[1])); } catch { return back("로그인 정보를 읽지 못했습니다."); }
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || !claims.sub) return back("로그인 정보가 올바르지 않습니다.");
  let user = await env.DB.prepare(`SELECT id, banned FROM users WHERE google_sub = ?`).bind(claims.sub).first();
  if (user && user.banned) return back("이용이 정지된 계정입니다.");
  if (!user) {
    user = { id: rid(12) };
    await env.DB.prepare(`INSERT INTO users (id, google_sub, email, name, created) VALUES (?, ?, ?, ?, ?)`).bind(user.id, claims.sub, claims.email || "", claims.name || claims.email || "사용자", now()).run();
  } else {
    await env.DB.prepare(`UPDATE users SET email = ?, name = ? WHERE id = ?`).bind(claims.email || "", claims.name || claims.email || "사용자", user.id).run();
  }
  const token = await newSession(env, user.id);
  const h = new Headers({ location: "/" });
  h.append("set-cookie", cookie("ordo_sid", token, SESSION_DAYS * 86400));
  h.append("set-cookie", cookie("ordo_state", "", 0));
  return new Response(null, { status: 302, headers: h });
}
// 내 컴퓨터에서 시험할 때만 쓰는 로그인. DEV_LOGIN=1 이고 주소가 localhost일 때만 작동합니다.
async function devLogin(req, env, url) {
  if (env.DEV_LOGIN !== "1" || !["localhost", "127.0.0.1"].includes(url.hostname)) return err(404, "없는 주소입니다.");
  let user = await env.DB.prepare(`SELECT id FROM users WHERE google_sub = 'dev'`).first();
  if (!user) { user = { id: rid(12) }; await env.DB.prepare(`INSERT INTO users (id, google_sub, email, name, created) VALUES (?, 'dev', 'dev@localhost', '시험 사용자', ?)`).bind(user.id, now()).run(); }
  const token = await newSession(env, user.id);
  return json({ ok: true }, 200, { "set-cookie": cookie("ordo_sid", token, 86400) });
}

/* ---------- upload ---------- */
async function upload(req, env, user, albumId) {
  const album = await ownAlbum(env, user, albumId);
  if (!album) return err(404, "앨범을 찾을 수 없습니다.");
  const L = limits(env);
  const form = await req.formData().catch(() => null);
  const file = form && form.get("file");
  if (!file || typeof file === "string") return err(400, "사진 파일이 없습니다.");
  const ext = ALLOWED[file.type];
  if (!ext) return err(415, "webp, png, jpg, gif 사진만 올릴 수 있습니다.");
  if (file.size > L.file) return err(413, `사진 한 장은 ${Math.round(L.file / 1048576)}MB까지 올릴 수 있습니다.`);
  if ((await usedBytes(env, user.id)) + file.size > L.user) return err(413, "내 저장 공간이 가득 찼습니다. 사진을 지우고 다시 시도하세요.");
  const tot = await env.DB.prepare(`SELECT COALESCE(SUM(size),0) AS s FROM images`).first();
  if (Number(tot.s) + file.size > L.total) return err(507, "서비스 전체 저장 공간이 가득 찼습니다. 관리자에게 알려주세요.");

  const id = rid(16);
  await env.STORE.put("img/" + id, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(pos),0) AS m FROM images WHERE album_id = ?`).bind(album.id).first();
  const w = parseInt(form.get("w"), 10) || 0, h = parseInt(form.get("h"), 10) || 0;
  const origName = String(form.get("origName") || file.name || "").slice(0, 200);
  const origSize = parseInt(form.get("origSize"), 10) || file.size;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO images (id, album_id, user_id, pos, ext, mime, size, w, h, orig_name, orig_size, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, album.id, user.id, Number(max.m) + 1, ext, file.type, file.size, w, h, origName, origSize, now()),
    env.DB.prepare(`UPDATE albums SET updated = ? WHERE id = ?`).bind(now(), album.id),
  ]);
  return json({ image: { id, ext, size: file.size, w, h, orig_name: origName, orig_size: origSize } }, 201);
}

/* ---------- public files ---------- */
async function sendObject(req, obj, mime, cacheControl, filename) {
  const h = new Headers();
  h.set("content-type", mime || obj.httpMetadata?.contentType || "application/octet-stream");
  h.set("cache-control", cacheControl);
  h.set("etag", obj.httpEtag);
  h.set("access-control-allow-origin", "*");
  h.set("x-content-type-options", "nosniff");
  if (filename) h.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  if (req.headers.get("if-none-match") === obj.httpEtag) return new Response(null, { status: 304, headers: h });
  return new Response(req.method === "HEAD" ? null : obj.body, { headers: h });
}
const notFound = () => new Response("이미지를 찾을 수 없습니다.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=30" } });

async function serveByName(req, env, path) {
  const m = path.match(IMG_RE); if (!m) return notFound();
  let base; try { base = decodeURIComponent(m[1]); } catch { return notFound(); }
  const album = await env.DB.prepare(`SELECT id, title, hidden FROM albums WHERE slug = ?`).bind(base.toLowerCase()).first();
  if (!album || album.hidden) return notFound();
  const n = parseInt(m[2], 10); if (n < 1) return notFound();
  const img = await env.DB.prepare(`SELECT id, ext, mime FROM images WHERE album_id = ? ORDER BY pos, created LIMIT 1 OFFSET ?`).bind(album.id, n - 1).first();
  if (!img || img.ext !== m[3].toLowerCase()) return notFound();
  const obj = await env.STORE.get("img/" + img.id); if (!obj) return notFound();
  // 순서를 바꾸면 같은 주소가 다른 사진을 가리키므로 캐시는 짧게 둡니다.
  return sendObject(req, obj, img.mime, `public, max-age=${limits(env).cache}`, `${safeTitle(album.title)}_${n}.${img.ext}`);
}
async function serveById(req, env, path) {
  const m = path.match(/^\/f\/([a-z0-9]+)$/); if (!m) return notFound();
  const img = await env.DB.prepare(`SELECT i.id, i.mime, a.hidden FROM images i JOIN albums a ON a.id = i.album_id WHERE i.id = ?`).bind(m[1]).first();
  if (!img || img.hidden) return notFound();
  const obj = await env.STORE.get("img/" + img.id); if (!obj) return notFound();
  return sendObject(req, obj, img.mime, "public, max-age=31536000, immutable");
}

/* ---------- report ---------- */
async function report(req, env) {
  const body = await req.json().catch(() => ({}));
  const albumId = String(body.albumId || "");
  const reason = REASONS.includes(body.reason) ? body.reason : null;
  if (!reason) return err(400, "신고 사유를 고르세요.");
  const album = await env.DB.prepare(`SELECT id FROM albums WHERE id = ?`).bind(albumId).first();
  if (!album) return err(404, "앨범을 찾을 수 없습니다.");
  await env.DB.prepare(`INSERT INTO reports (id, album_id, reason, detail, created) VALUES (?, ?, ?, ?, ?)`)
    .bind(rid(12), album.id, reason, String(body.detail || "").slice(0, 500), now()).run();
  return json({ ok: true });
}

/* ---------- share page ---------- */
async function sharePage(req, env, path) {
  const m = path.match(/^\/a\/([a-z0-9]+)\/?$/);
  const album = m ? await env.DB.prepare(`SELECT id, title, hidden FROM albums WHERE id = ?`).bind(m[1]).first() : null;
  const site = esc(siteName(env));
  if (!album || album.hidden) {
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>앨범 없음 · ${site}</title><link rel="stylesheet" href="/style.css"><main class="wrap" style="padding-block:48px"><h1>앨범을 찾을 수 없습니다</h1><p class="muted">삭제되었거나 비공개로 바뀐 앨범입니다.</p></main>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const origin = new URL(req.url).origin;
  const imgs = await albumImages(env, album.id);
  const links = imgs.map((img, i) => publicLink(origin, album, i, img));
  const title = esc(album.title);
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} · ${site}</title>
<meta property="og:title" content="${title}"><meta property="og:description" content="사진 ${imgs.length}장">${links[0] ? `<meta property="og:image" content="${esc(links[0])}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css"></head><body>
<header class="top"><div class="wrap"><a class="logo" href="/"><i><b></b><b></b><b></b><b></b></i>${site}</a><b class="headtitle">${title}</b><button class="btn" id="copyAll">링크 전체 복사</button></div></header>
<main class="wrap stack" style="max-width:640px">
<p class="muted mono" style="margin:0;font-size:12px">사진 ${imgs.length}장</p>
<div class="sharelist">${imgs.map((img, i) => `<div class="shareitem">
  <img src="/f/${img.id}" alt="${i + 1}번 사진" loading="${i < 2 ? "eager" : "lazy"}"${img.w && img.h ? ` width="${img.w}" height="${img.h}"` : ""}>
  <div class="linkbox"><code>${esc(links[i])}</code><button class="btn" data-copy="${i}">복사</button></div></div>`).join("") || `<div class="empty">아직 사진이 없습니다.</div>`}</div>
<div class="report"><button class="btn danger" id="repToggle" style="justify-self:start">이 앨범 신고</button>
<form id="repForm" class="stack" style="gap:6px" hidden>
${REASONS.map((r, i) => `<label><input type="radio" name="reason" value="${esc(r)}"${i === 0 ? " checked" : ""}> ${esc(r)}</label>`).join("")}
<textarea id="repDetail" maxlength="500" rows="3" placeholder="자세한 내용 (선택)"></textarea>
<button class="btn primary" type="submit" style="justify-self:start">신고 보내기</button></form></div>
</main><div class="toast" id="toast" hidden></div>
<script>
const LINKS=${JSON.stringify(links).replace(/</g, "\\u003c")};const AID=${JSON.stringify(album.id)};
const toast=m=>{const t=document.getElementById("toast");t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2200)};
async function copy(s,m){try{await navigator.clipboard.writeText(s);toast(m)}catch{toast("복사가 막혔습니다. 링크를 길게 눌러 복사하세요")}}
document.getElementById("copyAll").onclick=()=>copy(LINKS.join("\\n"),"링크 "+LINKS.length+"개를 복사했습니다");
document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copy(LINKS[+b.dataset.copy],"링크를 복사했습니다"));
const f=document.getElementById("repForm");document.getElementById("repToggle").onclick=()=>f.hidden=!f.hidden;
f.onsubmit=async e=>{e.preventDefault();const reason=f.querySelector("input[name=reason]:checked").value;
const r=await fetch("/api/report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({albumId:AID,reason,detail:document.getElementById("repDetail").value})});
f.hidden=true;toast(r.ok?"신고가 접수되었습니다":"신고를 보내지 못했습니다")};
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
