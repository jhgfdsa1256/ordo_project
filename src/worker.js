// Cloudflare Worker 진입점. wrangler.jsonc 의 main 이 이 파일을 가리킵니다.
// /api, /f, /a 요청과 /제목_번호.webp 사진 요청은 src/app.js 가 처리하고,
// 나머지(화면 파일)는 public 폴더의 정적 파일을 그대로 돌려줍니다.
import { handle } from "./app.js";

export default {
  async fetch(request, env) {
    const res = await handle(request, env);
    return res || env.ASSETS.fetch(request);
  },
};
