# Sync django.contrib.sites to OpenTD.org for verification email links.

from django.db import migrations


def forwards(apps, schema_editor):
    Site = apps.get_model("sites", "Site")
    Site.objects.update_or_create(
        pk=1,
        defaults={"name": "OpenTD.org", "domain": "opentd.org"},
    )


def backwards(apps, schema_editor):
    Site = apps.get_model("sites", "Site")
    Site.objects.filter(pk=1).update(name="example.com", domain="example.com")


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0002_security_beta_limits"),
        ("sites", "0002_alter_domain_unique"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
