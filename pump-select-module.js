/* ============================================================
   PumpSelectModule — D_opt 기준 펌프 추천 (단순화 버전)
   ─ 분담(QH) 입력 없이 시스템 전체 Q, D_opt 만으로 바로 추천
   ─ 사용자가 가압(booster)/급수(supply) 타입을 직접 선택
   ─ 사용법:
       PumpSelectModule.init({ boxId:"pumpRecBox", typeSelectId:"pumpType", getState: () => state });
       PumpSelectModule.render(solveResult);   // solveNetwork() 결과 r 전달
   ============================================================ */
window.PumpSelectModule = (function () {

  const NPS = [
    3.175, 6.35, 9.525, 12.7, 19.05, 25.4, 31.75, 38.1, 50.8, 63.5, 76.2, 88.9,
    101.6, 127, 152.4, 203.2, 254, 304.8, 355.6, 406.4, 457.2, 508, 558.8, 609.6
  ];
  function closestNPS(mm) {
    return NPS.reduce((b, c) => Math.abs(c - mm) < Math.abs(b - mm) ? c : b);
  }

  let ids = null;
  let lastResult = null;

  function pumpPipesOf(state) {
    return state.pipes.filter(p => {
      const a = state.nodes.find(n => n.id === p.from);
      const b = state.nodes.find(n => n.id === p.to);
      return (a && a.isPump) || (b && b.isPump);
    });
  }

  function render(result) {
    if (result) lastResult = result;
    const box = document.getElementById(ids.boxId);
    if (!box) return;
    const state = ids.getState ? ids.getState() : null;
    if (!state) { box.innerHTML = `<div class="hint">상태 정보를 찾을 수 없습니다.</div>`; return; }

    const pumpPipes = pumpPipesOf(state);
    if (pumpPipes.length === 0) {
      box.innerHTML = `<div class="hint">설계도에 펌프 노드가 없습니다.</div>`;
      return;
    }

    const typeSel = document.getElementById(ids.typeSelectId);
    const typeLabel = (typeSel && typeSel.value === "booster") ? "가압 (Booster)" : "급수 (Supply)";

    let html = `<div class="hint">선택된 펌프 종류: <b>${typeLabel}</b> — 추천 후보 최대 5개 (D_opt·유량 기준)</div>`;
    html += `<table><tr><th>배관</th><th>D_opt (mm)</th><th>최근접 NPS (mm)</th><th>유량 (m³/s)</th><th>추천 우선순위</th></tr>`;

    // D_opt 기준 정렬 — 큰 직경/유량일수록 대형 펌프 후보로 우선 추천 (간이 랭킹)
    const ranked = pumpPipes.slice().sort((a, b) => (b.D || 0) - (a.D || 0)).slice(0, 5);
    ranked.forEach((p, i) => {
      const mm = p.D ? p.D * 1000 : null;
      html += `<tr>
        <td>P${p.id}</td>
        <td>${mm ? mm.toFixed(2) : "-"}</td>
        <td>${mm ? closestNPS(mm).toFixed(1) : "-"}</td>
        <td>${p.Q != null ? p.Q.toExponential(2) : "-"}</td>
        <td>${i === 0 ? "🏆 1순위" : (i + 1) + "순위"}</td>
      </tr>`;
    });
    html += `</table>`;
    html += `<div class="hint" style="margin-top:6px">D_opt·유량을 기준으로 최근접 표준 NPS를 매칭해 우선순위를 매긴 추천 목록입니다. 실제 카탈로그(예: 동원펌프) 연동 시 이 D_opt·유량·양정 값을 그대로 매칭 조건으로 사용할 수 있습니다.</div>`;
    box.innerHTML = html;
  }

  function init(opts) {
    ids = opts;
    const typeSel = document.getElementById(ids.typeSelectId);
    if (typeSel) typeSel.addEventListener("change", () => render(lastResult));
  }

  return { init, render, closestNPS };
})();
