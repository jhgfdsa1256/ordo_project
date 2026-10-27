// 사진 저장소. 둘 중 하나를 씁니다.
//  1) R2: wrangler.jsonc 의 r2_buckets 에 BUCKET 이름으로 R2 버킷을 연결
//  2) S3 호환 저장소(Supabase Storage, Backblaze B2 등): 환경 변수 5개
//     S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
// 어느 쪽이든 put / get / delete 세 가지만 쓰므로 나머지 코드는 저장소가 뭔지 모릅니다.

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha256hex = async data => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

// AWS Signature Version 4 서명. headers는 서명에 넣을 헤더 전부(host 포함, 이름은 소문자).
export async function signV4({ method, url, headers, payloadHash, accessKeyId, secretAccessKey, region, amzDate, service = "s3" }) {
  const u = new URL(url);
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonHeaders = names.map(n => `${n}:${String(headers[n]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = [method, u.pathname, query, canonHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256hex(canonical)].join("\n");
  let k = await hmac(enc.encode("AWS4" + secretAccessKey), date);
  k = await hmac(k, region); k = await hmac(k, service); k = await hmac(k, "aws4_request");
  const signature = hex(await hmac(k, toSign));
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function s3Store(env) {
  const base = String(env.S3_ENDPOINT).replace(/\/+$/, "");
  const region = env.S3_REGION || "us-east-1";
  const urlFor = key => `${base}/${encodeURIComponent(env.S3_BUCKET)}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function send(method, key, body, contentType) {
    const url = urlFor(key);
    const u = new URL(url);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const payloadHash = await sha256hex(body ?? "");
    const headers = { host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (contentType) headers["content-type"] = contentType;
    const authorization = await signV4({ method, url, headers, payloadHash, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, region, amzDate });
    const { host, ...sendHeaders } = headers; // host는 fetch가 알아서 붙임
    return fetch(url, { method, headers: { ...sendHeaders, authorization }, body });
  }
  const fail = async (what, res) => { throw new Error(`저장소 ${what} 실패 (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`); };

  return {
    async put(key, body, opts) {
      const res = await send("PUT", key, body, opts?.httpMetadata?.contentType || "application/octet-stream");
      if (!res.ok) await fail("저장", res);
    },
    async get(key) {
      const res = await send("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) await fail("읽기", res);
      return { body: res.body, httpEtag: res.headers.get("etag") || "", httpMetadata: { contentType: res.headers.get("content-type") || undefined } };
    },
    async delete(keys) {
      const list = [].concat(keys);
      for (let i = 0; i < list.length; i += 10) {
        await Promise.all(list.slice(i, i + 10).map(async key => {
          const res = await send("DELETE", key);
          if (!res.ok && res.status !== 404) await fail("삭제", res);
        }));
      }
    },
  };
}

export function getStore(env) {
  if (env.BUCKET) return env.BUCKET;
  if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) return s3Store(env);
  return null;
}
