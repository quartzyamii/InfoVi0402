/**
 * 로컬 서버가 돌아가는 상태에서 API와 동일한 페이로드를 public/treemap-data.json 으로 저장합니다.
 * 호버 시 파일명·용량이 로컬 트리맵과 같게 맞추려면 이 파일을 커밋·푸시하세요.
 *
 * 사용: yarn start (다른 터미널) → yarn export-treemap-json
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.APP_PORT) || 3000;
const OUT = path.join(__dirname, "..", "public", "treemap-data.json");

const req = http.get(
  `http://127.0.0.1:${PORT}/api/treemap-data`,
  { headers: { Accept: "application/json" } },
  (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (c) => {
      raw += c;
    });
    res.on("end", () => {
      if (res.statusCode !== 200) {
        console.error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`);
        process.exit(1);
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error("JSON 파싱 실패:", e.message);
        process.exit(1);
      }
      if (data.error) {
        console.error("API 오류:", data.error);
        process.exit(1);
      }
      fs.writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      console.log("저장됨:", OUT);
    });
  }
);

req.on("error", (e) => {
  console.error(`연결 실패 (${PORT}번 포트). 먼저 yarn start 로 서버를 띄우세요.`);
  console.error(e.message);
  process.exit(1);
});
