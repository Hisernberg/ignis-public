#!/usr/bin/env python3
"""IGNIS brand suite generator.
Builds the scan-flame mark, wordmark (text->paths), lockups, banner, og-image,
icons + PNG renders. Pure-SVG output (all text converted to paths, no CSS,
no filters) so GitHub + cairosvg render identically.
"""
import math
import random
from pathlib import Path

import cairosvg
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform
from fontTools.ttLib import TTFont
from PIL import Image

OUT = Path("/home/z/my-project/download/ignis-brand")
SVG = OUT / "svg"
PNG = OUT / "png"
ICO = OUT / "icons"
for d in (SVG, PNG, ICO):
    d.mkdir(parents=True, exist_ok=True)

FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

# ---------------------------------------------------------------- palette
NIGHT = "#0B0E17"
BORDER = "#22304C"
TEXT_D = "#F2F5FA"   # text on dark
TEXT_L = "#10141F"   # text on light
MUTED_D = "#8B95A9"
MUTED_L = "#5A6478"
META_D = "#6B7689"
SPARK = "#FFE49A"
ORBIT = "#4DA8DA"
# scan-band colors bottom -> top (heat scale)
RAMP = ["#E03A0C", "#FF5A1F", "#FF7A2E", "#FFA02E", "#FFC53D", "#FFE49A"]

# ---------------------------------------------------------------- flame master path
# Leaning teardrop flame in a 512-box, pointed tip top-right, rounded base.
FLAME_D = (
    "M 296 44 "
    "C 302 102 332 142 354 198 "
    "C 376 256 372 322 336 376 "
    "C 306 420 268 446 232 456 "
    "C 176 470 136 428 142 372 "
    "C 148 318 194 294 208 242 "
    "C 220 196 242 118 296 44 Z"
)
# scan bands (bottom -> top) as (y0, y1); gaps 18px
BANDS = [(366, 466), (284, 348), (210, 266), (144, 192), (88, 126), (40, 70)]


def mark_group(scale=1.0, tx=0.0, ty=0.0, uid="m") -> str:
    """Scan-flame mark: real flame silhouette sliced into data bands; the
    detached top sliver is the rising 'hotspot spark'."""
    parts = [f'<g transform="translate({tx} {ty}) scale({scale})">']
    for i, ((y0, y1), color) in enumerate(zip(BANDS, RAMP)):
        parts.append(
            f'<clipPath id="s{uid}{i}"><rect x="90" y="{y0}" width="340" height="{y1-y0}"/></clipPath>'
            f'<g clip-path="url(#s{uid}{i})"><path d="{FLAME_D}" fill="{color}"/></g>'
        )
    parts.append("</g>")
    return "".join(parts)


def solid_group(scale=1.0, tx=0.0, ty=0.0) -> str:
    """Solid one-piece flame (favicon / tiny sizes)."""
    defs = (
        '<defs><linearGradient id="fg" x1="0" y1="1" x2="0" y2="0">'
        '<stop offset="0" stop-color="#E03A0C"/>'
        '<stop offset="0.38" stop-color="#FF5A1F"/>'
        '<stop offset="0.72" stop-color="#FFA02E"/>'
        '<stop offset="1" stop-color="#FFD34D"/>'
        "</linearGradient></defs>"
    )
    return (
        f'<g transform="translate({tx} {ty}) scale({scale})">{defs}'
        f'<path d="{FLAME_D}" fill="url(#fg)" stroke="url(#fg)" stroke-width="10" '
        f'stroke-linejoin="round"/></g>'
    )


def svg_doc(w: int, h: int, body: str, bg: str | None = None, rx: int = 0) -> str:
    bg_rect = ""
    if bg:
        bg_rect = f'<rect x="0" y="0" width="{w}" height="{h}" rx="{rx}" fill="{bg}"/>'
        if rx:
            bg_rect += (
                f'<rect x="0.75" y="0.75" width="{w-1.5}" height="{h-1.5}" rx="{rx}" '
                f'fill="none" stroke="{BORDER}" stroke-width="1.5"/>'
            )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'width="{w}" height="{h}">{bg_rect}{body}</svg>'
    )


