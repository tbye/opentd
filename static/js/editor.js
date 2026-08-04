/**
 * OpenTD map editor — grid painting, portals, entities, draft autosave.
 */
(function () {
  "use strict";

  const root = document.getElementById("editor-app");
  if (!root) return;

  const initialEl = document.getElementById("initial-game-document");
  let doc;
  try {
    doc = JSON.parse(initialEl ? initialEl.textContent : "{}");
  } catch (e) {
    doc = null;
  }
  if (!doc || !doc.settings || !doc.grid) {
    console.error("Invalid initial game document");
    return;
  }

  // Ensure portal arrays exist for older drafts.
  if (!Array.isArray(doc.spawns)) doc.spawns = [];
  if (!Array.isArray(doc.exits)) doc.exits = [];
  if (!Array.isArray(doc.wave_types)) doc.wave_types = [];

  const SCOREBOARD_WIDGETS = [
    { id: "score", label: "Score", hint: "Points from defeated monsters" },
    { id: "lives", label: "Lives", hint: "Remaining player lives" },
    { id: "gold", label: "Gold", hint: "Spendable currency" },
    { id: "wave", label: "Wave", hint: "Current wave number" },
    { id: "timer", label: "Countdown", hint: "Start / between-wave timer" },
    { id: "mobs", label: "Monsters left", hint: "Living enemies on the field" },
    { id: "title", label: "Game title", hint: "Shows the game name" },
  ];
  const DEFAULT_SCOREBOARD = ["score", "lives", "gold", "wave", "timer"];

  function ensureScoreboard() {
    if (!doc.scoreboard || !Array.isArray(doc.scoreboard.items)) {
      doc.scoreboard = { items: DEFAULT_SCOREBOARD.slice() };
    }
    const seen = new Set();
    doc.scoreboard.items = doc.scoreboard.items.filter((id) => {
      if (!SCOREBOARD_WIDGETS.some((w) => w.id === id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!doc.scoreboard.items.length) {
      doc.scoreboard.items = DEFAULT_SCOREBOARD.slice();
    }
  }
  ensureScoreboard();
  if (doc.settings.start_delay_seconds == null) doc.settings.start_delay_seconds = 15;
  if (doc.settings.between_waves_delay_seconds == null) {
    doc.settings.between_waves_delay_seconds = 5;
  }

  const csrf =
    document.querySelector("body")?.getAttribute("hx-headers") &&
    (() => {
      try {
        return JSON.parse(
          document.querySelector("body").getAttribute("hx-headers")
        )["X-CSRFToken"];
      } catch (_) {
        return null;
      }
    })();

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[2]) : "";
  }
  const csrfToken = csrf || getCookie("csrftoken");

  const draftUrl = root.dataset.draftUrl;
  const stashUrl = root.dataset.stashUrl;
  const gameCreateUrl = root.dataset.gameCreateUrl;
  const gameSaveUrl = root.dataset.gameSaveUrl || "";
  const isGuest = root.dataset.isGuest === "1";
  const isAuth = root.dataset.isAuth === "1";
  const maxDocumentBytes = parseInt(root.dataset.maxDocumentBytes || "200000", 10) || 200000;

  /** @type {{ max_games: number, max_towers: number, max_monsters: number, max_wave_types: number, tier: string }} */
  let limits = {
    max_games: 1,
    max_towers: 5,
    max_monsters: 5,
    max_wave_types: 3,
    tier: "guest",
  };
  try {
    const limEl = document.getElementById("editor-limits-json");
    if (limEl && limEl.textContent) {
      limits = Object.assign(limits, JSON.parse(limEl.textContent));
    }
  } catch (_) {
    /* keep defaults */
  }

  const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

  // Default paint tool: Spawn (critical for a complete game).
  let tool = "spawn";
  let painting = false;
  /** @type {"paint"|"erase"|null} fixed for the current pointer stroke */
  let strokeAction = null;
  let playtestLocked = false;
  let selectedTowerId = null;
  let selectedMonsterId = null;
  let selectedWaveTypeId = null;
  /** @type {{ kind: 'spawn'|'exit', id: string } | null} */
  let selectedPortal = null;
  let dirty = false;
  let saveTimer = null;

  // Persist palette open/closed (and which entity is expanded) across reloads.
  const UI_STATE_KEY = "opentd.editor.uiState";

  function readUiState() {
    try {
      const raw = localStorage.getItem(UI_STATE_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : {};
    } catch (_) {
      return {};
    }
  }

  function writeUiState(patch) {
    try {
      localStorage.setItem(
        UI_STATE_KEY,
        JSON.stringify(Object.assign(readUiState(), patch))
      );
    } catch (_) {
      /* private mode / quota */
    }
  }

  function palettePanels() {
    return document.querySelectorAll(
      ".editor-palette__scroll > details.palette-tree[data-panel]"
    );
  }

  function saveUiChromeState() {
    const palette = {};
    palettePanels().forEach((el) => {
      palette[el.dataset.panel] = !!el.open;
    });
    writeUiState({
      palette,
      selectedTowerId: selectedTowerId || null,
      selectedMonsterId: selectedMonsterId || null,
      selectedWaveTypeId: selectedWaveTypeId || null,
    });
  }

  function restoreUiChromeState() {
    const ui = readUiState();
    if (ui.palette && typeof ui.palette === "object") {
      palettePanels().forEach((el) => {
        const key = el.dataset.panel;
        if (Object.prototype.hasOwnProperty.call(ui.palette, key)) {
          el.open = !!ui.palette[key];
        }
      });
    }
    if (typeof ui.selectedTowerId === "string") {
      selectedTowerId = ui.selectedTowerId;
    }
    if (typeof ui.selectedMonsterId === "string") {
      selectedMonsterId = ui.selectedMonsterId;
    }
    if (typeof ui.selectedWaveTypeId === "string") {
      selectedWaveTypeId = ui.selectedWaveTypeId;
    }
  }

  function initPaletteDisclosurePersist() {
    restoreUiChromeState();
    palettePanels().forEach((el) => {
      el.addEventListener("toggle", () => saveUiChromeState());
    });
  }

  if (!doc.settings.game_type) doc.settings.game_type = "monster_march";
  if (typeof doc.settings.chaos_mode !== "boolean") doc.settings.chaos_mode = false;

  const els = {
    grid: document.getElementById("editor-grid"),
    title: document.getElementById("game-title"),
    status: document.getElementById("save-status"),
    width: document.getElementById("set-width"),
    height: document.getElementById("set-height"),
    groundBuild: document.getElementById("set-ground-build"),
    lives: document.getElementById("set-lives"),
    gold: document.getElementById("set-gold"),
    chaosMode: document.getElementById("set-chaos-mode"),
    chaosWrap: document.getElementById("chaos-mode-wrap"),
    chaosLabel: document.getElementById("chaos-mode-label"),
    completenessBanner: document.getElementById("completeness-banner"),
    completenessText: document.getElementById("completeness-text"),
    ptPlay: document.getElementById("pt-play"),
    ptPlayWrap: document.getElementById("pt-play-wrap"),
    terrainHint: document.getElementById("terrain-hint"),
    towerList: document.getElementById("tower-list"),
    monsterList: document.getElementById("monster-list"),
    towerCount: document.getElementById("tower-count"),
    monsterCount: document.getElementById("monster-count"),
    waveTypeList: document.getElementById("wave-type-list"),
    waveTypeCount: document.getElementById("wave-type-count"),
    spawnList: document.getElementById("spawn-list"),
    exitList: document.getElementById("exit-list"),
    spawnEmpty: document.getElementById("spawn-empty"),
    exitEmpty: document.getElementById("exit-empty"),
    portalCount: document.getElementById("portal-count"),
    portalEditor: document.getElementById("portal-editor"),
    portalEditorTitle: document.getElementById("portal-editor-title"),
    portalId: document.getElementById("portal-id"),
    portalPos: document.getElementById("portal-pos"),
    portalError: document.getElementById("portal-error"),
    spawnExitSettings: document.getElementById("spawn-exit-settings"),
    spawnExitAny: document.getElementById("spawn-exit-any"),
    spawnExitSpecific: document.getElementById("spawn-exit-specific"),
    spawnExitId: document.getElementById("spawn-exit-id"),
  };

  function setStatus(text, tone) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.className =
      "text-xs whitespace-nowrap " +
      (tone === "error"
        ? "text-error"
        : tone === "ok"
          ? "text-success"
          : "opacity-60");
  }

  function markDirty() {
    dirty = true;
    setStatus("Unsaved…");
    updatePlayButtonPlayability();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      autosaveDraft();
    }, 800);
  }

  function uid(prefix) {
    return (
      prefix +
      "_" +
      Math.random().toString(16).slice(2, 10) +
      Date.now().toString(16).slice(-4)
    );
  }

  function nextNumericId(list) {
    const used = new Set(list.map((p) => String(p.id)));
    let n = 1;
    while (used.has(String(n))) n += 1;
    return String(n);
  }

  function findSpawnAt(x, y) {
    return (doc.spawns || []).find((s) => s.x === x && s.y === y) || null;
  }

  function findExitAt(x, y) {
    return (doc.exits || []).find((e) => e.x === x && e.y === y) || null;
  }

  function removePortalAt(x, y) {
    const beforeS = doc.spawns.length;
    const beforeE = doc.exits.length;
    doc.spawns = doc.spawns.filter((s) => !(s.x === x && s.y === y));
    doc.exits = doc.exits.filter((e) => !(e.x === x && e.y === y));
    if (
      selectedPortal &&
      ((selectedPortal.kind === "spawn" &&
        !doc.spawns.some((s) => s.id === selectedPortal.id)) ||
        (selectedPortal.kind === "exit" &&
          !doc.exits.some((e) => e.id === selectedPortal.id)))
    ) {
      selectedPortal = null;
    }
    // Clear spawn links to removed exits
    const exitIds = new Set(doc.exits.map((e) => e.id));
    doc.spawns.forEach((s) => {
      if (s.exit_mode === "specific" && s.exit_id && !exitIds.has(s.exit_id)) {
        s.exit_id = "";
      }
    });
    return beforeS !== doc.spawns.length || beforeE !== doc.exits.length;
  }

  function addSpawn(x, y) {
    if (findSpawnAt(x, y)) return findSpawnAt(x, y);
    const spawn = {
      id: nextNumericId(doc.spawns),
      x,
      y,
      exit_mode: "any",
      exit_id: "",
    };
    doc.spawns.push(spawn);
    return spawn;
  }

  function addExit(x, y) {
    if (findExitAt(x, y)) return findExitAt(x, y);
    const exit = {
      id: nextNumericId(doc.exits),
      x,
      y,
    };
    doc.exits.push(exit);
    return exit;
  }

  function prunePortalsOutsideGrid() {
    const h = doc.grid.length;
    const w = doc.grid[0] ? doc.grid[0].length : 0;
    doc.spawns = doc.spawns.filter((s) => {
      if (s.x < 0 || s.y < 0 || s.x >= w || s.y >= h) return false;
      return doc.grid[s.y][s.x] === "spawn";
    });
    doc.exits = doc.exits.filter((e) => {
      if (e.x < 0 || e.y < 0 || e.x >= w || e.y >= h) return false;
      return doc.grid[e.y][e.x] === "exit";
    });
  }

  function resizeGrid(newW, newH) {
    newW = Math.max(5, Math.min(40, newW | 0));
    newH = Math.max(5, Math.min(30, newH | 0));
    const old = doc.grid || [];
    const next = [];
    for (let y = 0; y < newH; y++) {
      const row = [];
      for (let x = 0; x < newW; x++) {
        row.push(old[y] && old[y][x] ? old[y][x] : "ground");
      }
      next.push(row);
    }
    doc.grid = next;
    doc.settings.width = newW;
    doc.settings.height = newH;
    prunePortalsOutsideGrid();
    renderGrid();
    renderPortals();
    markDirty();
  }

  /**
   * Paint or erase a cell.
   * action: "paint" | "erase" | null
   *   null  → auto: same type as tool erases to ground; otherwise paints tool
   *   paint → set cell to current tool (no-op if already that type)
   *   erase → set cell to ground only if it matches the current tool
   * Stroke mode (drag) passes a fixed action so a path drag doesn't flip
   * every other cell.
   */
  function paintCell(x, y, action) {
    if (playtestLocked) return;
    if (y < 0 || x < 0 || y >= doc.grid.length || x >= doc.grid[0].length) return;
    const prev = doc.grid[y][x];

    let mode = action;
    if (!mode) {
      // Click same type as palette → clear to ground (except ground tool).
      mode =
        tool !== "ground" && prev === tool ? "erase" : "paint";
    }

    if (mode === "erase") {
      if (prev !== tool || tool === "ground") return;
      if (prev === "spawn" || prev === "exit") {
        removePortalAt(x, y);
      }
      // Drop portal selection if that portal was just erased.
      if (selectedPortal) {
        const still =
          selectedPortal.kind === "spawn"
            ? doc.spawns.find((s) => s.id === selectedPortal.id)
            : doc.exits.find((e) => e.id === selectedPortal.id);
        if (!still) {
          selectedPortal = null;
          els.portalEditor?.classList.add("hidden");
        }
      }
      doc.grid[y][x] = "ground";
      updateCellDom(x, y);
      renderPortals();
      markDirty();
      return;
    }

    // paint
    if (prev === tool) return;

    // Leaving a portal cell removes its metadata.
    if (prev === "spawn" || prev === "exit") {
      removePortalAt(x, y);
    }

    doc.grid[y][x] = tool;

    if (tool === "spawn") {
      const s = addSpawn(x, y);
      selectPortal("spawn", s.id);
    } else if (tool === "exit") {
      const e = addExit(x, y);
      selectPortal("exit", e.id);
    }

    updateCellDom(x, y);
    renderPortals();
    markDirty();
  }

  function portalLabelAt(x, y, kind) {
    if (kind === "spawn") {
      const s = findSpawnAt(x, y);
      return s ? s.id : "?";
    }
    if (kind === "exit") {
      const e = findExitAt(x, y);
      return e ? e.id : "?";
    }
    return "";
  }

  function updateCellDom(x, y) {
    const cell = els.grid.querySelector(`[data-x="${x}"][data-y="${y}"]`);
    if (!cell) {
      renderGrid();
      return;
    }
    const kind = doc.grid[y][x];
    cell.dataset.kind = kind;
    const label = portalLabelAt(x, y, kind);
    cell.textContent = label;
    cell.title =
      kind === "spawn" || kind === "exit"
        ? `${kind} “${label}” (${x},${y})`
        : `${kind} (${x},${y})`;
    const isSel =
      selectedPortal &&
      ((selectedPortal.kind === "spawn" &&
        findSpawnAt(x, y)?.id === selectedPortal.id) ||
        (selectedPortal.kind === "exit" &&
          findExitAt(x, y)?.id === selectedPortal.id));
    cell.classList.toggle("is-selected-portal", !!isSel);
  }

  function cellSize() {
    const w = doc.settings.width;
    const max = 36;
    const min = 14;
    const avail = Math.min(window.innerWidth - 360, 900);
    const size = Math.floor(avail / Math.max(w, 1));
    return Math.max(min, Math.min(max, size || 28));
  }

  function renderGrid() {
    const w = doc.settings.width;
    const h = doc.settings.height;
    const size = cellSize();
    els.grid.style.setProperty("--cell", size + "px");
    els.grid.style.gridTemplateColumns = `repeat(${w}, var(--cell))`;
    els.grid.innerHTML = "";

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const kind = (doc.grid[y] && doc.grid[y][x]) || "ground";
        const cell = document.createElement("div");
        cell.className = "editor-cell";
        cell.dataset.kind = kind;
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        cell.setAttribute("role", "gridcell");
        const label = portalLabelAt(x, y, kind);
        cell.textContent = label;
        cell.title =
          kind === "spawn" || kind === "exit"
            ? `${kind} “${label}” (${x},${y})`
            : `${kind} (${x},${y})`;
        if (
          selectedPortal &&
          ((selectedPortal.kind === "spawn" &&
            findSpawnAt(x, y)?.id === selectedPortal.id) ||
            (selectedPortal.kind === "exit" &&
              findExitAt(x, y)?.id === selectedPortal.id))
        ) {
          cell.classList.add("is-selected-portal");
        }
        els.grid.appendChild(cell);
      }
    }
  }

  function selectPortal(kind, id) {
    selectedPortal = { kind, id };
    selectedTowerId = null;
    selectedMonsterId = null;
    fillPortalEditor();
    renderPortals();
    renderGrid();
    // Collapse entity disclosures when editing portals
    renderTowers();
    renderMonsters();
  }

  const CHEVRON_SVG =
    '<svg class="chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>' +
    "</svg>";

  function fillPortalEditor() {
    if (!els.portalEditor || !selectedPortal) {
      els.portalEditor?.classList.add("hidden");
      return;
    }
    const list = selectedPortal.kind === "spawn" ? doc.spawns : doc.exits;
    const item = list.find((p) => p.id === selectedPortal.id);
    if (!item) {
      els.portalEditor.classList.add("hidden");
      return;
    }
    els.portalEditor.classList.remove("hidden");
    els.portalEditorTitle.textContent =
      selectedPortal.kind === "spawn" ? "Edit spawn" : "Edit exit";
    els.portalId.value = item.id;
    els.portalPos.textContent = `Position: (${item.x}, ${item.y})`;
    els.portalError?.classList.add("hidden");

    if (selectedPortal.kind === "spawn") {
      els.spawnExitSettings.classList.remove("hidden");
      const mode = item.exit_mode === "specific" ? "specific" : "any";
      els.spawnExitAny.checked = mode === "any";
      els.spawnExitSpecific.checked = mode === "specific";
      populateExitSelect(item.exit_id || "");
      els.spawnExitId.disabled = mode !== "specific";
    } else {
      els.spawnExitSettings.classList.add("hidden");
    }
  }

  function populateExitSelect(selectedId) {
    if (!els.spawnExitId) return;
    const cur = selectedId || els.spawnExitId.value;
    els.spawnExitId.innerHTML = '<option value="">— select exit —</option>';
    doc.exits.forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = `${e.id} @ (${e.x},${e.y})`;
      if (e.id === cur) opt.selected = true;
      els.spawnExitId.appendChild(opt);
    });
  }

  function updateCompleteness() {
    const nSpawn = doc.spawns.length;
    const nExit = doc.exits.length;
    const ok = nSpawn >= 1 && nExit >= 1;
    if (els.portalCount) {
      els.portalCount.textContent = String(nSpawn + nExit);
      els.portalCount.className =
        "badge badge-sm ml-auto " + (ok ? "badge-success" : "badge-warning");
    }
    if (els.completenessBanner && els.completenessText) {
      if (ok) {
        els.completenessBanner.className =
          "alert alert-success text-xs py-2 px-3";
        els.completenessText.innerHTML =
          "Complete: <strong>" +
          nSpawn +
          "</strong> spawn" +
          (nSpawn === 1 ? "" : "s") +
          ", <strong>" +
          nExit +
          "</strong> exit" +
          (nExit === 1 ? "" : "s") +
          ".";
      } else {
        els.completenessBanner.className =
          "alert alert-warning text-xs py-2 px-3";
        const need = [];
        if (nSpawn < 1) need.push("1 Spawn");
        if (nExit < 1) need.push("1 Exit");
        els.completenessText.innerHTML =
          "A complete game needs at least <strong>" +
          need.join("</strong> and <strong>") +
          "</strong>.";
      }
    }
    updatePlayButtonPlayability();
  }

  const ICON_PLAY =
    '<svg class="pt-btn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  const ICON_WARN =
    '<svg class="pt-btn-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';

  /**
   * Yellow Play button + DaisyUI tooltip when the design has playability issues.
   * Never blocks playtest — builders may still run the sim in test mode.
   */
  function updatePlayButtonPlayability() {
    const btn = els.ptPlay || document.getElementById("pt-play");
    const wrap = els.ptPlayWrap || document.getElementById("pt-play-wrap");
    if (!btn || !window.OpenTDDesignValidate) return;
    syncDocFromForm();
    const report = window.OpenTDDesignValidate.analyzeDesign(doc);
    const hasIssues = report.issues && report.issues.length > 0;
    const label = btn.dataset.playLabel || "Play";

    btn.classList.remove("btn-success", "btn-warning");
    btn.classList.add(hasIssues ? "btn-warning" : "btn-success");
    btn.innerHTML =
      (hasIssues ? ICON_WARN : ICON_PLAY) +
      "<span>" +
      label +
      "</span>";

    if (wrap) {
      wrap.classList.remove(
        "tooltip",
        "tooltip-top",
        "tooltip-warning",
        "tooltip-secondary"
      );
      wrap.removeAttribute("data-tip");
      if (hasIssues) {
        // Keep tip compact so it fits above the bar without clipping.
        const tip = report.issues
          .map((i) => {
            const tag = i.severity === "error" ? "!" : "•";
            return tag + " " + i.message;
          })
          .join("\n\n");
        wrap.classList.add("tooltip", "tooltip-top", "tooltip-warning");
        wrap.setAttribute("data-tip", tip);
        btn.setAttribute(
          "aria-description",
          report.issues.map((i) => i.message).join(" ")
        );
      } else {
        btn.removeAttribute("aria-description");
      }
    }
  }

  function updateGameTypeUi() {
    const gt = doc.settings.game_type || "monster_march";
    const rush = gt === "monster_rush";
    if (els.chaosMode) {
      els.chaosMode.disabled = !rush;
      if (!rush) {
        // Keep stored value in doc; only the control is inactive until Rush is selected.
      }
    }
    if (els.chaosLabel) {
      els.chaosLabel.classList.toggle("opacity-50", !rush);
      els.chaosLabel.classList.toggle("cursor-pointer", rush);
      els.chaosLabel.classList.toggle("cursor-not-allowed", !rush);
    }
    if (els.terrainHint) {
      const eraseTip = " Click the same type again to clear to ground.";
      if (gt === "monster_rush") {
        els.terrainHint.textContent =
          "Monster Rush: walls and tower pads build the maze. Path paint is optional. Blocked monsters chew walls/towers on the shortest route until a free path opens (unless Chaos mode)." +
          eraseTip;
      } else if (gt === "defend_the_castle") {
        els.terrainHint.textContent =
          "Defend the Castle: monsters push toward a central castle objective. Place spawns, exits, and defensive terrain." +
          eraseTip;
      } else {
        els.terrainHint.textContent =
          "Monster March: paint a continuous Path from spawn toward exit. Tower pads mark build sites." +
          eraseTip;
      }
    }
  }

  function renderPortals() {
    if (!els.spawnList) return;
    els.spawnList.innerHTML = "";
    els.exitList.innerHTML = "";
    updateCompleteness();
    if (els.spawnEmpty) {
      els.spawnEmpty.classList.toggle("hidden", doc.spawns.length > 0);
    }
    if (els.exitEmpty) {
      els.exitEmpty.classList.toggle("hidden", doc.exits.length > 0);
    }

    doc.spawns.forEach((s) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "entity-card btn btn-xs btn-ghost justify-start w-full normal-case font-normal border border-base-300 " +
        (selectedPortal?.kind === "spawn" && selectedPortal.id === s.id
          ? "is-selected"
          : "");
      const target =
        s.exit_mode === "specific"
          ? s.exit_id
            ? `→ ${escapeHtml(s.exit_id)}`
            : "→ (pick exit)"
          : "→ any";
      btn.innerHTML = `<span class="font-medium">S:${escapeHtml(s.id)}</span>
        <span class="opacity-50 text-[10px] ml-auto">(${s.x},${s.y}) ${target}</span>`;
      btn.addEventListener("click", () => selectPortal("spawn", s.id));
      els.spawnList.appendChild(btn);
    });

    doc.exits.forEach((e) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "entity-card btn btn-xs btn-ghost justify-start w-full normal-case font-normal border border-base-300 " +
        (selectedPortal?.kind === "exit" && selectedPortal.id === e.id
          ? "is-selected"
          : "");
      btn.innerHTML = `<span class="font-medium">E:${escapeHtml(e.id)}</span>
        <span class="opacity-50 text-[10px] ml-auto">(${e.x},${e.y})</span>`;
      btn.addEventListener("click", () => selectPortal("exit", e.id));
      els.exitList.appendChild(btn);
    });

    // Keep exit dropdown fresh while editing a spawn.
    if (selectedPortal?.kind === "spawn") {
      populateExitSelect(
        doc.spawns.find((s) => s.id === selectedPortal.id)?.exit_id || ""
      );
    }
  }

  function applyPortalEdits() {
    if (!selectedPortal) return;
    const list = selectedPortal.kind === "spawn" ? doc.spawns : doc.exits;
    const item = list.find((p) => p.id === selectedPortal.id);
    if (!item) return;

    const newId = (els.portalId.value || "").trim();
    if (!ID_RE.test(newId)) {
      showPortalError("Id must be 1–32 letters, numbers, _ or -.");
      return;
    }
    const clash = list.some(
      (p) => p.id === newId && !(p.x === item.x && p.y === item.y)
    );
    if (clash) {
      showPortalError("That id is already used by another " + selectedPortal.kind + ".");
      return;
    }

    const oldId = item.id;
    item.id = newId;

    if (selectedPortal.kind === "spawn") {
      const mode = els.spawnExitSpecific.checked ? "specific" : "any";
      item.exit_mode = mode;
      if (mode === "specific") {
        item.exit_id = els.spawnExitId.value || "";
        if (!item.exit_id) {
          showPortalError("Pick an exit, or choose “Any exit”.");
          return;
        }
      } else {
        item.exit_id = "";
      }
    } else if (oldId !== newId) {
      // Rename exit references on spawns.
      doc.spawns.forEach((s) => {
        if (s.exit_id === oldId) s.exit_id = newId;
      });
    }

    selectedPortal.id = newId;
    els.portalError?.classList.add("hidden");
    renderPortals();
    renderGrid();
    markDirty();
    setStatus("Portal updated", "ok");
  }

  function showPortalError(msg) {
    if (!els.portalError) return;
    els.portalError.textContent = msg;
    els.portalError.classList.remove("hidden");
  }

  function defaultWeapon() {
    return {
      type: "single",
      projectile_count: 1,
      burst_interval: 0.08,
      spread_degrees: 30,
    };
  }

  function towerCooldown(node) {
    if (node.cooldown != null && Number.isFinite(Number(node.cooldown))) {
      return Number(node.cooldown);
    }
    // Legacy fire_rate (shots per second)
    if (node.fire_rate != null && Number(node.fire_rate) > 0) {
      return 1 / Number(node.fire_rate);
    }
    return 1;
  }

  function defaultElement() {
    return {
      type: "none",
      duration: 2,
      tick_rate: 0.5,
      tick_damage: 1,
      slow_factor: 0.5,
      aoe_radius: 0,
    };
  }

  function ensureTowerShape(t) {
    if (!t.weapon || typeof t.weapon !== "object") t.weapon = defaultWeapon();
    if (!t.element || typeof t.element !== "object") t.element = defaultElement();
    if (t.cooldown == null && t.fire_rate != null && Number(t.fire_rate) > 0) {
      t.cooldown = 1 / Number(t.fire_rate);
    }
    if (t.cooldown == null) t.cooldown = 1;
    if (t.range == null) t.range = 3;
    if (t.hp == null || !(t.hp >= 1)) t.hp = 50;
    if (t.upgrade_of == null) t.upgrade_of = "";
    if (t.upgrade_level == null || t.upgrade_level < 1) t.upgrade_level = 1;
    // Drop legacy nested upgrades tree
    if (t.upgrades) delete t.upgrades;
    return t;
  }

  function baseTowersExcept(towerId) {
    return doc.towers.filter(
      (x) => x.id !== towerId && !(x.upgrade_of && String(x.upgrade_of).trim())
    );
  }

  function countUpgradesAtLevel(baseId, level) {
    return doc.towers.filter(
      (x) =>
        String(x.upgrade_of || "") === String(baseId) &&
        (x.upgrade_level | 0) === (level | 0)
    ).length;
  }

  function towerMetaText(t) {
    const w = (t.weapon && t.weapon.type) || "single";
    const e = (t.element && t.element.type) || "none";
    const bits = [
      (t.cost | 0) + "g",
      (t.hp | 0) + " hp",
      (t.damage | 0) + " dmg",
      "r" + (t.range | 0),
      towerCooldown(t).toFixed(2) + "s",
    ];
    if (w !== "single") bits.push(w.replace(/_/g, " "));
    if (e !== "none") bits.push(e);
    if (t.upgrade_of) {
      const base = doc.towers.find((x) => x.id === t.upgrade_of);
      bits.push(
        "↑ " +
          (base ? base.name : "?") +
          " L" +
          (t.upgrade_level | 0 || 1)
      );
    }
    return bits.join(" · ");
  }

  function selectHtml(path, value, options) {
    return (
      `<select class="select select-xs select-bordered w-full" data-path="${escapeAttr(path)}">` +
      options
        .map(
          ([val, lab]) =>
            `<option value="${escapeAttr(val)}"${val === value ? " selected" : ""}>${escapeHtml(lab)}</option>`
        )
        .join("") +
      `</select>`
    );
  }

  function pathField(label, path, value, type, min, step) {
    return (
      `<label class="form-control">` +
      `<span class="label-text text-[10px]">${escapeHtml(label)}</span>` +
      `<input type="${type}" class="input input-xs input-bordered" data-path="${escapeAttr(path)}"` +
      (min != null ? ` min="${min}"` : "") +
      (step != null ? ` step="${step}"` : "") +
      ` value="${escapeAttr(String(value))}">` +
      `</label>`
    );
  }

  /** Form for a flat tower type (base or upgrade of another tower). */
  function towerNodeFormHtml(node) {
    const w = node.weapon || defaultWeapon();
    const el = node.element || defaultElement();
    const wtype = w.type || "single";
    const etype = el.type || "none";
    const bases = baseTowersExcept(node.id);
    const upgradeOf = String(node.upgrade_of || "");
    const upgradeLevel = Math.max(1, node.upgrade_level | 0 || 1);
    const levelCount = upgradeOf
      ? countUpgradesAtLevel(upgradeOf, upgradeLevel)
      : 0;

    let html = "";
    html += `<label class="form-control w-full"><span class="label-text text-[10px]">Name</span>`;
    html += `<input type="text" class="input input-xs input-bordered w-full" data-path="name" value="${escapeAttr(node.name || "")}"></label>`;
    html += `<div class="grid grid-cols-2 gap-1">`;
    html += pathField("Cost", "cost", node.cost ?? 0, "number", 0);
    html += pathField("Health", "hp", node.hp ?? 50, "number", 1);
    html += pathField("Damage", "damage", node.damage ?? 0, "number", 0);
    html += pathField("Range (cells)", "range", node.range ?? 1, "number", 1);
    html += pathField("Cooldown (s)", "cooldown", towerCooldown(node), "number", 0.05, 0.05);
    html += `</div>`;
    html += `<p class="text-[10px] opacity-55 leading-snug m-0">Health is how much damage the tower can take when monsters attack it (Monster Rush dig / chaos).</p>`;
    html += `<label class="form-control w-full"><span class="label-text text-[10px]">Description</span>`;
    html += `<textarea class="textarea textarea-xs textarea-bordered w-full" rows="2" data-path="description">${escapeHtml(node.description || "")}</textarea></label>`;

    // Upgrade linkage (flat: this tower upgrades another)
    html += `<div class="rounded-md border border-base-300 p-2 space-y-1.5 bg-base-100">`;
    html += `<p class="text-[10px] font-semibold uppercase tracking-wide opacity-60">Upgrade of</p>`;
    html += `<label class="form-control w-full"><span class="label-text text-[10px]">Upgrade tower</span>`;
    html += `<select class="select select-xs select-bordered w-full" data-path="upgrade_of">`;
    html += `<option value="">— Not an upgrade (base tower) —</option>`;
    bases.forEach((b) => {
      html += `<option value="${escapeAttr(b.id)}"${b.id === upgradeOf ? " selected" : ""}>${escapeHtml(b.name || b.id)}</option>`;
    });
    html += `</select></label>`;
    if (upgradeOf) {
      const levelOpts = [];
      for (let lv = 1; lv <= 10; lv++) {
        levelOpts.push([String(lv), "Level " + lv]);
      }
      html += `<label class="form-control w-full"><span class="label-text text-[10px]">Upgrades to level</span>`;
      html += selectHtml("upgrade_level", String(upgradeLevel), levelOpts);
      html += `</label>`;
      html += `<p class="text-[11px] leading-snug opacity-70" data-role="upgrade-level-count">`;
      html += `<strong>${levelCount}</strong> tower${levelCount === 1 ? "" : "s"} selectable at this upgrade level`;
      html += levelCount > 1
        ? " (player chooses one when upgrading)."
        : levelCount === 1
          ? " (single path — simple confirm in play)."
          : ".";
      html += `</p>`;
    } else {
      html += `<p class="text-[10px] opacity-50">Base towers can be placed on the map. Create another tower and set “Upgrade tower” to this one to define upgrades.</p>`;
    }
    html += `</div>`;

    // Weapon
    html += `<div class="rounded-md border border-base-300 p-2 space-y-1.5 bg-base-100">`;
    html += `<p class="text-[10px] font-semibold uppercase tracking-wide opacity-60">Weapon</p>`;
    html += `<label class="form-control w-full"><span class="label-text text-[10px]">Type</span>`;
    html += selectHtml("weapon.type", wtype, [
      ["single", "Single shot"],
      ["machine_gun", "Machine gun (burst)"],
      ["shotgun", "Shotgun (spread)"],
      ["sniper", "Sniper (long range)"],
    ]);
    html += `</label>`;
    html += `<div class="grid grid-cols-2 gap-1" data-weapon-fields="${escapeAttr(wtype)}">`;
    if (wtype === "machine_gun") {
      html += pathField("Projectiles / burst", "weapon.projectile_count", w.projectile_count ?? 3, "number", 1);
      html += pathField("Burst cooldown (s)", "weapon.burst_interval", w.burst_interval ?? 0.08, "number", 0.02, 0.01);
    } else if (wtype === "shotgun") {
      html += pathField("Pellets", "weapon.projectile_count", w.projectile_count ?? 5, "number", 1);
      html += pathField("Spread (°)", "weapon.spread_degrees", w.spread_degrees ?? 30, "number", 5);
    } else if (wtype === "sniper") {
      html += `<p class="text-[10px] opacity-50 col-span-2">One high-precision shot. Use a large <strong>Range</strong> and longer <strong>Cooldown</strong>.</p>`;
    } else {
      html += `<p class="text-[10px] opacity-50 col-span-2">One projectile per shot. Cooldown is seconds between shots.</p>`;
    }
    html += `</div></div>`;

    // Element
    html += `<div class="rounded-md border border-base-300 p-2 space-y-1.5 bg-base-100">`;
    html += `<p class="text-[10px] font-semibold uppercase tracking-wide opacity-60">Element / effect</p>`;
    html += `<label class="form-control w-full"><span class="label-text text-[10px]">Element</span>`;
    html += selectHtml("element.type", etype, [
      ["none", "None"],
      ["fire", "Fire (burn)"],
      ["freeze", "Freeze (slow)"],
      ["poison", "Poison"],
    ]);
    html += `</label>`;
    if (etype !== "none") {
      html += `<div class="grid grid-cols-2 gap-1">`;
      html += pathField("Duration (s)", "element.duration", el.duration ?? 2, "number", 0, 0.1);
      html += pathField("Tick rate (s)", "element.tick_rate", el.tick_rate ?? 0.5, "number", 0.1, 0.05);
      html += pathField(
        etype === "freeze" ? "Tick damage (0=slow only)" : "Damage / tick",
        "element.tick_damage",
        el.tick_damage ?? (etype === "freeze" ? 0 : 1),
        "number",
        0
      );
      if (etype === "freeze") {
        html += pathField("Slow factor", "element.slow_factor", el.slow_factor ?? 0.5, "number", 0.05, 0.05);
      }
      html += pathField("AoE radius (cells)", "element.aoe_radius", el.aoe_radius ?? 0, "number", 0, 0.1);
      html += `</div>`;
    }
    html += `</div>`;

    return html;
  }

  function renderTowers() {
    if (!els.towerList) return;
    els.towerList.innerHTML = "";
    els.towerCount.textContent = String(doc.towers.length);
    doc.towers.forEach((t) => {
      ensureTowerShape(t);
      const details = document.createElement("details");
      details.className = "entity-disclosure palette-tree";
      details.dataset.towerId = t.id;
      if (t.id === selectedTowerId) details.open = true;

      const summary = document.createElement("summary");
      summary.innerHTML =
        CHEVRON_SVG +
        `<span class="entity-disclosure__name">${escapeHtml(t.name || "Tower")}</span>` +
        `<span class="entity-disclosure__meta" data-role="tower-meta">${escapeHtml(towerMetaText(t))}</span>`;
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "entity-disclosure__body";
      body.innerHTML =
        towerNodeFormHtml(t) +
        `<button type="button" class="btn btn-xs btn-error btn-outline btn-block" data-action="remove-tower" title="Remove this tower type from the game">Remove tower type</button>`;
      details.appendChild(body);

      details.addEventListener("toggle", () => {
        if (details.open) {
          selectedTowerId = t.id;
          selectedMonsterId = null;
          selectedPortal = null;
          els.towerList.querySelectorAll(":scope > details.entity-disclosure").forEach((d) => {
            if (d !== details) d.open = false;
          });
          els.monsterList
            ?.querySelectorAll("details.entity-disclosure")
            .forEach((d) => {
              d.open = false;
            });
        } else if (selectedTowerId === t.id) {
          selectedTowerId = null;
        }
        saveUiChromeState();
      });

      body.addEventListener("input", (e) => {
        const path = e.target.getAttribute("data-path");
        if (!path) return;
        applyTowerPath(t, path, e.target);
        const meta = details.querySelector('[data-role="tower-meta"]');
        if (meta) meta.textContent = towerMetaText(t);
        const nameEl = details.querySelector(":scope > summary .entity-disclosure__name");
        if (nameEl && path === "name") nameEl.textContent = t.name || "Tower";
        if (path === "upgrade_level" || path === "upgrade_of") {
          refreshUpgradeLevelCount(details, t);
        }
        markDirty();
      });
      body.addEventListener("change", (e) => {
        const path = e.target.getAttribute("data-path");
        if (!path) return;
        applyTowerPath(t, path, e.target);
        // Rebuild form when conditional sections change
        if (
          path === "weapon.type" ||
          path === "element.type" ||
          path === "upgrade_of"
        ) {
          if (path === "upgrade_of") {
            // Always keep a valid tier when linking (or clearing) an upgrade.
            if (!t.upgrade_of) t.upgrade_level = 1;
            else if (!(t.upgrade_level >= 1)) t.upgrade_level = 1;
          }
          selectedTowerId = t.id;
          renderTowers();
          markDirty();
          return;
        }
        if (path === "upgrade_level") {
          refreshUpgradeLevelCount(details, t);
        }
        const meta = details.querySelector('[data-role="tower-meta"]');
        if (meta) meta.textContent = towerMetaText(t);
        markDirty();
      });
      body.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action='remove-tower']");
        if (!btn) return;
        if (doc.towers.length <= 1) return;
        const removedId = t.id;
        doc.towers = doc.towers.filter((x) => x.id !== removedId);
        // Clear upgrade_of pointing at removed tower
        doc.towers.forEach((x) => {
          if (x.upgrade_of === removedId) {
            x.upgrade_of = "";
            x.upgrade_level = 1;
          }
        });
        if (selectedTowerId === removedId) selectedTowerId = null;
        renderTowers();
        markDirty();
      });

      els.towerList.appendChild(details);
    });
  }

  function refreshUpgradeLevelCount(detailsEl, tower) {
    const el = detailsEl.querySelector('[data-role="upgrade-level-count"]');
    if (!el || !tower.upgrade_of) return;
    const n = countUpgradesAtLevel(tower.upgrade_of, tower.upgrade_level | 0 || 1);
    el.innerHTML =
      `<strong>${n}</strong> tower${n === 1 ? "" : "s"} selectable at this upgrade level` +
      (n > 1
        ? " (player chooses one when upgrading)."
        : n === 1
          ? " (single path — simple confirm in play)."
          : ".");
  }

  function getByPath(obj, path) {
    if (!path) return obj;
    const parts = path.split(".");
    let cur = obj;
    for (const part of parts) {
      if (cur == null) return null;
      cur = cur[part];
    }
    return cur;
  }

  function setByPath(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] == null || typeof cur[p] !== "object") {
        cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function applyTowerPath(tower, path, inputEl) {
    ensureTowerShape(tower);
    let value = inputEl.value;
    if (inputEl.tagName === "SELECT") {
      value = inputEl.value;
    } else if (inputEl.type === "number") {
      value =
        path.includes("cooldown") ||
        path.includes("fire_rate") ||
        path.includes("burst") ||
        path.includes("spread") ||
        path.includes("duration") ||
        path.includes("tick") ||
        path.includes("slow") ||
        path.includes("aoe")
          ? parseFloat(value)
          : parseInt(value, 10);
      if (!Number.isFinite(value)) value = 0;
    }
    if (path === "upgrade_level") {
      value = Math.max(1, parseInt(value, 10) || 1);
    }
    if (path === "hp") {
      value = Math.max(1, parseInt(value, 10) || 1);
    }
    setByPath(tower, path, value);
    if (path === "upgrade_of") {
      if (!value) tower.upgrade_level = 1;
      else if (!(tower.upgrade_level >= 1)) tower.upgrade_level = 1;
    }
    // Keep weapon/element objects intact
    if (path === "weapon.type") {
      ensureTowerShape(tower);
      if (value === "machine_gun" && (tower.weapon.projectile_count || 1) < 2) {
        tower.weapon.projectile_count = 3;
      }
      if (value === "shotgun" && (tower.weapon.projectile_count || 1) < 2) {
        tower.weapon.projectile_count = 5;
      }
      if (value === "single" || value === "sniper") {
        tower.weapon.projectile_count = 1;
      }
      if (value === "sniper" && (tower.range || 0) < 8) {
        tower.range = 10;
      }
      if (value === "sniper" && (tower.cooldown || 0) < 1.5) {
        tower.cooldown = 2.5;
      }
    }
    if (path === "element.type") {
      ensureTowerShape(tower);
      if (value === "freeze") {
        tower.element.tick_damage = tower.element.tick_damage || 0;
      }
      if (value === "fire" && !(tower.element.tick_damage > 0)) {
        tower.element.tick_damage = 1;
      }
      if (value === "poison" && !(tower.element.tick_damage > 0)) {
        tower.element.tick_damage = 1;
      }
    }
  }

  function defaultWaveType() {
    const mid = (doc.monsters[0] && doc.monsters[0].id) || "";
    return {
      id: uid("wav"),
      name: "Default wave",
      rounds: "1-" + (limits.max_rounds || 100),
      groups: [{ monster_id: mid, count: 5 }],
      scaling: [
        {
          stat: "hp",
          basis: "appearance",
          mode: "base_times_n",
          factor: 1,
        },
      ],
    };
  }

  function ensureWaveTypes() {
    if (!Array.isArray(doc.wave_types) || !doc.wave_types.length) {
      doc.wave_types = [defaultWaveType()];
    }
  }

  function scalingLabel(s) {
    const stat = s.stat === "reward" ? "score" : s.stat;
    const basis = s.basis === "round" ? "round #" : "appearance #";
    if (s.mode === "base_times_n") {
      return stat + " = base × " + basis;
    }
    if (s.mode === "base_plus_n_times_factor") {
      return stat + " = base + (" + basis + " − 1) × " + (s.factor || 1);
    }
    return stat + " = base × (1 + (" + basis + " − 1) × " + (s.factor || 1) + ")";
  }

  function renderWaveTypes() {
    ensureWaveTypes();
    if (!els.waveTypeList) return;
    els.waveTypeList.innerHTML = "";
    if (els.waveTypeCount) {
      els.waveTypeCount.textContent = String(doc.wave_types.length);
    }
    const monsterOpts = doc.monsters.map((m) => [
      m.id,
      m.name || m.id,
    ]);

    doc.wave_types.forEach((wt) => {
      if (!Array.isArray(wt.groups)) wt.groups = [];
      if (!Array.isArray(wt.scaling)) wt.scaling = [];

      const details = document.createElement("details");
      details.className = "entity-disclosure palette-tree";
      details.dataset.waveTypeId = wt.id;
      if (wt.id === selectedWaveTypeId) details.open = true;

      const summary = document.createElement("summary");
      const groupSummary = (wt.groups || [])
        .map((g) => {
          const m = doc.monsters.find((x) => x.id === g.monster_id);
          return (g.count | 0) + "× " + (m ? m.name : "?");
        })
        .join(", ");
      summary.innerHTML =
        CHEVRON_SVG +
        `<span class="entity-disclosure__name">${escapeHtml(wt.name || "Wave")}</span>` +
        `<span class="entity-disclosure__meta">${escapeHtml(wt.rounds || "?")} · ${escapeHtml(groupSummary || "empty")}</span>`;
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "entity-disclosure__body";

      let html = "";
      html += `<label class="form-control w-full"><span class="label-text text-[10px]">Name</span>`;
      html += `<input type="text" class="input input-xs input-bordered w-full" data-wf="name" value="${escapeAttr(wt.name || "")}"></label>`;

      html += `<label class="form-control w-full"><span class="label-text text-[10px]">Rounds (e.g. 1, 3, 5, 10-15)</span>`;
      html += `<input type="text" class="input input-xs input-bordered w-full" data-wf="rounds" value="${escapeAttr(wt.rounds || "1")}" placeholder="1, 3, 5, 10-15"></label>`;
      html += `<p class="text-[10px] opacity-55 leading-snug">Which <strong>game rounds</strong> use this type. A range like <code>10-15</code> ends at 15 (end of that schedule). Open <code>20-</code> runs to your max rounds (${limits.max_rounds || 100}). Game ends after the last scheduled round.</p>`;

      // Monster groups
      html += `<div class="rounded-md border border-base-300 p-2 space-y-1.5 bg-base-100">`;
      html += `<div class="flex items-center justify-between"><p class="text-[10px] font-semibold uppercase tracking-wide opacity-60 m-0">Monsters in this wave</p>`;
      html += `<button type="button" class="btn btn-ghost btn-xs" data-wf-action="add-group">+ Group</button></div>`;
      (wt.groups || []).forEach((g, gi) => {
        html += `<div class="flex flex-wrap gap-1 items-end" data-group-index="${gi}">`;
        html += `<label class="form-control flex-1 min-w-[6rem]"><span class="label-text text-[10px]">Monster</span>`;
        html += `<select class="select select-xs select-bordered w-full" data-wf="group-monster" data-gi="${gi}">`;
        monsterOpts.forEach(([id, name]) => {
          html += `<option value="${escapeAttr(id)}"${id === g.monster_id ? " selected" : ""}>${escapeHtml(name)}</option>`;
        });
        html += `</select></label>`;
        html += `<label class="form-control w-16"><span class="label-text text-[10px]">Count</span>`;
        html += `<input type="number" min="1" class="input input-xs input-bordered w-full" data-wf="group-count" data-gi="${gi}" value="${g.count | 0 || 1}"></label>`;
        html += `<button type="button" class="btn btn-ghost btn-xs" data-wf-action="remove-group" data-gi="${gi}" title="Remove group">×</button>`;
        html += `</div>`;
      });
      if (!(wt.groups || []).length) {
        html += `<p class="text-[10px] opacity-50">No monsters — add a group.</p>`;
      }
      html += `</div>`;

      // Scaling
      html += `<div class="rounded-md border border-base-300 p-2 space-y-1.5 bg-base-100">`;
      html += `<div class="flex items-center justify-between"><p class="text-[10px] font-semibold uppercase tracking-wide opacity-60 m-0">Scaling for later appearances</p>`;
      html += `<button type="button" class="btn btn-ghost btn-xs" data-wf-action="add-scale">+ Rule</button></div>`;
      html += `<p class="text-[10px] opacity-55 leading-snug m-0">Appearance # = how many times <em>this wave type</em> has run (1st, 2nd, 3rd…). Round # = overall game round.</p>`;
      (wt.scaling || []).forEach((s, si) => {
        html += `<div class="space-y-1 p-1.5 rounded border border-base-300" data-scale-index="${si}">`;
        html += `<div class="grid grid-cols-2 gap-1">`;
        html += `<label class="form-control"><span class="label-text text-[10px]">Stat</span>`;
        html += selectHtml("", s.stat || "hp", [
          ["hp", "Health"],
          ["speed", "Speed"],
          ["reward", "Score"],
        ]).replace('data-path=""', `data-wf="scale-stat" data-si="${si}"`);
        html += `</label>`;
        html += `<label class="form-control"><span class="label-text text-[10px]">Based on</span>`;
        html += selectHtml("", s.basis || "appearance", [
          ["appearance", "Appearance # (this type)"],
          ["round", "Round # (global)"],
        ]).replace('data-path=""', `data-wf="scale-basis" data-si="${si}"`);
        html += `</label>`;
        html += `<label class="form-control col-span-2"><span class="label-text text-[10px]">Rule</span>`;
        html += selectHtml("", s.mode || "base_times_n", [
          ["base_times_n", "base × N"],
          ["base_plus_n_times_factor", "base + (N−1) × factor"],
          ["base_times_one_plus_n_minus_one_times_factor", "base × (1 + (N−1) × factor)"],
        ]).replace('data-path=""', `data-wf="scale-mode" data-si="${si}"`);
        html += `</label>`;
        html += pathField("Factor", "factor", s.factor ?? 1, "number", 0, 0.05)
          .replace('data-path="factor"', `data-wf="scale-factor" data-si="${si}"`);
        html += `</div>`;
        html += `<div class="flex items-center justify-between gap-1">`;
        html += `<span class="text-[10px] opacity-60">${escapeHtml(scalingLabel(s))}</span>`;
        html += `<button type="button" class="btn btn-ghost btn-xs" data-wf-action="remove-scale" data-si="${si}">Remove</button>`;
        html += `</div></div>`;
      });
      if (!(wt.scaling || []).length) {
        html += `<p class="text-[10px] opacity-50">No scaling — monsters use base stats every time.</p>`;
      }
      html += `</div>`;

      html += `<button type="button" class="btn btn-xs btn-error btn-outline btn-block" data-wf-action="remove-wave">Remove wave type</button>`;
      body.innerHTML = html;
      details.appendChild(body);

      details.addEventListener("toggle", () => {
        if (details.open) {
          selectedWaveTypeId = wt.id;
          els.waveTypeList
            .querySelectorAll(":scope > details.entity-disclosure")
            .forEach((d) => {
              if (d !== details) d.open = false;
            });
        } else if (selectedWaveTypeId === wt.id) {
          selectedWaveTypeId = null;
        }
        saveUiChromeState();
      });

      body.addEventListener("input", (e) => {
        const wf = e.target.getAttribute("data-wf");
        if (!wf) return;
        applyWaveField(wt, wf, e.target);
        const meta = details.querySelector(".entity-disclosure__meta");
        const nameEl = details.querySelector(
          ":scope > summary .entity-disclosure__name"
        );
        if (nameEl && wf === "name") nameEl.textContent = wt.name || "Wave";
        if (meta) {
          const gs = (wt.groups || [])
            .map((g) => {
              const m = doc.monsters.find((x) => x.id === g.monster_id);
              return (g.count | 0) + "× " + (m ? m.name : "?");
            })
            .join(", ");
          meta.textContent = (wt.rounds || "?") + " · " + (gs || "empty");
        }
        markDirty();
      });
      body.addEventListener("change", (e) => {
        const wf = e.target.getAttribute("data-wf");
        if (!wf) return;
        applyWaveField(wt, wf, e.target);
        markDirty();
      });
      body.addEventListener("click", (e) => {
        const act = e.target.closest("[data-wf-action]");
        if (!act) return;
        const action = act.getAttribute("data-wf-action");
        if (action === "add-group") {
          const mid = (doc.monsters[0] && doc.monsters[0].id) || "";
          wt.groups.push({ monster_id: mid, count: 5 });
          selectedWaveTypeId = wt.id;
          renderWaveTypes();
          markDirty();
        } else if (action === "remove-group") {
          const gi = parseInt(act.getAttribute("data-gi"), 10);
          wt.groups.splice(gi, 1);
          selectedWaveTypeId = wt.id;
          renderWaveTypes();
          markDirty();
        } else if (action === "add-scale") {
          wt.scaling.push({
            stat: "hp",
            basis: "appearance",
            mode: "base_times_n",
            factor: 1,
          });
          selectedWaveTypeId = wt.id;
          renderWaveTypes();
          markDirty();
        } else if (action === "remove-scale") {
          const si = parseInt(act.getAttribute("data-si"), 10);
          wt.scaling.splice(si, 1);
          selectedWaveTypeId = wt.id;
          renderWaveTypes();
          markDirty();
        } else if (action === "remove-wave") {
          if (doc.wave_types.length <= 1) return;
          doc.wave_types = doc.wave_types.filter((x) => x.id !== wt.id);
          if (selectedWaveTypeId === wt.id) selectedWaveTypeId = null;
          renderWaveTypes();
          markDirty();
        }
      });

      els.waveTypeList.appendChild(details);
    });
  }

  function applyWaveField(wt, wf, el) {
    if (wf === "name") wt.name = el.value || wt.name;
    else if (wf === "rounds") wt.rounds = el.value || "1-";
    else if (wf === "group-monster") {
      const gi = parseInt(el.getAttribute("data-gi"), 10);
      if (wt.groups[gi]) wt.groups[gi].monster_id = el.value;
    } else if (wf === "group-count") {
      const gi = parseInt(el.getAttribute("data-gi"), 10);
      if (wt.groups[gi]) {
        wt.groups[gi].count = Math.max(1, parseInt(el.value, 10) || 1);
      }
    } else if (wf === "scale-stat") {
      const si = parseInt(el.getAttribute("data-si"), 10);
      if (wt.scaling[si]) wt.scaling[si].stat = el.value;
    } else if (wf === "scale-basis") {
      const si = parseInt(el.getAttribute("data-si"), 10);
      if (wt.scaling[si]) wt.scaling[si].basis = el.value;
    } else if (wf === "scale-mode") {
      const si = parseInt(el.getAttribute("data-si"), 10);
      if (wt.scaling[si]) wt.scaling[si].mode = el.value;
    } else if (wf === "scale-factor") {
      const si = parseInt(el.getAttribute("data-si"), 10);
      if (wt.scaling[si]) {
        wt.scaling[si].factor = parseFloat(el.value) || 0;
      }
    }
  }

  function renderMonsters() {
    if (!els.monsterList) return;
    els.monsterList.innerHTML = "";
    els.monsterCount.textContent = String(doc.monsters.length);
    doc.monsters.forEach((m) => {
      const details = document.createElement("details");
      details.className = "entity-disclosure palette-tree";
      details.dataset.monsterId = m.id;
      if (m.id === selectedMonsterId) details.open = true;

      const summary = document.createElement("summary");
      summary.innerHTML =
        CHEVRON_SVG +
        `<span class="entity-disclosure__name">${escapeHtml(m.name || "Monster")}</span>` +
        `<span class="entity-disclosure__meta" data-role="monster-meta">${m.hp | 0} hp · ${m.reward | 0} pts</span>`;
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "entity-disclosure__body";
      body.innerHTML =
        `<label class="form-control w-full">` +
        `<span class="label-text text-[10px]">Name</span>` +
        `<input type="text" class="input input-xs input-bordered w-full" data-field="name" value="${escapeAttr(m.name || "")}">` +
        `</label>` +
        `<div class="grid grid-cols-2 gap-1">` +
        fieldHtml("HP", "hp", m.hp ?? 1, "number", 1) +
        fieldHtml("Speed", "speed", m.speed ?? 1, "number", 0.1, 0.1) +
        fieldHtml("Score", "reward", m.reward ?? 0, "number", 0) +
        `</div>` +
        `<label class="form-control w-full">` +
        `<span class="label-text text-[10px]">Description</span>` +
        `<textarea class="textarea textarea-xs textarea-bordered w-full" rows="2" data-field="description">${escapeHtml(m.description || "")}</textarea>` +
        `</label>` +
        `<button type="button" class="btn btn-xs btn-error btn-outline btn-block" data-action="remove-monster" title="Remove this monster type from the game">Remove monster type</button>`;
      details.appendChild(body);

      details.addEventListener("toggle", () => {
        if (details.open) {
          selectedMonsterId = m.id;
          selectedTowerId = null;
          selectedPortal = null;
          els.monsterList.querySelectorAll("details.entity-disclosure").forEach((d) => {
            if (d !== details) d.open = false;
          });
          els.towerList
            ?.querySelectorAll("details.entity-disclosure")
            .forEach((d) => {
              d.open = false;
            });
        } else if (selectedMonsterId === m.id) {
          selectedMonsterId = null;
        }
        saveUiChromeState();
      });

      body.addEventListener("input", (e) => {
        const field = e.target.getAttribute("data-field");
        if (!field) return;
        applyMonsterField(m.id, field, e.target);
      });
      body.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action='remove-monster']");
        if (!btn) return;
        if (doc.monsters.length <= 1) return;
        doc.monsters = doc.monsters.filter((x) => x.id !== m.id);
        if (selectedMonsterId === m.id) selectedMonsterId = null;
        renderMonsters();
        markDirty();
      });

      els.monsterList.appendChild(details);
    });
  }

  function fieldHtml(label, field, value, type, min, step) {
    return (
      `<label class="form-control">` +
      `<span class="label-text text-[10px]">${escapeHtml(label)}</span>` +
      `<input type="${type}" class="input input-xs input-bordered" data-field="${field}"` +
      (min != null ? ` min="${min}"` : "") +
      (step != null ? ` step="${step}"` : "") +
      ` value="${escapeAttr(String(value))}">` +
      `</label>`
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function applyMonsterField(monsterId, field, inputEl) {
    const m = doc.monsters.find((x) => x.id === monsterId);
    if (!m) return;
    if (field === "name") m.name = inputEl.value || m.name;
    else if (field === "description") m.description = inputEl.value || "";
    else if (field === "speed") m.speed = parseFloat(inputEl.value) || 1;
    else if (field === "hp") m.hp = parseInt(inputEl.value, 10) || 1;
    else if (field === "reward") m.reward = parseInt(inputEl.value, 10) || 0;

    const root = els.monsterList.querySelector(
      `[data-monster-id="${CSS.escape(monsterId)}"]`
    );
    if (root) {
      const nameEl = root.querySelector(".entity-disclosure__name");
      const metaEl = root.querySelector('[data-role="monster-meta"]');
      if (nameEl) nameEl.textContent = m.name || "Monster";
      if (metaEl) metaEl.textContent = `${m.hp | 0} hp · ${m.reward | 0} pts`;
    }
    markDirty();
  }

  function readGameTypeFromForm() {
    const checked = document.querySelector('input[name="game-type"]:checked');
    return checked ? checked.value : "monster_march";
  }

  function syncDocFromForm() {
    doc.title = (els.title.value || "Untitled game").trim().slice(0, 120);
    doc.settings.allow_ground_build = !!els.groundBuild.checked;
    doc.settings.starting_lives = parseInt(els.lives.value, 10) || 20;
    doc.settings.starting_gold = parseInt(els.gold.value, 10) || 0;
    doc.settings.game_type = readGameTypeFromForm();
    // Only persist chaos when the toggle is usable; otherwise keep prior doc value
    // unless the control is enabled and reflects user intent.
    if (els.chaosMode && !els.chaosMode.disabled) {
      doc.settings.chaos_mode = !!els.chaosMode.checked;
    }
    const startDelay = document.getElementById("set-start-delay");
    const waveDelay = document.getElementById("set-wave-delay");
    if (startDelay) {
      doc.settings.start_delay_seconds = Math.max(
        0,
        Math.min(120, parseInt(startDelay.value, 10) || 0)
      );
    }
    if (waveDelay) {
      doc.settings.between_waves_delay_seconds = Math.max(
        0,
        Math.min(120, parseInt(waveDelay.value, 10) || 0)
      );
    }
    ensureScoreboard();
  }

  function scoreboardItems() {
    ensureScoreboard();
    return doc.scoreboard.items.slice();
  }

  function widgetLabel(id) {
    return (SCOREBOARD_WIDGETS.find((w) => w.id === id) || {}).label || id;
  }

  /**
   * Render the standard scoreboard strip from doc.scoreboard.items.
   * @param {HTMLElement|null} el
   * @param {object} values live values during play / preview placeholders
   */
  function renderScoreboardBar(el, values) {
    if (!el) return;
    const items = scoreboardItems();
    values = values || {};
    if (!items.length) {
      el.innerHTML =
        '<span class="game-info-bar__empty">No scoreboard widgets — open the Scoreboard tab to add some.</span>';
      return;
    }
    el.innerHTML = items
      .map((id) => {
        let val = "—";
        let extra = "";
        if (id === "score") {
          val = values.score != null ? values.score : 0;
          extra = " game-info-bar__stat--score";
        } else if (id === "lives") {
          val =
            values.lives != null
              ? values.lives
              : doc.settings.starting_lives ?? "—";
        } else if (id === "gold") {
          val =
            values.gold != null
              ? values.gold
              : doc.settings.starting_gold ?? "—";
        } else if (id === "wave") {
          val = values.wave != null ? values.wave : 0;
        } else if (id === "timer") {
          val =
            values.timer != null
              ? values.timer
              : playtestLocked
                ? "—"
                : doc.settings.start_delay_seconds ?? 15;
          extra = " game-info-bar__stat--timer";
        } else if (id === "mobs") {
          val = values.mobs != null ? values.mobs : 0;
        } else if (id === "title") {
          val = values.title != null ? values.title : doc.title || "Untitled";
        }
        return (
          `<span class="game-info-bar__stat${extra}" data-sb-id="${escapeAttr(id)}">` +
          `${escapeHtml(widgetLabel(id))}<strong>${escapeHtml(String(val))}</strong></span>`
        );
      })
      .join("");
  }

  function refreshGameInfoBarIdle() {
    if (playtestLocked) return;
    const values = {
      score: 0,
      lives: doc.settings.starting_lives,
      gold: doc.settings.starting_gold,
      wave: 0,
      timer: doc.settings.start_delay_seconds ?? 15,
      mobs: 0,
      title: doc.title,
    };
    renderScoreboardBar(document.getElementById("game-info-bar"), values);
    renderScoreboardBar(document.getElementById("game-info-bar-preview"), values);
  }

  function renderScoreboardEditor() {
    ensureScoreboard();
    const onBoard = document.getElementById("sb-on-board");
    const palette = document.getElementById("sb-palette");
    if (!onBoard || !palette) return;

    const items = scoreboardItems();
    if (!items.length) {
      onBoard.innerHTML =
        '<span class="sb-strip__empty">Empty — add widgets from the palette below.</span>';
    } else {
      onBoard.innerHTML = items
        .map((id, index) => {
          return (
            `<span class="sb-chip" data-sb-item="${escapeAttr(id)}">` +
            `<span>${escapeHtml(widgetLabel(id))}</span>` +
            `<button type="button" data-sb-move="up" data-index="${index}" title="Move left" ${index === 0 ? "disabled" : ""}>‹</button>` +
            `<button type="button" data-sb-move="down" data-index="${index}" title="Move right" ${index === items.length - 1 ? "disabled" : ""}>›</button>` +
            `<button type="button" data-sb-remove="${escapeAttr(id)}" title="Remove">×</button>` +
            `</span>`
          );
        })
        .join("");
    }

    palette.innerHTML = SCOREBOARD_WIDGETS.map((w) => {
      const on = items.includes(w.id);
      return (
        `<button type="button" class="sb-palette__btn" data-sb-add="${escapeAttr(w.id)}" ` +
        `title="${escapeAttr(w.hint)}" ${on ? "disabled" : ""}>` +
        `${on ? "✓ " : "+ "}${escapeHtml(w.label)}` +
        `</button>`
      );
    }).join("");

    refreshGameInfoBarIdle();
  }

  function setStageTab(tab) {
    const playfield = document.getElementById("stage-panel-playfield");
    const scoreboard = document.getElementById("stage-panel-scoreboard");
    const stage = document.querySelector(".editor-stage");
    document.querySelectorAll(".stage-tab").forEach((btn) => {
      const on = btn.getAttribute("data-stage-tab") === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (playfield) {
      playfield.classList.toggle("is-active", tab === "playfield");
      playfield.hidden = tab !== "playfield";
    }
    if (scoreboard) {
      scoreboard.classList.toggle("is-active", tab === "scoreboard");
      scoreboard.hidden = tab !== "scoreboard";
    }
    if (stage) {
      stage.classList.toggle("is-scoreboard-tab", tab === "scoreboard");
    }
    if (tab === "scoreboard") {
      renderScoreboardEditor();
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || "Request failed (" + res.status + ")");
    }
    return data;
  }

  async function autosaveDraft() {
    syncDocFromForm();
    setStatus("Saving…");
    try {
      await postJson(draftUrl, { definition: doc });
      dirty = false;
      setStatus("Draft saved", "ok");
    } catch (err) {
      setStatus(err.message || "Save failed", "error");
    }
  }

  function publishingFlags() {
    const pub = document.getElementById("set-is-public");
    const dl = document.getElementById("set-allow-download");
    return {
      is_public: !!(pub && pub.checked),
      allow_download: !!(dl && dl.checked),
    };
  }

  async function saveOwnedOrNew() {
    syncDocFromForm();
    setStatus("Saving…");
    try {
      const flags = publishingFlags();
      if (gameSaveUrl) {
        await postJson(gameSaveUrl, {
          definition: doc,
          is_public: flags.is_public,
          allow_download: flags.allow_download,
        });
        setStatus("Game saved", "ok");
      } else if (isAuth && gameCreateUrl) {
        const data = await postJson(gameCreateUrl, {
          definition: doc,
          is_public: flags.is_public,
          allow_download: flags.allow_download,
        });
        setStatus("Saved", "ok");
        if (data.game_id) {
          window.location.href = "/editor/?game=" + data.game_id;
        }
      } else {
        await autosaveDraft();
      }
      dirty = false;
    } catch (err) {
      setStatus(err.message || "Save failed", "error");
    }
  }

  async function stashAndSignup() {
    syncDocFromForm();
    setStatus("Stashing…");
    try {
      const data = await postJson(stashUrl, {
        definition: doc,
        lock_for_signup: true,
      });
      window.location.href = data.redirect || "/accounts/signup/";
    } catch (err) {
      try {
        await postJson(draftUrl, { definition: doc, lock_for_signup: true });
      } catch (_) {}
      window.location.href = "/accounts/signup/";
    }
  }

  // ── Events ────────────────────────────────────────────────

  function setActiveTool(nextTool, activeBtn) {
    tool = nextTool;
    document.querySelectorAll(".paint-swatch, .tool-btn").forEach((b) => {
      const on = b === activeBtn || b.dataset.tool === nextTool;
      b.classList.toggle("is-active", on);
      if (b.hasAttribute("aria-pressed") || b.classList.contains("paint-swatch")) {
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
  }

  document.querySelectorAll(".paint-swatch, .tool-btn").forEach((btn) => {
    // pointerdown so the active border/background shows immediately on press
    btn.addEventListener("pointerdown", (e) => {
      // Left button / primary pointer only
      if (e.button != null && e.button !== 0) return;
      setActiveTool(btn.dataset.tool, btn);
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      setActiveTool(btn.dataset.tool, btn);
    });
  });

  els.grid.addEventListener("pointerdown", (e) => {
    if (playtestLocked) return;
    const cell = e.target.closest(".editor-cell");
    if (!cell) return;
    if (e.button != null && e.button !== 0) return;
    const x = +cell.dataset.x;
    const y = +cell.dataset.y;
    const kind = doc.grid[y][x];

    // Shift+click a spawn/exit to select it (edit id / exit target) without painting.
    if ((kind === "spawn" || kind === "exit") && e.shiftKey) {
      const p = kind === "spawn" ? findSpawnAt(x, y) : findExitAt(x, y);
      if (p) {
        selectPortal(kind, p.id);
        return;
      }
    }

    // Same type as palette → erase stroke; otherwise paint stroke.
    strokeAction =
      tool !== "ground" && kind === tool ? "erase" : "paint";
    painting = true;
    els.grid.setPointerCapture?.(e.pointerId);
    paintCell(x, y, strokeAction);
  });
  els.grid.addEventListener("pointermove", (e) => {
    if (!painting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest ? el.closest(".editor-cell") : null;
    if (cell && els.grid.contains(cell)) {
      paintCell(+cell.dataset.x, +cell.dataset.y, strokeAction || "paint");
    }
  });
  window.addEventListener("pointerup", () => {
    painting = false;
    strokeAction = null;
  });

  els.title.addEventListener("input", markDirty);
  els.groundBuild.addEventListener("change", () => {
    doc.settings.allow_ground_build = !!els.groundBuild.checked;
    markDirty();
  });
  els.lives.addEventListener("change", () => {
    markDirty();
    refreshGameInfoBarIdle();
  });
  els.lives.addEventListener("input", refreshGameInfoBarIdle);
  els.gold.addEventListener("change", () => {
    markDirty();
    refreshGameInfoBarIdle();
  });
  els.gold.addEventListener("input", refreshGameInfoBarIdle);
  els.chaosMode?.addEventListener("change", () => {
    if (els.chaosMode.disabled) return;
    doc.settings.chaos_mode = !!els.chaosMode.checked;
    markDirty();
  });
  document.querySelectorAll('input[name="game-type"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      doc.settings.game_type = readGameTypeFromForm();
      updateGameTypeUi();
      markDirty();
    });
  });
  // Ground-build and economy affect playability immediately.
  els.groundBuild?.addEventListener("change", () => updatePlayButtonPlayability());
  els.lives?.addEventListener("change", () => updatePlayButtonPlayability());
  els.gold?.addEventListener("change", () => updatePlayButtonPlayability());

  function onDimChange() {
    const w = parseInt(els.width.value, 10);
    const h = parseInt(els.height.value, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    resizeGrid(w, h);
  }
  els.width.addEventListener("change", () => {
    onDimChange();
    updateLimitsBanner();
  });
  els.height.addEventListener("change", () => {
    onDimChange();
    updateLimitsBanner();
  });

  els.spawnExitAny?.addEventListener("change", () => {
    if (els.spawnExitId) els.spawnExitId.disabled = true;
  });
  els.spawnExitSpecific?.addEventListener("change", () => {
    if (els.spawnExitId) els.spawnExitId.disabled = false;
    populateExitSelect(
      doc.spawns.find((s) => s.id === selectedPortal?.id)?.exit_id || ""
    );
  });
  // Live-edit portals (no Apply button).
  ["portal-id", "spawn-exit-any", "spawn-exit-specific", "spawn-exit-id"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.type === "text" || el.tagName === "SELECT" ? "input" : "change";
      el.addEventListener(evt === "input" && el.type !== "text" ? "change" : evt, () => {
        if (id === "spawn-exit-any" || id === "spawn-exit-specific") {
          if (els.spawnExitId) {
            els.spawnExitId.disabled = !els.spawnExitSpecific?.checked;
          }
        }
        applyPortalEdits();
      });
    }
  );

  function updateLimitsBanner() {
    const el = document.getElementById("limits-banner");
    if (!el) return;
    const tw = (doc.towers || []).length;
    const mo = (doc.monsters || []).length;
    const wv = (doc.wave_types || []).length;
    const tier =
      limits.tier === "registered" ? "registered" : "guest";
    const maxR = limits.max_rounds || 100;
    el.textContent =
      "Limits (" +
      tier +
      "): towers " +
      tw +
      "/" +
      limits.max_towers +
      " · monsters " +
      mo +
      "/" +
      limits.max_monsters +
      " · waves " +
      wv +
      "/" +
      limits.max_wave_types +
      " · rounds ≤" +
      maxR +
      " · games " +
      limits.max_games;
  }

  document.getElementById("btn-add-tower")?.addEventListener("click", () => {
    if ((doc.towers || []).length >= limits.max_towers) {
      setStatus("Tower type limit reached (" + limits.max_towers + ").");
      return;
    }
    const t = ensureTowerShape({
      id: uid("twr"),
      name: "New tower",
      cost: 50,
      damage: 5,
      range: 3,
      hp: 50,
      cooldown: 1,
      description: "",
      weapon: defaultWeapon(),
      element: defaultElement(),
      upgrade_of: "",
      upgrade_level: 1,
    });
    doc.towers.push(t);
    selectedTowerId = t.id;
    selectedMonsterId = null;
    selectedPortal = null;
    renderTowers();
    renderMonsters();
    updateLimitsBanner();
    markDirty();
  });

  document.getElementById("btn-add-monster")?.addEventListener("click", () => {
    if ((doc.monsters || []).length >= limits.max_monsters) {
      setStatus("Monster type limit reached (" + limits.max_monsters + ").");
      return;
    }
    const m = {
      id: uid("mob"),
      name: "New monster",
      hp: 20,
      speed: 1,
      reward: 10,
      description: "",
    };
    doc.monsters.push(m);
    selectedMonsterId = m.id;
    selectedTowerId = null;
    selectedPortal = null;
    renderMonsters();
    renderTowers();
    renderWaveTypes();
    updateLimitsBanner();
    markDirty();
  });

  document.getElementById("btn-add-wave-type")?.addEventListener("click", () => {
    ensureWaveTypes();
    if ((doc.wave_types || []).length >= limits.max_wave_types) {
      setStatus("Wave type limit reached (" + limits.max_wave_types + ").");
      return;
    }
    const wt = defaultWaveType();
    wt.name = "Wave type " + (doc.wave_types.length + 1);
    doc.wave_types.push(wt);
    selectedWaveTypeId = wt.id;
    renderWaveTypes();
    updateLimitsBanner();
    markDirty();
  });

  // Stage tabs: Playfield | Scoreboard
  document.querySelectorAll(".stage-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      setStageTab(btn.getAttribute("data-stage-tab") || "playfield");
    });
  });

  document.getElementById("sb-on-board")?.addEventListener("click", (e) => {
    const remove = e.target.closest("[data-sb-remove]");
    if (remove) {
      const id = remove.getAttribute("data-sb-remove");
      ensureScoreboard();
      doc.scoreboard.items = doc.scoreboard.items.filter((x) => x !== id);
      renderScoreboardEditor();
      markDirty();
      return;
    }
    const move = e.target.closest("[data-sb-move]");
    if (move) {
      const dir = move.getAttribute("data-sb-move");
      const index = parseInt(move.getAttribute("data-index"), 10);
      ensureScoreboard();
      const items = doc.scoreboard.items;
      const j = dir === "up" ? index - 1 : index + 1;
      if (j < 0 || j >= items.length) return;
      const tmp = items[index];
      items[index] = items[j];
      items[j] = tmp;
      renderScoreboardEditor();
      markDirty();
    }
  });

  document.getElementById("sb-palette")?.addEventListener("click", (e) => {
    const add = e.target.closest("[data-sb-add]");
    if (!add || add.disabled) return;
    const id = add.getAttribute("data-sb-add");
    ensureScoreboard();
    if (!doc.scoreboard.items.includes(id)) {
      doc.scoreboard.items.push(id);
      renderScoreboardEditor();
      markDirty();
    }
  });

  document.getElementById("set-start-delay")?.addEventListener("change", () => {
    syncDocFromForm();
    refreshGameInfoBarIdle();
    markDirty();
  });
  document.getElementById("set-wave-delay")?.addEventListener("change", () => {
    syncDocFromForm();
    markDirty();
  });

  document.getElementById("btn-save-game")?.addEventListener("click", () => {
    saveOwnedOrNew();
  });
  document.getElementById("btn-save-new")?.addEventListener("click", () => {
    saveOwnedOrNew();
  });

  // Header nav “Sign up to save” — stash draft before leaving the editor.
  document.getElementById("nav-signup-save")?.addEventListener("click", (e) => {
    if (!isGuest) return;
    e.preventDefault();
    stashAndSignup();
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  window.addEventListener("resize", () => {
    const size = cellSize();
    els.grid.style.setProperty("--cell", size + "px");
  });

  // Normalize tower shapes for older drafts
  doc.towers.forEach(ensureTowerShape);
  ensureWaveTypes();

  // Init: rebuild portal metadata if grid has spawn/exit but lists are empty
  // (server normalize should handle this; still heal client-side).
  (function healPortals() {
    const h = doc.grid.length;
    const w = doc.grid[0] ? doc.grid[0].length : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const kind = doc.grid[y][x];
        if (kind === "spawn" && !findSpawnAt(x, y)) addSpawn(x, y);
        if (kind === "exit" && !findExitAt(x, y)) addExit(x, y);
      }
    }
    prunePortalsOutsideGrid();
  })();

  // Restore which palette sections (and nested entities) were open last time.
  initPaletteDisclosurePersist();

  renderGrid();
  renderPortals();
  renderTowers();
  renderMonsters();
  renderWaveTypes();
  updateLimitsBanner();
  updateGameTypeUi();
  if (isGuest) {
    setTimeout(() => autosaveDraft(), 400);
  }

  // Playtest runtime (bottom bar)
  if (window.OpenTDPlaytest) {
    window.OpenTDPlaytest.init({
      getDocument: function () {
        syncDocFromForm();
        return doc;
      },
      onModeChange: function (active) {
        playtestLocked = !!active;
        if (active) {
          painting = false;
          setStatus("Playtesting…");
        } else {
          // Refresh grid visuals (walls may have been destroyed in sim only —
          // sim mutates overlay cells; restore from doc on stop).
          renderGrid();
          refreshGameInfoBarIdle();
          setStatus(dirty ? "Unsaved…" : "Ready");
        }
      },
    });
  }

  refreshGameInfoBarIdle();

  window.OpenTDEditor = {
    getDocument: function () {
      syncDocFromForm();
      return doc;
    },
    refreshPlayability: updatePlayButtonPlayability,
    renderScoreboardBar: renderScoreboardBar,
    scoreboardItems: scoreboardItems,
    widgetLabel: widgetLabel,
  };
})();
