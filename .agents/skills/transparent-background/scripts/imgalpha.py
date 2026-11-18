#!/usr/bin/env python3
"""imgalpha: turn an image with a flat background into a clean transparent PNG.

Subcommands (run with uv, nothing installed globally):
  remove      background -> transparent, smooth edges without a halo
  specks      find (--mark) or fill (-o) leftover background pixels inside dark areas
  components  list separate shapes (id, bbox, size, mean colour)
  recolor     recolour shapes, keeping their texture
  preview     composite on a colour, with zoomed crops / circles, to inspect results

  uv run --python 3.12 --with pillow --with numpy --with scipy \\
    python -I imgalpha.py remove in.jpg -o out.png
"""

import argparse
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

EIGHT = np.ones((3, 3), bool)


# ---------- parsing / io ----------


def parse_color(s):
    """'#rrggbb' or 'r,g,b' -> (r, g, b)."""
    s = s.strip()
    if s.startswith("#") and len(s) == 7:
        return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
    parts = s.split(",")
    if len(parts) == 3:
        return tuple(int(p) for p in parts)
    raise ValueError(f"bad colour {s!r}: use #rrggbb or r,g,b")


def parse_point(s):
    """'x,y' or 'x,y,size' -> tuple of ints."""
    parts = [int(p) for p in s.split(",")]
    if len(parts) not in (2, 3):
        raise ValueError(f"bad point {s!r}: use x,y or x,y,size")
    return tuple(parts)


def parse_box(s):
    parts = [int(p) for p in s.split(",")]
    if len(parts) != 4:
        raise ValueError(f"bad region {s!r}: use x0,y0,x1,y1")
    return tuple(parts)


def load_rgba(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float32)


def save_rgba(arr, path):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA").save(path, optimize=True)


def _dist(rgb, color):
    """Chebyshev distance of every pixel to a colour."""
    return np.abs(rgb - np.asarray(color, np.float32)).max(-1)


def _sat(rgb):
    return rgb.max(-1) - rgb.min(-1)


# ---------- remove ----------


def estimate_bg(rgb, border=4):
    """Median colour of the outer border strip."""
    strip = np.concatenate([
        rgb[:border].reshape(-1, 3), rgb[-border:].reshape(-1, 3),
        rgb[:, :border].reshape(-1, 3), rgb[:, -border:].reshape(-1, 3),
    ])
    return np.median(strip, axis=0).astype(np.float32)


def bg_mask(rgb, bg, tol=23, gap_chroma=3.0, gap_min_area=150):
    """Background = pixels within `tol` of the bg colour that touch the border,
    plus enclosed gaps (between hair strands, inside the arm...) that have the
    bg's hue (chroma deviation <= gap_chroma) and no hole. Skin is tinted (higher
    chroma) and rings such as hair clips have a hole, so both are kept.
    gap_chroma=None disables the enclosed-gap pass."""
    diff = rgb - bg
    near = np.abs(diff).max(-1) <= tol
    labels, _ = ndimage.label(near)
    edges = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    border = set(np.unique(edges).tolist()) - {0}
    mask = np.isin(labels, list(border))
    if gap_chroma is None:
        return mask
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        if i in border:
            continue
        m = labels[sl] == i
        area = int(m.sum())
        if area < gap_min_area:
            continue
        d = diff[sl][m]
        chroma = (d.max(1) - d.min(1)).mean()
        hole = ndimage.binary_fill_holes(m).sum() - area
        if chroma <= gap_chroma and hole < 0.02 * area:
            mask[sl] |= m
    return mask


