import { useEffect, useRef, useState } from 'react';
import { WorkSyncClient } from "../client/workSyncClient.js";
import { isVisionWorkbench } from "../../devices/model/visionWorkbench.js";

export function useWorkSync(adapter, projectRevision) {
  const current = useRef(adapter); current.current = adapter;
  const client = useRef(null);
  const [state, setState] = useState({ phase: 'starting', role: 'peer', requests: [], link: null });
  const [completionLinkId, setCompletionLinkId] = useState(null);
  const completedLinkId = state.link?.transfer?.complete ? state.link.id : null;
  // Share one completion window across home/workbench buttons, including the
  // page transition that happens while installing the received project.
  useEffect(() => {
    setCompletionLinkId(completedLinkId);
    if (!completedLinkId) return undefined;
    const timer = window.setTimeout(() => setCompletionLinkId(null), 1000);
    return () => window.clearTimeout(timer);
  }, [completedLinkId]);
  useEffect(() => {
    const bridge = new Proxy({}, { get: (_, key) => typeof current.current[key] === 'function'
      ? (...args) => current.current[key](...args) : current.current[key] });
    const instance = new WorkSyncClient({ adapter: bridge, onChange: setState,
      ...(isVisionWorkbench() ? { openSocket: null } : {}) });
    client.current = instance; instance.start();
    const leave = () => instance.stop();
    const resume = (event) => { if (event.persisted) instance.start(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume);
    return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', resume); instance.stop(); };
  }, []);
  useEffect(() => { client.current?.projectChanged(); }, [projectRevision]);
  return { ...state, completionActive: Boolean(completedLinkId && completionLinkId === completedLinkId),
    request: () => client.current?.requestAuthorization(),
    prepareTwin: () => client.current?.prepareTwin(),
    disconnect: (...args) => client.current?.disconnect(...args), decide: (id, allow) => client.current?.decide(id, allow) };
}
