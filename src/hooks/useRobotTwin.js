import { useEffect, useRef, useState } from 'react';
import { RobotTwinClient } from '../lib/robotTwinClient.js';

export function useRobotTwin(contextKey) {
  const client = useRef(null);
  const [state, setState] = useState({ active: false, phase: 'idle', pose: null, joints: {}, error: '' });
  useEffect(() => {
    const instance = new RobotTwinClient({ onChange: setState });
    client.current = instance;
    const leave = () => instance.disconnect();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      instance.onChange = () => {};
      instance.disconnect();
    };
  }, []);
  useEffect(() => { client.current?.disconnect(); }, [contextKey]);
  return { ...state, connect: (address, password) => client.current?.connect(address, password),
    disconnect: () => client.current?.disconnect() };
}
