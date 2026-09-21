// viewer_app.js — Standalone 3D DesktopFly and Brain viewer for Google Colab & Web
import * as THREE from '../../windows/node_modules/three/build/three.module.js';
import { OrbitControls } from '../../windows/node_modules/three/examples/jsm/controls/OrbitControls.js';

import circuitData from '../../data/circuit.json';
import locomotorData from '../../data/locomotor_circuit.json';
import brainPointsData from '../../data/brain_points.json';

import { LIFSim, SpikeBus, SimulationClock } from '../../windows/src/sim.js';
import { SignalBuilder } from '../../windows/src/signals.js';
import { Fly, SHADOWS_ENABLED, FLY_SCALE } from '../../windows/src/flymodel.js';
import { clampf, rnd, lag } from '../../windows/src/util.js';

// Super-class palette for FlyWire brain somas
const CLASS_COLORS = [
  [0.16, 0.22, 0.34], // optic — dim blue
  [0.45, 0.33, 0.16], // central — amber
  [0.14, 0.36, 0.34], // sensory — teal
  [0.10, 0.48, 0.62], // visual_projection — cyan
  [0.38, 0.22, 0.55], // visual_centrifugal — violet
  [0.62, 0.28, 0.10], // descending — orange
  [0.20, 0.45, 0.18], // ascending — green
  [0.55, 0.14, 0.14], // motor — red
  [0.50, 0.25, 0.40], // endocrine — pink
];

const ROLE_COLORS = {
  lc4: [0.15, 0.85, 1.0],
  lplc2: [0.15, 0.85, 1.0],
  dna01: [1.0, 0.55, 0.10],
  dna02: [1.0, 0.55, 0.10],
  mdn: [1.0, 0.20, 0.80],
  dnp09: [0.25, 1.0, 0.35],
  dng11: [0.75, 0.55, 1.0],
  escw: [1.0, 0.35, 0.25],
  gf: [1.0, 0.95, 0.4],
};

// Application state
let currentMode = 'fly'; // 'fly' or 'brain'
let cameraMode = 'follow'; // 'follow', 'orbit', 'top'
let autoRotateBrain = true;
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordDuration = 10; // seconds

// DOM elements
const container = document.getElementById('viewport-container');
const canvas = document.getElementById('webgl-canvas');
const statusBadge = document.getElementById('status-badge');
const gfIndicator = document.getElementById('gf-indicator');
const rateWalkEl = document.getElementById('rate-walk');
const rateGroomEl = document.getElementById('rate-groom');
const rateLoomEl = document.getElementById('rate-loom');
const rateMdnEl = document.getElementById('rate-mdn');
const recBtn = document.getElementById('btn-record');
const recTimerEl = document.getElementById('record-timer');
const videoPlayerContainer = document.getElementById('video-player-container');
const videoPlayer = document.getElementById('recorded-video');
const downloadVideoBtn = document.getElementById('btn-download-video');

// 3D Scene setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f19);

// Set camera up vector to Z+ (FlyModel uses +Z up, +Y forward)
const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 3000);
camera.up.set(0, 0, 1);
camera.position.set(0, -90, 45);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // required for video recording / screenshots
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// OrbitControls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 + 0.1;
controls.minDistance = 15;
controls.maxDistance = 600;

// Lighting for Fly scene
const flyGroup = new THREE.Group();
scene.add(flyGroup);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(60, 60, 120);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 10;
keyLight.shadow.camera.far = 400;
keyLight.shadow.camera.left = -150;
keyLight.shadow.camera.right = 150;
keyLight.shadow.camera.top = 150;
keyLight.shadow.camera.bottom = -150;
keyLight.shadow.bias = -0.0005;
flyGroup.add(keyLight);
flyGroup.add(keyLight.target);

const fillLight = new THREE.DirectionalLight(0x7ea8d6, 0.9);
fillLight.position.set(-80, -60, 80);
flyGroup.add(fillLight);

