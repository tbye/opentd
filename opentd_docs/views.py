from __future__ import annotations

import json

from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from core.export_format import FORMAT_ID, FORMAT_VERSION
from core.game_schema import (
    GAME_TYPE_LABELS,
    SCHEMA_VERSION,
    default_game_document,
)


def docs_index(request: HttpRequest) -> HttpResponse:
    return render(
        request,
        "opentd_docs/index.html",
        {
            "format_id": FORMAT_ID,
            "format_version": FORMAT_VERSION,
            "schema_version": SCHEMA_VERSION,
        },
    )


def docs_editor_guide(request: HttpRequest) -> HttpResponse:
    return render(
        request,
        "opentd_docs/editor_guide.html",
        {"game_types": GAME_TYPE_LABELS},
    )


def docs_json_format(request: HttpRequest) -> HttpResponse:
    sample = default_game_document(title="Example defense")
    # Shrink sample grid for readability in docs
    sample["settings"]["width"] = 8
    sample["settings"]["height"] = 6
    sample["grid"] = [["ground"] * 8 for _ in range(6)]
    sample["grid"][0][0] = "spawn"
    sample["grid"][5][7] = "exit"
    for x in range(8):
        sample["grid"][2][x] = "path"
    return render(
        request,
        "opentd_docs/json_format.html",
        {
            "format_id": FORMAT_ID,
            "format_version": FORMAT_VERSION,
            "schema_version": SCHEMA_VERSION,
            "sample_json": json.dumps(sample, indent=2),
            "game_types": GAME_TYPE_LABELS,
        },
    )
