import json

from allauth.account.models import EmailAddress
from allauth.account.signals import email_confirmed, user_signed_up
from django.contrib.auth import get_user_model
from django.test import Client, SimpleTestCase, TestCase
from django.urls import reverse

from .drafts import promote_pending_to_game
from .game_schema import (
    GAME_TYPE_MONSTER_MARCH,
    GAME_TYPE_ORDER,
    completeness,
    default_game_document,
    normalize_game_document,
    parse_round_spec,
    starter_game_document,
)
from .models import Game, PendingGame

User = get_user_model()


def _reaches(grid, start, goals, *, walkable):
    """4-directional reachability. walkable=None means any cell that is not a wall."""
    height = len(grid)
    width = len(grid[0]) if height else 0
    goalset = set(goals)
    seen = {start}
    queue = [start]
    while queue:
        x, y = queue.pop()
        if (x, y) in goalset:
            return True
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= width or ny >= height or (nx, ny) in seen:
                continue
            kind = grid[ny][nx]
            if walkable is None:
                if kind == "blocked":
                    continue
            elif kind not in walkable:
                continue
            seen.add((nx, ny))
            queue.append((nx, ny))
    return False


class DatabaseConfigTests(SimpleTestCase):
    def test_engine_follows_db_url(self):
        import os

        from django.conf import settings

        db = settings.DATABASES["default"]
        if os.environ.get("DB_URL", "").strip() or os.environ.get(
            "DATABASE_URL", ""
        ).strip():
            self.assertIn("postgresql", db["ENGINE"])
            return
        self.assertEqual(db["ENGINE"], "django.db.backends.sqlite3")

    def test_db_url_parses_postgres(self):
        import dj_database_url

        cfg = dj_database_url.parse(
            "postgres://opentd:secret@pg:5432/opentd",
            conn_max_age=600,
            conn_health_checks=True,
        )
        self.assertIn("postgresql", cfg["ENGINE"])
        self.assertEqual(cfg["NAME"], "opentd")
        self.assertEqual(cfg["USER"], "opentd")
        self.assertEqual(cfg["HOST"], "pg")
        self.assertEqual(int(cfg["PORT"]), 5432)
        self.assertEqual(cfg["CONN_MAX_AGE"], 600)