# ---------------------------------------------------------------- wordmark (text -> path)
_font = TTFont(FONT_BOLD)
_glyphs = _font.getGlyphSet()
_cmap = _font.getBestCmap()
_upem = _font["head"].unitsPerEm
_cap = getattr(_font["OS/2"], "sCapHeight", int(_upem * 0.72))


def text_path(text: str, cap_px: float, x: float, baseline: float,
              tracking_em: float = 0.0, fill: str = TEXT_D) -> tuple[str, float]:
    s = cap_px / _cap
    tracking = tracking_em * cap_px
    d_parts, pen_x = [], x
    for ch in text:
        gname = _cmap.get(ord(ch))
        if gname is None:
            raise ValueError(f"glyph missing in font: {ch!r}")
        glyph = _glyphs[gname]
        spen = SVGPathPen(_glyphs, ntos=lambda v: f"{v:.1f}")
        tp = TransformPen(spen, Transform(s, 0, 0, -s, pen_x, baseline))
        glyph.draw(tp)
        d = spen.getCommands()
        if d:
            d_parts.append(d)
        pen_x += glyph.width * s + tracking
    width = (pen_x - tracking) - x
    return f'<path d="{" ".join(d_parts)}" fill="{fill}"/>', width


def text_width(text: str, cap_px: float, tracking_em: float = 0.0) -> float:
    s = cap_px / _cap
    tracking = tracking_em * cap_px
    return sum(_glyphs[_cmap[ord(c)]].width * s for c in text) + tracking * (len(text) - 1)


def fit(text: str, cap: float, track: float, max_w: float) -> tuple[float, float]:
    """Shrink cap-size + tracking proportionally until text fits max_w."""
    w = text_width(text, cap, track)
    if w > max_w:
        k = max_w / w
        cap, track = cap * k, track * k
    return cap, track


# ---------------------------------------------------------------- decorations
def sparkle(x: float, y: float, r=6.0, fill=SPARK, op=0.6) -> str:
    k = r * 0.32
    return (f'<path d="M{x:.1f} {y-r:.1f} L{x+k:.1f} {y-k:.1f} L{x+r:.1f} {y:.1f} '
            f'L{x+k:.1f} {y+k:.1f} L{x:.1f} {y+r:.1f} L{x-k:.1f} {y+k:.1f} '
            f'L{x-r:.1f} {y:.1f} L{x-k:.1f} {y-k:.1f} Z" fill="{fill}" opacity="{op}"/>')


def starfield(w: int, h: int, seed=7, n=70) -> str:
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        x, y = rng.uniform(8, w - 8), rng.uniform(8, h - 8)
        r = rng.choice([0.9, 1.1, 1.4, 1.8])
        op = rng.uniform(0.12, 0.45)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="#DFE7F5" opacity="{op:.2f}"/>')
    for _ in range(4):
        x, y = rng.uniform(30, w - 30), rng.uniform(24, h - 24)
        out.append(sparkle(x, y, rng.choice([5, 6, 8]), op=rng.uniform(0.28, 0.5)))
    return "".join(out)


def grid(w: int, h: int, step=64) -> str:
    out = []
    for x in range(step, w, step):
        out.append(f'<line x1="{x}" y1="0" x2="{x}" y2="{h}" stroke="#FFFFFF" opacity="0.03" stroke-width="1"/>')
    for y in range(step, h, step):
        out.append(f'<line x1="0" y1="{y}" x2="{w}" y2="{y}" stroke="#FFFFFF" opacity="0.03" stroke-width="1"/>')
    return "".join(out)


