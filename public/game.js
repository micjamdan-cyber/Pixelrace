import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

// ===========================================================================
// Constants
// ===========================================================================
const TOTAL_LAPS_DEFAULT = 3;
const MAX_SPEED = 32;          // units / sec
const MAX_REVERSE = -10;
const ACCEL = 22;
const BRAKE_ACCEL = 34;
const DRAG = 0.9;              // natural deceleration factor
const TURN_RATE = 2.6;         // rad / sec at full speed
const SEND_INTERVAL_MS = 70;
const CAM_DIST = 8.5;
const CAM_HEIGHT = 4.2;
const CAM_LERP = 0.12;
const REMOTE_LERP = 0.25;
const FINISH_ZONE = { xMin: 38, xMax: 54, zMin: -4, zMax: 4 };
const CAR_SCALE = 1.3;

// ===========================================================================
// DOM references
// ===========================================================================
const $ = (id) => document.getElementById(id);
const screens = {
  menu: $('screen-menu'),
  lobby: $('screen-lobby'),
  race: $('screen-race'),
  results: $('screen-results'),
};
const el = {
  nameInput: $('name-input'),
  pinInput: $('pin-input'),
  btnCreate: $('btn-create'),
  btnJoin: $('btn-join'),
  menuError: $('menu-error'),
  connStatus: $('conn-status'),

  lobbyPin: $('lobby-pin'),
  lobbyPlayers: $('lobby-players'),
  btnStart: $('btn-start'),
  lobbyHint: $('lobby-hint'),
  btnLeaveLobby: $('btn-leave-lobby'),
  lobbyError: $('lobby-error'),

  canvas: $('race-canvas'),
  hudLap: $('hud-lap'),
  hudSpeed: $('hud-speed'),
  hudStandings: $('hud-standings'),
  countdownOverlay: $('countdown-overlay'),
  touchControls: $('touch-controls'),

  resultsList: $('results-list'),
  btnRestart: $('btn-restart'),
  resultsHint: $('results-hint'),

  toast: $('toast'),
};

function switchScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('active', key === name);
  }
}

function showToast(msg, ms = 3000) {
  el.toast.textContent = msg;
  el.toast.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.toast.style.display = 'none'; }, ms);
}

// ===========================================================================
// Client state
// ===========================================================================
const state = {
  ws: null,
  connected: false,
  myId: null,
  myPin: null,
  hostId: null,
  totalLaps: TOTAL_LAPS_DEFAULT,
  players: new Map(),     // id -> { id, name, color, laps, finished }
  playerOrder: [],        // ids in join order, for grid spawn placement
  screen: 'menu',
};

// ===========================================================================
// WebSocket networking
// ===========================================================================
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    el.connStatus.textContent = 'Connected';
    el.btnCreate.disabled = false;
    el.btnJoin.disabled = false;
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    el.connStatus.textContent = 'Disconnected — please reload the page to reconnect.';
    el.btnCreate.disabled = true;
    el.btnJoin.disabled = true;
    if (state.screen !== 'menu') {
      showToast('Connection lost. Please reload the page.', 6000);
    }
  });

  ws.addEventListener('error', () => { /* close event follows; nothing extra needed */ });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    handleServerMessage(msg);
  });
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'created': return onCreatedOrJoined(msg);
    case 'joined': return onCreatedOrJoined(msg);
    case 'lobby_update': return onLobbyUpdate(msg);
    case 'player_joined': return onPlayerJoined(msg);
    case 'player_left': return onPlayerLeft(msg);
    case 'race_start': return onRaceStart(msg);
    case 'state_update': return onStateUpdate(msg);
    case 'lap_update': return onLapUpdate(msg);
    case 'race_finished': return onRaceFinished(msg);
    case 'room_closed': return onRoomClosed(msg);
    case 'left': return onLeftRoom();
    case 'error': return onError(msg);
    default: return;
  }
}

function onCreatedOrJoined(msg) {
  state.myId = msg.playerId;
  state.myPin = msg.pin;
  state.hostId = msg.hostId;
  state.players.clear();
  state.playerOrder = [];
  for (const p of msg.players) {
    state.players.set(p.id, p);
    state.playerOrder.push(p.id);
  }
  el.lobbyPin.textContent = msg.pin;
  switchScreen('lobby');
  state.screen = 'lobby';
  renderLobby();
}

function onLobbyUpdate(msg) {
  state.hostId = msg.hostId;
  state.players.clear();
  state.playerOrder = [];
  for (const p of msg.players) {
    state.players.set(p.id, p);
    state.playerOrder.push(p.id);
  }
  if (msg.state === 'lobby') {
    resetRaceWorld();
    switchScreen('lobby');
    state.screen = 'lobby';
  }
  renderLobby();
}