def _soft_alpha(bg, sigma, lo, hi):
    """Anti-aliased alpha: blur the hard mask, smoothstep window shifted inward."""
    blur = ndimage.gaussian_filter((~bg).astype(np.float32), sigma)
    t = np.clip((blur - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t) * 255


def _unmix(rgb, fg, alpha, bgc, band_px):
    """Edge band pixel = a*F + (1-a)*bg. F is the local solid colour a few px
    inside; the JPEG's light anti-aliasing becomes transparency, not a halo."""
    dist_in = ndimage.distance_transform_edt(fg)
    band = (fg & (dist_in <= band_px)) | (~fg & (alpha > 0))
    core = dist_in > band_px
    if not core.any():
        core = fg
    if not core.any():
        return rgb, alpha
    w = ndimage.gaussian_filter(core.astype(np.float32), 2.0)
    avg = np.dstack([ndimage.gaussian_filter(rgb[..., c] * core, 2.0) for c in range(3)])
    _, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
    F = np.where((w > 0.05)[..., None], avg / np.maximum(w, 1e-6)[..., None], rgb[iy, ix])
    d_f = np.linalg.norm(F - bgc, axis=2)
    d_o = np.linalg.norm(rgb - bgc, axis=2)
    unmix = np.clip(d_o / np.maximum(d_f, 1e-6), 0, 1) * 255
    out, alpha = rgb.copy(), alpha.copy()
    out[band] = F[band]
    alpha[band] = np.minimum(alpha[band], np.where(d_f[band] > 40, unmix[band], 255))
    return out, alpha


def remove_background(img, bg=None, tol=23, gap_chroma=3.0, gap_min_area=150,
                      sigma=1.6, lo=0.35, hi=0.85, band_px=4):
    """HxWx3/4 float array -> HxWx4 with a transparent background."""
    rgb = img[..., :3]
    in_alpha = img[..., 3] if img.shape[-1] == 4 else None
    bgc = estimate_bg(rgb) if bg is None else np.asarray(bg, np.float32)
    mask = bg_mask(rgb, bgc, tol, gap_chroma, gap_min_area)
    if in_alpha is not None:
        mask |= in_alpha == 0
    alpha = _soft_alpha(mask, sigma, lo, hi)
    out, alpha = _unmix(rgb, ~mask, alpha, bgc, band_px)
    if in_alpha is not None:
        alpha = np.minimum(alpha, in_alpha)
    return np.dstack([out, alpha])


# ---------- specks ----------


def find_specks(rgba, bg=(255, 255, 255), seed_tol=55, seed_max_sat=30, max_area=600,
                ring_px=3, ring_max_sat=45, near_px=6, min_contrast=140, wide_px=20,
                wide_light_tol=85, wide_light_max=0.06, surround_max_sat=22,
                keep=(), keep_radius=15, region=None):
    """Leftover bg-coloured specks inside dark, neutral areas (hair, outlines).
    A speck is kept out when anything bg-like (shirt, lacing, eye white) or
    colourful (iris) is within `wide_px`; that wide check is what protects art."""
    rgb, opaque = rgba[..., :3], rgba[..., 3] > 128
    D, S = _dist(rgb, bg), _sat(rgb)
    seeds = opaque & (D <= seed_tol) & (S < seed_max_sat)
    labels, _ = ndimage.label(seeds, structure=EIGHT)
    sel = np.zeros(labels.shape, bool)
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        ys = slice(max(sl[0].start - wide_px - 1, 0), sl[0].stop + wide_px + 1)
        xs = slice(max(sl[1].start - wide_px - 1, 0), sl[1].stop + wide_px + 1)
        m = labels[ys, xs] == i
        if m.sum() > max_area:
            continue
        op, d, s = opaque[ys, xs], D[ys, xs], S[ys, xs]
        ring = ndimage.binary_dilation(m, iterations=ring_px) & ~m & op
        if ring.sum() < 4 or (s[ring] < ring_max_sat).mean() < 0.9:
            continue
        near = ndimage.binary_dilation(m, iterations=near_px) & ~m & op
        if d[near].mean() < min_contrast:
            continue
        wide = ndimage.binary_dilation(m, iterations=wide_px) & ~m & op
        if (d[wide] <= wide_light_tol).mean() < wide_light_max and s[wide].mean() < surround_max_sat:
            sel[ys, xs] |= m
    yy, xx = np.mgrid[:sel.shape[0], :sel.shape[1]]
    for kx, ky in keep:
        sel &= (xx - kx) ** 2 + (yy - ky) ** 2 > keep_radius ** 2
    if region is not None:
        x0, y0, x1, y1 = region
        sel &= (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)
    return sel


def fill_specks(rgba, sel, bg=(255, 255, 255), grow_px=3, solid_contrast=175, src_contrast=135):
    """Paint selected specks (plus their light anti-aliased rim) with a smooth
    average of the surrounding dark colour, and soften the 1px seam."""
    rgb, opaque = rgba[..., :3], rgba[..., 3] > 128
    D, S = _dist(rgb, bg), _sat(rgb)
    grow = (ndimage.binary_dilation(sel, iterations=grow_px) & (D < solid_contrast)) | sel
    src = opaque & ~grow & (D >= src_contrast) & (S < 45)
    out = rgba.copy()
    if not src.any():
        return out
    w = ndimage.gaussian_filter(src.astype(np.float32), 2.5)
    for c in range(3):
        avg = ndimage.gaussian_filter(rgba[..., c] * src, 2.5) / np.maximum(w, 1e-6)
        out[..., c][grow] = avg[grow]
    _, (iy, ix) = ndimage.distance_transform_edt(~src, return_indices=True)
    weak = grow & (w < 0.05)
    out[..., :3][weak] = rgba[..., :3][iy[weak], ix[weak]]
    seam = ndimage.binary_dilation(grow, iterations=1) & ~grow & opaque
    for c in range(3):
        soft = ndimage.gaussian_filter(out[..., c], 1.0)
        out[..., c][seam] = 0.5 * out[..., c][seam] + 0.5 * soft[seam]
    return out


# ---------- components / recolor ----------


def _shapes(rgba):
    labels, _ = ndimage.label(rgba[..., 3] > 0)
    return labels


def components(rgba, min_px=200):
    labels = _shapes(rgba)
    rows = []
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        m = labels[sl] == i
        px = int(m.sum())
        if px < min_px:
            continue
        rows.append({
            "id": i,
            "bbox": (sl[1].start, sl[0].start, sl[1].stop, sl[0].stop),
            "px": px,
            "mean": tuple(int(v) for v in rgba[sl][..., :3][m].mean(0).round()),
        })
    return rows


def _label_at(labels, point):
    x, y = point[:2]
    h, w = labels.shape
    if not (0 <= x < w and 0 <= y < h):
        raise ValueError(f"point {x},{y} is outside the image ({w}x{h})")
    lab = int(labels[y, x])
    if lab == 0:
        raise ValueError(f"no shape at {x},{y} (transparent pixel)")
    return lab


def sample_color(rgba, point):
    """Mean colour and texture (mean per-channel std) of the shape at a point."""
    labels = _shapes(rgba)
    m = (labels == _label_at(labels, point)) & (rgba[..., 3] > 200)
    px = rgba[..., :3][m]
    return px.mean(0), float(px.std(0).mean())


def recolor(rgba, points, ids, color, texture=4.0):
    """Recolour shapes (by point inside them and/or by id) to `color`, carrying
    each pixel's light/dark deviation over so crayon/brush texture survives."""
    labels = _shapes(rgba)
    targets = set(ids) | {_label_at(labels, p) for p in points}
    if not targets:
        raise ValueError("nothing to recolour: give --at x,y or --ids")
    for t in targets:
        if not 1 <= t <= labels.max():
            raise ValueError(f"no shape with id {t} (see `components`)")
    out = rgba.copy()
    lum = rgba[..., :3].mean(-1)
    col = np.asarray(color, np.float32)
    for t in sorted(targets):
        m = labels == t
        solid = m & (rgba[..., 3] > 200)
        if not solid.any():
            solid = m
        mu, sd = lum[solid].mean(), lum[solid].std()
        z = np.clip((lum[m] - mu) / max(sd, 1.0), -3, 3)
        out[..., :3][m] = np.clip(col + z[:, None] * texture, 0, 255)
    return out


# ---------- preview ----------


def preview(rgba, out_path, bg=(60, 160, 120), crops=(), circles=(), crop_size=40, tile=240):
    """Composite on a solid colour. With crops: a 240px-high overview followed by
    nearest-neighbour zoom tiles (so halos and stair-steps stay visible)."""
    base = Image.new("RGBA", (rgba.shape[1], rgba.shape[0]), (*bg, 255))
    base.alpha_composite(Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8), "RGBA"))
    draw = ImageDraw.Draw(base)
    for x, y, *_ in circles:
        draw.ellipse((x - 18, y - 18, x + 18, y + 18), outline=(255, 230, 0, 255), width=5)
    img = base.convert("RGB")
    if crops:
        ow = round(img.width * tile / img.height)
        sheet = Image.new("RGB", (ow + tile * len(crops), tile))
        sheet.paste(img.resize((ow, tile), Image.LANCZOS), (0, 0))
        for i, (x, y, *size) in enumerate(crops):
            r = (size[0] if size else crop_size) // 2
            sheet.paste(img.crop((x - r, y - r, x + r, y + r)).resize((tile, tile), Image.NEAREST),
                        (ow + i * tile, 0))
        img = sheet
    img.save(out_path, quality=88)


