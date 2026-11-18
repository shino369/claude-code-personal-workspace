"""Tests for imgalpha.py (run through uv; see SKILL.md "Tests")."""

import pathlib
import runpy
import sys

import numpy as np
import pytest
from PIL import Image

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import imgalpha as ia  # noqa: E402

WHITE = (250, 250, 250)
SKIN = (253, 238, 242)
DARK = (50, 45, 52)


def canvas(h=120, w=120, color=WHITE):
    return np.full((h, w, 3), color, np.float32)


def character(h=120, w=120):
    """White bg, a dark ring (outline) with pink skin inside, a white enclosed gap
    between two dark bars, and a white ring with a dark centre (a "clip")."""
    rgb = canvas(h, w)
    yy, xx = np.mgrid[:h, :w]
    r = np.hypot(yy - 60, xx - 45)
    rgb[r < 30] = DARK
    rgb[r < 24] = SKIN
    # Enclosed neutral-white gap between two dark bars (right side)
    rgb[20:100, 85:115] = DARK
    rgb[40:80, 95:105] = WHITE
    # White ring with dark centre inside the skin (a hair clip)
    rc = np.hypot(yy - 60, xx - 45)
    rgb[(rc < 9)] = (245, 245, 245)
    rgb[(rc < 4)] = DARK
    return rgb


def write(tmp_path, name, arr):
    p = tmp_path / name
    mode = "RGBA" if arr.shape[-1] == 4 else "RGB"
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode).save(p)
    return p


def read(p):
    return np.asarray(Image.open(p)).astype(np.float32)


# ---------- helpers ----------


def test_parse_color_and_point():
    assert ia.parse_color("#ff8000") == (255, 128, 0)
    assert ia.parse_color("10,20,30") == (10, 20, 30)
    with pytest.raises(ValueError):
        ia.parse_color("nope")
    assert ia.parse_point("3,4") == (3, 4)
    assert ia.parse_point("3,4,50") == (3, 4, 50)
    with pytest.raises(ValueError):
        ia.parse_point("3")


def test_load_rgba_adds_alpha_and_keeps_existing(tmp_path):
    a = ia.load_rgba(write(tmp_path, "a.jpg.png", canvas(4, 4)))
    assert a.shape == (4, 4, 4) and (a[..., 3] == 255).all()
    rgba = np.dstack([canvas(4, 4), np.full((4, 4), 7, np.float32)])
    b = ia.load_rgba(write(tmp_path, "b.png", rgba))
    assert (b[..., 3] == 7).all()


def test_estimate_bg_uses_border_median():
    rgb = canvas(50, 50, (240, 241, 242))
    rgb[10:40, 10:40] = DARK
    assert tuple(ia.estimate_bg(rgb)) == (240, 241, 242)


# ---------- remove ----------


def test_bg_mask_removes_edge_bg_and_neutral_gap_keeps_skin_and_clip():
    rgb = character()
    bg = ia.bg_mask(rgb, np.array(WHITE, np.float32))
    assert bg[0, 0] and bg[119, 119]  # outer background
    assert bg[60, 100]  # enclosed neutral gap
    assert not bg[60, 30]  # pink skin stays
    assert not bg[60, 45 + 6]  # white clip ring (has a hole) stays
    assert not bg[60, 45]  # clip centre


def test_bg_mask_can_skip_gaps():
    rgb = character()
    bg = ia.bg_mask(rgb, np.array(WHITE, np.float32), gap_chroma=None)
    assert not bg[60, 100]


def test_bg_mask_ignores_small_gaps():
    rgb = character()
    bg = ia.bg_mask(rgb, np.array(WHITE, np.float32), gap_min_area=10_000)
    assert not bg[60, 100]


def test_remove_background_alpha_and_no_halo():
    rgb = character()
    out = ia.remove_background(rgb)
    alpha = out[..., 3]
    assert alpha[0, 0] == 0 and alpha[60, 100] == 0
    assert alpha[60, 30] == 255 and alpha[60, 45] == 255
    # Edge band: partially transparent pixels take the outline colour, not white
    edge = (alpha > 0) & (alpha < 255)
    assert edge.any()
    assert out[..., :3][edge].mean() < 120