const ambientLight = new THREE.AmbientLight(0xdbe7ff, 0.7);
flyGroup.add(ambientLight);

// Shadow catcher floor and arena grid
const floorGeo = new THREE.PlaneGeometry(2400, 2400);
const floorMat = new THREE.ShadowMaterial({ opacity: 0.35 });
const floorMesh = new THREE.Mesh(floorGeo, floorMat);
floorMesh.position.z = -0.05;
floorMesh.receiveShadow = true;
flyGroup.add(floorMesh);

const gridHelper = new THREE.GridHelper(2400, 80, 0x223652, 0x142033);
gridHelper.rotation.x = Math.PI / 2;
gridHelper.position.z = -0.06;
flyGroup.add(gridHelper);

// Circular substrate platform
const platformGeo = new THREE.CylinderGeometry(500, 500, 3, 64);
const platformMat = new THREE.MeshStandardMaterial({
  color: 0x111c2e,
  roughness: 0.6,
  metalness: 0.2,
});
const platform = new THREE.Mesh(platformGeo, platformMat);
platform.rotation.x = Math.PI / 2;
platform.position.z = -1.5;
platform.receiveShadow = true;
flyGroup.add(platform);

// Platform rim glow ring
const ringGeo = new THREE.RingGeometry(496, 502, 64);
const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, opacity: 0.6, transparent: true });
const ring = new THREE.Mesh(ringGeo, ringMat);
ring.position.z = 0.01;
flyGroup.add(ring);

// -------------------------------------------------------------
// Brain View Scene
// -------------------------------------------------------------
const brainGroup = new THREE.Group();
brainGroup.visible = false;
scene.add(brainGroup);

let brainNeurons = null;
const flashPool = [];
const flashState = [];
let flashNext = 0;

function pointCloud(positions, colors, size) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const m = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  });
  return new THREE.Points(g, m);
}

function initBrainScene() {
  const pts = brainPointsData.points;
  const pos = new Float32Array(pts.length * 3);
  const col = new Float32Array(pts.length * 3);
  let k = 0;
  for (const p of pts) {
    if (p.length < 4) continue;
    pos[3 * k] = p[0];
    pos[3 * k + 1] = p[1];
    pos[3 * k + 2] = p[2];
    const c = CLASS_COLORS[p[3] | 0] || [0.3, 0.3, 0.3];
    col[3 * k] = c[0];
    col[3 * k + 1] = c[1];
    col[3 * k + 2] = c[2];
    k++;
  }
  brainGroup.add(pointCloud(pos.subarray(0, 3 * k), col.subarray(0, 3 * k), 0.12));

  // Circuit overlay
  const n = circuitData.neurons.length;
  const cpos = new Float32Array(n * 3);
  const ccol = new Float32Array(n * 3);
  const roles = [];
  const types = [];
  for (let i = 0; i < n; i++) {
    const nr = circuitData.neurons[i];
    roles.push(nr.role);
    types.push(nr.type);
    const p = nr.pos && nr.pos.length === 3 ? nr.pos : [0, 0, 0];
    cpos[3 * i] = p[0];
    cpos[3 * i + 1] = p[1];
    cpos[3 * i + 2] = p[2];
    const c = ROLE_COLORS[nr.role] || [0.45, 0.45, 0.50];
    ccol[3 * i] = c[0];
    ccol[3 * i + 1] = c[1];
    ccol[3 * i + 2] = c[2];
  }
  brainGroup.add(pointCloud(cpos, ccol, 0.36));
  brainNeurons = { n, roles, types, positions: cpos };

  // Giant Fiber markers
  const gfGeo = new THREE.SphereGeometry(0.35, 16, 12);
  const gfMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < n; i++) {
    if (roles[i] !== 'gf') continue;
    const node = new THREE.Mesh(gfGeo, gfMat.clone());
    node.position.set(cpos[3 * i], cpos[3 * i + 1], cpos[3 * i + 2]);
    brainGroup.add(node);
  }

  // Spike flashes pool
  const flashGeo = new THREE.SphereGeometry(0.2, 12, 10);
  for (let i = 0; i < 64; i++) {
    const m = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const node = new THREE.Mesh(flashGeo, m);
    node.visible = false;
    brainGroup.add(node);
    flashPool.push(node);
    flashState.push({ ttl: 0, dur: 1 });
  }
}

