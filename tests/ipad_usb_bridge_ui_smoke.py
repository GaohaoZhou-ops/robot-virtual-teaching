"""LAN workbench → local window → Windows TCP usbmux → iPad protocol fixture."""
import json
import os
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from archive_helpers import start_project_download, read_exported_archive
from topbar_tools_helpers import topbar_action
from ipad_usb_bridge_smoke import BridgeFixture

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ['BASE_URL']
OUTPUT = ROOT / 'build/ipad-windows-usb'


def run():
    assert urlparse(BASE).hostname not in ('127.0.0.1', 'localhost'), 'Use the server LAN URL'
    OUTPUT.mkdir(parents=True, exist_ok=True)
    fixture = BridgeFixture(port=21994)
    pad = fixture.pad
    errors, remote_frames, sync_writes = [], [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),
                                        args=['--use-angle=metal', '--enable-gpu'])
            try:
                context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True,
                    user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36')
                page = context.new_page(); page.set_default_timeout(60000)
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('request', lambda r: remote_frames.append(r.url) if '/ipad-screen/session/' in r.url
                        and r.url.endswith(('/frame', '/workspace')) else None)
                page.on('request', lambda r: sync_writes.append(r.url) if '/__atlas/work-sync/' in r.url
                        and r.method in ('POST', 'PUT', 'PATCH') and urlparse(r.url).path.rsplit('/', 1)[-1]
                        not in ('clients', 'status', 'leave') else None)
                page.goto(BASE + '/workbench', wait_until='networkidle')
                page.locator('[data-session-state="ready"]').wait_for()
                page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
                page.locator('.loading-curtain').wait_for(state='hidden')
                topbar_action(page, name='加载机器人', exact=True).click()
                page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
                page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
                page.get_by_role('tab', name='示教', exact=True).click()
                page.get_by_role('button', name='新建示教任务', exact=True).click()
                task = page.get_by_role('dialog', name='新建示教任务', exact=True)
                task.get_by_role('textbox', name='新示教任务名称').fill('Windows local USB')
                task.get_by_role('button', name='创建任务', exact=True).click()
                page.get_by_role('button', name='新增停车点', exact=True).click()
                topbar_action(page, name='iPad / iPhone', exact=True).click()
                page.get_by_role('menuitem', name='画面协作', exact=True).click()
                dialog = page.get_by_role('dialog', name='画面协作', exact=True)
                expect(dialog.get_by_alt_text('设备配对二维码')).to_be_visible()
                expect(dialog.get_by_role('tab')).to_have_count(3)
                dialog.get_by_role('tab', name='数据线', exact=True).click()
                expect(dialog.get_by_role('button', name='连接本机助手', exact=True)).to_be_enabled()
                with page.expect_download() as downloaded:
                    dialog.get_by_role('link', name='下载数据线连接助手').click()
                with zipfile.ZipFile(downloaded.value.path()) as archive:
                    assert set(archive.namelist()) == {'Atlas-iPad-USB/' + name for name in (
                        'ipadUSBBridge.py', 'ipadScreenUSB.py', 'start-windows.cmd', 'README.txt', 'web/index.html', 'web/client.js')}
                    assert b'__BRIDGE_SECRET__' in archive.read('Atlas-iPad-USB/web/index.html')
                    assert b'\r\n' in archive.read('Atlas-iPad-USB/start-windows.cmd')
                page.screenshot(path=str(OUTPUT / 'setup.png'))
                with page.expect_popup() as opened:
                    dialog.get_by_role('button', name='连接本机助手', exact=True).click()
                helper = opened.value; helper.set_default_timeout(30000)
                helper.on('pageerror', lambda e: errors.append(str(e)))
                helper.wait_for_load_state('networkidle')
                expect(helper.locator('#source')).to_have_text(BASE)
                assert fixture.state.session is None, 'the helper needs explicit approval before USB access'
                helper.screenshot(path=str(OUTPUT / 'allow.png'))
                helper.get_by_role('button', name='允许连接此工作台').click()
                expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
                page.screenshot(path=str(OUTPUT / 'connected.png'))

                def wait(check, label, timeout=30):
                    deadline = time.monotonic() + timeout
                    while time.monotonic() < deadline:
                        if check():
                            return
                        page.wait_for_timeout(100)
                    raise AssertionError(label + ': ' + json.dumps(pad.workspace))

                wait(lambda: len(pad.frames) >= 3 and pad.workspace.get('joints'), 'USB frames and joints')
                assert not remote_frames, 'collaboration images must not pass through the Mac service'
                assert page.url == BASE + '/workbench', 'keep the original project origin and storage'
                helper.screenshot(path=str(OUTPUT / 'helper-connected.png'))
                dialog.get_by_role('button', name='关闭画面协作窗口').click()
                before_view = page.locator('.three-canvas').get_attribute('data-view-signature')
                pad.page = 'joints'
                pad.commands = [{'robotId': pad.workspace['robotId'], 'name': 'left_J1', 'value': 24, 'sequence': 1, 'ageMs': 0}]
                pad.viewport_commands = [{'robotId': pad.workspace['robotId'], 'sequence': 1, 'kind': 'rotate', 'dx': .1, 'dy': .04, 'zoom': 0, 'ageMs': 0}]
                wait(lambda: pad.workspace.get('ack') == 1 and pad.workspace['viewportControl']['ack'] == 1, 'joint and viewport acknowledgement')
                assert page.locator('.three-canvas').get_attribute('data-view-signature') != before_view
                assert next(j['value'] for j in pad.workspace['joints'] if j['name'] == 'left_J1') == 24
                capture_id = str(uuid.uuid4())
                pad.capture = {'id': capture_id, 'robotId': pad.workspace['robotId'], 'ageMs': 0,
                               'taskId': pad.workspace['capture']['taskId'], 'parkingPointId': pad.workspace['capture']['parkingPointId']}
                wait(lambda: (pad.workspace.get('captureResult') or {}).get('status') == 'complete', 'USB Pose capture', 90)
                assert pad.workspace['captureResult']['id'] == capture_id
                print('PASS Windows USB framing; unsynchronized LAN workbench; local frames, joints, viewport and Pose capture', flush=True)

                # Pause browser image encoding, as happens with suspended graphics.
                # The local helper must own the heartbeat independently of frames.
                session_id = fixture.state.session['id']
                before = pad.heartbeats
                frozen_frames = len(pad.frames)
                page.evaluate('''() => {
                    window.__usbToBlob = HTMLCanvasElement.prototype.toBlob;
                    window.__usbPendingBlobs = [];
                    HTMLCanvasElement.prototype.toBlob = function (...args) {
                        window.__usbPendingBlobs.push(() => window.__usbToBlob.apply(this, args));
                    };
                    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                    document.dispatchEvent(new Event('visibilitychange'));
                }''')
                try:
                    page.wait_for_timeout(11500)
                    assert pad.active and pad.heartbeats > before, {
                        'active': pad.active, 'heartbeats': pad.heartbeats, 'before': before,
                        'framesBefore': frozen_frames, 'framesAfter': len(pad.frames),
                        'session': fixture.state.session and fixture.state.session['id']}
                    assert fixture.state.session['id'] == session_id
                finally:
                    page.evaluate('''() => {
                        HTMLCanvasElement.prototype.toBlob = window.__usbToBlob;
                        window.__usbPendingBlobs.splice(0).forEach(resume => resume());
                        delete document.hidden;
                        document.dispatchEvent(new Event('visibilitychange'));
                    }''')
                frame_count = len(pad.frames)
                wait(lambda: len(pad.frames) > frame_count + 2, 'USB resumes in the same session')
                helper.close()
                wait(lambda: not pad.active, 'closing helper ends native collaboration')
                expect(page.get_by_role('button', name='结束画面协作', exact=True)).to_have_count(0)
                topbar_action(page, name='iPad / iPhone', exact=True).click()
                page.get_by_role('menuitem', name='画面协作', exact=True).click()
                expect(dialog.get_by_role('button', name='连接本机助手', exact=True)).to_be_enabled()
                with page.expect_popup() as reopened:
                    dialog.get_by_role('button', name='连接本机助手', exact=True).click()
                helper = reopened.value
                helper.get_by_role('button', name='允许连接此工作台').click()
                expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
                assert fixture.state.session['id'] != session_id
                dialog.get_by_role('button', name='结束协作', exact=True).click()
                wait(lambda: not pad.active, 'explicit stop')
                dialog.get_by_role('button', name='关闭画面协作窗口').click()
                with page.expect_download() as saved:
                    start_project_download(page)
                archive = read_exported_archive(saved.value)
                tasks = archive['project']['virtualTeaching']['tasks']
                assert len(tasks) == 1 and tasks[0]['name'] == 'Windows local USB'
                poses = tasks[0]['parkingPoints'][0]['poses']
                assert len(poses) == 1 and poses[0]['fullBodyJoints']['values']['left_J1'] == 24
                assert set(poses[0]['cameraCapture']['frames']) == {'left', 'right'}
                assert not remote_frames and not sync_writes and not errors, (remote_frames, sync_writes, errors)
                page.screenshot(path=str(OUTPUT / 'pose-saved.png'))
                print('PASS background keepalive/resume, helper close/reconnect, stop, original-project export; no LAN image relay or project upload', flush=True)
            finally:
                browser.close()
    finally:
        fixture.close()


if __name__ == '__main__':
    run()