def test_remove_background_respects_input_alpha_and_explicit_bg():
    rgb = character()
    rgba = np.dstack([rgb, np.full(rgb.shape[:2], 255, np.float32)])
    rgba[60, 30, 3] = 0  # caller already cut this pixel
    out = ia.remove_background(rgba, bg=(250, 250, 250))
    assert out[60, 30, 3] == 0


def test_remove_background_interior_stays_opaque():
    rgb = canvas(40, 40)
    rgb[10:30, 10:30] = (215, 215, 215)
    out = ia.remove_background(rgb, tol=20)
    assert out[20, 20, 3] == 255


def test_remove_background_tiny_foreground_without_interior():
    # Thinner than the edge band: colours come from the shape itself
    rgb = canvas(30, 30)
    rgb[13:17, 13:17] = DARK
    out = ia.remove_background(rgb)
    assert out[15, 15, :3].mean() < 90 and out[15, 15, 3] > 0


def test_remove_background_blank_image_is_fully_transparent():
    out = ia.remove_background(canvas(20, 20))
    assert (out[..., 3] == 0).all()


# ---------- specks ----------


def hair_with_specks():
    """Transparent bg; a dark 'hair' block with two white specks; a white 'lacing'
    triangle inside dark lace that sits next to a big white shirt area."""
    h, w = 140, 200
    rgba = np.zeros((h, w, 4), np.float32)
    rgba[10:130, 10:110, :3] = DARK
    rgba[10:130, 10:110, 3] = 255
    rgba[40:43, 40:43, :3] = 252  # speck 1
    rgba[80:84, 70:73, :3] = 248  # speck 2
    rgba[60, 60, :3] = 150  # mid-grey AA rim pixel next to nothing special
    # Shirt (large light area) with dark lace and a small white triangle inside
    rgba[10:130, 120:190, :3] = 245
    rgba[10:130, 120:190, 3] = 255
    rgba[60:80, 140:160, :3] = DARK
    rgba[66:72, 147:153, :3] = 252  # lacing gap: shirt within 20px -> keep
    return rgba


def test_find_specks_selects_hair_specks_only():
    rgba = hair_with_specks()
    sel = ia.find_specks(rgba)
    assert sel[41, 41] and sel[82, 71]
    assert not sel[69, 150]  # lacing
    assert not sel[50, 150]  # shirt


def test_find_specks_keep_points_and_region():
    rgba = hair_with_specks()
    sel = ia.find_specks(rgba, keep=[(41, 41)])
    assert not sel[41, 41] and sel[82, 71]
    sel = ia.find_specks(rgba, region=(0, 0, 60, 60))
    assert sel[41, 41] and not sel[82, 71]


def test_find_specks_rejects_colourful_or_light_surroundings():
    rgba = hair_with_specks()
    assert not ia.find_specks(rgba, surround_max_sat=-1).any()
    assert not ia.find_specks(rgba, min_contrast=999).any()
    assert not ia.find_specks(rgba, max_area=1).any()


def test_find_specks_skips_isolated_and_coloured_ring():
    rgba = np.zeros((60, 60, 4), np.float32)
    rgba[30, 30] = (252, 252, 252, 255)  # lone white pixel, no opaque ring
    assert not ia.find_specks(rgba).any()
    rgba[20:40, 20:40] = (200, 40, 40, 255)  # red surroundings (ring not neutral)
    rgba[29:32, 29:32, :3] = 252
    assert not ia.find_specks(rgba).any()


def test_fill_specks_paints_neighbour_colour():
    rgba = hair_with_specks()
    sel = ia.find_specks(rgba)
    out = ia.fill_specks(rgba, sel)
    assert out[41, 41, :3].mean() < 90
    assert out[82, 71, :3].mean() < 90
    assert out[69, 150, :3].mean() > 240  # lacing untouched


