// Foxlight: a tiny cave platformer. Everything is drawn in code.
// Query flags:
//   ?bug=moon        spring has no speed cap (the moon jump)
//   ?script=<name>   deterministic input playback: run, moon, fixed, lanterns, stream
//   ?res=1080        render at 1920x1080 (internal world stays 1280x720)
//   ?manual=1        no real-time loop; advance with window.__step(ms)
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const W = 1280, H = 720;
  const RES = params.get('res') === '1080' ? 1.5 : 1;
  const MANUAL = params.has('manual');
  const SCRIPT = params.get('script');
  if (MANUAL) document.body.classList.add('rec');

  const canvas = document.getElementById('game');
  canvas.width = W * RES;
  canvas.height = H * RES;
  if (MANUAL) { canvas.style.width = W * RES + 'px'; canvas.style.height = H * RES + 'px'; }
  const ctx = canvas.getContext('2d');
  const dark = document.createElement('canvas');
  dark.width = canvas.width; dark.height = canvas.height;
  const dctx = dark.getContext('2d');

  // ---------- deterministic randomness ----------
  function mulberry(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const worldRng = mulberry(7);
  let fxRng = mulberry(1234);
  const rr = (a, b) => a + (b - a) * fxRng();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  // ---------- palette ----------
  const C = {
    bgTop: '#0b222a', bgBot: '#14363e',
    far: '#18434d', mid: '#1d4f58', near: '#245b63', nearRim: '#3a7a76',
    rock: '#0d1b21', rockTop: '#2a5553', rockLip: '#6b9c86', moss: '#5f9466', mossDark: '#3f6d50',
    fox: '#f0692c', foxShade: '#c64e1d', cream: '#f8e8cf', leg: '#3a241d', ink: '#1a0d09',
    lamp: '#ffd27a', lampCore: '#fff3cf', lampFrame: '#2c1f17',
    springPlate: '#ff5a36', springPlateDark: '#c23c1f', springBase: '#33393f', coil: '#b7bec7',
    water: '111,184,190',
  };
  const WARM = '255,170,92';

  // ---------- world ----------
  const WORLD_W = 3840;
  const GROUND = 640;
  // solid ground segments (top surface, solid sides)
  const grounds = [
    { x: 0, w: 560, top: GROUND },
    { x: 700, w: 2720, top: GROUND },
    { x: 3420, w: 320, top: 668, pool: true },
    { x: 3740, w: 100, top: GROUND },
  ];
  // one-way platforms
  const plats = [
    { x: 300, w: 170, top: 528 },
    { x: 590, w: 150, top: 466 },
    { x: 960, w: 180, top: 500 },
    { x: 1190, w: 150, top: 384 },
    { x: 2140, w: 380, top: 270, ledge: true },
    { x: 3010, w: 190, top: 520 },
    { x: 3530, w: 140, top: 392, hidden: true },
  ];
  const spring = { x: 1985, w: 112, restH: 52, comp: 0, vel: 0, tilt: 0, tiltV: 0, hits: 0 };
  const springTop = () => GROUND - spring.restH + spring.comp;
  const WATERFALL = { x: 3470, w: 140 };

  // ceiling profile: bottom edge y of the ceiling rock
  const ceilPts = [];
  for (let x = -100; x <= WORLD_W + 200; x += 40) {
    let y = 72 + 34 * Math.sin(x * 0.0031) + 22 * Math.sin(x * 0.011 + 1.3) + worldRng() * 14;
    if (x > 1860 && x < 2110) y = 116 + worldRng() * 6;           // above the spring
    if (x > 2110 && x < 2560) y = Math.min(y, 120);
    if (x > 3440 && x < 3640) y = 40 + worldRng() * 8;            // waterfall mouth
    ceilPts.push([x, y]);
  }
  function ceilY(x) {
    const i = clamp(Math.floor((x + 100) / 40), 0, ceilPts.length - 2);
    const a = ceilPts[i], b = ceilPts[i + 1];
    return lerp(a[1], b[1], (x - a[0]) / 40);
  }
  // stalactites hanging from the ceiling
  const stalactites = [];
  for (let x = 30; x < WORLD_W; x += 70 + worldRng() * 120) {
    if (Math.abs(x - spring.x) < 90) continue;
    if (x > 3440 && x < 3640) continue;
    stalactites.push({ x, len: 30 + worldRng() * 70, w: 14 + worldRng() * 22 });
  }

  // lanterns: hanging ones are already lit; floating ones wait to be collected
  const hanging = [
    { x: 210, y: 300, chain: true }, { x: 840, y: 250, chain: true },
    { x: 1290, y: 240, chain: true }, { x: 1700, y: 300, chain: true },
    { x: 2370, y: 236, stand: true },
  ];
  const floaters = [
    { id: 0, x: 2800, y: 512, lit: 0, litT: -1, region: 640 },
    { id: 1, x: 3105, y: 392, lit: 0, litT: -1, region: 660 },
    { id: 2, x: 3600, y: 334, lit: 0, litT: -1, region: 520, behindWater: true },
  ];

  // parallax rock layers, generated once
  function makeLayer(seed, factor, base, amp, spikes, color, rim) {
    const r = mulberry(seed);
    const width = W + (WORLD_W - W) * factor + 200;
    const top = [], bot = [];
    for (let x = -100; x <= width; x += 60) {
      top.push([x, base * 0.25 + amp * 0.5 * Math.sin(x * 0.004 + seed) + r() * amp * 0.35]);
      bot.push([x, H - base + amp * Math.sin(x * 0.0035 + seed * 2) + r() * amp * 0.6]);
    }
    const sp = [];
    for (let x = 0; x < width; x += 80 + r() * 160) sp.push({ x, len: spikes * (0.4 + r()), w: 20 + r() * 40, up: r() < 0.45 });
    return { factor, top, bot, sp, color, rim };
  }
  const layers = [
    makeLayer(11, 0.22, 170, 70, 120, C.far, null),
    makeLayer(23, 0.45, 120, 60, 100, C.mid, null),
    makeLayer(37, 0.7, 70, 46, 80, C.near, C.nearRim),
  ];

  // shapes for platforms (irregular rock slabs)
  function slabShape(p, seed) {
    const r = mulberry(seed);
    const pts = [];
    const n = Math.max(4, Math.round(p.w / 26));
    const depth = p.ledge ? 96 : 70 + r() * 26;
    for (let i = 0; i <= n; i++) pts.push([p.x + (p.w * i) / n, p.top + (i === 0 || i === n ? 4 : -r() * 3)]);
    const under = [];
    for (let i = n; i >= 0; i--) {
      const f = i / n;
      const taper = Math.sin(f * Math.PI);
      under.push([p.x + p.w * f + (r() - 0.5) * 8, p.top + 10 + depth * taper * (0.6 + r() * 0.5)]);
    }
    return pts.concat(under);
  }
  plats.forEach((p, i) => { p.shape = slabShape(p, 100 + i); });
  grounds.forEach((g, i) => {
    const r = mulberry(300 + i);
    g.edge = [];
    for (let x = g.x; x <= g.x + g.w + 0.1; x += 32) g.edge.push([x, g.top - r() * 4]);
    g.stones = [];
    for (let k = 0; k < g.w / 50; k++) g.stones.push({ x: g.x + r() * g.w, y: g.top + 24 + r() * 50, rx: 8 + r() * 18, ry: 5 + r() * 8 });
    g.tufts = [];
    for (let x = g.x + 10; x < g.x + g.w - 10; x += 40 + r() * 90) g.tufts.push({ x, h: 6 + r() * 9 });
  });
  plats.forEach((p, i) => {
    const r = mulberry(500 + i);
    p.tufts = [];
    for (let x = p.x + 12; x < p.x + p.w - 12; x += 30 + r() * 50) p.tufts.push({ x, h: 5 + r() * 8 });
    p.roots = [];
    for (let k = 0; k < p.w / 70; k++) p.roots.push({ x: p.x + 20 + r() * (p.w - 40), len: 16 + r() * 30 });
  });

  // ---------- state ----------
  const S = {
    t: 0, tick: 0,
    bug: params.get('bug') === 'moon',
    camX: 0, camLock: null,
    fox: null,
    particles: [], pebbles: [],
    ceilHoles: [], twinkles: [], rings: [],
    lanternsLit: 0,
    shake: 0,
    events: [],
  };
  function newFox(x, y) {
    return {
      x, y, vx: 0, vy: 0, face: 1, grounded: true, coyote: 0,
      runPhase: 0, squash: 0, squashV: 0, blink: 2.2, blinkT: 0,
      lampAng: 0, lampV: 0, tailT: 0, air: 0,
      gone: false, noclip: false, moonFlight: false, spin: 0,
      dazed: 0, landedOn: null, sit: 0, idleT: 0, look: 0, lookTarget: 0,
    };
  }
  S.fox = newFox(120, GROUND);
  const FOX_HW = 24, FOX_H = 58;

  // ambient motes and drips
  const motes = [];
  { const r = mulberry(77); for (let i = 0; i < 140; i++) motes.push({ x: r() * WORLD_W, y: 120 + r() * 520, p: r() * 6.28, s: 0.6 + r() * 1.6 }); }
  const dripSources = stalactites.filter((s, i) => i % 3 === 0);

  // ---------- input ----------
  const keys = { left: false, right: false, jump: false };
  let jumpQueued = false;
  if (!SCRIPT) {
    const map = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'jump', KeyW: 'jump', Space: 'jump' };
    addEventListener('keydown', (e) => {
      const k = map[e.code]; if (!k) { if (e.code === 'KeyB') S.bug = !S.bug; return; }
      if (k === 'jump' && !keys.jump) jumpQueued = true;
      keys[k] = true; e.preventDefault();
    });
    addEventListener('keyup', (e) => { const k = map[e.code]; if (k) keys[k] = false; });
  }

  // ---------- scripted playback ----------
  // Each step returns {dir, jump, done}. Steps advance when done.
  const R = (x) => ({ kind: 'R', x });               // hold right until fox.x >= x
  const L = (x) => ({ kind: 'L', x });               // hold left until fox.x <= x
  const J = (dir = 0) => ({ kind: 'J', dir });       // jump as soon as grounded
  const RJ = (x) => ({ kind: 'RJ', x });             // run right, jump at x
  const LJ = (x) => ({ kind: 'LJ', x });
  const Wt = (ms, dir = 0) => ({ kind: 'W', ms, dir });  // hold dir (or idle) for ms
  const LAND = (dir = 0) => ({ kind: 'LAND', dir });     // hold dir until grounded
  const SET = (o) => ({ kind: 'SET', o });
  const CAM = (x) => ({ kind: 'CAM', x });               // lock camera (null = follow)
  const DROP = (x) => ({ kind: 'DROP', x });             // fox falls back in from the top
  const FACE = (d) => ({ kind: 'FACE', d });
  const WAITBACK = () => ({ kind: 'WAITBACK' });          // wait until fox is back on the ground
  const GOTO = (x) => ({ kind: 'GOTO', x });              // walk to x on the current surface
  const LOOK = (a) => ({ kind: 'LOOK', a });              // tilt the head (negative looks up)

  const SCRIPTS = {
    run: {
      start: { x: 90, face: 1 }, cam: null,
      steps: [Wt(600), RJ(232), LAND(1), Wt(120, 0), RJ(452), LAND(1), R(770), Wt(250), RJ(850), LAND(1), Wt(80), J(1), LAND(1),
        Wt(250), FACE(-1), Wt(350), FACE(1), Wt(150), R(1420), Wt(120, 0), RJ(1440), LAND(1), R(1760), Wt(400), LOOK(-0.3), Wt(2000)],
    },
    moon: {
      start: { x: 1575, face: 1 }, cam: 1430, bug: true,
      steps: [Wt(700), R(1600), Wt(500), FACE(-1), Wt(350), FACE(1), Wt(350), RJ(1708), LAND(1), Wt(6000)],
    },
    fixed: {
      start: { x: 1575, face: 1 }, cam: 1430,
      steps: [Wt(700), R(1620), Wt(450), RJ(1708), LAND(1), Wt(500), J(0), LAND(0), Wt(300), R(2420), Wt(500), FACE(-1), Wt(700), FACE(1), Wt(3000)],
    },
    lanterns: {
      start: { x: 2610, face: 1 }, cam: 2560,
      steps: [Wt(400), RJ(2742), LAND(0), Wt(900), RJ(2900), Wt(380, 1), LAND(0), GOTO(3108), Wt(900),
        R(3290), Wt(150), R(3400), Wt(300), LOOK(-0.32), Wt(1100), LOOK(0), J(1), Wt(300, 1), LAND(0), Wt(500), LOOK(-0.3), Wt(2500)],
    },
    stream: {
      start: { x: 90, face: 1 }, cam: null,
      steps: [
        Wt(1500), RJ(232), LAND(1), Wt(120), RJ(452), LAND(1), R(770), Wt(300), RJ(850), LAND(1), Wt(80), J(1), LAND(1),
        Wt(900), L(1000), Wt(400), RJ(1060), LAND(1), Wt(600), R(1420), Wt(180), RJ(1440), LAND(1), R(1560), Wt(1200),
        // first spring try: the moon jump
        SET({ bug: true }), R(1600), Wt(800), RJ(1708), LAND(1), Wt(3000),
        DROP(1880), WAITBACK(), Wt(2600), SET({ bug: false }),
        L(1640), Wt(600), FACE(1), Wt(500), RJ(1708), LAND(1), Wt(1200), FACE(-1), Wt(700), FACE(1), Wt(400),
        // walk off the ledge into the dark part of the cave
        R(2600), LAND(1), Wt(400), RJ(2742), LAND(0), Wt(1300), RJ(2900), Wt(380, 1), LAND(0), GOTO(3108), Wt(1300),
        R(3290), Wt(200), R(3405), LOOK(-0.32), Wt(2400), LOOK(0), L(3330), Wt(400), FACE(1), Wt(400), RJ(3370), LAND(1), Wt(1600),
        L(3240), Wt(700), L(2900), Wt(500), RJ(2952), LAND(1), Wt(400), LJ(3030), LAND(-1), L(2700), Wt(900), FACE(1), Wt(500),
        // back to the spring: hop onto it from the right, then take it to the ledge again
        LJ(2262), LAND(-1), Wt(700), FACE(1), Wt(400), R(1600), Wt(300), RJ(1708), LAND(1), Wt(900),
        R(2600), LAND(1), R(3290), Wt(500), LOOK(-0.32), Wt(2200), LOOK(0), L(2950), Wt(1200), FACE(1), Wt(8000),
      ],
    },
  };
  let script = SCRIPT && SCRIPTS[SCRIPT] ? SCRIPTS[SCRIPT] : null;
  let stepIdx = 0, stepT = 0;
  if (script) {
    S.fox = newFox(script.start.x, GROUND);
    S.fox.face = script.start.face;
    if (script.bug) S.bug = true;
    S.camLock = script.cam;
  }
  S.camX = S.camLock != null ? S.camLock : clamp(S.fox.x - W * 0.4, 0, WORLD_W - W);

  function scriptInput(dt) {
    const f = S.fox;
    const out = { dir: 0, jump: false };
    while (stepIdx < script.steps.length) {
      const s = script.steps[stepIdx];
      let done = false;
      switch (s.kind) {
        case 'R': if (f.x >= s.x) done = true; else out.dir = 1; break;
        case 'L': if (f.x <= s.x) done = true; else out.dir = -1; break;
        case 'RJ': out.dir = 1; if (f.x >= s.x && f.grounded) { out.jump = true; done = true; } break;
        case 'LJ': out.dir = -1; if (f.x <= s.x && f.grounded) { out.jump = true; done = true; } break;
        case 'J': out.dir = s.dir; if (f.grounded) { out.jump = true; done = true; } break;
        case 'W': out.dir = s.dir; stepT += dt * 1000; if (stepT >= s.ms) { done = true; } break;
        case 'LAND': out.dir = s.dir; if (f.grounded && f.air === 0 && stepT > 0) done = true; stepT += dt * 1000; break;
        case 'SET': Object.assign(S, s.o); done = true; break;
        case 'CAM': S.camLock = s.x; done = true; break;
        case 'FACE': f.face = s.d; done = true; break;
        case 'GOTO': if (Math.abs(f.x - s.x) < 8 && f.grounded) done = true; else out.dir = Math.abs(f.x - s.x) < 8 ? 0 : Math.sign(s.x - f.x); break;
        case 'LOOK': f.lookTarget = s.a; done = true; break;
        case 'DROP': dropBack(s.x); done = true; break;
        case 'WAITBACK': if (!f.gone && f.grounded && !f.noclip) done = true; break;
      }
      if (!done) return out;
      stepIdx++; stepT = 0;
      if (out.jump) return out;
      // instantaneous steps fall through to the next one in the same tick
      if (s.kind === 'R' || s.kind === 'L' || s.kind === 'W' || s.kind === 'LAND' || s.kind === 'WAITBACK') continue;
    }
    return out;
  }

  function dropBack(x) {
    const f = S.fox;
    f.x = x; f.y = -60; f.vx = 0; f.vy = 200; f.gone = false; f.noclip = true; f.moonFlight = false; f.spin = 0; f.grounded = false;
  }

  // ---------- physics ----------
  const G = 2600, RUN = 380, JUMP = 1000, MAXFALL = 1500;
  const SPRING_BASE = 1250, SPRING_GAIN = 0.55, SPRING_CAP = 1480, BUG_GAIN = 2.4;

  function surfaceAt(x) { // highest ground under x (for shadows)
    for (const g of grounds) if (x >= g.x && x <= g.x + g.w) return g.top;
    return null;
  }

  function physics(dt) {
    const f = S.fox;
    let inp;
    if (script) inp = scriptInput(dt);
    else { inp = { dir: (keys.right ? 1 : 0) - (keys.left ? 1 : 0), jump: jumpQueued }; jumpQueued = false; }

    updateSpring(dt);
    if (f.gone) { f.y += f.vy * dt; return; }

    // horizontal
    const target = inp.dir * RUN;
    const acc = f.grounded ? (inp.dir ? 3400 : 4200) : (inp.dir ? 2100 : 900);
    if (f.vx < target) f.vx = Math.min(target, f.vx + acc * dt);
    else if (f.vx > target) f.vx = Math.max(target, f.vx - acc * dt);
    if (inp.dir) f.face = inp.dir;

    if (inp.jump && (f.grounded || f.coyote > 0)) {
      f.vy = -JUMP; f.grounded = false; f.coyote = 0;
      f.squashV -= 6; puff(f.x, f.y, 5, 0.6);
    }

    if (!f.moonFlight) f.vy = Math.min(MAXFALL, f.vy + G * dt);
    else f.vy += G * 0.15 * dt;

    // move x and resolve solid ground sides
    f.x += f.vx * dt;
    for (const g of grounds) {
      if (f.y > g.top + 2 && f.x + FOX_HW > g.x && f.x - FOX_HW < g.x + g.w) {
        if (f.grounded && f.y - g.top <= 32) { f.y = g.top; continue; }   // small step up out of the pool
        if (f.vx > 0 && f.x < g.x + 10) { f.x = g.x - FOX_HW; f.vx = 0; }
        else if (f.vx < 0 && f.x > g.x + g.w - 10) { f.x = g.x + g.w + FOX_HW; f.vx = 0; }
      }
    }
    f.x = clamp(f.x, FOX_HW + 4, WORLD_W - FOX_HW - 4);

    // move y
    const prev = f.y;
    f.y += f.vy * dt;
    const wasGrounded = f.grounded;
    f.grounded = false;
    let landedOn = null;
    if (f.vy >= 0 && !f.noclip) {
      // spring
      const st = GROUND - spring.restH;
      if (Math.abs(f.x - spring.x) < spring.w / 2 + 6 && prev <= st + 1 && f.y >= st) {
        launch(f);
        return;
      }
      for (const g of grounds) {
        if (f.x + FOX_HW + 1 > g.x && f.x - FOX_HW - 1 < g.x + g.w && prev <= g.top + 1 && f.y >= g.top) { f.y = g.top; landedOn = g; }
      }
      for (const p of plats) {
        if (f.x + FOX_HW * 0.6 > p.x && f.x - FOX_HW * 0.6 < p.x + p.w && prev <= p.top + 1 && f.y >= p.top) { f.y = p.top; landedOn = p; }
      }
      if (landedOn) {
        if (!wasGrounded && f.vy > 300) {
          f.squashV += Math.min(14, f.vy / 90);
          puff(f.x, f.y, f.vy > 1200 ? 14 : 7, f.vy > 1200 ? 1.4 : 0.8);
          if (f.vy > 1300) S.shake = 6;
          if (landedOn.pool) for (let i = 0; i < 22; i++) S.particles.push({ kind: 'splash', x: f.x + rr(-24, 24), y: 650, vx: rr(-220, 220), vy: -rr(250, 620), r: rr(2.5, 5), life: 0.9, max: 0.9 });
          S.events.push({ t: S.t, type: 'land', on: landedOn.ledge ? 'ledge' : 'floor', x: f.x, y: f.y });
        }
        f.vy = 0; f.grounded = true; f.coyote = 0.08; f.landedOn = landedOn;
        if (f.dazed === 0 && prev < 0) f.dazed = 2.2;
      }
    }
    if (f.noclip && f.y > ceilY(f.x) + FOX_H + 10) f.noclip = false;
    if (!f.grounded) { f.coyote = Math.max(0, f.coyote - dt); f.air += dt; } else f.air = 0;

    // ceiling
    if (f.vy < 0 && !f.noclip) {
      const head = f.y - FOX_H;
      const cy = ceilY(f.x);
      if (head < cy && head > cy - 140) {
        if (S.bug && f.vy < -2000) {
          if (!f.punched) { f.punched = true; punchCeiling(f.x, cy); }
        } else { f.y = cy + FOX_H; f.vy = 40; }
      }
    }
    if (f.moonFlight && f.y < -260) {
      f.gone = true; f.vy = -1200;
      S.events.push({ t: S.t, type: 'gone' });
      S.twinkles.push({ x: f.x, y: 14, t0: S.t + 1.4 });
    }
    // pit
    if (f.y > H + 120) { Object.assign(f, newFox(120, GROUND)); }
  }

  function launch(f) {
    const vin = f.vy;
    let v = SPRING_BASE + vin * SPRING_GAIN;
    if (S.bug) v = SPRING_BASE + vin * BUG_GAIN; else v = Math.min(v, SPRING_CAP);
    f.y = GROUND - spring.restH; f.vy = -v; f.grounded = false; f.air = 0.001;
    f.squashV -= 12;
    spring.vel += S.bug ? 900 : 520;
    spring.tiltV += S.bug ? 4 : 2;
    spring.hits++;
    puff(spring.x, GROUND - 6, 8, 0.9);
    if (S.bug && v > 2000) {
      f.moonFlight = true; f.punched = false; f.spin = 0;
      S.events.push({ t: S.t, type: 'moon', v });
      S.shake = 4;
    } else {
      S.events.push({ t: S.t, type: 'spring', v });
    }
  }

  function updateSpring(dt) {
    // damped oscillator; the plate is pushed down by velocity kicks
    const k = 380, c = S.bug ? 0.6 : 5.5;
    const a = -k * spring.comp - c * spring.vel;
    spring.vel += a * dt; spring.comp += spring.vel * dt;
    spring.comp = clamp(spring.comp, -20, 24);
    const ta = -260 * spring.tilt - 3 * spring.tiltV;
    spring.tiltV += ta * dt; spring.tilt += spring.tiltV * dt;
  }

  function punchCeiling(x, cy) {
    S.ceilHoles.push({ x, y: cy, t0: S.t });
    S.shake = 10;
    for (let i = 0; i < 18; i++) S.pebbles.push({ x: x + rr(-30, 30), y: cy + rr(-6, 6), vx: rr(-140, 140), vy: rr(-100, 120), r: rr(2.5, 6), rot: rr(0, 6), vr: rr(-8, 8), life: 3 });
    for (let i = 0; i < 14; i++) S.particles.push({ kind: 'dust', x: x + rr(-30, 30), y: cy + rr(0, 10), vx: rr(-80, 80), vy: rr(10, 90), r: rr(8, 18), life: rr(0.8, 1.6), max: 1.6 });
    for (let i = 0; i < 4; i++) S.particles.push({ kind: 'fur', x: x + rr(-20, 20), y: cy + rr(0, 10), vx: rr(-30, 30), vy: rr(20, 50), r: rr(4, 6), life: 6, max: 6, ph: rr(0, 6) });
  }

  function puff(x, y, n, strength) {
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1;
      S.particles.push({ kind: 'dust', x: x + rr(-10, 10), y: y - rr(0, 6), vx: dir * rr(40, 160) * strength, vy: -rr(10, 70) * strength, r: rr(4, 9) * (0.7 + strength * 0.4), life: rr(0.35, 0.7), max: 0.7 });
    }
  }

  function updateFx(dt) {
    const f = S.fox;
    // trail while flying to the moon
    if (f.moonFlight && !f.gone) {
      for (let i = 0; i < 3; i++) {
        S.particles.push({ kind: 'spark', x: f.x + rr(-8, 8), y: f.y - 20 + rr(0, 40), vx: rr(-30, 30), vy: rr(40, 160), r: rr(2, 4.5), life: rr(0.7, 1.4), max: 1.4 });
      }
      S.particles.push({ kind: 'trail', x: f.x + rr(-4, 4), y: f.y - 24, vx: 0, vy: 0, r: 18, life: 2.2, max: 2.2 });
      f.spin += dt * 14;
    }
    // running dust
    if (f.grounded && Math.abs(f.vx) > 200 && S.tick % 9 === 0) S.particles.push({ kind: 'dust', x: f.x - f.face * 18, y: f.y - 3, vx: -f.face * rr(20, 60), vy: -rr(10, 40), r: rr(3, 6), life: 0.45, max: 0.45 });

    for (const p of S.particles) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'dust') { p.vx *= 0.93; p.vy = p.vy * 0.93 - 10 * dt; }
      if (p.kind === 'spark') p.vy += 120 * dt;
      if (p.kind === 'splash') { p.vy += 1800 * dt; if (p.y > 652 && p.vy > 0) p.life = 0; }
      if (p.kind === 'fur') { p.vy = 46; p.vx = Math.sin(S.t * 2.6 + p.ph) * 50; const gt = surfaceAt(p.x); if (gt != null && p.y > gt - 3) { p.y = gt - 3; p.vy = 0; p.vx = 0; } }
    }
    S.particles = S.particles.filter((p) => p.life > 0);
    for (const p of S.pebbles) {
      p.vy += 1800 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= dt;
      const gt = surfaceAt(p.x);
      if (gt != null && p.y > gt - p.r) { p.y = gt - p.r; p.vy *= -0.35; p.vx *= 0.6; p.vr *= 0.5; }
    }
    S.pebbles = S.pebbles.filter((p) => p.life > 0);

    // drips
    if (S.tick % 47 === 0) {
      const s = dripSources[(S.tick / 47) % dripSources.length | 0];
      if (s) S.particles.push({ kind: 'drip', x: s.x, y: ceilY(s.x) + s.len - 4, vx: 0, vy: 0, r: 2.2, life: 1.2, max: 1.2 });
    }
    for (const p of S.particles) if (p.kind === 'drip') { p.vy += 1600 * dt; const gt = surfaceAt(p.x); if (gt != null && p.y > gt) p.life = 0; }

    // lantern pickup
    for (const l of floaters) {
      if (l.lit || l.behindWater) continue;
      const fy = f.y - 30, dx = f.x - l.x, dy = fy - (l.y + bob(l));
      if (dx * dx + dy * dy < 60 * 60) {
        l.lit = 1; l.litT = S.t; S.lanternsLit++;
        S.rings.push({ x: l.x, y: l.y, t0: S.t });
        for (let i = 0; i < 26; i++) { const a = (i / 26) * 6.283; S.particles.push({ kind: 'spark', x: l.x, y: l.y, vx: Math.cos(a) * rr(120, 260), vy: Math.sin(a) * rr(120, 260), r: rr(2, 4), life: rr(0.6, 1.1), max: 1.1 }); }
        S.events.push({ t: S.t, type: 'lantern', id: l.id });
      }
    }

    // fox animation state
    f.runPhase += (Math.abs(f.vx) / RUN) * dt * 15 * (f.grounded ? 1 : 0.2);
    const sk = 240, sc = 16;
    // simple spring for squash
    const sa = -sk * f.squash - sc * f.squashV;
    f.squashV += sa * dt; f.squash += f.squashV * dt;
    f.squash = clamp(f.squash, -0.35, 0.4);
    const lampTarget = -f.vx * 0.0011 + (f.grounded ? 0 : f.vy * 0.0002);
    f.lampV += ((lampTarget - f.lampAng) * 140 - f.lampV * 7) * dt; f.lampAng += f.lampV * dt;
    f.blinkT -= dt; if (f.blinkT < -0.12) f.blinkT = 2.2 + ((S.tick * 7919) % 100) / 40;
    f.tailT += dt * (1 + Math.abs(f.vx) / 200);
    if (f.dazed > 0) f.dazed = Math.max(0, f.dazed - dt);
    f.look = lerp(f.look, Math.abs(f.vx) > 30 ? 0 : f.lookTarget, 1 - Math.exp(-dt * 6));
    f.idleT = f.grounded && Math.abs(f.vx) < 5 ? f.idleT + dt : 0;

    // camera
    if (S.camLock != null) S.camX = lerp(S.camX, S.camLock, 1 - Math.exp(-dt * 3));
    else if (!f.gone && !f.moonFlight) {
      const tgt = clamp(f.x - W * 0.42 + f.face * 70, 0, WORLD_W - W);
      S.camX = lerp(S.camX, tgt, 1 - Math.exp(-dt * 2.6));
    }
    S.shake *= Math.exp(-dt * 8);
  }

  const bob = (l) => Math.sin(S.t * 2 + l.id * 1.7) * 6;

  // ---------- drawing helpers ----------
  function poly(c, pts) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); }
  function smoothPoly(c, pts, close = true) {
    c.beginPath();
    const n = pts.length;
    c.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    for (let i = 1; i < n - (close ? 0 : 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      c.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    if (close) c.closePath();
  }

  function drawBackground(camX) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, C.bgTop); g.addColorStop(1, C.bgBot);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (const L of layers) {
      // a band of cool haze behind each layer separates the depths
      const hz = ctx.createLinearGradient(0, H * 0.35, 0, H);
      hz.addColorStop(0, 'rgba(84,150,150,0)'); hz.addColorStop(0.6, 'rgba(84,150,150,0.07)'); hz.addColorStop(1, 'rgba(84,150,150,0)');
      ctx.fillStyle = hz; ctx.fillRect(0, H * 0.35, W, H * 0.65);
      ctx.save();
      ctx.translate(-camX * L.factor, 0);
      const x0 = camX * L.factor - 120, x1 = x0 + W + 240;
      ctx.fillStyle = L.color;
      // floor mass
      ctx.beginPath(); ctx.moveTo(x0, H + 10);
      for (const p of L.bot) if (p[0] >= x0 - 60 && p[0] <= x1 + 60) ctx.lineTo(p[0], p[1]);
      ctx.lineTo(x1, H + 10); ctx.closePath(); ctx.fill();
      // ceiling mass
      ctx.beginPath(); ctx.moveTo(x0, -10);
      for (const p of L.top) if (p[0] >= x0 - 60 && p[0] <= x1 + 60) ctx.lineTo(p[0], p[1]);
      ctx.lineTo(x1, -10); ctx.closePath(); ctx.fill();
      // spikes (stalactites / stalagmites)
      for (const s of L.sp) {
        if (s.x < x0 - 80 || s.x > x1 + 80) continue;
        ctx.beginPath();
        if (s.up) { const by = sampleY(L.bot, s.x) + 8; ctx.moveTo(s.x - s.w / 2, by); ctx.quadraticCurveTo(s.x - s.w * 0.1, by - s.len * 0.6, s.x, by - s.len); ctx.quadraticCurveTo(s.x + s.w * 0.1, by - s.len * 0.6, s.x + s.w / 2, by); }
        else { const ty = sampleY(L.top, s.x) - 8; ctx.moveTo(s.x - s.w / 2, ty); ctx.quadraticCurveTo(s.x - s.w * 0.1, ty + s.len * 0.6, s.x, ty + s.len); ctx.quadraticCurveTo(s.x + s.w * 0.1, ty + s.len * 0.6, s.x + s.w / 2, ty); }
        ctx.fill();
      }
      if (L.rim) {
        ctx.strokeStyle = L.rim; ctx.lineWidth = 2; ctx.globalAlpha = 0.55;
        ctx.beginPath(); let first = true;
        for (const p of L.bot) if (p[0] >= x0 - 60 && p[0] <= x1 + 60) { if (first) { ctx.moveTo(p[0], p[1]); first = false; } else ctx.lineTo(p[0], p[1]); }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  }
  // midground columns joining ceiling and floor, parallax 0.85
  const columns = [];
  { const r = mulberry(55); for (let x = 260; x < WORLD_W * 0.9 + 600; x += 560 + r() * 420) columns.push({ x, w: 90 + r() * 90, waist: 0.45 + r() * 0.2, lean: (r() - 0.5) * 40 }); }
  function drawColumns(camX) {
    const f = 0.85;
    ctx.save(); ctx.translate(-camX * f, 0);
    for (const c of columns) {
      const sx = c.x - camX * f; if (sx < -300 || sx > W + 300) continue;
      const top = 40, bot = H;
      const w = c.w, m = w * c.waist;
      ctx.fillStyle = '#163840';
      ctx.beginPath();
      ctx.moveTo(c.x - w, top);
      ctx.bezierCurveTo(c.x - w * 0.4, top + 120, c.x - m + c.lean, H * 0.45, c.x - m * 0.9 + c.lean, H * 0.55);
      ctx.bezierCurveTo(c.x - m + c.lean * 0.5, H * 0.75, c.x - w * 0.6, bot - 60, c.x - w * 1.1, bot);
      ctx.lineTo(c.x + w * 1.1, bot);
      ctx.bezierCurveTo(c.x + w * 0.6, bot - 60, c.x + m + c.lean * 0.5, H * 0.75, c.x + m * 0.9 + c.lean, H * 0.55);
      ctx.bezierCurveTo(c.x + m + c.lean, H * 0.45, c.x + w * 0.4, top + 120, c.x + w, top);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(70,128,120,0.45)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(c.x - w * 0.8, top + 20);
      ctx.bezierCurveTo(c.x - w * 0.35, top + 120, c.x - m + c.lean + 4, H * 0.45, c.x - m * 0.9 + c.lean + 4, H * 0.55);
      ctx.bezierCurveTo(c.x - m + c.lean * 0.5 + 4, H * 0.75, c.x - w * 0.6 + 4, bot - 60, c.x - w * 1.0, bot);
      ctx.stroke();
    }
    ctx.restore();
  }
  function sampleY(arr, x) {
    const i = clamp(Math.floor((x + 100) / 60), 0, arr.length - 2);
    return lerp(arr[i][1], arr[i + 1][1], (x - arr[i][0]) / 60);
  }

  function drawCeiling(x0, x1) {
    const cg = ctx.createLinearGradient(0, 0, 0, 140);
    cg.addColorStop(0, '#08141a'); cg.addColorStop(0.6, '#112a2f'); cg.addColorStop(1, '#1d4142');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.moveTo(x0, -20);
    for (const p of ceilPts) if (p[0] >= x0 - 80 && p[0] <= x1 + 80) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(x1, -20); ctx.closePath(); ctx.fill();
    // lip highlight from below (lantern light catches it)
    ctx.strokeStyle = C.rockTop; ctx.lineWidth = 3;
    ctx.beginPath(); let first = true;
    for (const p of ceilPts) if (p[0] >= x0 - 80 && p[0] <= x1 + 80) { if (first) { ctx.moveTo(p[0], p[1]); first = false; } else ctx.lineTo(p[0], p[1]); }
    ctx.stroke();
    for (const s of stalactites) {
      if (s.x < x0 - 60 || s.x > x1 + 60) continue;
      const cy = ceilY(s.x) - 4;
      ctx.fillStyle = C.rock;
      ctx.beginPath(); ctx.moveTo(s.x - s.w / 2, cy);
      ctx.quadraticCurveTo(s.x - s.w * 0.15, cy + s.len * 0.55, s.x, cy + s.len);
      ctx.quadraticCurveTo(s.x + s.w * 0.15, cy + s.len * 0.55, s.x + s.w / 2, cy);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#16302f';
      ctx.beginPath(); ctx.moveTo(s.x - s.w / 2 + 3, cy); ctx.quadraticCurveTo(s.x - s.w * 0.15, cy + s.len * 0.55, s.x, cy + s.len - 2); ctx.quadraticCurveTo(s.x - s.w * 0.05, cy + s.len * 0.4, s.x - s.w * 0.12, cy); ctx.closePath(); ctx.fill();
    }
    // holes punched by the moon jump
    for (const h of S.ceilHoles) {
      const age = S.t - h.t0;
      ctx.save(); ctx.translate(h.x, h.y);
      ctx.scale(1.5, 1.6);
      ctx.fillStyle = '#020507';
      ctx.beginPath();
      ctx.moveTo(-30, 6); ctx.lineTo(-24, -14); ctx.lineTo(-14, -8); ctx.lineTo(-10, -48); ctx.lineTo(-2, -26); ctx.lineTo(2, -60); ctx.lineTo(10, -28); ctx.lineTo(16, -52); ctx.lineTo(20, -12); ctx.lineTo(28, -18); ctx.lineTo(32, 6);
      ctx.closePath(); ctx.fill();
      // the shape of two ears, left behind in the rock
      ctx.strokeStyle = 'rgba(255,190,120,0.55)'; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.strokeStyle = C.rockLip; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-30, 6); ctx.lineTo(-48, 14); ctx.moveTo(32, 6); ctx.lineTo(52, 12); ctx.lineTo(60, 26); ctx.moveTo(-22, 4); ctx.lineTo(-30, 22); ctx.stroke();
      if (age < 0.35) { const rad = 40 * (1 + age * 4); const fg = ctx.createRadialGradient(0, -8, 0, 0, -8, rad); fg.addColorStop(0, `rgba(255,240,200,${0.9 * (1 - age / 0.35)})`); fg.addColorStop(1, `rgba(${WARM},0)`); ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, -8, rad, 0, 6.283); ctx.fill(); }
      ctx.restore();
    }
  }

  function drawGround(g) {
    ctx.fillStyle = C.rock;
    ctx.beginPath(); ctx.moveTo(g.x, H + 20);
    for (const p of g.edge) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(g.x + g.w, H + 20); ctx.closePath(); ctx.fill();
    // top band
    const grad = ctx.createLinearGradient(0, g.top - 4, 0, g.top + 30);
    grad.addColorStop(0, '#24504f'); grad.addColorStop(1, C.rock);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(g.x, g.top + 30);
    for (const p of g.edge) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(g.x + g.w, g.top + 30); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = C.mossDark; ctx.lineWidth = 8; ctx.lineJoin = 'round';
    ctx.beginPath(); g.edge.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1] + 2) : ctx.moveTo(p[0], p[1] + 2))); ctx.stroke();
    ctx.strokeStyle = C.moss; ctx.lineWidth = 4;
    ctx.beginPath(); g.edge.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    ctx.fillStyle = '#0a161b';
    for (const s of g.stones) { ctx.beginPath(); ctx.ellipse(s.x, s.y, s.rx, s.ry, 0, 0, 6.283); ctx.fill(); }
    drawTufts(g.tufts, g.top);
  }
  function drawTufts(tufts, top) {
    ctx.strokeStyle = C.moss; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    for (const t of tufts) {
      const sway = Math.sin(S.t * 1.6 + t.x * 0.05) * 1.5;
      ctx.beginPath();
      ctx.moveTo(t.x - 4, top); ctx.lineTo(t.x - 6 + sway, top - t.h * 0.8);
      ctx.moveTo(t.x, top); ctx.lineTo(t.x + sway, top - t.h);
      ctx.moveTo(t.x + 4, top); ctx.lineTo(t.x + 7 + sway, top - t.h * 0.7);
      ctx.stroke();
    }
  }
  function drawPlat(p) {
    if (p.hidden) return;
    const bottom = Math.max(...p.shape.map((q) => q[1]));
    ctx.save(); poly(ctx, p.shape); ctx.clip();
    const grad = ctx.createLinearGradient(0, p.top, 0, bottom);
    grad.addColorStop(0, '#24504f'); grad.addColorStop(0.35, '#16343a'); grad.addColorStop(1, '#0a161b');
    ctx.fillStyle = grad; ctx.fillRect(p.x - 20, p.top - 10, p.w + 40, bottom - p.top + 20);
    // strata lines on the face
    ctx.strokeStyle = 'rgba(5,12,15,0.55)'; ctx.lineWidth = 2;
    for (let k = 1; k < 3; k++) { ctx.beginPath(); ctx.moveTo(p.x - 10, p.top + k * 18 + 4); ctx.quadraticCurveTo(p.x + p.w / 2, p.top + k * 18 + (k % 2 ? 8 : -2), p.x + p.w + 10, p.top + k * 18 + 2); ctx.stroke(); }
    ctx.restore();
    // moss cap
    ctx.fillStyle = C.mossDark;
    ctx.beginPath(); ctx.roundRect(p.x - 2, p.top - 3, p.w + 4, 9, 4); ctx.fill();
    ctx.fillStyle = C.moss;
    ctx.beginPath(); ctx.roundRect(p.x, p.top - 3, p.w, 5, 3); ctx.fill();
    ctx.strokeStyle = C.mossDark; ctx.lineWidth = 2;
    for (const r of p.roots) { ctx.beginPath(); ctx.moveTo(r.x, p.top + 8); ctx.quadraticCurveTo(r.x + 6, p.top + 8 + r.len * 0.5, r.x + Math.sin(S.t + r.x) * 3, p.top + 8 + r.len); ctx.stroke(); }
    drawTufts(p.tufts, p.top - 2);
  }

  function drawSpring() {
    const s = spring, top = springTop();
    ctx.save(); ctx.translate(s.x, 0);
    // base
    ctx.fillStyle = C.springBase;
    roundRect(-s.w / 2 - 4, GROUND - 10, s.w + 8, 12, 4); ctx.fill();
    // coil
    const coilTop = top + 8, coilBot = GROUND - 8;
    ctx.strokeStyle = C.coil; ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.beginPath();
    const turns = 5;
    for (let i = 0; i <= turns * 2; i++) {
      const y = lerp(coilBot, coilTop, i / (turns * 2));
      const x = (i % 2 ? 1 : -1) * (s.w * 0.3) + Math.sin(s.tilt) * (i / (turns * 2)) * 10;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    // wobble marks while the spring is still ringing
    const ring = Math.min(1, Math.abs(s.vel) / 160 + Math.abs(s.comp) / 10);
    if (ring > 0.15) {
      ctx.strokeStyle = `rgba(240,236,226,${0.75 * ring})`; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (const base of [0, Math.PI]) {
        for (let k = 0; k < 2; k++) {
          ctx.beginPath(); ctx.arc(0, top + 8, s.w / 2 + 12 + k * 11, base - 0.45, base + 0.45); ctx.stroke();
        }
      }
    }
    // plate
    ctx.translate(Math.sin(s.tilt) * 10, top);
    ctx.rotate(s.tilt * 0.08);
    ctx.fillStyle = C.springPlateDark; roundRect(-s.w / 2, 2, s.w, 10, 4); ctx.fill();
    ctx.fillStyle = C.springPlate; roundRect(-s.w / 2, -2, s.w, 9, 4); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; roundRect(-s.w / 2 + 6, -1, s.w - 30, 2.5, 1); ctx.fill();
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

  function drawLanternBody(x, y, scale, glow, swing = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(swing); ctx.scale(scale, scale);
    // handle
    ctx.strokeStyle = C.lampFrame; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(0, -13, 6, Math.PI, 0); ctx.stroke();
    // cap
    ctx.fillStyle = C.lampFrame; roundRect(-9, -15, 18, 5, 2); ctx.fill();
    // glass
    const gl = ctx.createLinearGradient(0, -10, 0, 10);
    const a = 0.25 + glow * 0.75;
    gl.addColorStop(0, `rgba(255,236,190,${a})`); gl.addColorStop(1, `rgba(255,180,90,${a})`);
    ctx.fillStyle = glow > 0.05 ? gl : '#3b3a33';
    roundRect(-7, -11, 14, 19, 4); ctx.fill();
    if (glow > 0.05) { ctx.fillStyle = `rgba(255,250,230,${glow})`; ctx.beginPath(); ctx.ellipse(0, -1, 3, 4.5, 0, 0, 6.283); ctx.fill(); }
    // frame bars
    ctx.strokeStyle = C.lampFrame; ctx.lineWidth = 2;
    roundRect(-7, -11, 14, 19, 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, 8); ctx.stroke();
    ctx.fillStyle = C.lampFrame; roundRect(-8, 7, 16, 4, 2); ctx.fill();
    ctx.restore();
  }

  function drawHanging() {
    for (const h of hanging) {
      if (h.chain) {
        const cy = ceilY(h.x);
        const sw = Math.sin(S.t * 1.1 + h.x) * 0.04;
        ctx.save(); ctx.translate(h.x, cy); ctx.rotate(sw);
        ctx.strokeStyle = '#2a3236'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h.y - cy - 20); ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();
        const ex = h.x + Math.sin(sw) * -(h.y - cy);
        drawLanternBody(ex, h.y, 2, flicker(h.x), sw);
      } else if (h.stand) {
        ctx.strokeStyle = '#2a2018'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(h.x, 270); ctx.lineTo(h.x, h.y + 6); ctx.lineTo(h.x + 14, h.y + 6); ctx.stroke();
        drawLanternBody(h.x + 14, h.y + 26, 1.8, flicker(h.x));
      }
    }
  }
  const flicker = (seed) => 0.88 + 0.08 * Math.sin(S.t * 7.3 + seed) + 0.04 * Math.sin(S.t * 13.1 + seed * 2);

  function drawFloaters() {
    for (const l of floaters) {
      const age = l.lit ? S.t - l.litT : 0;
      const by = bob(l) - (l.lit ? easeOut(age / 0.8) * 26 : 0);
      const glow = l.lit ? Math.min(1, 0.3 + age * 1.6) * flicker(l.id * 9) : l.behindWater ? 0.75 * flicker(4) : 0.18 + 0.08 * Math.sin(S.t * 3 + l.id);
      const sc = 1.7 + (l.lit ? 0.2 * Math.max(0, 1 - age) : 0);
      drawLanternBody(l.x, l.y + by, sc, glow, Math.sin(S.t * 1.4 + l.id) * 0.08);
      if (l.behindWater) {
        const r = ctx.createRadialGradient(l.x, l.y + by, 2, l.x, l.y + by, 70);
        r.addColorStop(0, `rgba(${WARM},0.55)`); r.addColorStop(1, `rgba(${WARM},0)`);
        ctx.fillStyle = r; ctx.beginPath(); ctx.arc(l.x, l.y + by, 70, 0, 6.283); ctx.fill();
      }
      if (!l.lit && !l.behindWater) {
        // faint ember halo so the player can find it
        const r = ctx.createRadialGradient(l.x, l.y + by, 2, l.x, l.y + by, 40);
        r.addColorStop(0, `rgba(${WARM},0.35)`); r.addColorStop(1, `rgba(${WARM},0)`);
        ctx.fillStyle = r; ctx.beginPath(); ctx.arc(l.x, l.y + by, 40, 0, 6.283); ctx.fill();
      }
    }
  }

  function drawWaterfall() {
    const wf = WATERFALL, top = ceilY(wf.x + wf.w / 2) - 10, bot = 652;
    // behind-the-water ledge silhouette
    const hp = plats.find((p) => p.hidden);
    ctx.fillStyle = '#0a1519'; poly(ctx, hp.shape); ctx.fill();
    // sheet
    ctx.save();
    ctx.beginPath(); ctx.moveTo(wf.x, top);
    for (let y = top; y <= bot; y += 30) ctx.lineTo(wf.x - 6 * Math.sin(y * 0.02 + S.t * 3) - (y > bot - 120 ? (y - bot + 120) * 0.12 : 0), y);
    ctx.lineTo(wf.x + wf.w + 18, bot);
    for (let y = bot; y >= top; y -= 30) ctx.lineTo(wf.x + wf.w + 6 * Math.sin(y * 0.023 + S.t * 2.6) + (y > bot - 120 ? (y - bot + 120) * 0.15 : 0), y);
    ctx.closePath();
    const g = ctx.createLinearGradient(wf.x, 0, wf.x + wf.w, 0);
    g.addColorStop(0, `rgba(${C.water},0.30)`); g.addColorStop(0.5, `rgba(${C.water},0.46)`); g.addColorStop(1, `rgba(${C.water},0.30)`);
    ctx.fillStyle = g; ctx.fill();
    ctx.clip();
    // falling streaks
    ctx.strokeStyle = 'rgba(214,244,240,0.55)'; ctx.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const x = wf.x + 6 + (i * 37) % (wf.w - 4) + Math.sin(i * 3.1) * 4;
      const speed = 520 + (i % 5) * 70;
      const len = 40 + (i % 4) * 22;
      ctx.lineWidth = 1.6 + (i % 3);
      for (let k = 0; k < 4; k++) {
        const y = top + ((S.t * speed + i * 97 + k * 180) % (bot - top + 160)) - 80;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + len); ctx.stroke();
      }
    }
    ctx.restore();
    // edges
    ctx.strokeStyle = 'rgba(200,236,234,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(wf.x, top); ctx.lineTo(wf.x - 4, bot - 120); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wf.x + wf.w, top); ctx.lineTo(wf.x + wf.w + 4, bot - 120); ctx.stroke();
  }
  function drawPool() {
    const x0 = 3420, x1 = 3740, y = 650;
    ctx.fillStyle = `rgba(${C.water},0.42)`;
    ctx.beginPath(); ctx.moveTo(x0, y);
    for (let x = x0; x <= x1; x += 20) ctx.lineTo(x, y + Math.sin(x * 0.06 + S.t * 3) * 2);
    ctx.lineTo(x1, 672); ctx.lineTo(x0, 672); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(214,244,240,0.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); for (let x = x0; x <= x1; x += 20) { const yy = y + Math.sin(x * 0.06 + S.t * 3) * 2; x === x0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy); } ctx.stroke();
    // foam
    ctx.fillStyle = 'rgba(230,248,245,0.75)';
    for (let i = 0; i < 14; i++) {
      const ph = (S.t * 1.7 + i * 0.37) % 1;
      const fx = WATERFALL.x - 10 + (i * 53) % (WATERFALL.w + 40);
      ctx.globalAlpha = 1 - ph;
      ctx.beginPath(); ctx.arc(fx + Math.sin(i) * ph * 30, y - ph * 18, 5 + ph * 9, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- the fox ----------
  function drawFox(f) {
    if (f.gone) return;
    ctx.save();
    const sx = 1 + f.squash * 0.9, sy = 1 - f.squash;
    let sx2 = sx, sy2 = sy;
    if (!f.grounded && !f.moonFlight) { const st = clamp(-f.vy / 2600, -0.12, 0.18); sx2 *= 1 - st; sy2 *= 1 + st; }
    // contact shadow
    const gt = surfaceAt(f.x);
    let platTop = null;
    for (const p of plats) if (!p.hidden && f.x > p.x && f.x < p.x + p.w && p.top >= f.y - 2) platTop = platTop == null ? p.top : Math.min(platTop, p.top);
    const shadowY = platTop != null ? Math.min(platTop, gt ?? 9999) : gt;
    if (shadowY != null && !f.moonFlight) {
      const dist = clamp((shadowY - f.y) / 300, 0, 1);
      ctx.fillStyle = `rgba(3,8,10,${0.45 * (1 - dist)})`;
      ctx.beginPath(); ctx.ellipse(f.x, shadowY + 1, 34 * (1 - dist * 0.5), 6 * (1 - dist * 0.5), 0, 0, 6.283); ctx.fill();
    }
    ctx.translate(f.x, f.y);
    if (f.moonFlight) {
      ctx.translate(0, -30);
      ctx.rotate(-Math.PI / 2 * f.face + Math.sin(f.spin) * 0.25);
      ctx.scale(1.35, 0.85);
      ctx.translate(0, 30);
    }
    ctx.scale(f.face * sx2, sy2);
    const tilt = f.grounded ? (Math.abs(f.vx) > 30 ? 0.05 : 0) : clamp(f.vy / 3000, -0.25, 0.3);
    ctx.rotate(tilt);
    ctx.scale(1.5, 1.5);

    const run = f.grounded && Math.abs(f.vx) > 30;
    const ph = f.runPhase;
    const airT = !f.grounded;
    const breathe = f.grounded && !run ? Math.sin(S.t * 2.4) * 0.8 : 0;
    const bodyBob = run ? -Math.abs(Math.sin(ph)) * 3 : breathe;

    const shapes = (mode) => {
      const fill = (col) => { if (mode === 'out') ctx.stroke(); else { ctx.fillStyle = col; ctx.fill(); } };
      // tail
      const tw = Math.sin(f.tailT * 3) * 0.18 + (airT ? 0.35 : 0) + (run ? 0.25 : 0);
      ctx.save(); ctx.translate(-20, -26 + bodyBob); ctx.rotate(-0.25 - tw);
      ctx.beginPath(); ctx.moveTo(0, -4);
      ctx.bezierCurveTo(-18, -18, -40, -16, -48, -4);
      ctx.bezierCurveTo(-50, 4, -40, 10, -26, 8);
      ctx.bezierCurveTo(-14, 7, -6, 6, 0, 6); ctx.closePath(); fill(C.fox);
      if (mode !== 'out') {
        ctx.beginPath(); ctx.moveTo(-38, -14); ctx.bezierCurveTo(-46, -12, -51, -4, -48, 2); ctx.bezierCurveTo(-44, 8, -38, 9, -34, 8); ctx.bezierCurveTo(-38, 0, -39, -7, -38, -14); ctx.closePath();
        ctx.fillStyle = C.cream; ctx.fill();
      }
      ctx.restore();
      // legs
      const legs = [[-16, 0], [-7, Math.PI], [7, Math.PI * 0.5], [16, Math.PI * 1.5]];
      legs.forEach(([lx, off], i) => {
        let a = run ? Math.sin(ph + off) * 0.75 : [-0.12, 0.06, -0.06, 0.12][i];
        if (airT) a = i < 2 ? 0.7 : -0.7;
        if (f.dazed > 0 && f.grounded) a = 0;
        ctx.save(); ctx.translate(lx, -16 + bodyBob); ctx.rotate(a);
        ctx.beginPath(); ctx.roundRect(-3.1, -2, 6.2, 18, 3.1); fill(i % 2 ? C.leg : '#4a2e24');
        ctx.restore();
      });
      // body
      ctx.beginPath(); ctx.ellipse(-2, -25 + bodyBob, 24, 14, -0.05, 0, 6.283); fill(C.fox);
      if (mode !== 'out') {
        ctx.fillStyle = C.foxShade; ctx.beginPath(); ctx.ellipse(-6, -17 + bodyBob, 18, 5, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = C.cream; ctx.beginPath(); ctx.ellipse(13, -22 + bodyBob, 9, 9, 0.3, 0, 6.283); ctx.fill();
      }
      // head
      ctx.save(); ctx.translate(18, -44 + bodyBob * 1.2);
      const look = f.look; ctx.rotate(look);
      // ears
      const ef = airT ? 0.25 : Math.sin(S.t * 1.3) * 0.04;
      ctx.save(); ctx.translate(-8, -12); ctx.rotate(-0.25 - ef);
      ctx.beginPath(); ctx.moveTo(-7, 2); ctx.lineTo(-1, -22); ctx.lineTo(7, 2); ctx.closePath(); fill(C.fox);
      if (mode !== 'out') { ctx.fillStyle = C.leg; ctx.beginPath(); ctx.moveTo(-3.5, -2); ctx.lineTo(-1, -17); ctx.lineTo(3.5, -2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      ctx.save(); ctx.translate(6, -13); ctx.rotate(0.2 - ef * 0.5);
      ctx.beginPath(); ctx.moveTo(-7, 2); ctx.lineTo(0, -21); ctx.lineTo(7, 2); ctx.closePath(); fill(C.fox);
      if (mode !== 'out') { ctx.fillStyle = C.leg; ctx.beginPath(); ctx.moveTo(-3.5, -2); ctx.lineTo(0, -16); ctx.lineTo(3.5, -2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      ctx.beginPath(); ctx.ellipse(0, 0, 17, 15, 0, 0, 6.283); fill(C.fox);
      // snout
      ctx.beginPath(); ctx.moveTo(8, -6); ctx.quadraticCurveTo(22, -2, 27, 3); ctx.quadraticCurveTo(22, 9, 8, 9); ctx.closePath(); fill(C.cream);
      if (mode !== 'out') {
        ctx.fillStyle = C.cream; ctx.beginPath(); ctx.ellipse(4, 6, 11, 7, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = C.ink; ctx.beginPath(); ctx.ellipse(26.5, 2.5, 3.6, 3, 0, 0, 6.283); ctx.fill();
        // eye
        const blink = f.blinkT < 0 || f.dazed > 0;
        if (blink) { ctx.strokeStyle = C.ink; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(4, -4); ctx.quadraticCurveTo(8, -1, 12, -4); ctx.stroke(); }
        else {
          ctx.fillStyle = C.ink; ctx.beginPath(); ctx.ellipse(8, -4, 3.8, 4.8, 0, 0, 6.283); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(9.2, -5.8, 1.5, 0, 6.283); ctx.fill();
        }
        // cheek blush
        ctx.fillStyle = 'rgba(255,140,110,0.45)'; ctx.beginPath(); ctx.ellipse(4, 4, 4, 2.4, 0, 0, 6.283); ctx.fill();
      }
      ctx.restore();
    };
    ctx.lineJoin = 'round';
    ctx.strokeStyle = C.ink; ctx.lineWidth = 4;
    shapes('out');
    shapes('fill');

    // lantern carried in the mouth
    const lx = 40, ly = -40 + bodyBob * 1.2;
    ctx.strokeStyle = C.lampFrame; ctx.lineWidth = 2.2;
    ctx.save(); ctx.translate(lx, ly); ctx.rotate(f.lampAng / (f.face || 1));
    ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(0, 0); ctx.lineTo(0, 10); ctx.stroke();
    ctx.restore();
    const ax = lx + Math.sin(-f.lampAng) * 22, ay = ly + 24;
    drawLanternBody(ax, ay, 1.15, flicker(3), f.lampAng);

    // dazed stars after falling back from the moon
    if (f.dazed > 0) {
      for (let i = 0; i < 3; i++) {
        const a = S.t * 4 + (i * 6.283) / 3;
        star(18 + Math.cos(a) * 18, -72 + Math.sin(a) * 5, 4.5, `rgba(255,226,150,${Math.min(1, f.dazed)})`);
      }
    }
    ctx.restore();
  }
  function star(x, y, r, col) {
    ctx.fillStyle = col; ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; const rad = i % 2 ? r * 0.38 : r; ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); }
    ctx.closePath(); ctx.fill();
  }

  function drawParticles(kindFilter) {
    for (const p of S.particles) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.kind === 'dust') { ctx.fillStyle = `rgba(150,170,168,${0.45 * a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.4 - a * 0.4), 0, 6.283); ctx.fill(); }
      else if (p.kind === 'spark') { ctx.fillStyle = `rgba(255,214,140,${a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * a + 0.6, 0, 6.283); ctx.fill(); }
      else if (p.kind === 'trail') { ctx.fillStyle = `rgba(255,232,190,${0.32 * a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + a * 0.6), 0, 6.283); ctx.fill(); }
      else if (p.kind === 'fur') { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.sin(S.t * 2.6 + p.ph) * 0.8); ctx.globalAlpha = Math.min(1, p.life); ctx.fillStyle = C.fox; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(0, 0, p.r * 1.6, p.r * 0.7, 0, 0, 6.283); ctx.fill(); ctx.stroke(); ctx.restore(); }
      else if (p.kind === 'splash') { ctx.fillStyle = `rgba(214,244,240,${0.85 * a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill(); }
      else if (p.kind === 'drip') { ctx.fillStyle = 'rgba(170,220,220,0.8)'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 1.8, 3.6, 0, 0, 6.283); ctx.fill(); }
    }
    for (const p of S.pebbles) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = '#2c4a4b'; ctx.beginPath(); ctx.moveTo(-p.r, 0); ctx.lineTo(-p.r * 0.3, -p.r); ctx.lineTo(p.r, -p.r * 0.2); ctx.lineTo(p.r * 0.4, p.r); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawMotes() {
    ctx.fillStyle = 'rgba(255,214,160,0.55)';
    for (const m of motes) {
      const x = m.x + Math.sin(S.t * 0.3 * m.s + m.p) * 30;
      const y = m.y + Math.sin(S.t * 0.5 * m.s + m.p * 2) * 20;
      ctx.globalAlpha = 0.35 + 0.35 * Math.sin(S.t * m.s + m.p);
      ctx.beginPath(); ctx.arc(x, y, m.s, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- lighting ----------
  function lights() {
    const L = [];
    const f = S.fox;
    for (const h of hanging) L.push({ x: h.x + (h.stand ? 14 : 0), y: h.y + (h.stand ? 26 : 0), r: 430 * flicker(h.x), a: 1 });
    for (const l of floaters) {
      const by = bob(l);
      if (l.lit) {
        const age = S.t - l.litT;
        const k = age < 1.6 ? 1 - Math.pow(1 - age / 1.6, 3) * (1 + 0) : 1;
        const rad = (90 + (l.region - 90) * k) * flicker(l.id);
        L.push({ x: l.x, y: l.y + by - 26, r: rad, a: 1, big: true });
        L.push({ x: l.x, y: l.y + by - 26, r: rad * 0.75, a: 0.9 });
      } else L.push({ x: l.x, y: l.y + by, r: l.behindWater ? 150 : 85, a: l.behindWater ? 0.85 : 0.6 });
    }
    if (!f.gone) L.push({ x: f.x + f.face * 40, y: f.y - 20, r: 300 * flicker(5), a: 1, fox: true });
    L.push({ x: WATERFALL.x + WATERFALL.w / 2, y: 520, r: 190, a: 0.35, cool: true });
    for (const h of S.ceilHoles) { const age = S.t - h.t0; if (age < 1.2) L.push({ x: h.x, y: h.y, r: 220 * (1 - age / 1.2), a: 0.7 }); }
    return L;
  }

  function drawLighting(camX, Ls) {
    dctx.setTransform(RES, 0, 0, RES, 0, 0);
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(0, 0, W, H);
    // ambient darkness: the unexplored part of the cave (right) is much darker
    const g = dctx.createLinearGradient(-camX, 0, WORLD_W - camX, 0);
    g.addColorStop(0, 'rgba(4,11,15,0.26)');
    g.addColorStop(2380 / WORLD_W, 'rgba(4,11,15,0.32)');
    g.addColorStop(2700 / WORLD_W, 'rgba(3,8,11,0.86)');
    g.addColorStop(1, 'rgba(3,8,11,0.88)');
    dctx.fillStyle = g; dctx.fillRect(0, 0, W, H);
    dctx.globalCompositeOperation = 'destination-out';
    for (const l of Ls) {
      const x = l.x - camX, y = l.y;
      if (x < -l.r || x > W + l.r) continue;
      const rg = dctx.createRadialGradient(x, y, 0, x, y, l.r);
      rg.addColorStop(0, `rgba(0,0,0,${l.a})`);
      rg.addColorStop(0.45, `rgba(0,0,0,${l.a * 0.75})`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      dctx.fillStyle = rg; dctx.fillRect(x - l.r, y - l.r, l.r * 2, l.r * 2);
    }
    ctx.drawImage(dark, 0, 0, W, H);
    // warm bloom from the light sources (they are real lanterns)
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const l of Ls) {
      const x = l.x - camX, y = l.y, r = l.r * (l.big ? 0.5 : 0.7);
      if (x < -r || x > W + r) continue;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      const col = l.cool ? '120,190,196' : WARM;
      const a = l.cool ? 0.06 : (l.fox ? 0.17 : (l.big ? 0.2 : 0.2));
      rg.addColorStop(0, `rgba(${col},${a})`); rg.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = rg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // ring pulse when a lantern is lit
    for (const ring of S.rings) {
      const age = S.t - ring.t0; if (age > 1.4) continue;
      ctx.strokeStyle = `rgba(${WARM},${0.5 * (1 - age / 1.4)})`; ctx.lineWidth = 6 * (1 - age / 1.4) + 1;
      ctx.beginPath(); ctx.arc(ring.x - camX, ring.y - 20, 30 + easeOut(age / 1.4) * 420, 0, 6.283); ctx.stroke();
    }
    ctx.restore();
  }

  function drawForeground(camX) {
    // near rock mounds (parallax 1.3) in the bottom band for depth; low enough to never hide the fox
    const f = 1.3;
    ctx.save(); ctx.translate(-camX * f, 0);
    ctx.fillStyle = '#03080a';
    const r = mulberry(901);
    for (let x = 300; x < WORLD_W * f + 400; x += 900 + r() * 700) {
      const h = 34 + r() * 30, w = 220 + r() * 200;
      if (x - camX * f < -w || x - camX * f > W + w) continue;
      ctx.beginPath(); ctx.moveTo(x - w / 2, H + 5);
      ctx.quadraticCurveTo(x - w * 0.3, H - h, x, H - h);
      ctx.quadraticCurveTo(x + w * 0.3, H - h * 0.9, x + w / 2, H + 5);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  function drawPit() {
    // the gap between the first two ground pieces drops into darkness
    const x0 = 560, x1 = 700;
    const g = ctx.createLinearGradient(0, GROUND, 0, H);
    g.addColorStop(0, 'rgba(3,8,10,0.2)'); g.addColorStop(1, 'rgba(2,5,7,0.95)');
    ctx.fillStyle = g; ctx.fillRect(x0, GROUND - 10, x1 - x0, H - GROUND + 20);
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H * 0.48, H * 0.45, W / 2, H / 2, H * 0.95);
    g.addColorStop(0, 'rgba(2,6,8,0)'); g.addColorStop(1, 'rgba(2,6,8,0.42)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawHud() {
    // three lantern slots, top left
    ctx.save();
    ctx.fillStyle = 'rgba(6,14,18,0.55)';
    ctx.beginPath(); ctx.roundRect(22, 20, 150, 56, 16); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const lit = floaters[i].lit;
      drawLanternBody(56 + i * 42, 52, 1.25, lit ? 1 : 0, 0);
    }
    ctx.restore();
  }

  function drawTwinkles(camX) {
    for (const tw of S.twinkles) {
      const age = S.t - tw.t0; if (age < 0 || age > 0.9) continue;
      const k = Math.sin((age / 0.9) * Math.PI);
      ctx.save(); ctx.translate(tw.x - camX, tw.y + 24); ctx.rotate(age * 3);
      star(0, 0, 16 * k, `rgba(255,236,190,${k})`);
      ctx.restore();
    }
  }

  // ---------- frame ----------
  function render() {
    const camX = Math.round(S.camX * RES) / RES;
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    const shx = S.shake ? Math.sin(S.t * 90) * S.shake : 0;
    const shy = S.shake ? Math.cos(S.t * 77) * S.shake * 0.6 : 0;
    ctx.save(); ctx.translate(shx, shy);
    drawBackground(camX);
    drawColumns(camX);
    ctx.save(); ctx.translate(-camX, 0);
    const x0 = camX - 100, x1 = camX + W + 100;
    drawMotes();
    // lantern 3 sits behind the waterfall
    drawFloaters();
    drawWaterfall();
    drawPit();
    for (const g of grounds) if (g.x < x1 && g.x + g.w > x0) drawGround(g);
    drawPool();
    for (const p of plats) if (p.x < x1 && p.x + p.w > x0) drawPlat(p);
    drawCeiling(x0, x1);
    drawHanging();
    drawSpring();
    drawParticles();
    drawFox(S.fox);
    ctx.restore();
    drawLighting(camX, lights());
    drawTwinkles(camX);
    drawForeground(camX);
    ctx.restore();
    drawVignette();
    drawHud();
  }

  const DT = 1 / 60;
  function tick() {
    S.t += DT; S.tick++;
    physics(DT);
    updateFx(DT);
  }

  let acc = 0;
  window.__step = (ms) => { acc += ms / 1000; while (acc >= DT - 1e-9) { tick(); acc -= DT; } render(); return S.t; };
  window.__state = () => {
    const f = S.fox;
    return { t: +S.t.toFixed(3), x: +f.x.toFixed(1), y: +f.y.toFixed(1), vx: +f.vx.toFixed(0), vy: +f.vy.toFixed(0), grounded: f.grounded, gone: f.gone, moon: f.moonFlight, camX: +S.camX.toFixed(1), lit: S.lanternsLit, step: stepIdx, steps: script ? script.steps.length : 0, events: S.events.slice(), bug: S.bug };
  };
  window.__frame = (type = 'image/png', q) => canvas.toDataURL(type, q);

  render();
  window.__ready = true;
  if (!MANUAL) {
    let last = performance.now();
    const loop = (now) => {
      acc += Math.min(0.1, (now - last) / 1000); last = now;
      while (acc >= DT) { tick(); acc -= DT; }
      render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
})();
