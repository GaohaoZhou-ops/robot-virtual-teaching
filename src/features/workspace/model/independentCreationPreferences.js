const STORAGE_KEY = 'atlas-route-studio:independent-creation-preferences-v1';

export function loadIndependentCreationPreferences() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
    if (saved?.version === 1) return {
      syncRoute: typeof saved.syncRoute === 'boolean' ? saved.syncRoute : true,
      placeInMap: typeof saved.placeInMap === 'boolean' ? saved.placeInMap : true,
    };
  } catch {
    // A missing or unreadable preference must not prevent opening the dialog.
  }
  return { syncRoute: true, placeInMap: true };
}

export function saveIndependentCreationPreferences({ syncRoute, placeInMap }) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, syncRoute, placeInMap }));
  } catch {
    // Keep the current choices usable even when browser storage is unavailable.
  }
}
