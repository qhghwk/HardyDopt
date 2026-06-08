/* ============================================================
   ThreeViewModule — 설계도 3D 시각화 (Three.js)
   ─ 캔버스 (x,y) 좌표를 3D (x, height, y) 로 변환해 노드/배관/높이기둥 렌더
   ─ 마우스 드래그로 궤도 회전 (OrbitControls 대체)
   ─ 사용법:
       ThreeViewModule.init({
         wrapId:"threeWrap", openBtnId:"btn-3d", closeBtnId:"btn-3d-close",
         getState: () => CanvasModule.getState(),
         getCanvas: () => CanvasModule.getCanvas()
       });
   ============================================================ */
window.ThreeViewModule = (function () {

  let ids = null;
  let scene = null, renderer = null, camera = null, animId = null;

  function showMessage(wrap, html) {
    while (wrap.children.length > 1) wrap.removeChild(wrap.lastChild);
    const div = document.createElement("div");
    div.style.cssText = "color:#f48771; font-size:13px; padding:60px 24px; line-height:1.7;";
    div.innerHTML = html;
    wrap.appendChild(div);
  }

  function open() {
    const wrap = document.getElementById(ids.wrapId);
    wrap.classList.add("show");
    if (renderer) { try { renderer.dispose(); } catch (e) {} renderer = null; }
    while (wrap.children.length > 1) wrap.removeChild(wrap.lastChild);

    // Three.js 가 로드되지 않은 경우 (CDN 차단/네트워크 문제 등) — 검은 화면 대신 안내 메시지 표시
    if (typeof THREE === "undefined") {
      showMessage(wrap, `Three.js 라이브러리를 불러오지 못했습니다.<br/>
        (CDN: cdnjs.cloudflare.com 접속이 차단되었거나 네트워크 연결이 없을 수 있습니다.)<br/>
        인터넷 연결을 확인하거나, three.min.js 파일을 같은 폴더에 내려받아<br/>
        &lt;script src="three.min.js"&gt;&lt;/script&gt; 로 교체해 보세요.`);
      return;
    }

    const state = ids.getState();
    const canvas = ids.getCanvas();

    // wrap이 막 보이기 시작한 시점이라 레이아웃이 0일 수 있으므로 최소 크기 보장
    const W = Math.max(1, wrap.clientWidth), H = Math.max(1, wrap.clientHeight);

    let renderer_;
    try {
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111111);
      camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 5000);
      renderer_ = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      showMessage(wrap, `3D 렌더러 생성에 실패했습니다 (WebGL 미지원 가능성).<br/>오류: ${e.message || e}`);
      return;
    }
    renderer = renderer_;
    renderer.setSize(W, H);
    wrap.appendChild(renderer.domElement);

    // 밝은 조명 — 음영에 의해 흐릿해 보이지 않도록 전체적으로 밝게
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(200, 400, 300); scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.5); dl2.position.set(-200, 200, -300); scene.add(dl2);

    // 좌표 변환: 캔버스 (x,y) -> 3D (x, height, y)  (스케일 축소)
    const SCALE = 0.12;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const NODE_R = 6.5;     // 노드 구체 반지름 (기존 2.2 → 확대)
    const PIPE_R = 2.0;     // 배관 원통 반지름 (기존 0.9 → 확대)
    const pos = {};

    // 노드 색상 — 밝고 채도 높은 색 + emissive 로 항상 또렷하게 보이도록
    const NODE_COLOR = 0x4fc3f7;       // 밝은 하늘색 (일반 노드)
    const PUMP_COLOR = 0xb388ff;       // 밝은 보라색 (펌프 노드)
    const PIPE_COLOR = 0xffd54f;       // 밝은 노랑 (배관) — 배경/노드와 뚜렷이 대비

    state.nodes.forEach(n => {
      pos[n.id] = new THREE.Vector3((n.x - cx) * SCALE, (n.height || 0), (n.y - cy) * SCALE);
      const baseColor = n.isPump ? PUMP_COLOR : NODE_COLOR;
      const geo = new THREE.SphereGeometry(NODE_R, 28, 28);
      const mat = new THREE.MeshPhongMaterial({ color: baseColor, emissive: baseColor, emissiveIntensity: 0.35, shininess: 60 });
      const sph = new THREE.Mesh(geo, mat);
      sph.position.copy(pos[n.id]);
      scene.add(sph);
      // 테두리(윤곽선) — 또렷한 외곽으로 더 잘 보이게
      const edgeGeo = new THREE.EdgesGeometry(new THREE.SphereGeometry(NODE_R * 1.02, 12, 12));
      const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
      edge.position.copy(pos[n.id]);
      scene.add(edge);
      if (n.height) {
        const pGeo = new THREE.CylinderGeometry(1.0, 1.0, Math.abs(n.height), 14);
        const pMat = new THREE.MeshPhongMaterial({ color: 0x9e9e9e, emissive: 0x9e9e9e, emissiveIntensity: 0.15 });
        const pole = new THREE.Mesh(pGeo, pMat);
        pole.position.set(pos[n.id].x, n.height / 2, pos[n.id].z);
        scene.add(pole);
      }
    });
    state.pipes.forEach(p => {
      const a = pos[p.from], b = pos[p.to];
      if (!a || !b) return;
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const geo = new THREE.CylinderGeometry(PIPE_R, PIPE_R, len, 18);
      const mat = new THREE.MeshPhongMaterial({ color: PIPE_COLOR, emissive: PIPE_COLOR, emissiveIntensity: 0.3, shininess: 50 });
      const cyl = new THREE.Mesh(geo, mat);
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      cyl.position.copy(mid);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      scene.add(cyl);
      // 배관 테두리선
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x3e2f00, transparent: true, opacity: 0.4 }));
      edge.position.copy(cyl.position);
      edge.quaternion.copy(cyl.quaternion);
      scene.add(edge);
    });
    // 바닥 — 노드 구체와 겹쳐 z-fighting/파묻힘이 생기지 않도록 가장 낮은 노드보다 아래에 배치
    const minH = state.nodes.length ? Math.min(0, ...state.nodes.map(n => n.height || 0)) : 0;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshPhongMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide }));
    floor.rotation.x = Math.PI / 2;
    floor.position.y = minH - 5;
    scene.add(floor);

    // 카메라 위치
    const box = new THREE.Box3();
    scene.traverse(o => { if (o.isMesh) box.expandByObject(o); });
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 100;
    camera.position.set(center.x + size * 0.6, center.y + size * 0.5, center.z + size * 0.6);
    camera.lookAt(center);

    // 간단한 마우스 드래그 회전 (OrbitControls 대체)
    let dragging = false, lastX = 0, lastY = 0, theta = 0, phi = 0.6, radius = size;
    const dom = renderer.domElement;
    dom.addEventListener("mousedown", e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener("mouseup", () => dragging = false);
    dom.addEventListener("mousemove", e => {
      if (!dragging) return;
      theta -= (e.clientX - lastX) * 0.01;
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi - (e.clientY - lastY) * 0.01));
      lastX = e.clientX; lastY = e.clientY;
    });
    dom.addEventListener("wheel", e => { e.preventDefault(); radius = Math.max(size * 0.2, radius + e.deltaY * 0.5); }, { passive: false });

    function animate() {
      animId = requestAnimationFrame(animate);
      camera.position.set(
        center.x + radius * Math.sin(phi) * Math.cos(theta),
        center.y + radius * Math.cos(phi),
        center.z + radius * Math.sin(phi) * Math.sin(theta)
      );
      camera.lookAt(center);
      renderer.render(scene, camera);
    }
    animate();
  }

  function close() {
    document.getElementById(ids.wrapId).classList.remove("show");
    if (animId) cancelAnimationFrame(animId);
  }

  function init(opts) {
    ids = opts;
    document.getElementById(ids.openBtnId).addEventListener("click", () => {
      const state = ids.getState();
      if (state.nodes.length === 0) { alert("먼저 설계도를 그려주세요."); return; }
      open();
    });
    document.getElementById(ids.closeBtnId).addEventListener("click", close);
  }

  return { init, open, close };
})();
