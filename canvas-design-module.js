/* ============================================================
   CanvasModule — Konva.js 기반 배관망 설계 캔버스
   ─ 모든 기능·API (init, draw, getState, getCanvas, exportState, loadState, renderSelPopup)
     는 이전 canvas-design-module.js 와 동일하게 유지
   ─ 렌더링만 Konva.js 로 교체 (더 나은 시각 품질 + 히트 테스트)
   ============================================================ */
window.CanvasModule = (function () {

  /* ---- 단위 변환 테이블 ---- */
  const LEN_UNIT_TO_M  = { "m":1, "km":1000, "cm":0.01, "mm":0.001, "ft":0.3048, "in":0.0254 };
  const FLOW_UNIT_TO_M3S = { "m³/s":1, "L/s":1e-3, "L/min":1/60000, "m³/h":1/3600, "ft³/s":0.028316846592, "gpm":6.30902e-5 };
  const lenUnitOpts  = Object.keys(LEN_UNIT_TO_M).map(u=>`<option value="${u}">${u}</option>`).join("");
  const flowUnitOpts = Object.keys(FLOW_UNIT_TO_M3S).map(u=>`<option value="${u}">${u}</option>`).join("");
  const lenUnitSel  = id => `<select id="${id}" class="unit-sel">${lenUnitOpts}</select>`;
  const flowUnitSel = id => `<select id="${id}" class="unit-sel">${flowUnitOpts}</select>`;

  /* ---- 상태 ---- */
  const state = {
    mode: "select",
    nodes: [], pipes: [], arrows: [],
    nextNodeId: 0, nextPipeId: 0, nextArrowId: 0,
    pipeFirstNode: null,
    arrowDragFrom: null,
    selected: [],
    drag: null,
    loopDirections: {},
    _loopHitAreas: [],
    _mx: 0, _my: 0,
  };

  const ARROW_LEN = 38;
  const NODE_R    = 14;

  /* ---- 그리드 스냅 ---- */
  let snapEnabled = true;
  let snapSize    = 28;   // CSS background-size:28px 28px 와 일치
  function snapToGrid(x, y) {
    if (!snapEnabled) return { x, y };
    return { x: Math.round(x / snapSize) * snapSize, y: Math.round(y / snapSize) * snapSize };
  }

  let ids = null;
  let stage = null, layer = null, tempLayer = null;

  /* ================================================================
     HIT DETECTION — 수동 기하 계산 (Konva 내부 히트맵 불필요)
     ================================================================ */
  function nodeAt(x, y) {
    return state.nodes.find(n => Math.hypot(n.x - x, n.y - y) < NODE_R + 2) || null;
  }
  function pipeAt(x, y) {
    return state.pipes.find(p => {
      const a = state.nodes.find(n => n.id === p.from), b = state.nodes.find(n => n.id === p.to);
      if (!a || !b) return false;
      const len2 = (b.x-a.x)**2 + (b.y-a.y)**2;
      if (len2 < 1e-10) return false;
      const t = Math.max(0, Math.min(1, ((x-a.x)*(b.x-a.x) + (y-a.y)*(b.y-a.y)) / len2));
      return Math.hypot(a.x + t*(b.x-a.x) - x, a.y + t*(b.y-a.y) - y) < 9;
    }) || null;
  }
  function arrowTip(ar) {
    const n = state.nodes.find(x => x.id === ar.nodeId);
    if (!n) return null;
    return { x: n.x + Math.cos(ar.angle)*ARROW_LEN, y: n.y + Math.sin(ar.angle)*ARROW_LEN };
  }
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
        const len2 = (b.x-a.x)**2 + (b.y-a.y)**2;
        if (len2 < 1e-10) return false;
        const t = Math.max(0, Math.min(1, ((x-a.x)*(b.x-a.x) + (y-a.y)*(b.y-a.y)) / len2));
        return Math.hypot(a.x + t*(b.x-a.x) - x, a.y + t*(b.y-a.y) - y) < 9;
      }
      const tip = arrowTip(ar);
      if (!tip) return false;
      return Math.hypot(tip.x - x, tip.y - y) < 12;
    }) || null;
  }
  function loopGeometry(loop) {
    /* 루프를 구성하는 모든 고유 노드의 좌표를 수집 → 정확한 중심 계산 */
    const nodeIdSet = new Set();
    loop.edges.forEach(({ pipe }) => { nodeIdSet.add(pipe.from); nodeIdSet.add(pipe.to); });
    const pts = [...nodeIdSet].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    if (pts.length < 2) return null;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const avgDist = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
    return { cx, cy, r: Math.max(22, avgDist * 0.44) };
  }
  function loopAt(x, y) {
    return (state._loopHitAreas || []).find(L => Math.hypot(x - L.cx, y - L.cy) < L.r + 14) || null;
  }

  /* ================================================================
     SELECTION HELPERS
     ================================================================ */
  function isSelected(type, id) { return state.selected.some(s => s.type === type && s.id === id); }
  function selectOnly(type, id) { state.selected = [{ type, id }]; }
  function toggleSelect(type, id) {
    const idx = state.selected.findIndex(s => s.type === type && s.id === id);
    if (idx >= 0) { state.selected.splice(idx, 1); return; }
    if (state.selected.length && state.selected[0].type !== type) state.selected = [];
    state.selected.push({ type, id });
  }
  function selectedOfType(type) {
    const src = type === 'node' ? state.nodes : type === 'pipe' ? state.pipes : state.arrows;
    return state.selected.filter(s => s.type === type).map(s => src.find(x => x.id === s.id)).filter(Boolean);
  }
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

  /* ================================================================
     DRAW — 매 호출마다 Konva 도형 재생성
     ================================================================ */
  function draw() {
    if (!layer) return;
    layer.destroyChildren();
    tempLayer.destroyChildren();
    state._loopHitAreas = [];

    /* ---------- 1. 루프 표시기 ---------- */
    if (window.SolverModule && window.SolverModule.findLoops && state.pipes.length >= 2) {
      let loops = [];
      try { loops = window.SolverModule.findLoops(state) || []; } catch(e) {}
      loops.forEach((loop, idx) => {
        const geo = loopGeometry(loop);
        if (!geo) return;
        const { cx, cy, r } = geo;
        const dir = (state.loopDirections[loop.extra] === -1) ? -1 : 1;
        state._loopHitAreas.push({ extra: loop.extra, cx, cy, r });

        const startAngle = -Math.PI / 2;
        const sweep     = Math.PI * 1.6;
        const endAngle  = dir > 0 ? startAngle + sweep : startAngle - sweep;

        layer.add(new Konva.Shape({
          sceneFunc(kc) {
            kc.save();
            kc.strokeStyle = '#f97316'; kc.lineWidth = 2;
            kc.setLineDash([6, 4]);
            kc.beginPath(); kc.arc(cx, cy, r, startAngle, endAngle, dir < 0); kc.stroke();
            kc.setLineDash([]);
            const ax = cx + Math.cos(endAngle) * r, ay = cy + Math.sin(endAngle) * r;
            const tang = endAngle + dir * (Math.PI / 2);
            kc.save(); kc.translate(ax, ay); kc.rotate(tang);
            kc.fillStyle = '#f97316';
            kc.beginPath(); kc.moveTo(10, 0); kc.lineTo(-6, -5); kc.lineTo(-6, 5); kc.closePath(); kc.fill();
            kc.restore(); kc.restore();
          },
          hitFunc(kc, shape) {
            kc.beginPath(); kc.arc(cx, cy, r + 16, 0, Math.PI * 2, false); kc.fillShape(shape);
          },
        }));
        const t1 = new Konva.Text({ x: 0, y: cy - 9, text: `루프 ${idx + 1}`, fontSize: 12, fontStyle: 'bold', fill: '#f97316' });
        t1.x(cx - t1.width() / 2); layer.add(t1);
        const t2 = new Konva.Text({ x: 0, y: cy + 6, text: dir > 0 ? '(시계방향 · 클릭 반전)' : '(반시계 · 클릭 반전)', fontSize: 9, fill: '#f97316' });
        t2.x(cx - t2.width() / 2); layer.add(t2);
      });
    }

    /* ---------- 2. 배관 ---------- */
    state.pipes.forEach(p => {
      const a = state.nodes.find(n => n.id === p.from), b = state.nodes.find(n => n.id === p.to);
      if (!a || !b) return;
      const sel = isSelected('pipe', p.id);
      const col = sel ? '#10b981' : '#3b82f6';

      layer.add(new Konva.Line({
        points: [a.x, a.y, b.x, b.y],
        stroke: col, strokeWidth: sel ? 3.5 : 2.5, lineCap: 'round',
      }));

      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      layer.add(new Konva.Shape({
        sceneFunc(kc) {
          kc.save(); kc.translate(mx, my); kc.rotate(ang);
          kc.fillStyle = col;
          kc.beginPath(); kc.moveTo(10, 0); kc.lineTo(-6, -5); kc.lineTo(-6, 5); kc.closePath(); kc.fill();
          kc.restore();
        },
        hitFunc(kc, shape) {
          kc.beginPath(); kc.rect(mx - 14, my - 12, 28, 24); kc.fillShape(shape);
        },
      }));

      if (sel) {
        let lbl = `P${p.id}  L=${p.length ?? '-'}m`;
        if (p.fixedD != null && isFinite(p.fixedD)) lbl += `  D=${(p.fixedD*1000).toFixed(0)}mm🔒`;
        else if (p.D != null && isFinite(p.D) && p.D > 0) lbl += `  D=${(p.D*1000).toFixed(1)}mm`;
        if (p.minD != null && isFinite(p.minD) && p.minD > 0) lbl += `  (≥${(p.minD*1000).toFixed(0)}mm)`;
        if (p.maxD != null && isFinite(p.maxD) && p.maxD > 0) lbl += `  (≤${(p.maxD*1000).toFixed(0)}mm)`;
        if (p.fixedQ != null) lbl += '  Q🔒';
        if (p.minQ != null && isFinite(p.minQ) && p.minQ > 0) lbl += `  (Q≥${(p.minQ*3600).toFixed(2)}m³/h)`;
        if (p.c1 != null || p.n_exp != null) lbl += `  (C₁=${p.c1 ?? '-'} n=${p.n_exp ?? '-'})`;
        layer.add(new Konva.Text({
          x: mx + 10, y: my - 18, text: lbl,
          fontSize: 11, fill: '#0f766e',
          fontFamily: 'Segoe UI, sans-serif',
        }));
      }
    });

    /* 배관 그리기 미리보기 */
    if (state.mode === 'pipe' && state.pipeFirstNode != null) {
      const a = state.nodes.find(n => n.id === state.pipeFirstNode);
      if (a) tempLayer.add(new Konva.Line({ points: [a.x, a.y, state._mx, state._my], stroke: '#94a3b8', strokeWidth: 1.5, dash: [6, 4] }));
    }
    /* 화살표 드래그 미리보기 */
    if (state.mode === 'arrow' && state.arrowDragFrom != null) {
      const f = state.arrowDragFrom;
      tempLayer.add(new Konva.Line({ points: [f.x, f.y, state._mx, state._my], stroke: '#94a3b8', strokeWidth: 1.5, dash: [5, 4] }));
    }

    /* ---------- 3. 화살표 ---------- */
    state.arrows.forEach(ar => {
      if (ar.pumpNodeId != null) {
        /* 펌프 ↔ 노드 직접 연결 화살표 */
        const ends = pumpArrowEnds(ar);
        if (!ends) return;
        const { a, b } = ends;
        const sel = isSelected('arrow', ar.id);
        const isIn = (ar.flow || 0) >= 0;
        const col = sel ? '#10b981' : (isIn ? '#16a34a' : '#dc2626');
        const tailAt = isIn ? a : b, headAt = isIn ? b : a;
        const dist = Math.hypot(headAt.x - tailAt.x, headAt.y - tailAt.y);
        const ux = dist > 0 ? (headAt.x - tailAt.x) / dist : 1;
        const uy = dist > 0 ? (headAt.y - tailAt.y) / dist : 0;
        const tx = tailAt.x + ux*18, ty = tailAt.y + uy*18;
        const hx = headAt.x - ux*18, hy = headAt.y - uy*18;
        const arAng = Math.atan2(headAt.y - tailAt.y, headAt.x - tailAt.x);
        layer.add(new Konva.Shape({
          sceneFunc(kc) {
            kc.save();
            kc.strokeStyle = col; kc.lineWidth = sel ? 2.5 : 2; kc.setLineDash([7, 4]);
            kc.beginPath(); kc.moveTo(tx, ty); kc.lineTo(hx, hy); kc.stroke(); kc.setLineDash([]);
            kc.translate(hx, hy); kc.rotate(arAng);
            kc.fillStyle = col;
            kc.beginPath(); kc.moveTo(11, 0); kc.lineTo(-6, -5); kc.lineTo(-6, 5); kc.closePath(); kc.fill();
            kc.restore();
          },
          hitFunc(kc, shape) {
            kc.beginPath(); kc.moveTo(tx, ty); kc.lineTo(hx, hy); kc.lineWidth = 14; kc.strokeShape(shape);
          },
        }));
        if (sel) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          layer.add(new Konva.Text({ x: mx + 6, y: my - 14, text: `A${ar.id} [펌프↔N${b.id}] Q${ar.flow > 0 ? '+' : ''}${ar.flow ?? 0} h=${ar.height || 0}m`, fontSize: 10, fill: col, fontFamily: 'Segoe UI, sans-serif' }));
        }
      } else {
        /* 경계 유출입 화살표 */
        const n = state.nodes.find(x => x.id === ar.nodeId);
        const tip = arrowTip(ar);
        if (!n || !tip) return;
        const sel = isSelected('arrow', ar.id);
        const isIn = (ar.flow || 0) >= 0;
        const col = sel ? '#10b981' : (isIn ? '#16a34a' : '#dc2626');
        const headAt = isIn
          ? { x: n.x + Math.cos(ar.angle)*18, y: n.y + Math.sin(ar.angle)*18 }
          : tip;
        const tailAt = isIn
          ? tip
          : { x: n.x + Math.cos(ar.angle)*18, y: n.y + Math.sin(ar.angle)*18 };
        const arAng = Math.atan2(headAt.y - tailAt.y, headAt.x - tailAt.x);
        layer.add(new Konva.Shape({
          sceneFunc(kc) {
            kc.save();
            kc.strokeStyle = col; kc.lineWidth = sel ? 2.5 : 2;
            kc.beginPath(); kc.moveTo(tailAt.x, tailAt.y); kc.lineTo(headAt.x, headAt.y); kc.stroke();
            kc.translate(headAt.x, headAt.y); kc.rotate(arAng);
            kc.fillStyle = col;
            kc.beginPath(); kc.moveTo(11, 0); kc.lineTo(-6, -5); kc.lineTo(-6, 5); kc.closePath(); kc.fill();
            kc.restore();
          },
          hitFunc(kc, shape) {
            kc.beginPath(); kc.moveTo(tailAt.x, tailAt.y); kc.lineTo(headAt.x, headAt.y); kc.lineWidth = 14; kc.strokeShape(shape);
          },
        }));
        if (sel) {
          const lx = tip.x + (Math.cos(ar.angle) >= 0 ? 4 : -54);
          const ly = tip.y + (Math.sin(ar.angle) >= 0 ? 12 : -6);
          layer.add(new Konva.Text({ x: lx, y: ly, text: `A${ar.id} Q${ar.flow > 0 ? '+' : ''}${ar.flow ?? 0}`, fontSize: 10, fill: col, fontFamily: 'Segoe UI, sans-serif' }));
        }
      }
    });

    /* ---------- 4. 노드 (맨 위) ---------- */
    state.nodes.forEach(n => {
      const sel = isSelected('node', n.id);
      const isPump = n.isPump;
      if (sel) {
        layer.add(new Konva.Circle({
          x: n.x, y: n.y, radius: NODE_R + 7,
          fill: 'rgba(16,185,129,0.15)',
          stroke: '#10b981', strokeWidth: 1.5, dash: [4, 3],
        }));
      }
      layer.add(new Konva.Circle({
        x: n.x, y: n.y, radius: NODE_R,
        fill: isPump ? (sel ? '#6d28d9' : '#7c3aed') : (sel ? '#1d4ed8' : '#2563eb'),
        stroke: sel ? '#10b981' : '#1e293b',
        strokeWidth: sel ? 2.5 : 1.5,
        shadowColor: '#000', shadowBlur: 8, shadowOpacity: 0.18,
        shadowOffsetX: 1, shadowOffsetY: 2,
      }));
      if (isPump) {
        layer.add(new Konva.Text({ x: n.x - 7, y: n.y - 8, text: '⚙', fontSize: 14, fill: '#fff' }));
      }
      if (sel) {
        layer.add(new Konva.Text({
          x: n.x + NODE_R + 4, y: n.y - 8,
          text: `N${n.id}  h=${n.height}m`,
          fontSize: 11, fill: '#0f766e', fontStyle: 'bold',
          fontFamily: 'Segoe UI, sans-serif',
        }));
      } else {
        layer.add(new Konva.Text({
          x: n.x + NODE_R + 4, y: n.y - 6,
          text: `N${n.id}`,
          fontSize: 10, fill: '#334155',
          fontFamily: 'Segoe UI, sans-serif',
        }));
      }
    });

    layer.batchDraw();
    tempLayer.batchDraw();
  }

  /* ================================================================
     RESIZE
     ================================================================ */
  function resizeCanvas() {
    if (!stage) return;
    const wrap = document.getElementById(ids.wrapId);
    stage.width(wrap.clientWidth);
    stage.height(wrap.clientHeight);
    draw();
  }

  /* ================================================================
     EVENTS
     ================================================================ */
  function bindCanvasEvents() {
    stage.on('mousemove', () => {
      const pos = stage.getPointerPosition();
      if (!pos) return;
      const sn = snapToGrid(pos.x, pos.y);
      state._mx = sn.x; state._my = sn.y;
      if (state.drag) {
        const n = state.nodes.find(n => n.id === state.drag.id);
        if (n) { n.x = sn.x; n.y = sn.y; }
        draw(); return;
      }
      if ((state.mode === 'pipe' && state.pipeFirstNode != null) ||
          (state.mode === 'arrow' && state.arrowDragFrom != null)) draw();
    });

    stage.on('mouseup', () => {
      if (state.drag) { state.drag = null; draw(); return; }
      if (state.mode === 'arrow' && state.arrowDragFrom != null) {
        const from = state.arrowDragFrom;
        state.arrowDragFrom = null;
        const pos = stage.getPointerPosition();
        if (!pos) { draw(); return; }
        const { x, y } = pos;
        if (Math.hypot(x - from.x, y - from.y) < 6) { draw(); return; }
        const startNode = from.nodeId != null ? state.nodes.find(n => n.id === from.nodeId) : null;
        const endNode = nodeAt(x, y);
        if (!endNode) { draw(); return; }
        const startIsPump = !!(startNode && startNode.isPump);
        const endIsPump = !!endNode.isPump;
        if (startIsPump && endIsPump) { alert("펌프와 펌프는 화살표로 연결할 수 없습니다."); draw(); return; }
        if (startIsPump || endIsPump) {
          const pumpNode = startIsPump ? startNode : endNode;
          const otherNode = startIsPump ? endNode : startNode;
          if (!otherNode || pumpNode.id === otherNode.id) { draw(); return; }
          if (state.arrows.some(a => a.pumpNodeId != null && a.pumpNodeId === pumpNode.id && a.nodeId === otherNode.id)) { alert("이미 연결되어 있습니다."); draw(); return; }
          const id = state.nextArrowId++;
          state.arrows.push({ id, nodeId: otherNode.id, pumpNodeId: pumpNode.id, angle: Math.atan2(otherNode.y - pumpNode.y, otherNode.x - pumpNode.x), flow: 0, height: 0 });
          selectOnly('arrow', id); draw(); renderSelPopup(); return;
        }
        const id = state.nextArrowId++;
        state.arrows.push({ id, nodeId: endNode.id, angle: Math.atan2(from.y - endNode.y, from.x - endNode.x), flow: 0 });
        selectOnly('arrow', id); draw(); renderSelPopup();
      }
    });

    stage.on('mousedown', e => {
      const pos = stage.getPointerPosition();
      if (!pos) return;
      const { x, y } = pos;
      const nativeEvt = e.evt;

      if (state.mode === 'node' || state.mode === 'pump') {
        const sn = snapToGrid(x, y);
        const id = state.nextNodeId++;
        const isPump = state.mode === 'pump';
        state.nodes.push({ id, x: sn.x, y: sn.y, height: 0, demand: 0, isPump, scale: isPump ? 'medium' : null, pumpPowerKW: null, affectedPipeIds: isPump ? [] : null });
        draw(); return;
      }
      if (state.mode === 'arrow') {
        const hit = nodeAt(x, y);
        state.arrowDragFrom = { x, y, nodeId: hit ? hit.id : null };
        draw(); return;
      }
      if (state.mode === 'pipe') {
        const n = nodeAt(x, y);
        if (!n) return;
        if (state.pipeFirstNode == null) { state.pipeFirstNode = n.id; }
        else if (state.pipeFirstNode !== n.id) {
          const id = state.nextPipeId++;
          state.pipes.push({ id, from: state.pipeFirstNode, to: n.id, length: 10, fixedQ: null, fixedD: null, minD: null, maxD: null, minQ: null, schedule: 'SCH40', c1: null, n_exp: null, fittingsK: [], eps: null, material: null, Q: null, D: null });
          state.pipeFirstNode = null;
        } else { state.pipeFirstNode = null; }
        draw(); return;
      }
      if (state.mode === 'delete') {
        const ar = arrowAt(x, y);
        if (ar) { state.arrows = state.arrows.filter(a => a.id !== ar.id); state.selected = []; draw(); renderSelPopup(); return; }
        const n = nodeAt(x, y);
        if (n) {
          state.pipes  = state.pipes.filter(p => p.from !== n.id && p.to !== n.id);
          state.arrows = state.arrows.filter(a => a.nodeId !== n.id && a.pumpNodeId !== n.id);
          state.nodes  = state.nodes.filter(nn => nn.id !== n.id);
          state.arrowDragFrom = null; state.selected = []; draw(); renderSelPopup(); return;
        }
        const p = pipeAt(x, y);
        if (p) { state.pipes = state.pipes.filter(pp => pp.id !== p.id); state.selected = []; draw(); renderSelPopup(); return; }
        return;
      }
      /* select / move */
      const ar = arrowAt(x, y);
      if (ar) { nativeEvt.shiftKey ? toggleSelect('arrow', ar.id) : selectOnly('arrow', ar.id); draw(); renderSelPopup(); return; }
      const n = nodeAt(x, y);
      if (n) {
        if (nativeEvt.shiftKey) { toggleSelect('node', n.id); }
        else { selectOnly('node', n.id); state.drag = { type: 'node', id: n.id }; }
        draw(); renderSelPopup(); return;
      }
      const p = pipeAt(x, y);
      if (p) { nativeEvt.shiftKey ? toggleSelect('pipe', p.id) : selectOnly('pipe', p.id); draw(); renderSelPopup(); return; }
      const loopHit = loopAt(x, y);
      if (loopHit) { state.loopDirections[loopHit.extra] = state.loopDirections[loopHit.extra] === -1 ? 1 : -1; draw(); return; }
      if (!nativeEvt.shiftKey) { state.selected = []; renderSelPopup(); draw(); }
    });

    stage.on('dblclick', () => {
      const pos = stage.getPointerPosition();
      if (!pos) return;
      const p = pipeAt(pos.x, pos.y);
      if (p) { const t = p.from; p.from = p.to; p.to = t; draw(); }
    });
  }

  /* ================================================================
     정렬 도구
     ================================================================ */
  function alignNodes(how) {
    const nodes = selectedOfType('node');
    if (nodes.length < 2) { alert("Shift+클릭으로 2개 이상 노드를 선택하세요."); return; }
    if (how === 'left')    { const v = Math.min(...nodes.map(n=>n.x)); nodes.forEach(n=>n.x=v); }
    else if (how === 'right')   { const v = Math.max(...nodes.map(n=>n.x)); nodes.forEach(n=>n.x=v); }
    else if (how === 'top')     { const v = Math.min(...nodes.map(n=>n.y)); nodes.forEach(n=>n.y=v); }
    else if (how === 'bottom')  { const v = Math.max(...nodes.map(n=>n.y)); nodes.forEach(n=>n.y=v); }
    else if (how === 'centerH') { const v = nodes.reduce((s,n)=>s+n.x,0)/nodes.length; nodes.forEach(n=>n.x=Math.round(v)); }
    else if (how === 'centerV') { const v = nodes.reduce((s,n)=>s+n.y,0)/nodes.length; nodes.forEach(n=>n.y=Math.round(v)); }
    else if (how === 'distH') {
      nodes.sort((a,b)=>a.x-b.x);
      const span = nodes[nodes.length-1].x - nodes[0].x;
      const gap  = span / (nodes.length - 1);
      nodes.forEach((n,i) => n.x = Math.round(nodes[0].x + gap*i));
    }
    else if (how === 'distV') {
      nodes.sort((a,b)=>a.y-b.y);
      const span = nodes[nodes.length-1].y - nodes[0].y;
      const gap  = span / (nodes.length - 1);
      nodes.forEach((n,i) => n.y = Math.round(nodes[0].y + gap*i));
    }
    draw();
  }

  /* ================================================================
     TOOLBAR
     ================================================================ */
  function setMode(m) {
    state.mode = m; state.pipeFirstNode = null;
    Object.entries(ids.modeButtons).forEach(([k, btnId]) => document.getElementById(btnId).classList.toggle("active", k === m));
    const cursors = { node: 'crosshair', pump: 'crosshair', pipe: 'crosshair', arrow: 'crosshair', select: 'default', delete: 'not-allowed' };
    stage.container().style.cursor = cursors[m] || 'default';
  }
  function bindToolbar() {
    Object.entries(ids.modeButtons).forEach(([m, btnId]) => document.getElementById(btnId).addEventListener("click", () => setMode(m)));
    setMode("select");
    document.getElementById(ids.clearBtnId).addEventListener("click", () => {
      if (!confirm("전체 설계를 초기화할까요?")) return;
      Object.assign(state, { nodes: [], pipes: [], arrows: [], nextNodeId: 0, nextPipeId: 0, nextArrowId: 0, selected: [], pipeFirstNode: null, arrowDragFrom: null, loopDirections: {}, _loopHitAreas: [] });
      draw(); renderSelPopup();
      const st = document.getElementById("solveStatus"); if (st) st.textContent = "";
    });
  }

  /* ================================================================
     POPUP
     ================================================================ */
  function closePopup() { state.selected = []; draw(); renderSelPopup(); }
  let popupDragPos = null;

  function makePopupDraggable(pop) {
    let handle = pop.querySelector(".dragHandle");
    if (!handle) {
      handle = document.createElement("div");
      handle.className = "dragHandle";
      handle.textContent = "⠿⠿⠿ 드래그해서 이동";
      handle.style.cssText = "cursor:move; font-size:10px; letter-spacing:1.5px; color:#94a3b8; text-align:center; margin:-12px -14px 10px; padding:6px 14px; background:#f8fafc; border-bottom:1px solid #e2e8f0; border-radius:10px 10px 0 0; user-select:none;";
      pop.insertBefore(handle, pop.firstChild);
    }
    let dragging = false, sx = 0, sy = 0, sl = 0, st_ = 0;
    handle.onpointerdown = e => {
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch(_) {}
      const r = pop.getBoundingClientRect();
      const wr = stage.container().getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left - wr.left; st_ = r.top - wr.top;
      e.preventDefault(); e.stopPropagation();
    };
    handle.onpointermove = e => {
      if (!dragging) return;
      const nl = sl + (e.clientX - sx), nt = st_ + (e.clientY - sy);
      pop.style.left = nl + "px"; pop.style.top = nt + "px"; popupDragPos = { x: nl, y: nt };
    };
    const endDrag = e => { if (!dragging) return; dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch(_) {} };
    handle.onpointerup = endDrag; handle.onpointercancel = endDrag;
  }

  function renderSelPopup() {
    const pop = document.getElementById(ids.selPopupId);
    if (!pop) return;
    if (!state.selected.length) { pop.style.display = "none"; popupDragPos = null; return; }
    const last = state.selected[state.selected.length - 1];
    const anchor = popupAnchor(last);
    if (!anchor) { pop.style.display = "none"; return; }
    pop.style.display = "block";
    const cw = stage.width(), ch = stage.height();
    if (popupDragPos) {
      pop.style.left = Math.max(6, Math.min(popupDragPos.x, cw - 40)) + "px";
      pop.style.top  = Math.max(6, Math.min(popupDragPos.y, ch - 40)) + "px";
    } else {
      pop.style.left = Math.max(6, Math.min(anchor.x + 18, cw - 285)) + "px";
      pop.style.top  = Math.max(6, Math.min(anchor.y - 12, ch - 230)) + "px";
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
              return `<label style="display:flex;gap:6px;font-size:11px;margin:2px 0;cursor:pointer"><input type="checkbox" data-pipe-region="${p.id}" ${checked?"checked":""}/> P${p.id}</label>`;
            }).join("")
          : `<span class="hint">배관 없음</span>`;
        regionHtml = `<div class="hint">내부 펌프 — b,F 적용 배관 선택</div><div style="max-height:90px;overflow-y:auto;border:1px solid var(--line);border-radius:4px;padding:4px">${rows}</div>`;
      } else if (isExternalPump) {
        regionHtml = `<div class="hint">외부 펌프 — b,F 전체 적용</div>`;
      } else {
        regionHtml = `<div class="hint">화살표 연결=외부 펌프, 배관 연결=내부 펌프</div>`;
      }
    }
    const isExtOnly = allPump && nodes.length === 1 &&
      state.arrows.some(a => a.pumpNodeId === last.id) &&
      !state.pipes.some(p => p.from === last.id || p.to === last.id);

    pop.innerHTML = `
      <span class="close" data-close>✕</span>
      <div class="hint"><b>${nodes.map(n=>'N'+n.id).join(', ')}</b> ${allPump ? '<span class="pill">펌프</span>' : ''}</div>
      ${tag}
      <div class="row"><label>높이</label><input id="pp-height" type="text" value="${last.height}"/>${lenUnitSel("pp-heightUnit")}</div>
      ${isExtOnly ? "" : `<div class="row"><label>요구유량</label><input id="pp-demand" type="text" value="${last.demand ?? 0}" placeholder="기본 0"/>${flowUnitSel("pp-demandUnit")}</div>`}
      ${allPump ? `
      <div class="row"><label>펌프 규모</label><select id="pp-scale">${scaleOpts}</select></div>
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
        nodes.forEach(n => n.demand = isFinite(raw) ? raw * (FLOW_UNIT_TO_M3S[u] ?? 1) : 0);
      });
      pop.querySelector("#pp-demandUnit").addEventListener("change", () => demandInp.dispatchEvent(new Event("input")));
    }
    const scaleSel = pop.querySelector("#pp-scale");
    if (scaleSel) scaleSel.addEventListener("change", e => { nodes.forEach(n => n.scale = e.target.value); draw(); });
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
      <div class="row"><label>직경 D(mm)🔒</label><input id="pp-diam" type="text" value="${last.fixedD != null && isFinite(last.fixedD) ? (last.fixedD * 1000).toFixed(1) : ''}" placeholder="비우면 D최적화"/></div>
      <div class="row"><label>최소직경 D_min</label><input id="pp-dmin" type="text" value="${last.minD != null && isFinite(last.minD) && last.minD > 0 ? (last.minD * 1000).toFixed(1) : ''}" placeholder="mm (없으면 제약 없음)"/></div>
      <div class="row"><label>최대직경 D_max</label><input id="pp-dmax" type="text" value="${last.maxD != null && isFinite(last.maxD) && last.maxD > 0 ? (last.maxD * 1000).toFixed(1) : ''}" placeholder="mm (없으면 제약 없음)"/></div>
      <div class="row"><label>고정유량🔒</label><input id="pp-flow" type="text" value="${last.fixedQ ?? ''}" placeholder="비우면 자동계산"/>${flowUnitSel("pp-flowUnit")}</div>
      <div class="row"><label>최소유량 Q_min</label><input id="pp-minq" type="text" value="${last.minQ != null && isFinite(last.minQ) && last.minQ > 0 ? (last.minQ * 3600).toFixed(4) : ''}" placeholder="m³/h (없으면 제약 없음)"/></div>
      <div class="row"><label>배관 Schedule</label><select id="pp-schedule">
        ${['SCH10','SCH20','SCH30','SCH40','SCH60','SCH80','SCH100','SCH120','SCH140','SCH160','XXS'].map(s=>`<option value="${s}" ${(last.schedule||'SCH40')===s?'selected':''}>${s}</option>`).join('')}
      </select><span style="font-size:11px;color:#888;margin-left:6px">NPS 변환 시 적용</span></div>
      <div class="row"><label>재질</label><select id="pp-material">${matOptions}</select></div>
      <div class="row"><label>조도ε(mm)</label><input id="pp-eps" type="text" value="${last.eps != null ? last.eps : defaultEps}"/></div>
      <div class="row"><label>C₁</label><input id="pp-c1" type="text" value="${last.c1 ?? ''}" placeholder="예: 1.5"/></div>
      <div class="row"><label>지수 n</label><input id="pp-nexp" type="text" value="${last.n_exp ?? ''}" placeholder="예: 1.7"/></div>
      <div class="hint" id="pp-cn-applied"></div>
      <div id="pp-fittings"></div>
    `;
    pop.querySelector("[data-close]").addEventListener("click", closePopup);
    pop.querySelector("#pp-diam").addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      pipes.forEach(p => p.fixedD = (isFinite(v) && v > 0) ? v / 1000 : null);
      draw();
    });
    pop.querySelector("#pp-dmin").addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      pipes.forEach(p => p.minD = (isFinite(v) && v > 0) ? v / 1000 : null);
      draw();
    });
    pop.querySelector("#pp-dmax").addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      pipes.forEach(p => p.maxD = (isFinite(v) && v > 0) ? v / 1000 : null);
      draw();
    });
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
    pop.querySelector("#pp-minq").addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      // 입력값은 m³/h, 내부 저장은 m³/s
      pipes.forEach(p => p.minQ = (isFinite(v) && v > 0) ? v / 3600 : null);
      draw();
    });
    pop.querySelector("#pp-schedule").addEventListener("change", e => {
      pipes.forEach(p => p.schedule = e.target.value);
    });
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
    const updateCNApplied = () => {
      const SM = window.SolverModule;
      const DC1 = (SM && isFinite(SM.DEFAULT_C1)) ? SM.DEFAULT_C1 : 1.5;
      const DN  = (SM && isFinite(SM.DEFAULT_N_EXP)) ? SM.DEFAULT_N_EXP : 1.7;
      const c1v = parseFloat(pop.querySelector("#pp-c1").value);
      const nv  = parseFloat(pop.querySelector("#pp-nexp").value);
      const note = (isFinite(c1v) || isFinite(nv)) ? '(직접입력)' : '(기본값)';
      const box = pop.querySelector("#pp-cn-applied");
      if (box) box.textContent = `▶ 적용값: C₁=${isFinite(c1v) ? c1v : DC1}, n=${isFinite(nv) ? nv : DN} ${note}`;
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
      ${allPumpLink ? `<div class="row"><label>설치높이(m)</label><input id="pp-height" type="text" value="${last.height ?? 0}"/></div>` : ""}
      <button id="pp-del" style="margin-top:6px;padding:5px 12px;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:5px;cursor:pointer;font-size:12px;">✕ 삭제</button>
    `;
    pop.querySelector("[data-close]").addEventListener("click", closePopup);
    pop.querySelector("#pp-flow").addEventListener("input", e => {
      const u = pop.querySelector("#pp-flowUnit").value;
      const raw = parseFloat(e.target.value);
      arrows.forEach(a=>a.flow = isFinite(raw) ? raw * (FLOW_UNIT_TO_M3S[u] ?? 1) : 0); draw();
    });
    pop.querySelector("#pp-flowUnit").addEventListener("change", () => pop.querySelector("#pp-flow").dispatchEvent(new Event("input")));
    const heightInp = pop.querySelector("#pp-height");
    if (heightInp) heightInp.addEventListener("input", e => { const v = parseFloat(e.target.value); arrows.forEach(a => { if (a.pumpNodeId != null) a.height = isFinite(v) ? v : 0; }); });
    pop.querySelector("#pp-del").addEventListener("click", () => {
      const delIds = new Set(arrows.map(a=>a.id));
      state.arrows = state.arrows.filter(a => !delIds.has(a.id));
      state.selected = []; draw(); renderSelPopup();
    });
  }

  /* ---- 부속(피팅) 인라인 편집 ---- */
  function renderFittingsInline(pipe, box) {
    if (!box) return;
    if (!pipe) { box.innerHTML = ""; return; }
    const FITTING_K = window.SolverModule.FITTING_K;
    const rows = pipe.fittingsK.map((f, i) => `
      <div class="row"><select data-fi="${i}">
        ${Object.keys(FITTING_K).map(k => `<option value="${k}" ${k===f?'selected':''}>${k} (K=${FITTING_K[k]})</option>`).join("")}
      </select><button data-rm="${i}" style="flex:0 0 28px;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;">✕</button></div>`).join("");
    const totalK = pipe.fittingsK.reduce((s, f) => s + (FITTING_K[f] || 0), 0);
    box.innerHTML = `<div class="hint" style="margin:6px 0 2px">부속 ΣK = <b style="color:var(--accent)">${totalK.toFixed(3)}</b></div>
      ${rows}<button id="addFit" style="margin-top:4px;padding:4px 10px;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:4px;cursor:pointer;font-size:12px;">+ 부속 추가</button>`;
    box.querySelectorAll("[data-fi]").forEach(sel => sel.addEventListener("change", e => {
      pipe.fittingsK[+e.target.dataset.fi] = e.target.value; renderFittingsInline(pipe, box);
    }));
    box.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", e => {
      pipe.fittingsK.splice(+e.target.dataset.rm, 1); renderFittingsInline(pipe, box);
    }));
    box.querySelector("#addFit").addEventListener("click", () => { pipe.fittingsK.push("90_elbow_standard"); renderFittingsInline(pipe, box); });
  }

  /* ---- power-law 회귀 (CatalogFitModule 에서 사용) ---- */
  function powerLawFit(points) {
    const N = points.length; if (N < 2) return null;
    const lnX = points.map(p => Math.log(p.x)), lnY = points.map(p => Math.log(p.y));
    const sX = lnX.reduce((a,b)=>a+b,0), sY = lnY.reduce((a,b)=>a+b,0);
    const sXY = lnX.reduce((a,x,i)=>a+x*lnY[i],0), sXX = lnX.reduce((a,x)=>a+x*x,0);
    const denom = N*sXX - sX*sX; if (Math.abs(denom) < 1e-15) return null;
    const n = (N*sXY - sX*sY) / denom;
    const lnC1 = (sY - n*sX) / N, C1 = Math.exp(lnC1);
    const mY = sY/N, ssTot = lnY.reduce((a,y)=>a+(y-mY)**2,0);
    const ssRes = lnY.reduce((a,y,i)=>{ const yp=lnC1+n*lnX[i]; return a+(y-yp)**2; },0);
    return { C1, n, R2: ssTot > 0 ? 1 - ssRes/ssTot : 1, lnC1 };
  }

  /* ================================================================
     INIT
     ================================================================ */
  function init(opts) {
    ids = opts;
    const wrap = document.getElementById(ids.wrapId);
    // 기존 <canvas id="cv"> 요소가 있으면 숨김
    const oldCv = document.getElementById(ids.canvasId);
    if (oldCv) oldCv.style.display = 'none';

    /* Konva.Stage는 container.innerHTML='' 로 내부를 초기화하므로
       selPopup/threeWrap/photoPanel 등 형제 요소가 지워지지 않도록
       전용 내부 div를 먼저 만들어 Konva 컨테이너로 사용한다 */
    let konvaDiv = document.getElementById('__konvaContainer');
    if (!konvaDiv) {
      konvaDiv = document.createElement('div');
      konvaDiv.id = '__konvaContainer';
      konvaDiv.style.cssText = 'position:absolute;inset:0;z-index:1;';
      wrap.insertBefore(konvaDiv, wrap.firstChild);
    }

    stage = new Konva.Stage({
      container: '__konvaContainer',
      width: wrap.clientWidth,
      height: wrap.clientHeight,
    });
    layer     = new Konva.Layer();
    tempLayer = new Konva.Layer();
    stage.add(layer);
    stage.add(tempLayer);

    window.addEventListener("resize", resizeCanvas);
    bindCanvasEvents();
    bindToolbar();
    draw();
    renderSelPopup();
  }

  /* ================================================================
     STATE 직렬화
     ================================================================ */
  function exportState() {
    return {
      nodes: state.nodes, pipes: state.pipes, arrows: state.arrows,
      nextNodeId: state.nextNodeId, nextPipeId: state.nextPipeId, nextArrowId: state.nextArrowId,
      loopDirections: state.loopDirections,
    };
  }
  function loadState(saved) {
    if (!saved) return;
    state.nodes          = saved.nodes || [];
    state.pipes          = saved.pipes || [];
    state.arrows         = saved.arrows || [];
    state.nextNodeId     = saved.nextNodeId || 0;
    state.nextPipeId     = saved.nextPipeId || 0;
    state.nextArrowId    = saved.nextArrowId || 0;
    state.loopDirections = saved.loopDirections || {};
    state.selected = []; state.drag = null; state.pipeFirstNode = null; state.arrowDragFrom = null;
    draw(); renderSelPopup();
  }

  /* ================================================================
     PUBLIC API
     ================================================================ */
  return {
    init, draw, renderSelPopup,
    getState:   () => state,
    getCanvas:  () => layer ? layer.getCanvas()._canvas : null,
    nodeAt, pipeAt, arrowAt, powerLawFit,
    exportState, loadState,
    alignNodes,
    setSnap(en, sz) { snapEnabled = en; if (sz) snapSize = sz; },
    isSnapEnabled: () => snapEnabled,
  };
})();