def orbit(cx_: float, cy_: float, rx: float, ry: float, rot: float) -> str:
    """Thin elliptical orbit + satellite dot, drawn behind the flame."""
    th = math.radians(-38)
    px, py = cx_ + rx * math.cos(th), cy_ + ry * math.sin(th)
    ca, sa = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    qx = cx_ + (px - cx_) * ca - (py - cy_) * sa
    qy = cy_ + (px - cx_) * sa + (py - cy_) * ca
    return (
        f'<g transform="rotate({rot} {cx_} {cy_})" opacity="0.55">'
        f'<ellipse cx="{cx_}" cy="{cy_}" rx="{rx}" ry="{ry}" fill="none" '
        f'stroke="{ORBIT}" stroke-width="3.5" opacity="0.55"/>'
        f"</g>"
        f'<circle cx="{qx:.1f}" cy="{qy:.1f}" r="7" fill="{ORBIT}"/>'
        f'<circle cx="{qx:.1f}" cy="{qy:.1f}" r="12" fill="{ORBIT}" opacity="0.25"/>'
    )


# ---------------------------------------------------------------- compositions
def build_all():
    files = {}

    # 1. mark (transparent, dark-context optimized)
    files["ignis-mark.svg"] = svg_doc(512, 512, mark_group(uid="a"))

    # 2. solid flame (icons)
    files["ignis-mark-solid.svg"] = svg_doc(512, 512, solid_group(0.92, 22, 30))

    # 3. horizontal lockup (dark variant)
    w1 = text_width("IGNIS", 112, 0.16)
    w2 = text_width("EARTH\u2019S BURNING ACTIVITY CALENDAR", 26, 0.30)
    W = int(310 + max(w1, w2) + 30)
    body = [mark_group(0.50, 20, 18, uid="l")]
    wm, _ = text_path("IGNIS", 112, 310, 172, 0.16, TEXT_D)
    tg, _ = text_path("EARTH\u2019S BURNING ACTIVITY CALENDAR", 26, 314, 224, 0.30, MUTED_D)
    body += [wm, tg]
    files["ignis-lockup-horizontal.svg"] = svg_doc(W, 300, "".join(body))

    # 4. horizontal lockup (light variant)
    body = [mark_group(0.50, 20, 18, uid="k")]
    wm, _ = text_path("IGNIS", 112, 310, 172, 0.16, TEXT_L)
    tg, _ = text_path("EARTH\u2019S BURNING ACTIVITY CALENDAR", 26, 314, 224, 0.30, MUTED_L)
    body += [wm, tg]
    files["ignis-lockup-horizontal-light.svg"] = svg_doc(W, 300, "".join(body))

    # 5. pure wordmark (dark + light)
    wm, w = text_path("IGNIS", 160, 10, 180, 0.16, TEXT_D)
    files["ignis-wordmark.svg"] = svg_doc(int(w + 20), 200, wm)
    wm, w = text_path("IGNIS", 160, 10, 180, 0.16, TEXT_L)
    files["ignis-wordmark-light.svg"] = svg_doc(int(w + 20), 200, wm)

    # 6. README banner 1200x300
    body = [grid(1200, 300), starfield(1200, 300, seed=11, n=80)]
    body.append(orbit(158, 158, 186, 68, -16))
    body.append(mark_group(0.50, 30, 30, uid="b"))
    tc, tr = fit("EARTH\u2019S BURNING ACTIVITY CALENDAR", 24, 0.30, 1200 - 352 - 36)
    mc, mr = fit("MODIS + VIIRS \u00b7 26-YEAR RECORD \u00b7 NASA SPACE APPS 2026", 15, 0.26, 1200 - 352 - 36)
    wm, _ = text_path("IGNIS", 104, 352, 156, 0.17, TEXT_D)
    tg, _ = text_path("EARTH\u2019S BURNING ACTIVITY CALENDAR", tc, 352, 202, tr, MUTED_D)
    mt, _ = text_path("MODIS + VIIRS \u00b7 26-YEAR RECORD \u00b7 NASA SPACE APPS 2026",
                      mc, 352, 246, mr, META_D)
    body += [wm, tg, mt]
    files["ignis-banner.svg"] = svg_doc(1200, 300, "".join(body), bg=NIGHT, rx=26)

    # 7. og-image 1200x630
    body = [grid(1200, 630, 72), starfield(1200, 630, seed=23, n=110)]
    body.append(orbit(600, 240, 330, 108, -14))
    body.append(mark_group(0.50, 472, 34, uid="o"))
    w1 = text_width("IGNIS", 128, 0.17)
    wm, _ = text_path("IGNIS", 128, 600 - w1 / 2, 425, 0.17, TEXT_D)
    c2, r2 = fit("EARTH\u2019S BURNING ACTIVITY CALENDAR", 27, 0.30, 1060)
    w2 = text_width("EARTH\u2019S BURNING ACTIVITY CALENDAR", c2, r2)
    tg, _ = text_path("EARTH\u2019S BURNING ACTIVITY CALENDAR", c2, 600 - w2 / 2, 486, r2, MUTED_D)
    c3, r3 = fit("NASA SPACE APPS CHALLENGE 2026 \u00b7 CHALLENGE #9 \u00b7 MODIS + VIIRS HARMONIZATION",
                 15, 0.24, 1100)
    w3 = text_width("NASA SPACE APPS CHALLENGE 2026 \u00b7 CHALLENGE #9 \u00b7 MODIS + VIIRS HARMONIZATION", c3, r3)
    mt, _ = text_path("NASA SPACE APPS CHALLENGE 2026 \u00b7 CHALLENGE #9 \u00b7 MODIS + VIIRS HARMONIZATION",
                      c3, 600 - w3 / 2, 545, r3, META_D)
    body += [wm, tg, mt]
    files["og-image.svg"] = svg_doc(1200, 630, "".join(body), bg=NIGHT)

    # 8. app icon tile (rounded night square + solid flame)
    body = [solid_group(0.78, 54, 56)]
    files["ignis-icon-tile.svg"] = svg_doc(512, 512, body, bg=NIGHT, rx=96)

    for name, svg in files.items():
        (SVG / name).write_text(svg)
    return files


