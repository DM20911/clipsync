#!/usr/bin/env python3
"""Generate ClipSync PWA icons (192, 512) — minimal Signal Topology aesthetic."""
from PIL import Image, ImageDraw, ImageFilter
import math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'client-pwa')
BG    = (6, 10, 18)
AMBER = (244, 162, 45)

def make(size):
    img = Image.new('RGBA', (size, size), (*BG, 255))
    base = img.copy()
    d = ImageDraw.Draw(base)
    cx = cy = size // 2
    R = int(size * 0.28)
    # Octagon
    pts = [(cx + R*math.cos(math.radians(45*i + 22.5)),
            cy + R*math.sin(math.radians(45*i + 22.5))) for i in range(8)]
    # Glow layer
    glow = Image.new('RGBA', (size, size), (0,0,0,0))
    gd = ImageDraw.Draw(glow)
    for r, a in [(R+int(size*0.15), 25), (R+int(size*0.08), 50)]:
        gpts = [(cx + r*math.cos(math.radians(45*i + 22.5)),
                 cy + r*math.sin(math.radians(45*i + 22.5))) for i in range(8)]
        gd.polygon(gpts, fill=(*AMBER, a))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(size*0.06)))
    base = Image.alpha_composite(base, glow)
    # Octagon fill on top
    d2 = ImageDraw.Draw(base)
    d2.polygon(pts, fill=(*AMBER, 255))
    d2.polygon(pts, outline=(255, 220, 110, 220), width=max(2, size // 96))
    return base.convert('RGB')

for s in (192, 512):
    p = os.path.join(OUT, f'icon-{s}.png')
    make(s).save(p, 'PNG')
    print(f'wrote {p}')