# ---------- CLI ----------


def _build_parser():
    p = argparse.ArgumentParser(prog="imgalpha", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def io(sp, needs_out=True):
        sp.add_argument("input")
        sp.add_argument("-o", "--output", required=needs_out)
        sp.add_argument("--in-place", action="store_true",
                        help="allow -o to be the input file (back it up first)")

    r = sub.add_parser("remove", help="make the background transparent")
    io(r)
    r.add_argument("--bg", default="auto", help="auto (border median) | #rrggbb | r,g,b")
    r.add_argument("--tol", type=float, default=23, help="max distance to bg colour")
    r.add_argument("--gap-chroma", type=float, default=3.0)
    r.add_argument("--gap-min-area", type=int, default=150)
    r.add_argument("--no-gaps", action="store_true", help="keep enclosed bg-coloured gaps")
    r.add_argument("--sigma", type=float, default=1.6, help="edge softness")
    r.add_argument("--lo", type=float, default=0.35)
    r.add_argument("--hi", type=float, default=0.85)
    r.add_argument("--band", type=int, default=4, help="edge band width for unmixing")

    s = sub.add_parser("specks", help="find/fill leftover bg pixels in dark areas")
    io(s, needs_out=False)
    s.add_argument("--mark", help="write a preview with each speck circled")
    s.add_argument("--bg", default="#ffffff", help="the removed background colour")
    s.add_argument("--keep", action="append", default=[], help="x,y to protect (15px)")
    s.add_argument("--region", help="x0,y0,x1,y1 to limit the search")
    s.add_argument("--max-area", type=int, default=600)
    s.add_argument("--seed-tol", type=float, default=55)
    s.add_argument("--min-contrast", type=float, default=140)
    s.add_argument("--surround-max-sat", type=float, default=22)

    c = sub.add_parser("components", help="list separate shapes")
    c.add_argument("input")
    c.add_argument("--min-px", type=int, default=200)

    rc = sub.add_parser("recolor", help="recolour shapes keeping texture")
    io(rc)
    rc.add_argument("--at", action="append", default=[], help="x,y inside a shape")
    rc.add_argument("--ids", default="", help="comma-separated ids from `components`")
    rc.add_argument("--color", help="#rrggbb | r,g,b")
    rc.add_argument("--like", help="reference image to sample the colour from")
    rc.add_argument("--like-at", help="x,y inside the reference shape")
    rc.add_argument("--texture", type=float, help="texture strength (default: sampled or 4)")

    pv = sub.add_parser("preview", help="composite on a colour for inspection")
    io(pv)
    pv.add_argument("--bg", default="#3ca078")
    pv.add_argument("--crop", action="append", default=[], help="x,y[,size] zoom tile")
    pv.add_argument("--circle", action="append", default=[], help="x,y to circle")
    return p


def _same_file(a, b):
    return pathlib.Path(a).resolve() == pathlib.Path(b).resolve()


def _run(a):
    if a.cmd == "components":
        for row in components(load_rgba(a.input), a.min_px):
            print(f"id {row['id']}: bbox={row['bbox']} px={row['px']} mean={row['mean']}")
        return 0
    outs = [a.output, getattr(a, "mark", None)]
    if any(o and _same_file(a.input, o) for o in outs) and not a.in_place:
        print("refusing to overwrite the input; back it up and pass --in-place", file=sys.stderr)
        return 2
    img = load_rgba(a.input)
    if a.cmd == "remove":
        bg = None if a.bg == "auto" else parse_color(a.bg)
        rgb = img if (img[..., 3] < 255).any() else img[..., :3]
        save_rgba(remove_background(rgb, bg, a.tol, None if a.no_gaps else a.gap_chroma,
                                    a.gap_min_area, a.sigma, a.lo, a.hi, a.band), a.output)
        return 0
    if a.cmd == "specks":
        if not (a.output or a.mark):
            print("pass -o or --mark (or both)", file=sys.stderr)
            return 2
        bg = parse_color(a.bg)
        sel = find_specks(img, bg=bg, seed_tol=a.seed_tol, max_area=a.max_area,
                          min_contrast=a.min_contrast, surround_max_sat=a.surround_max_sat,
                          keep=[parse_point(k)[:2] for k in a.keep],
                          region=parse_box(a.region) if a.region else None)
        labels, n = ndimage.label(sel, structure=EIGHT)
        print(f"specks: {n} pixels: {int(sel.sum())}")
        if a.mark:
            centres = ndimage.center_of_mass(sel, labels, range(1, n + 1))
            preview(img, a.mark, bg=(40, 90, 200), circles=[(int(x), int(y)) for y, x in centres])
        if a.output:
            save_rgba(fill_specks(img, sel, bg=bg), a.output)
        return 0
    if a.cmd == "recolor":
        if a.like and not a.like_at:
            print("--like needs --like-at x,y", file=sys.stderr)
            return 2
        if a.like:
            color, texture = sample_color(load_rgba(a.like), parse_point(a.like_at))
        elif a.color:
            color, texture = parse_color(a.color), 4.0
        else:
            print("pass --color or --like", file=sys.stderr)
            return 2
        ids = [int(i) for i in a.ids.split(",") if i]
        save_rgba(recolor(img, [parse_point(p) for p in a.at], ids, color,
                          texture if a.texture is None else a.texture), a.output)
        return 0
    preview(img, a.output, bg=parse_color(a.bg), crops=[parse_point(c) for c in a.crop],
            circles=[parse_point(c) for c in a.circle])
    return 0


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        return _run(args)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
