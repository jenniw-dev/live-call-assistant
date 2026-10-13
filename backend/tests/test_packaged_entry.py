import run_packaged
from app.main import app as backend_app


def test_packaged_entry_passes_the_imported_application_to_uvicorn(monkeypatch):
    captured = {}

    def fake_run(application, **options):
        captured["application"] = application
        captured["options"] = options

    monkeypatch.setattr(run_packaged.uvicorn, "run", fake_run)
    monkeypatch.setenv("BACKEND_PORT", "18001")

    run_packaged.main()

    assert captured == {
        "application": backend_app,
        "options": {
            "host": "127.0.0.1",
            "port": 18001,
            "log_level": "info",
            "access_log": False,
        },
    }
