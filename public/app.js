const $ = (id) => document.getElementById(id);

const dockerBadge = $("dockerBadge");
const rows = $("rows");
const msg = $("msg");
const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnRefresh = $("btnRefresh");
const btnImport = $("btnImport");
const chkRemoveVol = $("chkRemoveVol");
const sourcePath = $("sourcePath");

function setMsg(text, type) {
  msg.textContent = text || "";
  msg.className = "msg" + (type ? " " + type : "");
}

function fmtPorts(publishers) {
  if (!publishers || !publishers.length) return "—";
  return publishers
    .map((p) => {
      const host = p.published_port;
      const inner = p.target_port;
      if (host && inner) return `${host}:${inner}`;
      return String(host || inner || "");
    })
    .filter(Boolean)
    .join(", ");
}

function renderRows(list) {
  rows.innerHTML = "";
  if (!list || !list.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="4" class="empty">실행 중인 Compose 서비스가 없습니다. 「스택 시작」을 눌러 주세요.</td>';
    rows.appendChild(tr);
    return;
  }
  for (const s of list) {
    const tr = document.createElement("tr");
    const name = s.Name || s.name || "—";
    const service = s.Service || s.service || "—";
    const state = s.State || s.state || "—";
    const ports = fmtPorts(s.Publishers || s.publishers);
    tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${escapeHtml(service)}</td><td>${escapeHtml(state)}</td><td>${escapeHtml(ports)}</td>`;
    rows.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refresh() {
  setMsg("");
  try {
    const r = await fetch("/api/status");
    const data = await r.json();
    if (!data.docker) {
      dockerBadge.textContent = "Docker 없음";
      dockerBadge.className = "badge badge-warn";
      renderRows([]);
      setMsg(data.message || "Docker를 확인할 수 없습니다.", "err");
      return;
    }
    dockerBadge.textContent = "Docker 준비됨";
    dockerBadge.className = "badge badge-ok";
    if (data.message && !data.compose) {
      setMsg(data.message, "err");
      renderRows([]);
      return;
    }
    renderRows(data.compose || []);
  } catch (e) {
    dockerBadge.textContent = "오류";
    dockerBadge.className = "badge badge-warn";
    setMsg(e.message || String(e), "err");
    renderRows([]);
  }
}

function setLoading(on) {
  btnStart.disabled = on;
  btnStop.disabled = on;
  btnRefresh.disabled = on;
  if (btnImport) btnImport.disabled = on;
}

btnRefresh.addEventListener("click", () => refresh());

btnStart.addEventListener("click", async () => {
  setLoading(true);
  setMsg("스택을 시작하는 중…");
  try {
    const r = await fetch("/api/start", { method: "POST" });
    const data = await r.json();
    if (!data.ok) {
      setMsg(data.message || "시작 실패", "err");
    } else {
      setMsg("시작 요청이 완료되었습니다.", "ok");
      renderRows(data.compose || []);
    }
  } catch (e) {
    setMsg(e.message || String(e), "err");
  } finally {
    setLoading(false);
    await refresh();
  }
});

btnStop.addEventListener("click", async () => {
  setLoading(true);
  const removeVolumes = chkRemoveVol.checked;
  setMsg(removeVolumes ? "볼륨까지 삭제하며 중지하는 중…" : "스택을 중지하는 중…");
  try {
    const r = await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeVolumes }),
    });
    const data = await r.json();
    if (!data.ok) {
      setMsg(data.message || "중지 실패", "err");
    } else {
      setMsg("중지 완료.", "ok");
    }
  } catch (e) {
    setMsg(e.message || String(e), "err");
  } finally {
    setLoading(false);
    await refresh();
  }
});

if (btnImport) {
  btnImport.addEventListener("click", async () => {
    setLoading(true);
    setMsg("JSON 데이터를 PostgreSQL로 적재하는 중…");
    try {
      const r = await fetch("/api/import-adobe", { method: "POST" });
      const data = await r.json();
      if (!data.ok) {
        setMsg(data.message || "적재 실패", "err");
      } else {
        setMsg(
          `적재 완료: 앱 ${data.importedApps}개, 상세 파일 ${data.importedTopFiles}개`,
          "ok"
        );
      }
    } catch (e) {
      setMsg(e.message || String(e), "err");
    } finally {
      setLoading(false);
      await refresh();
    }
  });
}

async function applyConfig() {
  try {
    const r = await fetch("/api/config");
    const c = await r.json();
    const pg = c.postgresPort || "5432";
    const ad = c.adminerPort || "8080";
    const user = c.postgresUser || "infovi";
    const db = c.postgresDb || "infovi_viz";
    const conn = $("connString");
    if (conn) {
      conn.textContent = `postgresql://${user}:<비밀번호>@127.0.0.1:${pg}/${db}`;
    }
    const al = $("adminerLink");
    if (al) {
      al.href = `http://127.0.0.1:${ad}`;
      al.textContent = `http://127.0.0.1:${ad}`;
    }
  } catch {
    /* 기본 HTML 유지 */
  }
}

async function loadSource() {
  if (!sourcePath) return;
  try {
    const r = await fetch("/api/source");
    const data = await r.json();
    if (!data.ok) {
      sourcePath.textContent = `${data.path} (파일 없음)`;
      return;
    }
    sourcePath.textContent = `${data.path} (${data.totalApps}개 앱 데이터)`;
  } catch {
    sourcePath.textContent = "소스 조회 실패";
  }
}

applyConfig();
loadSource();
refresh();