function onPlayerJoined(msg) {
  state.players.set(msg.player.id, msg.player);
  if (!state.playerOrder.includes(msg.player.id)) state.playerOrder.push(msg.player.id);
  if (state.screen === 'lobby') renderLobby();
}

function onPlayerLeft(msg) {
  state.players.delete(msg.id);
  state.playerOrder = state.playerOrder.filter((id) => id !== msg.id);
  state.hostId = msg.newHostId;
  removeRemoteCar(msg.id);
  if (state.screen === 'lobby') renderLobby();
  else showToast('A player left the room.');
}

function onError(msg) {
  if (state.screen === 'lobby') el.lobbyError.textContent = msg.message;
  else if (state.screen === 'menu') el.menuError.textContent = msg.message;
  else showToast(msg.message);
}

function onRoomClosed(msg) {
  showToast('Room closed: ' + (msg.reason || ''), 5000);
  resetToMenu();
}

function onLeftRoom() {
  resetToMenu();
}

function resetToMenu() {
  state.myPin = null;
  state.hostId = null;
  state.players.clear();
  state.playerOrder = [];
  resetRaceWorld();
  switchScreen('menu');
  state.screen = 'menu';
}

function renderLobby() {
  el.lobbyPin.textContent = state.myPin || '----';
  el.lobbyPlayers.innerHTML = '';
  for (const id of state.playerOrder) {
    const p = state.players.get(id);
    if (!p) continue;
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = '#' + p.color.toString(16).padStart(6, '0');
    li.appendChild(swatch);
    const label = document.createElement('span');
    label.textContent = p.name;
    li.appendChild(label);
    if (id === state.myId) {
      const you = document.createElement('span');
      you.className = 'you-tag';
      you.textContent = '(you)';
      li.appendChild(you);
    }
    if (id === state.hostId) {
      const host = document.createElement('span');
      host.className = 'host-tag';
      host.textContent = 'HOST';
      li.appendChild(host);
    }
    el.lobbyPlayers.appendChild(li);
  }
  const isHost = state.hostId === state.myId;
  el.btnStart.style.display = isHost ? 'inline-block' : 'none';
  el.lobbyHint.textContent = isHost
    ? 'Start the race when everyone has joined.'
    : 'Waiting for the host to start the race…';
  el.lobbyError.textContent = '';
}

// ===========================================================================
// Menu / lobby UI wiring
// ===========================================================================
el.btnCreate.addEventListener('click', () => {
  el.menuError.textContent = '';
  send({ type: 'create', name: el.nameInput.value });
});

el.btnJoin.addEventListener('click', () => {
  el.menuError.textContent = '';
  const pin = el.pinInput.value.trim();
  if (!/^[0-9]{4}$/.test(pin)) {
    el.menuError.textContent = 'Enter a valid 4-digit PIN.';
    return;
  }
  send({ type: 'join', pin, name: el.nameInput.value });
});

el.pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnJoin.click();
});
el.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnCreate.click();
});

el.btnLeaveLobby.addEventListener('click', () => {
  send({ type: 'leave' });
  resetToMenu();
});

el.btnStart.addEventListener('click', () => {
  send({ type: 'start' });
});

el.btnRestart.addEventListener('click', () => {
  send({ type: 'restart' });
});

// ===========================================================================
// Three.js scene setup
// ===========================================================================
const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd0ff);
scene.fog = new THREE.Fog(0x8fd0ff, 120, 420);

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1500);
camera.position.set(0, 20, 40);

const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(80, 120, 60);
scene.add(sun);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- Asset loading -------------------------------------------------------
let carTemplate = null;
let assetsReady = false;

function loadAssets() {
  const mtlLoaderTrack = new MTLLoader();
  mtlLoaderTrack.setPath('models/track/');
  mtlLoaderTrack.load('race_track.mtl', (materials) => {
    materials.preload();
    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath('models/track/');
    objLoader.load('race_track.obj', (obj) => {
      scene.add(obj);
    }, undefined, (err) => console.error('Track load error', err));
  }, undefined, (err) => console.error('Track MTL load error', err));

  const mtlLoaderCar = new MTLLoader();
  mtlLoaderCar.setPath('models/car/');
  mtlLoaderCar.load('race.mtl', (materials) => {
    materials.preload();
    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath('models/car/');
    objLoader.load('race.obj', (obj) => {
      obj.scale.setScalar(CAR_SCALE);
      carTemplate = obj;
      assetsReady = true;
    }, undefined, (err) => console.error('Car load error', err));
  }, undefined, (err) => console.error('Car MTL load error', err));
}
loadAssets();

function makeCarInstance(color) {
  if (!carTemplate) return new THREE.Group();
  const inst = carTemplate.clone(true);
  inst.traverse((child) => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        c.color = new THREE.Color(color);
        return c;
      });
      child.material = Array.isArray(child.material) ? cloned : cloned[0];
    }
  });
  return inst;
}

