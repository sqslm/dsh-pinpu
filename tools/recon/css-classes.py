"""Extract CSS class names matching a regex from the built frontend stylesheets.

Usage: python css-classes.py <file-or-dir> <regex>
"""
import re
import sys
from pathlib import Path


def main() -> None:
    target = Path(sys.argv[1])
    pattern = re.compile(sys.argv[2], re.I)
    files = [target] if target.is_file() else sorted(target.rglob("*.css"))
    seen: dict[str, set[str]] = {}
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for name in re.findall(r"\.([A-Za-z_][\w-]*_[A-Za-z0-9_-]+|[a-z][\w-]*(?:-[\w-]+)+)", text):
            if pattern.search(name):
                seen.setdefault(name, set()).add(path.name)
    for name in sorted(seen):
        print(f"{name}   <- {','.join(sorted(seen[name]))}")
    print(f"total {len(seen)}")


if __name__ == "__main__":
    main()
