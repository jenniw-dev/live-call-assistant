import os

import uvicorn

from app.main import app


def main() -> None:
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("BACKEND_PORT", "8001")),
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
