from django.urls import path

from . import views

app_name = "docs"

urlpatterns = [
    path("", views.docs_index, name="index"),
    path("editor/", views.docs_editor_guide, name="editor"),
    path("json/", views.docs_json_format, name="json"),
]
