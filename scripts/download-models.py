from pathlib import Path

from huggingface_hub import snapshot_download


ROOT = Path(__file__).resolve().parent.parent
MODEL_REVISIONS = {
    "BAAI/bge-small-en-v1.5": "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
    "Systran/faster-whisper-small": "536b0662742c02347bc0e980a01041f333bce120",
}


def download(repo_id: str, directory: str) -> None:
    snapshot_download(
        repo_id=repo_id,
        revision=MODEL_REVISIONS[repo_id],
        local_dir=ROOT / "models" / directory,
        local_dir_use_symlinks=False,
    )


if __name__ == "__main__":
    download("BAAI/bge-small-en-v1.5", "bge-small-en-v1.5")
    download("Systran/faster-whisper-small", "faster-whisper-small")
