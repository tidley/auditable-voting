#!/usr/bin/env python3
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT_DIR / "tests"
RESULTS_DIR = ROOT_DIR / "test-results"


def run_tests() -> tuple[int, list[str]]:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(TESTS_DIR), "-v", "--tb=short"],
        capture_output=True,
        text=True,
        cwd=str(ROOT_DIR),
    )
    lines = (result.stdout + result.stderr).splitlines()
    return result.returncode, lines


def parse_results(lines: list[str]) -> dict:
    tests = []
    for line in lines:
        line = line.strip()
        if "::" not in line or "PASSED" not in line and "FAILED" not in line:
            continue
        nodeid = line.split()[0]
        status = "passed" if "PASSED" in line else "failed"
        module = nodeid.split("::")[0] if "::" in nodeid else nodeid
        name = nodeid.split("::")[-1] if "::" in nodeid else nodeid
        tests.append({"nodeid": nodeid, "module": module, "name": name, "status": status})

    passed = sum(1 for t in tests if t["status"] == "passed")
    failed = sum(1 for t in tests if t["status"] == "failed")
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total": len(tests),
        "passed": passed,
        "failed": failed,
        "tests": tests,
    }


def persist_results(results: dict) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = RESULTS_DIR / f"{timestamp}.json"
    path.write_text(json.dumps(results, indent=2) + "\n")

    latest = RESULTS_DIR / "latest.json"
    latest.write_text(json.dumps(results, indent=2) + "\n")

    return path


def main() -> int:
    print("Running tests...")
    print()
    rc, lines = run_tests()
    print("\n".join(lines))
    print()

    results = parse_results(lines)
    path = persist_results(results)

    print(f"Results: {results['passed']}/{results['total']} passed, {results['failed']} failed")
    print(f"Saved to: {path}")
    print(f"Latest:   {path.parent / 'latest.json'}")

    return rc


if __name__ == "__main__":
    raise SystemExit(main())