class GameSchemaTests(TestCase):
    def test_normalize_clamps_dimensions(self):
        doc = normalize_game_document(
            {"settings": {"width": 999, "height": 1}, "grid": []}
        )
        self.assertEqual(doc["settings"]["width"], 40)
        self.assertEqual(doc["settings"]["height"], 5)
        self.assertEqual(len(doc["grid"]), 5)
        self.assertEqual(len(doc["grid"][0]), 40)

    def test_guest_entity_caps(self):
        from .limits import GUEST_LIMITS

        towers = [{"name": f"T{i}", "id": f"t{i}"} for i in range(20)]
        doc = normalize_game_document({"towers": towers}, limits=GUEST_LIMITS)
        self.assertLessEqual(len(doc["towers"]), GUEST_LIMITS.max_towers)

    def test_export_import_roundtrip(self):
        from .export_format import build_export_payload, parse_import_payload
        from .limits import REGISTERED_LIMITS

        base = default_game_document(title="Round trip")
        payload = build_export_payload(
            title="Round trip", definition=base, limits=REGISTERED_LIMITS
        )
        self.assertEqual(payload["format"], "opentd.game")
        title, definition = parse_import_payload(payload, limits=REGISTERED_LIMITS)
        self.assertEqual(title, "Round trip")
        self.assertEqual(definition["settings"]["width"], base["settings"]["width"])

    def test_default_has_entities(self):
        doc = default_game_document()
        self.assertTrue(doc["towers"])
        self.assertTrue(doc["monsters"])
        self.assertIn("allow_ground_build", doc["settings"])
        self.assertEqual(doc["settings"]["game_type"], "monster_march")
        self.assertFalse(doc["settings"]["chaos_mode"])
        self.assertEqual(doc["spawns"], [])
        self.assertEqual(doc["exits"], [])
        self.assertFalse(completeness(doc)["complete"])

    def test_game_type_and_chaos_normalize(self):
        doc = normalize_game_document(
            {
                "settings": {
                    "game_type": "monster_rush",
                    "chaos_mode": True,
                    "width": 10,
                    "height": 10,
                }
            }
        )
        self.assertEqual(doc["settings"]["game_type"], "monster_rush")
        self.assertTrue(doc["settings"]["chaos_mode"])
        bad = normalize_game_document({"settings": {"game_type": "nope"}})
        self.assertEqual(bad["settings"]["game_type"], "monster_march")

    def test_starter_games_are_paired_and_playable(self):
        for game_type in GAME_TYPE_ORDER:
            doc = starter_game_document(game_type)
            self.assertEqual(doc["settings"]["game_type"], game_type)
            self.assertEqual(len(doc["towers"]), 2)
            self.assertEqual(len(doc["monsters"]), 2)
            self.assertEqual(len(doc["wave_types"]), 2)
            self.assertEqual(len(doc["spawns"]), 2)
            self.assertEqual(len(doc["exits"]), 2)
            rounds = []
            for wave in doc["wave_types"]:
                rounds.extend(
                    parse_round_spec(wave["rounds"], max_round=doc["settings"]["max_rounds"])
                )
            self.assertEqual(sorted(set(rounds)), [1, 2])
            self.assertEqual(doc["settings"]["max_rounds"], 2)
            weapons = {t["weapon"]["type"] for t in doc["towers"]}
            elements = {t["element"]["type"] for t in doc["towers"]}
            self.assertGreater(len(weapons), 1)
            self.assertIn("none", elements)
            self.assertTrue(elements - {"none"})
            self.assertGreater(doc["settings"]["starting_gold"], 0)
            self.assertLessEqual(
                min(t["cost"] for t in doc["towers"]),
                doc["settings"]["starting_gold"],
            )
            goals = [(e["x"], e["y"]) for e in doc["exits"]]
            if game_type == GAME_TYPE_MONSTER_MARCH:
                walkable = {"path", "spawn", "exit"}
                self.assertFalse(doc["settings"]["allow_ground_build"])
                self.assertTrue(
                    all(s["exit_mode"] == "specific" and s["exit_id"] for s in doc["spawns"])
                )
            else:
                walkable = None
                self.assertTrue(doc["settings"]["allow_ground_build"])
            for spawn in doc["spawns"]:
                self.assertTrue(
                    _reaches(
                        doc["grid"],
                        (spawn["x"], spawn["y"]),
                        goals,
                        walkable=walkable,
                    ),
                    f"{game_type} spawn {spawn['id']} cannot reach an exit",
                )

            blank = starter_game_document(game_type, blank=True)
            self.assertEqual(blank["settings"]["game_type"], game_type)
            self.assertEqual(len(blank["towers"]), 2)
            self.assertEqual(len(blank["monsters"]), 2)
            self.assertEqual(len(blank["wave_types"]), 2)
            self.assertEqual(blank["spawns"], [])
            self.assertEqual(blank["exits"], [])
            self.assertTrue(
                all(cell == "ground" for row in blank["grid"] for cell in row)
            )

    def test_spawns_and_exits_sync_from_grid(self):
        base = default_game_document()
        w = base["settings"]["width"]
        h = base["settings"]["height"]
        grid = [row[:] for row in base["grid"]]
        grid[0][0] = "spawn"
        grid[0][1] = "spawn"
        grid[h - 1][w - 1] = "exit"
        grid[h - 1][w - 2] = "exit"
        doc = normalize_game_document(
            {
                "grid": grid,
                "settings": base["settings"],
                "spawns": [
                    {
                        "id": "alpha",
                        "x": 0,
                        "y": 0,
                        "exit_mode": "specific",
                        "exit_id": "gate-a",
                    }
                ],
                "exits": [
                    {"id": "gate-a", "x": w - 1, "y": h - 1},
                ],
            }
        )
        self.assertEqual(len(doc["spawns"]), 2)
        self.assertEqual(len(doc["exits"]), 2)
        by_pos = {(s["x"], s["y"]): s for s in doc["spawns"]}
        self.assertEqual(by_pos[(0, 0)]["id"], "alpha")
        self.assertEqual(by_pos[(0, 0)]["exit_mode"], "specific")
        self.assertEqual(by_pos[(0, 0)]["exit_id"], "gate-a")
        # Second spawn gets a free numeric id
        self.assertEqual(by_pos[(1, 0)]["id"], "1")
        self.assertEqual(by_pos[(1, 0)]["exit_mode"], "any")
        exit_ids = {e["id"] for e in doc["exits"]}
        self.assertIn("gate-a", exit_ids)



