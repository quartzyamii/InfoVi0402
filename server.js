const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.APP_PORT) || 3000;
const COMPOSE_FILE = path.join(ROOT, "docker-compose.yml");
const ADOBE_JSON_PATH =
  process.env.ADOBE_JSON_PATH || "/Users/kimminjin/Desktop/adobe_file_analysis.json";

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  try {
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* .env 없음 */
  }
}

loadDotEnv();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) {
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function runDocker(args, { timeoutMs = 120000 } = {}) {
  const cmd = `docker ${args}`;
  return execAsync(cmd, {
    cwd: ROOT,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

async function dockerAvailable() {
  try {
    await runDocker("version", { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function composePs() {
  try {
    const { stdout } = await runDocker(
      `compose -f "${COMPOSE_FILE}" ps --format json`,
      { timeoutMs: 30000 }
    );
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    const rows = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
    return rows.filter(Boolean);
  } catch (e) {
    return { error: e.stderr || e.message || String(e) };
  }
}

function sqlString(v) {
  return `'${String(v ?? "").replace(/'/g, "''")}'`;
}

function parseSizeToBytes(sizeText) {
  const t = String(sizeText || "").replace(/\s+/g, " ").trim();
  const m = t.match(/(?:약\s*)?([\d.]+)\s*(KB|MB|GB|B)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toUpperCase();
  const mul =
    unit === "GB"
      ? 1024 * 1024 * 1024
      : unit === "MB"
        ? 1024 * 1024
        : unit === "KB"
          ? 1024
          : 1;
  return Math.round(n * mul);
}

function readAdobeJson() {
  const raw = fs.readFileSync(ADOBE_JSON_PATH, "utf8");
  return JSON.parse(raw);
}

const EXT_ORDER = [".ai", ".psd", ".pdf", ".indd", ".aep", ".idml"];

function shortenPath(p, maxLen) {
  const s = String(p || "");
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 3)) + "...";
}

function extensionMeta(ext) {
  const e = String(ext || "").toLowerCase();
  const M = {
    ".ai": {
      headerLeft: "Illustrator",
      headerRight: ".ai",
      color: "#FF9A00",
      legendLabel: "Illustrator (.ai)",
    },
    ".psd": {
      headerLeft: "Photoshop",
      headerRight: ".psd",
      color: "#2E9DEF",
      legendLabel: "Photoshop (.psd)",
    },
    ".pdf": {
      headerLeft: "Acrobat (PDF)",
      headerRight: ".pdf",
      color: "#E24E4E",
      legendLabel: "Acrobat (PDF) (.pdf)",
    },
    ".indd": {
      headerLeft: "InDesign",
      headerRight: ".indd",
      color: "#FF4F90",
      legendLabel: "InDesign (.indd)",
    },
    ".aep": {
      headerLeft: "After Effects",
      headerRight: ".aep",
      color: "#9999F8",
      legendLabel: "After Effects (.aep)",
    },
    ".idml": {
      headerLeft: "InDesign",
      headerRight: ".idml",
      color: "#FF69A7",
      legendLabel: "InDesign (.idml)",
    },
  };
  return (
    M[e] || {
      headerLeft: ext || "기타",
      headerRight: "",
      color: "#4a5568",
      legendLabel: String(ext || "기타"),
    }
  );
}

function rowsFromJsonDoc(doc) {
  const rows = [];
  for (const app of doc.apps || []) {
    for (const f of app.top10_by_size || []) {
      rows.push({
        app_name: app.app_name,
        extension: app.extension,
        filename: f.filename,
        file_path: f.path,
        size_human: f.size_human,
        size_bytes: parseSizeToBytes(f.size_human),
      });
    }
  }
  return rows;
}

function bytesToHuman(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${Math.round(b / (1024 * 1024))} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${Math.max(0, Math.round(b))} B`;
}

function buildTreemapPayloadFromApps(apps, topRows, metadata, source) {
  const byExt = new Map();

  const topsByExt = new Map();
  for (const r of topRows || []) {
    const extKey = String(r.extension || "").toLowerCase() || ".unknown";
    if (!topsByExt.has(extKey)) topsByExt.set(extKey, []);
    const sb =
      r.size_bytes != null && r.size_bytes !== ""
        ? Number(r.size_bytes)
        : parseSizeToBytes(r.size_human);
    topsByExt.get(extKey).push({
      name: r.filename,
      value: Math.max(1, Number.isFinite(sb) ? sb : 0),
      size_human: r.size_human,
      extension: extKey,
    });
  }

  for (const app of apps || []) {
    const extKey = String(app.extension || "").toLowerCase() || ".unknown";
    const m = extensionMeta(extKey);
    if (!byExt.has(extKey)) {
      byExt.set(extKey, {
        headerLeft: m.headerLeft,
        headerRight: m.headerRight,
        color: m.color,
        extension: extKey,
        legendLabel: m.legendLabel,
        children: [],
        totalSizeBytes: 0,
      });
    }
    const totalBytes = parseSizeToBytes(app.total_size_human);

    const top = (topsByExt.get(extKey) || []).slice().sort((a, b) => b.value - a.value);
    /* 실제 적재·JSON에 있는 파일 행만 표시. 나머지 용량은 한 덩어리 "기타"로 합치지 않음(호버 트리맵 왜곡 방지). */
    byExt.get(extKey).children = top;
    byExt.get(extKey).totalSizeBytes = totalBytes;
  }

  let children = Array.from(byExt.values());
  children.forEach((c) => c.children.sort((a, b) => b.value - a.value));
  children.sort((a, b) => {
    const sa =
      Number.isFinite(Number(a.totalSizeBytes)) && Number(a.totalSizeBytes) > 0
        ? Number(a.totalSizeBytes)
        : a.children.reduce((s, x) => s + x.value, 0);
    const sb =
      Number.isFinite(Number(b.totalSizeBytes)) && Number(b.totalSizeBytes) > 0
        ? Number(b.totalSizeBytes)
        : b.children.reduce((s, x) => s + x.value, 0);
    if (sb !== sa) return sb - sa;
    const ia = EXT_ORDER.indexOf(a.extension);
    const ib = EXT_ORDER.indexOf(b.extension);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  children = children.map((c) => ({
    name: `${c.headerLeft} ${c.headerRight}`.trim(),
    headerLeft: c.headerLeft,
    headerRight: c.headerRight,
    color: c.color,
    extension: c.extension,
    legendLabel: c.legendLabel,
    children: c.children,
    totalSizeBytes: c.totalSizeBytes,
  }));

  const legend = EXT_ORDER.map((ext) => {
    const m = extensionMeta(ext);
    return {
      extension: ext,
      label: m.legendLabel,
      color: m.color,
      active: byExt.has(ext),
    };
  });

  return {
    title: "MY ADOBE FILE DISTRIBUTION",
    scanPath: metadata.scan_target || "",
    scanPathDisplay: shortenPath(metadata.scan_target || "", 42),
    source,
    legend,
    tree: { name: "root", children },
  };
}

function buildTreemapPayload(rows, metadata, source) {
  const byExt = new Map();
  for (const r of rows) {
    const extKey = String(r.extension || "").toLowerCase() || ".unknown";
    const m = extensionMeta(extKey);
    if (!byExt.has(extKey)) {
      byExt.set(extKey, {
        headerLeft: m.headerLeft,
        headerRight: m.headerRight,
        color: m.color,
        extension: extKey,
        legendLabel: m.legendLabel,
        children: [],
      });
    }
    const sb =
      r.size_bytes != null && r.size_bytes !== ""
        ? Number(r.size_bytes)
        : parseSizeToBytes(r.size_human);
    const v = Math.max(1, Number.isFinite(sb) ? sb : 0);
    byExt.get(extKey).children.push({
      name: r.filename,
      value: v,
      size_human: r.size_human,
      extension: extKey,
    });
  }

  let children = Array.from(byExt.values());
  children.forEach((c) => c.children.sort((a, b) => b.value - a.value));
  children.sort((a, b) => {
    const sa = a.children.reduce((s, x) => s + x.value, 0);
    const sb = b.children.reduce((s, x) => s + x.value, 0);
    if (sb !== sa) return sb - sa;
    const ia = EXT_ORDER.indexOf(a.extension);
    const ib = EXT_ORDER.indexOf(b.extension);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  children = children.map((c) => ({
    name: `${c.headerLeft} ${c.headerRight}`.trim(),
    headerLeft: c.headerLeft,
    headerRight: c.headerRight,
    color: c.color,
    extension: c.extension,
    legendLabel: c.legendLabel,
    children: c.children,
  }));

  const legend = EXT_ORDER.map((ext) => {
    const m = extensionMeta(ext);
    return {
      extension: ext,
      label: m.legendLabel,
      color: m.color,
      active: byExt.has(ext),
    };
  });

  return {
    title: "MY ADOBE FILE DISTRIBUTION",
    scanPath: metadata.scan_target || "",
    scanPathDisplay: shortenPath(metadata.scan_target || "", 42),
    source,
    legend,
    tree: { name: "root", children },
  };
}

function tryReadAppStatsFromDbSync() {
  const pgUser = process.env.POSTGRES_USER || "infovi";
  const pgDb = process.env.POSTGRES_DB || "infovi_viz";
  const sql = `SELECT COALESCE(
  (SELECT json_agg(row_to_json(t))
   FROM (
     SELECT rank, app_name, extension, file_count, total_size_human, average_size_human
     FROM adobe_app_stats
     ORDER BY rank ASC NULLS LAST, app_name
   ) t),
  '[]'::json
);`;
  const out = execSync(
    `docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U "${pgUser}" -d "${pgDb}" -v ON_ERROR_STOP=1 -t -A`,
    { cwd: ROOT, input: `${sql}\n`, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }
  );
  const trimmed = out.trim();
  if (!trimmed || trimmed === "null") return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [];
}

function tryReadTopFilesFromDbSync() {
  const pgUser = process.env.POSTGRES_USER || "infovi";
  const pgDb = process.env.POSTGRES_DB || "infovi_viz";
  const sql = `SELECT COALESCE(
  (SELECT json_agg(row_to_json(t))
   FROM (
     SELECT app_name, extension, filename, file_path, size_human, size_bytes::float8 AS size_bytes
     FROM adobe_top_files
     ORDER BY extension, size_bytes DESC NULLS LAST, filename
   ) t),
  '[]'::json
);`;
  const out = execSync(
    `docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U "${pgUser}" -d "${pgDb}" -v ON_ERROR_STOP=1 -t -A`,
    { cwd: ROOT, input: `${sql}\n`, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  const trimmed = out.trim();
  if (!trimmed || trimmed === "null") return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [];
}

async function getTreemapPayload() {
  let docMeta = {};
  try {
    docMeta = readAdobeJson().metadata || {};
  } catch {
    docMeta = {};
  }

  let rows = null;
  let apps = null;
  let source = "json";

  if (await dockerAvailable()) {
    try {
      const fromDb = tryReadTopFilesFromDbSync();
      const fromDbApps = tryReadAppStatsFromDbSync();
      if (fromDb.length > 0) {
        rows = fromDb;
        apps = fromDbApps && fromDbApps.length ? fromDbApps : null;
        source = "db";
      }
    } catch {
      /* 컨테이너/테이블 없음 */
    }
  }

  if (!rows) {
    const doc = readAdobeJson();
    docMeta = doc.metadata || {};
    rows = rowsFromJsonDoc(doc);
    apps = Array.isArray(doc.apps) ? doc.apps : null;
    source = "json";
  }

  /* DB에 top_files만 있고 app_stats가 비어 있으면 총용량/파일수는 JSON의 apps로 보강 */
  if (rows && (!apps || !apps.length)) {
    try {
      const doc = readAdobeJson();
      if (Array.isArray(doc.apps) && doc.apps.length) apps = doc.apps;
    } catch {
      /* ignore */
    }
  }

  if (apps && apps.length) {
    return buildTreemapPayloadFromApps(apps, rows, docMeta, source);
  }
  return buildTreemapPayload(rows, docMeta, source);
}

async function importAdobeJsonToDb() {
  const doc = readAdobeJson();
  const apps = Array.isArray(doc.apps) ? doc.apps : [];
  const pgUser = process.env.POSTGRES_USER || "infovi";
  const pgDb = process.env.POSTGRES_DB || "infovi_viz";
  const tempSqlPath = path.join(ROOT, ".tmp_adobe_import.sql");

  const lines = [];
  lines.push("BEGIN;");
  lines.push(`
CREATE TABLE IF NOT EXISTS adobe_app_stats (
  id SERIAL PRIMARY KEY,
  rank INT,
  app_name TEXT NOT NULL,
  extension TEXT,
  file_count INT,
  total_size_human TEXT,
  average_size_human TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`);
  lines.push(`
CREATE TABLE IF NOT EXISTS adobe_top_files (
  id SERIAL PRIMARY KEY,
  app_name TEXT NOT NULL,
  extension TEXT,
  filename TEXT,
  file_path TEXT,
  size_human TEXT,
  size_bytes BIGINT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`);
  lines.push("TRUNCATE TABLE adobe_app_stats;");
  lines.push("TRUNCATE TABLE adobe_top_files;");

  for (const app of apps) {
    lines.push(
      `INSERT INTO adobe_app_stats (rank, app_name, extension, file_count, total_size_human, average_size_human) VALUES (${Number(app.rank) || 0}, ${sqlString(app.app_name)}, ${sqlString(app.extension)}, ${Number(app.file_count) || 0}, ${sqlString(app.total_size_human)}, ${sqlString(app.average_size_human)});`
    );
    const top = Array.isArray(app.top10_by_size) ? app.top10_by_size : [];
    for (const f of top) {
      lines.push(
        `INSERT INTO adobe_top_files (app_name, extension, filename, file_path, size_human, size_bytes) VALUES (${sqlString(app.app_name)}, ${sqlString(app.extension)}, ${sqlString(f.filename)}, ${sqlString(f.path)}, ${sqlString(f.size_human)}, ${parseSizeToBytes(f.size_human)});`
      );
    }
  }
  lines.push("COMMIT;");

  fs.writeFileSync(tempSqlPath, lines.join("\n"), "utf8");
  try {
    await runDocker(
      `compose -f "${COMPOSE_FILE}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "${pgUser}" -d "${pgDb}" < "${tempSqlPath}"`
    );
  } finally {
    try {
      fs.unlinkSync(tempSqlPath);
    } catch {
      /* ignore */
    }
  }

  return {
    importedApps: apps.length,
    importedTopFiles: apps.reduce((acc, app) => {
      const top = Array.isArray(app.top10_by_size) ? app.top10_by_size.length : 0;
      return acc + top;
    }, 0),
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const docker = await dockerAvailable();
    return json(res, 200, { ok: true, docker });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      postgresPort: process.env.POSTGRES_PORT || "5432",
      adminerPort: process.env.ADMINER_PORT || "8080",
      postgresUser: process.env.POSTGRES_USER || "infovi",
      postgresDb: process.env.POSTGRES_DB || "infovi_viz",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/treemap-data") {
    try {
      const data = await getTreemapPayload();
      return json(res, 200, data, {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      });
    } catch (e) {
      return json(res, 500, { error: e.message || String(e) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/source") {
    try {
      const st = fs.statSync(ADOBE_JSON_PATH);
      const doc = readAdobeJson();
      const totalApps =
        doc &&
        doc.summary &&
        Number.isFinite(Number(doc.summary.total_adobe_apps_found))
          ? Number(doc.summary.total_adobe_apps_found)
          : Array.isArray(doc.apps)
            ? doc.apps.length
            : 0;
      return json(res, 200, {
        ok: true,
        path: ADOBE_JSON_PATH,
        bytes: st.size,
        totalApps,
      });
    } catch (e) {
      return json(res, 200, {
        ok: false,
        path: ADOBE_JSON_PATH,
        message: e.message || String(e),
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const docker = await dockerAvailable();
    if (!docker) {
      return json(res, 200, {
        docker: false,
        compose: null,
        message:
          "Docker가 설치되어 있지 않거나 실행 중이 아닙니다. Docker Desktop을 켠 뒤 다시 시도하세요.",
      });
    }
    const ps = await composePs();
    if (ps && ps.error) {
      return json(res, 200, {
        docker: true,
        compose: null,
        message: ps.error,
      });
    }
    return json(res, 200, { docker: true, compose: ps });
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    const docker = await dockerAvailable();
    if (!docker) {
      return json(res, 503, {
        ok: false,
        message: "Docker를 사용할 수 없습니다.",
      });
    }
    try {
      await runDocker(`compose -f "${COMPOSE_FILE}" up -d`);
      const ps = await composePs();
      return json(res, 200, { ok: true, compose: Array.isArray(ps) ? ps : [] });
    } catch (e) {
      return json(res, 500, {
        ok: false,
        message: (e.stderr || e.message || String(e)).trim(),
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const docker = await dockerAvailable();
    if (!docker) {
      return json(res, 503, {
        ok: false,
        message: "Docker를 사용할 수 없습니다.",
      });
    }
    try {
      let remove = false;
      try {
        const body = await parseBody(req);
        remove = Boolean(body.removeVolumes);
      } catch {
        /* 본문 없음 */
      }
      const volFlag = remove ? " -v" : "";
      await runDocker(`compose -f "${COMPOSE_FILE}" down${volFlag}`);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, {
        ok: false,
        message: (e.stderr || e.message || String(e)).trim(),
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/import-adobe") {
    const docker = await dockerAvailable();
    if (!docker) {
      return json(res, 503, {
        ok: false,
        message: "Docker를 사용할 수 없습니다.",
      });
    }
    try {
      const result = await importAdobeJsonToDb();
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 500, {
        ok: false,
        message: (e.stderr || e.message || String(e)).trim(),
      });
    }
  }

  return json(res, 404, { error: "not found" });
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === "/" ? "/treemap.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(PUBLIC, filePath);
  if (!abs.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(abs);
    const type = MIME[ext] || "application/octet-stream";
    const headers = { "Content-Type": type };
    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["Cache-Control"] = "no-cache, must-revalidate";
    }
    res.writeHead(200, headers);
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      json(res, 500, { error: e.message || String(e) });
    }
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`트리맵(기본): http://127.0.0.1:${PORT}/`);
  console.log(`DB 콘솔:      http://127.0.0.1:${PORT}/console.html`);
});
