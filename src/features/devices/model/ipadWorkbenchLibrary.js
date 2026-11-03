import { prepareWorkspaceSession, restoreIPadLibraryProject, saveIPadProjectLibrary } from '../../workspace/model/sessionStore.js';

const bridge = () => globalThis.webkit?.messageHandlers?.atlasIPadProjects;
export const isIPadWorkbench = () => typeof bridge()?.postMessage === 'function';
const message = (type, payload = {}) => bridge().postMessage({ type, ...payload });
let launchPromise;

export async function returnToIPadApp() {
  if (!isIPadWorkbench()) return;
  // Native coordinates saving, prevents duplicate exits and keeps the page
  // open with an error if its pending local writes cannot be completed.
  try { await message('return'); }
  catch (error) { await reportIPadLibraryError(error); }
}

export async function saveIPadLibrary(sessionId) {
  if (!isIPadWorkbench()) return;
  const projects = await saveIPadProjectLibrary(sessionId);
  await message('projects', { projects });
}

export async function prepareIPadLibrary(stored) {
  if (!isIPadWorkbench()) return stored;
  // React StrictMode can start hydration twice. Consume one native launch once.
  launchPromise ||= (async () => {
    const launch = await message('launch');
    await saveIPadLibrary(stored.sessionId);
    if (!launch?.id) return false;
    await restoreIPadLibraryProject(stored.sessionId, launch.id);
    await message('opened', { id: launch.id });
    return true;
  })().catch(async (error) => {
    await reportIPadLibraryError(error); throw error;
  });
  return await launchPromise ? prepareWorkspaceSession(stored.sessionId, { preserveExisting: true }) : stored;
}

export async function reportIPadLibraryError(error) {
  if (isIPadWorkbench()) await message('error', { message: `离线工程保存或打开失败：${error.message || error}` }).catch(() => {});
}

export function bindIPadLibrarySave(flush) {
  if (!isIPadWorkbench()) return () => {};
  const api = { flush };
  window.AtlasIPadLibrary = api;
  return () => { if (window.AtlasIPadLibrary === api) delete window.AtlasIPadLibrary; };
}
