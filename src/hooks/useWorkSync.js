import { useEffect, useRef, useState } from 'react';
import { WorkSyncClient } from '../lib/workSyncClient.js';

export function useWorkSync(adapter, projectRevision) {
  const current = useRef(adapter); current.current = adapter;
  const client = useRef(null);
  const [state, setState] = useState({ phase: 'starting', role: 'peer', requests: [], link: null });
  useEffect(() => {
    const bridge = new Proxy({}, { get: (_, key) => typeof current.current[key] === 'function'
      ? (...args) => current.current[key](...args) : current.current[key] });
    const instance = new WorkSyncClient({ adapter: bridge, onChange: setState });
    client.current = instance; instance.start();
    const leave = () => instance.stop();
    const resume = (event) => { if (event.persisted) instance.start(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume);
    return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', resume); instance.stop(); };
  }, []);
  useEffect(() => { client.current?.projectChanged(); }, [projectRevision]);
  return { ...state, request: () => client.current?.requestAuthorization(),
    disconnect: (...args) => client.current?.disconnect(...args), decide: (id, allow) => client.current?.decide(id, allow) };
}