function flashSpike(neuronIdx, isGF = false) {
  if (!brainNeurons || neuronIdx >= brainNeurons.n || !flashPool.length) return;
  const idx = flashNext;
  flashNext = (flashNext + 1) % flashPool.length;
  const node = flashPool[idx];
  const p = brainNeurons.positions;
  node.position.set(p[3 * neuronIdx], p[3 * neuronIdx + 1], p[3 * neuronIdx + 2]);
  node.visible = true;
  node.material.color.setHex(isGF ? 0xfacc15 : 0x38bdf8);
  node.material.opacity = isGF ? 1.0 : 0.85;
  const s = isGF ? 3.5 : 1.2;
  node.scale.set(s, s, s);
  const dur = isGF ? 0.6 : 0.3;
  flashState[idx] = { ttl: dur, dur };
}

initBrainScene();

// -------------------------------------------------------------
// Simulation & Fly Setup
// -------------------------------------------------------------
const spikeBus = new SpikeBus();
const sim = new LIFSim(circuitData, spikeBus, locomotorData);
const signalBuilder = new SignalBuilder();
const simulationClock = new SimulationClock();

const fly = new Fly({ x: 0, y: 0 });
flyGroup.add(fly.node);

let bounds = { width: 1400, height: 1000 };
let lastTime = null;
let msAccumulator = 0;
let loomOverride = 0;
let tempo = 1.0;
let isSleepy = false;
let continuousFlight = false;
let autoFlightTimer = 0;

// Launch flight command
export function launchFlight() {
  fly.scareCooldown = 0;
  if (sim) {
    sim.stimulate(sim.gf, 0.9, 100);
    sim.stimulate(sim.escw, 0.7, 800);
  }
  fly.startFlight(bounds, { escape: true });
}

export function toggleContinuousFlight() {
  continuousFlight = !continuousFlight;
  if (continuousFlight && fly.state !== 'flying') {
    launchFlight();
  }
  return continuousFlight;
}

// Custom stimulation triggers
export function stimulate(groupName) {
  if (groupName === 'escape' || groupName === 'flight') {
    launchFlight();
    return;
  }

  const specs = {
    walk: ['fwd', 0.35, 1600],
    groom: ['groom', 0.35, 900],
    backward: ['mdn', 0.45, 800],
    loom: null,
  };

  if (groupName === 'loom') {
    loomOverride = 0.95;
    sim.loomL = 0.85;
    sim.loomR = 0.45;
    return;
  }

  const spec = specs[groupName];
  if (spec && sim) {
    const [field, strength, dur] = spec;
    sim.stimulate(sim[field], strength, dur);
  }
}

// Tick simulation loop
function tick(dt) {
  // Continuous flight auto-trigger when landed
  if (continuousFlight && fly.state !== 'flying') {
    autoFlightTimer += dt;
    if (autoFlightTimer > 0.6) {
      autoFlightTimer = 0;
      launchFlight();
    }
  }

  // Feed proprioception & signals into LIF circuit
  sim.gaitDrive = fly.walkingIntensity;
  sim.gaitPhase = fly.gaitPhasePublic;
  sim.legFeedback = fly.legFeedback;
  sim.activityScale = isSleepy ? 0.65 : 1.0;
  sim.sensoryGate = isSleepy ? 0.5 : 1.0;

  if (loomOverride > 0) {
    loomOverride = Math.max(0, loomOverride - dt * 1.5);
    sim.loomL = loomOverride;
    sim.loomR = loomOverride * 0.7;
  }

  msAccumulator += dt * 1000;
  const steps = Math.min(50, Math.floor(msAccumulator));
  msAccumulator -= steps;
  sim.step(steps);

  const signals = signalBuilder.make(sim, dt);
  signals.tempo = tempo;
  signals.sleep = isSleepy;

  // Handle live spike bus for brain visuals
  const spikes = spikeBus.popAll();
  for (const s of spikes) {
    flashSpike(s.neuron, s.isGF);
  }

  // Update 3D Fly kinematics
  fly.terrain = [];
  fly.update(dt, bounds, null, signals);

  // Update UI Telemetry
  updateHUD(signals);
}

