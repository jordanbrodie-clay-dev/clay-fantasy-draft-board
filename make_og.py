#!/usr/bin/env python3
"""Generate the 1200x630 Open Graph preview card."""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BG, SURF, LINE = (14, 13, 18), (22, 21, 28), (40, 39, 52)
TEXT, MUTED, MATCHA, BRICK, BLUE = (236, 234, 242), (156, 152, 172), (127, 176, 105), (181, 84, 74), (107, 143, 199)

def font(sz, bold=False):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
              "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

W, H = 1200, 630
im = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(im)

d.rectangle([0, 0, W, 6], fill=MATCHA)
d.text((64, 60), "CLAY WORKFLOWS  ·  REDRAFT", font=font(20, True), fill=MATCHA)
d.text((64, 104), "Clay (Unofficial)", font=font(60, True), fill=TEXT)
d.text((64, 172), "Fantasy Football Draft Board", font=font(60, True), fill=TEXT)
d.text((64, 258), "200 players scored by a model built on Clay workflows.", font=font(26), fill=MUTED)
d.text((64, 294), "2026 half-PPR redraft  ·  draft live from the board", font=font(26), fill=MUTED)

# stat tiles
tiles = [("200", "players", TEXT), ("28", "targets", MATCHA), ("22", "fades", BRICK), ("17", "values", BLUE)]
x, y, tw, th = 64, 372, 250, 118
for i, (v, lbl, col) in enumerate(tiles):
    tx = x + i * (tw + 14)
    d.rounded_rectangle([tx, y, tx + tw, y + th], radius=14, fill=SURF, outline=LINE)
    d.text((tx + 22, y + 22), v, font=font(46, True), fill=col)
    d.text((tx + 22, y + 78), lbl, font=font(22), fill=MUTED)

d.text((64, 540), "Jordan Brodie", font=font(28, True), fill=TEXT)
d.text((64, 578), "Usage · vacated volume · weekly splits · coach sentiment · backtested vs 5 seasons of ADP",
       font=font(20), fill=MUTED)

im.save(os.path.join(HERE, "og.png"), optimize=True)
print("og.png written", im.size)
