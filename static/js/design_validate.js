/**
 * Design-time checks for winnable / runnable tower-defense maps.
 */
(function () {
  "use strict";

  const DIRS4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  function key(x, y) {
    return x + "," + y;
  }

  function inBounds(grid, x, y) {
    return y >= 0 && x >= 0 && y < grid.length && x < (grid[0] ? grid[0].length : 0);
  }

  function countCells(grid, kind) {
    let n = 0;
    if (!grid) return 0;
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        if (grid[y][x] === kind) n++;
      }
    }
    return n;
  }

  function marchWalkable(grid, x, y) {
    if (!inBounds(grid, x, y)) return false;
    const k = grid[y][x];
    return k === "path" || k === "spawn" || k === "exit";
  }

  /** BFS whether any goal is reachable from (sx,sy) on march walkable cells. */
  function canReach(grid, sx, sy, goals) {
    const goalSet = new Set(goals.map((g) => key(g.x, g.y)));
    if (goalSet.has(key(sx, sy))) return true;
    const seen = new Set([key(sx, sy)]);
    const q = [[sx, sy]];
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx;
        const ny = y + dy;
        const nk = key(nx, ny);
        if (seen.has(nk)) continue;
        if (!marchWalkable(grid, nx, ny)) continue;
        if (goalSet.has(nk)) return true;
        seen.add(nk);
        q.push([nx, ny]);
      }
    }
    return false;
  }

  /**
   * @returns {{
   *   ok: boolean,
   *   canPlay: boolean,
   *   issues: Array<{severity: 'error'|'warning', code: string, message: string}>,
   *   summary: string
   * }}
   */
  function analyzeDesign(doc) {
    const issues = [];
    if (!doc || !doc.settings || !doc.grid) {
      return {
        ok: false,
        canPlay: false,
        issues: [
          {
            severity: "error",
            code: "invalid_doc",
            message: "Game document is missing or invalid.",
          },
        ],
        summary: "Invalid design.",
      };
    }

    const settings = doc.settings;
    const grid = doc.grid;
    const spawns = doc.spawns || [];
    const exits = doc.exits || [];
    const towers = doc.towers || [];
    const monsters = doc.monsters || [];
    const gt = settings.game_type || "monster_march";
    const allowGround = !!settings.allow_ground_build;
    const gold = settings.starting_gold | 0;
    const lives = settings.starting_lives | 0;

    const padCount = countCells(grid, "tower");
    const pathCount = countCells(grid, "path");

    // --- Required structure ---
    if (spawns.length < 1) {
      issues.push({
        severity: "warning",
        code: "no_spawn",
        message: "Add at least one Spawn. Monsters need an entry point.",
      });
    }
    if (exits.length < 1) {
      issues.push({
        severity: "error",
        code: "no_exit",
        message: "Add at least one Exit. Without it, waves have no goal.",
      });
    }

    // --- Content catalogs ---
    if (monsters.length < 1) {
      issues.push({
        severity: "error",
        code: "no_monsters",
        message: "Define at least one monster type or there is nothing to fight.",
      });
    }

    const waveTypes = doc.wave_types || [];
    if (waveTypes.length < 1) {
      issues.push({
        severity: "warning",
        code: "no_wave_types",
        message:
          "No wave types defined. Add a wave type under Waves so rounds know what to spawn.",
      });
    } else {
      const emptyGroups = waveTypes.filter(
        (w) => !w.groups || !w.groups.length
      );
      if (emptyGroups.length) {
        issues.push({
          severity: "warning",
          code: "empty_wave_groups",
          message:
            "Wave type “" +
            (emptyGroups[0].name || "unnamed") +
            "” has no monster groups.",
        });
      }
    }
    if (towers.length < 1) {
      issues.push({
        severity: "error",
        code: "no_tower_types",
        message:
          "Define at least one tower type. Without towers, players cannot deal damage.",
      });
    }

    // --- Placement eligibility ---
    const canPlaceTowers = padCount > 0 || allowGround;
    if (!canPlaceTowers) {
      issues.push({
        severity: "error",
        code: "cannot_place_towers",
        message:
          "Players cannot place towers: there are no tower pads and “Allow building on bare ground” is off. Loss is the only outcome.",
      });
    }

    // --- Affordability / damage ---
    if (towers.length) {
      const costs = towers.map((t) => (t.cost | 0) || 0);
      const minCost = Math.min.apply(null, costs);
      const maxDmg = Math.max.apply(
        null,
        towers.map((t) => (t.damage | 0) || 0)
      );

      if (canPlaceTowers && minCost > gold) {
        issues.push({
          severity: "error",
          code: "towers_unaffordable",
          message:
            "Starting gold (" +
            gold +
            ") is less than the cheapest tower (" +
            minCost +
            "g). Players cannot build anything at the start.",
        });
      } else if (canPlaceTowers && gold === 0 && minCost > 0) {
        issues.push({
          severity: "error",
          code: "zero_gold",
          message: "Starting gold is 0 and every tower costs gold — nothing can be built.",
        });
      }

      if (maxDmg <= 0) {
        issues.push({
          severity: "error",
          code: "no_damage",
          message:
            "Every tower has 0 damage. Monsters cannot be eliminated, so the player cannot win.",
        });
      }
    }

    if (lives < 1) {
      issues.push({
        severity: "error",
        code: "no_lives",
        message: "Starting lives must be at least 1.",
      });
    }

    // --- Mode-specific pathing ---
    if (gt === "monster_march" && spawns.length && exits.length) {
      if (pathCount < 1) {
        issues.push({
          severity: "error",
          code: "march_no_path_paint",
          message:
            "Monster March needs painted Path cells connecting spawns toward exits.",
        });
      }
      const goals = exits.map((e) => ({ x: e.x, y: e.y }));
      const unreachable = spawns.filter(
        (s) => !canReach(grid, s.x, s.y, goals)
      );
      if (unreachable.length) {
        issues.push({
          severity: "error",
          code: "march_unreachable",
          message:
            "No path from spawn “" +
            unreachable[0].id +
            "” to an exit (using path/spawn/exit cells only). Monsters cannot leave — or cannot be tested fairly.",
        });
      }
    }

    // Monster Rush + ground build is intentionally free-form: no tower pads is fine.
    // (Pads remain optional convenience, not a playability warning.)

    if (gt === "defend_the_castle") {
      issues.push({
        severity: "warning",
        code: "castle_not_modeled",
        message:
          "Defend the Castle: a dedicated castle objective is not fully modeled in playtest yet. Ensure spawns, exits, and towers still form a playable defense.",
      });
    }

    // Only pads, but none on grid when ground build off — already covered
    if (padCount > 0 && !allowGround) {
      // fine
    }

    // Win condition narrative summary
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    let summary;
    if (errors.length) {
      summary =
        errors.length +
        " design problem" +
        (errors.length === 1 ? "" : "s") +
        " block a fair playtest.";
    } else if (warnings.length) {
      summary =
        "Playable, with " +
        warnings.length +
        " warning" +
        (warnings.length === 1 ? "" : "s") +
        ".";
    } else {
      summary = "Design looks playable: spawns, exits, and a way to damage monsters.";
    }

    return {
      ok: errors.length === 0 && warnings.length === 0,
      canPlay: errors.length === 0,
      issues: issues,
      summary: summary,
      meta: {
        padCount: padCount,
        canPlaceTowers: canPlaceTowers,
        allowGround: allowGround,
        gameType: gt,
      },
    };
  }

  window.OpenTDDesignValidate = {
    analyzeDesign: analyzeDesign,
  };
})();
