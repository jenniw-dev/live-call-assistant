import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "download-models.py"
SPEC = importlib.util.spec_from_file_location("download_models", SCRIPT)
download_models = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(download_models)


def test_model_downloads_use_reviewed_commit_revisions(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(download_models, "ROOT", tmp_path)
    monkeypatch.setattr(download_models, "snapshot_download", lambda **options: calls.append(options))

    download_models.download("BAAI/bge-small-en-v1.5", "bge-small-en-v1.5")
    download_models.download("Systran/faster-whisper-small", "faster-whisper-small")

    assert calls == [
        {
            "repo_id": "BAAI/bge-small-en-v1.5",
            "revision": "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
            "local_dir": tmp_path / "models" / "bge-small-en-v1.5",
            "local_dir_use_symlinks": False,
        },
        {
            "repo_id": "Systran/faster-whisper-small",
            "revision": "536b0662742c02347bc0e980a01041f333bce120",
            "local_dir": tmp_path / "models" / "faster-whisper-small",
            "local_dir_use_symlinks": False,
        },
    ]
