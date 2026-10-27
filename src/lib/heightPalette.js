// Linear RGB, shared by the Web shader and exported spatial geometry.
const stops = [
  [0.0176, 0.0685, 0.2159],
  [0.0212, 0.3916, 0.6308],
  [0.0908, 0.6514, 0.3325],
  [0.9047, 0.5841, 0.1095],
  [1.0, 0.1620, 0.1560],
];

export function heightPalette(height, minimum, maximum, target = [0, 0, 0]) {
  const t = Math.max(0, Math.min(1, (height - minimum) / Math.max(maximum - minimum, 0.000001))) * 4;
  const index = Math.min(3, Math.floor(t)), fraction = t - index;
  const blend = fraction * fraction * (3 - 2 * fraction);
  for (let channel = 0; channel < 3; channel++) {
    target[channel] = stops[index][channel] * (1 - blend) + stops[index + 1][channel] * blend;
  }
  return target;
}

export const heightPaletteGLSL = `
vec3 atlasHeightPalette(float heightValue, float heightMin, float heightMax) {
  float t = clamp((heightValue - heightMin) / max(heightMax - heightMin, 0.000001), 0.0, 1.0);
  ${stops.map((rgb, i) => `vec3 stop${i} = vec3(${rgb.map(value => value.toFixed(4)).join(', ')});`).join('\n  ')}
  if (t < 0.25) return mix(stop0, stop1, smoothstep(0.0, 0.25, t));
  if (t < 0.50) return mix(stop1, stop2, smoothstep(0.25, 0.50, t));
  if (t < 0.75) return mix(stop2, stop3, smoothstep(0.50, 0.75, t));
  return mix(stop3, stop4, smoothstep(0.75, 1.0, t));
}`;
