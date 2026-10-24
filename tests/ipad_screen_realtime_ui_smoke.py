"""Opt-in Mac + physical iPad benchmark. Pair with testLiveScreenRealtimeUSB.

Uses a disposable browser profile/project. Latency ends at the iPad's decoded
image acknowledgement, not at physical display scanout.
"""
import json
import os
import statistics
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21992')
OUTPUT = ROOT / os.environ.get('ATLAS_SCREEN_OUTPUT', 'build/ipad-realtime-validation')
BACKGROUND = os.environ.get('ATLAS_SCREEN_REALTIME_BACKGROUND') == '1'
SPY = r'''(() => {
  const stats = window.__realtime = { images: [], cameras: [], inputs: [], latency: [], maxInFlight: 0, inFlight: 0 };
  let sequence = 0; const pending = new Map();
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args);
      if (!String(args[0]).endsWith('/events')) return;
      this.addEventListener('message', event => {
        const value = JSON.parse(event.data);
        if (value.page) stats.page = value.page;
        for (const command of value.viewportCommands || []) {
          if (command.sequence <= sequence) continue;
          sequence = command.sequence;
          const age = Math.max(0, Date.now() - command.receivedAt + command.ageMs);
          pending.set(command.sequence, performance.now() - age);
          stats.inputs.push({ sequence, kind: command.kind, age });
        }
      });
    }
  };
  const fetch = window.fetch;
  window.fetch = async (url, options) => {
    const workspace = String(url).endsWith('/workspace');
    const frame = String(url).endsWith('/frame');
    if (!(workspace || frame) || !(options?.body instanceof Blob)) return fetch(url, options);
    let state, image = false;
    if (workspace) {
      const raw = await options.body.arrayBuffer(), header = new DataView(raw);
      state = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 8, header.getUint32(0))));
      image = header.getUint32(4) > 0;
    }
    stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        const now = performance.now();
        if (frame) stats.cameras.push(now);
        if (workspace && image) {
          stats.images.push({ time: now, ack: state.viewportControl.ack, page: stats.page, hidden: document.hidden, bytes: options.body.size });
          for (const [id, started] of pending) {
            if (id <= state.viewportControl.ack) { stats.latency.push(now - started); pending.delete(id); }
          }
        }
      }
      return response;
    } finally { stats.inFlight--; }
  };
})();'''


def run():
    if os.environ.get('ATLAS_SCREEN_REALTIME_LIVE') != '1':
        raise SystemExit('Set ATLAS_SCREEN_REALTIME_LIVE=1 with the matching physical iPad UI test.')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    native_log = os.environ.get('ATLAS_SCREEN_NATIVE_LOG')
    if native_log:
        deadline = time.monotonic() + 180
        while 'ATLAS_SCREEN_REALTIME_WAITING' not in Path(native_log).read_text(errors='replace'):
            assert time.monotonic() < deadline, 'Native test did not start'
            time.sleep(0.25)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
                                    args=['--use-angle=metal', '--enable-gpu'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(60000)
        page.add_init_script(SPY)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            map_file = os.environ.get('ATLAS_SCREEN_MAP', 'tests/fixtures/ipad-screen-targets.ply')
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / map_file))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            if os.environ.get('ATLAS_SCREEN_MAP'):
                page.get_by_role('button', name='视图工具', exact=True).click()
                page.get_by_role('button', name='定位机器人模型', exact=True).click()
                page.keyboard.press('Escape')
                page.wait_for_timeout(750)
            print('REALTIME_MAP_READY ' + map_file, flush=True)
            topbar_action(page, name='iPad / iPhone', exact=True).click()
            page.get_by_role('menuitem', name='画面协作', exact=True).click()
            with page.expect_response(lambda r: r.url.endswith('/ipad-screen/session') and r.request.method == 'POST') as created:
                page.get_by_role('dialog', name='画面协作', exact=True).get_by_role('button', name='发起邀请', exact=True).click()
            ticket = created.value.json()
            assert ticket.get('realtimeUSB') is True, 'Install the new iPad app and restart the Mac service'
            dialog = page.get_by_role('dialog', name='画面协作', exact=True)
            expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='关闭画面协作窗口', exact=True).click()
            if BACKGROUND:
                # Headless Chromium keeps every tab visible. Exercise the hidden
                # render path with RAF suspended and browser timers clamped to 1s.
                page.evaluate('''() => {
                  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                  window.requestAnimationFrame = () => 0;
                  const timeout = window.setTimeout;
                  window.setTimeout = (callback, delay, ...args) => timeout(callback, Math.max(delay || 0, 1000), ...args);
                  document.dispatchEvent(new Event('visibilitychange'));
                }''')
            print('REALTIME_USB_CONNECTED', flush=True)
            deadline = time.monotonic() + 180
            screenshot = False
            while page.get_by_role('button', name='结束画面协作', exact=True).count():
                assert time.monotonic() < deadline, 'Native gestures did not finish'
                page.wait_for_timeout(250)
                if not screenshot and page.evaluate('window.__realtime.inputs.length > 10'):
                    page.screenshot(path=str(OUTPUT / 'desktop.png'))
                    screenshot = True
            stats = page.evaluate('window.__realtime')
            assert not errors, errors
            assert {'rotate', 'zoom'}.issubset({item['kind'] for item in stats['inputs']})
            assert stats['maxInFlight'] == 1, 'Frame backpressure must remain bounded'
            images = [item for item in stats['images'] if item.get('page') == 'joints']
            # Split at camera-page switches instead of hiding arbitrary slow frames.
            intervals = [b['time'] - a['time'] for a, b in zip(stats['images'], stats['images'][1:])
                         if a.get('page') == b.get('page') == 'joints'
                         and not any(a['time'] < time < b['time'] for time in stats['cameras'])]
            latency = sorted(stats['latency'])
            assert len(intervals) >= 30 and len(latency) >= 10, 'Insufficient live samples'
            metrics = {'map': map_file, 'simulated_background': BACKGROUND, 'viewport_frames': len(images), 'median_frame_interval_ms': statistics.median(intervals),
                       'median_fps': 1000 / statistics.median(intervals), 'gesture_samples': len(latency),
                       'active_average_fps': len(intervals) * 1000 / sum(intervals),
                       'frame_interval_p95_ms': sorted(intervals)[int((len(intervals) - 1) * .95)],
                       'input_to_image_ack_median_ms': statistics.median(latency),
                       'input_to_image_ack_p95_ms': latency[int((len(latency) - 1) * .95)],
                       'max_in_flight': stats['maxInFlight']}
            (OUTPUT / 'metrics.json').write_text(json.dumps(metrics, indent=2))
            (OUTPUT / 'samples.json').write_text(json.dumps(stats, indent=2))
            print(json.dumps(metrics, indent=2), flush=True)
            assert metrics['median_fps'] >= 23, 'Viewport refresh below the interactive target'
            assert metrics['active_average_fps'] >= 23, 'Continuous viewport refresh below the interactive target'
            assert metrics['input_to_image_ack_p95_ms'] < 150, 'Input still waits too long for a decoded image'
        except Exception:
            page.screenshot(path=str(OUTPUT / 'failure.png'))
            (OUTPUT / 'failure-buttons.json').write_text(json.dumps(page.get_by_role('button').all_text_contents(), ensure_ascii=False))
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