def test_fill_specks_falls_back_to_nearest_colour():
    # Speck far from any usable source pixel within the blur radius
    rgba = np.zeros((40, 40, 4), np.float32)
    rgba[..., 3] = 255
    rgba[..., :3] = 252
    rgba[0, 0, :3] = DARK
    sel = np.zeros((40, 40), bool)
    sel[30, 30] = True
    out = ia.fill_specks(rgba, sel)
    assert tuple(out[30, 30, :3]) == DARK


def test_fill_specks_without_source_pixels_changes_nothing():
    rgba = np.full((20, 20, 4), 252, np.float32)
    rgba[..., 3] = 255
    sel = np.zeros((20, 20), bool)
    sel[10, 10] = True
    assert (ia.fill_specks(rgba, sel) == rgba).all()


# ---------- components / recolor ----------


def marks():
    rgba = np.zeros((60, 120, 4), np.float32)
    rgba[10:50, 10:40] = (*DARK, 255)  # id 1 (big)
    rgba[20:30, 60:70] = (60, 60, 70, 255)  # id 2
    rgba[20:30, 90:100] = (70, 62, 66, 255)  # id 3
    rgba[22, 92, :3] = 90  # texture
    return rgba


def test_components_lists_shapes():
    rows = ia.components(marks(), min_px=50)
    assert [r["id"] for r in rows] == [1, 2, 3]
    assert rows[1]["bbox"] == (60, 20, 70, 30)
    assert rows[0]["px"] == 1200
    assert len(ia.components(marks(), min_px=500)) == 1


def test_recolor_by_point_and_id_keeps_texture():
    rgba = marks()
    out = ia.recolor(rgba, points=[(65, 25)], ids=[3], color=(228, 100, 92), texture=4.0)
    assert np.abs(out[25, 65, :3] - (228, 100, 92)).max() < 10
    assert out[22, 92, :3].mean() > out[25, 95, :3].mean()  # lighter pixel stays lighter
    assert tuple(out[30, 20, :3]) == DARK  # id 1 untouched
    assert (out[..., 3] == rgba[..., 3]).all()


def test_recolor_rejects_points_outside_shapes():
    with pytest.raises(ValueError):
        ia.recolor(marks(), points=[(0, 0)], ids=[], color=(1, 2, 3))
    with pytest.raises(ValueError):
        ia.recolor(marks(), points=[], ids=[], color=(1, 2, 3))


def test_recolor_rejects_points_off_the_image():
    with pytest.raises(ValueError, match="outside the image"):
        ia.recolor(marks(), points=[(99999, 5)], ids=[], color=(1, 2, 3))
    with pytest.raises(ValueError, match="outside the image"):
        ia.recolor(marks(), points=[(-1, -1)], ids=[], color=(1, 2, 3))


def test_recolor_rejects_unknown_ids():
    with pytest.raises(ValueError, match="no shape with id 99"):
        ia.recolor(marks(), points=[], ids=[99], color=(1, 2, 3))


def test_recolor_shape_without_solid_pixels_uses_all_its_pixels():
    rgba = marks()
    rgba[20:30, 60:70, 3] = 120  # semi-transparent shape (id 2)
    out = ia.recolor(rgba, points=[(65, 25)], ids=[], color=(228, 100, 92))
    assert np.isfinite(out).all()
    assert np.abs(out[25, 65, :3] - (228, 100, 92)).max() < 10


def test_sample_color_from_reference():
    ref = marks()
    ref[20:30, 60:70, :3] = (228, 100, 92)
    mean, std = ia.sample_color(ref, (65, 25))
    assert tuple(mean) == (228, 100, 92) and std == 0
    with pytest.raises(ValueError):
        ia.sample_color(ref, (0, 0))


# ---------- preview ----------


def test_preview_writes_composite_and_crops(tmp_path):
    out = tmp_path / "p.jpg"
    ia.preview(marks(), out, bg=(40, 90, 200), crops=[(65, 25, 20), (95, 25)])
    im = Image.open(out)
    assert im.size == (480 + 2 * 240, 240)  # 120x60 overview scaled to 240 high + 2 crops
    out2 = tmp_path / "q.jpg"
    ia.preview(marks(), out2, bg=(40, 90, 200), circles=[(65, 25)])
    assert Image.open(out2).size == (120, 60)


