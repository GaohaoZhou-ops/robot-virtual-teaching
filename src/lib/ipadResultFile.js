import { IPAD_PROTOCOL, MAX_MODEL_BYTES, MAX_MODEL_VERTICES, MAX_MODEL_INDICES, validateIPadResult } from './ipadProtocol.js';

export const MAX_RESULT_FILE_BYTES = 64 * 1024 * 1024;

// The archive carries model identity and completed Poses, never pairing credentials.
// Actual workspace geometry is checked by ipadResultTask at the shared import boundary.
export async function readIPadResultFile(file) {
  if (!file || !Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_RESULT_FILE_BYTES) {
    throw new Error('请选择不超过 64 MiB 的 Atlas 示教结果文件');
  }
  let archive;
  try { archive = JSON.parse(await file.text()); }
  catch { throw new Error('结果文件不是有效的 JSON，请重新从 iPad 导出'); }
  if (archive?.format !== 'atlas-teaching-result' || archive.version !== 1) {
    throw new Error('结果文件格式或版本不支持，请选择 iPad 导出的 .atlas-teaching.json 文件');
  }
  const { manifest, result } = archive;
  if (manifest?.protocol !== IPAD_PROTOCOL || manifest.coordinateFrame !== 'virtual_origin'
    || manifest.distanceUnit !== 'meter' || manifest.verticalAxis !== 'Z'
    || !/^[a-f0-9]{64}$/.test(manifest.modelHash) || typeof manifest.name !== 'string' || !manifest.name.trim()
    || manifest.name.length > 4096 || !Number.isInteger(manifest.vertices) || manifest.vertices < 1 || manifest.vertices > MAX_MODEL_VERTICES
    || !Number.isInteger(manifest.indices) || manifest.indices < 0 || manifest.indices > MAX_MODEL_INDICES || manifest.indices % 3 !== 0
    || !Number.isInteger(manifest.byteLength) || manifest.byteLength > MAX_MODEL_BYTES
    || manifest.byteLength !== 32 + manifest.vertices * 16 + manifest.indices * 4) {
    throw new Error('结果文件中的模型清单无效，请重新从 iPad 导出');
  }
  if (typeof result?.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.sessionId)) {
    throw new Error('结果文件缺少有效的示教任务标识');
  }
  validateIPadResult(result, manifest, result.sessionId);
  return { result, ticket: { id: result.sessionId, manifest } };
}
