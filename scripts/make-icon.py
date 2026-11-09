"""fuck pdf icon + README hero, drawn from the braille middle finger (build/finger-braille.txt).
Big sizes show the real dots; tiny sizes fatten them into a solid silhouette."""
import os, sys
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(__file__))
from braille import dots

G = dots()
GH, GW = len(G), len(G[0])
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

def finger(height, radius_frac, color=(255, 255, 255, 255)):
    """Render the dot grid so it is `height` px tall. Drawn 4x then downsampled."""
    s = height * 4 / GH
    w, h = int(GW * s) + 2, int(GH * s) + 2
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = s * radius_frac
    for y in range(GH):
        row = G[y]
        for x in range(GW):
            if row[x]:
                cx, cy = (x + 0.5) * s, (y + 0.5) * s
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    return im.resize((max(1, w // 4), max(1, h // 4)), Image.LANCZOS)

def icon(size):
    big = size >= 128
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.18, fill=(0, 0, 0, 255),
                        outline=(255, 255, 255, 255) if big else None, width=max(1, size // 96))
    f = finger(int(size * (0.84 if big else 0.92)), 0.42 if big else 0.78)
    im.alpha_composite(f, ((size - f.width) // 2, (size - f.height) // 2 + (1 if not big else 0)))
    return im

os.makedirs("build", exist_ok=True)
icons = {s: icon(s) for s in (256, 128, 64, 48, 32, 24, 16)}
icons[256].save("build/icon.png")
icon(512).save("build/icon-512.png")
icons[256].save("build/icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)],
                append_images=[icons[s] for s in (16, 24, 32, 48, 64, 128)])

# README hero: finger + slant banner, white on black
banner = open("build/banner.txt", encoding="utf-8").read().rstrip("\n").split("\n")
W, H = 1280, 560
hero = Image.new("RGB", (W, H), (0, 0, 0))
f = finger(470, 0.40)
hero.paste(f, (90, (H - f.height) // 2), f)
font = ImageFont.truetype(MONO, 26)
d = ImageDraw.Draw(hero)
lh = 31
bx, by = 470, 150
for i, line in enumerate(banner):
    d.text((bx, by + i * lh), line, font=font, fill=(255, 255, 255))
small = ImageFont.truetype(MONO, 20)
tag = ["free pdf editor for windows.", "no subscription. no account. no watermark. no bullshit."]
for i, t in enumerate(tag):
    d.text((bx + 4, by + len(banner) * lh + 40 + i * 30), t, font=small, fill=(150, 150, 150))
os.makedirs("docs", exist_ok=True)
hero.save("docs/logo.png", optimize=True)

strip = Image.new("RGBA", (256 + 128 + 64 + 48 + 32 + 16 + 70, 262), (60, 60, 60, 255))
x = 5
for s in (256, 128, 64, 48, 32, 16):
    strip.alpha_composite(icons[s], (x, 3)); x += s + 10
strip.save("/tmp/icon-preview.png")
print("icons + hero ok")
