"""Explicit live-device test; uses an isolated browser and disposable fixture."""
import os
import json
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21992')


def native_status(device_id):
    command = {'action': 'request', 'deviceId': device_id, 'method': 'GET', 'path': '/status'}
    result = subprocess.run([sys.executable, str(ROOT / 'src/server/ipadScreenUSB.py')],
                            input=json.dumps(command) + '\n', text=True, capture_output=True, timeout=8, check=True)
    reply = json.loads(result.stdout)
    assert reply.get('value', {}).get('status') == 200, reply
    return reply['value']['body']


def run():
    if os.environ.get('ATLAS_SCREEN_LIVE') != '1':
        raise SystemExit('Set ATLAS_SCREEN_LIVE=1 with an unlocked USB device running Atlas.')
    wireless = os.environ.get('ATLAS_SCREEN_WIFI') == '1'
    output = ROOT / os.environ.get('ATLAS_SCREEN_OUTPUT', 'build/ipad-screen-test')
    output.mkdir(parents=True, exist_ok=True)
    native_stop = os.environ.get('ATLAS_SCREEN_NATIVE_STOP') == '1'
    joint_control = os.environ.get('ATLAS_SCREEN_JOINTS') == '1'
    errors, frames, sessions = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
                                    args=['--use-angle=metal', '--enable-gpu'] if sys.platform == 'darwin' else [])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(90000)
        if wireless:
            # Exercise Windows presentation against the real wireless service.
            # The physical cable is used only by native_status diagnostics.
            def windows_info(route):
                response = route.fetch()
                info = response.json(); info['usbSupported'] = False
                route.fulfill(response=response, json=info)
            page.route('**/__atlas/ipad-screen/info', windows_info)
        page.add_init_script('''(() => {
          const original = window.fetch;
          window.__screenSpy = { count: 0 };
          window.fetch = async (url, options) => {
            if (String(url).endsWith('/workspace') && options?.body instanceof Blob) {
              const data = await options.body.arrayBuffer(), view = new DataView(data), size = view.getUint32(0);
              window.__screenSpy.joints = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 8, size)));
              if (view.getUint32(4)) {
                let hash = 2166136261;
                for (const byte of new Uint8Array(data, 8 + size)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
                window.__screenSpy.viewportHash = hash;
              }
            }
            if (String(url).endsWith('/frame') && options?.body instanceof Blob) {
              const data = await options.body.arrayBuffer(), bytes = new Uint8Array(data);
              let hash = 2166136261;
              for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
              window.__screenSpy.hash = hash; window.__screenSpy.count++;
              if (!window.__screenSpy.pixels) {
                const left = new DataView(data).getUint32(0);
                window.__screenSpy.pixels = await Promise.all([bytes.slice(8, 8+left), bytes.slice(8+left)].map(async raw => {
                  const bitmap = await createImageBitmap(new Blob([raw], {type:'image/jpeg'}));
                  const canvas = new OffscreenCanvas(96,60), ctx = canvas.getContext('2d');
                  ctx.drawImage(bitmap,0,0,96,60); bitmap.close();
                  const pixels = ctx.getImageData(0,0,96,60).data; let bright = 0;
                  for (let i=0; i<pixels.length; i+=4) if (Math.max(pixels[i],pixels[i+1],pixels[i+2]) > 80) bright++;
                  return bright;
                }));
              }
            }
            return original(url, options);
          };
        })()''')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('response', lambda response: frames.append(response.status) if '/ipad-screen/session/' in response.url and response.url.endswith('/frame') else None)
        page.on('response', lambda response: sessions.append(response.status) if response.url.endswith('/ipad-screen/session') and response.request.method == 'POST' else None)
        def save_pair(request):
            if request.url.endswith('/frame') and request.post_data_buffer is not None and not (output / 'pair.bin').exists():
                (output / 'pair.bin').write_bytes(request.post_data_buffer)
        page.on('request', save_pair)
        device_id = os.environ.get('ATLAS_SCREEN_DEVICE_ID', '')
        deadline = time.monotonic() + 90
        while not wireless:
            devices = page.request.get(BASE + '/__atlas/ipad-screen/devices').json().get('devices', [])
            if any(device.get('ready') for device in devices):
                device_id = next(device['id'] for device in devices if device.get('ready'))
                break
            if time.monotonic() > deadline:
                raise AssertionError(f'No foreground Atlas App on USB: {devices}')
            page.wait_for_timeout(500)
        page.goto(BASE + '/workbench', wait_until='networkidle')
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
        page.locator('.loading-curtain').wait_for(state='hidden')
        topbar_action(page, name='加载机器人', exact=True).click()
        page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
        page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
        topbar_action(page, name='iPad / iPhone', exact=True).click()
        if wireless:
            with page.expect_response(lambda r: r.url.endswith('/ipad-screen/session') and r.request.method == 'POST') as created:
                page.get_by_role('menuitem', name='画面协作', exact=True).click()
        else:
            page.get_by_role('menuitem', name='画面协作', exact=True).click()
        dialog = page.get_by_role('dialog', name='画面协作', exact=True)
        expect(dialog).to_be_visible()
        if not wireless:
            dialog.get_by_role('button', name='发起邀请', exact=True).click()
        if wireless:
            expect(dialog.get_by_role('tab', name='数据线', exact=True)).to_be_visible()
            ticket = created.value.json()
            expect(dialog.get_by_alt_text('设备配对二维码')).to_be_visible()
            expect(dialog.get_by_role('button', name='重新生成二维码', exact=True)).to_be_enabled()
            page.screenshot(path=str(output / 'desktop-qr.png'))
            (output / 'pairing-qr.png').write_bytes(__import__('base64').b64decode(dialog.get_by_alt_text('设备配对二维码').get_attribute('src').split(',')[1]))
            dialog.get_by_role('tab', name='Wi-Fi', exact=True).click()
            expect(dialog.get_by_label('配对码 ' + ticket['pairingCode'], exact=True)).to_be_visible()
            assert sessions == [201], 'switching QR/Wi-Fi must preserve the pending pairing'
            page.screenshot(path=str(output / 'desktop-wifi.png'))
            ticket['address'] = dialog.get_by_label('协作连接地址').input_value()
            (output / 'pairing.json').write_text(json.dumps(ticket))
            print('WIRELESS_PAIRING_READY ' + str(output / 'pairing.json'), flush=True)
        try:
            expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible(timeout=600000 if wireless else 45000)
        except Exception:
            print(dialog.inner_text(), flush=True)
            page.screenshot(path=str(output / 'desktop-error.png'))
            raise
        pixels = page.evaluate('window.__screenSpy.pixels')
        assert all(count > 100 for count in pixels), f'both cameras must contain visible mesh targets: {pixels}'
        page.screenshot(path=str(output / 'desktop-connected.png'))
        page.get_by_role('button', name='关闭画面协作窗口', exact=True).click()
        expect(dialog).not_to_be_visible()
        if not native_stop:
            page.wait_for_function("[...document.querySelectorAll('.ipad-screen-renderer')].length === 2 && [...document.querySelectorAll('.ipad-screen-renderer')].every(e => e.dataset.rendererStatus === 'ready')")
            # Cameras continue while the inspector's ordinary camera tab is inactive.
            before = len(frames)
            deadline = time.monotonic() + 15
            while len(frames) <= before + 2 and time.monotonic() < deadline:
                page.wait_for_timeout(200)
            assert len(frames) > before + 2, f'independent renderer continues with dialog closed: {frames}'
        page.get_by_role('tab', name='相机', exact=True).click()
        page.wait_for_timeout(1500)
        assert all(code == 200 or (native_stop and code == 410) for code in frames), frames
        page.screenshot(path=str(output / 'desktop-streaming.png'))
        print(f'STREAM_READY {len(frames)} {"Wi-Fi" if wireless else "USB"} frames acknowledged; screenshot: {output}', flush=True)
        if wireless:
            assert native_status(device_id)['connectionKind'] == 'Wi-Fi'
        ready = output / 'stream-ready'; ready.write_text('ready')
        if joint_control:
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            arm_joint = page.get_by_role('spinbutton', name='left_J1 关节值', exact=True)
            arm_joint.fill('12'); arm_joint.press('Enter')
            page.wait_for_function("window.__screenSpy.joints?.joints.some(j => j.name === 'left_J1' && j.value === 12)")
            viewport_hash = page.evaluate('window.__screenSpy.viewportHash')
            # XCTest selects the joint page and drags the actual native Slider.
            page.wait_for_function("Number(document.querySelector('.joint-value-row[data-joint-name=left_J1]')?.dataset.jointValue) !== 12", timeout=int(os.environ.get('ATLAS_SCREEN_NATIVE_TIMEOUT', '90000')))
            moved, previous, settled = None, None, time.monotonic()
            deadline = time.monotonic() + 20
            while True:
                moved = float(page.locator('.joint-value-row[data-joint-name="left_J1"]').get_attribute('data-joint-value'))
                status = native_status(device_id)
                state = (moved, status['controlAck'], status['pendingControls'])
                if state != previous: previous, settled = state, time.monotonic()
                if status['controlAck'] > 0 and status['pendingControls'] == 0 and time.monotonic() - settled > 0.8:
                    assert abs(status['jointValues']['left_J1'] - moved) < 0.001, (status, moved)
                    assert status['controlPage'] == 'joints' and status['viewportFrames'] > 1, status
                    break
                assert time.monotonic() < deadline, status
                page.wait_for_timeout(150)
            page.wait_for_function('(old) => window.__screenSpy.viewportHash !== old', arg=viewport_hash)
            print(f'JOINT_CONTROL_ACKNOWLEDGED left_J1={moved}; 3D viewport updated', flush=True)
            arm_joint.fill('24'); arm_joint.press('Enter')
            page.get_by_role('button', name='关闭全关节浮动窗口').click()
        if not native_stop or os.environ.get('ATLAS_SCREEN_BACKGROUND') == '1':
            # Simulate a hidden workbench, then pause its JS execution. An active
            # WebSocket can exempt a tab from Chrome's normal lifecycle freezing.
            # The browser network stack must retain the USB session beyond both
            # the original 8-second server and 10-second native frame deadlines.
            page.evaluate('''() => {
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
              document.dispatchEvent(new Event('visibilitychange'));
            }''')
            page.wait_for_timeout(2500)
            expect(page.get_by_role('button', name='结束画面协作', exact=True)).to_be_visible()
            client = page.context.new_cdp_session(page)
            client.send('Debugger.enable')
            client.send('Debugger.pause')
            try:
                time.sleep(3)
                paused = native_status(device_id)
                time.sleep(11)
                retained = native_status(device_id)
                assert retained['active'] and retained['stale'], f'iPad must wait for frames without ending: {retained}'
                assert retained['receivedFrames'] == paused['receivedFrames'], 'heartbeat must not replace the retained camera frames'
                assert retained['width'] == 960 and retained['height'] == 600, retained
                if wireless:
                    assert retained['connectionKind'] == 'Wi-Fi', retained
                else:
                    devices = page.request.get(BASE + '/__atlas/ipad-screen/devices').json()['devices']
                    assert any(device.get('active') for device in devices), f'suspended workbench lost USB session: {devices}'
            finally:
                client.send('Debugger.resume')
                client.send('Debugger.disable')
                page.evaluate('''() => {
                  delete document.hidden;
                  document.dispatchEvent(new Event('visibilitychange'));
                }''')
                client.detach()
            before = len(frames)
            deadline = time.monotonic() + 15
            while len(frames) <= before + 2 and time.monotonic() < deadline:
                page.wait_for_timeout(200)
            assert len(frames) > before + 2, 'frame delivery must resume without clicking Start'
            assert sessions == [201], f'background/resume must preserve the same session: {sessions}'
            assert all(code == 200 for code in frames), frames
            old_hash = page.evaluate('window.__screenSpy.hash')
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            # Choose an actual arm joint, leaving the base and fixture unchanged.
            arm_joint = page.get_by_role('spinbutton', name='left_J1 关节值', exact=True)
            arm_joint.fill('12'); arm_joint.press('Enter')
            page.wait_for_function('(old) => window.__screenSpy.hash !== old', arg=old_hash, timeout=20000)
            page.get_by_role('button', name='关闭全关节浮动窗口').click()
        hold = float(os.environ.get('ATLAS_SCREEN_HOLD', '0'))
        if hold:
            deadline = time.monotonic() + hold
            while time.monotonic() < deadline and not (output / 'finish').exists():
                if native_stop and page.locator('.ipad-screen-renderer').count() == 0:
                    break
                page.wait_for_timeout(500)
        if native_stop:
            expect(page.locator('.ipad-screen-renderer')).to_have_count(0)
            expect(page.get_by_role('alert').filter(has_text='协作')).to_be_visible()
        if page.get_by_role('button', name='结束画面协作', exact=True).count():
            page.get_by_role('button', name='结束画面协作', exact=True).click()
        expect(page.locator('.ipad-screen-renderer')).to_have_count(0)
        if not native_stop and not wireless:
            # An actual page close must release the device, even with keepalive enabled.
            topbar_action(page, name='iPad / iPhone', exact=True).click()
            page.get_by_role('menuitem', name='画面协作', exact=True).click()
            expect(page.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
            page.close()
            deadline = time.monotonic() + 10
            while native_status(device_id)['active']:
                assert time.monotonic() < deadline, 'closing the workbench must stop device collaboration'
                time.sleep(0.2)
        assert not errors, errors
        browser.close()
        checks = ['menu', 'dual rendering']
        if wireless:
            checks.extend(['Windows connection choices', 'QR/Wi-Fi pairing reuse', 'native Wi-Fi transport'])
        if joint_control:
            checks.extend(['native joint drag', 'bidirectional joint values', '3D viewport update'])
        if not native_stop or os.environ.get('ATLAS_SCREEN_BACKGROUND') == '1':
            checks.extend(['hidden/suspended workbench', 'native retained frames', 'automatic resume', 'same session'])
        if native_stop:
            checks.append('native stop')
        else:
            checks.append('explicit stop')
            if not wireless:
                checks.append('tab close')
        print('iPad screen live UI passed: ' + ', '.join(checks) + '.', flush=True)


if __name__ == '__main__':
    run()
