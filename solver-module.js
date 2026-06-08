/* ============================================================
   SolverModule — Hardy-Cross + Doptimization 결합 솔버
   ─ 순수 함수 위주: state/gp 를 인자로 받아 계산만 수행
   ─ 사용법:
       SolverModule.FITTING_K               // 부속 ΣK 룩업 테이블
       SolverModule.findLoops(state)
       SolverModule.solveNetwork(state, gp) // gp = getGlobalParams() 결과
   ============================================================ */
window.SolverModule = (function () {

  const G = 9.81;

  /* ---- 부속(피팅) ΣK 룩업 ---- */
  const FITTING_K = {
    "90_elbow_standard": 0.75, "90_elbow_long_radius": 0.45, "45_elbow_standard": 0.35,
    "coupling_union": 0.04, "swing_check_valve": 2.0, "gate_valve_open": 0.17, "globe_valve_open": 9, "ball_valve_open": 0
  };

  /* ---- 시스템 규모(소/중/대) 분류 로직 제거 — C₁, n, b, F 기본값을 고정 상수로 사용
        (배관별로 c1/n_exp을 직접 입력하면 그 값이 우선 적용됨) ---- */
  const DEFAULT_C1 = 1.5;
  const DEFAULT_N_EXP = 1.7;
  const DEFAULT_B = 0.05;
  const DEFAULT_F = 0.25;

  function calcCRF(iPercent, years) {
    const i = iPercent / 100;
    if (!isFinite(i) || !isFinite(years) || i <= 0 || years <= 0) return null;
    return (i * Math.pow(1 + i, years)) / (Math.pow(1 + i, years) - 1);
  }

  function pipeArea(D) { return Math.PI * D * D / 4; }
  function colebrookF(Re, epsD) {
    if (!isFinite(Re) || Re <= 0) return 0.03;
    if (Re < 2300) return 64 / Re;
    let f = 0.02;
    for (let i = 0; i < 40; i++) {
      const rhs = -2 * Math.log10(epsD / 3.7 + 2.51 / (Re * Math.sqrt(f)));
      const fn = 1 / (rhs * rhs);
      if (Math.abs(fn - f) / f < 1e-10) { f = fn; break; }
      f = fn;
    }
    return f;
  }

  /* ---- 단순 폐회로(루프) 탐색: spanning tree + back-edge ---- */
  function findLoops(state) {
    const nodes = state.nodes.map(n => n.id);
    const adj = {}; nodes.forEach(id => adj[id] = []);
    state.pipes.forEach(p => { adj[p.from].push(p); adj[p.to].push(p); });
    const visited = new Set(); const parent = {}; const treeEdges = new Set();
    const loops = [];

    function pathToRoot(node) {
      const path = [node];
      let cur = node;
      while (parent[cur]) { path.push(parent[cur][0]); cur = parent[cur][0]; }
      return path;
    }
    function traceLoop(u, v, extraPipe) {
      const pu = pathToRoot(u), pv = pathToRoot(v);
      const setU = new Set(pu);
      let lca = null;
      for (const x of pv) { if (setU.has(x)) { lca = x; break; } }
      if (lca == null) return null;
      const segU = pu.slice(0, pu.indexOf(lca));
      const segV = pv.slice(0, pv.indexOf(lca));
      const nodeSeq = [u];
      for (let i = 1; i < segU.length; i++) nodeSeq.push(segU[i]);
      nodeSeq.push(lca);
      for (let i = segV.length - 1; i >= 0; i--) nodeSeq.push(segV[i]);
      nodeSeq.push(u);
      const edges = [];
      for (let i = 0; i < nodeSeq.length - 1; i++) {
        const a = nodeSeq[i], b = nodeSeq[i + 1];
        let pipe = (i === nodeSeq.length - 2) ? extraPipe : adj[a].find(p => (p.from === a && p.to === b) || (p.from === b && p.to === a));
        if (!pipe) return null;
        const dir = (pipe.from === a) ? 1 : -1;
        edges.push({ pipe, dir });
      }
      return edges;
    }
    function bfs(start) {
      visited.add(start);
      const queue = [start];
      while (queue.length) {
        const u = queue.shift();
        adj[u].forEach(p => {
          const v = (p.from === u) ? p.to : p.from;
          if (!visited.has(v)) {
            visited.add(v); parent[v] = [u, p]; treeEdges.add(p.id); queue.push(v);
          } else if (!treeEdges.has(p.id) && !loops.find(L => L.extra === p.id)) {
            const loop = traceLoop(u, v, p);
            if (loop) loops.push({ extra: p.id, edges: loop });
          }
        });
      }
    }
    nodes.forEach(id => { if (!visited.has(id)) bfs(id); });
    return loops;
  }

  /* D_opt(Q): Doptimization 공식을 그대로 사용해 주어진 Q에서의 최적 직경을 Newton-Raphson 으로 계산 */
  const DEFAULT_EPS_MM = 0.045; // 배관별 조도 입력이 없을 때의 기본값 (mm)
  function pipeEps(pipe) {
    const v = pipe.eps;
    return (v != null && isFinite(v) ? v : DEFAULT_EPS_MM) / 1000; // mm -> m
  }

  /* ---- caculbF.json 기반 b, F 계산 ----
     ※ "외부 펌프"의 b,F만 배관망 전체에 동일하게 적용되고, 그 외 모든 성분은 해당 배관에만 적용됨

     base.b              : 모든 배관에 공통으로 더해지는 기본 유지보수비 계수 (배관마다 개별 가산 — 망 전체 동일값)
     fittings.default /
     valves.default      : 그 배관(pipe.fittingsK)에 들어간 부속·밸브에 대해서만 —
                           "valve"가 이름에 포함되면 valves.default, 아니면 fittings.default 계수를 그 배관에 더함
     height_factor       : 그 배관 양 끝 노드(from, to)의 높이차 |h_to - h_from| 으로 구간 분류 → 그 배관에만 적용
     pump_power_class    : 각 펌프 노드(node.isPump)에 개별 입력된 출력(kW, node.pumpPowerKW)으로 소/중/대 구간 분류
                           ─ ↗ 화살표로 다른 노드와 연결된 "외부 펌프" → b,F가 배관망 전체에 동일하게 적용 (전역)
                           ─ 배관으로 망에 연결된 "내부 펌프"          → 그 펌프 노드에서 사용자가 직접 선택한
                                                                         배관들(node.affectedPipeIds)에만 적용
     pump_count_multiplier: 펌프 대수는 별도로 곱하지 않고 출력(kW) 등급에 이미 포함된 것으로 간주 (=1)

     globalB/globalF = base.b + Σ(외부 펌프 성분)            (배관망 전체에 동일 적용)
     perPipe[pipeId] = { b, F } = 전역값 + 그 배관 자신의 부속/밸브 + 그 배관 양끝 높이차 + (해당 시) 내부 펌프 지정영역분 */
  function parseRangeKey(key) {
    const parts = String(key).split("_");
    const lo = parseFloat(parts[0]);
    const hi = /plus/i.test(parts[1] || "") ? Infinity : parseFloat(parts[1]);
    return [lo, hi];
  }
  function classifyByRange(table, value, rangeField) {
    if (value == null || !isFinite(value)) return null;
    for (const key of Object.keys(table)) {
      const entry = table[key];
      const [lo, hi] = rangeField ? (entry[rangeField] || []) : parseRangeKey(key);
      if (lo != null && hi != null && isFinite(lo) && isFinite(hi) && value >= lo && value <= hi) return entry;
      if (lo != null && hi === Infinity && value >= lo) return entry;
    }
    return null;
  }
  function calcBF(state, gp) {
    const db = window.RefData && window.RefData.caculbF;
    if (!db || !db.base) return null;
    const multiplier = 1; // 펌프 대수는 출력(kW) 등급에 포함된 것으로 간주 (사용자 합의)

    // 1) 배관망 전체에 동일하게 적용되는 전역 성분 — 기본 유지보수비 + "외부 펌프"만
    const globalComponents = [];
    if (db.pump_power_class) {
      state.nodes.filter(n => n.isPump).forEach(pumpNode => {
        if (pumpNode.pumpPowerKW == null || !isFinite(pumpNode.pumpPowerKW)) return;
        const isExternal = state.arrows.some(a => a.pumpNodeId === pumpNode.id);
        if (!isExternal) return;
        const pc = classifyByRange(db.pump_power_class, pumpNode.pumpPowerKW, "power_kW_range");
        if (pc) globalComponents.push(pc);
      });
    }
    const baseB = (db.base && db.base.b) || 0;
    const globalB = (baseB + globalComponents.reduce((s, c) => s + (c.b || 0), 0)) * multiplier;
    const globalF = globalComponents.reduce((s, c) => s + (c.F || 0), 0) * multiplier;

    // 2) 내부 펌프(배관으로 망에 연결) — 사용자가 지정한 배관(affectedPipeIds)에만 적용
    const internalContribs = []; // [{ pipeIds:Set<id>, component:{b,F} }]
    if (db.pump_power_class) {
      state.nodes.filter(n => n.isPump).forEach(pumpNode => {
        if (pumpNode.pumpPowerKW == null || !isFinite(pumpNode.pumpPowerKW)) return;
        const isInternal = state.pipes.some(p => p.from === pumpNode.id || p.to === pumpNode.id);
        if (!isInternal) return;
        const pc = classifyByRange(db.pump_power_class, pumpNode.pumpPowerKW, "power_kW_range");
        if (!pc) return;
        const ids = Array.isArray(pumpNode.affectedPipeIds) ? pumpNode.affectedPipeIds : [];
        if (ids.length) internalContribs.push({ pipeIds: new Set(ids), component: pc });
        // 적용 영역을 지정하지 않은 내부 펌프는 범위가 불명확하므로 b,F에 기여하지 않음
      });
    }

    // 3) 배관별 b,F = 전역값(기본+외부펌프) + 그 배관 자신의 부속/밸브 + 그 배관 양끝 높이차 + (해당 시) 내부 펌프 지정영역분
    const perPipe = {};
    let localCount = 0;
    state.pipes.forEach(p => {
      let b = globalB, F = globalF;

      (p.fittingsK || []).forEach(key => {
        const comp = /valve/i.test(key) ? (db.valves && db.valves.default) : (db.fittings && db.fittings.default);
        if (comp) { b += (comp.b || 0) * multiplier; F += (comp.F || 0) * multiplier; localCount++; }
      });

      if (db.height_factor) {
        const nA = state.nodes.find(n => n.id === p.from);
        const nB = state.nodes.find(n => n.id === p.to);
        if (nA && nB && isFinite(nA.height) && isFinite(nB.height)) {
          const diff = Math.abs(nB.height - nA.height);
          const hc = classifyByRange(db.height_factor, diff, null);
          if (hc) { b += (hc.b || 0) * multiplier; F += (hc.F || 0) * multiplier; localCount++; }
        }
      }

      internalContribs.forEach(({ pipeIds, component }) => {
        if (pipeIds.has(p.id)) { b += (component.b || 0) * multiplier; F += (component.F || 0) * multiplier; }
      });

      perPipe[p.id] = { b, F };
    });

    return {
      F_total: globalF, b_total: globalB,                 // 전역 공통값 (기본 유지보수비 + 외부 펌프) — 요약 표시용
      perPipe,                                             // 배관별 b,F (부속/밸브·높이차·내부 펌프 지정영역 모두 반영)
      count: globalComponents.length + internalContribs.length + localCount,
    };
  }

  /* ── 펌프별 H_total(양정) · Q(유량) · H_total×Q 계산 ──────────────────────────
     ※ solveNetwork 실행 후(각 배관의 Q, D, _Kp가 계산된 뒤) 호출해야 함
     ─ 외부 펌프(화살표로 연결) : 그 화살표가 연결된 노드에 직접 닿은 배관들이 범위(scope)
        Q = |arrow.flow|, 추가 양정 = 펌프 설치 높이(arrow.height) ↔ 연결 노드 높이차(흐름 방향 기준, 오르막만 가산)
     ─ 내부 펌프(배관으로 연결)   : 사용자가 지정한 affectedPipeIds가 범위(scope)
        Q = scope 배관들의 |Q| 평균
     공통: H_total = (펌프 자체 양정 가산분) + Σ(scope 배관의 마찰손실수두 |_Kp·Q·|Q||)
                                            + Σ(scope 배관의 흐름방향 오르막 높이차, 내리막은 0) */
  function computePumpHeads(state, gp) {
    const arrows = state.arrows || [];
    const out = [];
    state.nodes.filter(n => n.isPump).forEach(pumpNode => {
      const arrow = arrows.find(a => a.pumpNodeId === pumpNode.id);
      const isExternal = !!arrow;
      const isInternal = state.pipes.some(p => p.from === pumpNode.id || p.to === pumpNode.id);
      if (!isExternal && !isInternal) return;

      let scopePipes = [];
      let Q = null;
      let pumpOwnHead = 0;

      if (isExternal) {
        const netNode = state.nodes.find(n => n.id === arrow.nodeId);
        scopePipes = state.pipes.filter(p => p.from === arrow.nodeId || p.to === arrow.nodeId);
        Q = Math.abs(arrow.flow || 0);
      } else {
        const ids = Array.isArray(pumpNode.affectedPipeIds) ? pumpNode.affectedPipeIds : [];
        scopePipes = state.pipes.filter(p => ids.includes(p.id));
        if (scopePipes.length) {
          Q = scopePipes.reduce((s, p) => s + Math.abs(p.Q || 0), 0) / scopePipes.length;
        }
      }

      let frictionHead = 0, elevHead = 0;
      scopePipes.forEach(p => {
        if (p._Kp != null && isFinite(p.Q)) frictionHead += Math.abs(p._Kp * p.Q * Math.abs(p.Q));
        const nA = state.nodes.find(n => n.id === p.from);
        const nB = state.nodes.find(n => n.id === p.to);
        if (nA && nB && isFinite(nA.height) && isFinite(nB.height)) {
          elevHead += (p.Q >= 0) ? Math.max(0, nB.height - nA.height) : Math.max(0, nA.height - nB.height);
        }
      });

      const H_total = pumpOwnHead + elevHead + frictionHead;
      if (Q == null || !isFinite(Q) || Q <= 0 || !isFinite(H_total) || H_total <= 0) return;
      out.push({
        nodeId: pumpNode.id,
        kind: isExternal ? "external" : "internal",
        Q, H_total, HQ: H_total * Q,
        pipeIds: scopePipes.map(p => p.id),
      });
    });
    return out;
  }

  function doptForQ(Q, pipe, gp, bf) {
    if (Q === 0) return null;
    const rho = gp.rho, mu = gp.mu, eps = pipeEps(pipe);
    const mdot = rho * Math.abs(Q);
    // 배관별 C1, n이 입력되어 있으면 그 값을 우선 사용 (없으면 고정 기본값)
    const C1 = (pipe.c1 != null && isFinite(pipe.c1)) ? pipe.c1 : DEFAULT_C1;
    const nExp = (pipe.n_exp != null && isFinite(pipe.n_exp)) ? pipe.n_exp : DEFAULT_N_EXP;
    // b, F — caculbF.json 기반 배관별 계산값(bf.perPipe)이 있으면 그 값을, 없으면 고정 기본값을 사용
    const b = (bf && isFinite(bf.b)) ? bf.b : DEFAULT_B;
    const F = (bf && isFinite(bf.F)) ? bf.F : DEFAULT_F;
    const C2 = gp.C2, t = gp.t, eta = gp.eta;
    const a_crf = calcCRF(gp.i, gp.n);
    if (C2 == null || t == null || a_crf == null) return null;
    const sumK = pipe.fittingsK.reduce((s, k) => s + (FITTING_K[k] || 0), 0);
    const L = pipe.length;
    function RHS(D) {
      if (D <= 0) return null;
      const v = 4 * Math.abs(Q) / (Math.PI * D * D);
      const Re = rho * v * D / mu;
      const f = colebrookF(Re, eps / D);
      const Leq = sumK * D / f;
      const numer = 40 * f * Math.pow(mdot, 3) * C2 * t * (L + Leq);
      const denom = L * nExp * (a_crf + b) * (1 + F) * C1 * eta * Math.PI * Math.PI * rho * rho;
      if (denom <= 0 || numer <= 0) return null;
      return Math.pow(numer / denom, 1 / (nExp + 5));
    }
    let D = Math.max(0.005, Math.sqrt(4 * Math.abs(Q) / (Math.PI * 2)));
    for (let it = 0; it < 80; it++) {
      const r = RHS(D); if (r == null) return null;
      const g = D - r;
      const dD = D * 1e-5;
      const r2 = RHS(D + dD); if (r2 == null) return null;
      const gp_ = ((D + dD - r2) - g) / dD;
      if (Math.abs(gp_) < 1e-15) break;
      const Dn = Math.max(1e-6, D - g / gp_);
      if (Math.abs(Dn - D) < 1e-9 * Math.max(1, D)) { D = Dn; break; }
      D = Dn;
    }
    return D;
  }

  /* Hardy-Cross + Dopt 결합 반복:
     1) 각 배관의 추정 Q로 D_opt(Q) 계산 (Doptimization 공식)
     2) 그 D를 Darcy-Weisbach 손실계수 K_p = f·L /(2gD·A^2) 에 대입 → 등가 저항
     3) Hardy-Cross 루프 보정으로 Q 갱신
     4) 수렴까지 반복 (D와 Q가 서로를 갱신하는 이중 루프) */
  function solveNetwork(state, gp) {
    if (state.pipes.length === 0) { return { error: "배관이 없습니다." }; }
    // 고정 유량(fixedQ)이 입력된 배관은 "초기 추정값"이 아니라 항상 만족해야 하는 값 — Q를 고정하고 절대 보정하지 않음
    state.pipes.forEach(p => {
      p.locked = (p.fixedQ != null && isFinite(p.fixedQ));
      p.Q = p.locked ? p.fixedQ : 0.01;
    });

    // 경계 유출입: 화살표(arrows)의 유량 (+ = 유입, − = 유출) + 노드 요구유량(외부 펌프 전용 노드 제외)
    const arrows = state.arrows || [];
    const isExtOnlyPump = (n) => n.isPump &&
      arrows.some(a => a.pumpNodeId === n.id) &&
      !state.pipes.some(p => p.from === n.id || p.to === n.id);
    const nodeDemand = state.nodes.reduce((s, n) => s + (n.demand > 0 && !isExtOnlyPump(n) ? n.demand : 0), 0);
    const outDemand = arrows.filter(a => (a.flow || 0) < 0).reduce((s, a) => s + Math.abs(a.flow), 0) + nodeDemand;
    const Q_out_m3h = outDemand > 0 ? outDemand * 3600 : null;
    // caculbF.json이 로드되어 있으면 배관별 b,F는 그 데이터 기반 계산값(bf.perPipe)을 사용, 없으면 고정 기본값(DEFAULT_B/F) 사용
    const bf = calcBF(state, gp);

    const loops = findLoops(state);

    // 배관별 b,F 적용값 — 외부 펌프(전역) + 그 배관 자신의 부속/밸브·높이차 + (해당 시) 내부 펌프 지정영역 모두 반영된 값
    const bfFor = (p) => (bf && bf.perPipe && bf.perPipe[p.id]) ? bf.perPipe[p.id] : null;

    let lastMaxDelta = 0, outerIter = 0;
    for (outerIter = 0; outerIter < 60; outerIter++) {
      state.pipes.forEach(p => { p.D = (p.fixedD != null && isFinite(p.fixedD)) ? p.fixedD : doptForQ(p.Q, p, gp, bfFor(p)); });
      state.pipes.forEach(p => {
        const D = p.D || 0.05;
        const A = pipeArea(D);
        const v = Math.abs(p.Q) / A;
        const Re = gp.rho * v * D / gp.mu;
        const f = colebrookF(Re, pipeEps(p) / D);
        const sumK = p.fittingsK.reduce((s, k) => s + (FITTING_K[k] || 0), 0);
        p._Kp = (f * p.length / D + sumK) / (2 * G * A * A);
      });
      let maxDelta = 0;
      loops.forEach(loop => {
        let num = 0, den = 0;
        loop.edges.forEach(({ pipe, dir }) => {
          const Q = pipe.Q * dir;
          num += pipe._Kp * Q * Math.abs(Q);
          // 고정 유량(locked) 배관은 Q가 변하지 않으므로 보정 분모(d(hf)/dQ 합)에서 제외
          // — 손실은 num에 그대로 반영해 다른 배관들이 이 손실을 보상하도록 함
          if (!pipe.locked) den += 2 * pipe._Kp * Math.abs(Q);
        });
        if (den < 1e-12) return;
        const dQ = -num / den;
        loop.edges.forEach(({ pipe, dir }) => { if (!pipe.locked) pipe.Q += dir * dQ; });
        maxDelta = Math.max(maxDelta, Math.abs(dQ));
      });
      lastMaxDelta = maxDelta;
      if (loops.length === 0 || maxDelta < 1e-7) break;
    }

    return { converged: lastMaxDelta < 1e-6 || loops.length === 0, iterations: outerIter, loops: loops.length, Q_out_m3h, gp, bf };
  }

  return {
    G, FITTING_K, DEFAULT_EPS_MM,
    DEFAULT_C1, DEFAULT_N_EXP, DEFAULT_B, DEFAULT_F,
    pipeArea, colebrookF, calcCRF, pipeEps, calcBF, computePumpHeads,
    findLoops, doptForQ, solveNetwork
  };
})();
