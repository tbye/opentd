"""Default tower-defense game document and light validation helpers."""

from __future__ import annotations

import copy
import json
import re
import uuid
from typing import Any

from .limits import (
    GUEST_LIMITS,
    MAX_DOCUMENT_BYTES,
    MAX_ID_LEN,
    REGISTERED_LIMITS,
    TierLimits,
)
from .sanitize import clean_description, clean_id, clean_name, clean_title

# Cell kinds painted on the map grid.
CELL_GROUND = "ground"
CELL_PATH = "path"
CELL_TOWER = "tower"  # optional dedicated tower pad
CELL_BLOCKED = "blocked"  # never buildable scenery
CELL_SPAWN = "spawn"  # monster entry point
CELL_EXIT = "exit"  # monster goal

CELL_KINDS = frozenset(
    {
        CELL_GROUND,
        CELL_PATH,
        CELL_TOWER,
        CELL_BLOCKED,
        CELL_SPAWN,
        CELL_EXIT,
    }
)

# Spawn/exit public ids: letters, digits, underscore, hyphen (1–24 chars).
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")

EXIT_MODE_ANY = "any"
EXIT_MODE_SPECIFIC = "specific"
EXIT_MODES = frozenset({EXIT_MODE_ANY, EXIT_MODE_SPECIFIC})

# ---------------------------------------------------------------------------
# Game types (settings.game_type)
# ---------------------------------------------------------------------------
# monster_march — classic pathing: monsters follow painted path cells to an exit.
# monster_rush  — no fixed path required. Players place towers/walls (blocked).
#   If there is no open path spawn→exit, monsters attack walls/towers on the
#   shortest route. When a free path opens, they follow it and stop attacking
#   (unless chaos_mode is on).
# defend_the_castle — monsters try to destroy a central castle objective instead
#   of (or in addition to) reaching an exit, depending on play rules.
GAME_TYPE_MONSTER_MARCH = "monster_march"
GAME_TYPE_MONSTER_RUSH = "monster_rush"
GAME_TYPE_DEFEND_THE_CASTLE = "defend_the_castle"
GAME_TYPES = frozenset(
    {
        GAME_TYPE_MONSTER_MARCH,
        GAME_TYPE_MONSTER_RUSH,
        GAME_TYPE_DEFEND_THE_CASTLE,
    }
)
GAME_TYPE_LABELS = {
    GAME_TYPE_MONSTER_MARCH: "Monster March",
    GAME_TYPE_MONSTER_RUSH: "Monster Rush",
    GAME_TYPE_DEFEND_THE_CASTLE: "Defend the Castle",
}

SCHEMA_VERSION = 1

DEFAULT_WIDTH = 20
DEFAULT_HEIGHT = 12

# Standard scoreboard widgets (shared layout across all OpenTD games).
SCOREBOARD_WIDGET_IDS = (
    "score",
    "lives",
    "gold",
    "wave",
    "timer",
    "mobs",
    "title",
)
SCOREBOARD_WIDGET_LABELS = {
    "score": "Score",
    "lives": "Lives",
    "gold": "Gold",
    "wave": "Wave",
    "timer": "Countdown",
    "mobs": "Monsters left",
    "title": "Game title",
}
DEFAULT_SCOREBOARD_ITEMS = ["score", "lives", "gold", "wave", "timer"]


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


WEAPON_TYPES = frozenset({"single", "machine_gun", "shotgun", "sniper"})
ELEMENT_TYPES = frozenset({"none", "fire", "freeze", "poison"})
# Max upgrade tier a tower can target (level 1 = first upgrade from base purchase)
MAX_UPGRADE_LEVEL = 10


def default_weapon() -> dict[str, Any]:
    return {
        "type": "single",
        # Machine gun: shots in a burst; shotgun: pellets in a cone; sniper: single long-range
        "projectile_count": 1,
        # Seconds between successive projectiles in a machine-gun burst
        "burst_interval": 0.08,
        # Shotgun cone width in degrees
        "spread_degrees": 30.0,
    }


def default_element() -> dict[str, Any]:
    return {
        "type": "none",
        "duration": 2.0,
        "tick_rate": 0.5,
        # Fire/poison: damage per tick. Freeze: often 0 (slow only).
        "tick_damage": 1.0,
        # Freeze: speed multiplier while affected (0.5 = half speed)
        "slow_factor": 0.5,
        # Area of effect radius in cells (0 = single target)
        "aoe_radius": 0.0,
    }


