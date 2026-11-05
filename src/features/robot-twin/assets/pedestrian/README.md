# Standing pedestrian display mesh

`standing-person.ply` is a static, clothed human used for pedestrian detections in the robot twin.

- Creator: Innerscene, adapted from MakeHuman CC0 assets.
- Source: [Abstract white man – 3D Person, Standing](https://www.innerscene.com/tools/library/3d-parts/abstract-white-man-3d-person-standing-9e06c5d7).
- Download: https://files.innerscene.com/library/abstract-white-man-3d-person-standing-9e06c5d7/b8b04e10b17ae2f5edab/abstract-white-man-abstract_man_standing.glb
- Retrieved: 2026-11-05.
- Original GLB SHA-256: `19f5096f559fd09066435a96250f61b24338ac011c9ae185ef83e9d5256d7225`.
- License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/); the source page and GLB asset metadata both carry the dedication. See `LICENSE.txt`.

The source has been simplified to approximately 12,000 triangles, merged into one geometry, stripped of textures and normalized to height 1 with feet at Z=0 and the face toward +X. Body proportions are preserved. The application uses a pure white material and scales all three axes by the detected height; detection-box width and depth do not stretch the human. Live and briefly retained detections share this mesh, with transparency distinguishing retained observations. A depth-only pass preserves the nearest surface before blending retained people, preventing skin and internal clothing surfaces from showing through. There is no skeletal animation.

To regenerate using Blender 5.2 (the source download is not needed at runtime):

```bash
mkdir -p build/robot-twin-person
curl -fL 'https://files.innerscene.com/library/abstract-white-man-3d-person-standing-9e06c5d7/b8b04e10b17ae2f5edab/abstract-white-man-abstract_man_standing.glb' -o build/robot-twin-person/source.glb
blender -b --python scripts/prepare_pedestrian_model.py -- build/robot-twin-person/source.glb src/features/robot-twin/assets/pedestrian/standing-person.ply
```

The local PLY is bundled with the app, loaded on first use and reused across detections. Runtime rendering does not contact the source website.
