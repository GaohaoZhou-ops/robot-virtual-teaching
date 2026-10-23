"""Two unsynchronized LAN browser projects collaborate without crossing state."""
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action
from archive_helpers import start_project_download, read_exported_archive
from ipad_screen_capture_ui_smoke import PEER, ROOT

BASE = os.environ['BASE_URL']
OUTPUT = ROOT / 'build/ipad-remote-collaboration/browsers'


def run():
    assert urlparse(BASE).hostname not in ('localhost', '127.0.0.1'), 'Use the actual server LAN address'
    OUTPUT.mkdir(parents=True, exist_ok=True)
    peers, clients, errors, sync_writes = [], [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),
                                    args=['--use-angle=metal', '--enable-gpu'])
        try:
            for name, initial in [('A', 21), ('B', -17)]:
                folder = OUTPUT / name
                folder.mkdir(exist_ok=True)
                for file in ('state.json', 'command.json'):
                    (folder / file).unlink(missing_ok=True)
                page = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True).new_page()
                page.set_default_timeout(60000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                # Presence/status metadata is sent for every LAN browser. A project
                # remains unsynchronized until authorization, bundle or exchange calls.
                page.on('request', lambda request: sync_writes.append(request.url)
                        if '/__atlas/work-sync/' in request.url and request.method in ('POST', 'PUT', 'PATCH')
                        and urlparse(request.url).path.rsplit('/', 1)[-1] not in ('clients', 'status', 'leave') else None)
                page.goto(BASE + '/workbench', wait_until='networkidle')
                page.locator('[data-session-state="ready"]').wait_for()
                page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
                page.locator('.loading-curtain').wait_for(state='hidden')
                topbar_action(page, name='加载机器人', exact=True).click()
                page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
                page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
                page.get_by_role('button', name='打开全关节浮动窗口').click()
                value = page.get_by_role('spinbutton', name='left_J1 关节值', exact=True)
                value.fill(str(initial)); value.press('Enter')
                page.get_by_role('button', name='关闭全关节浮动窗口').click()
                page.get_by_role('tab', name='示教', exact=True).click()
                page.get_by_role('button', name='新建示教任务', exact=True).click()
                dialog = page.get_by_role('dialog', name='新建示教任务', exact=True)
                dialog.get_by_role('textbox', name='新示教任务名称').fill('Independent browser ' + name)
                dialog.get_by_role('button', name='创建任务', exact=True).click()
                page.get_by_role('button', name='新增停车点', exact=True).click()
                topbar_action(page, name='iPad / iPhone', exact=True).click()
                with page.expect_response(lambda r: r.url.endswith('/ipad-screen/session') and r.request.method == 'POST') as created:
                    page.get_by_role('menuitem', name='画面协作', exact=True).click()
                assert created.value.status == 201
                ticket = created.value.json()
                dialog = page.get_by_role('dialog', name='画面协作', exact=True)
                expect(dialog.get_by_role('tab', name='数据线')).to_have_count(0)
                expect(dialog.get_by_alt_text('设备配对二维码')).to_be_visible()
                assert dialog.get_by_label('协作连接地址').input_value() == BASE
                page.screenshot(path=str(folder / 'independent-qr.png'))
                response = page.request.post(BASE + '/__atlas/ipad-screen/pair', data={
                    'code': ticket['pairingCode'], 'sessionId': ticket['id'], 'serverId': ticket['serverId'],
                    'deviceId': 'browser-peer-' + name, 'deviceName': 'Independent iPad ' + name})
                assert response.ok, response.text()
                (folder / 'peer.json').write_text(json.dumps({'base': BASE, 'ticket': ticket, 'credential': response.json()}))
                peers.append(subprocess.Popen(['node', '--input-type=module', '-e', PEER, str(folder)], cwd=ROOT))
                expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
                dialog.get_by_role('button', name='关闭画面协作窗口').click()
                clients.append({'page': page, 'folder': folder, 'ticket': ticket, 'name': name})

            def state(client):
                file = client['folder'] / 'state.json'
                return json.loads(file.read_text()) if file.exists() else {}

            def wait(client, check, label):
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    current = state(client)
                    if check(current):
                        return current
                    client['page'].wait_for_timeout(100)
                raise AssertionError(label + ': ' + json.dumps(state(client)))

            def command(client, **payload):
                (client['folder'] / 'command.json').write_text(json.dumps({'created': int(time.time() * 1000), **payload}))

            def joint(current):
                return next(j['value'] for j in current.get('joints', []) if j['name'] == 'left_J1')

            a, b = clients
            assert a['ticket']['pairingCode'] != b['ticket']['pairingCode']
            sa = wait(a, lambda s: 'capture' in s, 'browser A workspace')
            sb = wait(b, lambda s: 'capture' in s, 'browser B workspace')
            assert sa['capture']['taskId'] != sb['capture']['taskId']
            assert joint(sa) == 21 and joint(sb) == -17
            before_b = b['page'].locator('.three-canvas').get_attribute('data-view-signature')
            command(a, page='joints', commands=[{'robotId': sa['robotId'], 'name': 'left_J1', 'value': 33, 'sequence': 1}],
                    viewportCommands=[{'robotId': sa['robotId'], 'sequence': 1, 'kind': 'rotate', 'dx': .1, 'dy': .04, 'zoom': 0}])
            wait(a, lambda s: s.get('ack') == 1 and joint(s) == 33 and s['viewportControl']['ack'] == 1, 'isolated robot/view control')
            assert joint(state(b)) == -17
            assert b['page'].locator('.three-canvas').get_attribute('data-view-signature') == before_b
            print('PASS independent LAN QR sessions and isolated joint/viewport controls', flush=True)

            for client, expected_joint in [(a, 33), (b, -17)]:
                current = state(client)
                capture_id = str(uuid.uuid4())
                command(client, capture={'id': capture_id, 'robotId': current['robotId'],
                    'taskId': current['capture']['taskId'], 'parkingPointId': current['capture']['parkingPointId']})
                saved = wait(client, lambda s: (s.get('captureResult') or {}).get('id') == capture_id
                             and s['captureResult']['status'] != 'recording', 'browser-local capture')['captureResult']
                assert saved['status'] == 'complete', saved
                client['page'].get_by_role('button', name='结束画面协作', exact=True).click()
                with client['page'].expect_download() as download:
                    start_project_download(client['page'])
                archive = read_exported_archive(download.value)
                tasks = archive['project']['virtualTeaching']['tasks']
                assert len(tasks) == 1 and tasks[0]['name'] == 'Independent browser ' + client['name']
                poses = tasks[0]['parkingPoints'][0]['poses']
                assert len(poses) == 1 and poses[0]['fullBodyJoints']['values']['left_J1'] == expected_joint
                assert set(poses[0]['cameraCapture']['frames']) == {'left', 'right'}
                if client is a:
                    assert not state(b).get('captureResult'), 'recording A must not add a Pose to B'
                    expect(b['page'].get_by_role('button', name='结束画面协作', exact=True)).to_be_visible()
                client['page'].screenshot(path=str(client['folder'] / 'local-pose.png'))
            assert not sync_writes, sync_writes
            assert not errors, errors
            print('PASS Pose saved only in its browser project; stopping A preserves B; no project synchronization or upload', flush=True)
        finally:
            browser.close()
            for peer in peers:
                peer.terminate(); peer.wait(timeout=10)


if __name__ == '__main__':
    run()
