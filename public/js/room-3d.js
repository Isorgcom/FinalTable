// room-3d.js — Three.js 3D room scene (background layer)
// KKR dark study aesthetic: walnut panels, warm spotlight, felt table

(function () {
  'use strict';

  function initRoom3D() {
    const canvas = document.getElementById('room3dCanvas');
    if (!canvas) return;

    // Skip 3D on mobile — saves ~600KB download + GPU resources
    if (window.innerWidth < 768) {
      canvas.style.display = 'none';
      return;
    }

    // WebGL availability check
    let gl = null;
    try {
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    } catch (e) {}
    if (!gl) {
      canvas.style.display = 'none';
      console.log('WebGL not available, using CSS fallback');
      return;
    }

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f06);

    // The felt lives in the table stage: the window minus the docked side
    // panel (--rail-w). Size the view to the stage so the spotlight pool sits
    // under the felt rather than under the middle of the window.
    function viewSize() {
      const rail = parseFloat(getComputedStyle(document.body).getPropertyValue('--rail-w')) || 0;
      return { width: Math.max(1, window.innerWidth - rail), height: window.innerHeight };
    }
    const view = viewSize();
    const camera = new THREE.PerspectiveCamera(45, view.width / view.height, 0.1, 50);
    camera.position.set(0, 5, 4);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(view.width, view.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;

    // ── Materials ──
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x1a0f08,
      roughness: 0.7,
      metalness: 0.05,
    });
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0f0a06,
      roughness: 0.8,
      metalness: 0.0,
    });

    // ── Room geometry ──
    // Floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.5;
    scene.add(floor);

    // Back wall
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), wallMat);
    backWall.position.set(0, 1.5, -7);
    scene.add(backWall);

    // Left wall
    const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), wallMat);
    leftWall.position.set(-7, 1.5, 0);
    leftWall.rotation.y = Math.PI / 2;
    scene.add(leftWall);

    // Right wall
    const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), wallMat);
    rightWall.position.set(7, 1.5, 0);
    rightWall.rotation.y = -Math.PI / 2;
    scene.add(rightWall);

    // Wall panel grooves (subtle vertical lines)
    for (let i = -3; i <= 3; i++) {
      const groove = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 5, 0.01),
        new THREE.MeshStandardMaterial({ color: 0x120a04, roughness: 0.9 })
      );
      groove.position.set(i * 2, 1.5, -6.99);
      scene.add(groove);
    }

    // ── Lighting ──
    // Main spotlight above the CSS table layer
    const spotLight = new THREE.SpotLight(0xffd89e, 1.2, 12, Math.PI / 4, 0.6, 1.5);
    spotLight.position.set(0, 6, 0);
    spotLight.target.position.set(0, 0, 0);
    scene.add(spotLight);
    scene.add(spotLight.target);

    // Wall sconces
    const wallLight1 = new THREE.PointLight(0xffa54f, 0.3, 8);
    wallLight1.position.set(-5, 2.5, -5);
    scene.add(wallLight1);

    const wallLight2 = new THREE.PointLight(0xffa54f, 0.3, 8);
    wallLight2.position.set(5, 2.5, -5);
    scene.add(wallLight2);

    // Ambient
    const ambientLight = new THREE.AmbientLight(0x1a1008, 0.15);
    scene.add(ambientLight);

    // ── Render once (static scene) ──
    renderer.render(scene, camera);

    // Refit on resize, and on demand when the side panel docks or hides
    // (the rail changes without a window resize).
    function fitView() {
      const next = viewSize();
      camera.aspect = next.width / next.height;
      camera.updateProjectionMatrix();
      renderer.setSize(next.width, next.height);
      renderer.render(scene, camera);
    }
    window.addEventListener('resize', fitView);
    window.roomThreeRefit = fitView;

    // Cleanup on page unload (best practice)
    window.addEventListener('beforeunload', () => {
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      renderer.dispose();
    });
  }

  // Init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRoom3D);
  } else {
    initRoom3D();
  }
})();
