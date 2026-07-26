/* Crater Runner — game.js
 * A self-contained, guaranteed-playable momentum side-scroll rover mechanic (genome:
 * crater-runner): the rover auto-drives a rolling synthwave regolith line. NO GUNS —
 * you manage MOMENTUM: HOP over crater-gaps and rocks (launch harder off ramps), hold
 * BOOST to speed up (it overheats and forces a cooldown), hold BRAKE to widen your
 * reaction window and let a hazard slide past, and fire a timed SHIELD PULSE to
 * ricochet incoming bombs. A front scoop MAGNET-GRABS falling ore/drones into a
 * rising combo you cash at every stage beacon. INTEGRATES the shared Octagonal
 * engine/beacon + the reusable engine/arcade-controls.js deck when present
 * (canonical-origin load), but NEVER depends on any of them for the core loop, so
 * the cabinet plays even if the engine/deck fail to load. Cartridge concerns wired:
 * beacon telemetry (canonical 17-event vocab incl. live "error" reporting), flags.json
 * monetization slots, SEO/OG share deep-link, "Made with Octagonal" backlink. No build
 * step; classic script.
 *
 * DEPTH: procedurally escalating stages (gentle -> gauntlet) — gaps tighten, rocks grow,
 * skies thicken with bombs/ore/drones as stages advance; lives; a rising air+grab combo
 * multiplier cashed at every stage beacon; dust-and-boom particle juice (boost exhaust,
 * landing puffs, crash booms, shield ricochet sparks, ore/drone grab sparkle).
 */
