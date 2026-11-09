"""Build the fuck pdf icon: a middle finger, white on black.
Big sizes are drawn out of ASCII '#' characters, small sizes are a solid silhouette."""
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 1024
FONT = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

def silhouette():
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    r = 70
    # middle finger
    d.rounded_rectangle([430, 90, 594, 640], radius=82, fill=255)
    # folded index / ring / pinky (knuckles)
    d.rounded_rectangle([262, 400, 418, 660], radius=r, fill=255)
    d.rounded_rectangle([606, 400, 762, 660], radius=r, fill=255)
    d.rounded_rectangle([774, 450, 900, 680], radius=60, fill=255)
    # palm
    d.rounded_rectangle([262, 560, 900, 880], radius=120, fill=255)
    # thumb, folded across
    d.rounded_rectangle([150, 560, 330, 820], radius=90, fill=255)
    d.polygon([(200, 760), (560, 760), (560, 880), (330, 880)], fill=255)
    # wrist
    d.rectangle([340, 860, 840, 1000], fill=255)
    # gaps between fingers so it reads at small sizes
    g = 18
    for x in (418, 594, 762):
        d.rectangle([x, 380, x + g, 640], fill=0)
    d.line([(240, 700), (520, 760)], fill=0, width=g)  # thumb crease
    return m

def ascii_render(mask, size, cols):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * 0.04
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.18, fill=(0, 0, 0, 255), outline=(255, 255, 255, 255), width=max(1, size // 64))
    cell = (size - 2 * pad) / cols
    font = ImageFont.truetype(FONT, int(cell * 1.25))
    small = mask.resize((cols, cols), Image.BILINEAR)
    px = small.load()
    for y in range(cols):
        for x in range(cols):
            v = px[x, y]
            if v > 110:
                ch = "#" if v > 200 else "+"
                cx = pad + x * cell + cell / 2
                cy = pad + y * cell + cell / 2
                d.text((cx, cy), ch, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return img

def solid_render(mask, size):
    big = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.18, fill=(0, 0, 0, 255))
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    big.paste(white, (0, 0), mask)
    return big.resize((size, size), Image.LANCZOS)

mask = silhouette()
out = {}
for size, cols in ((256, 26), (128, 20)):
    out[size] = ascii_render(mask, size, cols)
for size in (64, 48, 32, 24, 16):
    out[size] = solid_render(mask, size)
out[256].save("build/icon.png")
ascii_render(mask, 512, 34).save("build/icon-512.png")
out[256].save("build/icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)], append_images=[out[s] for s in (16, 24, 32, 48, 64, 128)])
# preview strip
strip = Image.new("RGBA", (256 + 128 + 64 + 48 + 32 + 16 + 70, 260), (40, 40, 40, 255))
x = 5
for s in (256, 128, 64, 48, 32, 16):
    strip.paste(out[s], (x, 2), out[s]); x += s + 10
strip.save("scratch/icon-preview.png")
print("icons ok")
