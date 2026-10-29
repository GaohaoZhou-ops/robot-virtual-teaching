import { Matrix4, Vector3 } from 'three';
import { transferMatrix } from "../../teaching/model/teachingTransfer.js";

const bytesOf = (buffer) => buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : null;
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

// Equality is deliberately bit-exact, including Float32 rounding and signed
// zero. Edited/legacy geometry that no longer matches is stored verbatim.
async function matchesPositions(target, source, start, matrix) {
  const point = new Vector3();
  for (let i = 0; i < source.length; i += 3) {
    point.fromArray(source, i).applyMatrix4(matrix);
    if (!Object.is(Math.fround(point.x), target[start * 3 + i])
      || !Object.is(Math.fround(point.y), target[start * 3 + i + 1])
      || !Object.is(Math.fround(point.z), target[start * 3 + i + 2])) return false;
    if (i && i % 750000 === 0) await yieldToUI();
  }
  return true;
}

const identical = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// Work with saved snapshots only. No placement, scene geometry, group identity,
// task, or transform is changed by this storage optimization.
export async function projectGeometryRecipes(payload, options, entries) {
  const other = options.companionWorkspace || options.linkedWorkspace;
  const collection = Boolean(other || options.independentHistory?.length);
  const mode = payload.workspace?.teachingSpaceMode;
  const snapshots = [{ mode, map: options.mapResource, project: payload,
    prefix: collection ? `workspaces/${mode}/` : '' },
  ...(other ? [{ ...other, project: other.config.config.project, prefix: `workspaces/${other.mode}/` }] : []),
  ...(options.independentHistory || []).map((snapshot, i) => ({ ...snapshot,
    project: snapshot.config.config.project, prefix: `independent-history/${i + 1}/` }))];
  const recipes = new Map(), sources = new Map();
  const loadSource = async (identity) => {
    if (!identity) return null;
    const key = identity.sourceHash || identity.mapId;
    if (sources.has(key)) return sources.get(key);
    const existing = snapshots.find((snapshot) => snapshot.mode === 'independent'
      && (identity.sourceHash ? snapshot.map.sourceHash === identity.sourceHash : snapshot.map.mapId === identity.mapId));
    // Missing source caches must not make an otherwise complete map unexportable.
    let source = existing?.map;
    if (!source && options.loadGeometrySource) {
      try { source = await options.loadGeometrySource(identity); } catch { source = null; }
    }
    sources.set(key, source || null);
    return source;
  };
  for (const snapshot of snapshots) {
    if (snapshot.mode !== 'map' || !snapshot.map?.positionBuffer) continue;
    const relation = snapshot.project.workspace?.transfer || (snapshot.project === payload ? options.geometryTransfer : null);
    if (relation?.kind !== 'placement') continue;
    const positions = new Float32Array(snapshot.map.positionBuffer);
    const colors = bytesOf(snapshot.map.colorBuffer);
    const indices = snapshot.map.indexComponentType !== 'uint16' && snapshot.map.indexBuffer
      ? new Uint32Array(snapshot.map.indexBuffer) : null;
    let cursor = positions.length / 3, indexCursor = indices?.length || 0;
    const positionParts = [], colorParts = [], indexParts = [];
    let canStoreIndices = Boolean(indices);
    for (const placement of [relation, ...(relation.previousPlacements || [])]) {
      const source = await loadSource(placement.sourceMap);
      if (!(source?.positionBuffer instanceof ArrayBuffer) || source.positionBuffer.byteLength % 12) break;
      const local = new Float32Array(source.positionBuffer), count = local.length / 3, start = cursor - count;
      if (!count || start < 0) break;
      let matrix;
      try {
        // JSON normalizes -0 to 0; verify the exact matrix the reader will use.
        matrix = new Matrix4().fromArray(transferMatrix(placement.localToMap).toArray().map((value) => value || 0));
      } catch { break; }
      if (!(matrix instanceof Matrix4) || !await matchesPositions(positions, local, start, matrix)) break;
      positionParts.unshift({ kind: 'positions', bytes: bytesOf(source.positionBuffer), matrix: matrix.toArray() });
      if (colors) {
        const expected = colors.subarray(start * 3, cursor * 3), localColors = bytesOf(source.colorBuffer);
        colorParts.unshift({ kind: 'bytes', bytes: localColors && identical(expected, localColors) ? localColors : expected });
      }
      if (canStoreIndices && source.indexBuffer?.byteLength) {
        const stride = source.indexComponentType === 'uint16' ? 2 : 4;
        const localIndices = stride === 2 ? new Uint16Array(source.indexBuffer) : new Uint32Array(source.indexBuffer);
        const indexStart = indexCursor - localIndices.length;
        if (indexStart < 0 || !localIndices.every((value, i) => indices[indexStart + i] === value + start)) canStoreIndices = false;
        else {
          indexParts.unshift({ kind: 'indices', bytes: bytesOf(source.indexBuffer), stride, offset: start });
          indexCursor = indexStart;
        }
      }
      cursor = start;
      options.onProgress?.({ phase: '识别可共享的地图模型', detail: `${positionParts.length} 个放置模型已验证` });
    }
    if (!positionParts.length) continue;
    const prefix = `${snapshot.prefix}environment/`;
    const addRecipe = (path, parts, prefixBytes) => {
      if (!entries[path]) return;
      if (prefixBytes.byteLength) parts.unshift({ kind: 'bytes', bytes: prefixBytes });
      recipes.set(path, parts);
    };
    addRecipe(`${prefix}positions.f32le`, positionParts, bytesOf(snapshot.map.positionBuffer).subarray(0, cursor * 12));
    if (colors) addRecipe(`${prefix}colors.rgb8`, colorParts, colors.subarray(0, cursor * 3));
    if (canStoreIndices && indexParts.length) addRecipe(`${prefix}triangles.u32le`, indexParts,
      bytesOf(snapshot.map.indexBuffer).subarray(0, indexCursor * 4));
  }
  return recipes;
}
