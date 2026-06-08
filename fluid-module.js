/* ============================================================
   FluidModule — 유체 선택 + 물성(ρ, μ) 계산
   ─ 단순 유체: 고정 ρ, μ
   ─ 온도/압력 의존 유체: poly_T / vogel(VFT) / virial_TP / power_T_exp_P
   ─ 사용법:
       FluidModule.init({
         selectId: "g-fluid", T_rowId: "g-T-row", P_rowId: "g-P-row",
         T_id: "g-T", P_id: "g-P", outId: "g-fluid-props"
       });
       FluidModule.getProps()  → { rho, mu, name, T_C?, P_bar?, range? }
   ============================================================ */
window.FluidModule = (function () {

  // 유체 물성 데이터 — fluids.json 에서 비동기 로드 (init 시 fetch)
  let FLUID_DB = null;
  const FLUID_JSON_PATH = "fluids.json";

  /* ---------- helpers ---------- */
  function toCelsius(v, unit) {
    if (unit === "°F") return (v - 32) * 5 / 9;
    if (unit === "K") return v - 273.15;
    return v; // °C
  }
  function toBar(v, unit) {
    if (unit === "atm") return v * 1.01325;
    if (unit === "psi") return v * 0.0689476;
    if (unit === "kPa") return v / 100;
    return v; // bar
  }

  function fluidNeedsTP(name) {
    const f = FLUID_DB[name];
    return f && (typeof f.density === "object" || typeof f.viscosity === "object");
  }
  function polyT(coeffs, T) {
    // coeffs: 최고차항부터, ex) [c3,c2,c1,c0] -> c3*T^3 + c2*T^2 + c1*T + c0
    const n = coeffs.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += coeffs[i] * Math.pow(T, n - 1 - i);
    return s;
  }
  function evalDensity(spec, T_C, P_bar) {
    if (typeof spec === "number") return spec;
    if (spec.form === "poly_T") {
      const T = spec.T_unit === "K" ? T_C + 273.15 : T_C;
      return polyT(spec.coeffs, T);
    }
    if (spec.form === "virial_TP") {
      const T_K = T_C + 273.15, P_Pa = P_bar * 1e5;
      const c = spec.Z_coeffs;
      const Z = 1 + c.P*P_bar + c.P2*P_bar*P_bar + c.PT*P_bar*T_K
                  + c.P2T*P_bar*P_bar*T_K + c.PT2*P_bar*T_K*T_K;
      return (P_Pa * spec.M_kg_per_mol) / (Z * spec.R * T_K);
    }
    return null;
  }
  function evalViscosity(spec, T_C, P_bar) {
    if (typeof spec === "number") return spec;
    if (spec.form === "vogel") {
      const T = spec.T_unit === "K" ? T_C + 273.15 : T_C;
      return Math.exp(spec.A + spec.B / (T - spec.C)); // VFT 식 (Pa·s)
    }
    if (spec.form === "power_T_exp_P") {
      const T = spec.T_unit === "K" ? T_C + 273.15 : T_C;
      return spec.A * Math.pow(T, spec.n) * Math.exp(spec.alpha_P * P_bar);
    }
    return null;
  }

  /* ---------- state / DOM ---------- */
  let ids = null;

  function getProps() {
    const sel = document.getElementById(ids.selectId);
    if (!FLUID_DB) return { rho: null, mu: null, name: null };
    const name = sel ? sel.value : "water";
    const f = FLUID_DB[name] || FLUID_DB["water"];
    if (!fluidNeedsTP(name)) return { rho: f.density, mu: f.viscosity, name };
    const T = parseFloat(document.getElementById(ids.T_id)?.value);
    const P = parseFloat(document.getElementById(ids.P_id)?.value);
    const Tunit = document.getElementById(ids.T_unitId)?.value || "°C";
    const Punit = document.getElementById(ids.P_unitId)?.value || "bar";
    const T_C = isFinite(T) ? toCelsius(T, Tunit) : 25;
    const P_bar = isFinite(P) ? toBar(P, Punit) : 1.013;
    return {
      rho: evalDensity(f.density, T_C, P_bar),
      mu:  evalViscosity(f.viscosity, T_C, P_bar),
      name, T_C, P_bar, range: f.valid_range,
    };
  }

  function refresh() {
    const sel = document.getElementById(ids.selectId);
    const box = document.getElementById(ids.outId);
    if (!FLUID_DB) { if (box) box.textContent = "fluids.json 로딩 중..."; return; }
    const needsTP = fluidNeedsTP(sel.value);
    const Trow = document.getElementById(ids.T_rowId);
    const Prow = document.getElementById(ids.P_rowId);
    if (Trow) Trow.style.display = needsTP ? "" : "none";
    if (Prow) Prow.style.display = needsTP ? "" : "none";
    const p = getProps();
    if (!box) return;
    let extra = "";
    if (p.range) extra = ` · 적용범위 T=${p.range.T_C[0]}~${p.range.T_C[1]}°C, P=${p.range.P_bar[0]}~${p.range.P_bar[1]} bar`;
    box.textContent = (p.rho != null && p.mu != null)
      ? `ρ = ${p.rho.toFixed(4)} kg/m³, μ = ${p.mu.toExponential(4)} Pa·s${extra}`
      : "물성 계산 불가 — T/P 범위를 확인하세요.";
  }

  function populateSelect() {
    const sel = document.getElementById(ids.selectId);
    if (!sel || !FLUID_DB) return;
    sel.innerHTML = Object.keys(FLUID_DB)
      .map(k => `<option value="${k}" ${k === "water" ? "selected" : ""}>${k}</option>`)
      .join("");
  }

  async function init(opts) {
    ids = opts;
    const sel = document.getElementById(ids.selectId);
    if (!sel) { console.error("[FluidModule] select element not found:", ids.selectId); return; }
    sel.addEventListener("change", refresh);
    document.getElementById(ids.T_id)?.addEventListener("input", refresh);
    document.getElementById(ids.P_id)?.addEventListener("input", refresh);
    document.getElementById(ids.T_unitId)?.addEventListener("change", refresh);
    document.getElementById(ids.P_unitId)?.addEventListener("change", refresh);
    refresh(); // "로딩 중..." 표시

    try {
      const res = await fetch(FLUID_JSON_PATH);
      if (!res.ok) throw new Error("HTTP " + res.status);
      FLUID_DB = await res.json();
    } catch (e) {
      console.error("[FluidModule] fluids.json 로드 실패 — 같은 폴더에 fluids.json 이 있는지 확인하세요.", e);
      const box = document.getElementById(ids.outId);
      if (box) box.textContent = "fluids.json 로드 실패 — 같은 폴더에 파일이 있는지 확인하세요.";
      return;
    }
    populateSelect();
    refresh();
  }

  return { init, getProps, getDB: () => FLUID_DB };
})();