def default_tower() -> dict[str, Any]:
    return {
        "id": _new_id("twr"),
        "name": "Archer",
        "cost": 50,
        "damage": 5,
        "range": 3,
        # Hit points when monsters attack this tower (Monster Rush dig / chaos).
        "hp": 50,
        # Seconds between full attack cycles (all weapon types)
        "cooldown": 1.0,
        "description": "Basic ranged tower.",
        "weapon": default_weapon(),
        "element": default_element(),
        # Flat upgrades: this tower upgrades another tower to upgrade_level.
        # Empty upgrade_of = base tower (purchasable on the map).
        "upgrade_of": "",
        "upgrade_level": 1,
    }


def _clamp_float(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _clamp_int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def normalize_weapon(raw: Any) -> dict[str, Any]:
    base = default_weapon()
    if not isinstance(raw, dict):
        return base
    wtype = str(raw.get("type") or base["type"])
    if wtype not in WEAPON_TYPES:
        wtype = "single"
    base["type"] = wtype
    base["projectile_count"] = _clamp_int(raw.get("projectile_count"), 1, 1, 20)
    base["burst_interval"] = _clamp_float(raw.get("burst_interval"), 0.08, 0.02, 2.0)
    base["spread_degrees"] = _clamp_float(raw.get("spread_degrees"), 30.0, 5.0, 120.0)
    if wtype in ("single", "sniper"):
        base["projectile_count"] = 1
    return base


def normalize_element(raw: Any) -> dict[str, Any]:
    base = default_element()
    if not isinstance(raw, dict):
        return base
    etype = str(raw.get("type") or base["type"])
    if etype not in ELEMENT_TYPES:
        etype = "none"
    base["type"] = etype
    base["duration"] = _clamp_float(raw.get("duration"), 2.0, 0.0, 60.0)
    base["tick_rate"] = _clamp_float(raw.get("tick_rate"), 0.5, 0.1, 10.0)
    base["tick_damage"] = _clamp_float(raw.get("tick_damage"), 1.0, 0.0, 10_000.0)
    base["slow_factor"] = _clamp_float(raw.get("slow_factor"), 0.5, 0.05, 1.0)
    base["aoe_radius"] = _clamp_float(raw.get("aoe_radius"), 0.0, 0.0, 10.0)
    if etype == "none":
        base["tick_damage"] = 0.0
        base["duration"] = 0.0
    elif etype == "freeze" and raw.get("tick_damage") is None:
        # Slow-only freeze by default
        base["tick_damage"] = 0.0
    return base


def normalize_tower(raw: Any) -> dict[str, Any]:
    """
    Flat tower type.

    Base towers have empty upgrade_of (purchasable on the map).
    Upgrade towers set upgrade_of to another tower id and upgrade_level
    (the tier they upgrade that base to). Several towers may share the
    same upgrade_of + upgrade_level (player picks one).
    """
    base = default_tower()
    if not isinstance(raw, dict):
        return base

    # Prefer explicit cooldown; migrate legacy fire_rate (shots/sec) → cooldown (sec).
    if raw.get("cooldown") is not None:
        cooldown = _clamp_float(raw.get("cooldown"), base["cooldown"], 0.05, 60.0)
    elif raw.get("fire_rate") is not None:
        try:
            fr = float(raw.get("fire_rate"))
            cooldown = _clamp_float(1.0 / fr if fr > 0 else 1.0, 1.0, 0.05, 60.0)
        except (TypeError, ValueError):
            cooldown = base["cooldown"]
    else:
        cooldown = base["cooldown"]

    upgrade_of = str(raw.get("upgrade_of") or "").strip()[:40]
    # Self-reference is invalid
    tower_id = clean_id(raw.get("id") or base["id"], fallback=_new_id("twr"))
    if upgrade_of and upgrade_of == tower_id:
        upgrade_of = ""

    upgrade_level = _clamp_int(raw.get("upgrade_level"), 1, 1, MAX_UPGRADE_LEVEL)
    if not upgrade_of:
        upgrade_level = 1

    return {
        "id": tower_id,
        "name": clean_name(raw.get("name") or base["name"], default="Tower"),
        "cost": _clamp_int(raw.get("cost"), base["cost"], 0, 1_000_000),
        "damage": _clamp_int(raw.get("damage"), base["damage"], 0, 100_000),
        "range": _clamp_int(raw.get("range"), base["range"], 1, 40),
        "hp": _clamp_int(raw.get("hp"), base["hp"], 1, 1_000_000),
        "cooldown": cooldown,
        "description": clean_description(raw.get("description") or ""),
        "weapon": normalize_weapon(raw.get("weapon")),
        "element": normalize_element(raw.get("element")),
        "upgrade_of": clean_id(upgrade_of, fallback="") if upgrade_of else "",
        "upgrade_level": upgrade_level,
    }


def towers_for_upgrade(towers: list[dict[str, Any]], base_id: str, level: int) -> list[dict[str, Any]]:
    """All tower types that upgrade base_id to the given level."""
    return [
        t
        for t in towers
        if str(t.get("upgrade_of") or "") == str(base_id)
        and int(t.get("upgrade_level") or 0) == int(level)
    ]


def default_monster() -> dict[str, Any]:
    return {
        "id": _new_id("mob"),
        "name": "Goblin",
        "hp": 20,
        "speed": 1.0,
        "reward": 10,
        "description": "Weak and fast.",
    }


# ---------------------------------------------------------------------------
# Wave types
# ---------------------------------------------------------------------------
# A wave type defines WHAT spawns (monster groups) and WHEN (round schedule).
# "Appearance" = the Nth time this wave type is used (not the global round).
# Example: Goblin wave on rounds 1,3,5 → round 1 is appearance 1, round 3 is
# appearance 2, round 5 is appearance 3. Scaling can use appearance or round.
SCALING_STATS = frozenset({"hp", "speed", "reward"})
SCALING_BASIS = frozenset({"appearance", "round"})
SCALING_MODES = frozenset(
    {
        "base_times_n",  # value = base * n
        "base_plus_n_times_factor",  # value = base + (n - 1) * factor
        "base_times_one_plus_n_minus_one_times_factor",  # base * (1 + (n-1)*factor)
    }
)


def default_wave_type(*, monster_id: str = "") -> dict[str, Any]:
    return {
        "id": _new_id("wav"),
        "name": "Default wave",
        # Human-friendly schedule: "1, 3, 5, 10-15"
        "rounds": "1-",
        "groups": [
            {
                "monster_id": monster_id,
                "count": 5,
            }
        ],
        "scaling": [
            {
                "stat": "hp",
                "basis": "appearance",
                "mode": "base_times_n",
                "factor": 1.0,
            }
        ],
    }


def parse_round_spec(spec: str) -> list[int]:
    """
    Parse '1, 3, 5, 10-15, 20-' into sorted unique positive rounds.
    Open-ended '20-' means 20 through a high cap (used at runtime with max round).
    """
    rounds: set[int] = set()
    if not isinstance(spec, str):
        return []
    for part in spec.split(","):
        p = part.strip()
        if not p:
            continue
        if "-" in p:
            left, _, right = p.partition("-")
            left = left.strip()
            right = right.strip()
            try:
                a = int(left) if left else 1
            except ValueError:
                continue
            if right == "":
                # Open-ended: store as large range; runtime clamps by progress
                b = 9999
            else:
                try:
                    b = int(right)
                except ValueError:
                    continue
            lo, hi = (a, b) if a <= b else (b, a)
            lo = max(1, lo)
            hi = min(9999, hi)
            for n in range(lo, hi + 1):
                rounds.add(n)
        else:
            try:
                n = int(p)
            except ValueError:
                continue
            if n >= 1:
                rounds.add(n)
    return sorted(rounds)


def normalize_wave_type(raw: Any, *, monsters: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    monsters = monsters or []
    monster_ids = {str(m.get("id")) for m in monsters if m.get("id")}
    base = default_wave_type(
        monster_id=str(monsters[0]["id"]) if monsters else ""
    )
    if not isinstance(raw, dict):
        return base

    groups_out: list[dict[str, Any]] = []
    groups_in = raw.get("groups")
    if isinstance(groups_in, list):
        for g in groups_in[:20]:
            if not isinstance(g, dict):
                continue
            mid = str(g.get("monster_id") or "").strip()
            if monster_ids and mid not in monster_ids:
                # Keep id even if unknown (draft may re-add monster later)
                pass
            count = _clamp_int(g.get("count"), 5, 1, 200)
            if mid:
                groups_out.append({"monster_id": mid[:40], "count": count})
    if not groups_out and monsters:
        groups_out = [{"monster_id": str(monsters[0]["id"]), "count": 5}]

    scaling_out: list[dict[str, Any]] = []
    scaling_in = raw.get("scaling")
    if isinstance(scaling_in, list):
        for s in scaling_in[:12]:
            if not isinstance(s, dict):
                continue
            stat = str(s.get("stat") or "hp")
            if stat not in SCALING_STATS:
                continue
            basis = str(s.get("basis") or "appearance")
            if basis not in SCALING_BASIS:
                basis = "appearance"
            mode = str(s.get("mode") or "base_times_n")
            if mode not in SCALING_MODES:
                mode = "base_times_n"
            scaling_out.append(
                {
                    "stat": stat,
                    "basis": basis,
                    "mode": mode,
                    "factor": _clamp_float(s.get("factor"), 1.0, 0.0, 1000.0),
                }
            )

    rounds = str(raw.get("rounds") or base["rounds"]).strip()[:120] or "1-"

    return {
        "id": clean_id(raw.get("id") or base["id"], fallback=_new_id("wav")),
        "name": clean_name(raw.get("name") or base["name"], default="Wave"),
        "rounds": rounds,
        "groups": groups_out,
        "scaling": scaling_out,
    }


def normalize_wave_types(
    raw: Any,
    *,
    monsters: list[dict[str, Any]],
    max_wave_types: int = 30,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        # One default wave covering all rounds, using first monster
        return [
            default_wave_type(
                monster_id=str(monsters[0]["id"]) if monsters else ""
            )
        ]
    out: list[dict[str, Any]] = []
    for item in raw[: max(1, max_wave_types)]:
        if isinstance(item, dict):
            out.append(normalize_wave_type(item, monsters=monsters))
    return out or [
        default_wave_type(monster_id=str(monsters[0]["id"]) if monsters else "")
    ]


def empty_grid(width: int, height: int) -> list[list[str]]:
    return [[CELL_GROUND for _ in range(width)] for _ in range(height)]


def default_game_document(*, title: str = "Untitled game") -> dict[str, Any]:
    """Full JSON document stored in Game.definition / PendingGame.definition."""
    monsters = [default_monster()]
    return {
        "version": SCHEMA_VERSION,
        "title": title,
        "settings": {
            "width": DEFAULT_WIDTH,
            "height": DEFAULT_HEIGHT,
            "game_type": GAME_TYPE_MONSTER_MARCH,
            # Monster Rush only: if True, monsters keep destroying obstacles on
            # the shortest path to the exit even after a free lane exists.
            # If False (default), once an open path appears they pathfind through
            # it and stop attacking walls/towers.
            "chaos_mode": False,
            # When True, towers may be built on bare ground cells.
            # When False, towers are limited to dedicated tower-pad cells.
            "allow_ground_build": False,
            "starting_lives": 20,
            "starting_gold": 1000,
            "path_must_reach_exit": True,
            # Seconds before the first wave after Play.
            "start_delay_seconds": 15,
            # Seconds after a wave is cleared before the next wave.
            "between_waves_delay_seconds": 5,
        },
        "grid": empty_grid(DEFAULT_WIDTH, DEFAULT_HEIGHT),
        # Multiple spawns/exits; ids default to "1", "2", … and may be renamed.
        "spawns": [],
        "exits": [],
        "towers": [default_tower()],
        "monsters": monsters,
        "wave_types": [
            default_wave_type(monster_id=str(monsters[0]["id"])),
        ],
        # Ordered list of enabled scoreboard widget ids (standard platform layout).
        "scoreboard": {
            "items": list(DEFAULT_SCOREBOARD_ITEMS),
        },
    }


def default_scoreboard() -> dict[str, Any]:
    return {"items": list(DEFAULT_SCOREBOARD_ITEMS)}


def normalize_scoreboard(raw: Any) -> dict[str, Any]:
    base = default_scoreboard()
    if not isinstance(raw, dict):
        return base
    items_in = raw.get("items")
    if not isinstance(items_in, list):
        return base
    seen: set[str] = set()
    items: list[str] = []
    for item in items_in:
        wid = str(item).strip()
        if wid in SCOREBOARD_WIDGET_IDS and wid not in seen:
            seen.add(wid)
            items.append(wid)
    if not items:
        items = list(DEFAULT_SCOREBOARD_ITEMS)
    return {"items": items}


def document_byte_size(doc: dict[str, Any]) -> int:
    return len(json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def normalize_game_document(
    raw: Any,
    *,
    limits: TierLimits | None = None,
) -> dict[str, Any]:
    """
    Coerce arbitrary client JSON into a safe document.

    Unknown keys on the root are dropped; nested lists are validated lightly.
    Raises ValueError for unusable or oversized payloads.
    """
    caps = limits or GUEST_LIMITS
    if raw is None:
        return default_game_document()
    if not isinstance(raw, dict):
        raise ValueError("Game document must be a JSON object.")

    base = default_game_document()
    title = clean_title(raw.get("title", base["title"]))

    settings_in = raw.get("settings") if isinstance(raw.get("settings"), dict) else {}
    settings = copy.deepcopy(base["settings"])
    for key, cast in (
        ("width", int),
        ("height", int),
        ("starting_lives", int),
        ("starting_gold", int),
        ("start_delay_seconds", int),
        ("between_waves_delay_seconds", int),
    ):
        if key in settings_in:
            try:
                settings[key] = cast(settings_in[key])
            except (TypeError, ValueError):
                pass
    # Keep maps small enough for browser playtest performance.
    settings["width"] = max(5, min(40, settings["width"]))
    settings["height"] = max(5, min(30, settings["height"]))
    settings["starting_lives"] = max(1, min(999, settings["starting_lives"]))
    settings["starting_gold"] = max(0, min(1_000_000, settings["starting_gold"]))
    settings["start_delay_seconds"] = max(
        0, min(120, settings.get("start_delay_seconds", 15))
    )
    settings["between_waves_delay_seconds"] = max(
        0, min(120, settings.get("between_waves_delay_seconds", 5))
    )
    settings["allow_ground_build"] = bool(
        settings_in.get("allow_ground_build", settings["allow_ground_build"])
    )
    settings["path_must_reach_exit"] = bool(
        settings_in.get("path_must_reach_exit", settings["path_must_reach_exit"])
    )
    game_type = settings_in.get("game_type", settings["game_type"])
    if game_type not in GAME_TYPES:
        game_type = GAME_TYPE_MONSTER_MARCH
    settings["game_type"] = game_type
    settings["chaos_mode"] = bool(settings_in.get("chaos_mode", settings["chaos_mode"]))

    width, height = settings["width"], settings["height"]
    grid_cells = width * height
    grid = _normalize_grid(raw.get("grid"), width, height)
    towers = _normalize_entity_list(
        raw.get("towers"), kind="tower", max_items=caps.max_towers
    )
    monsters = _normalize_entity_list(
        raw.get("monsters"), kind="monster", max_items=caps.max_monsters
    )
    if not monsters:
        monsters = [default_monster()]
    if not towers:
        towers = [default_tower()]
    # Truncate again if defaults pushed over (shouldn't) — enforce hard caps
    towers = towers[: caps.max_towers]
    monsters = monsters[: caps.max_monsters]
    wave_types = normalize_wave_types(
        raw.get("wave_types"),
        monsters=monsters,
        max_wave_types=caps.max_wave_types,
    )
    wave_types = wave_types[: caps.max_wave_types]
    spawns, exits = _sync_portals(
        grid,
        raw.get("spawns"),
        raw.get("exits"),
    )
    # Portal lists cannot exceed grid area (one portal per cell max).
    if len(spawns) > grid_cells:
        spawns = spawns[:grid_cells]
    if len(exits) > grid_cells:
        exits = exits[:grid_cells]

    doc = {
        "version": SCHEMA_VERSION,
        "title": title,
        "settings": settings,
        "grid": grid,
        "spawns": spawns,
        "exits": exits,
        "towers": towers,
        "monsters": monsters,
        "wave_types": wave_types,
        "scoreboard": normalize_scoreboard(raw.get("scoreboard")),
    }
    size = document_byte_size(doc)
    if size > MAX_DOCUMENT_BYTES:
        raise ValueError(
            f"Game document too large ({size} bytes; max {MAX_DOCUMENT_BYTES}). "
            "Reduce map size or entity counts."
        )
    return doc


def _normalize_grid(raw: Any, width: int, height: int) -> list[list[str]]:
    grid = empty_grid(width, height)
    if not isinstance(raw, list):
        return grid
    for y in range(min(height, len(raw))):
        row = raw[y]
        if not isinstance(row, list):
            continue
        for x in range(min(width, len(row))):
            cell = row[x]
            if isinstance(cell, str) and cell in CELL_KINDS:
                grid[y][x] = cell
            else:
                grid[y][x] = CELL_GROUND
    return grid


def _sanitize_portal_id(raw: Any, fallback: str) -> str:
    return clean_id(raw, fallback=fallback or "1")


def _next_numeric_id(used: set[str]) -> str:
    n = 1
    while str(n) in used:
        n += 1
    return str(n)


def _index_portals_by_pos(raw: Any) -> dict[tuple[int, int], dict[str, Any]]:
    out: dict[tuple[int, int], dict[str, Any]] = {}
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            x = int(item.get("x"))
            y = int(item.get("y"))
        except (TypeError, ValueError):
            continue
        out[(x, y)] = item
    return out


def _sync_portals(
    grid: list[list[str]],
    raw_spawns: Any,
    raw_exits: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    Align spawn/exit metadata with grid cells.

    Grid is authoritative for positions. Existing ids and spawn exit settings
    are preserved when the cell is still a spawn/exit at that coordinate.
    """
    height = len(grid)
    width = len(grid[0]) if height else 0
    prev_spawns = _index_portals_by_pos(raw_spawns)
    prev_exits = _index_portals_by_pos(raw_exits)

    used_spawn_ids: set[str] = set()
    used_exit_ids: set[str] = set()
    spawns: list[dict[str, Any]] = []
    exits: list[dict[str, Any]] = []

    # First pass: claim previous ids that still match the grid.
    spawn_cells: list[tuple[int, int]] = []
    exit_cells: list[tuple[int, int]] = []
    for y in range(height):
        for x in range(width):
            kind = grid[y][x]
            if kind == CELL_SPAWN:
                spawn_cells.append((x, y))
            elif kind == CELL_EXIT:
                exit_cells.append((x, y))

    for x, y in spawn_cells:
        prev = prev_spawns.get((x, y), {})
        candidate = _sanitize_portal_id(prev.get("id"), "")
        if not candidate or candidate in used_spawn_ids:
            candidate = _next_numeric_id(used_spawn_ids)
        used_spawn_ids.add(candidate)
        mode = prev.get("exit_mode", EXIT_MODE_ANY)
        if mode not in EXIT_MODES:
            mode = EXIT_MODE_ANY
        exit_id = str(prev.get("exit_id") or "").strip()
        if mode != EXIT_MODE_SPECIFIC:
            exit_id = ""
        elif exit_id and not ID_RE.match(exit_id):
            exit_id = ""
        spawns.append(
            {
                "id": candidate,
                "x": x,
                "y": y,
                "exit_mode": mode,
                "exit_id": exit_id,
            }
        )

    for x, y in exit_cells:
        prev = prev_exits.get((x, y), {})
        candidate = _sanitize_portal_id(prev.get("id"), "")
        if not candidate or candidate in used_exit_ids:
            candidate = _next_numeric_id(used_exit_ids)
        used_exit_ids.add(candidate)
        exits.append({"id": candidate, "x": x, "y": y})

    # Drop spawn→exit links that no longer exist.
    exit_id_set = {e["id"] for e in exits}
    for spawn in spawns:
        if spawn["exit_mode"] == EXIT_MODE_SPECIFIC:
            if spawn["exit_id"] not in exit_id_set:
                # Keep mode; editor can re-pick. Clear dangling id.
                spawn["exit_id"] = ""

    return spawns, exits


def completeness(document: dict[str, Any]) -> dict[str, Any]:
    """
    Lightweight design completeness checks.

    A complete game requires at least one spawn and one exit (all game types).
    """
    spawns = document.get("spawns") or []
    exits = document.get("exits") or []
    has_spawn = len(spawns) >= 1
    has_exit = len(exits) >= 1
    missing: list[str] = []
    if not has_spawn:
        missing.append("At least one Spawn is required.")
    if not has_exit:
        missing.append("At least one Exit is required.")
    return {
        "complete": has_spawn and has_exit,
        "has_spawn": has_spawn,
        "has_exit": has_exit,
        "spawn_count": len(spawns),
        "exit_count": len(exits),
        "missing": missing,
        "game_type": (document.get("settings") or {}).get(
            "game_type", GAME_TYPE_MONSTER_MARCH
        ),
    }


def _normalize_entity_list(
    raw: Any, *, kind: str, max_items: int = 20
) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[: max(1, max_items)]:
        if not isinstance(item, dict):
            continue
        if kind == "tower":
            out.append(normalize_tower(item))
        else:
            base = default_monster()
            base["id"] = clean_id(item.get("id") or base["id"], fallback=_new_id("mob"))
            base["name"] = clean_name(item.get("name") or base["name"], default="Monster")
            base["description"] = clean_description(item.get("description") or "")
            for key in ("hp", "reward"):
                try:
                    base[key] = int(item.get(key, base[key]))
                except (TypeError, ValueError):
                    pass
            try:
                base["speed"] = float(item.get("speed", base["speed"]))
            except (TypeError, ValueError):
                pass
            out.append(base)
    return out
