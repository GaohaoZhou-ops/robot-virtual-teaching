import { useEffect, useRef, useState } from 'react';
import { RobotTwinFleet } from '../lib/robotTwinFleet.js';

export function useRobotTwin(contextKey) {
  const client = useRef(null);
  const [state, setState] = useState({ active: false, phase: 'idle', pose: null, joints: {}, robots: [], error: '' });
  useEffect(() => {
    const instance = new RobotTwinFleet({ onChange: setState });
    client.current = instance;
    const leave = () => instance.disconnect();
    const visibility = () => { if (document.hidden) instance.stopCameras(); };
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
  return { ...state, ...state.access,
    connectMany: (profiles) => client.current?.connectMany(profiles),
    selectRobot: (id) => client.current?.select(id),
    disconnect: () => client.current?.disconnect() };
}
