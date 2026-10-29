export const normalizeIgnoredCollisionJoints = (value) => [...new Set(
  (Array.isArray(value) ? value : [])
    .filter((name) => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean),
)].sort();

export const collisionSideForLink = (name) => {
  const side = String(name).match(/^(?:(?:arm|tool|zivid)[_-])?(left|right)(?:[_-]|$)/i)?.[1];
  return side?.toLowerCase() || 'body';
};
