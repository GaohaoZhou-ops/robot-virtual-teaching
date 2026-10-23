"""Record real teaching poses through collaboration; optionally exercise an iPad.

Use ATLAS_SCREEN_CAPTURE_LIVE=1 alongside testLiveScreenPoseCapture for USB UI.
Add ATLAS_SCREEN_BRIDGE=1 and use a LAN BASE_URL to exercise the localhost helper.
The default uses the real LAN transport with a small protocol peer.
"""
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from archive_helpers import start_project_download, read_exported_archive
from topbar_tools_helpers import topbar_action
from ipad_screen_ui_smoke import native_status

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21992')
LIVE = os.environ.get('ATLAS_SCREEN_CAPTURE_LIVE') == '1'
BRIDGE = os.environ.get('ATLAS_SCREEN_BRIDGE') == '1'
OUTPUT = ROOT / 'build/screen-capture-validation' / ('bridge-live' if BRIDGE else 'live' if LIVE else 'lan')
DEVICE = os.environ.get('ATLAS_SCREEN_DEVICE_ID', '00008027-001910CE0184402E')
PEER = r'''
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
const folder = process.argv[1], { base, ticket, credential } = JSON.parse(readFileSync(folder + '/peer.json'));
const socket = new WebSocket(base.replace('http:', 'ws:') + '/__atlas/ipad-screen/session/' + ticket.id + '/device',
  { headers: { Authorization: 'Bearer ' + credential.deviceToken } });
socket.on('error', e => { console.error(e); process.exitCode = 1; });
socket.on('message', data => {
  const action = data[0], requestId = data.readUInt32BE(1), body = data.subarray(5);
  if (action === 3) {
    const state = JSON.parse(body.subarray(8, 8 + body.readUInt32BE(0)));
    if (body.readUInt32BE(4)) state.viewportHash = createHash('sha256').update(body.subarray(8 + body.readUInt32BE(0))).digest('hex');
    writeFileSync(folder + '/state.tmp', JSON.stringify(state)); renameSync(folder + '/state.tmp', folder + '/state.json');
  }
  let command = {}; try { command = JSON.parse(readFileSync(folder + '/command.json')); } catch {}
  const captureRequest = command.capture && { ...command.capture, ageMs: Date.now() - command.created };
  const commands = (command.commands || []).map(c => ({ ...c, ageMs: Date.now() - command.created }));
  const viewportCommands = (command.viewportCommands || []).map(c => ({ ...c, ageMs: Date.now() - command.created }));
  socket.send(JSON.stringify({ requestId, status: 200, body: { page: command.page || 'cameras', commands, captureRequest, viewportCommands } }));
});
'''


