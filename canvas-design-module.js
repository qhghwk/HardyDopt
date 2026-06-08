/* ============================================================
   CanvasModule — 그림판 스타일 캔버스: 상태/그리기/입력/속성패널
   ─ 노드/펌프/배관 배치, 선택·이동·삭제, 방향 반전(더블클릭)
   ─ 사이드패널(노드/배관 속성 + 부속 ΣK) 렌더링
   ─ 사용법:
       CanvasModule.init({
         canvasId:"cv", wrapId:"canvasWrap",
         modeButtons: {node:"btn-node", pump:"btn-pump", pipe:"btn-pipe", select:"btn-select", delete:"btn-delete"},
         clearBtnId:"btn-clear",
         selPopupId:"selPopup"
       });
       CanvasModule.getState()   → state 객체 (solver/3D/pump 모듈에 전달)
       CanvasModule.draw()
   ============================================================ */
window.CanvasModule = (function () {

  // 입력창 단위 변환 — 내부 저장은 항상 SI(m, m³/s) 기준. 단위를 고르면 입력값을 SI로 환산해 저장.
  const LEN_UNIT_TO_M = { "m":1, "km":1000, "cm":0.01, "mm":0.001, "ft":0.3048, "in":0.0254 };
  const FLOW_UNIT_TO_M3S = { "m³/s":1, "L/s":1e-3, "L/min":1/60000, "m³/h":1/3600, "ft³/s":0.028316846592, "gpm":0.003785411784/60 };
  const lenUnitOpts = Object.keys(LEN_UNIT_TO_M).map(u => `<option value="${u}">${u}</option>`).join("");
  const flowUnitOpts = Object.keys(FLOW_UNIT_TO_M3S).map(u => `<option value="${u}">${u}</option>`).join("");
  const lenUnitSel = id => `<select id="${id}" class="unit-sel">${lenUnitOpts}</select>`;
  const flowUnitSel = id => `<select id="${id}" class="unit-sel">${flowUnitOpts}</select>`;

  const state = {
    mode: "select",          // node | pump | pipe | arrow | select | delete
    nodes: [],               // {id, x, y, height, demand, isPump, scale}  demand=노드 요구 유량(m³/s, 기본 0, continuity에 포함). scale(소/중/대)은 isPump 노드에서만 사용.
    pipes: [],               // {id, from, to, length, fixedQ, c1, n_exp, fittingsK, eps, Q, D}
    arrows: [],              // {id, nodeId, angle, flow, pumpNodeId, height}
                             //  - 일반(경계) 화살표: {nodeId, angle, flow}            ※ 시스템 외부 유입/유출 (+ 유입, − 유출)
                             //  - 펌프 연결 화살표  : {nodeId, pumpNodeId, angle, flow, height}  ※ 펌프 노드 ↔ 일반 노드를 직접 연결 (노드-노드 연결은 불가, 반드시 한쪽은 펌프). height = 펌프 설치 위치(높이, m) — 양정이 아님
    nextNodeId: 0,
    nextPipeId: 0,
    nextArrowId: 0,
    pipeFirstNode: null,     // pipe-drawing 임시 시작 노드
    arrowDragFrom: null,     // 화살표 드래그 시작점 {x, y, nodeId|null} — 허공/노드/펌프 어디서든 시작 가능, 노드 위에서 놓으면 연결
    selected: [],            // [{type:'node'|'pipe'|'arrow', id}, ...] — 다중 선택(Shift+클릭) 지원, 마지막 항목 옆에 입력창 표시
    drag: null,              // {type:'node', id}
    loopDirections: {},      // {[loop.extra 배관 id]: 1(시계방향, 기본) | -1(반시계방향)} — 폐회로 표시 화살표 클릭 시 토글
    _loopHitAreas: [],       // draw()에서 매번 갱신되는 루프 클릭 판정 영역 [{extra, cx, cy, r}]
  };
  const ARROW_LEN = 34;      // 화살표 길이(px) — 노드 중심에서부터

  let ids = null;
  let canvas, ctx;

  /* ---- 좌표 검색 ---- */
  function nodeAt(x, y) {
    return state.nodes.find(n => Math.hypot(n.x - x, n.y - y) < 14);
  }
  function pipeAt(x, y) {
    return state.pipes.find(p => {
      const a = state.nodes.find(n => n.id === p.from), b = state.nodes.find(n => n.id === p.to);
      if (!a || !b) return false;
      const A = Math.hypot(b.x - a.x, b.y - a.y);
      if (A < 1e-6) return false;
      const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (A * A)));
      const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
      return Math.hypot(px - x, py - y) < 8;
    });
  }
  /* 화살표 끝점 좌표 (경계 유출입 화살표 전용) */
  function arrowTip(ar) {
    const n = state.nodes.find(x => x.id === ar.nodeId);
    if (!n) return null;
    return { x: n.x + Math.cos(ar.angle) * ARROW_LEN, y: n.y + Math.sin(ar.angle) * ARROW_LEN };
  }
  /* 펌프↔노드 연결 화살표의 양 끝(노드) */
  function pumpArrowEnds(ar) {
    const a = state.nodes.find(x => x.id === ar.pumpNodeId);
    const b = state.nodes.find(x => x.id === ar.nodeId);
    if (!a || !b) return null;
    return { a, b };
  }
  function arrowAt(x, y) {
    return state.arrows.find(ar => {
      if (ar.pumpNodeId != null) {
        const ends = pumpArrowEnds(ar);
        if (!ends) return false;
        const { a, b } = ends;
        const A = Math.hypot(b.x - a.x, b.y - a.y);
        if (A < 1e-6) return false;
        const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (A * A)));
        const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
        return Math.hypot(px - x, py - y) < 8;
      }
      const tip = arrowTip(ar);
      if (!tip) return false;
      return Math.hypot(tip.x - x, tip.y - y) < 10;
    });
  }

  /* ---- 닫힌 루프(폐회로) 기하: 루프를 이루는 노드들의 중심점·반지름 계산 ---- */
  function loopGeometry(loop) {
    const nodeIds = loop.edges.map(({ pipe, dir }) => (dir === 1 ? pipe.from : pipe.to));
    const pts = nodeIds.map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    if (pts.length < 3) return null;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const avgDist = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
    const r = Math.max(20, avgDist * 0.45);
    return { cx, cy, r };
  }
  function loopAt(x, y) {
    return (state._loopHitAreas || []).find(L => Math.hypot(x - L.cx, y - L.cy) < L.r);
  }

  /* ---- 선택 관리: 다중 선택(같은 종류만) — 입력창은 마지막 선택 요소 옆에 표시되고 선택된 모두에 적용 ---- */
  function isSelected(type, id) {
    return state.selected.some(s => s.type === type && s.id === id);
  }
  function selectOnly(type, id) {
    state.selected = [{ type, id }];
  }
  function toggleSelect(type, id) {
    const idx = state.selected.findIndex(s => s.type === type && s.id === id);
    if (idx >= 0) { state.selected.splice(idx, 1); return; }
    if (state.selected.length && state.selected[0].type !== type) state.selected = [];
    state.selected.push({ type, id });
  }
  function selectedOfType(type) {
    const src = type === 'node' ? state.nodes : type === 'pipe' ? state.pipes : state.arrows;
    return state.selected.filter(s => s.type === type)
      .map(s => src.find(x => x.id === s.id)).filter(Boolean);
  }
  /* 선택 요소의 캔버스 좌표(입력창을 띄울 기준점) */
  function popupAnchor(sel) {
    if (sel.type === 'node') {
      const n = state.nodes.find(x => x.id === sel.id);
      return n ? { x: n.x, y: n.y } : null;
    }
    if (sel.type === 'pipe') {
      const p = state.pipes.find(x => x.id === sel.id);
      if (!p) return null;
      const a = state.nodes.find(n => n.id === p.from), b = state.nodes.find(n => n.id === p.to);
      if (!a || !b) return null;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    const ar = state.arrows.find(x => x.id === sel.id);
    if (!ar) return null;
    if (ar.pumpNodeId != null) {
      const ends = pumpArrowEnds(ar);
      return ends ? { x: (ends.a.x + ends.b.x) / 2, y: (ends.a.y + ends.b.y) / 2 } : null;
    }
    return arrowTip(ar);
  }

  function resizeCanvas() {
    const wrap = document.getElementById(ids.wrapId);
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
  }

  /* ---- 그리기 ---- */
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /* ---- 닫힌 루프(폐회로) 표시: 루프 이름 + 방향 화살표(원형) — 클릭하면 방향 반전 ---- */
    state._loopHitAreas = [];
    if (window.SolverModule && window.SolverModule.findLoops && state.pipes.length >= 2) {
      let loops = [];
      try { loops = window.SolverModule.findLoops(state) || []; } catch (e) { loops = []; }
      loops.forEach((loop, idx) => {
        const geo = loopGeometry(loop);
        if (!geo) return;
        const { cx, cy, r } = geo;
        const dirSign = (state.loopDirections[loop.extra] === -1) ? -1 : 1; // 1=시계방향(기본), -1=반시계방향
        state._loopHitAreas.push({ extra: loop.extra, cx, cy, r: r + 14 });

        const startAngle = -Math.PI / 2;
        const sweep = Math.PI * 1.6;
        const endAngle = dirSign > 0 ? startAngle + sweep : startAngle - sweep;

        ctx.save();
        ctx.strokeStyle = "#ce9178"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle, endAngle, dirSign < 0);
        ctx.stroke();
        ctx.setLineDash([]);

        // 화살촉: 호의 끝점에서 진행 방향(접선)을 향하도록
        const ax = cx + Math.cos(endAngle) * r, ay = cy + Math.sin(endAngle) * r;
        const tangentAngle = endAngle + dirSign * (Math.PI / 2);
        ctx.translate(ax, ay); ctx.rotate(tangentAngle);
        ctx.fillStyle = "#ce9178";
        ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = "#ce9178"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = "bold 12px sans-serif";
        ctx.fillText(`루프 ${idx + 1}`, cx, cy - 1);
        ctx.font = "9px sans-serif";
        ctx.fillText(dirSign > 0 ? "(시계방향 · 클릭 시 반전)" : "(반시계방향 · 클릭 시 반전)", cx, cy + 12);
        ctx.restore();
      });
    }

    state.pipes.forEach(p => {
      const a = state.nodes.find(n => n.id === p.from), b = state.nodes.find(n => n.id === p.to);
      if (!a || !b) return;
      const sel = isSelected('pipe', p.id);
      ctx.strokeStyle = sel ? "#00897b" : "#1976d2";
      ctx.lineWidth = sel ? 4 : 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.save();
      ctx.translate(mx, my); ctx.rotate(ang);
      ctx.fillStyle = sel ? "#00897b" : "#1976d2";
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = "#a1660b"; ctx.font = "11px sans-serif";
      let lbl = `P${p.id} L=${p.length || '-'}m`;
      if (p.fixedQ != null) lbl += ` 🔒Q=${p.fixedQ}`;
      if (p.c1 != null || p.n_exp != null) lbl += ` (C1=${p.c1 ?? '-'}, n=${p.n_exp ?? '-'})`;
      ctx.fillText(lbl, mx + 10, my - 8);
    });
    if (state.mode === "pipe" && state.pipeFirstNode != null) {
      const a = state.nodes.find(n => n.id === state.pipeFirstNode);
      if (a) { ctx.strokeStyle = "#888"; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(state._mx || a.x, state._my || a.y); ctx.stroke(); ctx.setLineDash([]); }
    }
    state.nodes.forEach(n => {
      const sel = isSelected('node', n.id);
      ctx.beginPath(); ctx.arc(n.x, n.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = n.isPump ? "#5e35b1" : "#1976d2";
      ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.5; ctx.strokeStyle = sel ? "#00897b" : "#37474f"; ctx.stroke();
      if (n.isPump) { ctx.fillStyle = "#fff"; ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("⚙", n.x, n.y + 1); }
      ctx.fillStyle = "#37474f"; ctx.font = "11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`N${n.id} h=${n.height}m`, n.x + 15, n.y + 4);
    });
    /* ---- 화살표: 펌프↔노드 직접 연결 (양 끝 모두 노드) ---- */
    state.arrows.forEach(ar => {
      if (ar.pumpNodeId == null) return;
      const ends = pumpArrowEnds(ar);
      if (!ends) return;
      const { a, b } = ends; // a = 펌프 노드, b = 일반 노드
      const sel = isSelected('arrow', ar.id);
      const isIn = (ar.flow || 0) >= 0; // +: 펌프→노드(공급), -: 노드→펌프(흡입)
      const col = sel ? "#00897b" : (isIn ? "#2e7d32" : "#d32f2f");
      const tailAt = isIn ? a : b;
      const headAt = isIn ? b : a;
      ctx.strokeStyle = col; ctx.lineWidth = sel ? 3 : 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(tailAt.x, tailAt.y); ctx.lineTo(headAt.x, headAt.y); ctx.stroke();
      ctx.setLineDash([]);
      const ang = Math.atan2(headAt.y - tailAt.y, headAt.x - tailAt.x);
      ctx.save(); ctx.translate(headAt.x + Math.cos(ang) * -16, headAt.y + Math.sin(ang) * -16); ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.fillStyle = col; ctx.font = "10px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`A${ar.id}[펌프↔N${b.id}] Q${ar.flow > 0 ? '+' : ''}${ar.flow ?? 0} h=${ar.height || 0}m`, mx + 6, my - 6);
    });
    /* ---- 화살표(노드 외부 유입/유출, 단일 끝점) ---- */
    state.arrows.forEach(ar => {
      if (ar.pumpNodeId != null) return;
      const n = state.nodes.find(x => x.id === ar.nodeId);
      const tip = arrowTip(ar);
      if (!n || !tip) return;
      const sel = isSelected('arrow', ar.id);
      const isIn = (ar.flow || 0) >= 0;
      const col = sel ? "#00897b" : (isIn ? "#2e7d32" : "#d32f2f");
      // 유입(+): 화살표가 노드를 "향해" 들어옴 → 끝(화살촉)이 노드 쪽
      // 유출(−): 화살표가 노드에서 "나감" → 화살촉이 바깥쪽
      const headAt = isIn ? { x: n.x + Math.cos(ar.angle) * 16, y: n.y + Math.sin(ar.angle) * 16 } : tip;
      const tailAt = isIn ? tip : { x: n.x + Math.cos(ar.angle) * 16, y: n.y + Math.sin(ar.angle) * 16 };
      ctx.strokeStyle = col; ctx.lineWidth = sel ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(tailAt.x, tailAt.y); ctx.lineTo(headAt.x, headAt.y); ctx.stroke();
      const ang = Math.atan2(headAt.y - tailAt.y, headAt.x - tailAt.x);
      ctx.save(); ctx.translate(headAt.x, headAt.y); ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = col; ctx.font = "10px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`A${ar.id} Q${ar.flow > 0 ? '+' : ''}${ar.flow ?? 0}`, tip.x + (Math.cos(ar.angle) >= 0 ? 4 : -54), tip.y + (Math.sin(ar.angle) >= 0 ? 12 : -6));
    });
    /* ---- 화살표 드래그 중 미리보기 선 (시작점 → 현재 마우스) ---- */
    if (state.mode === "arrow" && state.arrowDragFrom != null) {
      const f = state.arrowDragFrom;
      ctx.strokeStyle = "#888"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(state._mx != null ? state._mx : f.x, state._my != null ? state._my : f.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* ---- 캔버스 입력 이벤트 ---- */
  function bindCanvasEvents() {
    canvas.addEventListener("mousemove", e => {
      const r = canvas.getBoundingClientRect();
      state._mx = e.clientX - r.left; state._my = e.clientY - r.top;
      if (state.drag) {
        if (state.drag.type === "node") {
          const n = state.nodes.find(n => n.id === state.drag.id);
          if (n) { n.x = state._mx; n.y = state._my; }
        }
        draw();
      } else if (state.mode === "pipe" && state.pipeFirstNode != null) { draw(); }
      else if (state.mode === "arrow" && state.arrowDragFrom != null) { draw(); }
    });
    canvas.addEventListener("mouseup", e => {
      state.drag = null;
      if (state.mode === "arrow" && state.arrowDragFrom != null) {
        const from = state.arrowDragFrom;
        state.arrowDragFrom = null;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        if (Math.hypot(x - from.x, y - from.y) < 6) { draw(); return; } // 드래그 거리가 너무 짧으면 취소
        const startNode = (from.nodeId != null) ? state.nodes.find(n => n.id === from.nodeId) : null;
        const endNode = nodeAt(x, y);
        if (!endNode) { draw(); return; } // 노드 위에서 놓지 않으면 취소

        const startIsPump = !!(startNode && startNode.isPump);
        const endIsPump = !!endNode.isPump;

        if (startIsPump && endIsPump) {
          alert("펌프와 펌프는 화살표로 연결할 수 없습니다.");
          draw(); return;
        }
        if (startIsPump || endIsPump) {
          // 펌프 ↔ 일반 노드 직접 연결 (= 외부 펌프). 시작/끝 어느 쪽이 펌프든 허용
          const pumpNode = startIsPump ? startNode : endNode;
          const otherNode = startIsPump ? endNode : startNode;
          if (!otherNode || pumpNode.id === otherNode.id) { draw(); return; }
          const exists = state.arrows.some(a => a.pumpNodeId != null &&
            a.pumpNodeId === pumpNode.id && a.nodeId === otherNode.id);
          if (exists) { alert("이미 해당 펌프와 노드 사이에 화살표가 연결되어 있습니다."); draw(); return; }
          const angle = Math.atan2(otherNode.y - pumpNode.y, otherNode.x - pumpNode.x);
          const id = state.nextArrowId++;
          state.arrows.push({ id, nodeId: otherNode.id, pumpNodeId: pumpNode.id, angle, flow: 0, height: 0 });
          selectOnly('arrow', id);
          draw(); renderSelPopup(); return;
        }
        // 양쪽 모두 일반 노드(또는 허공) → 노드-노드 연결은 불가. 도착 노드에 경계(외부 유입/유출) 화살표를 부착하고
        // 방향은 "드래그 시작점 → 노드" 방향(허공에서 노드로 끌어오면 그 방향이 유입/유출 표시 방향이 됨)으로 설정
        const angle = Math.atan2(from.y - endNode.y, from.x - endNode.x);
        const id = state.nextArrowId++;
        state.arrows.push({ id, nodeId: endNode.id, angle, flow: 0 });
        selectOnly('arrow', id);
        draw(); renderSelPopup(); return;
      }
    });
    canvas.addEventListener("mousedown", e => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;

      if (state.mode === "node" || state.mode === "pump") {
        const id = state.nextNodeId++;
        const isPump = state.mode === "pump";
        state.nodes.push({ id, x, y, height: 0, demand: 0, isPump, scale: isPump ? "medium" : null, pumpPowerKW: null, affectedPipeIds: isPump ? [] : null });
        draw(); return;
      }
      if (state.mode === "arrow") {
        // 허공 / 노드 / 펌프 어디서든 드래그를 시작할 수 있음 — 실제 연결 처리는 mouseup에서 수행
        const hit = nodeAt(x, y);
        state.arrowDragFrom = { x, y, nodeId: hit ? hit.id : null };
        draw(); return;
      }
      if (state.mode === "pipe") {
        const n = nodeAt(x, y);
        if (!n) return;
        if (state.pipeFirstNode == null) { state.pipeFirstNode = n.id; }
        else if (state.pipeFirstNode !== n.id) {
          const id = state.nextPipeId++;
          state.pipes.push({ id, from: state.pipeFirstNode, to: n.id, length: 10, fixedQ: null, c1: null, n_exp: null, fittingsK: [], eps: null, material: null, Q: null, D: null });
          state.pipeFirstNode = null;
        } else { state.pipeFirstNode = null; }
        draw(); return;
      }
      if (state.mode === "delete") {
        const ar = arrowAt(x, y);
        if (ar) {
          state.arrows = state.arrows.filter(a => a.id !== ar.id); state.selected = []; draw(); renderSelPopup(); return;
        }
        const n = nodeAt(x, y);
        if (n) {
          state.pipes = state.pipes.filter(p => p.from !== n.id && p.to !== n.id);
          state.arrows = state.arrows.filter(a => a.nodeId !== n.id && a.pumpNodeId !== n.id);
          state.nodes = state.nodes.filter(nn => nn.id !== n.id);
          state.arrowDragFrom = null;
          state.selected = []; draw(); renderSelPopup(); return;
        }
        const p = pipeAt(x, y);
        if (p) {
          state.pipes = state.pipes.filter(pp => pp.id !== p.id);
          state.selected = []; draw(); renderSelPopup(); return;
        }
        return;
      }
      // select / move (Shift+클릭 = 같은 종류 다중 선택 토글)
      const ar = arrowAt(x, y);
      if (ar) { e.shiftKey ? toggleSelect('arrow', ar.id) : selectOnly('arrow', ar.id); draw(); renderSelPopup(); return; }
      const n = nodeAt(x, y);
      if (n) {
        if (e.shiftKey) { toggleSelect('node', n.id); }
        else { selectOnly('node', n.id); state.drag = { type: 'node', id: n.id }; }
        draw(); renderSelPopup(); return;
      }
      const p = pipeAt(x, y);
      if (p) { e.shiftKey ? toggleSelect('pipe', p.id) : selectOnly('pipe', p.id); draw(); renderSelPopup(); return; }
      const loopHit = loopAt(x, y);
      if (loopHit) {
        state.loopDirections[loopHit.extra] = (state.loopDirections[loopHit.extra] === -1) ? 1 : -1;
        draw();
        return;
      }
      if (!e.shiftKey) { state.selected = []; renderSelPopup(); draw(); }
    });
    canvas.addEventListener("dblclick", e => {
      // 배관 방향 반전 (더블클릭)
      const r = canvas.getBoundingClientRect();
      const p = pipeAt(e.clientX - r.left, e.clientY - r.top);
      if (p) { const t = p.from; p.from = p.to; p.to = t; draw(); }
    });
  }

  /* ---- 툴바(모드 전환) ---- */
  function setMode(m) {
    state.mode = m; state.pipeFirstNode = null;
    Object.entries(ids.modeButtons).forEach(([k, id]) => document.getElementById(id).classList.toggle("active", k === m));
  }
  function bindToolbar() {
    Object.entries(ids.modeButtons).forEach(([m, id]) => document.getElementById(id).addEventListener("click", () => setMode(m)));
    setMode("select");

    document.getElementById(ids.clearBtnId).addEventListener("click", () => {
      if (!confirm("전체 설계를 초기화할까요?")) return;
      state.nodes = []; state.pipes = []; state.arrows = [];
      state.nextNodeId = 0; state.nextPipeId = 0; state.nextArrowId = 0;
      state.selected = []; state.pipeFirstNode = null; state.arrowDragFrom = null;
      state.loopDirections = {}; state._loopHitAreas = [];
      draw(); renderSelPopup();
      const st = document.getElementById("solveStatus"); if (st) st.textContent = "";
    });
  }

  /* ---- 요소 옆 입력창(팝업): 선택한 요소 캔버스 위치 옆에 떠서 값 편집
        — 같은 종류를 여러 개 선택(Shift+클릭)하면 마지막 선택 요소 옆에 뜨고, 입력값은 선택된 모두에 적용 ---- */
  function closePopup() { state.selected = []; draw(); renderSelPopup(); }

  /* 팝업을 사용자가 드래그로 옮긴 절대 위치(px, #canvasWrap 기준) — 있으면 앵커 기반 위치 계산 대신 이 값을 사용 */
  let popupDragPos = null;

  function makePopupDraggable(pop) {
    let handle = pop.querySelector(".dragHandle");
    if (!handle) {
      handle = document.createElement("div");
      handle.className = "dragHandle";
      handle.title = "드래그해서 위치 이동";
      handle.textContent = "⠿⠿⠿ 드래그해서 이동";
      handle.style.cssText = "cursor:move; font-size:10px; letter-spacing:2px; color:#9aa0a6; text-align:center; "
        + "margin:-10px -12px 8px; padding:5px 12px; background:var(--panel2,#eef1f4); border-bottom:1px solid var(--line,#d8dce1); "
        + "border-radius:8px 8px 0 0; user-select:none;";
      pop.insertBefore(handle, pop.firstChild);
    }
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    handle.onpointerdown = e => {
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      const r = pop.getBoundingClientRect();
      const wrapR = canvas.parentElement.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      sl = r.left - wrapR.left; st = r.top - wrapR.top;
      e.preventDefault(); e.stopPropagation();
    };
    handle.onpointermove = e => {
      if (!dragging) return;
      const nl = sl + (e.clientX - sx), nt = st + (e.clientY - sy);
      pop.style.left = nl + "px";
      pop.style.top = nt + "px";
      popupDragPos = { x: nl, y: nt };
    };
    const endDrag = e => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    handle.onpointerup = endDrag;
    handle.onpointercancel = endDrag;
  }

  function renderSelPopup() {
    const pop = document.getElementById(ids.selPopupId);
    if (!pop) return;
    if (!state.selected.length) { pop.style.display = "none"; popupDragPos = null; return; }
    const last = state.selected[state.selected.length - 1];
    const anchor = popupAnchor(last);
    if (!anchor) { pop.style.display = "none"; return; }
    pop.style.display = "block";
    const cw = canvas.width || 600, ch = canvas.height || 400;
    if (popupDragPos) {
      pop.style.left = Math.max(6, Math.min(popupDragPos.x, cw - 40)) + "px";
      pop.style.top = Math.max(6, Math.min(popupDragPos.y, ch - 40)) + "px";
    } else {
      pop.style.left = Math.max(6, Math.min(anchor.x + 18, cw - 280)) + "px";
      pop.style.top = Math.max(6, Math.min(anchor.y - 12, ch - 220)) + "px";
    }

    const tag = state.selected.length > 1
      ? `<div class="pill" style="margin:4px 0">${state.selected.length}개 선택 — 입력값이 모두에 적용됩니다</div>` : "";

    if (last.type === "node") renderNodePopup(pop, tag);
    else if (last.type === "pipe") renderPipePopup(pop, tag);
    else renderArrowPopup(pop, tag);
    makePopupDraggable(pop);
  }

  function renderNodePopup(pop, tag) {
    const nodes = selectedOfType("node");
    if (!nodes.length) { pop.style.display = "none"; return; }
    const last = nodes[nodes.length - 1];
    const allPump = nodes.every(n => n.isPump);
    const scaleOpts = [["small","소"],["medium","중"],["large","대"]]
      .map(([k,lbl]) => `<option value="${k}" ${last.scale===k?"selected":""}>${lbl}</option>`).join("");

    let regionHtml = "";
    if (allPump && nodes.length === 1) {
      const isExternalPump = state.arrows.some(a => a.pumpNodeId === last.id);
      const isInternalPump = state.pipes.some(p => p.from === last.id || p.to === last.id);
      if (isInternalPump) {
        const rows = state.pipes.length
          ? state.pipes.map(p => {
              const checked = Array.isArray(last.affectedPipeIds) && last.affectedPipeIds.includes(p.id);
              return `<label style="display:flex;gap:6px;font-size:11px;margin:2px 0;cursor:pointer">
                <input type="checkbox" data-pipe-region="${p.id}" ${checked?"checked":""}/> P${p.id}</label>`;
            }).join("")
          : `<span class="hint">배관 없음</span>`;
        regionHtml = `<div class="hint">내부 펌프 — b,F 적용 배관 선택</div>
          <div style="max-height:90px;overflow-y:auto;border:1px solid var(--line);border-radius:4px;padding:4px">${rows}</div>`;
      } else if (isExternalPump) {
        regionHtml = `<div class="hint">외부 펌프 — b,F 전체 적용</div>`;
      } else {
        regionHtml = `<div class="hint">화살표 연결=외부 펌프, 배관 연결=내부 펌프</div>`;
      }
    }

    pop.innerHTML = `
      <span class="close" data-close>✕</span>
      <div class="hint"><b>${nodes.map(n=>'N'+n.id).join(', ')}</b> ${allPump ? '<span class="pill">펌프</span>' : ''}</div>
      ${tag}
      <div class="row"><label>높이</label><input id="pp-height" type="text" value="${last.height}"/>${lenUnitSel("pp-heightUnit")}</div>
      ${(() => {
        const isExtOnly = allPump && nodes.length === 1 &&
          state.arrows.some(a => a.pumpNodeId === last.id) &&
          !state.pipes.some(p => p.from === last.id || p.to === last.id);
        return isExtOnly ? "" : `<div class="row"><label>요구유량</label><input id="pp-demand" type="text" value="${last.demand ?? 0}" placeholder="기본 0"/>${flowUnitSel("pp-demandUnit")}</div>`;
      })()}
      ${allPump ? `
      <div class="row"><label>출력 규모</label><select id="pp-scale">${scaleOpts}</select></div>
      <div class="row"><label>출력(kW)</label><input id="pp-power" type="text" value="${last.pumpPowerKW ?? ''}" placeholder="예: 15"/></div>
      ${regionHtml}` : `<div class="hint">유출입 유량은 ↗ 화살표에서 입력합니다</div>`}
    `;
    pop.querySelector("[data-close]").addEventListener("click", closePopup);
    pop.querySelector("#pp-height").addEventListener("input", e => {
      const u = pop.querySelector("#pp-heightUnit").value;
      const v = (parseFloat(e.target.value) || 0) * (LEN_UNIT_TO_M[u] ?? 1);
      nodes.forEach(n => n.height = v); draw();
    });
    pop.querySelector("#pp-heightUnit").addEventListener("change", () => pop.querySelector("#pp-height").dispatchEvent(new Event("input")));
    const demandInp = pop.querySelector("#pp-demand");
    if (demandInp) {
      demandInp.addEventListener("input", e => {
        const u = pop.querySelector("#pp-demandUnit").value;
        const raw = parseFloat(e.target.value);
        const v = isFinite(raw) ? raw * (FLOW_UNIT_TO_M3S[u] ?? 1) : 0;
        nodes.forEach(n => n.demand = v);
      });
      pop.querySelector("#pp-demandUnit").addEventListener("change", () => demandInp.dispatchEvent(new Event("input")));
    }
    const scaleSel = pop.querySelector("#pp-scale");
    if (scaleSel) scaleSel.addEventListener("change", e => { nodes.forEach(n => n.scale = e.target.value); draw(); });
    const powerInp = pop.querySelector("#pp-power");
    if (powerInp) powerInp.addEventListener("input", e => {
      const v = parseFloat(e.target.value); nodes.forEach(n => n.pumpPowerKW = isFinite(v) ? v : null);
    });
    pop.querySelectorAll("[data-pipe-region]").forEach(cb => cb.addEventListener("change", () => {
      const pid = +cb.dataset.pipeRegion;
      if (!Array.isArray(last.affectedPipeIds)) last.affectedPipeIds = [];
      if (cb.checked) { if (!last.affectedPipeIds.includes(pid)) last.affectedPipeIds.push(pid); }
      else last.affectedPipeIds = last.affectedPipeIds.filter(x => x !== pid);
    }));
  }

  function renderPipePopup(pop, tag) {
    const pipes = selectedOfType("pipe");
    if (!pipes.length) { pop.style.display = "none"; return; }
    const last = pipes[pipes.length - 1];
    const multi = pipes.length > 1;
    const defaultEps = window.SolverModule ? window.SolverModule.DEFAULT_EPS_MM : 0.045;
    const matOptions = (() => {
      const db = (window.RefData && window.RefData.roughness) || null;
      if (!db) return '<option value="">로딩 중</option>';
      return `<option value="">직접 입력</option>` + Object.keys(db).map(key => {
        const m = db[key];
        return `<option value="${key}" ${last.material===key?"selected":""}>${m.label} (${m.roughness_mm}mm)</option>`;
      }).join("");
    })();
    pop.innerHTML = `
      <span class="close" data-close>✕</span>
      <div class="hint"><b>${pipes.map(p=>'P'+p.id).join(', ')}</b>${!multi ? ` N${last.from}→N${last.to} (더블클릭=방향반전)` : ''}</div>
      ${tag}
      <div class="row"><label>길이</label><input id="pp-length" type="text" value="${last.length}"/>${lenUnitSel("pp-lengthUnit")}</div>
      <div class="row"><label>고정유량🔒</label><input id="pp-flow" type="text" value="${last.fixedQ ?? ''}" placeholder="비우면 자동계산"/>${flowUnitSel("pp-flowUnit")}</div>
      <div class="row"><label>재질</label><select id="pp-material">${matOptions}</select></div>
      <div class="row"><label>조도ε(mm)</label><input id="pp-eps" type="text" value="${last.eps != null ? last.eps : defaultEps}"/></div>
      <div class="row"><label>C₁</label><input id="pp-c1" type="text" value="${last.c1 ?? ''}" placeholder="예: 1.5"/></div>
      <div class="row"><label>지수 n</label><input id="pp-nexp" type="text" value="${last.n_exp ?? ''}" placeholder="예: 1.7"/></div>
      <div class="hint" id="pp-cn-applied"></div>
      <div id="pp-fittings"></div>
    `;
    pop.querySelector("[data-close]").addEventListener("click", closePopup);
    pop.querySelector("#pp-length").addEventListener("input", e => {
      const u = pop.querySelector("#pp-lengthUnit").value;
      const v = (parseFloat(e.target.value)||0) * (LEN_UNIT_TO_M[u] ?? 1);
      pipes.forEach(p=>p.length=v); draw();
    });
    pop.querySelector("#pp-lengthUnit").addEventListener("change", () => pop.querySelector("#pp-length").dispatchEvent(new Event("input")));
    pop.querySelector("#pp-flow").addEventListener("input", e => {
      const u = pop.querySelector("#pp-flowUnit").value;
      const raw = parseFloat(e.target.value);
      const v = isFinite(raw) ? raw * (FLOW_UNIT_TO_M3S[u] ?? 1) : null;
      pipes.forEach(p=>p.fixedQ = v); draw();
    });
    pop.querySelector("#pp-flowUnit").addEventListener("change", () => pop.querySelector("#pp-flow").dispatchEvent(new Event("input")));
    pop.querySelector("#pp-material").addEventListener("change", e => {
      const key = e.target.value;
      const db = (window.RefData && window.RefData.roughness) || null;
      pipes.forEach(p => {
        if (key && db && db[key]) { p.material = key; p.eps = db[key].roughness_mm; }
        else { p.material = null; }
      });
      renderSelPopup(); draw();
    });
    pop.querySelector("#pp-eps").addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      pipes.forEach(p => { p.eps = isFinite(v) ? v : null; p.material = null; });
    });
    // 이 배관에 실제로 적용되는 C₁, n 값 표시 — 직접 입력하지 않으면 SolverModule의 고정 기본값이 쓰임
    const updateCNApplied = () => {
      const SM = window.SolverModule;
      const DC1 = (SM && isFinite(SM.DEFAULT_C1)) ? SM.DEFAULT_C1 : 1.5;
      const DN  = (SM && isFinite(SM.DEFAULT_N_EXP)) ? SM.DEFAULT_N_EXP : 1.7;
      const c1v = parseFloat(pop.querySelector("#pp-c1").value);
      const nv  = parseFloat(pop.querySelector("#pp-nexp").value);
      const appliedC1 = isFinite(c1v) ? c1v : DC1;
      const appliedN  = isFinite(nv)  ? nv  : DN;
      const note = (isFinite(c1v) || isFinite(nv)) ? '(직접입력)' : '(기본값)';
      const box = pop.querySelector("#pp-cn-applied");
      if (box) box.textContent = `▶ 적용값: C₁=${appliedC1}, n=${appliedN} ${note}`;
    };
    pop.querySelector("#pp-c1").addEventListener("input", e => { const v = parseFloat(e.target.value); pipes.forEach(p=>p.c1 = isFinite(v)?v:null); updateCNApplied(); draw(); });
    pop.querySelector("#pp-nexp").addEventListener("input", e => { const v = parseFloat(e.target.value); pipes.forEach(p=>p.n_exp = isFinite(v)?v:null); updateCNApplied(); draw(); });
    updateCNApplied();
    renderFittingsInline(multi ? null : last, pop.querySelector("#pp-fittings"));
  }

  function renderArrowPopup(pop, tag) {
    const arrows = selectedOfType("arrow");
    if (!arrows.length) { pop.style.display = "none"; return; }
    const last = arrows[arrows.length - 1];
    const allPumpLink = arrows.every(a => a.pumpNodeId != null);
    pop.innerHTML = `
      <span class="close" data-close>✕</span>
      <div class="hint"><b>${arrows.map(a=>'A'+a.id).join(', ')}</b>${allPumpLink ? ' <span class="pill">펌프 연결</span>' : ''}</div>
      ${tag}
      <div class="row"><label>유량</label><input id="pp-flow" type="text" value="${last.flow ?? 0}" placeholder="${allPumpLink ? '+공급 / −흡입' : '+유입 / −유출'}"/>${flowUnitSel("pp-flowUnit")}</div>
      <button id="pp-del" style="margin-top:4px">✕ 삭제</button>
    `;
    pop.querySelector("[data-close]").addEventListener("click", closePopup);
    pop.querySelector("#pp-flow").addEventListener("input", e => {
      const u = pop.querySelector("#pp-flowUnit").value;
      const raw = parseFloat(e.target.value);
      const v = isFinite(raw) ? raw * (FLOW_UNIT_TO_M3S[u] ?? 1) : 0;
      arrows.forEach(a=>a.flow = v); draw();
    });
    pop.querySelector("#pp-flowUnit").addEventListener("change", () => pop.querySelector("#pp-flow").dispatchEvent(new Event("input")));
    pop.querySelector("#pp-del").addEventListener("click", () => {
      const delIds = new Set(arrows.map(a=>a.id));
      state.arrows = state.arrows.filter(a => !delIds.has(a.id));
      state.selected = []; draw(); renderSelPopup();
    });
  }

  /* ---- 거듭제곱 피팅: cost/length = C1 · D^n  (로그-로그 선형회귀) ---- */
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
    return { C1, n, R2, lnC1 };
  }

  /* ---- 부속(피팅) ΣK 편집 — 배관 선택 팝업 안에 인라인으로 렌더링. K 값은 SolverModule.FITTING_K 참조 ---- */
  function renderFittingsInline(pipe, box) {
    if (!box) return;
    if (!pipe) { box.innerHTML = ""; return; }
    const FITTING_K = window.SolverModule.FITTING_K;
    const rows = pipe.fittingsK.map((f, i) => `
      <div class="row"><select data-fi="${i}">
        ${Object.keys(FITTING_K).map(k => `<option value="${k}" ${k === f ? 'selected' : ''}>${k} (K=${FITTING_K[k]})</option>`).join("")}
      </select><button data-rm="${i}" style="flex:0 0 28px">✕</button></div>`).join("");
    const totalK = pipe.fittingsK.reduce((s, f) => s + (FITTING_K[f] || 0), 0);
    box.innerHTML = `<div class="hint" style="margin:6px 0 2px">부속 ΣK = <b style="color:var(--accent)">${totalK.toFixed(3)}</b></div>
      ${rows}<button id="addFit" style="margin-top:4px">+ 부속 추가</button>`;
    box.querySelectorAll("[data-fi]").forEach(sel => sel.addEventListener("change", e => {
      pipe.fittingsK[+e.target.dataset.fi] = e.target.value; renderFittingsInline(pipe, box);
    }));
    box.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", e => {
      pipe.fittingsK.splice(+e.target.dataset.rm, 1); renderFittingsInline(pipe, box);
    }));
    box.querySelector("#addFit").addEventListener("click", () => { pipe.fittingsK.push("90_elbow_standard"); renderFittingsInline(pipe, box); });
  }

  function init(opts) {
    ids = opts;
    canvas = document.getElementById(ids.canvasId);
    ctx = canvas.getContext("2d");
    window.addEventListener("resize", resizeCanvas);
    bindCanvasEvents();
    bindToolbar();
    resizeCanvas();
    renderSelPopup();
  }

  /* ---- 직렬화 가능한 설계 상태 저장/복원 (Project Database 페이지 이동 시 유지용) ---- */
  function exportState() {
    return {
      nodes: state.nodes, pipes: state.pipes, arrows: state.arrows,
      nextNodeId: state.nextNodeId, nextPipeId: state.nextPipeId, nextArrowId: state.nextArrowId,
      loopDirections: state.loopDirections,
    };
  }
  function loadState(saved) {
    if (!saved) return;
    state.nodes = saved.nodes || [];
    state.pipes = saved.pipes || [];
    state.arrows = saved.arrows || [];
    state.nextNodeId = saved.nextNodeId || 0;
    state.nextPipeId = saved.nextPipeId || 0;
    state.nextArrowId = saved.nextArrowId || 0;
    state.loopDirections = saved.loopDirections || {};
    state.selected = [];
    state.drag = null;
    state.pipeFirstNode = null;
    state.arrowDragFrom = null;
    draw();
    renderSelPopup();
  }

  return {
    init, draw, renderSelPopup,
    getState: () => state,
    getCanvas: () => canvas,
    nodeAt, pipeAt, arrowAt, powerLawFit,
    exportState, loadState,
  };
})();
