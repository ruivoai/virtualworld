const planCanvas = document.getElementById("planCanvas");
const heatCanvas = document.getElementById("heatCanvas");
const planCtx = planCanvas.getContext("2d");
const heatCtx = heatCanvas.getContext("2d");
const statsEl = document.getElementById("stats");

let baseImageData = null;
let wallMask = null;

const getNum = (id) => Number(document.getElementById(id).value);

function resizeCanvases(w, h) {
  planCanvas.width = heatCanvas.width = w;
  planCanvas.height = heatCanvas.height = h;
}

function detectWalls(imgData) {
  const { width, height, data } = imgData;
  const mask = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const gray = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
    mask[p] = gray < 105 ? 1 : 0;
  }

  const dilated = new Uint8Array(mask);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      let hits = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) hits += mask[idx + dy * width + dx];
      }
      if (hits >= 4) dilated[idx] = 1;
    }
  }
  return dilated;
}

function lineWallCrossings(x0, y0, x1, y1, width, height, mask) {
  const steps = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 2));
  let wallHits = 0;
  let inWall = false;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.max(0, Math.min(width - 1, Math.floor(x0 + (x1 - x0) * t)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(y0 + (y1 - y0) * t)));
    const isWall = mask[y * width + x] === 1;
    if (isWall && !inWall) wallHits += 1;
    inWall = isWall;
  }

  return wallHits;
}

function predictSignal(ap, point, params, mask, width, height) {
  const dPx = Math.max(1, Math.hypot(ap.x - point.x, ap.y - point.y));
  const dMeters = dPx / params.ppm;
  const fsplBase = 40 + 10 * params.pathLoss * Math.log10(dMeters);
  const wallCount = lineWallCrossings(ap.x, ap.y, point.x, point.y, width, height, mask);
  return params.txPower - fsplBase - wallCount * params.wallLoss;
}

function chooseCandidateAps(mask, width, height, spacingPx) {
  const candidates = [];
  for (let y = spacingPx; y < height - spacingPx; y += spacingPx) {
    for (let x = spacingPx; x < width - spacingPx; x += spacingPx) {
      if (mask[y * width + x] === 0) candidates.push({ x, y });
    }
  }
  return candidates;
}

function designAps(mask, width, height, params) {
  const spacingPx = Math.round(params.apSpacing * params.ppm);
  const sampleStep = Math.max(8, Math.floor(spacingPx / 2));
  const candidates = chooseCandidateAps(mask, width, height, spacingPx);
  const demandPoints = [];

  for (let y = sampleStep; y < height; y += sampleStep) {
    for (let x = sampleStep; x < width; x += sampleStep) {
      if (mask[y * width + x] === 0) demandPoints.push({ x, y });
    }
  }

  const aps = [];
  const covered = new Uint8Array(demandPoints.length);

  while (aps.length < 60) {
    let best = null;
    let bestGain = 0;

    for (const cand of candidates) {
      let gain = 0;
      for (let i = 0; i < demandPoints.length; i++) {
        if (covered[i]) continue;
        const dbm = predictSignal(cand, demandPoints[i], params, mask, width, height);
        if (dbm >= params.targetSignal) gain++;
      }
      if (gain > bestGain) {
        bestGain = gain;
        best = cand;
      }
    }

    if (!best || bestGain < 3) break;

    aps.push(best);
    for (let i = 0; i < demandPoints.length; i++) {
      if (covered[i]) continue;
      if (predictSignal(best, demandPoints[i], params, mask, width, height) >= params.targetSignal) {
        covered[i] = 1;
      }
    }
  }

  return { aps, demandPoints };
}