def run():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ['state.json', 'command.json']:
        (OUTPUT / name).unlink(missing_ok=True)
    peer = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
            args=['--use-angle=metal', '--enable-gpu'] if sys.platform == 'darwin' else [])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        page.set_default_timeout(90000)
        errors = []
        remote_frames = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda r: remote_frames.append(r.url) if '/ipad-screen/session/' in r.url
                and r.url.endswith(('/frame', '/workspace')) else None)
        if not LIVE:
            def windows_info(route):
                response = route.fetch(); info = response.json(); info['usbSupported'] = False
                route.fulfill(response=response, json=info)
            page.route('**/__atlas/ipad-screen/info', windows_info)

        def state():
            if LIVE:
                return native_status(DEVICE)
            file = OUTPUT / 'state.json'
            return json.loads(file.read_text()) if file.exists() else {}

        def wait(check, label, timeout=90):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = state()
                if check(value): return value
                page.wait_for_timeout(200)
            raise AssertionError(label + ': ' + json.dumps(state(), ensure_ascii=False))

        def request_capture(overrides=None, remote_page='cameras'):
            current = state()
            capture = {'id': str(uuid.uuid4()), 'robotId': current['robotId'],
                'taskId': current['capture']['taskId'], 'parkingPointId': current['capture']['parkingPointId'], **(overrides or {})}
            (OUTPUT / 'command.json').write_text(json.dumps({'capture': capture, 'created': int(time.time() * 1000), 'page': remote_page}))
            return wait(lambda s: (s.get('captureResult') or {}).get('id') == capture['id']
                and s['captureResult']['status'] != 'recording', 'capture response')['captureResult']

        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            if LIVE and not BRIDGE:
                deadline = time.monotonic() + 150
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
                    'code': ticket['pairingCode'], 'deviceId': 'capture-test-ipad', 'deviceName': 'Capture test iPad'}).json()
                (OUTPUT / 'peer.json').write_text(json.dumps({'base': BASE, 'ticket': ticket, 'credential': credential}))
                peer = subprocess.Popen(['node', '--input-type=module', '-e', PEER, str(OUTPUT)], cwd=ROOT)
            dialog = page.get_by_role('dialog', name='画面协作', exact=True)
            if BRIDGE:
                assert LIVE, 'The companion capture fixture requires a physical iPad'
                dialog.get_by_role('tab', name='数据线', exact=True).click()
                with page.expect_popup() as opened:
                    dialog.get_by_role('button', name='连接本机助手', exact=True).click()
                helper = opened.value
                helper.get_by_role('button', name='允许连接此工作台').click()
            expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible(timeout=90000)
            dialog.get_by_role('button', name='关闭画面协作窗口', exact=True).click()
            if LIVE:
                wait(lambda s: '示教任务' in s.get('captureNotice', ''), 'native no-task alert', 240)
            else:
                wait(lambda s: 'capture' in s, 'capture state')
                result = request_capture()
                assert result['status'] == 'error' and '网页端' in result['message'] and '示教任务' in result['message'], result
            print('PASS missing task redirects to the web workbench', flush=True)

            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='新建示教任务', exact=True).click()
            create = page.get_by_role('dialog', name='新建示教任务', exact=True)
            create.get_by_role('textbox', name='新示教任务名称').fill('iPad 快捷记录验证')
            create.get_by_role('button', name='创建任务', exact=True).click()
            panel = page.get_by_label('虚拟示教', exact=True)
            task = panel.get_attribute('data-active-teaching-task')
            if LIVE:
                wait(lambda s: '停车点' in s.get('captureNotice', '') and '示教任务' not in s['captureNotice'], 'native no-parking alert', 240)
            else:
                wait(lambda s: s['capture']['taskId'] == task, 'new task propagated')
                result = request_capture()
                assert result['status'] == 'error' and '停车点' in result['message'] and '网页端' in result['message'], result
            page.get_by_role('button', name='新增停车点', exact=True).click()
            parking = panel.get_attribute('data-active-parking-point')
            print('PASS missing parking point redirects to the web workbench', flush=True)

            if not LIVE:
                page.get_by_role('button', name='打开全关节浮动窗口').click()
                joint = page.get_by_role('spinbutton', name='left_J1 关节值', exact=True)
                joint.fill('24'); joint.press('Enter')
                page.get_by_role('button', name='关闭全关节浮动窗口').click()
                wait(lambda s: s['capture']['parkingPointId'] == parking and any(j['name'] == 'left_J1' and j['value'] == 24 for j in s['joints']), 'parking and joint propagated')
                first = request_capture()
                assert first['status'] == 'complete' and 'A01' in first['message'], first
                page.wait_for_timeout(1200)
                assert state()['captureResult'] == first, 'Repeated request must return the same capture result'
                invalid = request_capture({'taskId': 'changed-task'})
                assert invalid['status'] == 'error' and '切换' in invalid['message'], invalid
                before = state()['captureResult']
                (OUTPUT / 'command.json').write_text(json.dumps({'capture': {'id': str(uuid.uuid4()), 'robotId': state()['robotId'],
                    'taskId': task, 'parkingPointId': parking}, 'created': int(time.time() * 1000) - 4000}))
                page.wait_for_timeout(500)
                assert state()['captureResult'] == before, 'Expired requests must not record a pose'
                page.get_by_role('tab', name='相机', exact=True).click()
                # A background workbench may retain networking while animation
                # frames pause. Snapshot capture must not wait on those frames.
                page.evaluate('''() => {
                    window.__captureRAF = window.requestAnimationFrame;
                    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                    window.requestAnimationFrame = () => 0;
                    document.dispatchEvent(new Event('visibilitychange'));
                }''')
                try:
                    second = request_capture(remote_page='joints')
                    assert second['status'] == 'complete' and 'A02' in second['message'], second
                finally:
                    page.evaluate('''() => {
                        window.requestAnimationFrame = window.__captureRAF;
                        delete document.hidden;
                        document.dispatchEvent(new Event('visibilitychange'));
                    }''')
                print('PASS recording continues with browser animation frames suspended', flush=True)
                page.get_by_role('button', name='结束画面协作', exact=True).click()
            else:
                wait(lambda s: 'A02' in s.get('captureMessage', ''), 'native records in camera and joint pages', 420)
                # XCTest takes a screenshot and ends collaboration after its second capture.
                expect(page.get_by_role('button', name='结束画面协作', exact=True)).not_to_be_visible(timeout=180000)
            with page.expect_download() as download:
                start_project_download(page)
            archive = read_exported_archive(download.value)
            tasks = archive['project']['virtualTeaching']['tasks']
            assert len(tasks) == 1 and len(tasks[0]['parkingPoints']) == 1
            poses = tasks[0]['parkingPoints'][0]['poses']
            assert [pose['name'] for pose in poses] == ['A01', 'A02'], 'Exactly one pose per accepted click, no implicit task/parking creation'
            for pose in poses:
                assert pose['fullBodyJoints']['count'] == 24
                assert set(pose['cameraCapture']['frames']) == {'left', 'right'}
                if not LIVE: assert pose['fullBodyJoints']['values']['left_J1'] == 24
            (OUTPUT / 'saved-poses.json').write_text(json.dumps(poses, ensure_ascii=False, indent=2))
            assert not errors, errors
            if BRIDGE:
                assert not remote_frames, 'The live USB companion must not send images to the Mac workbench server'
            print('PASS two recorded poses preserve all 24 joints and both camera snapshots; no duplicates or implicit task/parking creation', flush=True)
        finally:
            browser.close()
            if peer:
                peer.terminate(); peer.wait(timeout=10)


if __name__ == '__main__':
    run()
