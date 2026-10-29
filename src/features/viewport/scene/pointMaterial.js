import { TEACHING_SURFACE_TINT_OPACITY, TEACHING_SURFACE_COVERAGE_ATTRIBUTE } from './viewportConfig.js';
import { heightPaletteGLSL } from "../model/heightPalette.js";

export const colorModeValue = (mode) => (mode === 'height' ? 1 : mode === 'white' ? 2 : 0);

export const POINT_COLOR_MODES = [
  { id: 'height', label: '高程色' },
  { id: 'source', label: '原始色' },
  { id: 'white', label: '纯白色' },
];

export const installMapColorShader = (material, bounds, colorMode, { surface = false, objectColorMode = colorMode } = {}) => {
  material.userData.mapColorMode = colorMode;
  material.userData.objectColorMode = objectColorMode;
  material.defaultAttributeValues = { ...material.defaultAttributeValues, atlasPlacedObject: [0] };
  material.userData.teachingTintVisibility = 1;
  material.userData.teachingTintOpacity = TEACHING_SURFACE_TINT_OPACITY;
  if (surface) {
    material.extensions = { ...(material.extensions || {}), derivatives: true };
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atlasPointColorMode = {
      value: colorModeValue(material.userData.mapColorMode),
    };
    shader.uniforms.atlasObjectColorMode = { value: colorModeValue(material.userData.objectColorMode) };
    shader.uniforms.atlasHeightMin = { value: bounds.min.z };
    shader.uniforms.atlasHeightMax = { value: bounds.max.z };
    shader.uniforms.atlasTeachingTintVisibility = {
      value: material.userData.teachingTintVisibility,
    };
    shader.uniforms.atlasTeachingTintOpacity = {
      value: material.userData.teachingTintOpacity,
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float ${TEACHING_SURFACE_COVERAGE_ATTRIBUTE};
attribute float atlasPlacedObject;
varying float vAtlasPlacedObject;
varying float vAtlasHeight;
varying float vAtlasTeachingCoverage;
${surface ? 'varying vec3 vAtlasViewPosition;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vAtlasTeachingCoverage = ${TEACHING_SURFACE_COVERAGE_ATTRIBUTE};
vAtlasPlacedObject = atlasPlacedObject;
#ifdef USE_INSTANCING
  vAtlasHeight = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).z;
#else
  vAtlasHeight = (modelMatrix * vec4(transformed, 1.0)).z;
#endif`,
      );
    if (surface) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vAtlasViewPosition = -mvPosition.xyz;`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vAtlasHeight;
varying float vAtlasTeachingCoverage;
varying float vAtlasPlacedObject;
${surface ? 'varying vec3 vAtlasViewPosition;' : ''}
uniform float atlasPointColorMode;
uniform float atlasObjectColorMode;
uniform float atlasHeightMin;
uniform float atlasHeightMax;
uniform float atlasTeachingTintVisibility;
uniform float atlasTeachingTintOpacity;

${heightPaletteGLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float atlasActiveColorMode = vAtlasPlacedObject > 0.5 ? atlasObjectColorMode : atlasPointColorMode;
if (atlasActiveColorMode > 1.5) {
  diffuseColor.rgb = vec3(1.0);
} else if (atlasActiveColorMode > 0.5) {
  diffuseColor.rgb = atlasHeightPalette(vAtlasHeight, atlasHeightMin, atlasHeightMax);
}
${surface ? `vec3 atlasDx = dFdx(vAtlasViewPosition);
vec3 atlasDy = dFdy(vAtlasViewPosition);
vec3 atlasFaceNormal = normalize(cross(atlasDx, atlasDy));
vec3 atlasLightDirection = normalize(vec3(0.32, 0.46, 0.83));
float atlasSurfaceLight = 0.68 + 0.32 * abs(dot(atlasFaceNormal, atlasLightDirection));
diffuseColor.rgb *= atlasSurfaceLight;` : ''}
${surface ? '' : `float atlasTeachingSurface = smoothstep(
  0.18,
  0.82,
  clamp(vAtlasTeachingCoverage, 0.0, 1.0)
);
vec3 atlasTeachingTint = vec3(0.1765, 0.9412, 0.5961);
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  atlasTeachingTint,
  atlasTeachingSurface
    * atlasTeachingTintOpacity
    * atlasTeachingTintVisibility
);`}`,
      );
    material.userData.mapColorShader = shader;
  };
  material.customProgramCacheKey = () => (
    surface ? 'atlas-map-color-v13-object-layers-surface' : 'atlas-map-color-v13-object-layers-points'
  );
};

export const statusColor = (status, selected = false) => {
  if (status === 'unreachable') return 0xf4c95d;
  if (selected) return 0xb7f8ff;
  if (status === 'connected') return 0x5ee59a;
  return 0x59dbe8;
};
