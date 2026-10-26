// /api, /f, /a 요청과 /제목_번호.webp 사진 요청을 src/app.js로 넘깁니다. 나머지는 public 폴더의 파일을 그대로 보여줍니다.
import { handle } from "../src/app.js";

export async function onRequest(context) {
  const res = await handle(context.request, context.env);
  return res || context.next();
}
