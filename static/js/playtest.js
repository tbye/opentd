/**
 * OpenTD editor playtest runtime — spawn waves, pathfind, simple towers.
 */
(function () {
  "use strict";

  const state = {
    active: false,
    paused: false,
    speed: 1,
    lives: 0,
    gold: 0,
    wave: 0,
    monsters: [],
    towers: [],
    shots: [],
    simGrid: null,
    wallHp: null, // key "x,y" -> remaining hits
    spawnQueue: [],
    spawnTimer: 0,
    lastTs: 0,
    raf: 0,
    status: "idle", // idle | running | won | lost
    doc: null,
  };

  const els = {};
  let getDoc = () => null;
  let onModeChange = () => {};

  const DIRS4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const DIRS8 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function bindDom() {
    els.stage = document.querySelector(".editor-stage");
    els.overlay = $("playtest-overlay");
    els.grid = $("editor-grid");
    els.play = $("pt-play");
    els.pause = $("pt-pause");
    els.stop = $("pt-stop");
    els.waveBtn = $("pt-wave");
    els.lives = $("pt-lives");
    els.gold = $("pt-gold");
    els.waveNum = $("pt-wave-num");
    els.mobs = $("pt-mobs");
    els.msg = $("pt-msg");
    els.placeMenu = $("playtest-place-menu");
    els.gameInfoBar = $("game-info-bar");
  }

  function setMsg(text, tone) {
    if (!els.msg) return;
    els.msg.textContent = text;
    els.msg.classList.remove("is-error", "is-ok");
    if (tone === "error") els.msg.classList.add("is-error");
    if (tone === "ok") els.msg.classList.add("is-ok");
  }

  function formatTimer(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return String(s);
  }

  function updateHud() {
    if (els.lives) els.lives.textContent = String(state.lives);
    if (els.gold) els.gold.textContent = String(state.gold);
    if (els.waveNum) els.waveNum.textContent = String(state.wave);
    if (els.mobs) els.mobs.textContent = String(state.monsters.length);

    let timerDisplay = "—";
    if (state.phase === "start_countdown" || state.phase === "between_waves") {
      timerDisplay = formatTimer(state.countdown);
    } else if (state.phase === "wave_active") {
      timerDisplay = "—";
    }

    const values = {
      score: state.score | 0,
      lives: state.lives,
      gold: state.gold,
      wave: state.wave,
      timer: timerDisplay,
      mobs: state.monsters.length,
      title: (state.doc && state.doc.title) || "Untitled",
    };
    if (
      window.OpenTDEditor &&
      typeof window.OpenTDEditor.renderScoreboardBar === "function"
    ) {
      window.OpenTDEditor.renderScoreboardBar(els.gameInfoBar, values);
    } else if (els.gameInfoBar) {
      // Minimal fallback if editor helpers unavailable
      els.gameInfoBar.innerHTML =
        `<span class="game-info-bar__stat game-info-bar__stat--score">Score<strong>${values.score}</strong></span>` +
        `<span class="game-info-bar__stat">Lives<strong>${values.lives}</strong></span>` +
        `<span class="game-info-bar__stat">Gold<strong>${values.gold}</strong></span>` +
        `<span class="game-info-bar__stat">Wave<strong>${values.wave}</strong></span>` +
        `<span class="game-info-bar__stat game-info-bar__stat--timer">Countdown<strong>${values.timer}</strong></span>`;
    }
  }

  function setControlsRunning(running) {
    if (els.play) els.play.disabled = running && !state.paused;
    if (els.pause) els.pause.disabled = !running || state.paused;
    if (els.stop) els.stop.disabled = !running && state.status === "idle";
    if (els.waveBtn) els.waveBtn.disabled = !running || state.paused;
    if (els.play) {
      const label = running && state.paused ? "Resume" : "Play";
      els.play.dataset.playLabel = label;
      if (!running) {
        els.play.disabled = false;
        els.stop.disabled = true;
      } else if (!state.paused) {
        els.play.disabled = true;
      }
    }
    // Icons + yellow/green theme live in refreshPlayability (do not wipe with textContent).
    if (window.OpenTDEditor && window.OpenTDEditor.refreshPlayability) {
      window.OpenTDEditor.refreshPlayability();
    }
  }

  function cellSizePx() {
    return gridMetrics().cs;
  }

  /** Pixel layout of the editor grid (cells + 1px gaps + border). */
  function gridMetrics() {
    const cell = els.grid && els.grid.querySelector(".editor-cell");
    if (!cell || !els.grid) {
      return { cs: 28, gap: 1, borderLeft: 2, borderTop: 2, pitch: 29 };
    }
    const cs = cell.getBoundingClientRect().width || 28;
    const style = getComputedStyle(els.grid);
    const gapRaw = parseFloat(style.columnGap || style.gap);
    const gap = Number.isFinite(gapRaw) ? gapRaw : 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    return {
      cs,
      gap,
      borderLeft,
      borderTop,
      pitch: cs + gap,
    };
  }

  /** Map continuous cell-space coords (centers at n+0.5) to overlay pixels. */
  function cellCoordToPx(coord, border, pitch, gap) {
    return border + coord * pitch - gap * 0.5;
  }

  /** Top-left of integer cell (x, y) in overlay pixels. */
  function cellOriginPx(x, y, m) {
    return {
      left: m.borderLeft + x * m.pitch,
      top: m.borderTop + y * m.pitch,
    };
  }

  /**
   * Map a viewport click to a grid cell. Prefers the real cell element under the
   * pointer, then placed-tower bounds, then pitch math (includes gap strips).
   */
  function clientToCell(clientX, clientY) {
    if (!els.grid || !state.simGrid) return null;

    // 1) Hit-test real cell elements (most accurate; ignores gap/border math drift)
    const cells = els.grid.querySelectorAll(".editor-cell[data-x][data-y]");
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const r = cell.getBoundingClientRect();
      if (
        clientX >= r.left &&
        clientX < r.right &&
        clientY >= r.top &&
        clientY < r.bottom
      ) {
        const x = parseInt(cell.dataset.x, 10);
        const y = parseInt(cell.dataset.y, 10);
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      }
    }

    const m = gridMetrics();
    const gr = els.grid.getBoundingClientRect();

    // 2) Prefer a placed tower whose full-cell rect contains the point
    for (let i = 0; i < state.towers.length; i++) {
      const t = state.towers[i];
      const origin = cellOriginPx(t.x, t.y, m);
      const left = gr.left + origin.left;
      const top = gr.top + origin.top;
      if (
        clientX >= left &&
        clientX < left + m.cs &&
        clientY >= top &&
        clientY < top + m.cs
      ) {
        return { x: t.x | 0, y: t.y | 0 };
      }
    }

    // 3) Pitch math (covers 1px gaps between cells)
    const x = Math.floor((clientX - gr.left - m.borderLeft) / m.pitch);
    const y = Math.floor((clientY - gr.top - m.borderTop) / m.pitch);
    if (!inBounds(state.simGrid, x, y)) return null;
    return { x, y };
  }

  function cloneGrid(grid) {
    return grid.map((row) => row.slice());
  }

  function key(x, y) {
    return x + "," + y;
  }

  function inBounds(grid, x, y) {
    return y >= 0 && x >= 0 && y < grid.length && x < (grid[0] ? grid[0].length : 0);
  }

  function hasPlacedTower(x, y) {
    return state.towers.some((t) => t.x === x && t.y === y);
  }

  function isOpenWalkable(grid, x, y, gameType) {
    if (!inBounds(grid, x, y)) return false;
    const k = grid[y][x];
    if (gameType === "monster_march") {
      return k === "path" || k === "spawn" || k === "exit";
    }
    // rush / castle: open terrain; placed towers and walls block
    if (k === "blocked") return false;
    if (hasPlacedTower(x, y)) return false;
    return true;
  }

  function isObstacle(grid, x, y) {
    if (!inBounds(grid, x, y)) return false;
    const k = grid[y][x];
    return k === "blocked" || hasPlacedTower(x, y);
  }

  function pathHasObstacle(path, grid) {
    if (!path) return false;
    for (let i = 1; i < path.length; i++) {
      if (isObstacle(grid, path[i].x, path[i].y)) return true;
    }
    return false;
  }

  function rebuildPath(prev, endX, endY) {
    const path = [];
    let cur = [endX, endY];
    while (cur) {
      path.push({ x: cur[0], y: cur[1] });
      const p = prev.get(key(cur[0], cur[1]));
      cur = p;
    }
    path.reverse();
    return path;
  }

  function heuristicToGoals(x, y, goals) {
    let best = Infinity;
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * A* shortest path.
   * Monster Rush uses 8-directional moves (diagonal cost √2) so units head
   * toward the exit instead of axis-biased BFS corridors.
   * March keeps 4-directional steps on painted path cells.
   */
  function findPath(grid, sx, sy, goals, walkableFn, opts) {
    opts = opts || {};
    const diagonals = !!opts.diagonals;
    const dirs = diagonals ? DIRS8 : DIRS4;
    const goalSet = new Set(goals.map((g) => key(g.x, g.y)));
    if (goalSet.has(key(sx, sy))) return [{ x: sx, y: sy }];

    function canStep(x, y, dx, dy) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkableFn(nx, ny)) return false;
      // No corner-cutting through blocked diagonals.
      if (dx !== 0 && dy !== 0) {
        if (!walkableFn(x + dx, y) || !walkableFn(x, y + dy)) return false;
      }
      return true;
    }

    const sk = key(sx, sy);
    const gScore = new Map([[sk, 0]]);
    const prev = new Map([[sk, null]]);
    // open: [f, g, x, y] — sort by f, then by g (prefer progress), then by h
    const open = [[heuristicToGoals(sx, sy, goals), 0, sx, sy]];

    while (open.length) {
      open.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const [, g, x, y] = open.shift();
      const ck = key(x, y);
      if (g !== gScore.get(ck)) continue;
      if (goalSet.has(ck)) {
        return rebuildPath(prev, x, y);
      }
      for (let i = 0; i < dirs.length; i++) {
        const dx = dirs[i][0];
        const dy = dirs[i][1];
        if (!canStep(x, y, dx, dy)) continue;
        const nx = x + dx;
        const ny = y + dy;
        const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
        const ng = g + step;
        const nk = key(nx, ny);
        if (!gScore.has(nk) || ng < gScore.get(nk) - 1e-9) {
          gScore.set(nk, ng);
          prev.set(nk, [x, y]);
          const h = heuristicToGoals(nx, ny, goals);
          open.push([ng + h, ng, nx, ny]);
        }
      }
    }
    return null;
  }

  /**
   * Path that may cross walls/towers (Monster Rush dig / chaos).
   * mode:
   *   "dig"   — high cost on obstacles so the path breaks the cheapest/nearest
   *             barrier when the open path is sealed.
   *   "chaos" — pure geometric shortest path; obstacles cost the same as open
   *             cells so monsters smash straight through toward the exit.
   */
  function findPathThroughObstacles(grid, sx, sy, goals, mode) {
    const goalSet = new Set(goals.map((g) => key(g.x, g.y)));
    if (goalSet.has(key(sx, sy))) return [{ x: sx, y: sy }];
    const chaos = mode === "chaos";

    const sk = key(sx, sy);
    const dist = new Map([[sk, 0]]);
    const prev = new Map([[sk, null]]);
    const open = [[0, sx, sy]];
    let found = null;

    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [d, x, y] = open.shift();
      if (d !== dist.get(key(x, y))) continue;
      if (goalSet.has(key(x, y))) {
        found = [x, y];
        break;
      }
      for (let i = 0; i < DIRS8.length; i++) {
        const dx = DIRS8[i][0];
        const dy = DIRS8[i][1];
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(grid, nx, ny)) continue;
        // Diagonals: both orthogonal neighbors must exist; for dig mode, do not
        // corner-cut through two solid obstacles (still allow dig into one).
        if (dx !== 0 && dy !== 0) {
          if (!inBounds(grid, x + dx, y) || !inBounds(grid, x, y + dy)) continue;
          if (!chaos) {
            const sideA = isObstacle(grid, x + dx, y);
            const sideB = isObstacle(grid, x, y + dy);
            if (sideA && sideB) continue;
          }
        }
        let cost = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
        if (!chaos) {
          // Prefer opening the nearest/cheapest breach when blocked.
          if (grid[ny][nx] === "blocked") cost += 12;
          if (hasPlacedTower(nx, ny)) cost += 14;
        }
        const nd = d + cost;
        const nk = key(nx, ny);
        if (!dist.has(nk) || nd < dist.get(nk) - 1e-9) {
          dist.set(nk, nd);
          prev.set(nk, [x, y]);
          open.push([nd, nx, ny]);
        }
      }
    }
    if (!found) return null;
    return rebuildPath(prev, found[0], found[1]);
  }

  function exitGoalsForSpawn(spawn, doc) {
    if (spawn.exit_mode === "specific" && spawn.exit_id) {
      const e = (doc.exits || []).find((x) => x.id === spawn.exit_id);
      if (e) return [{ x: e.x, y: e.y }];
    }
    return (doc.exits || []).map((e) => ({ x: e.x, y: e.y }));
  }

  function castleCells(grid) {
    const goals = [];
    if (!grid) return goals;
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y] || [];
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "castle") goals.push({ x: x, y: y });
      }
    }
    return goals;
  }

  function goalsForSpawn(spawn, doc, grid) {
    const gt = (doc.settings && doc.settings.game_type) || "monster_march";
    if (gt === "defend_the_castle") return castleCells(grid || doc.grid);
    return exitGoalsForSpawn(spawn, doc);
  }

  function isRushLike(gameType) {
    return gameType === "monster_rush" || gameType === "defend_the_castle";
  }

  /**
   * Monster Rush / Castle pathing:
   * - Open lane exists, normal mode → walk it (no attacking).
   * - Fully blocked, normal mode → dig path; attack first wall/tower on it.
   *   When a breach opens a free lane, callers repath and stop attacking.
   * - Chaos mode → always geometric shortest path; attack every wall/tower
   *   on that path even if a free detour exists.
   */
  function pathForMonster(spawn, doc, grid) {
    const goals = goalsForSpawn(spawn, doc, grid);
    if (!goals.length) return null;
    const gt = doc.settings.game_type || "monster_march";
    const chaos = !!doc.settings.chaos_mode;

    if (gt === "monster_march") {
      const path = findPath(grid, spawn.x, spawn.y, goals, (x, y) =>
        isOpenWalkable(grid, x, y, "monster_march")
      );
      return path ? { cells: path, attacking: false } : null;
    }

    const open = findPath(
      grid,
      spawn.x,
      spawn.y,
      goals,
      (x, y) => isOpenWalkable(grid, x, y, "monster_rush"),
      { diagonals: true }
    );

    if (chaos) {
      const dig = findPathThroughObstacles(
        grid,
        spawn.x,
        spawn.y,
        goals,
        "chaos"
      );
      if (dig) {
        return {
          cells: dig,
          attacking: pathHasObstacle(dig, grid),
        };
      }
      return open ? { cells: open, attacking: false } : null;
    }

    // Normal rush: free path wins.
    if (open) return { cells: open, attacking: false };

    // Blocked: dig the cheapest route through walls/towers and attack them.
    const dig = findPathThroughObstacles(grid, spawn.x, spawn.y, goals, "dig");
    if (dig) {
      return {
        cells: dig,
        attacking: pathHasObstacle(dig, grid),
      };
    }
    return null;
  }

  function start() {
    const doc = getDoc();
    if (!doc) return;

    // Always allow playtest (including designs with playability problems) so
    // builders can experiment; the Play button turns yellow + tooltip when issues exist.
    if (window.OpenTDDesignValidate) {
      const report = window.OpenTDDesignValidate.analyzeDesign(doc);
      if (report.issues && report.issues.length) {
        state._pendingWarning = report.issues
          .map((i) => i.message)
          .slice(0, 2)
          .join(" ");
      } else {
        state._pendingWarning = null;
      }
    }

    state.doc = doc;
    state.active = true;
    state.paused = false;
    state.status = "running";
    state.lives = doc.settings.starting_lives | 0 || 20;
    state.gold = doc.settings.starting_gold | 0 || 1000;
    state.score = 0;
    state.wave = 0;
    state.waveAppearances = {};
    state.maxRound = computeMaxRound(doc);
    state.monsters = [];
    state.towers = [];
    state.shots = [];
    state.simGrid = cloneGrid(doc.grid);
    state.wallHp = new Map();
    state.playerWalls = new Map(); // "x,y" → gold paid (for refund on remove)
    state.spawnQueue = [];
    state.spawnTimer = 0;
    state.lastTs = 0;
    state.placeTarget = null;
    state.phase = "start_countdown";
    state.countdown = Math.max(0, doc.settings.start_delay_seconds | 0);
    if (state.countdown === 0) {
      state.phase = "wave_active";
    }
    hidePlaceMenu();
    hideEndModal();

    els.stage?.classList.add("is-playtesting");
    if (els.overlay) els.overlay.setAttribute("aria-hidden", "false");
    onModeChange(true);
    setControlsRunning(true);
    updateHud();
    if (state.phase === "wave_active") {
      queueWave();
      setMsg(playStartMessage(), "ok");
    } else {
      setMsg(
        "Get ready — first wave in " + state.countdown + "s… " +
          "(last round " +
          state.maxRound +
          ") " +
          (state._pendingWarning ? "Note: " + state._pendingWarning : ""),
        "ok"
      );
      state._pendingWarning = null;
    }
    if (state.phase === "wave_active" && state._pendingWarning) {
      setMsg("Playtest running — note: " + state._pendingWarning, "ok");
      state._pendingWarning = null;
    }
    if (!state.raf) {
      state.lastTs = performance.now();
      state.raf = requestAnimationFrame(tick);
    }
  }

  function playStartMessage() {
    return (
      "Playtest running — place towers/walls; click a tower to upgrade or sell; click a wall to remove."
    );
  }

  function pause() {
    if (!state.active) return;
    state.paused = true;
    setControlsRunning(true);
    setMsg("Paused.");
  }

  function resume() {
    if (!state.active) return;
    state.paused = false;
    state.lastTs = performance.now();
    setControlsRunning(true);
    setMsg("Resumed.", "ok");
    if (!state.raf) state.raf = requestAnimationFrame(tick);
  }

  function stop() {
    state.active = false;
    state.paused = false;
    state.status = "idle";
    state.monsters = [];
    state.towers = [];
    state.shots = [];
    state.spawnQueue = [];
    hidePlaceMenu();
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    els.stage?.classList.remove("is-playtesting");
    if (els.overlay) {
      els.overlay.innerHTML = "";
      els.overlay.setAttribute("aria-hidden", "true");
    }
    onModeChange(false);
    setControlsRunning(false);
    if (els.lives) els.lives.textContent = "—";
    if (els.gold) els.gold.textContent = "—";
    if (els.waveNum) els.waveNum.textContent = "0";
    if (els.mobs) els.mobs.textContent = "0";
    state.phase = "idle";
    state.countdown = 0;
    setMsg("Stopped — back to edit mode.");
  }

  var ABS_MAX_ROUNDS = 100;

  function tierMaxRounds(doc) {
    const fromDoc = doc && doc.settings && Number(doc.settings.max_rounds);
    if (Number.isFinite(fromDoc) && fromDoc >= 1) {
      return Math.min(ABS_MAX_ROUNDS, fromDoc | 0);
    }
    return ABS_MAX_ROUNDS;
  }

  function parseRoundSpec(spec, maxRound) {
    const cap = Math.max(
      1,
      Math.min(ABS_MAX_ROUNDS, maxRound | 0 || ABS_MAX_ROUNDS)
    );
    const rounds = new Set();
    if (!spec || typeof spec !== "string") return rounds;
    String(spec)
      .split(",")
      .forEach((part) => {
        const p = part.trim();
        if (!p) return;
        if (p.includes("-")) {
          const bits = p.split("-");
          const left = (bits[0] || "").trim();
          const right = (bits[1] != null ? bits[1] : "").trim();
          const a = parseInt(left || "1", 10);
          if (!Number.isFinite(a)) return;
          let b;
          if (right === "") {
            // Open-ended: from a through tier max (if a is in range).
            if (a > cap) return;
            b = cap;
          } else {
            b = parseInt(right, 10);
            if (!Number.isFinite(b)) return;
          }
          const lo = Math.max(1, Math.min(a, b));
          const hi = Math.min(cap, Math.max(a, b));
          if (lo > hi) return;
          for (let n = lo; n <= hi; n++) rounds.add(n);
        } else {
          const n = parseInt(p, 10);
          if (Number.isFinite(n) && n >= 1 && n <= cap) rounds.add(n);
        }
      });
    return rounds;
  }

  function computeMaxRound(doc) {
    const cap = tierMaxRounds(doc);
    let hi = 0;
    (doc.wave_types || []).forEach((wt) => {
      parseRoundSpec(wt.rounds || "", cap).forEach((n) => {
        if (n > hi) hi = n;
      });
    });
    return hi >= 1 ? Math.min(cap, hi) : Math.min(cap, 1);
  }

  function findWaveTypeForRound(doc, round) {
    const types = doc.wave_types || [];
    const cap = tierMaxRounds(doc);
    for (let i = 0; i < types.length; i++) {
      const rounds = parseRoundSpec(types[i].rounds || "", cap);
      if (rounds.has(round)) return types[i];
    }
    return null;
  }

  function scaleStat(base, scalingRule, n) {
    const mode = scalingRule.mode || "base_times_n";
    const factor = Number(scalingRule.factor);
    const f = Number.isFinite(factor) ? factor : 1;
    const nn = Math.max(1, n | 0);
    if (mode === "base_plus_n_times_factor") {
      return base + (nn - 1) * f;
    }
    if (mode === "base_times_one_plus_n_minus_one_times_factor") {
      return base * (1 + (nn - 1) * f);
    }
    // base_times_n
    return base * nn;
  }

  function applyWaveScaling(baseMonster, waveType, appearance, round) {
    const out = Object.assign({}, baseMonster);
    const rules = (waveType && waveType.scaling) || [];
    rules.forEach((rule) => {
      const n = rule.basis === "round" ? round : appearance;
      if (rule.stat === "hp") {
        out.hp = Math.max(1, Math.round(scaleStat(baseMonster.hp || 1, rule, n)));
      } else if (rule.stat === "speed") {
        out.speed = Math.max(
          0.05,
          scaleStat(baseMonster.speed || 1, rule, n)
        );
      } else if (rule.stat === "reward") {
        out.reward = Math.max(
          0,
          Math.round(scaleStat(baseMonster.reward || 0, rule, n))
        );
      }
    });
    return out;
  }

  function queueWave() {
    const doc = state.doc;
    if (!doc) return;
    if (!state.maxRound) state.maxRound = computeMaxRound(doc);
    if (state.wave >= state.maxRound) {
      endGame(true);
      return;
    }
    state.phase = "wave_active";
    state.countdown = 0;
    state.wave += 1;
    const round = state.wave;

    if (!state.waveAppearances) state.waveAppearances = {};

    let waveType = findWaveTypeForRound(doc, round);
    // No schedule match past the designed end — treat as victory path.
    if (!waveType) {
      if (state.wave >= state.maxRound) {
        endGame(true);
        return;
      }
      waveType = (doc.wave_types && doc.wave_types[0]) || null;
    }

    let appearance = 1;
    if (waveType && waveType.id) {
      state.waveAppearances[waveType.id] =
        (state.waveAppearances[waveType.id] || 0) + 1;
      appearance = state.waveAppearances[waveType.id];
    }

    state.spawnQueue = [];
    let delay = 0;
    const groupSummary = [];

    if (waveType && Array.isArray(waveType.groups) && waveType.groups.length) {
      waveType.groups.forEach((g) => {
        const baseMob =
          (doc.monsters || []).find((m) => m.id === g.monster_id) ||
          doc.monsters[0] || {
            name: "Mob",
            hp: 20,
            speed: 1,
            reward: 10,
          };
        const scaled = applyWaveScaling(baseMob, waveType, appearance, round);
        const count = Math.max(1, g.count | 0 || 1);
        groupSummary.push(count + "× " + (scaled.name || "Mob"));
        doc.spawns.forEach((spawn) => {
          for (let i = 0; i < count; i++) {
            state.spawnQueue.push({
              spawn,
              def: scaled,
              delay: delay,
            });
            delay += 0.35;
          }
        });
      });
    } else {
      // Legacy fallback
      const mobDef =
        doc.monsters[(round - 1) % Math.max(1, doc.monsters.length)];
      const count = Math.min(3 + round, 12);
      groupSummary.push(count + "× " + ((mobDef && mobDef.name) || "Mob"));
      doc.spawns.forEach((spawn) => {
        for (let i = 0; i < count; i++) {
          state.spawnQueue.push({
            spawn,
            def: mobDef || { name: "Mob", hp: 20, speed: 1, reward: 10 },
            delay: i * 0.45,
          });
        }
      });
    }

    state.spawnTimer = 0;
    updateHud();
    const typeName = (waveType && waveType.name) || "Wave";
    setMsg(
      "Round " +
        round +
        " — " +
        typeName +
        " (appearance " +
        appearance +
        "): " +
        groupSummary.join(", ") +
        " per spawn"
    );
  }

  function clearProjectiles() {
    state.shots = [];
    // Drop in-flight machine-gun bursts so they don't fire into empty space.
    state.towers.forEach((t) => {
      t.burstQueue = [];
      t.burstTimer = 0;
    });
  }

  function fadeShots(dt) {
    for (let i = state.shots.length - 1; i >= 0; i--) {
      state.shots[i].life -= dt;
      if (state.shots[i].life <= 0) state.shots.splice(i, 1);
    }
  }

  function beginBetweenWaves() {
    // Wave is over — remove lingering projectile visuals immediately.
    clearProjectiles();
    if (state.wave >= (state.maxRound || 0) && state.lives > 0) {
      endGame(true);
      return;
    }
    if (state.wave >= (state.maxRound || 0)) {
      endGame(false);
      return;
    }
    const delay = Math.max(
      0,
      (state.doc && state.doc.settings.between_waves_delay_seconds) | 0
    );
    if (delay <= 0) {
      queueWave();
      return;
    }
    state.phase = "between_waves";
    state.countdown = delay;
    state.spawnQueue = [];
    state.spawnTimer = 0;
    setMsg(
      "Wave cleared — next wave in " +
        delay +
        "s… (" +
        state.wave +
        "/" +
        state.maxRound +
        ")",
      "ok"
    );
    updateHud();
  }

  function hideEndModal() {
    const modal = document.getElementById("pt-end-modal");
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function showEndModal(won) {
    let modal = document.getElementById("pt-end-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "pt-end-modal";
      modal.className = "pt-end-modal";
      modal.innerHTML =
        '<div class="pt-end-modal__card" role="dialog" aria-modal="true" aria-labelledby="pt-end-title">' +
        '<p id="pt-end-title" class="pt-end-modal__title"></p>' +
        '<p class="pt-end-modal__sub" id="pt-end-sub"></p>' +
        '<button type="button" class="btn btn-primary" id="pt-end-replay">Replay</button>' +
        "</div>";
      document.body.appendChild(modal);
      modal.querySelector("#pt-end-replay").addEventListener("click", () => {
        hideEndModal();
        start();
      });
    }
    const title = modal.querySelector("#pt-end-title");
    const sub = modal.querySelector("#pt-end-sub");
    if (won) {
      title.textContent = "Congrats, You win!";
      sub.textContent =
        "You cleared all " +
        (state.maxRound || state.wave) +
        " rounds with " +
        state.lives +
        " life" +
        (state.lives === 1 ? "" : "s") +
        " left.";
      modal.classList.remove("is-loss");
      modal.classList.add("is-win");
    } else {
      title.textContent = "You lost.";
      sub.textContent =
        "Lives depleted on round " +
        (state.wave || 1) +
        " of " +
        (state.maxRound || "?") +
        ".";
      modal.classList.remove("is-win");
      modal.classList.add("is-loss");
    }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function endGame(won) {
    if (state.status === "won" || state.status === "lost") return;
    state.status = won ? "won" : "lost";
    state.paused = true;
    state.phase = "ended";
    state.spawnQueue = [];
    clearProjectiles();
    setControlsRunning(true);
    if (els.play) {
      els.play.disabled = false;
      const label = els.play.querySelector("span:last-child");
      // keep button usable for resume is wrong — replay via modal
    }
    if (els.pause) els.pause.disabled = true;
    if (els.waveBtn) els.waveBtn.disabled = true;
    setMsg(
      won ? "Victory — all rounds cleared!" : "Defeat — no lives left.",
      won ? "ok" : "error"
    );
    showEndModal(won);
    updateHud();
  }

  function resolvePath(spawn) {
    const raw = pathForMonster(spawn, state.doc, state.simGrid);
    if (!raw) return null;
    if (Array.isArray(raw)) return { cells: raw, attacking: false };
    return raw;
  }

  function spawnOne(entry) {
    const pathInfo = resolvePath(entry.spawn);
    if (!pathInfo || !pathInfo.cells || pathInfo.cells.length < 1) {
      setMsg("No path from spawn “" + entry.spawn.id + "” to an exit.", "error");
      return;
    }
    const cells = pathInfo.cells;
    state.monsters.push({
      id: Math.random().toString(36).slice(2, 9),
      def: entry.def,
      hp: entry.def.hp || 20,
      maxHp: entry.def.hp || 20,
      speed: Math.max(0.2, entry.def.speed || 1),
      reward: entry.def.reward || 0,
      spawnId: entry.spawn.id,
      cells,
      idx: 0,
      progress: 0,
      attacking: !!pathInfo.attacking,
      attackTimer: 0,
      x: cells[0].x + 0.5,
      y: cells[0].y + 0.5,
    });
  }

  function repathMonster(m) {
    const spawn = (state.doc.spawns || []).find((s) => s.id === m.spawnId);
    if (!spawn) return;
    const prevTarget =
      m.cells && m.idx < m.cells.length - 1
        ? m.cells[m.idx + 1]
        : null;
    // repath from current cell
    const cx = Math.floor(m.x);
    const cy = Math.floor(m.y);
    const fakeSpawn = { ...spawn, x: cx, y: cy };
    const pathInfo = resolvePath(fakeSpawn);
    if (!pathInfo || !pathInfo.cells || !pathInfo.cells.length) return;
    m.cells = pathInfo.cells;
    m.idx = 0;
    m.progress = 0;
    m.attacking = !!pathInfo.attacking;
    // Keep swing timer if still chewing the same wall/tower.
    const newTarget =
      m.cells && m.cells.length > 1 ? m.cells[1] : null;
    const sameTarget =
      prevTarget &&
      newTarget &&
      prevTarget.x === newTarget.x &&
      prevTarget.y === newTarget.y;
    if (!sameTarget) m.attackTimer = 0;
  }

  function towerMaxHpFromDef(def) {
    const hp = def && def.hp != null ? Number(def.hp) : 50;
    return Math.max(1, Number.isFinite(hp) ? hp | 0 : 50);
  }

  function ensureTowerHp(tower) {
    if (!tower) return;
    const maxFromDef = towerMaxHpFromDef(tower.def);
    if (tower.maxHp == null || !(tower.maxHp >= 1)) {
      tower.maxHp = maxFromDef;
    }
    if (tower.hp == null || !Number.isFinite(Number(tower.hp))) {
      tower.hp = tower.maxHp;
    }
  }

  function damageObstacle(x, y, amount) {
    const dmg = Math.max(0, Number(amount) || 0);
    if (dmg <= 0) return false;

    // Placed towers use their own hit points from the tower type definition.
    const tower = state.towers.find(
      (t) => (t.x | 0) === (x | 0) && (t.y | 0) === (y | 0)
    );
    if (tower) {
      ensureTowerHp(tower);
      tower.hp -= dmg;
      if (tower.hp <= 0) {
        state.towers = state.towers.filter((t) => t !== tower);
        if (state.wallHp) state.wallHp.delete(key(x, y));
        restoreTerrain(x, y);
        setMsg(
          ((tower.def && tower.def.name) || "Tower") + " destroyed!",
          "error"
        );
        return true;
      }
      return false;
    }

    // Walls (and empty tower pads without a placement) use wall hit points.
    const k = key(x, y);
    if (!state.wallHp.has(k)) {
      state.wallHp.set(k, 5);
    }
    const left = state.wallHp.get(k) - dmg;
    state.wallHp.set(k, left);
    if (left <= 0) {
      if (state.playerWalls) state.playerWalls.delete(k);
      state.wallHp.delete(k);
      restoreTerrain(x, y);
      return true;
    }
    return false;
  }

  function tick(ts) {
    state.raf = 0;
    if (!state.active) return;
    const dt = Math.min(0.05, (ts - state.lastTs) / 1000) * state.speed;
    state.lastTs = ts;

    if (!state.paused && state.status === "running") {
      step(dt);
    }
    renderOverlay();
    updateHud();

    if (state.active) {
      state.raf = requestAnimationFrame(tick);
    }
  }

  function step(dt) {
    // Start / between-wave countdowns
    if (state.phase === "start_countdown" || state.phase === "between_waves") {
      state.countdown -= dt;
      if (state.countdown <= 0) {
        state.countdown = 0;
        if (state.phase === "start_countdown") {
          setMsg(playStartMessage(), "ok");
        }
        queueWave();
      }
      // No combat during countdown; still expire any residual shot sprites.
      fadeShots(dt);
      return;
    }

    // spawn queue within an active wave
    if (state.spawnQueue.length) {
      state.spawnTimer += dt;
      while (state.spawnQueue.length && state.spawnQueue[0].delay <= state.spawnTimer) {
        const entry = state.spawnQueue.shift();
        spawnOne(entry);
      }
    } else if (
      state.monsters.length === 0 &&
      state.status === "running" &&
      state.wave > 0 &&
      state.phase === "wave_active"
    ) {
      beginBetweenWaves();
    }

    // monsters
    const gtNow =
      (state.doc.settings && state.doc.settings.game_type) || "monster_march";
    const goals =
      gtNow === "defend_the_castle"
        ? castleCells(state.simGrid).map((g) => key(g.x, g.y))
        : (state.doc.exits || []).map((e) => key(e.x, e.y));
    for (let i = state.monsters.length - 1; i >= 0; i--) {
      const m = state.monsters[i];
      if (m.hp <= 0) {
        const pts = m.reward || 0;
        state.gold += pts;
        state.score = (state.score || 0) + pts;
        state.monsters.splice(i, 1);
        continue;
      }

      // Status effects: fire/poison ticks, freeze slow
      let speedMul = 1;
      if (Array.isArray(m.effects)) {
        for (let ei = m.effects.length - 1; ei >= 0; ei--) {
          const fx = m.effects[ei];
          fx.remaining -= dt;
          if (fx.remaining <= 0) {
            m.effects.splice(ei, 1);
            continue;
          }
          if (fx.type === "freeze") {
            speedMul = Math.min(speedMul, fx.slow_factor != null ? fx.slow_factor : 0.5);
          }
          if (fx.tick_damage > 0 && fx.tick_rate > 0) {
            fx.tickAcc = (fx.tickAcc || 0) + dt;
            while (fx.tickAcc >= fx.tick_rate) {
              fx.tickAcc -= fx.tick_rate;
              m.hp -= fx.tick_damage;
            }
          }
        }
      }
      if (m.hp <= 0) {
        const pts = m.reward || 0;
        state.gold += pts;
        state.score = (state.score || 0) + pts;
        state.monsters.splice(i, 1);
        continue;
      }
      m._speedMul = speedMul;

      // reached exit?
      const cx = Math.floor(m.x);
      const cy = Math.floor(m.y);
      const gt = (state.doc.settings && state.doc.settings.game_type) || "monster_march";
      const chaos = !!(state.doc.settings && state.doc.settings.chaos_mode);
      const rush = isRushLike(gt);

      if (goals.includes(key(cx, cy)) && m.idx >= m.cells.length - 1) {
        state.lives -= 1;
        state.monsters.splice(i, 1);
        if (state.lives <= 0) {
          state.lives = 0;
          endGame(false);
        }
        continue;
      }

      if (!m.cells || !m.cells.length || m.idx >= m.cells.length - 1) {
        repathMonster(m);
        if (!m.cells || !m.cells.length || m.idx >= m.cells.length - 1) continue;
      }

      let next = m.cells[Math.min(m.idx + 1, m.cells.length - 1)];

      // Rush: wall/tower on the route → attack it (nearest on dig path).
      // Normal mode repaths first so a free lane after a breach is preferred.
      // Chaos mode keeps attacking along the geometric shortest path.
      if (
        rush &&
        next &&
        m.idx < m.cells.length - 1 &&
        isObstacle(state.simGrid, next.x, next.y)
      ) {
        if (!chaos) {
          repathMonster(m);
          next = m.cells[Math.min(m.idx + 1, m.cells.length - 1)];
        }
        if (
          next &&
          m.idx < m.cells.length - 1 &&
          isObstacle(state.simGrid, next.x, next.y)
        ) {
          m.attacking = true;
          m.attackTimer = (m.attackTimer || 0) + dt;
          if (m.attackTimer >= 0.35) {
            m.attackTimer = 0;
            damageObstacle(next.x, next.y, 1);
            // Destroying a barrier may open a free path (normal) or shift dig path.
            repathMonster(m);
          }
          continue; // stay put while attacking
        }
        // Non-chaos: repath found a free lane — fall through and walk.
      }

      // Stale dig flag: clear if we're not facing an obstacle.
      if (
        m.attacking &&
        (!next || !isObstacle(state.simGrid, next.x, next.y))
      ) {
        m.attacking = false;
      }

      // move toward next cell center
      const tx = next.x + 0.5;
      const ty = next.y + 0.5;
      const dx = tx - m.x;
      const dy = ty - m.y;
      const dist = Math.hypot(dx, dy) || 1;
      const stepLen = m.speed * (m._speedMul != null ? m._speedMul : 1) * dt;
      if (stepLen >= dist) {
        m.x = tx;
        m.y = ty;
        m.idx = Math.min(m.idx + 1, m.cells.length - 1);
        // Rush: repath every cell so new walls / opened lanes are noticed.
        if (rush) {
          repathMonster(m);
        }
      } else {
        m.x += (dx / dist) * stepLen;
        m.y += (dy / dist) * stepLen;
      }
    }

    // towers fire
    state.towers.forEach((t) => {
      t.cooldown = Math.max(0, t.cooldown - dt);
      // Process burst queue (machine gun)
      if (Array.isArray(t.burstQueue) && t.burstQueue.length) {
        t.burstTimer = (t.burstTimer || 0) - dt;
        if (t.burstTimer <= 0) {
          const shot = t.burstQueue.shift();
          fireProjectile(t, shot.target, shot.angleOffset || 0);
          t.burstTimer =
            (t.def.weapon && t.def.weapon.burst_interval) || 0.08;
        }
      }
      if (t.cooldown > 0) return;
      const range = t.def.range || 3;
      let best = null;
      let bestD = Infinity;
      state.monsters.forEach((m) => {
        const d = Math.hypot(m.x - (t.x + 0.5), m.y - (t.y + 0.5));
        if (d <= range && d < bestD) {
          best = m;
          bestD = d;
        }
      });
      if (best) {
        const weapon = t.def.weapon || { type: "single", projectile_count: 1 };
        const wtype = weapon.type || "single";
        const count = Math.max(1, weapon.projectile_count | 0 || 1);
        if (wtype === "machine_gun" && count > 1) {
          t.burstQueue = [];
          for (let i = 0; i < count; i++) {
            t.burstQueue.push({ target: best, angleOffset: 0 });
          }
          t.burstTimer = 0;
        } else if (wtype === "shotgun" && count > 1) {
          const spread = (weapon.spread_degrees || 30) * (Math.PI / 180);
          for (let i = 0; i < count; i++) {
            const tnorm = count === 1 ? 0.5 : i / (count - 1);
            const offset = (tnorm - 0.5) * spread;
            fireProjectile(t, best, offset);
          }
        } else {
          fireProjectile(t, best, 0);
        }
        // Cooldown = seconds between full attack cycles (all weapon types)
        let cd = t.def.cooldown;
        if (cd == null && t.def.fire_rate > 0) cd = 1 / t.def.fire_rate;
        t.cooldown = Math.max(0.05, cd != null ? Number(cd) : 1);
      }
    });

    fadeShots(dt);
  }

  function fireProjectile(tower, primaryTarget, angleOffset) {
    if (!primaryTarget || primaryTarget.hp <= 0) return;
    const tx = tower.x + 0.5;
    const ty = tower.y + 0.5;
    // Shotgun: pick aim point rotated around tower toward target
    let aimX = primaryTarget.x;
    let aimY = primaryTarget.y;
    if (angleOffset) {
      const dx = primaryTarget.x - tx;
      const dy = primaryTarget.y - ty;
      const ang = Math.atan2(dy, dx) + angleOffset;
      const dist = Math.hypot(dx, dy) || 1;
      aimX = tx + Math.cos(ang) * dist;
      aimY = ty + Math.sin(ang) * dist;
    }

    const element = tower.def.element || { type: "none" };
    const aoe = (element.aoe_radius || 0) > 0 ? element.aoe_radius : 0;
    const dmg = tower.def.damage || 0;

    // Hit primary (or nearest to aim for shotgun pellet)
    let hit = primaryTarget;
    if (angleOffset) {
      let best = null;
      let bestD = Infinity;
      state.monsters.forEach((m) => {
        const d = Math.hypot(m.x - aimX, m.y - aimY);
        if (d < bestD && d < 1.25) {
          best = m;
          bestD = d;
        }
      });
      if (best) hit = best;
      else return; // pellet misses
    }

    applyHit(hit, dmg, element);

    if (aoe > 0) {
      state.monsters.forEach((m) => {
        if (m === hit) return;
        const d = Math.hypot(m.x - hit.x, m.y - hit.y);
        if (d <= aoe) applyHit(m, dmg * 0.6, element);
      });
    }

    state.shots.push({
      x0: tx,
      y0: ty,
      x1: hit.x,
      y1: hit.y,
      life: 0.12,
    });
  }

  function applyHit(monster, damage, element) {
    if (!monster || monster.hp <= 0) return;
    monster.hp -= damage || 0;
    const etype = (element && element.type) || "none";
    if (etype === "none") return;
    if (!Array.isArray(monster.effects)) monster.effects = [];
    // Refresh or add effect
    const existing = monster.effects.find((e) => e.type === etype);
    const fx = {
      type: etype,
      remaining: element.duration || 2,
      tick_rate: element.tick_rate || 0.5,
      tick_damage: element.tick_damage || 0,
      slow_factor: element.slow_factor != null ? element.slow_factor : 0.5,
      tickAcc: 0,
    };
    if (existing) {
      existing.remaining = Math.max(existing.remaining, fx.remaining);
      existing.tick_damage = fx.tick_damage;
      existing.tick_rate = fx.tick_rate;
      existing.slow_factor = fx.slow_factor;
    } else {
      monster.effects.push(fx);
    }
  }

  function renderOverlay() {
    if (!els.overlay || !els.grid) return;
    const m = gridMetrics();
    // Overlay is inset:0 on map-frame (same box as the grid); clear any stale size.
    els.overlay.style.width = "";
    els.overlay.style.height = "";

    // Entity sizes are fractions of a single cell (not % of the whole map).
    const mobSize = Math.max(8, Math.min(18, Math.round(m.cs * 0.42)));
    // Towers fill the whole cell so they read as solid blockers.
    const towerW = Math.max(1, m.cs);
    const towerH = Math.max(1, m.cs);
    const shotSize = Math.max(3, Math.round(m.cs * 0.12));

    const parts = [];
    state.towers.forEach((t) => {
      ensureTowerHp(t);
      const origin = cellOriginPx(t.x, t.y, m);
      const maxHp = Math.max(1, t.maxHp | 0);
      const hp = Math.max(0, t.hp | 0);
      const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
      const damaged = hp < maxHp;
      const name = (t.def && t.def.name) || "Tower";
      parts.push(
        `<div class="playtest-tower${damaged ? " is-damaged" : ""}" style="left:${origin.left}px;top:${origin.top}px;width:${towerW}px;height:${towerH}px" title="${escapeHtml(
          name + " (" + hp + "/" + maxHp + " hp)"
        )}">` +
          (damaged
            ? `<span class="playtest-tower__hp"><i style="width:${pct}%"></i></span>`
            : "") +
          `</div>`
      );
    });
    state.monsters.forEach((mob) => {
      const left = cellCoordToPx(mob.x, m.borderLeft, m.pitch, m.gap);
      const top = cellCoordToPx(mob.y, m.borderTop, m.pitch, m.gap);
      const pct = Math.max(0, Math.min(100, (mob.hp / mob.maxHp) * 100));
      parts.push(
        `<div class="playtest-mob" style="left:${left}px;top:${top}px;width:${mobSize}px;height:${mobSize}px" title="${escapeHtml(
          mob.def.name || "Mob"
        )}">
          <span class="playtest-mob__hp"><i style="width:${pct}%"></i></span>
        </div>`
      );
    });
    state.shots.forEach((s) => {
      const left = cellCoordToPx(
        (s.x0 + s.x1) / 2,
        m.borderLeft,
        m.pitch,
        m.gap
      );
      const top = cellCoordToPx(
        (s.y0 + s.y1) / 2,
        m.borderTop,
        m.pitch,
        m.gap
      );
      parts.push(
        `<div class="playtest-shot" style="left:${left}px;top:${top}px;width:${shotSize}px;height:${shotSize}px"></div>`
      );
    });
    els.overlay.innerHTML = parts.join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const WALL_COST = 15;
  /** Full refund in playtest so creators can experiment freely. */
  const SELL_REFUND_RATE = 1;

  function hidePlaceMenu() {
    state.placeTarget = null;
    if (els.placeMenu) {
      els.placeMenu.hidden = true;
      els.placeMenu.innerHTML = "";
    }
  }

  function setCellKindVisual(x, y, kind) {
    const cell = els.grid?.querySelector(`[data-x="${x}"][data-y="${y}"]`);
    if (cell) {
      cell.dataset.kind = kind;
      if (kind !== "spawn" && kind !== "exit") {
        cell.textContent = "";
      }
    }
  }

  /**
   * Restore terrain after selling a tower / removing a wall.
   * Uses the original map cell; map-painted walls open to ground.
   */
  function restoreTerrain(x, y) {
    const row = state.doc && state.doc.grid && state.doc.grid[y];
    let kind = row ? row[x] : "ground";
    if (!kind || kind === "blocked") kind = "ground";
    state.simGrid[y][x] = kind;
    setCellKindVisual(x, y, kind);
    if (state.wallHp) state.wallHp.delete(key(x, y));
  }

  function towerSpent(tower) {
    if (tower.spent != null && Number.isFinite(Number(tower.spent))) {
      return Math.max(0, tower.spent | 0);
    }
    return Math.max(0, (tower.def && tower.def.cost) | 0);
  }

  function sellRefund(spent) {
    return Math.floor(Math.max(0, spent) * SELL_REFUND_RATE);
  }

  function repathAllMonsters() {
    state.monsters.forEach((m) => repathMonster(m));
  }

  function placementOptionsForCell(x, y) {
    const kind = state.simGrid[y][x];
    const allowGround = !!state.doc.settings.allow_ground_build;
    const occupied = state.towers.some((t) => t.x === x && t.y === y);
    const options = [];

    if (occupied || kind === "spawn" || kind === "exit" || kind === "blocked") {
      return options;
    }

    const towersOk =
      kind === "tower" ||
      (allowGround && (kind === "ground" || kind === "path"));
    if (towersOk) {
      // Only base towers (not upgrades of another tower) can be placed on the map
      (state.doc.towers || [])
        .filter((tdef) => !String(tdef.upgrade_of || "").trim())
        .forEach((tdef) => {
          options.push({
            type: "tower",
            id: tdef.id,
            name: tdef.name || "Tower",
            cost: tdef.cost | 0 || 0,
            def: tdef,
            meta:
              (tdef.cost | 0 || 0) +
              "g · " +
              towerMaxHpFromDef(tdef) +
              " hp · " +
              (tdef.damage | 0 || 0) +
              " dmg",
          });
        });
    }

    // Walls on bare ground (and path when ground-build is on) for maze playtests.
    const wallOk =
      kind === "ground" || (allowGround && kind === "path");
    if (wallOk) {
      options.push({
        type: "wall",
        id: "wall",
        name: "Wall",
        cost: WALL_COST,
        def: null,
        meta: WALL_COST + "g · blocks path",
      });
    }

    return options;
  }

  function openPlaceMenu(clientX, clientY, cellX, cellY, options, titleText) {
    if (!els.placeMenu) return;
    state.placeTarget = { x: cellX, y: cellY };
    // Park on body so overflow:hidden ancestors cannot clip the menu.
    if (els.placeMenu.parentElement !== document.body) {
      document.body.appendChild(els.placeMenu);
    }
    const title =
      titleText ||
      "Place at (" + cellX + ", " + cellY + ") — gold " + state.gold;
    let html =
      '<div class="playtest-place-menu__title">' +
      escapeHtml(title) +
      "</div>";
    (options || []).forEach((opt, i) => {
      const isFreeAction =
        opt.type === "sell" ||
        opt.type === "remove_wall" ||
        (opt.cost | 0) <= 0;
      const canAfford = isFreeAction || state.gold >= (opt.cost | 0);
      html +=
        '<button type="button" role="menuitem" class="playtest-place-menu__item' +
        (opt.danger ? " playtest-place-menu__item--danger" : "") +
        (canAfford ? "" : " is-unaffordable") +
        '" data-opt-index="' +
        i +
        '"' +
        (canAfford ? "" : " disabled") +
        ">" +
        '<span class="playtest-place-menu__name">' +
        escapeHtml(opt.name) +
        "</span>" +
        '<span class="playtest-place-menu__meta">' +
        escapeHtml(opt.meta || "") +
        "</span>" +
        "</button>";
    });
    if (!(options && options.length)) {
      html +=
        '<p class="playtest-place-menu__meta" style="padding:0.35rem 0.5rem;margin:0">No options available.</p>';
    }
    html +=
      '<button type="button" class="playtest-place-menu__cancel" data-cancel="1">Cancel</button>';
    els.placeMenu.innerHTML = html;
    els.placeMenu.hidden = false;

    // Position near cursor, keep on-screen.
    const pad = 8;
    const mw = els.placeMenu.offsetWidth || 180;
    const mh = els.placeMenu.offsetHeight || 120;
    let left = clientX + 10;
    let top = clientY + 10;
    if (left + mw > window.innerWidth - pad) left = clientX - mw - 10;
    if (top + mh > window.innerHeight - pad) top = clientY - mh - 10;
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    els.placeMenu.style.left = left + "px";
    els.placeMenu.style.top = top + "px";

    els.placeMenu._options = options || [];
    // Ignore the opening click for outside-dismiss (same event tick / bubble quirks).
    els.placeMenu._ignoreOutsideUntil = performance.now() + 50;
  }

  function applyPlacement(opt) {
    if (!state.placeTarget || !opt) return;
    const { x, y } = state.placeTarget;
    if (!inBounds(state.simGrid, x, y)) return;

    if (opt.type === "sell") {
      const tower = state.towers.find(
        (t) => (t.x | 0) === (x | 0) && (t.y | 0) === (y | 0)
      );
      if (!tower) return;
      const refund = sellRefund(towerSpent(tower));
      state.towers = state.towers.filter((t) => t !== tower);
      restoreTerrain(x, y);
      state.gold += refund;
      setMsg(
        "Sold " +
          ((tower.def && tower.def.name) || "tower") +
          (refund > 0 ? " (+" + refund + "g)." : "."),
        "ok"
      );
      repathAllMonsters();
      hidePlaceMenu();
      updateHud();
      return;
    }

    if (opt.type === "remove_wall") {
      if (state.simGrid[y][x] !== "blocked") {
        setMsg("No wall here.", "error");
        hidePlaceMenu();
        return;
      }
      const k = key(x, y);
      const paid =
        state.playerWalls && state.playerWalls.has(k)
          ? state.playerWalls.get(k) | 0
          : 0;
      if (state.playerWalls) state.playerWalls.delete(k);
      const refund = sellRefund(paid);
      restoreTerrain(x, y);
      state.gold += refund;
      setMsg(
        "Removed wall" + (refund > 0 ? " (+" + refund + "g)." : "."),
        "ok"
      );
      repathAllMonsters();
      hidePlaceMenu();
      updateHud();
      return;
    }

    if (state.gold < (opt.cost | 0)) {
      setMsg("Not enough gold.", "error");
      return;
    }

    if (opt.type === "upgrade") {
      const tower = state.towers.find(
        (t) => (t.x | 0) === (x | 0) && (t.y | 0) === (y | 0)
      );
      if (!tower || !opt.def) return;
      state.gold -= opt.cost;
      // Keep rootId so further upgrades still resolve against the base type.
      if (!tower.rootId) tower.rootId = rootBaseId(tower);
      tower.spent = towerSpent(tower) + (opt.cost | 0);
      tower.def = opt.def;
      // Upgrades refresh structure HP to the new type's max.
      tower.maxHp = towerMaxHpFromDef(opt.def);
      tower.hp = tower.maxHp;
      tower.burstQueue = [];
      tower.cooldown = 0;
      setMsg(
        "Upgraded to " + (opt.name || "next tier") + " (−" + opt.cost + "g).",
        "ok"
      );
      hidePlaceMenu();
      updateHud();
      return;
    }

    if (state.towers.some((t) => t.x === x && t.y === y)) {
      setMsg("Something is already placed here.", "error");
      hidePlaceMenu();
      return;
    }

    if (opt.type === "tower") {
      state.gold -= opt.cost;
      // Only base towers (no upgrade_of) are placeable from the build menu
      const def = opt.def;
      const maxHp = towerMaxHpFromDef(def);
      state.towers.push({
        x,
        y,
        def: def,
        rootId: def && def.id,
        spent: opt.cost | 0,
        maxHp,
        hp: maxHp,
        cooldown: 0,
        burstQueue: [],
      });
      // Keep pad kind for pads; mark ground builds as tower for obstacles in rush.
      if (state.simGrid[y][x] !== "tower") {
        state.simGrid[y][x] = "tower";
      }
      setMsg(
        "Placed " + (opt.name || "tower") + " (−" + opt.cost + "g).",
        "ok"
      );
      // Sealing a lane should immediately send monsters into dig/attack mode.
      repathAllMonsters();
    } else if (opt.type === "wall") {
      state.gold -= opt.cost;
      state.simGrid[y][x] = "blocked";
      setCellKindVisual(x, y, "blocked");
      if (!state.playerWalls) state.playerWalls = new Map();
      state.playerWalls.set(key(x, y), opt.cost | 0 || WALL_COST);
      setMsg("Placed wall (−" + opt.cost + "g).", "ok");
      // Monsters may need a new path after a wall drops.
      repathAllMonsters();
    }
    hidePlaceMenu();
    updateHud();
  }

  function liveTowers() {
    // Prefer the live editor document so upgrade defs match the palette.
    const live = typeof getDoc === "function" ? getDoc() : null;
    if (live && Array.isArray(live.towers)) return live.towers;
    return (state.doc && state.doc.towers) || [];
  }

  function rootBaseId(tower) {
    // Placed towers track root base via rootId; fall back to def.upgrade_of chain
    if (tower.rootId) return tower.rootId;
    let def = tower.def;
    const towers = liveTowers();
    const seen = new Set();
    while (def && def.upgrade_of && !seen.has(def.id)) {
      seen.add(def.id);
      const parent = towers.find(
        (x) => String(x.id) === String(def.upgrade_of)
      );
      if (!parent) break;
      def = parent;
    }
    return def ? def.id : tower.def && tower.def.id;
  }

  function currentUpgradeLevel(tower) {
    // Base placement is level 0; after upgrading to a tower with upgrade_level N, level is N
    if (tower.def && String(tower.def.upgrade_of || "").trim()) {
      const lvl = Number(tower.def.upgrade_level);
      return Number.isFinite(lvl) && lvl >= 1 ? lvl : 1;
    }
    return 0;
  }

  function upgradeLevelOf(tdef) {
    const lvl = Number(tdef && tdef.upgrade_level);
    return Number.isFinite(lvl) && lvl >= 1 ? lvl : 1;
  }

  /**
   * Find upgrade options for a placed tower.
   * Flat model: upgrade_of = base id, upgrade_level = tier (1, 2, …).
   * Also accepts upgrade_of = current type id (direct parent chain).
   * Uses the next *available* tier, not only current+1 (skips gaps).
   */
  function findUpgradeOptions(tower) {
    const towers = liveTowers();
    const baseId = String(rootBaseId(tower) || "");
    const curId = String((tower.def && tower.def.id) || "");
    const currentLevel = currentUpgradeLevel(tower);

    const ofBase = towers.filter(
      (u) => String(u.upgrade_of || "").trim() === baseId && String(u.id) !== curId
    );
    const higher = ofBase.filter((u) => upgradeLevelOf(u) > currentLevel);
    if (higher.length) {
      const nextLevel = Math.min.apply(
        null,
        higher.map((u) => upgradeLevelOf(u))
      );
      return {
        nextLevel,
        ups: higher.filter((u) => upgradeLevelOf(u) === nextLevel),
      };
    }

    // Direct children of the current type (chain-style upgrade_of)
    if (curId) {
      const children = towers.filter(
        (u) =>
          String(u.upgrade_of || "").trim() === curId && String(u.id) !== curId
      );
      if (children.length) {
        return { nextLevel: currentLevel + 1, ups: children };
      }
    }

    return { nextLevel: currentLevel + 1, ups: [] };
  }

  function openTowerMenu(clientX, clientY, tower) {
    // Keep state.doc tower list in sync with the editor (upgrade defs may change).
    const live = typeof getDoc === "function" ? getDoc() : null;
    if (live) state.doc = live;

    const { nextLevel, ups } = findUpgradeOptions(tower);
    const baseName = (tower.def && tower.def.name) || "Tower";
    const refund = sellRefund(towerSpent(tower));

    const options = ups.map((u) => ({
      type: "upgrade",
      id: u.id,
      name: u.name || "Upgrade",
      cost: u.cost | 0 || 0,
      def: u,
      meta:
        (u.cost | 0 || 0) +
        "g · " +
        (u.damage | 0 || 0) +
        " dmg" +
        (u.weapon && u.weapon.type && u.weapon.type !== "single"
          ? " · " + String(u.weapon.type).replace(/_/g, " ")
          : "") +
        (u.element && u.element.type && u.element.type !== "none"
          ? " · " + u.element.type
          : ""),
    }));

    if (options.length === 1) {
      options[0].meta =
        "Upgrade for " + options[0].cost + "g — click to confirm";
    }

    options.push({
      type: "sell",
      id: "sell",
      name: "Sell tower",
      cost: 0,
      danger: true,
      meta: refund > 0 ? "+" + refund + "g refund" : "remove",
    });

    let title = baseName;
    if (options.length > 1 && ups.length) {
      title =
        ups.length === 1
          ? baseName + " — upgrade or sell"
          : baseName +
            " — choose level " +
            nextLevel +
            " upgrade (" +
            ups.length +
            ") or sell";
    } else {
      title = baseName + " — sell or cancel";
    }

    openPlaceMenu(clientX, clientY, tower.x, tower.y, options, title);
  }

  function openWallMenu(clientX, clientY, x, y) {
    const k = key(x, y);
    const paid =
      state.playerWalls && state.playerWalls.has(k)
        ? state.playerWalls.get(k) | 0
        : 0;
    const refund = sellRefund(paid);
    const options = [
      {
        type: "remove_wall",
        id: "remove_wall",
        name: "Remove wall",
        cost: 0,
        danger: true,
        meta: refund > 0 ? "+" + refund + "g refund" : "clear cell",
      },
    ];
    openPlaceMenu(
      clientX,
      clientY,
      x,
      y,
      options,
      refund > 0 ? "Wall — remove for refund" : "Wall — remove"
    );
  }

  function onOverlayClick(clientX, clientY) {
    if (!state.active || state.status !== "running") return;
    // Allow placement while paused too
    const cell = clientToCell(clientX, clientY);
    if (!cell) {
      hidePlaceMenu();
      return;
    }
    const { x, y } = cell;

    // Click existing tower → upgrade / sell menu
    const existing = state.towers.find(
      (t) => (t.x | 0) === (x | 0) && (t.y | 0) === (y | 0)
    );
    if (existing) {
      openTowerMenu(clientX, clientY, existing);
      return;
    }

    // Click wall → remove menu
    if (state.simGrid[y][x] === "blocked") {
      openWallMenu(clientX, clientY, x, y);
      return;
    }

    const options = placementOptionsForCell(x, y);
    if (!options.length) {
      hidePlaceMenu();
      const kind = state.simGrid[y][x];
      if (kind === "spawn" || kind === "exit") {
        setMsg("Cannot place on spawn or exit.", "error");
      } else {
        setMsg(
          "Not a buildable cell. Use a tower pad" +
            (state.doc.settings.allow_ground_build
              ? " or enable ground-build for open ground."
              : " (or turn on “Allow building on bare ground”)."),
          "error"
        );
      }
      return;
    }
    openPlaceMenu(clientX, clientY, x, y, options);
  }

  function init(opts) {
    bindDom();
    getDoc = opts.getDocument || getDoc;
    onModeChange = opts.onModeChange || onModeChange;

    els.play?.addEventListener("click", () => {
      if (!state.active) start();
      else if (state.paused) resume();
    });
    els.pause?.addEventListener("click", () => pause());
    els.stop?.addEventListener("click", () => {
      hidePlaceMenu();
      stop();
    });
    els.waveBtn?.addEventListener("click", () => {
      // Skip countdown / force next wave for testing
      if (state.active && !state.paused) {
        state.phase = "wave_active";
        state.countdown = 0;
        queueWave();
      }
    });
    document.querySelectorAll(".playtest-speed").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.speed = parseFloat(btn.dataset.speed) || 1;
        document.querySelectorAll(".playtest-speed").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
      });
    });
    els.overlay?.addEventListener("click", (e) => {
      e.stopPropagation();
      onOverlayClick(e.clientX, e.clientY);
    });
    els.placeMenu?.addEventListener("click", (e) => {
      e.stopPropagation();
      const cancel = e.target.closest("[data-cancel]");
      if (cancel) {
        hidePlaceMenu();
        return;
      }
      const item = e.target.closest("[data-opt-index]");
      if (!item || item.disabled) return;
      const idx = parseInt(item.getAttribute("data-opt-index"), 10);
      const options = els.placeMenu._options || [];
      const opt = options[idx];
      if (opt) applyPlacement(opt);
    });
    document.addEventListener("click", (e) => {
      if (!els.placeMenu || els.placeMenu.hidden) return;
      if (
        els.placeMenu._ignoreOutsideUntil &&
        performance.now() < els.placeMenu._ignoreOutsideUntil
      ) {
        return;
      }
      if (els.placeMenu.contains(e.target)) return;
      if (els.overlay && els.overlay.contains(e.target)) return;
      hidePlaceMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hidePlaceMenu();
    });

    window.addEventListener("resize", () => {
      if (state.active) renderOverlay();
      hidePlaceMenu();
    });

    setControlsRunning(false);
  }

  window.OpenTDPlaytest = {
    init,
    isActive: () => state.active,
    stop,
    start,
  };
})();
