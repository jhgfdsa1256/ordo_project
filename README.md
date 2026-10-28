# Ordo 이미지 호스팅

AI 이미지를 앨범 단위로 올리고, 앨범 제목과 순서에 따라 `제목_1.webp`, `제목_2.webp` 링크를 주는 이미지 호스팅 사이트입니다.

- 구글 로그인, 개인 보관함, 앨범별 관리
- 여러 장 한 번에 업로드, 브라우저에서 WebP 변환 (고화질 90 / 무손실)
- 사진을 눌러서 순서 변경, 변경 즉시 링크 번호가 다시 매겨짐
- 1~5열 미리보기, 앨범 ZIP 저장
- 앨범을 묶는 폴더(한 단계), 폰·태블릿·PC에 맞춰 바뀌는 화면
- 로그인 없이 보는 공유 페이지, 신고 접수와 관리자 숨김 처리
- 1인 저장 한도와 전체 저장 한도 (무료 범위를 넘지 않도록)

## 구조

| 경로 | 내용 |
| --- | --- |
| `public/` | 화면 (index.html, app.js, style.css) |
| `src/worker.js` | Cloudflare Worker 진입점 |
| `wrangler.jsonc` | 배포 설정 (Worker 이름, D1 연결, 정적 파일) |
| `src/app.js` | 서버 로직 전체 (로그인, 앨범, 업로드, 링크, 공유 페이지, 신고) |
| `src/storage.js` | 사진 저장소 (R2 또는 Supabase·Backblaze B2 같은 S3 호환 저장소) |
| `test/smoke.mjs` | 가짜 DB·저장소로 서버 흐름 점검 (`node test/smoke.mjs`, S3 경로는 `USE_S3=1`) |
| `test/s3.mjs` | S3 서명·저장소 어댑터 점검 (`node test/s3.mjs`) |
| `test/worker.mjs` | Worker 진입점 점검 (`node test/worker.mjs`) |

공개 주소 형식

- 사진: `/{제목}_{번호}.{확장자}` (제목은 사이트 전체에서 하나)
- 공유 페이지: `/a/{앨범ID}`

설치 방법은 `설치안내서.md`를 보세요.
