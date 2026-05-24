#!/usr/bin/env python3
"""Batch-process raw crest art into app-ready assets.

Reads source images from  mobile/assets/crests/raw/<tier>.<ext>  (jpg/jpeg/png/
webp), removes the background (rembg / U2Net), applies optional per-tier hue
nudges, trims to the emblem, pads to a transparent square, resizes to 512x512,
and writes  mobile/assets/crests/<tier>.png.

Run:   py -3.11 mobile/assets/crests/_process.py
Re-run any time you regenerate the art (replace files in raw/).
"""
import os, glob, sys
import numpy as np
from PIL import Image
from rembg import remove, new_session

TIERS = ['wood', 'bronze', 'silver', 'gold', 'platinum', 'ruby', 'diamond', 'obsidian']
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
SIZE = 512

# Per-tier distinction nudges.
#   HUE  — selective hue rotation of mid-saturation pixels in a band (PIL's
#          0-255 hue scale). Good when the art already has a colored accent.
#   BAL  — global R/G/B channel multiply. Good for near-neutral metal that a
#          hue shift can't grab (e.g. silvery platinum -> green patina).
HUE_TINTS = {
    'diamond': (140, 185, 30, 45),   # steel-blue -> more purple
}
BAL_TINTS = {
    'platinum': (0.87, 1.10, 0.93),  # green patina over the silver
}

session = new_session()  # default u2net model


def hue_tint(img, lo, hi, delta, sat_min):
    h, s, v = img.convert('RGB').convert('HSV').split()
    H = np.array(h, dtype=np.int16)
    S = np.array(s)
    mask = (H >= lo) & (H < hi) & (S >= sat_min)
    H[mask] = np.clip(H[mask] + delta, 0, 255)
    h2 = Image.fromarray(H.astype('uint8'), 'L')
    out = Image.merge('HSV', (h2, s, v)).convert('RGBA')
    out.putalpha(img.split()[-1])
    return out


def color_balance(img, rf, gf, bf):
    r, g, b, a = img.split()
    r = r.point(lambda x: min(255, int(x * rf)))
    g = g.point(lambda x: min(255, int(x * gf)))
    b = b.point(lambda x: min(255, int(x * bf)))
    return Image.merge('RGBA', (r, g, b, a))


def find_src(tier):
    for ext in ('png', 'jpg', 'jpeg', 'webp'):
        hits = glob.glob(os.path.join(RAW, f'{tier}.{ext}'))
        if hits:
            return hits[0]
    return None


def process(src, tier):
    img = Image.open(src).convert('RGBA')
    cut = remove(img, session=session, post_process_mask=True)
    if tier in HUE_TINTS:
        cut = hue_tint(cut, *HUE_TINTS[tier])
    if tier in BAL_TINTS:
        cut = color_balance(cut, *BAL_TINTS[tier])
    bbox = cut.split()[-1].getbbox()
    if bbox:
        cut = cut.crop(bbox)
    w, h = cut.size
    side = max(w, h)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(cut, ((side - w) // 2, (side - h) // 2), cut)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    if not os.path.isdir(RAW):
        print(f'No raw/ folder at {RAW} — create it and drop <tier>.jpg files in.')
        sys.exit(1)
    done = 0
    for tier in TIERS:
        src = find_src(tier)
        if not src:
            print(f'  - {tier}: no source found, skipped')
            continue
        process(src, tier).save(os.path.join(HERE, f'{tier}.png'))
        done += 1
        print(f'  OK {tier}: {os.path.basename(src)} -> {tier}.png')
    print(f'\nDone: {done}/{len(TIERS)} -> {HERE}')


if __name__ == '__main__':
    main()
