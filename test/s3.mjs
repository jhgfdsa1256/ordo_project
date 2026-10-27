// S3 호환 저장소(Supabase, Backblaze B2) 어댑터 점검.
// 실행: node test/s3.mjs   (배포에는 쓰이지 않습니다)
import assert from "node:assert/strict";
import { signV4, getStore } from "../src/storage.js";

// 1) AWS 공식 문서의 서명 예제(GET Object)와 똑같은 결과가 나오는지
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const auth = await signV4({
  method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt",
  headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
  payloadHash: EMPTY, accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1", amzDate: "20130524T000000Z",
});
assert.ok(auth.endsWith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"), auth);
assert.ok(auth.includes("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"));

// 2) 가짜 S3 서버로 저장·읽기·삭제 흐름
const objects = new Map(); const seen = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url); seen.push({ method: init.method, path: u.pathname, h: init.headers });
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=KEYID\/\d{8}\/ap-northeast-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date|SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.ok(!("host" in init.headers), "host 헤더는 직접 보내지 않음");
  if (init.method === "PUT") { objects.set(u.pathname, { buf: new Uint8Array(init.body), type: init.headers["content-type"] }); return new Response(null, { status: 200 }); }
  if (init.method === "GET") { const o = objects.get(u.pathname); return o ? new Response(o.buf, { headers: { etag: '"abc"', "content-type": o.type } }) : new Response("NoSuchKey", { status: 404 }); }
  if (init.method === "DELETE") { objects.delete(u.pathname); return new Response(null, { status: 204 }); }
  return new Response("?", { status: 400 });
};
const env = { S3_ENDPOINT: "https://abc.supabase.co/storage/v1/s3/", S3_REGION: "ap-northeast-2", S3_BUCKET: "ordo-images", S3_ACCESS_KEY_ID: "KEYID", S3_SECRET_ACCESS_KEY: "SECRET" };
const store = getStore(env);
assert.ok(store);
await store.put("img/abc123", new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/webp" } });
assert.deepEqual([...objects.keys()], ["/storage/v1/s3/ordo-images/img/abc123"]);
const got = await store.get("img/abc123");
assert.equal(got.httpEtag, '"abc"'); assert.equal(got.httpMetadata.contentType, "image/webp");
assert.deepEqual([...new Uint8Array(await new Response(got.body).arrayBuffer())], [1, 2, 3]);
assert.equal(await store.get("img/none"), null);
await store.delete(["img/abc123", "img/none"]);
assert.equal(objects.size, 0);
// 3) 서버가 오류를 돌려주면 예외
globalThis.fetch = async () => new Response("denied", { status: 403 });
await assert.rejects(() => store.put("img/x", new ArrayBuffer(1), {}), /저장소 저장 실패 \(403\)/);
// 4) 설정이 모자라면 저장소 없음 / R2 연결이 있으면 그걸 우선
assert.equal(getStore({ S3_ENDPOINT: "x" }), null);
const r2 = {}; assert.equal(getStore({ BUCKET: r2, ...env }), r2);
console.log("S3 어댑터 점검 통과");