function assignChannels(aps, params) {
  const channels24 = [1, 6, 11];
  const channels5 = [36, 44, 149, 157];
  const threshold = params.apSpacing * params.ppm * 1.8;

  return aps.map((ap, idx) => {
    const near = aps
      .map((other, j) => ({ j, d: Math.hypot(ap.x - other.x, ap.y - other.y) }))
      .filter((v) => v.j !== idx && v.d < threshold)
      .map((v) => v.j);

    const used24 = new Set(near.map((j) => aps[j].ch24).filter(Boolean));
    const used5 = new Set(near.map((j) => aps[j].ch5).filter(Boolean));

    ap.ch24 = channels24.find((c) => !used24.has(c)) ?? channels24[idx % channels24.length];
    ap.ch5 = channels5.find((c) => !used5.has(c)) ?? channels5[idx % channels5.length];
    return ap;
  });
}

function render(mask, aps, params, width, height) {
  const heatImg = heatCtx.createImageData(width, height);
  const step = 6;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (mask[y * width + x]) continue;
      let best = -120;
      for (const ap of aps) best = Math.max(best, predictSignal(ap, { x, y }, params, mask, width, height));

      const normalized = Math.max(0, Math.min(1, (best + 90) / 45));
      const r = Math.floor(255 * (1 - normalized));
      const g = Math.floor(255 * normalized);
      const b = 80;

      for (let oy = 0; oy < step; oy++) {
        for (let ox = 0; ox < step; ox++) {
          const px = x + ox;
          const py = y + oy;
          if (px >= width || py >= height) continue;
          const i = (py * width + px) * 4;
          heatImg.data[i] = r;
          heatImg.data[i + 1] = g;
          heatImg.data[i + 2] = b;
          heatImg.data[i + 3] = 120;
        }
      }
    }
  }

  heatCtx.putImageData(heatImg, 0, 0);

  planCtx.putImageData(baseImageData, 0, 0);
  planCtx.save();
  planCtx.globalAlpha = 0.25;
  planCtx.fillStyle = "#ff3355";
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (mask[y * width + x]) planCtx.fillRect(x, y, 2, 2);
    }
  }
  planCtx.restore();

  planCtx.font = "12px ui-sans-serif";
  for (let i = 0; i < aps.length; i++) {
    const ap = aps[i];
    planCtx.fillStyle = "#00d9ff";
    planCtx.beginPath();
    planCtx.arc(ap.x, ap.y, 8, 0, Math.PI * 2);
    planCtx.fill();
    planCtx.fillStyle = "#ffffff";
    planCtx.fillText(`#${i + 1} C${ap.ch24}/${ap.ch5}`, ap.x + 10, ap.y - 10);
  }
}

document.getElementById("planUpload").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();

  const maxW = 1400;
  const scale = Math.min(1, maxW / img.width);
  const w = Math.floor(img.width * scale);
  const h = Math.floor(img.height * scale);

  resizeCanvases(w, h);
  planCtx.drawImage(img, 0, 0, w, h);
  baseImageData = planCtx.getImageData(0, 0, w, h);
  wallMask = detectWalls(baseImageData);
  heatCtx.clearRect(0, 0, w, h);

  statsEl.textContent = "Plan loaded. Click Generate Design.";
});

document.getElementById("runBtn").addEventListener("click", () => {
  if (!baseImageData || !wallMask) {
    statsEl.textContent = "Upload a floor plan first.";
    return;
  }

  const params = {
    targetSignal: getNum("targetSignal"),
    txPower: getNum("txPower"),
    pathLoss: getNum("pathLoss"),
    wallLoss: getNum("wallLoss"),
    apSpacing: getNum("apSpacing"),
    ppm: getNum("ppm")
  };

  const { width, height } = baseImageData;
  const { aps, demandPoints } = designAps(wallMask, width, height, params);
  assignChannels(aps, params);
  render(wallMask, aps, params, width, height);

  statsEl.textContent = [
    `AP count: ${aps.length}`,
    `Evaluated demand points: ${demandPoints.length}`,
    "2.4 GHz channels: 1/6/11 reuse",
    "5 GHz channels: 36/44/149/157 reuse",
    "Note: This is a planning estimate. Validate with predictive RF tools and onsite surveys."
  ].join("\n");
});