function updateHUD(signals) {
  if (statusBadge) {
    const stateStr = fly.state.toUpperCase();
    statusBadge.textContent = stateStr;
    statusBadge.className = `status-pill status-${fly.state}`;
  }

  if (gfIndicator) {
    if (signals.escape || fly.state === 'flying') {
      gfIndicator.classList.add('active');
    } else {
      gfIndicator.classList.remove('active');
    }
  }

  if (rateWalkEl) rateWalkEl.textContent = (sim.rateFwd || 0).toFixed(1) + ' Hz';
  if (rateGroomEl) rateGroomEl.textContent = (sim.rateGroom || 0).toFixed(1) + ' Hz';
  if (rateLoomEl) rateLoomEl.textContent = (sim.rateLoom || 0).toFixed(1) + ' Hz';
  if (rateMdnEl) rateMdnEl.textContent = (sim.rateMDN || 0).toFixed(1) + ' Hz';
}

// -------------------------------------------------------------
// Render Loop
// -------------------------------------------------------------
function animate(timeMs) {
  requestAnimationFrame(animate);

  const t = timeMs / 1000;
  if (lastTime === null) {
    lastTime = t;
    return;
  }
  const dt = Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;

  // Advance simulation at 120Hz
  simulationClock.advance(dt, tick);

  // Camera handling
  if (currentMode === 'fly') {
    const flyZ = (fly.node && typeof fly.node.position.z === 'number' && !isNaN(fly.node.position.z))
      ? fly.node.position.z : 0;
    const targetX = (typeof fly.pos.x === 'number' && !isNaN(fly.pos.x)) ? fly.pos.x : 0;
    const targetY = (typeof fly.pos.y === 'number' && !isNaN(fly.pos.y)) ? fly.pos.y : 0;
    const targetZ = flyZ + 5;

    if (cameraMode === 'follow') {
      // Smoothly follow behind and above the fly
      const camDist = 65;
      const camHeight = 32 + Math.max(0, flyZ * 0.35);
      const angle = fly.heading - Math.PI;

      const desiredCamX = targetX + Math.cos(angle) * camDist;
      const desiredCamY = targetY + Math.sin(angle) * camDist;
      const desiredCamZ = targetZ + camHeight;

      camera.position.x += (desiredCamX - camera.position.x) * 0.08;
      camera.position.y += (desiredCamY - camera.position.y) * 0.08;
      camera.position.z += (desiredCamZ - camera.position.z) * 0.08;

      controls.target.set(targetX, targetY, targetZ);
    } else if (cameraMode === 'top') {
      camera.position.set(targetX, targetY, 240);
      controls.target.set(targetX, targetY, targetZ);
    }
    controls.update();

    // Keylight follows fly for crisp dynamic shadows
    keyLight.position.set(targetX + 60, targetY + 60, flyZ + 120);
    keyLight.target.position.set(targetX, targetY, flyZ);
  } else {
    // Brain mode: auto rotate
    if (autoRotateBrain) {
      brainGroup.rotation.z += 0.005;
    }
    controls.update();

    // Update brain spike flashes
    for (let i = 0; i < flashPool.length; i++) {
      const st = flashState[i];
      if (st.ttl > 0) {
        st.ttl -= dt;
        if (st.ttl <= 0) {
          flashPool[i].visible = false;
        } else {
          flashPool[i].material.opacity = (st.ttl / st.dur) * 0.9;
        }
      }
    }
  }

  // Render 3D scene
  renderer.render(scene, camera);

  // Recording timer update
  if (isRecording) {
    const elapsed = ((performance.now() - recordStartTime) / 1000).toFixed(1);
    if (recTimerEl) recTimerEl.textContent = `🔴 REC ${elapsed}s / ${recordDuration}s`;
    if (elapsed >= recordDuration) {
      stopRecording();
    }
  }
}

