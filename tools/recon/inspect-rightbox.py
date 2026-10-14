"""Measure the geometry of the strip the user circled in the reference screenshot.

Usage: python inspect-rightbox.py <png> [x0 y0 x1 y1]
Prints the background colour, every connected component (a "dash"), and a coarse
ASCII rendering so the shape of the thing can be reasoned about without eyeballing.
"""
import sys
import collections
from PIL import Image


def main() -> None:
    path = sys.argv[1]
    box = tuple(int(v) for v in sys.argv[2:6]) if len(sys.argv) >= 6 else (1195, 300, 1280, 540)
    im = Image.open(path).convert("RGB")
    x0, y0, x1, y1 = box
    px = im.load()

    histogram = collections.Counter()
    for y in range(y0, y1):
        for x in range(x0, x1):
            histogram[px[x, y]] += 1
    background = histogram.most_common(1)[0][0]
    print(f"image={im.size} box={box} background={background}")
    print("top colours:", histogram.most_common(6))

    w, h = x1 - x0, y1 - y0
    mask = [[0] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            colour = px[x0 + x, y0 + y]
            if sum(abs(a - b) for a, b in zip(colour, background)) > 24:
                mask[y][x] = 1

    seen = [[0] * w for _ in range(h)]
    components = []
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            stack = [(y, x)]
            seen[y][x] = 1
            points = []
            while stack:
                cy, cx = stack.pop()
                points.append((cy, cx))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = 1
                        stack.append((ny, nx))
            ys = [p[0] for p in points]
            xs = [p[1] for p in points]
            colours = [px[x0 + cx, y0 + cy] for cy, cx in points]
            components.append({
                "top": min(ys) + y0,
                "bottom": max(ys) + y0,
                "left": min(xs) + x0,
                "right": max(xs) + x0,
                "px": len(points),
                "colour": collections.Counter(colours).most_common(1)[0][0],
            })

    components.sort(key=lambda c: (c["top"], c["left"]))
    print(f"components: {len(components)}")
    for c in components:
        print(
            f"  y {c['top']}-{c['bottom']} x {c['left']}-{c['right']}"
            f"  h={c['bottom'] - c['top'] + 1} w={c['right'] - c['left'] + 1}"
            f"  px={c['px']} colour={c['colour']}"
        )

    print("ascii map (# = ink):")
    for y in range(0, h, 2):
        row = "".join("#" if mask[y][x] else "." for x in range(w))
        print(f"{y0 + y:>4} {row}")


if __name__ == "__main__":
    main()
