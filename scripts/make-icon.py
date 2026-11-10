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

def doc_icon(size):
    """.pdf file icon: a black page with a folded corner, the finger on it, PDF label when there's room."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    big = size >= 48
    w = size * 0.80
    x0, y0 = (size - w) / 2, size * 0.03
    x1, y1 = x0 + w, size * 0.97
    fold = w * 0.26
    line = max(1, round(size / 64))
    page = [(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)]
    d.polygon(page, fill=(0, 0, 0, 255))
    d.line(page + [page[0]], fill=(255, 255, 255, 255), width=line, joint="curve")
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(150, 150, 150, 255))
    d.line([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(255, 255, 255, 255), width=line)
    label_h = size * 0.20 if big else 0
    avail_h = (y1 - y0) - fold * 0.55 - label_h - size * 0.06
    f = finger(int(avail_h), 0.42 if size >= 128 else 0.8)
    fx = int((size - f.width) / 2)
    fy = int(y0 + fold * 0.55 + size * 0.03)
    im.alpha_composite(f, (fx, fy))
    if big:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", max(8, int(size * 0.15)))
        d.text((size / 2, y1 - label_h / 2 - size * 0.015), "PDF", font=font, fill=(255, 255, 255, 255), anchor="mm")
    return im

os.makedirs("build", exist_ok=True)
icons = {s: icon(s) for s in (256, 128, 64, 48, 32, 24, 16)}
icons[256].save("build/icon.png")
icon(512).save("build/icon-512.png")
icons[256].save("build/icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)],
                append_images=[icons[s] for s in (16, 24, 32, 48, 64, 128)])

docs = {s: doc_icon(s) for s in (256, 128, 64, 48, 32, 24, 16)}
docs[256].save("build/pdf-file.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)],
               append_images=[docs[s] for s in (16, 24, 32, 48, 64, 128)])
docs[256].save("build/pdf-file.png")

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
for bg in ((255, 255, 255, 255), (32, 32, 32, 255)):
    st = Image.new("RGBA", (256 + 128 + 64 + 48 + 32 + 24 + 16 + 90, 262), bg)
    x = 5
    for s_ in (256, 128, 64, 48, 32, 24, 16):
        st.alpha_composite(docs[s_], (x, 3)); x += s_ + 12
    st.save("/tmp/doc-preview-%s.png" % ("light" if bg[0] > 128 else "dark"))
print("icons + hero ok")