// ===========================================================================
// Local car + remote cars
// ===========================================================================
const local = {
  group: null,
  x: 46, y: 0, z: 0, heading: 0, speed: 0,
};
scene.add((local.group = new THREE.Group()));

const remotes = new Map(); // id -> { group, target:{x,y,z,heading} }

function removeRemoteCar(id) {
  const r = remotes.get(id);
  if (r) {
    scene.remove(r.group);
    remotes.delete(id);
  }
}

function resetRaceWorld() {
  for (const id of Array.from(remotes.keys())) removeRemoteCar(id);
  while (local.group.children.length) local.group.remove(local.group.children[0]);
}

function gridSpawnFor(index, total) {
  const spacing = 3.2;
  const startOffset = -((total - 1) * spacing) / 2;
  const x = 46 + startOffset + index * spacing;
  return { x, y: 0, z: 0, heading: 0 };
}

// ===========================================================================
// Race lifecycle
// ===========================================================================
let raceActive = false;
let countdownTimer = null;
let wasInFinishZone = true; // starts true: spawn sits on the line

function onRaceStart(msg) {
  state.totalLaps = msg.totalLaps || TOTAL_LAPS_DEFAULT;
  switchScreen('race');
  state.screen = 'race';
  resetRaceWorld();

  const order = state.playerOrder;
  const myIndex = Math.max(0, order.indexOf(state.myId));
  const spawn = gridSpawnFor(myIndex, order.length || 1);
  local.x = spawn.x; local.y = spawn.y; local.z = spawn.z; local.heading = spawn.heading;
  local.speed = 0;
  wasInFinishZone = true;

  if (!local.group.children.length) {
    const me = state.players.get(state.myId);
    const car = makeCarInstance(me ? me.color : 0xffffff);
    local.group.add(car);
  }

  for (const id of order) {
    if (id === state.myId) continue;
    const p = state.players.get(id);
    if (!p) continue;
    const idx = order.indexOf(id);
    const sp = gridSpawnFor(idx, order.length);
    const car = makeCarInstance(p.color);
    const group = new THREE.Group();
    group.add(car);
    group.position.set(sp.x, sp.y, sp.z);
    scene.add(group);
    remotes.set(id, { group, target: { x: sp.x, y: sp.y, z: sp.z, heading: sp.heading }, name: p.name });
  }

  for (const p of state.players.values()) { p.laps = 0; p.finished = false; }
  updateHud();

  const startTime = msg.startTime;
  raceActive = false;
  if (countdownTimer) clearInterval(countdownTimer);
  el.countdownOverlay.style.display = 'flex';
  countdownTimer = setInterval(() => {
    const remaining = startTime - Date.now();
    if (remaining <= 0) {
      el.countdownOverlay.style.display = 'none';
      clearInterval(countdownTimer);
      countdownTimer = null;
      raceActive = true;
    } else {
      el.countdownOverlay.textContent = Math.ceil(remaining / 1000);
    }
  }, 100);
}

function onStateUpdate(msg) {
  for (const p of msg.players) {
    if (p.id === state.myId) continue;
    const r = remotes.get(p.id);
    if (!r) continue;
    r.target.x = p.x; r.target.y = p.y; r.target.z = p.z; r.target.heading = p.rotY;
  }
}

function onLapUpdate(msg) {
  const p = state.players.get(msg.id);
  if (p) {
    p.laps = msg.laps;
    p.finished = msg.finished;
  }
  updateHud();
}

function onRaceFinished(msg) {
  raceActive = false;
  switchScreen('results');
  state.screen = 'results';
  el.resultsList.innerHTML = '';
  for (const r of msg.results) {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = '#' + r.rank;
    li.appendChild(rank);
    const name = document.createElement('span');
    name.textContent = r.name + (r.id === state.myId ? ' (you)' : '');
    li.appendChild(name);
    el.resultsList.appendChild(li);
  }
  const isHost = state.hostId === state.myId;
  el.btnRestart.style.display = isHost ? 'inline-block' : 'none';
  el.resultsHint.textContent = isHost ? '' : 'Waiting for the host to return to the lobby…';
}

// ===========================================================================
// HUD
// ===========================================================================
function updateHud() {
  const me = state.players.get(state.myId);
  el.hudLap.textContent = `Lap ${me ? Math.min(me.laps, state.totalLaps) : 0} / ${state.totalLaps}`;
  el.hudSpeed.textContent = `${Math.round(Math.abs(local.speed) * 3.2)} km/h`;

  const sorted = Array.from(state.players.values()).sort((a, b) => (b.laps - a.laps));
  el.hudStandings.innerHTML = '';
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = '#' + p.color.toString(16).padStart(6, '0');
    row.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = `${p.name}${p.id === state.myId ? ' (you)' : ''} — ${p.laps}/${state.totalLaps}`;
    row.appendChild(label);
    el.hudStandings.appendChild(row);
  }
}