# ---------- CLI ----------


def test_cli_remove_specks_recolor_components_preview(tmp_path, capsys):
    src = write(tmp_path, "in.png", character())
    out = tmp_path / "out.png"
    assert ia.main(["remove", str(src), "-o", str(out), "--bg", "auto"]) == 0
    assert read(out)[0, 0, 3] == 0
    assert ia.main(["remove", str(src), "-o", str(out), "--bg", "#fafafa", "--no-gaps"]) == 0
    assert read(out)[60, 100, 3] == 255

    hair = write(tmp_path, "hair.png", hair_with_specks())
    mark = tmp_path / "mark.jpg"
    assert ia.main(["specks", str(hair), "--mark", str(mark)]) == 0
    assert "specks: 2" in capsys.readouterr().out and mark.exists()
    filled = tmp_path / "filled.png"
    assert ia.main(["specks", str(hair), "-o", str(filled), "--keep", "41,41",
                    "--region", "0,0,200,140"]) == 0
    f = read(filled)
    assert f[41, 41, :3].mean() > 240 and f[82, 71, :3].mean() < 90

    m = write(tmp_path, "marks.png", marks())
    assert ia.main(["components", str(m), "--min-px", "50"]) == 0
    assert "id 2" in capsys.readouterr().out
    rc = tmp_path / "rc.png"
    assert ia.main(["recolor", str(m), "-o", str(rc), "--at", "65,25", "--ids", "3",
                    "--color", "#e4645c"]) == 0
    assert read(rc)[25, 65, 0] > 200
    ref = marks()
    ref[20:30, 60:70, :3] = (10, 200, 10)
    refp = write(tmp_path, "ref.png", ref)
    assert ia.main(["recolor", str(m), "-o", str(rc), "--at", "95,25",
                    "--like", str(refp), "--like-at", "65,25"]) == 0
    assert read(rc)[25, 95, 1] > 180

    pv = tmp_path / "pv.jpg"
    assert ia.main(["preview", str(m), "-o", str(pv), "--bg", "#2860c8",
                    "--crop", "65,25,30", "--circle", "95,25"]) == 0
    assert pv.exists()


def test_cli_refuses_to_overwrite_input_and_reports_errors(tmp_path, capsys):
    src = write(tmp_path, "in.png", character())
    assert ia.main(["remove", str(src), "-o", str(src)]) == 2
    assert "refusing to overwrite" in capsys.readouterr().err
    assert ia.main(["remove", str(src), "-o", str(src), "--in-place"]) == 0
    assert ia.main(["specks", str(src), "--mark", str(src)]) == 2
    assert "refusing to overwrite" in capsys.readouterr().err
    assert ia.main(["remove", str(tmp_path / "missing.png"), "-o", str(tmp_path / "x.png")]) == 1
    assert "error:" in capsys.readouterr().err
    m = write(tmp_path, "m.png", marks())
    assert ia.main(["recolor", str(m), "-o", str(tmp_path / "r.png"), "--at", "65,25"]) == 2
    assert "--color or --like" in capsys.readouterr().err
    assert ia.main(["specks", str(m)]) == 2
    assert "-o or --mark" in capsys.readouterr().err
    assert ia.main(["recolor", str(m), "-o", str(tmp_path / "r.png"), "--at", "65,25",
                    "--like", str(m)]) == 2
    assert "needs --like-at" in capsys.readouterr().err
    assert ia.main(["specks", str(m), "--mark", str(tmp_path / "k.jpg"), "--region", "1,2"]) == 1
    assert "x0,y0,x1,y1" in capsys.readouterr().err


def test_runs_as_script(tmp_path, monkeypatch):
    m = write(tmp_path, "m.png", marks())
    monkeypatch.setattr(sys, "argv", ["imgalpha.py", "components", str(m)])
    with pytest.raises(SystemExit) as e:
        runpy.run_path(str(SCRIPTS / "imgalpha.py"), run_name="__main__")
    assert e.value.code == 0
