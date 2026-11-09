"""Braille art -> dot matrix. Each braille cell is 2 dots wide and 4 tall."""
BITS = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]

def dots(path="build/finger-braille.txt"):
    rows = open(path, encoding="utf-8").read().rstrip("\n").split("\n")
    w, h = max(len(r) for r in rows) * 2, len(rows) * 4
    grid = [[0] * w for _ in range(h)]
    for cy, row in enumerate(rows):
        for cx, ch in enumerate(row):
            v = ord(ch) - 0x2800
            if not 0 <= v <= 0xFF:
                continue
            for dx, dy, bit in BITS:
                if v & bit:
                    grid[cy * 4 + dy][cx * 2 + dx] = 1
    return grid
