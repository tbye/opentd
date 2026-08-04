import secrets

import django.utils.timezone
from django.db import migrations, models


def gen_codes(apps, schema_editor):
    Game = apps.get_model("core", "Game")
    used = set()
    for game in Game.objects.all():
        code = secrets.token_urlsafe(9)
        while code in used:
            code = secrets.token_urlsafe(9)
        used.add(code)
        game.share_code = code
        game.save(update_fields=["share_code"])


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0004_user_profile_max_games"),
    ]

    operations = [
        migrations.AddField(
            model_name="game",
            name="allow_download",
            field=models.BooleanField(
                default=False,
                help_text="When on, anyone may download the game as OpenTD JSON.",
            ),
        ),
        migrations.AddField(
            model_name="game",
            name="is_public",
            field=models.BooleanField(
                default=False,
                help_text="When on, anyone can play via the share link and it may appear in the gallery.",
            ),
        ),
        migrations.AddField(
            model_name="game",
            name="share_code",
            field=models.CharField(blank=True, default="", max_length=24),
        ),
        migrations.RunPython(gen_codes, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="game",
            name="share_code",
            field=models.CharField(
                db_index=True,
                default="",
                editable=False,
                max_length=24,
                unique=True,
            ),
        ),
    ]
