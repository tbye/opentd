from django.urls import path

from . import views

urlpatterns = [
    path("", views.home, name="home"),
    path("editor/", views.editor, name="editor"),
    path("api/draft/", views.draft_api, name="draft_api"),
    path("api/stash-signup/", views.stash_and_signup, name="stash_and_signup"),
    path("api/games/new/", views.create_game_from_editor, name="game_create"),
    path("api/games/<int:game_id>/", views.save_owned_game, name="game_save"),
]