(function () {
  "use strict";

  /* ---- Cartridge integration (all guarded — missing engine = no-op, never a crash) ---- */
  var SLUG = "crater-runner";
  var Beacon = (window.OCTAGO_BEACON && typeof window.OCTAGO_BEACON.emit === "function")
    ? window.OCTAGO_BEACON : { emit: function () {} };
  var Meta = (window.OCTAGO && window.OCTAGO.meta) || null;   // meta-layer lives at OCTAGO.meta
  var VARIANT = "A";
  // Boot the beacon ourselves: this cabinet does NOT call OCTAGO.boot(), so nothing
  // else inits the beacon — without this, emit() only buffers and never POSTs.
  if (window.OCTAGO_BEACON && window.OCTAGO_BEACON.init) {
    window.OCTAGO_BEACON.init({ collector: window.OCTAGO_COLLECTOR || "", key: window.OCTAGO_KEY || "octgnl_pub_live", entity: "slug", slug: SLUG });
  }
  function emit(event, value, unit, dims) {
    try {
      Beacon.emit(event, {
        entity: SLUG, value: value == null ? 1 : value, unit: unit || "count",
        dims: Object.assign({ variant: VARIANT, slug: SLUG }, dims || {})
      });
    } catch (e) {}
  }

  /* ---- live error telemetry (the template pattern for every game) ----------------------
   * A crash used to die silently. Now the rAF loop is wrapped and BOTH global error hooks
   * funnel through emit("error", ...) (the only error verb in the 17-event vocab). Guarded
   * so the reporter itself can never throw. QA (?debug=1) can read errorCount() as evidence.
   */
  var _errCount = 0, _lastErr = null;
  function emitError(msg, src) {
    _errCount++;
    _lastErr = { msg: String(msg == null ? "" : msg), src: String(src == null ? "" : src) };
    try { emit("error", 1, "count", { msg: _lastErr.msg.slice(0, 120), src: _lastErr.src.slice(0, 60) }); } catch (e) {}
  }
  addEventListener("error", function (e) {
    try { emitError((e && e.message) || "error", ((e && e.filename) || "") + ":" + ((e && e.lineno) || 0)); } catch (_) {}
  });
  addEventListener("unhandledrejection", function (e) {
    try { var r = e && e.reason; emitError((r && r.message) || String(r || "rejection"), "promise"); } catch (_) {}
  });

  function xp(n) {
    try {
      if (Meta && Meta.awardXp) { Meta.awardXp(n); return; }
      if (Meta && Meta.addXP) { Meta.addXP(n); return; }
    } catch (e) {}
    emit("xp_earn", n, "count");   // ensure the event fires even without the engine
  }

  var reduce = false;
  try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /* ---- procedural WebAudio SFX ---------------------------------------------------------
   * Every sound is SYNTHESIZED (OscillatorNode/GainNode/noise buffer) so the cartridge
   * ships ZERO audio assets — asset weight stays flat. The AudioContext is created lazily
   * and resumed on the first user gesture (browser autoplay policy). A mute toggle persists
   * to localStorage.
   */
  var Sound = (function () {
    var ctx = null, master = null, muted = false;
    try { muted = localStorage.getItem("oct.crater-runner.muted") === "1"; } catch (e) {}
    var VOL = 0.5;
    function ensure() {
      if (ctx) return ctx;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : VOL;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; }
      return ctx;
    }
    function unlock() {
      var c = ensure();
      if (c && c.state === "suspended") { try { c.resume(); } catch (e) {} }
    }
    function tone(o) {
      if (muted) return;
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime, dur = o.dur || 0.08;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || "square";
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1 != null) { try { osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dur); } catch (e) {} }
      var peak = o.gain == null ? 0.28 : o.gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function noise(dur, gain) {
      if (muted) return;
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime, n = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(); src.buffer = buf;
      var hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 500;
      var g = c.createGain(); g.gain.value = gain == null ? 0.22 : gain;
      src.connect(hp); hp.connect(g); g.connect(master);
      src.start(t0);
    }
    function arp(freqs, step, type) {
      if (muted) return;
      for (var i = 0; i < freqs.length; i++) {
        (function (f, d) { setTimeout(function () { tone({ type: type, f0: f, dur: step * 1.5, gain: 0.24 }); }, d * 1000); })(freqs[i], step * i);
      }
    }
    function comboMul(combo) { return Math.pow(2, Math.min(15, (combo | 0)) / 12); }
    var SFX = {
      hop:      function () { tone({ type: "square", f0: 360, f1: 620, dur: 0.09, gain: 0.22 }); },
      land:     function () { tone({ type: "triangle", f0: 220, f1: 120, dur: 0.06, gain: 0.16 }); noise(0.05, 0.10); },
      clear:    function (o) { var m = comboMul(o && o.combo); tone({ type: "triangle", f0: 520 * m, f1: 780 * m, dur: 0.10, gain: 0.22 }); },
      ramp:     function () { tone({ type: "sawtooth", f0: 260, f1: 720, dur: 0.16, gain: 0.24 }); },
      grab:     function (o) { var m = comboMul(o && o.combo); tone({ type: "sine", f0: 660 * m, f1: 1100 * m, dur: 0.10, gain: 0.22 }); },
      grabBig:  function (o) { arp([660, 880, 1175, 1568], 0.045, "sine"); },
      shield:   function () { tone({ type: "sine", f0: 900, f1: 300, dur: 0.14, gain: 0.26 }); },
      ricochet: function () { tone({ type: "sawtooth", f0: 1200, f1: 220, dur: 0.16, gain: 0.28 }); noise(0.10, 0.16); },
      boost:    function () { tone({ type: "sawtooth", f0: 180, f1: 340, dur: 0.10, gain: 0.14 }); },
      overheat: function () { tone({ type: "square", f0: 140, f1: 60, dur: 0.30, gain: 0.24 }); },
      boom:     function () { tone({ type: "sawtooth", f0: 200, f1: 40, dur: 0.30, gain: 0.32 }); noise(0.28, 0.30); },
      life:     function () { tone({ type: "sawtooth", f0: 400, f1: 90, dur: 0.38, gain: 0.28 }); },
      beacon:   function () { arp([523, 659, 784, 1047, 1319], 0.075, "triangle"); },
      over:     function () { arp([440, 349, 262, 175], 0.16, "sawtooth"); },
      // BRAKE was previously "rewarded" only by the absence of a crash — silent to the player.
      // brakeOn gives the hold itself a tactile grind; brakeSave is a distinct, satisfying
      // whoosh+chime fired the instant a brake-through actually pays off (a hazard cleared
      // while holding brake), so the skill has its own identity instead of borrowing "clear".
      brakeOn:  function () { tone({ type: "sawtooth", f0: 130, f1: 90, dur: 0.10, gain: 0.10 }); noise(0.06, 0.05); },
      brakeSave: function () { tone({ type: "sine", f0: 200, f1: 640, dur: 0.16, gain: 0.24 }); noise(0.05, 0.08); arp([640, 960], 0.05, "sine"); },
      // maxCombo: the x6 cap used to hit silently. This is the "you're at the ceiling" fanfare.
      maxCombo: function () { arp([784, 988, 1175, 1568, 2093], 0.05, "triangle"); tone({ type: "sine", f0: 1568, f1: 2400, dur: 0.22, gain: 0.20 }); }
    };
    return {
      unlock: unlock,
      play: function (name, opts) { try { if (SFX[name]) SFX[name](opts); } catch (e) {} },
      isMuted: function () { return muted; },
      toggle: function () {
        muted = !muted;
        try { localStorage.setItem("oct.crater-runner.muted", muted ? "1" : "0"); } catch (e) {}
        if (master) master.gain.value = muted ? 0 : VOL;
        if (!muted) unlock();
        return muted;
      }
    };
  })();

  /* ---- canvas / geometry ---------------------------------------------------------------- */
  var cvs = document.getElementById("game"), ctx = cvs.getContext("2d");
  var W = cvs.width, H = cvs.height;                 // 480 x 600
  var BASE_Y = 462;                                   // ground baseline (screen y)
  var ROVER_X = 128;                                  // rover's fixed screen x
  var ROVER_W = 46, ROVER_H = 24, WHEEL_R = 9;

  var GRAV = 1560;                                    // px/s^2
  var JUMP_V = 650;                                   // hop impulse (px/s, upward)
  var RAMP_V = 760;                                   // ramp auto-launch impulse
  var HOLD_GRAV_MUL = 0.55, HOLD_MAX_T = 0.16;        // brief float while holding HOP on the way up

  var SPEED0 = 220, SPEED_RAMP = 16;                  // px/s baseline + per-stage ramp
  var BOOST_MUL = 1.75, BRAKE_MUL = 0.55;
  var HEAT_RATE = 46, HEAT_COOL = 30;                 // %/s while boosting / cooling
  var OVERHEAT_T = 2.2;                                // forced lockout seconds once heat maxes

  var STAGE_LEN = 1700;                               // world px per stage (beacon spacing)
  var LOOKAHEAD = 900;                                 // world px generated ahead of the rover
  var I_FRAMES = 1.05;                                 // post-crash invulnerability (s)
  var SHIELD_DUR = 0.42, SHIELD_CD = 1.1;

  var GAP_BONUS = 30, ROCK_BONUS = 26, RAMP_BONUS = 14, ORE_BONUS = 18, DRONE_BONUS = 42, SHIELD_BONUS = 34, BEACON_BASE = 130;
  var MULT_STEP = 4, MULT_MAX = 6;

  /* ---- DOM refs ------------------------------------------------------------------------- */
  var els = {
    score: document.getElementById("score"), best: document.getElementById("best"),
    lives: document.getElementById("lives"), level: document.getElementById("level"),
    combo: document.getElementById("combo"), heat: document.getElementById("heat"),
    overlay: document.getElementById("overlay"), title: document.getElementById("title"),
    tag: document.getElementById("tag"), start: document.getElementById("start"),
    daily: document.getElementById("daily"), metaProgress: document.getElementById("meta-progress"),
    shareWrap: document.getElementById("share-wrap"), share: document.getElementById("share"),
    status: document.getElementById("a11y-status")
  };

  var best = +(localStorage.getItem("oct.crater-runner.best") || 0);
  if (els.best) els.best.textContent = best;

  /* ---- lightweight meta-progression (furthest stage + a shared daily-seed run) ----------
   * No new beacon dims/events here (telemetry vocab is out of scope for this pass) — this is
   * pure localStorage + UI, same pattern as the existing "best" high score.
   */
  var bestStage = +(localStorage.getItem("oct.crater-runner.beststage") || 1);
  function dayIndex() { return Math.floor(Date.now() / 86400000); }           // UTC-day bucket, stable for all players
  function dailyBestKey() { return "oct.crater-runner.daily." + dayIndex(); }
  function dailyBest() { return +(localStorage.getItem(dailyBestKey()) || 0); }
  function renderMetaProgress() {
    if (!els.metaProgress) return;
    els.metaProgress.textContent = "furthest stage " + bestStage + " · today's best " + dailyBest();
  }
  renderMetaProgress();

  /* ---- haptics (mobile-primary control deck) — guarded, inert on unsupported browsers --- */
  function haptic(pattern) {
    try { if (navigator && typeof navigator.vibrate === "function") navigator.vibrate(pattern); } catch (e) {}
  }

  /* ---- deterministic-ish RNG (mulberry32) — reproducible spawn spacing ------------------ */
  var _seed = 0x9e3779b9;
  function seedRng(n) { _seed = (0x9e3779b9 ^ (n * 2654435761)) >>> 0; }
  function rng() {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    var t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randRange(a, b) { return a + rng() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerpHex(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
    var br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
    var r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), b2 = Math.round(ab + (bb - ab) * t);
    return "rgb(" + r + "," + g + "," + b2 + ")";
  }

  /* ---- beat-my-score deep link (?s=&p=) ------------------------------------------------- */
  var q = new URLSearchParams(location.search);
  var rivalScore = +q.get("s") || 0, rival = q.get("p") || "";

  /* ---- flags.json -> monetization slots -------------------------------------------------- */
  fetch("./flags.json").then(function (r) { return r.json(); }).then(function (f) {
    var slots = (f && f.slots) || {};
    VARIANT = (f && f.experiment && f.experiment.variant) || "A";
    Object.keys(slots).forEach(function (k) {
      var on = slots[k] && slots[k].on;
      var el = document.querySelector('[data-slot="' + k + '"]');
      if (el && on) {
        el.classList.add("on");
        if (k === "cabinet_banner") emit("ad_impression", 1, "count", { network: (slots[k].network || "house") });
        if (k === "insert_coin_jar") {
          el.href = "https://ko-fi.com/octagonal";        // hosted checkout — zero server
          el.addEventListener("click", function () {
            emit("coin_insert", 1, "count");
            emit("checkout_step", 1, "count", { step: "jar_click" });
          });
        }
      }
    });
  }).catch(function () {/* flags optional */ });

  /* ---- arcade control deck (engine/arcade-controls.js) ---------------------------------- */
  var deck = null;
  (function mountDeck() {
    try {
      var mountEl = document.getElementById("controls");
      if (mountEl && window.ArcadeControls) {
        deck = window.ArcadeControls.mount({
          mount: mountEl, theme: "synthwave",
          layout: [
            { id: "hop", type: "button", side: "left", label: "HOP", sub: "jump",
              ariaLabel: "Hop — jump over craters and rocks", keys: ["Space", "ArrowUp", "KeyW"] },
            { id: "shield", type: "button", side: "left", label: "SHIELD", sub: "pulse",
              ariaLabel: "Shield pulse — ricochet an incoming bomb", keys: ["KeyS", "KeyX"] },
            { id: "boost", type: "button", side: "right", label: "BOOST", sub: "hold",
              ariaLabel: "Boost — hold to speed up, overheats on a meter", keys: ["ShiftLeft", "ShiftRight", "KeyB"] },
            { id: "brake", type: "button", side: "right", label: "BRAKE", sub: "hold",
              ariaLabel: "Brake — hold to slow down and let a hazard slide past", keys: ["ControlLeft", "ControlRight", "KeyN", "ArrowDown"] }
          ]
        });
      }
    } catch (e) { deck = null; }
  })();

  /* ---- keyboard fallback (deck missing OR just extra input) ----------------------------- */
  var kb = { hop: false, shield: false, boost: false, brake: false };
  var kbEdge = { hop: false, shield: false };
  var KEY_HOP = { Space: 1, ArrowUp: 1, KeyW: 1 };
  var KEY_SHIELD = { KeyS: 1, KeyX: 1 };
  var KEY_BOOST = { ShiftLeft: 1, ShiftRight: 1, KeyB: 1 };
  var KEY_BRAKE = { ControlLeft: 1, ControlRight: 1, KeyN: 1, ArrowDown: 1 };
  addEventListener("keydown", function (e) {
    if (e.repeat) return;
    if (KEY_HOP[e.code]) { if (!kb.hop) kbEdge.hop = true; kb.hop = true; e.preventDefault(); }
    else if (KEY_SHIELD[e.code]) { if (!kb.shield) kbEdge.shield = true; kb.shield = true; e.preventDefault(); }
    else if (KEY_BOOST[e.code]) { kb.boost = true; e.preventDefault(); }
    else if (KEY_BRAKE[e.code]) { kb.brake = true; e.preventDefault(); }
    else if (e.code === "KeyP") togglePause();
  });
  addEventListener("keyup", function (e) {
    if (KEY_HOP[e.code]) kb.hop = false;
    else if (KEY_SHIELD[e.code]) kb.shield = false;
    else if (KEY_BOOST[e.code]) kb.boost = false;
    else if (KEY_BRAKE[e.code]) kb.brake = false;
  });

  /* ---- state ------------------------------------------------------------------------------
   * S.rover: { airY (0=grounded, px above ground), vy (px/s, +up), holdT }
   * dist = total world px traveled (also the scroll offset).
   */
  var S = null;
  var particles = [];   // dust / boom / spark juice
  var shake = 0;
  var ground = [];       // {x0,x1,type:'gap'|'rock'|'ramp', h, cleared, entered}
  var sky = [];          // {worldX, type:'bomb'|'ore'|'drone', y (screen-relative offset), grabbed, hit, phase}
  var beacons = [];      // {worldX, cashed}
  var genGroundX = 0, genSkyX = 0, genBeaconX = 0;
  var mesasFar = [], mesasNear = [];

  function newRun(seed) {
    seedRng(seed);
    ground = []; sky = []; beacons = [];
    genGroundX = 500; genSkyX = 380; genBeaconX = STAGE_LEN;
    beacons.push({ worldX: genBeaconX, cashed: false });
    mesasFar = proceduralMesas(1400, 620, 60, 40);
    mesasNear = proceduralMesas(900, 900, 90, 70);
  }
  function proceduralMesas(spacing, count, hMin, hMax) {
    var arr = [], x = -200;
    for (var i = 0; i < count; i++) {
      x += spacing * 0.5 + rng() * spacing;
      arr.push({ x: x, w: 120 + rng() * 220, h: hMin + rng() * (hMax - hMin) });
    }
    return arr;
  }

  function stageOf(dist) { return Math.floor(dist / STAGE_LEN) + 1; }

  /* ---- procedural ground/sky/beacon generation ------------------------------------------ */
  function spawnAhead(dist) {
    var stage = stageOf(dist);
    // QA (2026-07): competent runs died at 14-21s / stage 3-4 — the gauntlet ramp hit too
    // early. diffStage lags two stages behind the real stage number so stages 1-3 all play
    // at the former stage-1 gentleness (a first run should comfortably clear stage 2), and
    // the gauntlet proper only bites once a run has proven it can survive that far.
    var diffStage = Math.max(1, stage - 2);
    while (genGroundX < dist + LOOKAHEAD) {
      var gMin = Math.max(210 - diffStage * 9, 118), gMax = gMin + 100;
      genGroundX += randRange(gMin, gMax);
      var roll = rng();
      if (roll < 0.36) {
        var w = clamp(64 + diffStage * 3 + rng() * 36, 64, 130);
        ground.push({ x0: genGroundX, x1: genGroundX + w, type: "gap" });
        genGroundX += w;
      } else if (roll < 0.62) {
        var rw = 32 + rng() * 14, rh = clamp(22 + diffStage * 2 + rng() * 22, 22, 90);
        ground.push({ x0: genGroundX, x1: genGroundX + rw, type: "rock", h: rh });
        genGroundX += rw;
      } else if (roll < 0.84) {
        var rmw = 48;
        ground.push({ x0: genGroundX, x1: genGroundX + rmw, type: "ramp" });
        genGroundX += rmw;
      } else {
        var rmw2 = 48;
        ground.push({ x0: genGroundX, x1: genGroundX + rmw2, type: "ramp" });
        genGroundX += rmw2 + 10;
        var w2 = clamp(115 + diffStage * 4 + rng() * 40, 115, 170);
        ground.push({ x0: genGroundX, x1: genGroundX + w2, type: "gap" });
        genGroundX += w2;
      }
    }
    while (genSkyX < dist + LOOKAHEAD) {
      var sMin = Math.max(300 - diffStage * 10, 150), sMax = Math.max(430 - diffStage * 10, 240);
      genSkyX += randRange(sMin, sMax);
      var r2 = rng();
      var type = r2 < 0.40 ? "bomb" : (r2 < 0.75 ? "ore" : "drone");
      sky.push({ worldX: genSkyX, type: type, grabbed: false, hit: false, phase: rng() * Math.PI * 2 });
    }
    while (genBeaconX < dist + LOOKAHEAD) {
      genBeaconX += STAGE_LEN;
      beacons.push({ worldX: genBeaconX, cashed: false });
    }
    // prune what has scrolled well behind
    var cut = dist - 260;
    ground = ground.filter(function (o) { return o.x1 > cut; });
    sky = sky.filter(function (o) { return o.worldX > cut - 40; });
    beacons = beacons.filter(function (o) { return o.worldX > cut; });
  }

  function groundAt(x) {
    // returns the obstacle occupying world-x x, or null (flat ground)
    for (var i = 0; i < ground.length; i++) { var o = ground[i]; if (x >= o.x0 && x <= o.x1) return o; }
    return null;
  }
  /* ---- rover / run lifecycle ------------------------------------------------------------- */
  function startGame(daily) {
    S = {
      mode: "play", score: 0, lives: 3, level: 1, best: best,
      dist: 0, speed: SPEED0, boosting: false, braking: false, prevBraking: false, heat: 0, overheatT: 0,
      airY: 0, vy: 0, grounded: true, holdT: 0,
      combo: 0, mult: 1, maxComboHit: false, comboFlash: 0, invulnT: 0, shieldT: 0, shieldCd: 0,
      shakeFlash: 0, lastSig: "", startTs: Date.now(), last: performance.now(),
      inGap: null, inRock: null, rampArm: true,
      daily: !!daily
    };
    particles = []; shake = 0;
    newRun(daily ? (dayIndex() || 1) : ((Date.now() % 2147483647) || 1));
    spawnAhead(0);
    els.overlay.classList.add("hide");
    hud();
    emit("play_start", 1, "count", {});
    emit("level", 1, "count", {});
    announce(daily ? "Daily run started. Three lives." : "Run started. Three lives.");
    requestAnimationFrame(loop);
  }

  function addScore(n) {
    S.score += Math.round(n);
    if (els.score) els.score.textContent = S.score;
  }
  function addCombo(n) {
    S.combo += n;
    S.mult = clamp(1 + Math.floor(S.combo / MULT_STEP), 1, MULT_MAX);
    if (S.mult >= MULT_MAX && !S.maxComboHit) {
      S.maxComboHit = true;
      celebrateMaxCombo();
    }
  }
  function resetCombo() {
    S.combo = 0; S.mult = 1; S.maxComboHit = false;
  }
  function celebrateMaxCombo() {
    S.comboFlash = 1;
    shake = Math.max(shake, 0.35);
    spawnSparkle(ROVER_X, BASE_Y - 90, "#ffd23f", 26);
    spawnSparkle(ROVER_X, BASE_Y - 60, "#20e6ff", 14);
    Sound.play("maxCombo");
    haptic([16, 40, 16, 40, 30]);
    announce("Max combo! x" + MULT_MAX + ".");
  }

  function doHop() {
    if (!S || S.mode !== "play") return;
    if (!S.grounded) return;
    Sound.unlock();
    S.vy = JUMP_V; S.grounded = false; S.holdT = HOLD_MAX_T;
    Sound.play("hop");
    haptic(8);
  }

  function fireShield() {
    if (!S || S.mode !== "play") return;
    if (S.shieldCd > 0) return;
    Sound.unlock();
    S.shieldT = SHIELD_DUR; S.shieldCd = SHIELD_CD;
    Sound.play("shield");
    haptic(12);
  }

  /* ---- BRAKE feedback -------------------------------------------------------------------
   * Previously braking's only feedback was the absence of a crash. brakeOn gives the hold a
   * tactile identity; brakeSaveFX celebrates the moment it actually pays off (a hazard cleared
   * while braking through it) with its own sound, sparkle color, score kicker and haptic.
   */
  var BRAKE_SAVE_BONUS_MUL = 1.4;
  function brakeSaveFX(x, y) {
    Sound.play("brakeSave");
    spawnSparkle(x, y, "#bfe9ff", 14);
    haptic([10, 30, 18]);
    announce("Brake save!");
  }

  function currentSpeedMul() {
    if (S.overheatT > 0) return 0.72;                 // limp home while cooling down
    if (S.boosting) return BOOST_MUL;
    if (S.braking) return BRAKE_MUL;
    return 1;
  }

  function crash(reason) {
    if (S.invulnT > 0) return;
    S.lives--;
    resetCombo();
    S.invulnT = I_FRAMES;
    S.boosting = false; S.braking = false; S.overheatT = 0; S.heat = 0;
    shake = 1; S.shakeFlash = 0.5;
    spawnBoom(ROVER_X, BASE_Y - 14);
    Sound.play("boom");
    haptic([25, 30, 55]);
    announce("Crash! " + S.lives + " lives left.");
    hud();
    if (S.lives <= 0) { endGame(false); return; }
    Sound.play("life");
  }

  function crossBeacon(b) {
    b.cashed = true;
    var bonus = BEACON_BASE * S.mult;
    addScore(bonus);
    S.level = stageOf(S.dist);
    S.speed = SPEED0 + (S.level - 1) * SPEED_RAMP;
    if (S.level > bestStage) {
      bestStage = S.level;
      try { localStorage.setItem("oct.crater-runner.beststage", bestStage); } catch (e) {}
    }
    spawnSparkle(ROVER_X, BASE_Y - 80, "#ffd23f", 18);
    Sound.play("beacon");
    haptic([12, 25, 12]);
    announce("Stage " + S.level + ". Combo cashed for " + Math.round(bonus) + ".");
    emit("level", S.level, "count", {});
    emit("score", S.score, "count");
    hud();
  }

  function endGame(won) {
    S.mode = "over";
    Sound.play("over");
    var dur = Date.now() - S.startTs;
    emit("score", S.score, "count");
    emit("play_end", dur, "ms", { score: S.score, level: S.level, won: 0 });
    xp(S.score);
    if (S.score > best) { best = S.score; try { localStorage.setItem("oct.crater-runner.best", best); } catch (e) {} if (els.best) els.best.textContent = best; }
    var newBest = S.score >= best;
    var newDaily = false;
    if (S.daily && S.score > dailyBest()) {
      newDaily = true;
      try { localStorage.setItem(dailyBestKey(), S.score); } catch (e) {}
    }
    renderMetaProgress();
    els.title.textContent = "GAME OVER";
    els.tag.innerHTML = "score <b style='color:#20e6ff'>" + S.score + "</b> · stage <b>" + S.level + "</b><br>" +
      (newBest ? "★ NEW BEST ★" : "best " + best) +
      (S.daily ? (newDaily ? " · ★ NEW DAILY BEST ★" : " · daily best " + dailyBest()) : "") +
      " · furthest stage " + bestStage +
      " — press HOP to run again";
    els.start.textContent = "▶ INSERT COIN";
    els.shareWrap.style.display = "";
    announce("Game over. Final score " + S.score + ".");
    els.overlay.classList.remove("hide");
  }

  /* ---- juice: particles ------------------------------------------------------------------ */
  function spawnDust(x, y, n, col) {
    if (reduce) return;
    for (var i = 0; i < n; i++) {
      particles.push({ x: x, y: y, vx: (Math.random() - 0.5) * 90 - 40, vy: -Math.random() * 60 - 10, t: 1, s: 2 + Math.random() * 3, col: col || "#8f86c9", kind: "dust" });
    }
  }
  function spawnBoom(x, y) {
    if (reduce) { shake = 0.4; return; }
    for (var i = 0; i < 26; i++) {
      var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260;
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, t: 1, s: 2 + Math.random() * 4, col: Math.random() < 0.5 ? "#ff2fb9" : "#ffd23f", kind: "boom" });
    }
  }
  function spawnSparkle(x, y, col, n) {
    if (reduce) return;
    for (var i = 0; i < (n || 12); i++) {
      var a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 140;
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, t: 1, s: 1.5 + Math.random() * 2.5, col: col, kind: "spark" });
    }
  }
  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.t -= dt * (p.kind === "dust" ? 1.6 : 1.9);
      if (p.t <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 340 * dt;
    }
    if (shake > 0) shake = Math.max(0, shake - dt * 2.4);
  }

  /* ---- physics ---------------------------------------------------------------------------- */
  function physics(dt) {
    // input snapshot (deck OR keyboard fallback)
    var hopPressed = false, shieldPressed = false, boostDown = false, brakeDown = false;
    if (deck) {
      var st = deck.state();
      hopPressed = !!(st.hop && st.hop.justPressed);
      shieldPressed = !!(st.shield && st.shield.justPressed);
      boostDown = !!(st.boost && st.boost.down);
      brakeDown = !!(st.brake && st.brake.down);
      deck.frameEnd();
    }
    // keyboard always mirrors too (works alongside or instead of the deck)
    if (kbEdge.hop) { hopPressed = true; kbEdge.hop = false; }
    if (kbEdge.shield) { shieldPressed = true; kbEdge.shield = false; }
    boostDown = boostDown || kb.boost;
    brakeDown = brakeDown || kb.brake;

    if (hopPressed) doHop();
    if (shieldPressed) fireShield();

    S.boosting = boostDown && !brakeDown && S.overheatT <= 0;
    S.braking = brakeDown && !S.boosting;
    if (S.braking && !S.prevBraking) Sound.play("brakeOn");   // tactile cue the instant brake engages
    S.prevBraking = S.braking;

    // heat meter
    if (S.overheatT > 0) {
      S.overheatT -= dt;
      S.heat = Math.max(0, S.heat - HEAT_COOL * 1.4 * dt);
      if (S.overheatT <= 0) S.heat = 0;
    } else if (S.boosting) {
      S.heat += HEAT_RATE * dt;
      if (S.heat >= 100) { S.heat = 100; S.overheatT = OVERHEAT_T; S.boosting = false; Sound.play("overheat"); announce("Overheated. Cooling down."); }
    } else {
      S.heat = Math.max(0, S.heat - HEAT_COOL * dt);
    }

    var mul = currentSpeedMul();
    var curSpeed = S.speed * mul;
    S.dist += curSpeed * dt;
    spawnAhead(S.dist);

    // vertical motion
    if (!S.grounded) {
      var g = (S.vy > 0 && S.holdT > 0 && (kb.hop || (deck && deck.state().hop && deck.state().hop.down))) ? GRAV * HOLD_GRAV_MUL : GRAV;
      S.holdT = Math.max(0, S.holdT - dt);
      S.vy -= g * dt;
      S.airY += S.vy * dt;
      if (S.airY <= 0) {
        S.airY = 0; S.vy = 0; S.grounded = true;
        if (!reduce) spawnDust(ROVER_X - 6, BASE_Y, 6, "#8f86c9");
        Sound.play("land");
      }
    }

    // ramp auto-launch: entering a ramp segment while grounded fires a bonus launch
    var rampHit = groundAt(S.dist);
    if (S.grounded && rampHit && rampHit.type === "ramp" && !rampHit.entered) {
      rampHit.entered = true;
      S.vy = RAMP_V; S.grounded = false; S.holdT = 0;
      addScore(RAMP_BONUS * S.mult); addCombo(1);
      spawnDust(ROVER_X, BASE_Y, 10, "#20e6ff");
      Sound.play("ramp");
      hud();
    }

    // gap / rock collision + clean-clear bookkeeping (checked at the rover's world x)
    var atX = S.dist;
    var g2 = groundAt(atX);
    if (g2 && g2.type === "gap") {
      if (!g2.entered) { g2.entered = true; g2.cleanSoFar = true; }
      if (S.airY <= 0.5) {
        if (S.invulnT <= 0) crash("gap");
      }
      S._lastGap = g2;
    } else if (S._lastGap && !S._lastGap.cleared) {
      S._lastGap.cleared = true;
      var gapBraked = S.braking;
      addScore((gapBraked ? GAP_BONUS * BRAKE_SAVE_BONUS_MUL : GAP_BONUS) * S.mult); addCombo(1);
      if (gapBraked) { brakeSaveFX(ROVER_X, BASE_Y - 30); }
      else { Sound.play("clear", { combo: S.combo }); spawnSparkle(ROVER_X, BASE_Y - 30, "#20e6ff", 8); }
      hud();
      S._lastGap = null;
    }
    if (g2 && g2.type === "rock") {
      if (!g2.entered) g2.entered = true;
      if (S.airY < g2.h) {
        if (S.invulnT <= 0) crash("rock");
      }
      S._lastRock = g2;
    } else if (S._lastRock && !S._lastRock.cleared) {
      S._lastRock.cleared = true;
      var rockBraked = S.braking;
      addScore((rockBraked ? ROCK_BONUS * BRAKE_SAVE_BONUS_MUL : ROCK_BONUS) * S.mult); addCombo(1);
      if (rockBraked) { brakeSaveFX(ROVER_X, BASE_Y - 30); }
      else { Sound.play("clear", { combo: S.combo }); spawnSparkle(ROVER_X, BASE_Y - 30, "#ff2fb9", 8); }
      hud();
      S._lastRock = null;
    }

    // sky hazards / pickups — collide/collect near the rover's world x
    for (var i = 0; i < sky.length; i++) {
      var s = sky[i];
      if (s.grabbed || s.hit) continue;
      var dx = s.worldX - S.dist;
      if (Math.abs(dx) > 16) continue;
      var falling = Math.min(1, Math.max(0, (S.dist - (s.worldX - 260)) / 260)); // 0..1 descent progress for bombs
      if (s.type === "bomb") {
        if (falling >= 0.92) {
          if (S.shieldT > 0) {
            s.hit = true;
            addScore(SHIELD_BONUS * S.mult); addCombo(1);
            Sound.play("ricochet");
            spawnSparkle(ROVER_X, BASE_Y - 100, "#ff8a1e", 16);
            hud();
          } else if (S.invulnT <= 0) {
            s.hit = true;
            crash("bomb");
          }
        }
      } else if (s.type === "ore") {
        s.grabbed = true;
        addScore(ORE_BONUS * S.mult); addCombo(1);
        Sound.play("grab", { combo: S.combo });
        spawnSparkle(ROVER_X, BASE_Y - 90, "#8be04a", 10);
        hud();
      } else if (s.type === "drone") {
        if (!S.grounded) {
          s.grabbed = true;
          addScore(DRONE_BONUS * S.mult); addCombo(1);
          Sound.play("grabBig");
          spawnSparkle(ROVER_X, BASE_Y - 150, "#ffd23f", 20);
          hud();
        }
      }
    }

    // stage beacons
    for (var j = 0; j < beacons.length; j++) {
      var b = beacons[j];
      if (!b.cashed && S.dist >= b.worldX) crossBeacon(b);
    }

    if (S.shieldT > 0) S.shieldT = Math.max(0, S.shieldT - dt);
    if (S.shieldCd > 0) S.shieldCd = Math.max(0, S.shieldCd - dt);
    if (S.invulnT > 0) S.invulnT = Math.max(0, S.invulnT - dt);

    // ambient score trickle + a light boost exhaust puff
    addScore(curSpeed * dt * 0.045);
    if (S.boosting && Math.random() < 0.5) spawnDust(ROVER_X - 22, BASE_Y - 6, 1, "#ff2fb9");
  }

  /* ---- rendering -------------------------------------------------------------------------- */
  function drawMesas(list, parallax, col, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var sx = m.x - S.dist * parallax;
      if (sx + m.w < -40 || sx > W + 40) continue;
      ctx.beginPath();
      ctx.moveTo(sx, BASE_Y + 4);
      ctx.lineTo(sx + m.w * 0.3, BASE_Y - m.h);
      ctx.lineTo(sx + m.w * 0.7, BASE_Y - m.h * 0.7);
      ctx.lineTo(sx + m.w, BASE_Y + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    var sh = shake > 0 && !reduce ? shake * 6 : 0;
    ctx.save();
    if (sh) ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);

    // gauntlet telegraph: the deeper the run, the warmer/redder the whole palette grades —
    // an environmental read of escalating danger, not just a HUD number climbing.
    var warmth = S ? clamp(((S.level || 1) - 1) / 7, 0, 1) : 0;

    // sky gradient
    var sky1 = ctx.createLinearGradient(0, 0, 0, BASE_Y);
    sky1.addColorStop(0, lerpHex("#1a0c3e", "#3a0e14", warmth));
    sky1.addColorStop(0.55, lerpHex("#2a1256", "#5c1620", warmth));
    sky1.addColorStop(1, lerpHex("#3a1550", "#7a2118", warmth));
    ctx.fillStyle = sky1; ctx.fillRect(0, 0, W, BASE_Y + 40);

    // bloom sun
    var sunX = W * 0.72, sunY = 118;
    var sg = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, 130);
    sg.addColorStop(0, "rgba(255,210,63,0.85)"); sg.addColorStop(0.4, "rgba(255," + Math.round(80 - 40 * warmth) + ",180," + (0.35 + 0.15 * warmth) + ")"); sg.addColorStop(1, "rgba(255,80,180,0)");
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sunX, sunY, 130, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffe9a8"; ctx.beginPath(); ctx.arc(sunX, sunY, 34, 0, Math.PI * 2); ctx.fill();

    drawMesas(mesasFar, 0.10, lerpHex("#241154", "#4a121a", warmth), 0.75);
    drawMesas(mesasNear, 0.22, lerpHex("#170a3d", "#340f14", warmth), 0.9);

    // horizon scanline strip
    ctx.fillStyle = lerpHex("#0d0530", "#2e0c10", warmth); ctx.fillRect(0, BASE_Y + 4, W, H - BASE_Y - 4);
    ctx.strokeStyle = "rgba(32,230,255,0.35)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, BASE_Y + 4); ctx.lineTo(W, BASE_Y + 4); ctx.stroke();

    if (S) {
      drawGround();
      drawSky();
      drawBeacons();
      drawRover();
      drawParticles();
    }
    ctx.restore();

    if (S && S.shakeFlash > 0) {
      ctx.fillStyle = "rgba(255,47,185," + (S.shakeFlash * 0.35) + ")";
      ctx.fillRect(0, 0, W, H);
      S.shakeFlash = Math.max(0, S.shakeFlash - 0.04);
    }
    // max-combo (x6) celebration pulse — a gold vignette riser, distinct from the crash flash
    if (S && S.comboFlash > 0) {
      ctx.save();
      ctx.globalAlpha = S.comboFlash * 0.4;
      var cg = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, W * 0.8);
      cg.addColorStop(0, "rgba(255,210,63,0.85)"); cg.addColorStop(1, "rgba(255,210,63,0)");
      ctx.fillStyle = cg; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      S.comboFlash = Math.max(0, S.comboFlash - 0.018);
    }
  }

  function drawGround() {
    // flat ground base line already drawn; render obstacles relative to rover
    for (var i = 0; i < ground.length; i++) {
      var o = ground[i];
      var sx0 = o.x0 - S.dist + ROVER_X, sx1 = o.x1 - S.dist + ROVER_X;
      if (sx1 < -20 || sx0 > W + 20) continue;
      if (o.type === "gap") {
        ctx.fillStyle = "#050213";
        ctx.fillRect(sx0, BASE_Y + 4, sx1 - sx0, H - BASE_Y - 4);
        ctx.strokeStyle = "rgba(255,47,185,0.55)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx0, BASE_Y + 4); ctx.lineTo(sx1, BASE_Y + 4); ctx.stroke();
      } else if (o.type === "rock") {
        var h = o.h, w = sx1 - sx0;
        ctx.fillStyle = "#3d2570";
        ctx.beginPath();
        ctx.moveTo(sx0, BASE_Y + 2); ctx.lineTo(sx0 + w * 0.5, BASE_Y - h); ctx.lineTo(sx1, BASE_Y + 2);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "#ff2fb9"; ctx.lineWidth = 1.5; ctx.stroke();
      } else if (o.type === "ramp") {
        var w2 = sx1 - sx0;
        ctx.fillStyle = "#20304f";
        ctx.beginPath();
        ctx.moveTo(sx0, BASE_Y + 2); ctx.lineTo(sx1, BASE_Y - 46); ctx.lineTo(sx1, BASE_Y + 2);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "#20e6ff"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
  }

  function drawBeacons() {
    for (var i = 0; i < beacons.length; i++) {
      var b = beacons[i];
      var sx = b.worldX - S.dist + ROVER_X;
      if (sx < -30 || sx > W + 30) continue;
      var glow = b.cashed ? 0.25 : 0.9;
      ctx.save();
      ctx.globalAlpha = glow;
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx, BASE_Y + 2); ctx.lineTo(sx, BASE_Y - 130); ctx.stroke();
      ctx.fillStyle = "#ffd23f";
      ctx.beginPath(); ctx.arc(sx, BASE_Y - 138, 8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function drawSky() {
    for (var i = 0; i < sky.length; i++) {
      var s = sky[i];
      if (s.grabbed || s.hit) continue;
      var sx = s.worldX - S.dist + ROVER_X;
      if (sx < -30 || sx > W + 30) continue;
      var fall = Math.min(1, Math.max(0, (S.dist - (s.worldX - 260)) / 260));
      if (s.type === "bomb") {
        var sy = 40 + fall * (BASE_Y - 40 - 10);
        ctx.save();
        ctx.shadowColor = "#ff5a2e"; ctx.shadowBlur = 12;
        ctx.fillStyle = "#ff5a2e";
        ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = "rgba(255,90,46,0.4)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx, sy - 16); ctx.lineTo(sx, sy - 4); ctx.stroke();
      } else if (s.type === "ore") {
        var oy = BASE_Y - 80 + Math.sin(s.phase + S.dist * 0.006) * 8;
        ctx.save();
        ctx.translate(sx, oy); ctx.rotate(S.dist * 0.004 + s.phase);
        ctx.fillStyle = "#8be04a"; ctx.shadowColor = "#8be04a"; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(0, -8); ctx.lineTo(7, 0); ctx.lineTo(0, 8); ctx.lineTo(-7, 0); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (s.type === "drone") {
        var dy = BASE_Y - 150 + Math.sin(s.phase + S.dist * 0.01) * 14;
        ctx.save();
        ctx.fillStyle = "#ffd23f"; ctx.shadowColor = "#ffd23f"; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.ellipse(sx, dy, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#0b0420";
        ctx.beginPath(); ctx.ellipse(sx, dy - 3, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
  }

  function drawRover() {
    var y = BASE_Y - S.airY;
    var blink = S.invulnT > 0 && Math.floor(S.invulnT * 14) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = blink ? 0.35 : 1;
    // wheels
    ctx.fillStyle = "#0b0420";
    ctx.beginPath(); ctx.arc(ROVER_X - 14, y - 2, WHEEL_R, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ROVER_X + 14, y - 2, WHEEL_R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#20e6ff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ROVER_X - 14, y - 2, WHEEL_R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(ROVER_X + 14, y - 2, WHEEL_R, 0, Math.PI * 2); ctx.stroke();
    // body (chrome buggy)
    var grad = ctx.createLinearGradient(ROVER_X - ROVER_W / 2, y - ROVER_H, ROVER_X + ROVER_W / 2, y);
    grad.addColorStop(0, "#eaf6ff"); grad.addColorStop(0.5, "#8fd8ff"); grad.addColorStop(1, "#2b6fa0");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ROVER_X - ROVER_W / 2, y - 6);
    ctx.lineTo(ROVER_X - ROVER_W / 2 + 6, y - ROVER_H);
    ctx.lineTo(ROVER_X + ROVER_W / 2 - 10, y - ROVER_H);
    ctx.lineTo(ROVER_X + ROVER_W / 2 + 6, y - 6);
    ctx.lineTo(ROVER_X + ROVER_W / 2, y - 2);
    ctx.lineTo(ROVER_X - ROVER_W / 2, y - 2);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#ff2fb9"; ctx.lineWidth = 1.5; ctx.stroke();
    // magnet scoop (front)
    ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(ROVER_X + ROVER_W / 2 + 4, y - 10, 7, Math.PI * 0.2, Math.PI * 1.3); ctx.stroke();
    // boost exhaust
    if (S.boosting && !reduce) {
      ctx.fillStyle = "rgba(255,138,30,0.75)";
      ctx.beginPath(); ctx.moveTo(ROVER_X - ROVER_W / 2, y - 8); ctx.lineTo(ROVER_X - ROVER_W / 2 - 16 - Math.random() * 8, y - 4); ctx.lineTo(ROVER_X - ROVER_W / 2, y - 2); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // shield ring
    if (S.shieldT > 0) {
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(S.shieldT * 30);
      ctx.strokeStyle = "#20e6ff"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ROVER_X, y - 10, 30, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.t);
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /* ---- HUD / a11y ------------------------------------------------------------------------- */
  function hud() {
    if (!S) return;
    if (els.score) els.score.textContent = S.score;
    if (els.lives) els.lives.textContent = S.lives;
    if (els.level) els.level.textContent = S.level;
    if (els.combo) els.combo.textContent = "x" + S.mult;
    if (els.heat) {
      els.heat.textContent = Math.round(S.heat) + "%";
      els.heat.style.color = S.overheatT > 0 ? "#ff2fb9" : (S.heat > 70 ? "#ffd23f" : "#20e6ff");
    }
    if (els.status) {
      var sig = S.mode + "|" + S.level + "|" + S.lives;
      if (sig !== S.lastSig && S.mode === "play") {
        S.lastSig = sig;
        announce("Stage " + S.level + ", " + S.lives + " lives, score " + S.score + ".");
      }
    }
  }
  var _lastAnnounce = "";
  function announce(msg) {
    if (!els.status || msg === _lastAnnounce) return;
    _lastAnnounce = msg; els.status.textContent = msg;
  }

  function togglePause() {
    if (!S) return;
    if (S.mode === "play") {
      S.mode = "pause";
      els.title.textContent = "PAUSED";
      els.tag.innerHTML = "press P / HOP to resume";
      els.start.textContent = "▶ RESUME";
      els.shareWrap.style.display = "none";
      els.overlay.classList.remove("hide");
    } else if (S.mode === "pause") {
      S.mode = "play";
      els.overlay.classList.add("hide");
    }
  }

  function onStartPress() {
    Sound.unlock();
    if (!S || S.mode === "idle" || S.mode === "over") { startGame(); return; }
    if (S.mode === "pause") { togglePause(); return; }
  }
  function onDailyPress() {
    Sound.unlock();
    if (!S || S.mode === "idle" || S.mode === "over") { startGame(true); return; }
    if (S.mode === "pause") { togglePause(); return; }
  }
  if (els.start) els.start.addEventListener("click", onStartPress);
  if (els.daily) els.daily.addEventListener("click", onDailyPress);
  if (els.share) els.share.addEventListener("click", share);

  function share() {
    var pid = localStorage.getItem("oct_pid") || ("g" + (Date.now() % 1e7));
    try { localStorage.setItem("oct_pid", pid); } catch (e) {}
    var sc = S ? S.score : 0;
    var url = location.origin + location.pathname + "?s=" + sc + "&p=" + encodeURIComponent(pid);
    emit("share_click", 1, "count", { score: sc });
    var text = "I ran " + sc + " in Crater Runner — can you beat it? ⯃";
    if (navigator.share) { navigator.share({ title: "Crater Runner", text: text, url: url }).catch(function () {}); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () {
        els.share.textContent = "✓ LINK COPIED";
        setTimeout(function () { els.share.textContent = "↗ SHARE / BEAT MY SCORE"; }, 1500);
      }).catch(function () { prompt("Copy your challenge link:", url); });
    } else prompt("Copy your challenge link:", url);
  }

  /* ---- main loop (variable timestep, clamped) -------------------------------------------- */
  function loop(now) {
    if (!S) return;
    try {
      var dt = (now - S.last) / 1000; S.last = now;
      if (dt > 0.1) dt = 0.1;

      if (S.mode === "play") {
        if (S.__injectErr) { S.__injectErr = false; throw new Error("qa-injected loop error"); }
        physics(dt);
      }
      updateParticles(dt);
      draw();

      if (S.mode === "play" || S.mode === "pause") requestAnimationFrame(loop);
      else requestAnimationFrame(loopIdle);
    } catch (err) {
      // fail SAFE: report once, drop to the idle loop (no physics) so a per-frame throw
      // cannot spin the CPU. The cabinet stays interactive; a reload restarts cleanly.
      emitError((err && err.message) || err, "loop");
      // End through the REAL game-over path so the overlay renders, the restart control re-arms,
      // sound plays, and the score/play_end beacons fire for the crashed session (matching a
      // natural death). endGame() is self-guarded; if IT throws, fall back to a raw mode flip so
      // the fail-safe can never itself wedge on a frozen frame.
      try { if (S && S.mode === "play") endGame(false); }
      catch (_) { try { if (S) S.mode = "over"; } catch (__) {} }
      try { requestAnimationFrame(loopIdle); } catch (_) {}
    }
  }
  function loopIdle(now) {
    if (!S) return;
    try {
      var dt = (now - S.last) / 1000; S.last = now; if (dt > 0.1) dt = 0.1;
      if ((kbEdge.hop || (deck && deck.state().hop && deck.state().hop.justPressed)) && (S.mode === "idle" || S.mode === "over")) { kbEdge.hop = false; startGame(); if (deck) deck.frameEnd(); return; }
      if (deck) deck.frameEnd();
      kbEdge.hop = false; kbEdge.shield = false;
      updateParticles(dt);
      draw();
      if (S && (S.mode === "over" || S.mode === "idle")) requestAnimationFrame(loopIdle);
    } catch (err) {
      emitError((err && err.message) || err, "loopIdle");
    }
  }

  /* ---- optional test hook (inert unless ?debug=1) — used only by the QA smoke harness --- */
  if (/[?&]debug=1/.test(location.search)) {
    window.__CR = {
      state: function () { return S; },
      errorCount: function () { return _errCount; },
      lastError: function () { return _lastErr; },
      injectError: function () { if (S) S.__injectErr = true; },
      start: function () { startGame(); },
      startDaily: function () { startGame(true); },
      hop: function () { doHop(); },
      shield: function () { fireShield(); },
      setBoost: function (v) { kb.boost = !!v; },
      setBrake: function (v) { kb.brake = !!v; },
      forceCrash: function () { if (S) crash("debug"); },
      forceBeacon: function () { if (S && beacons[0]) crossBeacon(beacons[0]); },
      forceMaxCombo: function () { if (S) { S.combo = MULT_STEP * MULT_MAX; addCombo(0); } },
      ground: function () { return ground.slice(0, 20); },
      sky: function () { return sky.slice(0, 20); },
      audioMute: function () { return Sound.isMuted(); },
      bestStage: function () { return bestStage; },
      dailyBest: function () { return dailyBest(); }
    };
  }

  /* ---- boot: idle attract-mode + deep-link challenge ------------------------------------- */
  S = { mode: "idle", last: performance.now(), airY: 0, dist: 0, mult: 1, heat: 0, overheatT: 0, boosting: false, level: 1, lives: 3, score: 0 };
  newRun(1);
  spawnAhead(0);
  if (rivalScore > 0) {
    els.tag.innerHTML = "a challenger ran <b style='color:#20e6ff'>" + rivalScore + "</b> — can you beat it?<br>HOP / BOOST / BRAKE / SHIELD";
    emit("cross_promo_click", 1, "count", { referrer: "share", rival: rival });
  }
  draw();          // draw the idle board behind the overlay
  requestAnimationFrame(loopIdle);   // idle attract loop — polls HOP (deck + keyboard) so a
                                      // press starts the run even before the first game frame
})();
