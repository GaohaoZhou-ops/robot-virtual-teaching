from topbar_tools_helpers import topbar_action

import base64
import copy
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from ipad_menu_helpers import open_ipad_dialog, open_ipad_menu
from ipad_teaching_source_ui_smoke import BASE, CHROME, ROOT, fixture_data, ready, saved_workspace


ARTIFACTS = Path(os.environ.get('ATLAS_TEST_ARTIFACTS', ROOT / 'test-artifacts/ipad-model-consistency'))


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    project, archive = fixture_data()
    # Same filename and point count, but a genuinely different source point cloud.
    changed_ply = (ROOT / 'tests/fixtures/rotation-map.ply').read_text().replace(
        '0.0 0.0 0.0 255 90 70', '0.5 0.0 0.0 255 90 70', 1)
    changed = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
        import { readFileSync } from 'node:fs';
        import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
        import { packIPadModel } from './src/lib/ipadTeaching.js';
        const source = readFileSync(0);
        const geometry = new PLYLoader().parse(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
        geometry.computeBoundingBox();
        const packed = await packIPadModel({geometry, name: 'rotation-map.ply', bounds: geometry.boundingBox});
        console.log(JSON.stringify({manifest: packed.manifest, bytes: Buffer.from(packed.buffer).toString('base64')}));
    '''], input=changed_ply, cwd=ROOT, text=True))
    assert changed['manifest']['modelHash'] != archive['manifest']['modelHash']
    assert changed['manifest']['byteLength'] == archive['manifest']['byteLength']
    errors, receipts, mutations = [], [], []
    # Real LAN middleware, with its own temporary store; never modify user transfers.
    with tempfile.TemporaryDirectory(prefix='atlas-model-consistency-') as directory:
        server = subprocess.Popen(['node', '--input-type=module', '-e', '''
            import { createServer } from 'node:http';
            import { createIPadTeachingService } from './src/server/ipadTeachingService.js';
            const middleware = createIPadTeachingService({directory: process.env.ATLAS_TEST_STORE});
            const server = createServer((req, res) => middleware(req, res, () => {res.writeHead(404); res.end();}));
            server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
        '''], cwd=ROOT, env={**os.environ, 'ATLAS_TEST_STORE': directory}, stdout=subprocess.PIPE, text=True)
        try:
            service = server.stdout.readline().strip()
            assert service.startswith('http://127.0.0.1:'), service

            def api(route, body=None, token=None, method=None):
                binary = isinstance(body, bytes)
                request = Request(service + '/__atlas/ipad' + route,
                    data=body if binary else json.dumps(body).encode() if body is not None else None,
                    method=method, headers={'Content-Type': 'application/octet-stream' if binary else 'application/json',
                        **({'Authorization': 'Bearer ' + token} if token else {})})
                with urlopen(request) as response:
                    return json.load(response)

            def complete(ticket, result):
                result = copy.deepcopy(result)
                result.update(sessionId=ticket['id'], modelHash=ticket['manifest']['modelHash'])
                paired = api('/pair', {'code': ticket['pairingCode'], 'deviceId': str(uuid.uuid4()), 'deviceName': 'iPad test'})
                api('/sessions/' + ticket['id'] + '/result', result, paired['deviceToken'])
                return {**ticket, **api('/sessions/' + ticket['id'], token=ticket['ownerToken'])}, result

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
                try:
                    def route_lan(route):
                        request = route.request
                        path = urlsplit(request.url).path
                        if request.method in ['POST', 'PUT']:
                            mutations.append(path)
                        if path.endswith('/imported'):
                            receipts.append(path)
                        headers = {key: value for key, value in request.headers.items()
                            if key in ['authorization', 'content-type']}
                        response = route.fetch(url=service + path, headers=headers)
                        route.fulfill(response=response)

                    page = browser.new_page(viewport={'width': 1280, 'height': 800})
                    page.set_default_timeout(30000)
                    page.route('**/__atlas/ipad/**', route_lan)
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(BASE + '/workbench', wait_until='networkidle')
                    ready(page)
                    # Inspect the rendered entry before operating the dynamic app.
                    expect(page.locator('[data-independent-teaching-input]')).to_have_count(1)
                    page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
                    ready(page)
                    page.locator('[data-project-guide-input]').set_input_files({
                        'name': 'desktop.json', 'mimeType': 'application/json', 'buffer': json.dumps(project).encode()})
                    original = saved_workspace(page, 'desktop-task-1', 2)['project']['virtualTeaching']['tasks']
                    expect(open_ipad_menu(page, '传输任务')).to_contain_text('暂无传输任务')
                    topbar_action(page, name='iPad / iPhone', exact=True).click()
                    assert not mutations, 'browsing menus must not create a transfer'
                    open_ipad_dialog(page)
                    dialog = page.get_by_role('dialog', name='iPad / iPhone 示教')
                    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
                    ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
                    page.get_by_role('button', name='关闭设备示教窗口').click()
                    open_ipad_dialog(page, '更新配对码')
                    expect(dialog.locator('.ipad-code')).not_to_have_text(ticket['pairingCode'])
                    expect(page.get_by_role('button', name='关闭设备示教窗口')).to_be_enabled()
                    renewed = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
                    assert renewed['id'] == ticket['id']
                    assert mutations.count('/__atlas/ipad/sessions/' + ticket['id'] + '/renew') == 1
                    assert mutations.count('/__atlas/ipad/sessions') == 1
                    ticket = renewed
                    page.get_by_role('button', name='关闭设备示教窗口').click()
                    sync_menu = open_ipad_menu(page, '同步与接收')
                    expect(sync_menu.get_by_role('menuitem', name='检查完成状态', exact=True)).to_be_visible()
                    ticket, good_result = complete(ticket, archive['result'])
                    expect(sync_menu.get_by_role('menuitem', name='接收示教结果', exact=True)).to_be_visible(timeout=10000)
                    page.screenshot(path=str(ARTIFACTS / 'sync-menu-1280.png'), full_page=True)
                    topbar_action(page, name='iPad / iPhone', exact=True).click()
                    wrong = api('/sessions', {'manifest': changed['manifest']})
                    api('/sessions/' + wrong['id'] + '/model', base64.b64decode(changed['bytes']), wrong['ownerToken'], 'PUT')
                    wrong, bad_result = complete(wrong, {**archive['result'], 'id': str(uuid.uuid4())})
                    bad_archive = {**archive, 'manifest': wrong['manifest'], 'result': bad_result}
                    page.evaluate("items => localStorage.setItem('atlas-ipad-handoffs-v1', JSON.stringify(items))", [ticket, wrong])
                    history = open_ipad_menu(page, '传输任务')
                    page.screenshot(path=str(ARTIFACTS / 'history-menu-1280.png'), full_page=True)
                    history.locator('[data-transfer-id="' + wrong['id'] + '"]').click()
                    expect(dialog.get_by_label('电脑局域网地址')).to_be_visible()
                    expect(dialog.get_by_role('button', name='接收示教结果', exact=True)).to_be_enabled()
                    expect(dialog.get_by_label('传输任务')).to_have_value(wrong['id'])
                    warning = page.get_by_role('alertdialog', name='独立示教地图不一致')

                    def unchanged(task_id='desktop-task-1', count=2):
                        tasks = saved_workspace(page, task_id, count)['project']['virtualTeaching']['tasks']
                        assert tasks[:2] == original, 'existing desktop teaching must remain byte-for-byte intact'

                    # Every failed LAN receipt shows a new modal; no imported acknowledgement.
                    for index in range(2):
                        dialog.get_by_role('button', name='接收示教结果', exact=True).click()
                        expect(warning).to_be_visible()
                        expect(warning).to_contain_text('模型内容不一致')
                        expect(warning.locator('dd')).to_have_text(['rotation-map.ply', 'rotation-map.ply'])
                        confirm = warning.get_by_role('button', name='知道了')
                        expect(confirm).to_be_focused()
                        confirm.press('Tab')
                        expect(confirm).to_be_focused()
                        confirm.press('Shift+Tab')
                        expect(confirm).to_be_focused()
                        unchanged()
                        assert not receipts
                        if index == 0:
                            page.screenshot(path=str(ARTIFACTS / 'same-name-mismatch.png'), full_page=True)
                            confirm.press('Escape')
                            expect(dialog.get_by_role('button', name='接收示教结果', exact=True)).to_be_focused()
                        else:
                            confirm.click()
                        expect(warning).not_to_be_visible()

                    # Matching content accepts and deduplicates regardless of changed metadata.
                    page.get_by_role('button', name='关闭设备示教窗口').click()
                    open_ipad_dialog(page, '接收示教结果')
                    expect(dialog.locator('[data-ipad-status="imported"]')).to_be_visible()
                    mobile_id = 'ipad-' + good_result['id']
                    unchanged(mobile_id, 3)
                    page.get_by_role('button', name='关闭设备示教窗口').click()
                    open_ipad_dialog(page, '再次接收（去重）')
                    expect(dialog.get_by_label('电脑局域网地址')).to_be_visible()
                    expect(dialog.get_by_role('button', name='再次接收（去重）')).to_be_enabled()
                    unchanged(mobile_id, 3)
                    assert len(receipts) == 2, receipts

                    # File picker and drag/drop share the same validation, including after success.
                    for dropped in [False, True]:
                        if dropped:
                            transfer = page.evaluate_handle('''archive => {
                                const transfer = new DataTransfer();
                                transfer.items.add(new File([JSON.stringify(archive)], 'wrong.atlas-teaching.json', {type: 'application/json'}));
                                return transfer;
                            }''', bad_archive)
                            dialog.get_by_role('region', name='AirDrop 或文件接收').dispatch_event('drop', {'dataTransfer': transfer})
                        else:
                            dialog.locator('[data-ipad-result-input]').set_input_files({
                                'name': 'wrong.atlas-teaching.json', 'mimeType': 'application/json', 'buffer': json.dumps(bad_archive).encode()})
                        expect(warning).to_be_visible()
                        unchanged(mobile_id, 3)
                        warning.get_by_role('button', name='知道了').click()
                    assert len(receipts) == 2
                    assert api('/sessions/' + wrong['id'], token=wrong['ownerToken'])['status'] == 'completed'
                    renamed = {**archive, 'manifest': {**ticket['manifest'], 'name': 'renamed-map.ply', 'sourceMapId': 'reopened'}, 'result': good_result}
                    dialog.locator('[data-ipad-result-input]').set_input_files({
                        'name': 'correct.atlas-teaching.json', 'mimeType': 'application/json', 'buffer': json.dumps(renamed).encode()})
                    expect(dialog.locator('.ipad-result-file__receipt')).to_contain_text('已接收 2 个 Pose')
                    expect(warning).not_to_be_visible()
                    unchanged(mobile_id, 3)
                    page.get_by_role('button', name='关闭设备示教窗口').click()
                    open_ipad_dialog(page, '新建传输')
                    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
                    expect(page.get_by_role('button', name='关闭设备示教窗口')).to_be_enabled()
                    assert mutations.count('/__atlas/ipad/sessions') == 2, 'one explicit new transfer, even under StrictMode'
                    assert page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0].id") != ticket['id']
                    page.get_by_role('button', name='关闭设备示教窗口').click()
                    page.reload(wait_until='networkidle')
                    ready(page)
                    unchanged(mobile_id, 3)

                    # A previously imported result cannot bypass validation on another current map.
                    page.on('dialog', lambda prompt: prompt.accept())
                    page.locator('[data-independent-teaching-input]').set_input_files({
                        'name': 'rotation-map.ply', 'mimeType': 'application/octet-stream', 'buffer': changed_ply.encode()})
                    ready(page)
                    saved_workspace(page, None, 0)
                    open_ipad_menu(page, '传输任务').locator('[data-transfer-id="' + ticket['id'] + '"]').click()
                    expect(dialog.get_by_label('传输任务')).to_have_value(ticket['id'])
                    dialog.get_by_role('button', name='再次接收（去重）').click()
                    expect(warning).to_be_visible()
                    saved_workspace(page, None, 0)
                    assert len(receipts) == 2, 'mismatched repeat must not acknowledge another import'
                    assert not errors, errors
                finally:
                    browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)
    print('Navigation sync and map consistency passed: menu status polling, direct receive/repeat/renew/new actions, exact history selection, real LAN receipt, file picker, drag/drop, mismatch validation, unchanged desktop data, reload and keyboard modal behavior.')


if __name__ == '__main__':
    run()
