"""Explicit live-device test; uses an isolated browser and disposable fixture."""
import os
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21992')


def run():
    if os.environ.get('ATLAS_SCREEN_LIVE') != '1':
        raise SystemExit('Set ATLAS_SCREEN_LIVE=1 with an unlocked USB device running Atlas.')
    output = ROOT / 'build/ipad-screen-test'
    output.mkdir(parents=True, exist_ok=True)
    native_stop = os.environ.get('ATLAS_SCREEN_NATIVE_STOP') == '1'
    errors, frames = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
                                    args=['--use-angle=metal', '--enable-gpu'] if sys.platform == 'darwin' else [])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(90000)
        page.add_init_script('''(() => {
          const original = window.fetch;
          window.__screenSpy = { count: 0 };
          window.fetch = async (url, options) => {
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
        def save_pair(request):
            if request.url.endswith('/frame') and request.post_data_buffer is not None and not (output / 'pair.bin').exists():
                (output / 'pair.bin').write_bytes(request.post_data_buffer)
        page.on('request', save_pair)
        deadline = time.monotonic() + 90
        while True:
            devices = page.request.get(BASE + '/__atlas/ipad-screen/devices').json().get('devices', [])
            if any(device.get('ready') for device in devices):
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
        page.get_by_role('menuitem', name='画面协作', exact=True).click()
        dialog = page.get_by_role('dialog', name='画面协作', exact=True)
        expect(dialog).to_be_visible()
        try:
            expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible(timeout=45000)
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
        print(f'STREAM_READY {len(frames)} USB frames acknowledged; screenshot: {output}', flush=True)
        ready = output / 'stream-ready'; ready.write_text('ready')
        if not native_stop:
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
                if native_stop and 410 in frames:
                    break
                page.wait_for_timeout(500)
        if native_stop:
            assert 410 in frames, 'device-side stop must reach the desktop sender'
        if page.get_by_role('button', name='结束画面协作', exact=True).count():
            page.get_by_role('button', name='结束画面协作', exact=True).click()
        expect(page.locator('.ipad-screen-renderer')).to_have_count(0)
        assert not errors, errors
        browser.close()
        print('iPad screen live UI passed: menu, auto-connect, dual rendering, background inspector, acknowledgement and stop.', flush=True)


if __name__ == '__main__':
    run()
