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
        const classKey = pumpNode.scale; // 'small' | 'medium' | 'large'
        if (!classKey || !db.pump_power_class[classKey]) return;
        const isExternal = state.arrows.some(a => a.pumpNodeId === pumpNode.id);
        if (!isExternal) return;
        globalComponents.push(db.pump_power_class[classKey]);
      });
    }
    const baseB = (db.base && db.base.b) || 0;
    const globalB = (baseB + globalComponents.reduce((s, c) => s + (c.b || 0), 0)) * multiplier;
    const globalF = globalComponents.reduce((s, c) => s + (c.F || 0), 0) * multiplier;

    // 2) 내부 펌프(배관으로 망에 연결) — 사용자가 지정한 배관(affectedPipeIds)에만 적용
    const internalContribs = []; // [{ pipeIds:Set<id>, component:{b,F} }]
    if (db.pump_power_class) {
      state.nodes.filter(n => n.isPump).forEach(pumpNode => {
        const classKey = pumpNode.scale;
        if (!classKey || !db.pump_power_class[classKey]) return;
        const isInternal = state.pipes.some(p => p.from === pumpNode.id || p.to === pumpNode.id);
        if (!isInternal) return;
        const pc = db.pump_power_class[classKey];
        const ids = Array.isArray(pumpNode.affectedPipeIds) ? pumpNode.affectedPipeIds : [];
        if (ids.length) internalContribs.push({ pipeIds: new Set(ids), component: pc });
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

  /* ── NPS (Nominal Pipe Size) 내경 테이블 — ASME B36.10M 기준 ──────────
     schedule별 {dn, od, id} 배열. id = 내경(mm), od = 외경(mm).
     SCH20/30/60/100/140는 NPS 8"(DN200) 이상에만 존재.
     SCH120/160/XXS는 NPS 4"(DN100)부터 존재(소구경은 SCH160/XXS만).
     nearestNPS(D_m, schedule) 에서 schedule 미지정 시 'SCH40' 기본 적용. */
  const NPS_SCHEDULE_TABLE = {
    'SCH10': [
      {dn:15,  od:21.34,  id:17.12}, {dn:20,  od:26.67,  id:22.45},
      {dn:25,  od:33.40,  id:27.86}, {dn:32,  od:42.16,  id:36.62},
      {dn:40,  od:48.26,  id:42.72}, {dn:50,  od:60.33,  id:54.79},
      {dn:65,  od:73.03,  id:66.93}, {dn:80,  od:88.90,  id:82.80},
      {dn:100, od:114.30, id:108.20},{dn:125, od:141.30, id:135.76},
      {dn:150, od:168.28, id:161.47},{dn:200, od:219.08, id:211.56},
      {dn:250, od:273.05, id:264.67},{dn:300, od:323.85, id:314.71},
      {dn:350, od:355.60, id:342.90},{dn:400, od:406.40, id:393.70},
      {dn:450, od:457.20, id:444.50},{dn:500, od:508.00, id:495.30},
      {dn:600, od:609.60, id:596.90}
    ],
    'SCH20': [
      {dn:200, od:219.08, id:206.38},{dn:250, od:273.05, id:260.35},
      {dn:300, od:323.85, id:311.15},{dn:350, od:355.60, id:339.76},
      {dn:400, od:406.40, id:390.56},{dn:450, od:457.20, id:441.36},
      {dn:500, od:508.00, id:488.94},{dn:600, od:609.60, id:590.54}
    ],
    'SCH30': [
      {dn:200, od:219.08, id:205.00},{dn:250, od:273.05, id:257.45},
      {dn:300, od:323.85, id:307.09},{dn:350, od:355.60, id:336.54},
      {dn:400, od:406.40, id:387.34},{dn:450, od:457.20, id:438.14},
      {dn:500, od:508.00, id:482.60},{dn:600, od:609.60, id:581.06}
    ],
    'SCH40': [
      {dn:15,  od:21.34,  id:15.80}, {dn:20,  od:26.67,  id:20.93},
      {dn:25,  od:33.40,  id:26.64}, {dn:32,  od:42.16,  id:35.04},
      {dn:40,  od:48.26,  id:40.90}, {dn:50,  od:60.33,  id:52.51},
      {dn:65,  od:73.03,  id:62.71}, {dn:80,  od:88.90,  id:77.92},
      {dn:100, od:114.30, id:102.26},{dn:125, od:141.30, id:128.19},
      {dn:150, od:168.28, id:154.06},{dn:200, od:219.08, id:202.72},
      {dn:250, od:273.05, id:254.51},{dn:300, od:323.85, id:304.79},
      {dn:350, od:355.60, id:333.34},{dn:400, od:406.40, id:381.00},
      {dn:450, od:457.20, id:428.66},{dn:500, od:508.00, id:477.82},
      {dn:600, od:609.60, id:574.64}
    ],
    'SCH60': [
      {dn:200, od:219.08, id:198.46},{dn:250, od:273.05, id:247.65},
      {dn:300, od:323.85, id:295.31},{dn:350, od:355.60, id:325.42},
      {dn:400, od:406.40, id:373.08},{dn:450, od:457.20, id:419.10},
      {dn:500, od:508.00, id:466.76},{dn:600, od:609.60, id:560.38}
    ],
    'SCH80': [
      {dn:15,  od:21.34,  id:13.88}, {dn:20,  od:26.67,  id:18.85},
      {dn:25,  od:33.40,  id:24.30}, {dn:32,  od:42.16,  id:32.46},
      {dn:40,  od:48.26,  id:38.10}, {dn:50,  od:60.33,  id:49.25},
      {dn:65,  od:73.03,  id:59.01}, {dn:80,  od:88.90,  id:73.66},
      {dn:100, od:114.30, id:97.18}, {dn:125, od:141.30, id:122.25},
      {dn:150, od:168.28, id:146.33},{dn:200, od:219.08, id:193.68},
      {dn:250, od:273.05, id:242.87},{dn:300, od:323.85, id:288.89},
      {dn:350, od:355.60, id:317.50},{dn:400, od:406.40, id:363.52},
      {dn:450, od:457.20, id:409.54},{dn:500, od:508.00, id:455.62},
      {dn:600, od:609.60, id:547.68}
    ],
    'SCH100': [
      {dn:200, od:219.08, id:188.90},{dn:250, od:273.05, id:236.53},
      {dn:300, od:323.85, id:280.97},{dn:350, od:355.60, id:307.94},
      {dn:400, od:406.40, id:354.02},{dn:450, od:457.20, id:398.48},
      {dn:500, od:508.00, id:442.92},{dn:600, od:609.60, id:531.82}
    ],
    'SCH120': [
      {dn:100, od:114.30, id:92.04}, {dn:125, od:141.30, id:115.90},
      {dn:150, od:168.28, id:139.73},{dn:200, od:219.08, id:184.12},
      {dn:250, od:273.05, id:230.17},{dn:300, od:323.85, id:273.05},
      {dn:350, od:355.60, id:300.02},{dn:400, od:406.40, id:344.48},
      {dn:450, od:457.20, id:387.34},{dn:500, od:508.00, id:431.80},
      {dn:600, od:609.60, id:517.56}
    ],
    'SCH140': [
      {dn:200, od:219.08, id:177.83},{dn:250, od:273.05, id:222.25},
      {dn:300, od:323.85, id:266.69},{dn:350, od:355.60, id:292.10},
      {dn:400, od:406.40, id:333.34},{dn:450, od:457.20, id:377.85},
      {dn:500, od:508.00, id:419.10},{dn:600, od:609.60, id:504.85}
    ],
    'SCH160': [
      {dn:15,  od:21.34,  id:11.78}, {dn:20,  od:26.67,  id:15.55},
      {dn:25,  od:33.40,  id:20.70}, {dn:32,  od:42.16,  id:29.46},
      {dn:40,  od:48.26,  id:33.99}, {dn:50,  od:60.33,  id:42.85},
      {dn:65,  od:73.03,  id:53.98}, {dn:80,  od:88.90,  id:66.65},
      {dn:100, od:114.30, id:87.32}, {dn:125, od:141.30, id:109.55},
      {dn:150, od:168.28, id:131.76},{dn:200, od:219.08, id:173.06},
      {dn:250, od:273.05, id:215.89},{dn:300, od:323.85, id:257.20},
      {dn:350, od:355.60, id:284.17},{dn:400, od:406.40, id:325.42},
      {dn:450, od:457.20, id:366.71},{dn:500, od:508.00, id:407.98},
      {dn:600, od:609.60, id:490.52}
    ],
    'XXS': [
      {dn:15,  od:21.34,  id:6.40},  {dn:20,  od:26.67,  id:11.03},
      {dn:25,  od:33.40,  id:15.22}, {dn:32,  od:42.16,  id:22.76},
      {dn:40,  od:48.26,  id:27.94}, {dn:50,  od:60.33,  id:38.18},
      {dn:65,  od:73.03,  id:44.99}, {dn:80,  od:88.90,  id:58.42},
      {dn:100, od:114.30, id:80.06}
    ]
  };
  /* ── 대구경(DN600 초과) 데이터 보강 ──────────────────────────────────
     위 표는 모든 schedule이 DN600에서 끝난다. 그보다 큰 D를 NPS로 변환하면
     nearestNPS가 무조건 DN600 행에 클램프되어 버려, 실제 D*와 변환된 NPS
     직경의 차이가 비정상적으로 커지는 문제가 있었다(특히 대용량 배관망).
     ASME B36.10M은 NPS 80"(DN2000)까지 정의하지만 schedule별 정확한 두께를
     전부 옮기는 대신, 각 schedule의 마지막(DN600) 두께를 그대로 유지한다는
     근사(대구경에서 STD/XS 등급은 실제로 두께가 거의 일정하게 유지되는
     경향과 부합)로 DN1200까지 행을 자동 추가해 외삽 클램프를 방지한다. */
  (function extendLargeBore() {
    const EXTRA_DN_OD = [
      [650, 660.4], [700, 711.2], [750, 762.0], [800, 812.8],
      [900, 914.4], [1000, 1016.0], [1050, 1066.8], [1200, 1219.2],
    ];
    Object.keys(NPS_SCHEDULE_TABLE).forEach(sch => {
      const rows = NPS_SCHEDULE_TABLE[sch];
      const last = rows[rows.length - 1];
      const wallT = (last.od - last.id) / 2;   // 마지막 행 두께를 상수로 근사 유지
      EXTRA_DN_OD.forEach(([dn, od]) => {
        if (od <= last.od) return;             // 이미 표에 있는 범위는 건너뜀
        rows.push({ dn, od, id: Math.max(od - 2 * wallT, od * 0.5) });
      });
    });
  })();
  /* schedule 코드 정규화 (사용자 입력 → 내부 키) */
  const SCH_ALIAS = {
    'STD':'SCH40','STANDARD':'SCH40',
    'XS':'SCH80','EXTRASTTRONG':'SCH80',
    'SCH5':'SCH10',
    'SCH10S':'SCH10','SCH40S':'SCH40','SCH80S':'SCH80'
  };
  function normalizeSch(s) {
    if (!s) return 'SCH40';
    const u = String(s).toUpperCase().replace(/\s/g,'').replace(/^SCH\.?/,'SCH');
    return SCH_ALIAS[u] || (NPS_SCHEDULE_TABLE[u] ? u : 'SCH40');
  }
  /* nearestNPS: schedule을 고려해 가장 가까운 내경의 NPS를 반환
     인수: D_m (m), schedule (문자열, 예: 'SCH40')
     반환: { D_m, D_mm, DN, schedule } */
  function nearestNPS(D_m, schedule) {
    const D_mm = D_m * 1000;
    const sch = normalizeSch(schedule);
    const rows = NPS_SCHEDULE_TABLE[sch] || NPS_SCHEDULE_TABLE['SCH40'];
    let best = rows[0], bestDiff = Math.abs(rows[0].id - D_mm);
    for (let i = 1; i < rows.length; i++) {
      const diff = Math.abs(rows[i].id - D_mm);
      if (diff < bestDiff) { bestDiff = diff; best = rows[i]; }
    }
    return { D_m: best.id / 1000, D_mm: best.id, DN: best.dn, schedule: sch };
  }
  /* 하위 호환: 구형 단일 배열 (SCH40 기준) — 외부 참조 시 사용 */
  const NPS_INNER_MM = NPS_SCHEDULE_TABLE['SCH40'].map(r => r.id);
  const NPS_DN       = NPS_SCHEDULE_TABLE['SCH40'].map(r => r.dn);

  /* Hardy-Cross Only — D 고정, Q만 수렴
     ─ 각 배관의 D: fixedD > p.D 순서 적용, 둘 다 없으면 오류 반환
     ─ Q 초기값: fixedQ > 이전 계산 결과 Q > 0.01 m³/s */
  function solveNetworkHConly(state, gp, opts) {
    if (state.pipes.length === 0) return { error: "배관이 없습니다." };
    /* opts.qTol / opts.maxIter: 정밀도가 덜 중요한 대량 샘플링(회귀 등)에서
       완화된 허용오차·반복상한을 넘겨 연산량을 줄이기 위한 옵션 (저사양 대응) */
    const tol     = (opts && isFinite(opts.qTol)   && opts.qTol   > 0) ? opts.qTol   : Q_TOL;
    const maxIter = (opts && isFinite(opts.maxIter) && opts.maxIter > 0) ? opts.maxIter : 20000;

    // D 확정 (fixedD 우선, 없으면 p.D, 둘 다 없으면 오류)
    const missingD = [];
    state.pipes.forEach(p => {
      if (p.fixedD != null && isFinite(p.fixedD) && p.fixedD > 0) {
        p.D = p.fixedD;
      } else if (p.D != null && isFinite(p.D) && p.D > 0) {
        /* p.D 그대로 유지 (이전 최적화/NPS 변환 결과) */
      } else {
        missingD.push('P' + p.id);
      }
    });
    if (missingD.length > 0) {
      return { error: `D 미입력 배관: ${missingD.join(', ')} — 직경을 직접 입력하거나 Q+D Iteration을 먼저 실행하세요.` };
    }

    // Q 초기화
    state.pipes.forEach(p => {
      p.locked = (p.fixedQ != null && isFinite(p.fixedQ));
      p.Q = p.locked ? p.fixedQ : (p.Q != null && isFinite(p.Q) && p.Q !== 0 ? p.Q : 0.01);
    });

    const arrows = state.arrows || [];
    const isExtOnlyPump = (n) => n.isPump && arrows.some(a => a.pumpNodeId === n.id) && !state.pipes.some(p => p.from === n.id || p.to === n.id);
    const nodeDemand = state.nodes.reduce((s, n) => s + (n.demand > 0 && !isExtOnlyPump(n) ? n.demand : 0), 0);
    const outDemand = arrows.filter(a => (a.flow || 0) < 0).reduce((s, a) => s + Math.abs(a.flow), 0) + nodeDemand;
    const Q_out_m3h = outDemand > 0 ? outDemand * 3600 : null;

    const bf = calcBF(state, gp);
    const loops = findLoops(state);

    /* ── 내부 HC 루프 (adaptive relaxation) ── */
    function runHCloop() {
      let lastMaxDQ = 0, it = 0;
      let relax = 1.0, prevMDQ = Infinity, noP = 0;
      for (it = 0; it < maxIter; it++) {
        state.pipes.forEach(p => {
          const A = pipeArea(p.D);
          const v = Math.max(Math.abs(p.Q), 1e-9) / A;
          const Re = gp.rho * v * p.D / gp.mu;
          const f = colebrookF(Re, pipeEps(p) / p.D);
          const sumK = (p.fittingsK || []).reduce((s, k) => s + (FITTING_K[k] || 0), 0);
          p._Kp = (f * p.length / p.D + sumK) / (2 * G * A * A);
        });
        let maxDQ = 0;
        loops.forEach(loop => {
          let num = 0, den = 0;
          loop.edges.forEach(({ pipe, dir }) => {
            const Q = pipe.Q * dir;
            num += pipe._Kp * Q * Math.abs(Q);
            if (!pipe.locked) den += 2 * pipe._Kp * Math.abs(Q);
          });
          if (den < 1e-15) return;
          const dQ = relax * (-num / den);
          loop.edges.forEach(({ pipe, dir }) => { if (!pipe.locked) pipe.Q += dir * dQ; });
          maxDQ = Math.max(maxDQ, Math.abs(dQ));
        });
        lastMaxDQ = maxDQ;
        if (loops.length === 0 || maxDQ < tol) break;
        if (maxDQ > prevMDQ * 0.99) {
          noP++;
          if (noP >= 3) { relax = Math.max(0.05, relax * 0.6); noP = 0; }
        } else {
          noP = 0;
          /* 과이완은 풀 정밀도(낮은 tol)에서 오히려 진동/미수렴을 유발할 수 있어
             1.0 이하로 제한 — 안정적인 수렴을 우선함 */
          if (relax < 1.0) relax = Math.min(1.0, relax * 1.05);
        }
        prevMDQ = maxDQ;
      }
      return { converged: lastMaxDQ < tol || loops.length === 0, iterations: it };
    }

    /* ── 1차 HC 수렴 ── */
    let hcResult = runHCloop();

    /* ── minQ 강제 적용 루프 (수렴 후 위반 배관을 잠그고 재실행) ── */
    const minQLockedIds = new Set();
    for (let mi = 0; mi < state.pipes.length + 1; mi++) {
      const violated = state.pipes.filter(p =>
        !p.locked &&
        p.minQ != null && isFinite(p.minQ) && p.minQ > 0 &&
        Math.abs(p.Q) < p.minQ
      );
      if (!violated.length) break;
      violated.forEach(p => {
        const sign = Math.abs(p.Q) > 1e-10 ? Math.sign(p.Q) : 1;
        p.Q = sign * p.minQ;
        p.locked = true;
        minQLockedIds.add(p.id);
      });
      hcResult = runHCloop();
    }

    return {
      converged: hcResult.converged,
      iterations: hcResult.iterations,
      loops: loops.length,
      minQEnforced: minQLockedIds.size > 0 ? [...minQLockedIds] : null,
      Q_out_m3h, gp, bf,
      mode: 'hc_only',
    };
  }

  /* 이중 루프 반복 (Outer: D 수렴, Inner: Hardy-Cross Q 수렴)
     ─ 외부 루프: D 고정 → 내부 Hardy-Cross Q 수렴 → D_opt(Q) 재계산 → D relaxation 업데이트 → D 수렴 판정
     ─ 내부 루프: 현재 D로 K_p 계산 → Hardy-Cross ΔQ 보정 → max|ΔQ| < Q_TOL 까지 반복
     ─ D 업데이트: D_new = D_old + D_RELAX × (D_opt(Q) − D_old),  D_RELAX = 0.3
     ─ 외부 수렴 판정: max(|ΔD| / D_old) < D_TOL */
  const D_RELAX = 0.3;
  const D_TOL   = 1e-4;
  const Q_TOL   = 1e-7;

  function solveNetwork(state, gp) {
    if (state.pipes.length === 0) { return { error: "배관이 없습니다." }; }

    // 초기 Q 설정
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

    const bf = calcBF(state, gp);
    const loops = findLoops(state);
    const bfFor = (p) => (bf && bf.perPipe && bf.perPipe[p.id]) ? bf.perPipe[p.id] : null;

    // 초기 D 추정: D_opt(Q_initial), fixedD가 있으면 그 값 사용
    state.pipes.forEach(p => {
      if (p.fixedD != null && isFinite(p.fixedD)) {
        p.D = p.fixedD;
      } else {
        const d0 = doptForQ(p.Q, p, gp, bfFor(p));
        let dInit = (d0 != null && d0 > 0) ? d0 : 0.05;
        if (p.minD != null && isFinite(p.minD) && p.minD > 0) dInit = Math.max(dInit, p.minD);
        if (p.maxD != null && isFinite(p.maxD) && p.maxD > 0) dInit = Math.min(dInit, p.maxD);
        p.D = dInit;
      }
    });

    let lastMaxDeltaQ = 0, lastMaxDeltaD = 0, outerIter = 0;

    for (outerIter = 0; outerIter < 300; outerIter++) {
      // 이전 D 저장
      const Dprev = state.pipes.map(p => p.D);

      // ── 내부 루프: D 고정, Hardy-Cross Q 수렴 (adaptive relaxation) ──
      let innerRelax = 1.0, innerPrev = Infinity, innerNoProg = 0;
      for (let inner = 0; inner < 5000; inner++) {
        // K_p 계산 (현재 D 사용) — Q=0 방지
        state.pipes.forEach(p => {
          const D = p.D || 0.05;
          const A = pipeArea(D);
          const v = Math.max(Math.abs(p.Q), 1e-9) / A;
          const Re = gp.rho * v * D / gp.mu;
          const f = colebrookF(Re, pipeEps(p) / D);
          const sumK = (p.fittingsK || []).reduce((s, k) => s + (FITTING_K[k] || 0), 0);
          p._Kp = (f * p.length / D + sumK) / (2 * G * A * A);
        });

        // Hardy-Cross 루프 보정
        let maxDeltaQ = 0;
        loops.forEach(loop => {
          let num = 0, den = 0;
          loop.edges.forEach(({ pipe, dir }) => {
            const Q = pipe.Q * dir;
            num += pipe._Kp * Q * Math.abs(Q);
            if (!pipe.locked) den += 2 * pipe._Kp * Math.abs(Q);
          });
          if (den < 1e-15) return;
          const dQ = innerRelax * (-num / den);
          loop.edges.forEach(({ pipe, dir }) => { if (!pipe.locked) pipe.Q += dir * dQ; });
          maxDeltaQ = Math.max(maxDeltaQ, Math.abs(dQ));
        });
        lastMaxDeltaQ = maxDeltaQ;
        if (loops.length === 0 || maxDeltaQ < Q_TOL) break;

        // 진동 감지 → relax 감소
        if (maxDeltaQ > innerPrev * 0.99) {
          innerNoProg++;
          if (innerNoProg >= 3) { innerRelax = Math.max(0.05, innerRelax * 0.6); innerNoProg = 0; }
        } else {
          innerNoProg = 0;
          if (innerRelax < 1.0) innerRelax = Math.min(1.0, innerRelax * 1.05);
        }
        innerPrev = maxDeltaQ;
      }

      // ── minQ 강제 적용: 위반 배관을 잠그고 HC 재실행 ──
      for (let mi = 0; mi < state.pipes.length + 1; mi++) {
        const violated = state.pipes.filter(p =>
          !p.locked &&
          p.minQ != null && isFinite(p.minQ) && p.minQ > 0 &&
          Math.abs(p.Q) < p.minQ
        );
        if (!violated.length) break;
        violated.forEach(p => {
          const sign = Math.abs(p.Q) > 1e-10 ? Math.sign(p.Q) : 1;
          p.Q = sign * p.minQ;
          p.locked = true;
        });
        // minQ 잠금 후 내부 HC 재수렴
        let r2 = 1.0, p2 = Infinity, n2 = 0;
        for (let ii = 0; ii < 5000; ii++) {
          state.pipes.forEach(p => {
            const D = p.D || 0.05, A = pipeArea(D);
            const v = Math.max(Math.abs(p.Q), 1e-9) / A;
            const Re = gp.rho * v * D / gp.mu;
            const f = colebrookF(Re, pipeEps(p) / D);
            const sumK = (p.fittingsK || []).reduce((s, k) => s + (FITTING_K[k] || 0), 0);
            p._Kp = (f * p.length / D + sumK) / (2 * G * A * A);
          });
          let mq = 0;
          loops.forEach(loop => {
            let num = 0, den = 0;
            loop.edges.forEach(({ pipe, dir }) => {
              const Q = pipe.Q * dir;
              num += pipe._Kp * Q * Math.abs(Q);
              if (!pipe.locked) den += 2 * pipe._Kp * Math.abs(Q);
            });
            if (den < 1e-15) return;
            const dQ = r2 * (-num / den);
            loop.edges.forEach(({ pipe, dir }) => { if (!pipe.locked) pipe.Q += dir * dQ; });
            mq = Math.max(mq, Math.abs(dQ));
          });
          lastMaxDeltaQ = mq;
          if (loops.length === 0 || mq < Q_TOL) break;
          if (mq > p2 * 0.99) { n2++; if (n2 >= 3) { r2 = Math.max(0.05, r2 * 0.6); n2 = 0; } }
          else { n2 = 0; if (r2 < 1.0) r2 = Math.min(1.0, r2 * 1.05); }
          p2 = mq;
        }
      }

      // ── D 업데이트 (relaxation 0.3) + 수렴 판정 ────────────────
      let maxDeltaD = 0;
      state.pipes.forEach((p, i) => {
        if (p.fixedD != null && isFinite(p.fixedD)) return; // fixedD 배관은 건드리지 않음
        const dOpt = doptForQ(p.Q, p, gp, bfFor(p));
        if (dOpt == null || dOpt <= 0) return;
        const dOld = Dprev[i];
        let dNew = dOld + D_RELAX * (dOpt - dOld);
        if (p.minD != null && isFinite(p.minD) && p.minD > 0) dNew = Math.max(dNew, p.minD);
        if (p.maxD != null && isFinite(p.maxD) && p.maxD > 0) dNew = Math.min(dNew, p.maxD);
        const relErr = dOld > 1e-9 ? Math.abs(dNew - dOld) / dOld : Math.abs(dNew - dOld);
        maxDeltaD = Math.max(maxDeltaD, relErr);
        p.D = dNew;
      });
      lastMaxDeltaD = maxDeltaD;

      if (loops.length === 0 || maxDeltaD < D_TOL) break;
    }

    return {
      converged: lastMaxDeltaD < D_TOL || loops.length === 0,
      iterations: outerIter,
      loops: loops.length,
      Q_out_m3h, gp, bf
    };
  }

  return {
    G, FITTING_K, DEFAULT_EPS_MM,
    DEFAULT_C1, DEFAULT_N_EXP, DEFAULT_B, DEFAULT_F,
    NPS_SCHEDULE_TABLE, NPS_INNER_MM, NPS_DN, nearestNPS, normalizeSch,
    pipeArea, colebrookF, calcCRF, pipeEps, calcBF, computePumpHeads,
    findLoops, doptForQ, solveNetwork, solveNetworkHConly
  };
})();
