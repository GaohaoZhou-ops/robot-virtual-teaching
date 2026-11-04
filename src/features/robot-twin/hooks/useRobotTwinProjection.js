import { useEffect, useRef, useState } from 'react';
import { RobotTwinProjectionLayer } from '../model/robotTwinProjectionLayer.js';

export function useRobotTwinProjection({ enabled, geometry, modelStatus, modelRef, sceneRef, displayGeometryRef,
  surfaceGeometryRef, cloudMaterialRef, controlsRef, robots, height, twinSceneRef }) {
  const layer = useRef(null);
  const [visible, setVisible] = useState({ left: true, right: true });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || modelStatus !== 'loaded' || !geometry || !modelRef.current || !displayGeometryRef.current) return undefined;
    const instance = new RobotTwinProjectionLayer({ scene: sceneRef.current, model: modelRef.current, geometry,
      displayGeometry: displayGeometryRef.current, surfaceGeometry: surfaceGeometryRef.current?.geometry,
      material: cloudMaterialRef.current, canvas: controlsRef.current.domElement, onStatus: setError });
    layer.current = instance; setError('');
    return () => { instance.dispose(); if (layer.current === instance) layer.current = null; };
  }, [enabled, geometry, modelStatus]);
  useEffect(() => {
    layer.current?.sync(robots, height, twinSceneRef.current?.heightOffsets);
  }, [enabled, geometry, modelStatus, robots, height]);
  useEffect(() => { layer.current?.setVisible(visible); }, [enabled, geometry, modelStatus, visible]);
  const missing = robots.reduce((sum, robot) => sum + (robot.captureProjectionMissing || 0), 0);
  return { visible, toggle: (side) => setVisible((value) => ({ ...value, [side]: !value[side] })),
    message: enabled ? error || (missing ? `${missing} 次采集缺少拍照时的有效定位或姿态，未生成投影` : '拍照后保留模型表面投影，停止同步后清除') : '真机孪生拍照后显示模型表面投影' };
}
