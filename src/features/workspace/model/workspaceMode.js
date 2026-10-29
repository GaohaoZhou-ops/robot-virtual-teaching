import { normalizeTeachingSpaceMode } from "./io.js";

export const teachingModeLabel = (mode) => mode === 'independent' ? '独立示教' : '地图示教';

export const assertProjectMode = (actualMode, requestedMode) => {
  if (normalizeTeachingSpaceMode(actualMode) === normalizeTeachingSpaceMode(requestedMode)) return;
  const error = new Error(
    `所选工程属于“${teachingModeLabel(actualMode)}”，当前入口为“${teachingModeLabel(requestedMode)}”。请返回主页面选择“${teachingModeLabel(actualMode)}”后再加载。`,
  );
  error.code = 'PROJECT_MODE_MISMATCH';
  throw error;
};