// ===========================================================================
// Input handling
// ===========================================================================
const keys = { forward: false, backward: false, left: false, right: false };

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowUp': case 'w': case 'W': keys.forward = true; break;
    case 'ArrowDown': case 's': case 'S': keys.backward = true; break;
    case 'ArrowLeft': case 'a': case 'A': keys.left = true; break;
    case 'ArrowRight': case 'd': case 'D': keys.right = true; break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.key) {
    case 'ArrowUp': case 'w': case 'W': keys.forward = false; break;
    case 'ArrowDown': case 's': case 'S': keys.backward = false; break;
    case 'ArrowLeft': case 'a': case 'A': keys.left = false; break;
    case 'ArrowRight': case 'd': case 'D': keys.right = false; break;
  }
});

// Touch controls (shown on small / touch devices)
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  el.touchControls.classList.add('visible');
}
for (const btn of document.querySelectorAll('.touch-btn')) {
  const key = btn.dataset.key;
  const map = { throttle: 'forward', brake: 'backward', left: 'left', right: 'right' };
  const prop = map[key];
  const setVal = (v) => { keys[prop] = v; };
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); setVal(true); }, { passive: false });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); setVal(false); }, { passive: false });
  btn.addEventListener('touchcancel', () => setVal(false));
  btn.addEventListener('mousedown', () => setVal(true));
  btn.addEventListener('mouseup', () => setVal(false));
  btn.addEventListener('mouseleave', () => setVal(false));
}

// ===========================================================================
// Physics + render loop
// ===========================================================================
const clock = new THREE.Clock();
let lastSend = 0;

function shortestDelta(target, current) {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function updateLocalPhysics(dt) {
  if (!raceActive) return;

  const throttle = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
  if (throttle > 0) {
    local.speed += ACCEL * dt;
  } else if (throttle < 0) {
    local.speed -= (local.speed > 0 ? BRAKE_ACCEL : ACCEL) * dt;
  } else {
    // natural drag toward zero
    const drag = Math.sign(local.speed) * DRAG * 8 * dt;
    if (Math.abs(drag) > Math.abs(local.speed)) local.speed = 0;
    else local.speed -= drag;
  }
  local.speed = Math.max(MAX_REVERSE, Math.min(MAX_SPEED, local.speed));

  const steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const speedFactor = Math.max(-1, Math.min(1, local.speed / MAX_SPEED));
  local.heading += steer * TURN_RATE * dt * speedFactor;

  local.x += -Math.sin(local.heading) * local.speed * dt;
  local.z += -Math.cos(local.heading) * local.speed * dt;

  local.group.position.set(local.x, local.y, local.z);
  local.group.rotation.y = local.heading;

  // finish-line / lap detection
  const inZone = local.x >= FINISH_ZONE.xMin && local.x <= FINISH_ZONE.xMax &&
                 local.z >= FINISH_ZONE.zMin && local.z <= FINISH_ZONE.zMax;
  if (inZone && !wasInFinishZone) {
    send({ type: 'lap' });
  }
  wasInFinishZone = inZone;
}

function updateCamera(dt) {
  const behind = new THREE.Vector3(
    Math.sin(local.heading) * CAM_DIST,
    CAM_HEIGHT,
    Math.cos(local.heading) * CAM_DIST
  );
  const desired = new THREE.Vector3(local.x, local.y, local.z).add(behind);
  camera.position.lerp(desired, 1 - Math.pow(1 - CAM_LERP, dt * 60));
  const lookAt = new THREE.Vector3(local.x, local.y + 1.2, local.z);
  camera.lookAt(lookAt);
}

function updateRemotes(dt) {
  const lerpFactor = 1 - Math.pow(1 - REMOTE_LERP, dt * 60);
  for (const r of remotes.values()) {
    const g = r.group;
    g.position.x += (r.target.x - g.position.x) * lerpFactor;
    g.position.y += (r.target.y - g.position.y) * lerpFactor;
    g.position.z += (r.target.z - g.position.z) * lerpFactor;
    const delta = shortestDelta(r.target.heading, g.rotation.y);
    g.rotation.y += delta * lerpFactor;
  }
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state.screen === 'race') {
    updateLocalPhysics(dt);
    updateRemotes(dt);
    updateCamera(dt);
    updateHud();

    const now = performance.now();
    if (raceActive && now - lastSend > SEND_INTERVAL_MS) {
      lastSend = now;
      send({ type: 'state', x: local.x, y: local.y, z: local.z, rotY: local.heading, speed: local.speed });
    }
  }

  renderer.render(scene, camera);
}
tick();

// ===========================================================================
// Boot
// ===========================================================================
connect();