# ---------------------------------------------------------------- PNG renders
def render(files: dict):
    jobs = [
        ("ignis-mark.svg", PNG / "ignis-mark-512.png", 512, 512),
        ("ignis-mark.svg", PNG / "ignis-mark-1024.png", 1024, 1024),
        ("ignis-mark-solid.svg", PNG / "ignis-mark-solid-512.png", 512, 512),
        ("ignis-lockup-horizontal.svg", PNG / "ignis-lockup-horizontal.png", None, 600),
        ("ignis-banner.svg", PNG / "ignis-banner.png", 2400, 600),
        ("og-image.svg", OUT / "og-image.png", 1200, 630),
        ("ignis-icon-tile.svg", PNG / "ignis-icon-tile-512.png", 512, 512),
    ]
    for src, dst, w, h in jobs:
        cairosvg.svg2png(url=str(SVG / src), write_to=str(dst), output_width=w, output_height=h)

    for s in (16, 32, 48, 64, 128, 256):
        cairosvg.svg2png(url=str(SVG / "ignis-mark-solid.svg"),
                         write_to=str(ICO / f"icon-{s}.png"), output_width=s, output_height=s)
    for s, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
        cairosvg.svg2png(url=str(SVG / "ignis-icon-tile.svg"),
                         write_to=str(ICO / name), output_width=s, output_height=s)
    cairosvg.svg2png(url=str(SVG / "ignis-icon-tile.svg"),
                     write_to=str(ICO / "maskable-512.png"), output_width=512, output_height=512)
    imgs = [Image.open(ICO / f"icon-{s}.png").convert("RGBA") for s in (16, 32, 48)]
    imgs[0].save(ICO / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
                 append_images=imgs[1:])


if __name__ == "__main__":
    files = build_all()
    render(files)
    print(f"generated {len(files)} SVGs + renders in {OUT}")
