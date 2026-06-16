/* ============================================================
   RegressionDoptModule — 회귀 기반 D 최적화
   ─────────────────────────────────────────────────────────────
   알고리즘:
   1. 각 배관 직경 Di를 D_ref × [dMinF, dMaxF] 범위에서 랜덤 샘플링 (nSamples회)
   2. 각 샘플 → Hardy-Cross 실행 → 전체 비용 C 계산
   3. 물리 기반 회귀 모델  C ≈ Σ_i (ã_i·(Di/Dref_i)^n_i  +  b̃_i·(Di/Dref_i)^{-5})
      → 최소자승 피팅 (정규방정식, Gaussian elimination)
   4. 해석적 최소화  Di* = Dref_i · (5·b̃_i / (n_i·ã_i))^{1/(n_i+5)}
   5. Di* 로 Hardy-Cross 재실행 → 최종 Q 확정, state 업데이트
   ============================================================ */
window.RegressionDoptModule = (function () {

  /* ── 정규방정식 풀기 (Gaussian elimination + partial pivoting) ── */
  function gaussSolve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);           // 첨가 행렬
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++)
        if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      if (Math.abs(M[col][col]) < 1e-20) return null;     // 특이 행렬
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const f = M[row][col] / M[col][col];
        for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /* ── 라틴 하이퍼큐브 샘플링(LHS) 테이블 생성 ──
     각 차원(배관)을 [0,1) 구간을 nSamples개 등간격 칸으로 나눠
     칸마다 1개씩(칸 내부는 랜덤) 뽑은 뒤, 차원별로 독립 셔플.
     → 순수 랜덤보다 공간을 고르게 채우고, 배관 간 우연한 상관을 줄여
       회귀 행렬(AᵗA) 조건을 안정화함.
     반환: table[i][k] ∈ [0,1) — i=배관 인덱스, k=샘플 인덱스 */
  function makeLHS(nSamples, N) {
    const table = [];
    for (let i = 0; i < N; i++) {
      const col = new Array(nSamples);
      for (let s = 0; s < nSamples; s++) col[s] = (s + Math.random()) / nSamples;
      /* Fisher–Yates 셔플: 차원별로 독립적으로 섞어 배관 간 상관 제거 */
      for (let s = nSamples - 1; s > 0; s--) {
        const j = Math.floor(Math.random() * (s + 1));
        [col[s], col[j]] = [col[j], col[s]];
      }
      table.push(col);
    }
    return table;
  }

  /* ── R² 계산 ── */
  function r2Score(Amat, coeffs, Ynorm) {
    const Yhat  = Amat.map(row => row.reduce((s, v, j) => s + v * coeffs[j], 0));
    const Ymean = Ynorm.reduce((s, v) => s + v, 0) / Ynorm.length;
    const SStot = Ynorm.reduce((s, v) => s + (v - Ymean) ** 2, 0);
    const SSres = Ynorm.reduce((s, v, k) => s + (v - Yhat[k]) ** 2, 0);
    return SStot < 1e-30 ? 1 : 1 - SSres / SStot;
  }

  /* ── 배관망 전체 연간 비용 계산 ── */
  function totalCost(workState, origState, gp, bf, DEF, SM) {
    const G = SM.G;
    const a_crf = SM.calcCRF(gp.i, gp.n);
    let sum = 0;
    for (const p of workState.pipes) {
      const orig = origState.pipes.find(pp => pp.id === p.id);
      if (!orig) continue;
      const D = p.D, Q = p.Q;
      if (!isFinite(D) || D <= 0 || !isFinite(Q)) return null;

      const pipeBF = bf && bf.perPipe && bf.perPipe[p.id];
      const c1   = (orig.c1    != null && isFinite(orig.c1))    ? orig.c1    : DEF.C1;
      const nexp = (orig.n_exp != null && isFinite(orig.n_exp)) ? orig.n_exp : DEF.n_exp;
      const bv   = (pipeBF    && isFinite(pipeBF.b)) ? pipeBF.b : DEF.b;
      const Fv   = (pipeBF    && isFinite(pipeBF.F)) ? pipeBF.F : DEF.F;
      const L    = orig.length;

      /* 자본 회수 */
      const cap = (a_crf != null)
        ? (a_crf + bv) * (1 + Fv) * c1 * Math.pow(D, nexp) * L : 0;

      /* 에너지 */
      const nA = origState.nodes.find(n => n.id === orig.from);
      const nB = origState.nodes.find(n => n.id === orig.to);
      const elev = (nA && nB && isFinite(nA.height) && isFinite(nB.height))
        ? Math.abs(nB.height - nA.height) : 0;
      const Ap = SM.pipeArea(D);
      const v  = Q / Ap;
      const Re = gp.rho * Math.abs(v) * D / gp.mu;
      const f  = SM.colebrookF(Re, SM.pipeEps(orig) / D);
      const hf = f * (L / D) * (v * Math.abs(v)) / (2 * G);
      const sumK = (orig.fittingsK || []).reduce((s, k) => s + (SM.FITTING_K[k] || 0), 0);
      const hm = sumK * (v * Math.abs(v)) / (2 * G);
      const H  = elev + Math.abs(hf) + Math.abs(hm);
      const eng = (isFinite(gp.C2) && isFinite(gp.t) && isFinite(gp.rho) && isFinite(gp.eta))
        ? gp.C2 * gp.t * gp.rho * G * Math.abs(Q) * H / gp.eta / 1000 : 0;

      sum += cap + eng;
    }
    return isFinite(sum) && sum > 0 ? sum : null;
  }

  /* ── 메인: run(state, gp, SM, options) ── */
  function run(state, gp, SM, options) {
    const {
      nSamples   = 700,
      dMinFactor = 0.25,
      dMaxFactor = 4.0,
      onProgress = () => {},
      onDone     = () => {},
      onError    = () => {},
    } = options || {};

    /* ① 최적화 대상 배관 (fixedD 없는 것만) */
    const freePipes = state.pipes.filter(
      p => !(p.fixedD != null && isFinite(p.fixedD) && p.fixedD > 0)
    );
    if (!freePipes.length) { onError("최적화할 배관이 없습니다 (모두 fixedD)."); return; }
    const N = freePipes.length;

    /* D 기준값 (샘플링 중심) */
    const Drefs = freePipes.map(p => {
      if (p.D   && isFinite(p.D)   && p.D   > 0) return p.D;
      if (p.minD && isFinite(p.minD) && p.minD > 0) return p.minD * 2;
      return 0.05;
    });

    /* 지수 n (배관별, 없으면 기본값) */
    const DEF   = { C1: SM.DEFAULT_C1, n_exp: SM.DEFAULT_N_EXP, b: SM.DEFAULT_B, F: SM.DEFAULT_F };
    const nExps = freePipes.map(p =>
      (p.n_exp != null && isFinite(p.n_exp)) ? p.n_exp : DEF.n_exp
    );
    const bf = SM.calcBF(state, gp);

    /* ② 작업 상태 (딥클론 1회 — 이후 재사용) */
    const workState = JSON.parse(JSON.stringify(state));

    /* LHS 샘플링 테이블 (배관별 [0,1) 좌표, 차원 간 셔플로 상관 제거) */
    const lhsTable = makeLHS(nSamples, N);

    const Xdata = [];   // 유효 샘플: freePipes 직경 [m]
    const Ydata = [];   // 유효 샘플: 전체 비용

    const BATCH = 50;   // 고사양 대응: 한 프레임당 처리량 상향(저사양 시 20이었음)
    let k = 0;

    /* 샘플링 단계는 회귀용 데이터 포인트일 뿐 최종 결과가 아니므로
       허용오차를 약간 완화(1e-7 → 1e-5)하고 반복상한을 낮춰(5000) 연산량을 줄이되,
       고사양 환경에서는 정밀도를 더 확보해 회귀 데이터 품질을 높임.
       최종 D* 확정 HC(아래 finalize 내부)는 옵션 없이(=풀 정밀도) 실행됨. */
    const SAMPLE_HC_OPTS = { qTol: 1e-5, maxIter: 5000 };

    /* ③ 배치별 샘플링 (비동기, UI 블로킹 방지) */
    function processBatch() {
      const end = Math.min(k + BATCH, nSamples);
      while (k < end) {
        /* 직경 랜덤화 */
        workState.pipes.forEach(p => {
          const fi = freePipes.findIndex(fp => fp.id === p.id);
          if (fi < 0) return;                           // fixedD 배관 유지
          const orig = state.pipes.find(pp => pp.id === p.id);
          const factor = dMinFactor + lhsTable[fi][k] * (dMaxFactor - dMinFactor);
          let D = Math.max(0.005, Drefs[fi] * factor); // 최소 5mm
          if (orig && orig.minD && isFinite(orig.minD) && orig.minD > 0)
            D = Math.max(D, orig.minD);
          if (orig && orig.maxD && isFinite(orig.maxD) && orig.maxD > 0)
            D = Math.min(D, orig.maxD);   // 샘플링 단계도 D_max 제약 적용 (기존엔 minD만 적용되던 누락 수정)
          p.D = D;
          /* warm-start Q: 이전 결과 유지 (없으면 0.01) */
          if (!isFinite(p.Q) || p.Q === 0) p.Q = 0.01;
        });

        /* Hardy-Cross 실행 (샘플링용 완화 옵션) */
        SM.solveNetworkHConly(workState, gp, SAMPLE_HC_OPTS);

        /* 비용 계산 */
        const cost = totalCost(workState, state, gp, bf, DEF, SM);
        if (cost != null) {
          Xdata.push(freePipes.map(fp => workState.pipes.find(p => p.id === fp.id).D));
          Ydata.push(cost);
        }
        k++;
      }

      onProgress(k, nSamples);

      if (k < nSamples) {
        setTimeout(processBatch, 0);   // 다음 배치
      } else {
        finalize();                    // 회귀 + 최적화
      }
    }

    /* ④ 회귀 및 최적화 */
    function finalize() {
      const M = Xdata.length;
      if (M < 2 * N + 5) {
        onError(`유효 샘플(${M}개)이 부족합니다. C₂·t·η 입력값을 확인하세요.`);
        return;
      }

      /* 정규화:
         feature = (Di / Dref_i)^n_i  또는  (Di / Dref_i)^{-5}
         y_norm  = C / C_mean   (수치 안정성) */
      const Cmean = Ydata.reduce((s, v) => s + v, 0) / M;

      const Amat = Xdata.map(xRow => {
        const row = [];
        for (let i = 0; i < N; i++)
          row.push(Math.pow(xRow[i] / Drefs[i], nExps[i]));  // (D/Dref)^n
        for (let i = 0; i < N; i++)
          row.push(Math.pow(xRow[i] / Drefs[i], -5));         // (D/Dref)^{-5}
        return row;
      });
      const Ynorm = Ydata.map(c => c / Cmean);

      /* 정규방정식 A^T A x = A^T y */
      const cols = 2 * N;
      const ATA  = Array.from({ length: cols }, () => new Array(cols).fill(0));
      const ATy  = new Array(cols).fill(0);
      for (let m = 0; m < M; m++) {
        for (let j = 0; j < cols; j++) {
          ATy[j] += Amat[m][j] * Ynorm[m];
          for (let l = 0; l < cols; l++)
            ATA[j][l] += Amat[m][j] * Amat[m][l];
        }
      }
      /* 릿지 정규화 (adaptive λ: trace 기반, 수치 안정성 강화)
         λ = max(trace(ATA) / cols × 1e-4, 1e-8) */
      const traceATA = ATA.reduce((s, row, j) => s + row[j], 0);
      const ridgeLambda = Math.max(traceATA / cols * 1e-4, 1e-8);
      for (let j = 0; j < cols; j++) ATA[j][j] += ridgeLambda;

      const coeffs = gaussSolve(ATA, ATy);
      if (!coeffs) { onError("회귀 행렬 역산 실패 — 배관 수 대비 샘플이 부족하거나 특이 행렬입니다."); return; }

      const aTilde = coeffs.slice(0, N);  // ã_i (정규화된 자본 계수)
      const bTilde = coeffs.slice(N);     // b̃_i (정규화된 에너지 계수)
      const R2 = r2Score(Amat, coeffs, Ynorm);

      /* 회귀 오차(계수 부호 이상) 시 대체용 — 샘플 중 비용(Ydata) 최솟값 인덱스.
         (이전엔 "회귀 최솟값" 비교 케이스를 위해 상위 K개를 풀 정밀도로
          재검증했으나, 그 비교 기능 자체를 삭제하면서 이 가벼운 버전으로 단순화함) */
      const bestIdx = Ydata.reduce((bi, v, i) => v < Ydata[bi] ? i : bi, 0);

      /* ⑤ 해석적 최소화
         D_i* = Dref_i · (5·b̃_i / (n_i·ã_i))^{1/(n_i+5)}
         ─ ai/bi ≤ 0 이면 검증된 최솟값 샘플의 직경으로 대체 (회귀 오류 방어)
         ─ Dref × [dMinFactor, dMaxFactor] 범위로 클리핑.
           ※ 과거엔 [0.12, 8.0]처럼 샘플링 범위보다 넓게 클리핑했는데, 그러면
             회귀 모델이 학습한 적 없는 영역(예: 매우 큰 D → 매우 낮은 유속 →
             낮은 Re → 층류 영역)으로 D*가 외삽될 수 있다. 그 영역에서 실제
             HC 재계산 시 에너지비용이 비정상적으로 낮게 나와 "D회귀최적화
             결과가 비정상적으로 낮다"는 현상의 원인이 됨 → 학습(샘플링)
             범위와 일치시켜 외삽을 방지함. */
      const D_star = freePipes.map((p, i) => {
        const ai = aTilde[i], bi2 = bTilde[i], ni = nExps[i];
        let Ds;
        if (ai > 0 && bi2 > 0) {
          Ds = Drefs[i] * Math.pow(5 * bi2 / (ni * ai), 1 / (ni + 5));
          /* 클리핑: 회귀 모델 학습 범위(샘플링 범위)와 일치시켜 외삽 방지 */
          Ds = Math.max(Drefs[i] * dMinFactor, Math.min(Drefs[i] * dMaxFactor, Ds));
        } else {
          /* 부호 이상 (회귀 오차) → 샘플 중 최솟값 직경 사용 */
          Ds = Xdata[bestIdx][i];
        }
        /* 사용자 제약 적용 */
        if (p.minD != null && isFinite(p.minD) && p.minD > 0) Ds = Math.max(Ds, p.minD);
        if (p.maxD != null && isFinite(p.maxD) && p.maxD > 0) Ds = Math.min(Ds, p.maxD);
        return Math.max(0.005, Ds);
      });

      /* ⑥ D* 적용 → 최종 Hardy-Cross (D 고정이므로 단일 호출로 수렴) */
      workState.pipes.forEach(wp => {
        const fi = freePipes.findIndex(fp => fp.id === wp.id);
        if (fi >= 0) wp.D = D_star[fi];
        /* Q warm-start: 마지막 샘플 결과 유지 */
      });
      const finalR = SM.solveNetworkHConly(workState, gp);

      /* ⑥-b D_star Q 저장 */
      const dstarQ = {};
      workState.pipes.forEach(wp => { dstarQ[wp.id] = wp.Q; });

      /* ⑦ 원본 state 업데이트 — D_star 값으로 복원 */
      workState.pipes.forEach(wp => {
        const orig = state.pipes.find(p => p.id === wp.id);
        const fi   = freePipes.findIndex(fp => fp.id === wp.id);
        if (orig) {
          orig.D = fi >= 0 ? D_star[fi] : wp.D;
          orig.Q = dstarQ[wp.id] ?? wp.Q;
        }
      });

      onDone({
        nSamples : M,
        nPipes   : N,
        R2,
        Cmean,
        aTilde, bTilde, nExps, Drefs,
        D_star,
        finalConverged : finalR.converged,
        finalIterations: finalR.iterations,
        pipeResults: freePipes.map((p, i) => ({
          id   : p.id,
          from : p.from,
          to   : p.to,
          Dref : Drefs[i],
          Dstar: D_star[i],
          Q    : state.pipes.find(pp => pp.id === p.id)?.Q,
          a    : aTilde[i],
          b    : bTilde[i],
          n    : nExps[i],
          aOk  : aTilde[i] > 0,
          bOk  : bTilde[i] > 0,
        })),
      });
    }

    /* 시작 */
    setTimeout(processBatch, 0);
  }

  return { run };
})();