requestAnimationFrame(animate);

// Automatically take off 800ms after load so the user immediately sees the fly in flight!
setTimeout(() => {
  launchFlight();
}, 800);

// -------------------------------------------------------------
// Video Recording Implementation (Canvas -> MediaRecorder)
// -------------------------------------------------------------
export function startRecording(durationSeconds = 10) {
  if (isRecording) return;
  recordDuration = durationSeconds;
  recordedChunks = [];

  const stream = canvas.captureStream(60);
  let options = { mimeType: 'video/webm;codecs=vp9' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm' };
  }

  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    console.warn('Fallback to default MediaRecorder mimeType', err);
    mediaRecorder = new MediaRecorder(stream);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    isRecording = false;
    if (recBtn) {
      recBtn.textContent = '🎥 錄製 3D 影片';
      recBtn.classList.remove('recording');
    }
    if (recTimerEl) recTimerEl.textContent = '';

    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const videoUrl = URL.createObjectURL(blob);

    if (videoPlayer) {
      videoPlayer.src = videoUrl;
      videoPlayer.load();
      videoPlayer.play();
    }
    if (videoPlayerContainer) {
      videoPlayerContainer.style.display = 'block';
      videoPlayerContainer.scrollIntoView({ behavior: 'smooth' });
    }

    if (downloadVideoBtn) {
      downloadVideoBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = videoUrl;
        a.download = `desktop_fly_3d_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
    }

    // Google Colab callback: save video directly to Colab environment if available
    if (window.google && window.google.colab && window.google.colab.kernel) {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => {
        const base64Data = reader.result.split(',')[1];
        window.google.colab.kernel.invokeFunction('save_recorded_video', [base64Data], {});
        console.log('Video sent to Google Colab kernel');
      };
    }
  };

  mediaRecorder.start();
  isRecording = true;
  recordStartTime = performance.now();
  if (recBtn) {
    recBtn.textContent = '⏹ 停止錄製';
    recBtn.classList.add('recording');
  }
}

export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// -------------------------------------------------------------
// View & Mode Switchers
// -------------------------------------------------------------
export function setViewMode(mode) {
  currentMode = mode;
  if (mode === 'fly') {
    flyGroup.visible = true;
    brainGroup.visible = false;
    camera.up.set(0, 0, 1);
    camera.position.set(0, -90, 45);
    controls.target.set(0, 0, 5);
  } else {
    flyGroup.visible = false;
    brainGroup.visible = true;
    camera.up.set(0, 1, 0);
    camera.position.set(0, 1, 32);
    controls.target.set(0, 0, 0);
  }
}

export function setCameraMode(mode) {
  cameraMode = mode;
  if (mode === 'orbit') {
    controls.enablePan = true;
  }
}

export function setTempo(val) {
  tempo = parseFloat(val);
}

export function toggleSleep() {
  isSleepy = !isSleepy;
  return isSleepy;
}

// Wire buttons
window.DesktopFlyApp = {
  stimulate,
  launchFlight,
  toggleContinuousFlight,
  startRecording,
  stopRecording,
  setViewMode,
  setCameraMode,
  setTempo,
  toggleSleep,
  fly,
  sim,
};

// Handle window resize
window.addEventListener('resize', () => {
  if (!container) return;
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});
