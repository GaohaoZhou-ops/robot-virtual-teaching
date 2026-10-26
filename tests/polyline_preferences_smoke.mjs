import assert from 'node:assert/strict';
import { normalizePolyline, POLYLINE_DEFAULTS, POLYLINE_MAX_SPEED } from '../src/lib/polylineTeaching.js';
import { loadPolylinePreferences, savePolylinePreferences, POLYLINE_PREFERENCES_KEY } from '../src/lib/polylineTeachingPreferences.js';
import { POLYLINE_ALGORITHM_FIELDS } from '../src/lib/polylineTeachingParameters.js';

const entries = new Map([['unrelated', 'preserve']]);
const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
assert.equal(loadPolylinePreferences(storage), null);
assert.equal(POLYLINE_DEFAULTS.speed, .3);
assert.equal(POLYLINE_MAX_SPEED, .3);
assert.equal(normalizePolyline({ points: [] }).settings.speed, .3);
for (const speed of [.001, .05, .275, .3]) {
  assert.equal(normalizePolyline({ points: [], settings: { speed } }).settings.speed, speed);
}
for (const speed of [0, .301, Infinity, NaN]) assert.equal(normalizePolyline({ points: [], settings: { speed } }), null);
for (const field of POLYLINE_ALGORITHM_FIELDS) {
  assert.equal(normalizePolyline({ points: [] }).settings[field.key], field.default, 'old records retain current algorithm defaults');
  for (const value of [field.min, field.max]) assert.equal(normalizePolyline({ points: [], settings: { [field.key]: value } }).settings[field.key], value);
  for (const value of [field.min - 1, field.max + 1, Infinity, NaN, ...(field.integer ? [field.default + .5] : [])]) {
    assert.equal(normalizePolyline({ points: [], settings: { [field.key]: value } }), null, `reject invalid ${field.key}`);
  }
}

const saved = normalizePolyline({ id: 'saved-line', name: 'Keep this saved record', side: 'right',
  points: [{ position: [1, 2, 3] }, { position: [2, 2, 3] }], closed: true, quaternion: [0, 0, 0, 1],
  tcpOffset: [.01, -.005, 0], toolAxisDirection: 1,
  settings: { speed: .275, acceleration: .35, tolerance: .002, step: .005, rotationTolerance: .7, uniformSpeed: false,
    deepSearchSeconds: 30, deepSearchCandidates: 64, postureRetries: 24, postureSamples: 192 },
  base: { sync: true, search: true, allowPartial: true, waistAssist: true, range: 1.3, yawRange: 75 } });
const before = structuredClone(saved);
assert.equal(savePolylinePreferences(saved, storage), true);
const restored = loadPolylinePreferences(storage);
for (const key of ['side', 'tcpOffset', 'toolAxisDirection', 'settings', 'base']) assert.deepEqual(restored[key], saved[key]);
assert.equal(restored.toolAxisDirection, 1, 'retain direction at zero distance');
const encoded = JSON.parse(entries.get(POLYLINE_PREFERENCES_KEY));
assert.deepEqual(Object.keys(encoded).sort(), ['base', 'pathType', 'settings', 'side', 'tcpOffset', 'toolAxisDirection', 'version']);
assert.deepEqual(saved, before, 'remembering parameters cannot change the saved record');
assert.equal(entries.get('unrelated'), 'preserve');
restored.tcpOffset[0] = .2;
restored.settings.speed = .125;
assert.deepEqual(saved, before, 'restored preferences are independent of saved paths');
assert.equal(savePolylinePreferences(restored, storage), true);
assert.equal(loadPolylinePreferences(storage).settings.speed, .125);
const lastGood = entries.get(POLYLINE_PREFERENCES_KEY);
assert.equal(savePolylinePreferences({ ...saved, settings: { speed: 1 } }, storage), false);
assert.equal(entries.get(POLYLINE_PREFERENCES_KEY), lastGood, 'invalid input cannot overwrite the remembered configuration');

for (const value of ['{bad-json', 'null', '[]', '{"version":2}', '{"version":1,"tcpOffset":[0,0,2]}', '{"version":1,"settings":{"speed":1}}']) {
  entries.set(POLYLINE_PREFERENCES_KEY, value);
  assert.equal(loadPolylinePreferences(storage), null);
}
for (const unavailable of [null, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } }]) {
  assert.equal(loadPolylinePreferences(unavailable), null);
  assert.equal(savePolylinePreferences(saved, unavailable), false);
}
// Some browsers throw while merely accessing localStorage, before getItem.
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
try {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage access denied'); } });
  assert.equal(loadPolylinePreferences(), null);
  assert.equal(savePolylinePreferences(saved), false);
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
}
console.log('Polyline preferences: 300 mm/s default/range, legacy speeds, parameter-only persistence, zero direction, record isolation and invalid/blocked storage recovery passed.');
