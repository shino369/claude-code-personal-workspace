---
name: transparent-background
description: Turn an image with a flat or near-flat background (illustration, sticker, logo, scan, product shot on white) into a clean transparent PNG, then fix what is left — white halo or jagged edges, leftover background pixels between hair strands or inside outlines — and optionally recolour separate shapes (marks, text, icons) to a given or sampled colour. Use when the user asks to remove a background, make an image transparent, cut out a character or logo, clean edges or white fringes of a cutout, fill leftover white pixels, or change the colour of part of an image.
---

# Transparent Background

One script, `scripts/imgalpha.py`, does the work. Run it through uv (no global installs) on
macOS, Linux, or Windows. Define the `ia` helper once per shell command, from inside the repo. It
resolves an absolute path, so a later `cd` is fine. The examples below use it.

bash / zsh / Git Bash:

```bash
IA_PY="$(git rev-parse --show-toplevel)/.agents/skills/transparent-background/scripts/imgalpha.py"
ia() { uv run --quiet --python 3.12 --with pillow --with numpy --with scipy python -I "$IA_PY" "$@"; }
ia remove in.jpg -o out.png
```

PowerShell (`cmd.exe` has no functions, so use PowerShell or Git Bash):

```powershell
$IA_PY = Join-Path (git rev-parse --show-toplevel) '.agents/skills/transparent-background/scripts/imgalpha.py'
function ia { uv run --quiet --python 3.12 --with pillow --with numpy --with scipy python -I $IA_PY @args }
ia remove in.jpg -o out.png
```

Write colours as `r,g,b` (`--bg 40,96,200`). It needs no quoting in any shell. `#rrggbb` also
works, but quote it: PowerShell treats a bare `#` as a comment, and `cmd` keeps single quotes.

## Workflow

1. **Look first.** Read the image. This script suits flat or near-flat backgrounds. For photos or
   busy backgrounds use an AI matting model instead (`rembg`, see
   [references/troubleshooting.md](references/troubleshooting.md#when-not-to-use-this)).
2. **Never touch the original.** Write to a new file. Before editing a result in place, copy it to a
   `backup/<yymmdd-hhmm>/` folder next to it. The script refuses `-o` = input unless `--in-place`.
3. **Remove** the background: `ia remove in.jpg -o out.png`. The bg colour is the border median
   (`--bg 255,255,255` to force). It removes bg connected to the edges plus enclosed gaps of the bg's
   hue that have no hole, so skin, white stripes and ring-shaped details stay.
4. **Inspect on a contrasting colour, zoomed.** Transparency hides problems on white:

   ```bash
   ia preview out.png -o check.jpg --bg 40,96,200 --crop 600,140 --crop 260,1140,60
   ```

   Read `check.jpg`. Check a dark background too. Look for halos, stair-steps, holes in light
   details, leftover white.

5. **Fix what you see**, one issue at a time, re-inspecting after each. Symptom → fix table:
   [references/troubleshooting.md](references/troubleshooting.md).
6. **Optional extras:** leftover specks (below), recolouring (below).
7. **Report** the output path, what changed, what was deliberately kept, and the backup location.

## Leftover background pixels (`specks`)

White slivers between hair strands or inside dark outlines. Always mark before filling:

```bash
ia specks out.png --mark marked.jpg          # circles every candidate; prints the count
ia specks out.png -o fixed.png --keep 1237,1467   # fill; protect a deliberate sparkle
```

Read `marked.jpg` and check every circle. If one sits on real art (lacing, eye glint, sparkle), use
`--keep x,y` or a `--region x0,y0,x1,y1`. Then compare before and after with `preview --crop`. The
defaults are tuned for dark, neutral areas (black hair, outlines). For coloured areas raise
`--surround-max-sat`.

## Recolouring shapes (`components`, `recolor`)

```bash
ia components out.png                    # id, bbox, size, mean colour of each shape
ia recolor out.png -o red.png --at 200,640 --at 1400,500 --like other.png --like-at 1350,880
ia recolor out.png -o red.png --ids 2,3 --color 228,100,91
```

`--like` samples the colour and texture of the shape at `--like-at` in a reference image. Each
pixel keeps its light/dark deviation, so brush or crayon texture survives. Pick shapes with `--at`
(a point inside them). It is safer than ids, which change when the image changes.

## Rules

- Inspect the result yourself (read the preview image) after every step. Do not assume the
  defaults worked.
- Pass paths as arguments and run Python with `-I`. Never name a scratch file after a stdlib module
  (`inspect.py` shadowed numpy's import once).
- Keep scratch output in the task's `tmp/` or the system temp folder, not next to the user's
  images.

## Tests

One line, so it runs unchanged in bash, PowerShell and `cmd` (the `.coverage` file it leaves is
git-ignored):

```bash
uv run --quiet --python 3.12 --with pytest --with pytest-cov --with pillow --with numpy --with scipy python -I -B -m pytest -q -p no:cacheprovider .agents/skills/transparent-background/scripts --cov=imgalpha --cov-branch --cov-fail-under=100
```
