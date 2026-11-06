// All release times entered by the publisher are Beijing time, independent of
// the build machine's timezone. This module is also used by the interactive CLI.
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

export function parseReleaseMinute(value, now = Date.now()) {
  const input = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(input);
  if (!match) throw new Error('请输入 YYYY-MM-DD HH:mm，例如 2026-12-01 14:30（北京时间）。');
  const [, year, month, day, hour, minute] = match.map(Number);
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(local);
  if (year < 2020 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    throw new Error('日期或时间无效，请检查月份、日期、小时和分钟。');
  }
  const expires = local - BEIJING_OFFSET;
  if (expires <= now) throw new Error('失效时间必须晚于当前时间。');
  return new Date(expires).toISOString();
}

export function formatReleaseMinute(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(value)).replaceAll('/', '-');
}

export function validateRelease(release) {
  if (!release || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.version || '')
    || !/^[\w.-]+$/.test(release.buildId || '') || !Number.isFinite(Date.parse(release.builtAt))
    || !Number.isFinite(Date.parse(release.expiresAt)) || Date.parse(release.expiresAt) <= Date.parse(release.builtAt)
    || !Number.isInteger(release.warnBeforeDays) || release.warnBeforeDays < 0 || release.warnBeforeDays > 90) {
    throw new Error('发布信息无效，请联系发布者重新打包。');
  }
  return Object.freeze({ ...release });
}

// High-water time survives ordinary reinstall/update. Monotonic elapsed time
// prevents moving the system clock backwards from extending a running session.
// This is an offline version policy, not tamper-proof licensing.
export function createReleaseClock(release, { lastSeen = 0, wallNow = Date.now,
  monotonicNow = () => performance.now() } = {}) {
  const policy = validateRelease(release);
  let effective = Math.max(wallNow(), Number(lastSeen) || 0, Date.parse(policy.builtAt));
  let tick = monotonicNow();
  return {
    snapshot() {
      const next = monotonicNow();
      effective = Math.max(wallNow(), effective + Math.max(0, next - tick));
      tick = next;
      const remainingMs = Date.parse(policy.expiresAt) - effective;
      return { ...policy, now: effective, remainingMs,
        status: remainingMs <= 0 ? 'expired' : remainingMs <= policy.warnBeforeDays * 86400000 ? 'warning' : 'active' };
    },
  };
}
