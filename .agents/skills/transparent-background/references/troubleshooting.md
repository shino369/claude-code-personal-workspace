# Troubleshooting a cutout

Each row: what you see on the zoomed preview, why it happens, what to do. Re-run `preview --crop` on
the same spots after every change.

| Symptom                                                        | Cause                                                                                                      | Fix                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Face, skin, white stripes became transparent                   | A plain "white → transparent" was used; light art is close to the bg colour                                | Use `remove`: only edge-connected bg plus hue-matched enclosed gaps go                                                                         |
| White gaps between hair strands / arm and body stay white      | Gap does not touch the image edge                                                                          | Default enclosed-gap pass removes them. If not: the gap is tinted (raise `--gap-chroma` a little) or small (lower `--gap-min-area`)            |
| A white detail with a dark centre vanished (clip, button, eye) | It matched as a gap                                                                                        | Rings are kept automatically (they have a hole). For solid white details: `--no-gaps`, or raise `--gap-chroma` above its tint                  |
| Stair-step, jagged outline                                     | Hard binary mask                                                                                           | Edges are already anti-aliased; for softer: `--sigma 2.5`. Brush/crayon bumps in the art itself are not jaggies, keep them                     |
| Thin white or light ring along the outline (shows on dark bg)  | JPEG anti-aliasing blends the line into the bg over ~3px; keeping it opaque leaves a halo                  | Built-in colour unmixing turns that blend into transparency. Still visible: widen with `--band 6`, or pull the edge in (`--lo 0.45 --hi 0.95`) |
| Dotted light line just inside the edge after a tweak           | Recolouring only the outer pixels; the innermost halo ring stayed opaque                                   | Do not recolour edges by copying a single nearby pixel; use the unmixing band (`--band`), which covers the whole blend                         |
| Light specks on the edge                                       | Edge colour copied from one noisy interior pixel                                                           | Built in: the edge colour is a local average of interior pixels                                                                                |
| White wedges where strands fork, specks inside hair            | Background narrower than ~3px is not reached by the flood fill, or was made opaque by morphology (opening) | `specks --mark` then `specks -o`; never apply a binary opening to the bg mask                                                                  |
| `specks` circles lacing, an eye glint, a sparkle, buckle shine | These are light details surrounded by dark                                                                 | Real leftovers are near bg colour and have only dark/transparent pixels within 20px. Exclude the rest with `--keep x,y` / `--region`           |
| `specks` circles nothing although white bits are visible       | They are grey highlights (art) or bigger than `--max-area`, or sit in a coloured area                      | Zoom in and confirm it is bg white. Then raise `--max-area` / `--seed-tol`, or `--surround-max-sat` for coloured surroundings                  |
| Faint outline around a filled speck                            | The speck's anti-aliased rim was not filled                                                                | Built in (fill grows 3px into anything lighter than solid hair, plus a seam blend); check with a zoom crop                                     |
| Recoloured mark looks flat                                     | Single colour painted                                                                                      | `recolor` keeps each pixel's deviation; set `--texture` (≈ reference std, 4 by default) higher for more grain                                  |
| `ModuleNotFoundError` / circular import from numpy or scipy    | A scratch script named like a stdlib module (`inspect.py`, `json.py`) in the script's directory            | Rename it; keep scratch scripts away from the images and run with `python -I`                                                                  |

## When not to use this

- **Photos, gradients, textured or busy backgrounds:** the bg is not one colour, so use AI
  matting with `rembg` via uv (model `isnet-anime` for illustrations, `u2net` for photos).
  Check its install extras and flags with `--help` first; they change between versions. The first
  run downloads a ~170 MB model, so ask before downloading. Then still use `preview` and `specks` here for clean-up.
- **Quick one-off on macOS:** Finder → right-click → Quick Actions → Remove Background. It is fast
  but rough on fine hair.

## Tuning reference (defaults)

| Command  | Option                            | Default       | Meaning                                                                          |
| -------- | --------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `remove` | `--tol`                           | 23            | max per-channel distance from the bg colour to count as bg                       |
| `remove` | `--gap-chroma` / `--gap-min-area` | 3.0 / 150     | enclosed gap must have the bg's hue (skin ≈ 10–15) and at least this many pixels |
| `remove` | `--sigma`, `--lo`, `--hi`         | 1.6, .35, .85 | edge softness; raising `lo`/`hi` pulls the edge inward                           |
| `remove` | `--band`                          | 4             | px inside the edge that get colour unmixing                                      |
| `specks` | `--seed-tol` / `--max-area`       | 55 / 600      | how close to bg colour a speck must be / its max size                            |
| `specks` | `--min-contrast`                  | 140           | mean distance from bg of pixels within 6px (dark surroundings)                   |
| `specks` | `--surround-max-sat`              | 22            | mean saturation within 20px; protects colourful areas (iris)                     |
