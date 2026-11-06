import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseReleaseMinute, formatReleaseMinute, createReleaseClock } from '../../desktop/release-policy.mjs';

const start = Date.parse('2026-11-06T03:00:00Z');
assert.equal(parseReleaseMinute('2026-11-06 14:00', start), '2026-11-06T06:00:00.000Z');
assert.equal(formatReleaseMinute('2026-11-06T06:00:00Z'), '2026-11-06 14:00');
for (const input of ['2026-02-30 14:00', '2026-11-06 24:00', '2026-11-06 14:60', '11/06/2026 14:00', '2026-11-06', '2026-11-06 14:00:01', '2026-11-06 10:59']) {
  assert.throws(() => parseReleaseMinute(input, start), undefined, input);
}
const policy = { version: '1.0.0', buildId: 'test.1', builtAt: new Date(start).toISOString(),
  expiresAt: new Date(start + 120000).toISOString(), warnBeforeDays: 7 };
let wall = start, monotonic = 0;
const clock = createReleaseClock(policy, { wallNow: () => wall, monotonicNow: () => monotonic });
assert.equal(clock.snapshot().status, 'warning');
wall += 60000; monotonic += 60000;
assert.equal(clock.snapshot().remainingMs, 60000);
wall -= 86400000; monotonic += 59999;
assert.equal(clock.snapshot().status, 'warning');
monotonic += 1;
assert.equal(clock.snapshot().status, 'expired', 'locks exactly at cutoff even after wall-clock rollback');
const lastSeen = clock.snapshot().now;
assert.equal(createReleaseClock(policy, { lastSeen, wallNow: () => start }).snapshot().status, 'expired', 'same package reinstall does not reset persisted cutoff');
const later = { ...policy, expiresAt: new Date(start + 86400000).toISOString() };
assert.equal(createReleaseClock(later, { lastSeen, wallNow: () => lastSeen }).snapshot().status, 'warning', 'a new release restores use');
assert.throws(() => createReleaseClock({ ...policy, expiresAt: undefined }));
assert.throws(() => createReleaseClock({ ...policy, expiresAt: policy.builtAt }));
for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
  const actual = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {parseReleaseMinute} from './desktop/release-policy.mjs';console.log(parseReleaseMinute('2026-11-06 14:00', ${start}))`],
  { cwd: new URL('../../', import.meta.url), env: { ...process.env, TZ: timezone }, encoding: 'utf8' }).trim();
  assert.equal(actual, '2026-11-06T06:00:00.000Z');
}
console.log('Desktop expiry: minute boundary, timezone, invalid dates, rollback, restart and new release passed.');
