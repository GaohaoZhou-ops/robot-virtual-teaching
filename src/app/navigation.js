export const APP_PAGE_HOME = 'home';

export const APP_PAGE_WORKBENCH = 'workbench';

export const APP_PAGE_TEACHING_DATA = 'teaching-data';

export const APP_PAGE_MODEL_EDITOR = 'model-editor';

export const APP_PAGE_MODEL_PAIR_EDITOR = 'model-editor/dual';

export const appPageFromLocation = () => {
  if (typeof window === 'undefined') return APP_PAGE_HOME;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.endsWith('/teaching-data')) return APP_PAGE_TEACHING_DATA;
  if (path.endsWith('/model-editor/dual')) return APP_PAGE_MODEL_PAIR_EDITOR;
  if (path.endsWith('/model-editor')) return APP_PAGE_MODEL_EDITOR;
  if (path.endsWith('/workbench')) return APP_PAGE_WORKBENCH;
  return APP_PAGE_HOME;
};
