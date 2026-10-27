// 서버 코드 점검용: 가짜 D1(SQLite)과 가짜 R2(메모리)로 주요 흐름을 돌려봅니다.
// 실행: node test/smoke.mjs   (배포에는 쓰이지 않습니다)
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { handle } from "../src/app.js";

const sql = new DatabaseSync(":memory:");
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  first: async () => sql.prepare(q).get(...args) ?? null,
  all: async () => ({ results: sql.prepare(q).all(...args) }),
  run: async () => { sql.prepare(q).run(...args); return { success: true }; },
});
const DB = { prepare: q => stmt(q), batch: async list => { for (const s of list) await s.run(); return []; } };
const store = new Map();
const BUCKET = {
  async put(k, body, o) { store.set(k, { buf: new Uint8Array(await new Response(body).arrayBuffer()), type: o?.httpMetadata?.contentType }); },
  async get(k) { const v = store.get(k); return v ? { body: v.buf, httpEtag: `"${k}-${v.buf.length}"`, httpMetadata: { contentType: v.type } } : null; },
  async delete(k) { for (const x of [].concat(k)) store.delete(x); },
};
// USE_S3=1 이면 R2 대신 S3 호환 저장소(가짜 서버)로 같은 점검을 돌립니다.
const useS3 = process.env.USE_S3 === "1";
if (useS3) {
  globalThis.fetch = async (url, init) => {
    const key = new URL(url).pathname.replace(/^\/s3\/ordo\//, "");
    if (init.method === "PUT") { store.set(key, { buf: new Uint8Array(init.body), type: init.headers["content-type"] }); return new Response(null, { status: 200 }); }
    if (init.method === "GET") { const v = store.get(key); return v ? new Response(v.buf, { headers: { etag: `"${key}-${v.buf.length}"`, "content-type": v.type } }) : new Response("", { status: 404 }); }
    if (init.method === "DELETE") { store.delete(key); return new Response(null, { status: 204 }); }
    return new Response("", { status: 400 });
  };
}
const s3env = { S3_ENDPOINT: "https://x.example/s3", S3_REGION: "r", S3_BUCKET: "ordo", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
const env = { DB, ...(useS3 ? s3env : { BUCKET }), DEV_LOGIN: "1", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", ADMIN_EMAILS: "dev@localhost", USER_QUOTA_MB: "1" };
const O = "http://localhost:8788";
let jar = "";
async function call(method, path, body, extra = {}) {
  const headers = { cookie: jar, origin: O, ...extra };
  let b = body;
  if (body && !(body instanceof FormData)) { headers["content-type"] = "application/json"; b = JSON.stringify(body); }
  const r = await handle(new Request(O + path, { method, headers, body: b }), env);
  const sc = r.headers.get("set-cookie"); if (sc && sc.includes("ordo_sid=")) jar = sc.split(";")[0];
  return r;
}
const j = async r => ({ status: r.status, body: await r.json() });
const png = n => new File([new Uint8Array(200 + n).fill(n)], `${1000 + n}.png`, { type: "image/webp" });

// 로그인 전
assert.equal((await j(await call("GET", "/api/albums"))).status, 401);
assert.equal(await handle(new Request(O + "/index.html"), env), null, "정적 파일은 통과");
// 로그인 페이지는 구글로 보냄
const lg = await call("GET", "/api/auth/login"); assert.equal(lg.status, 302); assert.match(lg.headers.get("location"), /accounts\.google\.com/);
// 다른 사이트에서 온 요청 거부
assert.equal((await call("POST", "/api/albums", { title: "x" }, { origin: "https://evil.example" })).status, 403);
// 시험 로그인
assert.equal((await call("POST", "/api/auth/dev-login")).status, 200);
const me = await j(await call("GET", "/api/me")); assert.equal(me.body.user.isAdmin, true);
// 앨범 + 업로드 3장
const al = (await j(await call("POST", "/api/albums", { title: "AA 테스트" }))).body.album;
const ids = [];
for (let n = 0; n < 3; n++) {
  const fd = new FormData(); fd.append("file", png(n)); fd.append("w", "10"); fd.append("h", "20"); fd.append("origName", `${1000 + n}.png`); fd.append("origSize", "9999");
  const r = await j(await call("POST", `/api/albums/${al.id}/images`, fd)); assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push(r.body.image.id);
}
// 잘못된 형식 거부
{ const fd = new FormData(); fd.append("file", new File(["x"], "a.txt", { type: "text/plain" })); assert.equal((await call("POST", `/api/albums/${al.id}/images`, fd)).status, 415); }
// 같은 제목(대소문자·띄어쓰기만 다른 것 포함)은 거부
assert.equal((await call("POST", "/api/albums", { title: "aa  테스트" })).status, 409);
assert.equal((await j(await call("GET", "/api/title-check?title=" + encodeURIComponent("AA 테스트")))).body.available, false);
assert.equal((await j(await call("GET", "/api/title-check?title=" + encodeURIComponent("AA 테스트") + "&except=" + al.id))).body.available, true);
const other = (await j(await call("POST", "/api/albums", { title: "CC" }))).body.album;
assert.equal((await call("PATCH", `/api/albums/${other.id}`, { title: "AA 테스트" })).status, 409);
// 정적 파일은 서버 코드를 거치지 않음
assert.equal(await handle(new Request(O + "/app.js"), env), null);
// 공개 링크: 제목 공백 → _, 대소문자 무시
const name = n => `/${encodeURIComponent("AA_테스트")}_${n}.webp`;
const size = async n => { const r = await call("GET", name(n)); return r.status === 200 ? (await r.arrayBuffer()).byteLength : r.status; };
assert.deepEqual([await size(1), await size(2), await size(3)], [200, 201, 202]);
assert.equal((await call("GET", `/${encodeURIComponent("aa_테스트")}_1.webp`)).status, 200);
assert.equal((await call("GET", `/${encodeURIComponent("AA_테스트")}_1.png`)).status, 404);
assert.equal(await size(4), 404);
// 순서 변경: 3번을 맨 앞으로
assert.equal((await call("PUT", `/api/albums/${al.id}/order`, { ids: [ids[2], ids[0], ids[1]] })).status, 200);
assert.deepEqual([await size(1), await size(2), await size(3)], [202, 200, 201]);
// 틀린 목록은 거부
assert.equal((await call("PUT", `/api/albums/${al.id}/order`, { ids: [ids[0], ids[0], ids[1]] })).status, 409);
// 제목 변경 → 옛 링크 404, 새 링크 200
await call("PATCH", `/api/albums/${al.id}`, { title: "BB" });
assert.equal(await size(1), 404);
assert.equal((await call("GET", `/BB_1.webp`)).status, 200);
// 제목을 바꾸면 옛 제목은 다른 앨범이 쓸 수 있음
assert.equal((await call("PATCH", `/api/albums/${other.id}`, { title: "AA 테스트" })).status, 200);
await call("PATCH", `/api/albums/${other.id}`, { title: "CC" });
// 공유 페이지
const sp = await call("GET", `/a/${al.id}`); const html = await sp.text();
assert.equal(sp.status, 200); assert.ok(html.includes(O + "/BB_3.webp"));
// 보관함 목록
const lib = await j(await call("GET", "/api/albums")); const bb = lib.body.albums.find(x => x.id === al.id); assert.equal(bb.count, 3); assert.equal(bb.covers.length, 3);
// 신고 → 관리자 숨김 → 링크 차단
assert.equal((await call("POST", "/api/report", { albumId: al.id, reason: "저작권 침해" })).status, 200);
const reps = await j(await call("GET", "/api/admin/reports")); assert.equal(reps.body.reports.length, 1);
await call("POST", `/api/admin/albums/${al.id}/hide`, { hidden: true });
assert.equal((await call("GET", `/BB_1.webp`)).status, 404);
assert.equal((await call("GET", `/a/${al.id}`)).status, 404);
await call("POST", `/api/admin/albums/${al.id}/hide`, { hidden: false });
// 사진 삭제 → 번호 당겨짐
await call("DELETE", `/api/images/${ids[2]}`);
assert.equal((await call("GET", `/BB_3.webp`)).status, 404);
assert.equal(await (async () => (await (await call("GET", `/BB_1.webp`)).arrayBuffer()).byteLength)(), 200);
// 용량 한도 (1MB)
{ const fd = new FormData(); fd.append("file", new File([new Uint8Array(1100000)], "big.webp", { type: "image/webp" })); assert.equal((await call("POST", `/api/albums/${al.id}/images`, fd)).status, 413); }
// 앨범 삭제 → 저장소 비워짐, 제목이 다시 비어 있음
await call("DELETE", `/api/albums/${al.id}`);
await call("DELETE", `/api/albums/${other.id}`);
assert.equal((await call("POST", "/api/albums", { title: "BB" })).status, 201);
assert.equal(store.size, 0);
// 로그아웃
await call("POST", "/api/auth/logout"); jar = "";
assert.equal((await j(await call("GET", "/api/me"))).body.user, null);
console.log("모든 점검 통과");
