# Lume trabalhando no computador

Asset: `public/pet/lume-working.png` (1254 × 1254, RGBA).

Generated with the built-in imagegen tool, using `public/pet/lume-atlas.png` as the identity reference and a transparent background.

## Generation prompt

Use case: precise-object-edit. Asset type: production animation sprite sheet for the Lume desktop pet. The input image is the existing Lume character identity/style reference. Create a NEW transparent sprite sheet of exactly FOUR frames in a precise 2 by 2 grid of equal square cells (not the original 4x4 layout). In all four frames the SAME blue flame-shaped robot with dark navy face, cyan eyes, headset-like ears and small golden diamond chest is WORKING AT A SMALL LAPTOP, actively typing with both hands. Preserve the character's exact visual identity, blue palette and crisp pixel-art style from the reference. Laptop sits in front of lower torso, angled slightly so the viewer sees typing hands and the laptop lid/back. Four subtle consecutive typing poses: left hand down, both poised, right hand down, both poised with tiny head bob. Feet remain stationary, no running or jumping. Laptop and character same size, camera, position and baseline across every cell. Fully transparent background, no environment, no ground shadow, no grid lines, no labels, no frame numbers, no text, no extra characters. Leave consistent transparent margins per cell, entire character including flame and laptop fully within each cell. Readable at 125px per frame. Output one square sprite sheet with 2 columns and 2 rows.

## Playback alignment

The generated poses have different transparent margins. Uniform 2 × 2 playback caused a ~14px horizontal and ~6px vertical jump at the normal 125px size. `workingAnchors` in `src/Pet.tsx` compensates during rendering, without modifying the generated image.

The anchors use the horizontal center and bottom of each pose's alpha > 180 bounds, measured in source pixels:

| Frame | Center X | Baseline Y |
|---|---:|---:|
| 0 | 350.5 | 583 |
| 1 | 907 | 583 |
| 2 | 351 | 1178 |
| 3 | 913 | 1178 |

All four render at center X = 62.5 and baseline Y ≈ 116.228 at 125px; at 160px they render at X = 80 and Y ≈ 148.772. Recalibrate these anchors when replacing the sheet.

Validation: TypeScript/Vite build and diff whitespace checks passed. Browser checks of dock hover, keyboard, stable character layout, composer, four-frame playback, reduced motion and edge alignment passed before the anchor correction. Final anchor coordinates were checked locally against image alpha bounds; another browser check was unavailable because automatic approval review hit its usage limit.
