/* ============================================================
   CatalogFitModule — 비용/길이 값과 Inner Diameter 값을 각각
   줄 단위(행)로 입력받아 같은 줄끼리 짝지은 뒤,
   cost/length = C1 · ID^n 형태로 거듭제곱 피팅(log-log 회귀)해서
   C1, n, R² 값을 구하고 선택된 배관에 적용하는 모듈.
   ============================================================ */
window.CatalogFitModule = (function () {

  /* ---- 숫자 파싱: 한 줄에 숫자 하나(쉼표·공백·단위 등은 무시) ---- */
  function parseNumLine(s) {
    if (s == null) return null;
    const m = String(s).replace(/,/g, "").match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isNaN(n) ? null : n;
  }
  function parseLines(text) {
    return String(text || "").split(/\r?\n/).map(parseNumLine);
  }

  /* ---- 거듭제곱 피팅: cost/length = C1 · ID^n (log-log 선형회귀) ---- */
  function powerLawFit(points) {
    const N = points.length;
    if (N < 2) return null;
    const lnX = points.map(p => Math.log(p.x));
    const lnY = points.map(p => Math.log(p.y));
    const sumX = lnX.reduce((a, b) => a + b, 0);
    const sumY = lnY.reduce((a, b) => a + b, 0);
    const sumXY = lnX.reduce((acc, x, i) => acc + x * lnY[i], 0);
    const sumXX = lnX.reduce((acc, x) => acc + x * x, 0);
    const denom = N * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-15) return null;
    const n = (N * sumXY - sumX * sumY) / denom;
    const lnC1 = (sumY - n * sumX) / N;
    const C1 = Math.exp(lnC1);
    const meanY = sumY / N;
    const ssTot = lnY.reduce((acc, y) => acc + (y - meanY) * (y - meanY), 0);
    const ssRes = lnY.reduce((acc, y, i) => { const yPred = lnC1 + n * lnX[i]; return acc + (y - yPred) * (y - yPred); }, 0);
    const R2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
    return { C1, n, R2 };
  }

  /* ---- UI ---- */
  let ids = null;
  const cat = { fit: null, points: null };

  function render() {
    const box = document.getElementById(ids.containerId);
    if (!box) return;
    box.innerHTML = `
      <div class="row" style="gap:8px; align-items:flex-start">
        <div style="flex:1">
          <label style="font-size:11px; color:var(--muted,#777)">비용/길이</label>
          <textarea id="cf-cost" placeholder="12.5&#10;15.3&#10;20.1"
            style="width:100%; min-height:100px; font-family:ui-monospace,Consolas,monospace; font-size:11px;
                   border:1px solid var(--line); border-radius:6px; padding:8px;"></textarea>
        </div>
        <div style="flex:1">
          <label style="font-size:11px; color:var(--muted,#777)">Inner Diameter</label>
          <textarea id="cf-id" placeholder="0.5&#10;0.75&#10;1.0"
            style="width:100%; min-height:100px; font-family:ui-monospace,Consolas,monospace; font-size:11px;
                   border:1px solid var(--line); border-radius:6px; padding:8px;"></textarea>
        </div>
      </div>
      <div class="row" style="margin-top:6px">
        <button type="button" id="cf-parse" style="flex:1">📊 피팅</button>
        <button type="button" id="cf-clear" style="flex:0 0 auto">🗑️ 비우기</button>
      </div>
      <div id="cf-output" class="hint" style="margin-top:6px"></div>
    `;
    box.querySelector("#cf-parse").addEventListener("click", onFit);
    box.querySelector("#cf-clear").addEventListener("click", onClear);
  }

  function onClear() {
    const c = document.getElementById("cf-cost");
    const d = document.getElementById("cf-id");
    if (c) c.value = "";
    if (d) d.value = "";
    cat.fit = null; cat.points = null;
    const out = document.getElementById("cf-output");
    if (out) out.innerHTML = "";
  }

  function onFit() {
    const out = document.getElementById("cf-output");
    const costRaw = parseLines(document.getElementById("cf-cost").value);
    const idRaw = parseLines(document.getElementById("cf-id").value);
    const N = Math.min(costRaw.length, idRaw.length);
    const points = [];
    for (let i = 0; i < N; i++) {
      const y = costRaw[i], x = idRaw[i];
      if (x != null && y != null && x > 0 && y > 0) points.push({ x, y });
    }
    if (points.length < 2) {
      out.innerHTML = `<span style="color:var(--bad,#d32f2f)">⚠ 같은 줄에서 짝지어지는 유효한 (비용/길이, ID) 값이 2쌍 이상 필요합니다.</span>`;
      cat.fit = null; cat.points = null;
      return;
    }
    cat.points = points;
    cat.fit = powerLawFit(points);
    renderResult();
  }

  function renderResult() {
    const out = document.getElementById("cf-output");
    if (!cat.fit) {
      out.innerHTML = `<span style="color:var(--bad,#d32f2f)">⚠ 피팅에 실패했습니다. 입력값을 확인하세요.</span>`;
      return;
    }
    const f = cat.fit;
    out.innerHTML = `
      <div style="padding:8px 10px; background:var(--panel2); border-radius:6px;">
        <div>데이터 ${cat.points.length}쌍 &nbsp; C₁ = <b style="color:var(--accent)">${f.C1.toExponential(4)}</b> &nbsp; n = <b style="color:var(--accent)">${f.n.toFixed(4)}</b> &nbsp; R² = ${f.R2.toFixed(4)}</div>
        <button type="button" id="cf-apply" style="margin-top:6px; width:100%; background:var(--accent); border-color:var(--accent); color:#fff;">✅ 적용</button>
      </div>
    `;
    const applyBtn = out.querySelector("#cf-apply");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      if (cat.fit && typeof ids.onApply === "function") ids.onApply(cat.fit.C1, cat.fit.n);
    });
  }

  function init(opts) {
    ids = opts; // { containerId, onApply(C1, n) }
    render();
  }

  return { init, powerLawFit };
})();
