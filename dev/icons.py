#!/usr/bin/env python3
"""Draw the Kehikot app icon and write every icon file the bundle uses.

    python3 dev/icons.py          # writes app-icon.png and src-tauri/icons/*

The icon is drawn, not scaled: each size is rendered from the geometry below,
so small sizes get a slightly heavier stroke and a slightly larger cube
instead of a blurred-down 1024 image.

Shape: Apple's macOS app icon grid. On a 1024 canvas the body is an 824 x 824
rounded rectangle with continuous ("squircle") corners, centred, leaving 100 px
of transparent margin around it, with a soft drop shadow in that margin.
macOS 26 and later put an icon that does not have this shape on a grey plate
and shrink it; one that has it is shown at full size.

Needs Pillow, and macOS `iconutil` for the .icns.
"""
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

BODY_COLOR = (28, 29, 34, 255)     # the original's dark ground, #1c1d22
LINE_COLOR = (232, 228, 218, 255)  # the original's cream, #e8e4da

# Apple's grid, as fractions of the canvas.
BODY = 824 / 1024      # body width
CORNER = 185.4 / 1024  # nominal corner radius
SMOOTH = 1.528         # a continuous corner starts this many radii from the edge
EXPONENT = 2.9         # superellipse exponent of the corner curve

# The cube, as in the original drawing: two squares offset diagonally, joined at
# the corners. On a 768-unit cube the offset was 190 and the stroke 44.
OFFSET = 190 / 768
STROKE = 0.062         # stroke as a fraction of the cube (original 0.057)
CUBE = 0.60            # cube as a fraction of the body: ~20% padding each side

SS = 4                 # supersampling


def cube_for(px: int) -> tuple[float, float]:
    """Cube size (fraction of the body) and minimum stroke in output pixels."""
    if px <= 16:
        return 0.72, 1.35
    if px <= 32:
        return 0.68, 1.6
    if px <= 64:
        return 0.64, 2.0
    return CUBE, 0.0


def body_mask(size: int, inset: float, side: float) -> Image.Image:
    """A squircle of width `side` at offset `inset` on a size x size canvas."""
    m = Image.new("L", (size, size), 0)
    c = min(CORNER / BODY * side * SMOOTH, side / 2)
    pts = []
    steps = 90
    # Corners clockwise from top-right; each corner is a superellipse quadrant.
    centres = [
        (inset + side - c, inset + c, 1, -1),
        (inset + side - c, inset + side - c, 1, 1),
        (inset + c, inset + side - c, -1, 1),
        (inset + c, inset + c, -1, -1),
    ]
    starts = [-90, 0, 90, 180]
    for (cx, cy, _, _), a0 in zip(centres, starts):
        for i in range(steps + 1):
            a = math.radians(a0 + 90 * i / steps)
            ca, sa = math.cos(a), math.sin(a)
            x = math.copysign(abs(ca) ** (2 / EXPONENT), ca)
            y = math.copysign(abs(sa) ** (2 / EXPONENT), sa)
            pts.append((cx + c * x, cy + c * y))
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def draw_cube(draw: ImageDraw.ImageDraw, x0: float, y0: float, s: float, t: float) -> None:
    o = OFFSET * s
    h = t / 2
    # Centre lines of the front and back squares.
    front = (x0 + h, y0 + o + h, x0 + s - o - h, y0 + s - h)
    back = (x0 + o + h, y0 + h, x0 + s - h, y0 + s - o - h)

    def square(l, tp, r, b):
        draw.rectangle((l - h, tp - h, r + h, b + h), fill=LINE_COLOR)
        draw.rectangle((l + h, tp + h, r - h, b - h), fill=BODY_COLOR)

    def join(p, q):
        dx, dy = q[0] - p[0], q[1] - p[1]
        n = math.hypot(dx, dy)
        nx, ny = -dy / n * h, dx / n * h
        draw.polygon(
            [(p[0] + nx, p[1] + ny), (q[0] + nx, q[1] + ny),
             (q[0] - nx, q[1] - ny), (p[0] - nx, p[1] - ny)],
            fill=LINE_COLOR,
        )

    square(*back)
    square(*front)
    # Redraw the back square's edges that the front square's fill covered:
    # it is a wireframe, every edge shows.
    l, tp, r, b = back
    draw.rectangle((l - h, tp - h, l + h, b + h), fill=LINE_COLOR)
    draw.rectangle((l - h, b - h, r + h, b + h), fill=LINE_COLOR)
    fl, ft, fr, fb = front
    for p, q in (((fl, ft), (l, tp)), ((fr, ft), (r, tp)),
                 ((fr, fb), (r, b)), ((fl, fb), (l, b))):
        join(p, q)
    # Square off the corners where a join meets a square.
    for x, y in ((fl, ft), (fr, ft), (fr, fb), (fl, fb), (l, tp), (r, tp), (r, b), (l, b)):
        draw.rectangle((x - h, y - h, x + h, y + h), fill=LINE_COLOR)


def render(px: int, shadow: bool = True) -> Image.Image:
    size = px * SS
    side = BODY * size
    inset = (size - side) / 2
    frac, min_stroke = cube_for(px)

    art = Image.new("RGBA", (size, size), BODY_COLOR)
    s = frac * side
    t = max(STROKE * s, min_stroke * SS)
    draw_cube(ImageDraw.Draw(art), (size - s) / 2, (size - s) / 2, s, t)

    mask = body_mask(size, inset, side)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if shadow and px >= 32:
        # Apple's template: a soft shadow straight down, inside the margin.
        sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        offset = round(0.0098 * size)
        sm = ImageChops.offset(mask, 0, offset).point(lambda v: v * 0.5)
        sh.putalpha(sm.filter(ImageFilter.GaussianBlur(0.0098 * size)))
        out = Image.alpha_composite(out, sh)
    body = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    body.paste(art, (0, 0), mask)
    out = Image.alpha_composite(out, body)
    return out.resize((px, px), Image.LANCZOS)


def main() -> int:
    master = render(1024)
    master.save(ROOT / "app-icon.png")
    render(512).save(ICONS / "icon.png")

    for name, px in {
        "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256,
        "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310, "StoreLogo.png": 50,
    }.items():
        render(px).save(ICONS / name)

    ico = [render(px) for px in (16, 24, 32, 48, 64, 128, 256)]
    ico[-1].save(ICONS / "icon.ico", sizes=[(i.width, i.height) for i in ico],
                 append_images=ico[:-1])

    if shutil.which("iconutil") is None:
        print("iconutil not found: icon.icns left as it was", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            render(base).save(iconset / f"icon_{base}x{base}.png")
            render(base * 2).save(iconset / f"icon_{base}x{base}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICONS / "icon.icns")],
                       check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
