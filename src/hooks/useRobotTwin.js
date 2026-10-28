import { useCallback, useEffect, useRef, useState } from 'react';
import { RobotTwinClient } from '../lib/robotTwinClient.js';

export function useRobotTwin(contextKey) {
  const client = useRef(null);
  const [state, setState] = useState({ active: false, phase: 'idle', pose: null, joints: {}, error: '' });
  useEffect(() => {
    const instance = new RobotTwinClient({ onChange: setState });
    client.current = instance;
    const leave = () => instance.disconnect();
    const visibility = () => { if (document.hidden) void instance.cameraClient.stop(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', visibility);
      instance.onChange = () => {};
      instance.disconnect();
    };
  }, []);
  useEffect(() => { client.current?.disconnect(); }, [contextKey]);
  const loadCameras = useCallback(() => client.current?.cameraClient.load(), []);
  const selectCamera = useCallback((id) => client.current?.cameraClient.select(id), []);
  const startCamera = useCallback(() => client.current?.cameraClient.start(), []);
  const stopCamera = useCallback((message) => client.current?.cameraClient.stop(message), []);
  const readCapture = useCallback((id, side, kind, signal) => client.current?.api(`/captures/${id}/${side}/${kind}`,
    { binary: true, timeoutMs: 65_000, signal }), []);
  const readCaptureHistory = useCallback((runId, offset, signal) => client.current?.api(`/capture-history/${runId}/${offset}`,
    { timeoutMs: 30_000, signal }), []);
  return { ...state, connect: (address, password, profileId) => client.current?.connect(address, password, profileId),
    disconnect: () => client.current?.disconnect(), loadCameras, selectCamera, startCamera, stopCamera, readCapture, readCaptureHistory };
}
