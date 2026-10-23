"""Real viewport/transport checks; ATLAS_SCREEN_VIEWPORT_LIVE=1 also exercises iPad gestures."""
import json
import os
import subprocess
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action
from ipad_screen_capture_ui_smoke import PEER, ROOT, DEVICE
from ipad_screen_ui_smoke import native_status

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21992')
LIVE = os.environ.get('ATLAS_SCREEN_VIEWPORT_LIVE') == '1'
OUTPUT = ROOT / 'build/screen-viewport-validation' / ('live' if LIVE else 'lan')


def run():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ['state.json', 'command.json']:
        (OUTPUT / name).unlink(missing_ok=True)
    peer = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
            args=['--use-angle=metal', '--enable-gpu'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(90000)
        page.add_init_script('''(() => {
            const original = window.fetch;
            window.fetch = async (url, options) => {
                if (String(url).endsWith('/workspace') && options?.body instanceof Blob) {
                    const bytes = await options.body.arrayBuffer(), header = new DataView(bytes);
                    if (header.getUint32(4)) {
                        const image = await createImageBitmap(new Blob([bytes.slice(8 + header.getUint32(0))], {type: 'image/jpeg'}));
                        window.__sharedViewportFrame = {width: image.width, height: image.height,
                            count: (window.__sharedViewportFrame?.count || 0) + 1};
                        image.close();
                    }
                }
                return original(url, options);
            };
        })()''')
        errors, motions = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        def socket_opened(socket):
            if socket.url.endswith('/events'):
                socket.on('framereceived', lambda data: motions.extend(json.loads(data).get('viewportCommands', [])))
        page.on('websocket', socket_opened)
        if not LIVE:
            def windows_info(route):
                response = route.fetch(); info = response.json(); info['usbSupported'] = False
                route.fulfill(response=response, json=info)
            page.route('**/__atlas/ipad-screen/info', windows_info)

        def state():
            file = OUTPUT / 'state.json'
            return json.loads(file.read_text()) if file.exists() else {}

        def wait(check, label, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = state()
                if check(value): return value
                page.wait_for_timeout(100)
            raise AssertionError(label + ': ' + json.dumps(state()))

        def gesture(sequence, kind, dx=0, dy=0, zoom=0, age=0):
            command = {'robotId': state()['robotId'], 'sequence': sequence, 'kind': kind, 'dx': dx, 'dy': dy, 'zoom': zoom}
            (OUTPUT / 'command.json').write_text(json.dumps({'page': 'joints', 'viewportCommands': [command], 'created': int(time.time() * 1000) - age}))
            if age < 3000: wait(lambda s: s['viewportControl']['ack'] == sequence, kind + ' acknowledgement')

        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            if LIVE:
                # XCTest relaunches the app. Wait for that relaunch before
                # connecting, so the old installed app cannot claim the session.
                native_log = os.environ.get('ATLAS_SCREEN_NATIVE_LOG')
                if native_log:
                    deadline = time.monotonic() + 180
                    while 'Waiting 180.0s for "screen-collaboration-stop"' not in Path(native_log).read_text(errors='replace'):
                        assert time.monotonic() < deadline, 'Native test did not finish launching the app'
                        page.wait_for_timeout(300)
                deadline = time.monotonic() + 180
                while True:
                    devices = page.request.get(BASE + '/__atlas/ipad-screen/devices').json()['devices']
                    if any(device.get('ready') for device in devices): break
                    assert time.monotonic() < deadline, devices
                    page.wait_for_timeout(500)
            topbar_action(page, name='iPad / iPhone', exact=True).click()
            with page.expect_response(lambda r: r.url.endswith('/ipad-screen/session') and r.request.method == 'POST') as created:
                page.get_by_role('menuitem', name='画面协作', exact=True).click()
            ticket = created.value.json()
            if not LIVE:
                credential = page.request.post(BASE + '/__atlas/ipad-screen/pair', data={
                    'code': ticket['pairingCode'], 'deviceId': 'viewport-test-ipad', 'deviceName': 'Viewport test iPad'}).json()
                (OUTPUT / 'peer.json').write_text(json.dumps({'base': BASE, 'ticket': ticket, 'credential': credential}))
                peer = subprocess.Popen(['node', '--input-type=module', '-e', PEER, str(OUTPUT)], cwd=ROOT)
            dialog = page.get_by_role('dialog', name='画面协作', exact=True)
            expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='关闭画面协作窗口', exact=True).click()
            canvas = page.locator('.three-canvas')
            def check_frame_aspect(after=0):
                page.wait_for_function('''(after) => {
                    const frame = window.__sharedViewportFrame, source = document.querySelector('.three-canvas');
                    return frame && frame.count > after && source?.height
                        && Math.abs(frame.width - frame.height * source.width / source.height) <= 2
                        && frame.width <= 960 && frame.height <= 600
                        && (frame.width === 960 || frame.height === 600);
                }''', arg=after)
            check_frame_aspect()
            robot = [canvas.get_attribute('data-robot-' + key) for key in ['x', 'y', 'z', 'yaw', 'joint-values']]
            initial = canvas.get_attribute('data-view-signature')
            if LIVE:
                deadline = time.monotonic() + 240
                while not {'rotate', 'zoom'}.issubset({c['kind'] for c in motions}):
                    assert time.monotonic() < deadline, motions
                    page.wait_for_timeout(200)
                expect(page.get_by_role('button', name='结束画面协作', exact=True)).not_to_be_visible(timeout=180000)
                assert canvas.get_attribute('data-view-signature') != initial
                print('PASS physical iPad gestures received: ' + ', '.join(sorted({c['kind'] for c in motions})), flush=True)
            else:
                wait(lambda s: s.get('viewportControl', {}).get('enabled'), 'viewport ready')
                (OUTPUT / 'command.json').write_text(json.dumps({'page': 'joints'}))
                wait(lambda s: s.get('viewportHash'), 'first viewport image')
                gesture(1, 'rotate', dx=0.08, dy=0.04)
                rotated = canvas.get_attribute('data-view-signature')
                assert rotated != initial
                image = state()['viewportHash']
                distance = float(canvas.get_attribute('data-effective-camera-distance'))
                gesture(2, 'zoom', zoom=0.6931471805599453)
                assert abs(float(canvas.get_attribute('data-effective-camera-distance')) / distance - 0.5) < 1e-6
                assert state()['viewportHash'] != image
                targets = [canvas.get_attribute('data-target-' + key) for key in ['x', 'y', 'z']]
                direction = [canvas.get_attribute('data-camera-up-' + key) for key in ['x', 'y', 'z']]
                gesture(3, 'pan', dx=0.12, dy=-0.07)
                assert targets != [canvas.get_attribute('data-target-' + key) for key in ['x', 'y', 'z']]
                assert direction == [canvas.get_attribute('data-camera-up-' + key) for key in ['x', 'y', 'z']]
                applied = canvas.get_attribute('data-view-signature')
                page.wait_for_timeout(600)
                assert canvas.get_attribute('data-view-signature') == applied, 'Repeated packets must not repeat relative motion'
                gesture(4, 'pan', dx=0.2, age=4000)
                page.wait_for_timeout(400)
                assert canvas.get_attribute('data-view-signature') == applied, 'Expired motion must not move the view'
                page.evaluate('''() => {
                    window.__viewportRAF = window.requestAnimationFrame;
                    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                    window.requestAnimationFrame = () => 0;
                    document.dispatchEvent(new Event('visibilitychange'));
                }''')
                try:
                    before = state()['viewportHash']
                    gesture(5, 'rotate', dx=-0.05, dy=0.02)
                    assert state()['viewportHash'] != before, 'Background navigation must render a fresh image'
                finally:
                    page.evaluate('''() => {
                        window.requestAnimationFrame = window.__viewportRAF; delete document.hidden;
                        document.dispatchEvent(new Event('visibilitychange'));
                    }''')
                for width, height in [(1100, 900), (1700, 800), (1440, 1000)]:
                    frames = page.evaluate('window.__sharedViewportFrame.count')
                    page.set_viewport_size({'width': width, 'height': height})
                    check_frame_aspect(after=frames + 2)
                print('PASS shared JPEG keeps the source aspect and resolution across window resizing', flush=True)
                page.screenshot(path=str(OUTPUT / 'navigated-workbench.png'))
                page.get_by_role('button', name='结束画面协作', exact=True).click()
                print('PASS LAN rotation, pinch ratio, pan, replay/expiry and background image updates', flush=True)
            assert robot == [canvas.get_attribute('data-robot-' + key) for key in ['x', 'y', 'z', 'yaw', 'joint-values']], 'Gestures must not change robot pose or joints'
            assert not errors, errors
            (OUTPUT / 'motions.json').write_text(json.dumps(motions, indent=2))
            print('PASS robot pose and joints unchanged; no browser errors', flush=True)
        finally:
            browser.close()
            if peer: peer.terminate(); peer.wait(timeout=10)


if __name__ == '__main__':
    run()
