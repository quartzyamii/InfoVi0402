/* global d3 */

const tmTitle = document.getElementById("tmTitle");
const tmSub = document.getElementById("tmSub");
const tmLegend = document.getElementById("tmLegend");
const tmSvg = document.getElementById("tmSvg");
const tmStatus = document.getElementById("tmStatus");
const tmChart = document.getElementById("tmChart");

const HDR = 26;
const GUTTER_OUTER = 14; // 종이 '절지' 느낌: 큰 구획선
const GUTTER_INNER = 8;
const LEAF_GUTTER = 0;
/** 작은 범주(AE·InDesign 등)가 비율상 너무 얇게 사라지지 않도록 바깥 트리맵 최소 몫 */
const MIN_CAT_SHARE = 0.024;
/** SVG 경계에서 stroke·큰 글자가 잘리지 않도록 안쪽 레이아웃 영역만 사용 */
const SVG_EDGE_INSET = 8;
/** 용량 배지: 캔버스·SVG 렌더 차이·잘림 방지 — 이 픽셀만큼 일찍 둘 줄로 전환 */
const CAP_BADGE_SPLIT_SLOP_PX = 12;

function bytesToHuman(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${Math.round(b / (1024 * 1024))} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${Math.max(0, Math.round(b))} B`;
}

/** "312.68 MB" → 숫자 / 단위 (줄 나눌 때만 사용, M·B 분리 방지) */
function splitHumanSizeForBadge(s) {
  const t = String(s || "").trim();
  const i = t.lastIndexOf(" ");
  if (i <= 0) return { num: t, unit: "" };
  return { num: t.slice(0, i).trim(), unit: t.slice(i + 1).trim() };
}

/** 호버 타일 용량 라벨: 한 줄이 안 되면 숫자 줄 + 단위 줄 (M/B 분리 방지) */
function layoutSizeLinesForLeaf(szLabel, maxW, measureSz) {
  const t = String(szLabel || "").trim();
  if (!t) return [];
  const { num, unit } = splitHumanSizeForBadge(t);
  if (!unit) {
    let lines = wrapTextToLinesUnlimited(t, maxW, measureSz);
    lines = fitLinesWithCap(lines, 2, maxW, measureSz);
    return lines;
  }
  const single = `${num} ${unit}`.replace(/\s+/, "\u00A0");
  const singleW = measureSz(single);
  if (singleW <= maxW + 6) return [single];
  const wN = measureSz(num);
  const wU = measureSz(unit);
  if (wN <= maxW + 6 && wU <= maxW + 6) return [num, unit];
  return [num, unit];
}

function setStatus(text, isErr) {
  tmStatus.textContent = text || "";
  tmStatus.className = "tm-status" + (isErr ? " err" : "");
}

function legColor(hex) {
  const c = d3.rgb(hex);
  return d3.rgb(c.r * 0.52, c.g * 0.52, c.b * 0.52);
}

// 앱 구역 배경(단색, 약간 어둡게)
function leafFillSimilar(hex) {
  try {
    const mix = d3.interpolateRgb(hex, "#000000")(0.22);
    return d3.rgb(mix).formatRgb();
  } catch {
    return "#374151";
  }
}

/**
 * 한 파일 타일 = 단색. 같은 앱 내에서 용량이 작을수록 명도↓, 클수록 명도↑
 * @param {string} hex - 앱 베이스 색
 * @param {number} value - 파일 바이트(value)
 * @param {number[]} valuesInCategory - 해당 앱의 모든 파일 value 목록
 */
function leafFillByValue(hex, value, valuesInCategory, extKey) {
  const vals = (valuesInCategory || []).filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) return leafFillSimilar(hex);
  const min = d3.min(vals);
  const max = d3.max(vals);
  const v = Number(value) || 0;
  let t;
  if (max <= min) t = 1;
  else t = Math.max(0, Math.min(1, (v - min) / (max - min)));

  try {
    const src = d3.hsl(hex);
    const h = src.h;
    const s = Math.min(1, (Number.isFinite(src.s) ? src.s : 0.65) * 1.02);
    /* 베이스 색 톤은 유지하되, 전체 명도는 내려서 눈에 부담 덜 가게 */
    const baseL = Number.isFinite(src.l) ? src.l : 0.5;
    const spread = 0.055;
    let l = baseL + (t - 0.5) * spread;
    l = 0.58 * l + 0.13;
    const ext = String(extKey || "").toLowerCase();
    const liftAeIndesign = ext === ".aep" || ext === ".indd" || ext === ".idml";
    if (liftAeIndesign) {
      l += 0.07;
    }
    const lCap = liftAeIndesign ? 0.78 : 0.7;
    l = Math.max(0.12, Math.min(lCap, l));
    return d3.hsl(h, s, l).rgb().formatRgb();
  } catch {
    return leafFillSimilar(hex);
  }
}

function leafStrokeSimilar(hex) {
  try {
    const mix = d3.interpolateRgb(hex, "#ffffff")(0.18);
    const rgb = d3.rgb(mix);
    return `rgba(${rgb.r},${rgb.g},${rgb.b},0.55)`;
  } catch {
    return "rgba(255,255,255,0.22)";
  }
}

function textColorForBase(hex, alpha = 0.92) {
  try {
    const h = d3.hsl(hex);
    // 앱별 색상차를 더 크게: 채도 강화 + 밝기만 가독성 수준으로 보정
    const sat = Math.min(1, h.s * 1.55 + 0.16);
    const lit = Math.min(0.88, Math.max(0.66, 0.6 + h.l * 0.34));
    const rgb = d3.hsl(h.h, sat, lit).rgb();
    return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
  } catch {
    return `rgba(255,245,205,${alpha})`;
  }
}

function fontSizeForRect(w, h, base) {
  const a = Math.sqrt(Math.max(0, w * h));
  return Math.max(7, Math.min(base, 0.035 * a + 6));
}

const BYTES_1MB = 1024 * 1024;
const BYTES_10MB = 10 * BYTES_1MB;

function isCapacityMidRange(bytes) {
  const b = Number(bytes) || 0;
  return b >= BYTES_1MB && b <= BYTES_10MB;
}

/** 용량 라벨: 1~10MB는 기존 작은 크기 유지, 그 외는 타일·화면 점유 비율로 크게 */
function fontSizeForCapacity(lw, lh, chartW, chartH, fsName, bytes) {
  const baseline = Math.max(7, fsName - 2);
  if (isCapacityMidRange(bytes)) return baseline;
  const a = Math.sqrt(Math.max(0, lw * lh));
  const chartArea = Math.max(1, chartW * chartH);
  const share = (lw * lh) / chartArea;
  const fromTile = 0.064 * a + 11 + share * 118;
  return Math.round(Math.min(48, Math.max(baseline + 8, fromTile)));
}

function splitGraphemes(text) {
  try {
    return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)].map(
      (x) => x.segment
    );
  } catch {
    return Array.from(text);
  }
}

function makeTextMeasurer(fontSize, fontWeight) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontWeight} ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  return (s) => ctx.measureText(s || "").width;
}

function wrapTextToLinesUnlimited(text, maxWidth, measure) {
  if (!text) return [];
  const gms = splitGraphemes(text);
  const lines = [];
  let line = "";
  for (const gm of gms) {
    const test = line + gm;
    if (measure(test) <= maxWidth) line = test;
    else {
      if (line) lines.push(line);
      line = gm;
      if (measure(line) > maxWidth) {
        lines.push(line);
        line = "";
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitLinesWithCap(lines, maxLines, maxWidth, measure) {
  if (lines.length <= maxLines) return lines;
  const head = lines.slice(0, maxLines - 1);
  const tailGms = splitGraphemes(lines.slice(maxLines - 1).join(""));
  const ell = "…";
  while (tailGms.length && measure(tailGms.join("") + ell) > maxWidth) tailGms.pop();
  const tail = tailGms.length ? tailGms.join("") + ell : ell;
  head.push(tail);
  return head;
}

/** 타일 높이·너비 안에 제목+용량이 들어가는지 검사하며 용량 폰트 시도 */
function layoutLeafText(title, szLabel, maxW, lh, fsName, fsSzTry) {
  const lineHeightName = fsName * 1.2;
  const measureName = makeTextMeasurer(fsName, 600);
  const measureSz = makeTextMeasurer(fsSzTry, 500);
  const lineHeightSz = fsSzTry * 1.15;

  let sizeLines = [];
  if (szLabel) {
    sizeLines = layoutSizeLinesForLeaf(szLabel, maxW, measureSz);
  }
  const sizeBlockH = sizeLines.length ? sizeLines.length * lineHeightSz + 6 : 6;
  const widthOk = !szLabel || sizeLines.every((ln) => measureSz(ln) <= maxW + 1);

  const maxTitleLines = Math.max(1, Math.floor((lh - 10 - sizeBlockH) / lineHeightName));
  let titleLines = [];
  if (title) {
    titleLines = wrapTextToLinesUnlimited(title, maxW, measureName);
    titleLines = fitLinesWithCap(titleLines, maxTitleLines, maxW, measureName);
  }
  const titleBlockH = titleLines.length ? titleLines.length * lineHeightName + 6 : 0;
  const ok = widthOk && titleBlockH + sizeBlockH <= lh - 8;
  return { ok, sizeLines, titleLines, lineHeightSz, fsSz: fsSzTry };
}

function appendWrappedLabel(g, lines, x, yStart, lineHeight, attrs) {
  const tg = g.append("g").attr("class", "tm-label");
  lines.forEach((ln, i) => {
    tg.append("text")
      .attr("x", x)
      .attr("y", yStart + i * lineHeight)
      .attr("fill", attrs.fill)
      .attr("font-size", attrs.fontSize)
      .attr("font-weight", attrs.fontWeight)
      .attr("font-family", "inherit")
      .attr("text-anchor", attrs.anchor || "start")
      .text(ln);
  });
}

/** 호버 전 박스 좌하단 앱 마크 (Ai / Ps / PDF / Id / Ae …) */
function appBadgeShort(ext, headerRight) {
  const e = String(ext || "").toLowerCase();
  const key = e.startsWith(".") ? e : `.${e}`;
  const map = {
    ".ai": "Ai",
    ".psd": "Ps",
    ".pdf": "PDF",
    ".indd": "Id",
    ".aep": "Ae",
    ".idml": "Idml",
  };
  if (map[key]) return map[key];
  const hr = String(headerRight || "").replace(/^\s*/, "");
  if (hr && /^\.[a-z0-9]+$/i.test(hr)) {
    const kk = hr.toLowerCase();
    if (map[kk]) return map[kk];
  }
  return hr ? String(hr).replace(/^\./, "").slice(0, 4).toUpperCase() : "?";
}

function badgeTextBrighterThanBox(base) {
  try {
    const boxRgb = d3.rgb(leafFillSimilar(base));
    const boxH = d3.hsl(boxRgb);
    const boxL = Number.isFinite(boxH.l) ? boxH.l : 0.22;
    const brand = d3.hsl(base);
    const h = Number.isFinite(brand.h) ? brand.h : boxH.h;
    const s = Math.min(1, (Number.isFinite(brand.s) ? brand.s : 0.55) * 0.92 + 0.06);
    const lift = 0.3;
    const l = Math.min(0.93, Math.max(boxL + lift, 0.7));
    return d3.hsl(h, s, l).rgb().formatRgb();
  } catch {
    return "#f0f4f8";
  }
}

function appendCategoryAppBadge(g, d, base, x0, y0, bw, bh) {
  const innerBodyH = bh - HDR;
  if (innerBodyH < 22 || bw < 36) return;

  const label = appBadgeShort(d.extension, d.headerRight);
  const files = d.files || [];
  const totalFromMeta = Number(d.totalSizeBytes);
  const totalBytes =
    Number.isFinite(totalFromMeta) && totalFromMeta > 0
      ? totalFromMeta
      : d3.sum(files, (f) => Number(f.value) || 0);
  const totalStr = bytesToHuman(totalBytes);

  const bodyArea = Math.max(1, bw * innerBodyH);
  const shortSide = Math.min(bw, innerBodyH);
  /* 박스가 클수록 훨씬 크게: 면적 루트 + 짧은 변 상한 */
  let badgeFs = 0.092 * Math.sqrt(bodyArea) + 9;
  badgeFs = Math.min(badgeFs, shortSide * 0.42);
  badgeFs = Math.max(12, Math.min(64, badgeFs));
  if (label.length >= 5) badgeFs *= 0.76;
  else if (label.length >= 4) badgeFs *= 0.84;
  else if (label.length >= 3) badgeFs *= 0.9;

  const extNorm = String(d.extension || "").toLowerCase();
  const extMult =
    extNorm === ".ai" || extNorm === "ai"
      ? 3
      : extNorm === ".psd" || extNorm === "psd"
        ? 2
        : 1;
  if (extMult !== 1) badgeFs *= extMult;

  const charW =
    label === "PDF" || label === "Idml" ? 0.58 : label.length <= 2 ? 0.6 : label.length === 3 ? 0.56 : 0.54;
  const approxW = label.length * badgeFs * charW;
  const maxW = Math.max(28, bw - 24);
  if (approxW > maxW) badgeFs *= maxW / approxW;
  /* 세로로 박스를 넘지 않게 */
  badgeFs = Math.min(badgeFs, innerBodyH * 0.62);
  badgeFs = Math.max(12, badgeFs);

  const margin = Math.round(Math.max(8, Math.min(16, 8 + shortSide * 0.04)));
  const gapMid = Math.max(10, margin * 0.75);
  const charWTotal = 0.56;
  const { num: capNum, unit: capUnit } = splitHumanSizeForBadge(totalStr);
  const wTwoLine = capUnit
    ? Math.max(capNum.length, capUnit.length) * badgeFs * charWTotal
    : 0;
  let wLeft = label.length * badgeFs * charW;
  let wRight = Math.max(totalStr.length * badgeFs * charWTotal, wTwoLine);
  const need = wLeft + wRight + 2 * margin + gapMid;
  if (need > bw && need > 0) {
    badgeFs *= bw / need;
    wLeft = label.length * badgeFs * charW;
    wRight = Math.max(
      totalStr.length * badgeFs * charWTotal,
      capUnit ? Math.max(capNum.length, capUnit.length) * badgeFs * charWTotal : 0
    );
  }
  badgeFs = Math.max(10, Math.min(badgeFs, innerBodyH * 0.62));

  const measureLbl = makeTextMeasurer(badgeFs, 800);
  const measureCap = makeTextMeasurer(badgeFs, 700);
  const labelW = measureLbl(label);
  const capSlotW = Math.max(8, bw - 2 * margin - gapMid - labelW);
  const oneLineCapW = measureCap(totalStr);
  let useSplitCap = Boolean(
    capUnit && oneLineCapW > capSlotW - CAP_BADGE_SPLIT_SLOP_PX
  );
  if (useSplitCap) {
    const twoNeedW = Math.max(measureCap(capNum), measureCap(capUnit));
    if (twoNeedW > capSlotW && capSlotW > 0) {
      badgeFs = Math.max(10, badgeFs * (capSlotW / twoNeedW));
    }
  }

  if (useSplitCap) {
    const blockH = badgeFs * 2.18;
    const bottomY = y0 + bh - margin;
    if (bottomY - blockH < y0 + HDR + 2) {
      const scale = Math.max(0.55, (bottomY - (y0 + HDR + 2)) / blockH);
      badgeFs = Math.max(10, badgeFs * scale);
    }
  }

  const measureCapFinal = makeTextMeasurer(badgeFs, 700);
  const measureLblFinal = makeTextMeasurer(badgeFs, 800);
  const capSlotFinal = Math.max(8, bw - 2 * margin - gapMid - measureLblFinal(label));
  const oneLineFinalW = measureCapFinal(totalStr);
  useSplitCap = Boolean(
    capUnit && oneLineFinalW > capSlotFinal - CAP_BADGE_SPLIT_SLOP_PX
  );

  const fillBadge = badgeTextBrighterThanBox(base);
  const badgeG = g.append("g").attr("class", "tm-app-badge");
  const capFont = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

  badgeG
    .append("text")
    .attr("x", x0 + margin)
    .attr("y", y0 + bh - margin)
    .attr("fill", fillBadge)
    .attr("font-size", badgeFs)
    .attr("font-weight", 800)
    .attr("font-family", capFont)
    .attr("dominant-baseline", "alphabetic")
    .text(label);

  const capX = x0 + bw - margin;
  const bottomY = y0 + bh - margin;
  const lineStep = badgeFs * 1.14;

  if (useSplitCap && capUnit) {
    badgeG
      .append("text")
      .attr("x", capX)
      .attr("y", bottomY)
      .attr("text-anchor", "end")
      .attr("fill", fillBadge)
      .attr("font-size", badgeFs)
      .attr("font-weight", 700)
      .attr("font-family", capFont)
      .attr("dominant-baseline", "alphabetic")
      .text(capUnit);
    badgeG
      .append("text")
      .attr("x", capX)
      .attr("y", bottomY - lineStep)
      .attr("text-anchor", "end")
      .attr("fill", fillBadge)
      .attr("font-size", badgeFs)
      .attr("font-weight", 700)
      .attr("font-family", capFont)
      .attr("dominant-baseline", "alphabetic")
      .text(capNum);
  } else {
    const oneLineNbsp = totalStr.includes(" ")
      ? totalStr.replace(/\s+/, "\u00A0")
      : totalStr;
    badgeG
      .append("text")
      .attr("x", capX)
      .attr("y", bottomY)
      .attr("text-anchor", "end")
      .attr("fill", fillBadge)
      .attr("font-size", badgeFs)
      .attr("font-weight", 700)
      .attr("font-family", capFont)
      .attr("dominant-baseline", "alphabetic")
      .style("white-space", "nowrap")
      .text(oneLineNbsp);
  }
}

/** 앱 블록 안(헤더 아래)에 파일 단위 트리맵 — 좌표는 전체 SVG 기준 */
function renderInnerFilesTreemap(gSel, cat, base, x0, yHdr, innerW, innerH, chartW, chartH) {
  const files = cat.files || [];
  if (innerH < 6 || !files.length) return;

  const fileValues = files.map((f) => Number(f.value) || 0);
  const fh = d3
    .hierarchy({
      name: "g",
      children: files.map((f) => ({
        name: f.name,
        value: f.value,
        size_human: f.size_human,
      })),
    })
    .sum((x) => x.value || 0);

  d3
    .treemap()
    .tile(d3.treemapSquarify)
    .size([innerW, innerH])
    .paddingOuter(LEAF_GUTTER)
    .paddingInner(LEAF_GUTTER)
    .round(true)(fh);

  for (const leaf of fh.leaves()) {
    const lx0 = leaf.x0 + x0;
    const ly0 = leaf.y0 + yHdr;
    const lx1 = leaf.x1 + x0;
    const ly1 = leaf.y1 + yHdr;
    const lw = lx1 - lx0;
    const lh = ly1 - ly0;
    if (lw < 1.5 || lh < 1.5) continue;

    gSel
      .append("rect")
      .attr("x", lx0)
      .attr("y", ly0)
      .attr("width", lw)
      .attr("height", lh)
      .attr("fill", leafFillByValue(base, leaf.data.value, fileValues, cat.extension))
      .attr("stroke", leafStrokeSimilar(base))
      .attr("stroke-width", 1.35);

    const showText = lw >= 44 && lh >= 22;
    if (!showText) continue;

    const fsName = fontSizeForRect(lw, lh, 11.5);
    const padX = 5;
    const maxW = Math.max(12, lw - padX * 2);

    const title = String(leaf.data.name || "");
    const szLabel = String(leaf.data.size_human || "");
    const fileBytes = Number(leaf.data.value) || 0;

    const ABS_MIN_SZ = 5;
    const preferredStart = isCapacityMidRange(fileBytes)
      ? Math.max(ABS_MIN_SZ, fsName - 2)
      : Math.floor(fontSizeForCapacity(lw, lh, chartW, chartH, fsName, fileBytes));

    let fsSz = preferredStart;
    let fitted = null;
    for (let tryFs = preferredStart; tryFs >= ABS_MIN_SZ; tryFs--) {
      const L = layoutLeafText(title, szLabel, maxW, lh, fsName, tryFs);
      if (L.ok) {
        fitted = L;
        fsSz = L.fsSz;
        break;
      }
    }
    if (!fitted) {
      fitted = layoutLeafText(title, szLabel, maxW, lh, fsName, ABS_MIN_SZ);
      fsSz = ABS_MIN_SZ;
    }

    const { sizeLines, titleLines, lineHeightSz } = fitted;
    const lineHeightName = fsName * 1.2;

    const titleColor = textColorForBase(base, 0.92);
    if (titleLines.length) {
      appendWrappedLabel(gSel, titleLines, lx0 + padX, ly0 + fsName + 2, lineHeightName, {
        fill: titleColor,
        fontSize: fsName,
        fontWeight: 600,
        anchor: "start",
      });
    }

    if (sizeLines.length) {
      sizeLines.forEach((ln, i) => {
        const fromBottom = sizeLines.length - 1 - i;
        gSel
          .append("text")
          .attr("x", lx1 - padX)
          .attr("y", ly1 - 5 - fromBottom * lineHeightSz)
          .attr("text-anchor", "end")
          .attr("fill", textColorForBase(base, 0.88))
          .attr("font-size", fsSz)
          .attr("font-weight", 500)
          .attr("font-family", "inherit")
          .style("white-space", "nowrap")
          .text(ln);
      });
    }
  }
}

function hideAllCategoryDetails() {
  d3.selectAll(".tm-cat-detail").interrupt();
  d3.selectAll(".tm-cat-detail").attr("opacity", 0);
  d3.selectAll(".tm-cat-detail").selectAll("*").remove();
}

function renderLegend(legend) {
  tmLegend.innerHTML = "";
  for (const item of legend || []) {
    const div = document.createElement("div");
    div.className = "tm-leg-item" + (item.active ? "" : " inactive");
    const sw = document.createElement("span");
    sw.className = "tm-swatch";
    sw.style.background = item.color;
    const lab = document.createElement("span");
    lab.textContent = item.label;
    if (item && item.color) lab.style.color = textColorForBase(item.color, 0.92);
    div.appendChild(sw);
    div.appendChild(lab);
    tmLegend.appendChild(div);
  }
}

function renderTreemap(data) {
  hideAllCategoryDetails();
  const W = tmChart.clientWidth || tmSvg.clientWidth || 900;
  const H = Math.max(480, window.innerHeight - tmChart.getBoundingClientRect().top - 40);
  const layW = Math.max(1, W - 2 * SVG_EDGE_INSET);
  const layH = Math.max(1, H - 2 * SVG_EDGE_INSET);

  tmSvg.setAttribute("width", W);
  tmSvg.setAttribute("height", H);
  tmSvg.innerHTML = "";

  const cats = data.tree && Array.isArray(data.tree.children) ? data.tree.children : [];
  if (!cats.length) {
    setStatus("표시할 데이터가 없습니다. JSON 경로와 DB 적재 여부를 확인하세요.", true);
    return;
  }

  const sums = cats.map((cat) => {
    const t = Number(cat.totalSizeBytes);
    if (Number.isFinite(t) && t > 0) return t;
    return (cat.children || []).reduce((s, f) => s + (f.value || 0), 0);
  });
  const globalTotal = d3.sum(sums) || 1;
  const rootCats = d3
    .hierarchy({
      name: "root",
      children: cats.map((cat, i) => ({
        headerLeft: cat.headerLeft,
        headerRight: cat.headerRight,
        color: cat.color,
        extension: cat.extension,
        totalSizeBytes: cat.totalSizeBytes,
        files: cat.children || [],
        value: Math.max(sums[i] || 0, globalTotal * MIN_CAT_SHARE),
      })),
    })
    .sum((d) => d.value || 0);

  d3
    .treemap()
    .tile(d3.treemapSquarify)
    .size([layW, layH])
    .paddingOuter(GUTTER_OUTER)
    .paddingInner(GUTTER_INNER)
    .round(true)(rootCats);

  const g = d3
    .select(tmSvg)
    .append("g")
    .attr("class", "tm-root")
    .attr("transform", `translate(${SVG_EDGE_INSET},${SVG_EDGE_INSET})`);
  const defs = g.append("defs");

  const catNodes = rootCats.children || [];
  catNodes.forEach((cell, i) => {
    const x0 = cell.x0;
    const y0 = cell.y0;
    const x1 = cell.x1;
    const y1 = cell.y1;
    const bw = x1 - x0;
    const bh = y1 - y0;
    const d = cell.data;
    const base = d.color || "#666";
    const innerW = bw;
    const innerH = Math.max(0, bh - HDR);
    const yHdr = y0 + HDR;
    const clipId = `tmCatClip${i}`;

    defs
      .append("clipPath")
      .attr("id", clipId)
      .append("rect")
      .attr("x", x0)
      .attr("y", yHdr)
      /* stroke·우측 정렬 라벨 글리프가 경계에서 안 잘리도록 소폭 여유 */
      .attr("width", innerW + 3)
      .attr("height", innerH + 2);

    g.append("rect")
      .attr("x", x0)
      .attr("y", y0)
      .attr("width", bw)
      .attr("height", bh)
      .attr("fill", leafFillSimilar(base))
      .attr("stroke", "rgba(255,255,255,0.10)")
      .attr("stroke-width", 2);

    appendCategoryAppBadge(g, d, base, x0, y0, bw, bh);

    const detailG = g
      .append("g")
      .attr("class", "tm-cat-detail")
      .attr("clip-path", `url(#${clipId})`)
      .attr("opacity", 0)
      .style("pointer-events", "none")
      .style("will-change", "opacity");

    const headFill = legColor(base);
    g.append("rect")
      .attr("x", x0)
      .attr("y", y0)
      .attr("width", bw)
      .attr("height", HDR)
      .attr("fill", headFill)
      .attr("stroke", "rgba(0,0,0,0.35)")
      .attr("stroke-width", 1);

    const tSize = Math.min(12, Math.max(9, HDR * 0.42));
    g.append("text")
      .attr("x", x0 + 8)
      .attr("y", y0 + HDR * 0.68)
      .attr("fill", textColorForBase(base, 0.98))
      .attr("font-size", tSize)
      .attr("font-weight", 700)
      .attr("font-family", "inherit")
      .text(d.headerLeft || "");

    g.append("text")
      .attr("x", x0 + bw - 8)
      .attr("y", y0 + HDR * 0.68)
      .attr("text-anchor", "end")
      .attr("fill", textColorForBase(base, 0.95))
      .attr("font-size", tSize)
      .attr("font-weight", 600)
      .attr("font-family", "inherit")
      .text(d.headerRight || "");

    g.append("rect")
      .attr("x", x0)
      .attr("y", y0)
      .attr("width", bw)
      .attr("height", bh)
      .attr("fill", "transparent")
      .style("cursor", "pointer")
      .on("mouseenter", () => {
        if (innerH < 6 || !(d.files || []).length) return;
        hideAllCategoryDetails();
        renderInnerFilesTreemap(detailG, d, base, x0, yHdr, innerW, innerH, W, H);
        detailG.transition().duration(100).ease(d3.easeCubicOut).attr("opacity", 1);
      })
      .on("mouseleave", () => {
        detailG.interrupt();
        detailG
          .transition()
          .duration(75)
          .ease(d3.easeCubicIn)
          .attr("opacity", 0)
          .on("end", () => {
            detailG.selectAll("*").remove();
          });
      });
  });

  setStatus(
    `데이터: ${
      data.source === "db"
        ? "PostgreSQL"
        : data.source === "static"
          ? "정적 treemap-data.json"
          : "JSON 파일"
    } · 항목 ${cats.length}개 범주`,
    false
  );
}

async function fetchTreemapPayload() {
  const apiUrl = new URL("/api/treemap-data", window.location.origin).href;
  try {
    const r = await fetch(`${apiUrl}?_=${Date.now()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (r.ok) {
      const data = await r.json();
      if (!data.error) return data;
    }
  } catch {
    /* 네트워크 또는 GitHub Pages 등 API 없음 */
  }
  const staticUrl = new URL("treemap-data.json", window.location.href).href;
  const r2 = await fetch(`${staticUrl}?_=${Date.now()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!r2.ok) {
    throw new Error(
      "데이터를 불러올 수 없습니다. 로컬에서는 yarn start 후 사용하거나, GitHub Pages에는 public/treemap-data.json을 두세요."
    );
  }
  const data = await r2.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function loadAndDraw() {
  setStatus("데이터 불러오는 중…", false);
  try {
    const data = await fetchTreemapPayload();

    tmTitle.textContent = data.title || "MY ADOBE FILE DISTRIBUTION";
    tmSub.textContent = data.scanPathDisplay || data.scanPath || "";
    renderLegend(data.legend || []);
    renderTreemap(data);
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

let resizeTid = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTid);
  resizeTid = setTimeout(() => loadAndDraw(), 150);
});

loadAndDraw();
