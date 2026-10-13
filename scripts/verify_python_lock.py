#!/usr/bin/env python3
"""Verify the exact, supported Python environment used for the Mac bundle."""

from __future__ import annotations

import argparse
import importlib.metadata
import platform
import re
import subprocess
import sys
from pathlib import Path


PACKAGE_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


def canonicalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_lock(path: Path) -> dict[str, tuple[str, str]]:
    locked: dict[str, tuple[str, str]] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        pin, separator, sha256 = line.partition(" --hash=sha256:")
        if not separator or not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise ValueError(f"line {line_number} lacks one exact sha256 wheel hash")
        if pin.count("==") != 1:
            raise ValueError(f"line {line_number} is not an exact package pin")
        name, version = pin.split("==", 1)
        if not PACKAGE_NAME.fullmatch(name) or not version or any(char.isspace() for char in version):
            raise ValueError(f"line {line_number} is not an exact package pin")
        normalized = canonicalize(name)
        if normalized in locked:
            raise ValueError(f"line {line_number} duplicates package {name}")
        locked[normalized] = (name, version)
    if not locked:
        raise ValueError("lock is empty")
    return locked


def installed_packages() -> dict[str, tuple[str, str]]:
    installed: dict[str, tuple[str, str]] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if not name:
            continue
        installed[canonicalize(name)] = (name, distribution.version)
    return installed


def describe(entries: set[str], packages: dict[str, tuple[str, str]]) -> str:
    return ", ".join(
        f"{packages[name][0]}=={packages[name][1]}" for name in sorted(entries)
    )


def verify(lock_path: Path) -> int:
    if platform.machine() != "arm64":
        raise RuntimeError(f"expected arm64 Python, found {platform.machine()}")
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError(
            f"expected Python 3.11, found {sys.version_info.major}.{sys.version_info.minor}"
        )

    locked = read_lock(lock_path)
    installed = installed_packages()
    missing = set(locked) - set(installed)
    extra = set(installed) - set(locked)
    mismatched = {
        name
        for name in set(locked) & set(installed)
        if locked[name][1] != installed[name][1]
    }
    problems: list[str] = []
    if missing:
        problems.append(f"missing: {describe(missing, locked)}")
    if extra:
        problems.append(f"unexpected: {describe(extra, installed)}")
    if mismatched:
        expected = describe(mismatched, locked)
        actual = describe(mismatched, installed)
        problems.append(f"version mismatch (expected {expected}; found {actual})")
    if problems:
        raise RuntimeError("Python environment does not match lock: " + "; ".join(problems))

    check = subprocess.run(
        [sys.executable, "-m", "pip", "check"],
        check=False,
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        detail = (check.stdout + check.stderr).strip()
        raise RuntimeError(f"pip check failed: {detail}")

    print(f"Python lock verified: {len(locked)} exact packages; pip check passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()
    try:
        return verify(args.lock)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Python lock verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
