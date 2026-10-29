export const packCollisionPositions = (attribute) => {
  const count = attribute?.count || 0;
  if (
    attribute?.array instanceof Float32Array
    && !attribute.isInterleavedBufferAttribute
    && attribute.itemSize === 3
  ) {
    return attribute.array.slice(0, count * 3);
  }
  const packed = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    packed[offset] = attribute.getX(index);
    packed[offset + 1] = attribute.getY(index);
    packed[offset + 2] = attribute.getZ(index);
  }
  return packed;
};

export const packCollisionIndices = (attribute) => {
  const count = attribute?.count || 0;
  if (attribute?.array instanceof Uint32Array && !attribute.isInterleavedBufferAttribute) {
    return attribute.array.slice(0, count);
  }
  if (attribute?.array instanceof Uint16Array && !attribute.isInterleavedBufferAttribute) {
    return Uint32Array.from(attribute.array.subarray(0, count));
  }
  const packed = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) packed[index] = attribute.getX(index);
  return packed;
};

export const collisionStatusSignature = (status) => JSON.stringify({
  enabled: status.enabled,
  state: status.state,
  backend: status.backend,
  requestedBackend: status.requestedBackend,
  engine: status.engine,
  minimumDistance: Number.isFinite(status.minimumDistance)
    ? Number(status.minimumDistance).toFixed(4)
    : null,
  collisionLinks: status.collisionLinks,
  nearLinks: status.nearLinks,
  excludedLinks: status.excludedLinks,
  ignoredJointNames: status.ignoredJointNames,
  ignoredLinks: status.ignoredLinks,
  monitoredLinkCount: status.monitoredLinkCount,
  monitoredProxyCount: status.monitoredProxyCount,
  collisionModelProxyCount: status.collisionModelProxyCount,
  visualFallbackProxyCount: status.visualFallbackProxyCount,
  sourcePointCount: status.sourcePointCount,
  indexedPointCount: status.indexedPointCount,
  meshSampleCount: status.meshSampleCount,
  message: status.message,
  detail: status.detail,
});