class DraftAndPromoteTests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_editor_is_public(self):
        r = self.client.get(reverse("editor"))
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "Game settings")
        self.assertContains(r, "Towers")
        self.assertContains(r, "Monsters")
        self.assertContains(r, "editor-grid")
        self.assertContains(r, 'data-tool="spawn"')
        self.assertContains(r, 'data-tool="exit"')
        self.assertContains(r, "paint-bar")
        self.assertContains(r, "paint-swatch")
        self.assertContains(r, "playtest-bar")
        self.assertContains(r, "pt-play")
        self.assertContains(r, "playtest.js")
        self.assertContains(r, "design_validate.js")
        self.assertContains(r, "pt-play-wrap")
        self.assertContains(r, "tab-scoreboard")
        self.assertContains(r, "sb-palette")
        self.assertNotContains(r, 'id="design-issues"')
        self.assertContains(r, "Spawns")
        self.assertContains(r, "at least 1 Spawn")
        self.assertContains(r, "Monster March")
        self.assertContains(r, "Monster Rush")
        self.assertContains(r, "Defend the Castle")
        self.assertContains(r, "Chaos mode")
        self.assertContains(r, 'id="game-type-picker"')
        self.assertContains(r, "game-type-picker__cards")
        self.assertContains(r, 'data-game-type="monster_march"')
        self.assertContains(r, 'data-game-type="monster_rush"')
        self.assertContains(r, 'data-game-type="defend_the_castle"')
        self.assertContains(
            r, "Start the game with a blank map with no predetermined items."
        )
        self.assertContains(r, 'id="set-game-type"')
        self.assertContains(r, "Sign up to save")
        self.assertContains(r, "nav-signup-help-tip")
        self.assertNotContains(r, "btn-signup-save")
        self.assertNotContains(r, "btn-save-draft")

    def test_new_game_picker_does_not_load_existing_draft(self):
        doc = default_game_document(title="Secret draft")
        saved = self.client.post(
            reverse("draft_api"),
            data=json.dumps({"definition": doc}),
            content_type="application/json",
        )
        self.assertEqual(saved.status_code, 200)
        fresh = self.client.get(reverse("editor") + "?new=1")
        self.assertEqual(fresh.status_code, 200)
        self.assertContains(fresh, 'id="game-type-picker"')
        self.assertNotContains(fresh, "Secret draft")
        resume = self.client.get(reverse("editor"))
        self.assertNotContains(resume, 'id="game-type-picker"')
        self.assertContains(resume, "Secret draft")

    def test_draft_api_saves_session_pending(self):
        doc = default_game_document(title="My map")
        doc["grid"][0][0] = "path"
        r = self.client.post(
            reverse("draft_api"),
            data=json.dumps({"definition": doc}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertTrue(PendingGame.objects.filter(pk=body["pending_id"]).exists())
        pending = PendingGame.objects.get(pk=body["pending_id"])
        self.assertEqual(pending.title, "My map")
        self.assertEqual(pending.definition["grid"][0][0], "path")
        self.assertIsNone(pending.user_id)

    def test_signup_attaches_pending_and_verify_promotes(self):
        # Guest paints a draft
        doc = default_game_document(title="Guest masterpiece")
        doc["settings"]["allow_ground_build"] = True
        doc["grid"][1][1] = "tower"
        r = self.client.post(
            reverse("draft_api"),
            data=json.dumps({"definition": doc, "lock_for_signup": True}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        pending_id = r.json()["pending_id"]

        user = User.objects.create_user(
            username="guest1", email="guest1@opentd.test", password="TestPass123!"
        )
        # Simulate allauth user_signed_up with the same session
        request = self.client.get(reverse("editor")).wsgi_request
        # Rebuild request bound to session after draft
        session = self.client.session
        session.save()
        from django.test import RequestFactory

        factory = RequestFactory()
        req = factory.get("/editor/")
        req.session = self.client.session
        req.user = user
        user_signed_up.send(sender=User, request=req, user=user)

        pending = PendingGame.objects.get(pk=pending_id)
        self.assertEqual(pending.user_id, user.pk)
        self.assertTrue(pending.locked_for_signup)
        self.assertEqual(Game.objects.filter(owner=user).count(), 0)

        # Email confirmed → Game created
        email = EmailAddress.objects.create(
            user=user, email=user.email, primary=True, verified=False
        )
        email_confirmed.send(sender=EmailAddress, request=req, email_address=email)

        self.assertEqual(Game.objects.filter(owner=user).count(), 1)
        game = Game.objects.get(owner=user)
        self.assertEqual(game.title, "Guest masterpiece")
        self.assertTrue(game.definition["settings"]["allow_ground_build"])
        self.assertEqual(game.definition["grid"][1][1], "tower")
        self.assertFalse(PendingGame.objects.filter(user=user).exists())

    def test_promote_helper_idempotent_empty(self):
        user = User.objects.create_user(
            username="empty", email="empty@opentd.test", password="TestPass123!"
        )
        self.assertIsNone(promote_pending_to_game(user))

    def test_stash_and_signup_redirects(self):
        doc = default_game_document(title="Stash me")
        r = self.client.post(
            reverse("stash_and_signup"),
            data=json.dumps({"definition": doc}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])
        self.assertTrue(PendingGame.objects.filter(title="Stash me").exists())
