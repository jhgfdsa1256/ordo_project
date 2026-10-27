// Worker 진입점 점검: 서버 경로는 app.js가, 그 밖은 정적 파일(ASSETS)이 처리하는지
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const env = { ASSETS: { fetch: async req => new Response("static:" + new URL(req.url).pathname) } };
// DB·저장소가 없으면 서버 경로는 설정 안내 오류
const api = await worker.fetch(new Request("https://x.example/api/me"), env);
assert.equal(api.status, 500); assert.match((await api.json()).error, /서버 설정이 끝나지 않았습니다/);
// 정적 파일은 ASSETS 로
const st = await worker.fetch(new Request("https://x.example/app.js"), env);
assert.equal(await st.text(), "static:/app.js");
const root = await worker.fetch(new Request("https://x.example/"), env);
assert.equal(await root.text(), "static:/");
// 사진 주소 모양은 서버가 가져감 (설정이 없으니 500)
const img = await worker.fetch(new Request("https://x.example/AA_1.webp"), env);
assert.equal(img.status, 500);
console.log("Worker 진입점 점검 통과");
