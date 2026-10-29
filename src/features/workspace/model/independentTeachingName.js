export const INDEPENDENT_TEACHING_NAME_MAX_LENGTH = 80;

export const normalizeIndependentTeachingName = (value) => typeof value === 'string' ? value.trim() : '';

export function validateIndependentTeachingName(value) {
  const name = normalizeIndependentTeachingName(value);
  if (!name) throw new Error('请输入独立示教名称');
  if (name.length > INDEPENDENT_TEACHING_NAME_MAX_LENGTH) throw new Error('独立示教名称不能超过 80 个字符');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('独立示教名称不能包含换行或控制字符');
  return name;
}

export const defaultIndependentTeachingName = (fileName) => (
  normalizeIndependentTeachingName(String(fileName || '').replace(/\.ply$/i, '')) || '未命名独立示教'
).slice(0, INDEPENDENT_TEACHING_NAME_MAX_LENGTH);

export const independentWorkspaceLabel = (entry) => normalizeIndependentTeachingName(entry?.teachingName)
  || entry?.mapName || '未命名独立示教';
