export const BODY_CAMERAS = Object.freeze({
  'head-left': '头部左目', 'head-right': '头部右目', 'chest-color': '胸前彩色',
  'chest-depth': '胸前深度', 'wrist-left': '左手腕', 'wrist-right': '右手腕',
});
export const ROBOT_CAMERA_INTERVAL = 167;
export const ROBOT_CAMERA_MAX_AGE = 1500;
export const isBodyCamera = (id) => Object.hasOwn(BODY_CAMERAS, id);
