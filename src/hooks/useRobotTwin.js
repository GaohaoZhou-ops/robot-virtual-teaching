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
  return { ...state, connect: (address, password) => client.current?.connect(address, password),
    disconnect: () => client.current?.disconnect(), loadCameras, selectCamera, startCamera, stopCamera };
}
