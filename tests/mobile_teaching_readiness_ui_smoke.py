"""QR result reception and in-dialog robot loading use disposable service/storage."""
import copy
import json
import subprocess
import tempfile
import uuid
from contextlib import contextmanager
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

from ipad_menu_helpers import open_ipad_dialog
from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from mobile_teaching_solver_ui_smoke import BASE, CHROME, ROOT, await_saved
from topbar_tools_helpers import topbar_action

ARTIFACTS = ROOT / 'test-artifacts/mobile-teaching-readiness'


@contextmanager
def isolated_service():
    with tempfile.TemporaryDirectory(prefix='atlas-solve-readiness-') as directory:
        process = subprocess.Popen(['node', '--input-type=module', '-e', '''
            import { createServer } from 'node:http';
            import { createIPadTeachingService } from './src/server/ipadTeachingService.js';
            const middleware = createIPadTeachingService({ directory: process.argv[1],
                getAddresses: port => [`http://127.0.0.1:${port}`] });
            const server = createServer((req, res) => middleware(req, res, () => {
                res.writeHead(404); res.end();
            }));
            server.listen(0, '127.0.0.1', () => console.log(server.address().port));
        ''', directory], cwd=ROOT, stdout=subprocess.PIPE, text=True)
        try:
            yield 'http://127.0.0.1:' + process.stdout.readline().strip()
        finally:
            process.terminate()
            process.wait(timeout=10)


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
    # A fixed-base, out-of-reach target completes quickly; the existing IK UI
    # regression separately checks reachable solutions and saved robot poses.
    archive['result']['samples'] = archive['result']['samples'][:1]
    archive['result']['samples'][0]['cameraPose']['position'] = dict(x=20, y=20, z=20)
    with isolated_service() as service, sync_playwright() as playwright:
        def api(path, body=None, token=None):
            request = Request(service + '/__atlas/ipad' + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
            with urlopen(request, timeout=10) as response:
                return json.load(response)

        def proxy(route):
            incoming = route.request
            request = Request(service + urlsplit(incoming.url).path, data=incoming.post_data_buffer,
                method=incoming.method, headers={key: value for key, value in incoming.headers.items()
                    if key.lower() in ['authorization', 'content-type']})
            try:
                response = urlopen(request, timeout=10)
            except HTTPError as error:
                response = error
            with response:
                route.fulfill(status=response.status, body=response.read(),
                    content_type=response.headers.get('Content-Type', 'application/json'))

        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1280, 'height': 800})
            page.set_default_timeout(30000)
            errors, received = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: received.append(request.url)
                if request.method == 'GET' and request.url.endswith('/result') else None)
            page.route('**/__atlas/ipad/**', proxy)
            page.goto(BASE + '/workbench', wait_until='networkidle')
            ready(page)
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            ipad = open_ipad_dialog(page)
            expect(ipad.get_by_role('img', name='设备配对二维码')).to_be_visible()
            ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
            result = archive['result']
            result.update(sessionId=ticket['id'], modelHash=ticket['manifest']['modelHash'])
            pairing = api('/pair-result', {
                'code': ticket['pairingCode'], 'sessionId': ticket['id'], 'serverId': api('/info')['serverId'],
                'deviceId': str(uuid.uuid4()), 'deviceName': 'iPad readiness test', 'resultId': result['id'],
                'modelIdentity': {key: ticket['manifest'][key] for key in ['modelHash', 'byteLength']},
            })
            assert api('/sessions/' + ticket['id'] + '/result', result, pairing['deviceToken'])['received']
            expect(ipad.locator('[data-ipad-status="completed"]')).to_be_visible()
            ipad.get_by_role('button', name='接收示教结果', exact=True).click()
            expect(ipad.locator('[data-ipad-status="imported"]')).to_be_visible()
            ipad.get_by_role('button', name='关闭设备示教窗口').click()

            # Loading must also work when opened from the data page and the
            # workbench is hidden. No second reception should be required.
            topbar_action(page, name='打开示教数据管理页').click()
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            start = dialog.get_by_role('button', name='开始计算', exact=True)
            expect(start).to_be_disabled()
            expect(dialog).to_contain_text('请先在本窗口加载机器人')
            tolerance = dialog.get_by_role('spinbutton', name='X 位置容差 (cm)')
            tolerance.fill('7.5')
            page.screenshot(path=str(ARTIFACTS / 'robot-required.png'), full_page=True)

            # Catalog failure is recoverable inside this dialog. Escape closes
            # only the nested picker, preserving the calculation settings.
            page.route('**/__atlas/robots', lambda route: route.fulfill(status=503, body='test'), times=1)
            load = dialog.get_by_role('button', name='加载机器人', exact=True)
            load.click()
            picker = dialog.get_by_role('dialog', name='robots 目录模型', exact=True)
            expect(picker).to_contain_text('机器人目录请求失败')
            picker.get_by_role('button', name='刷新机器人列表').click()
            option = picker.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True)
            expect(option).to_be_visible()
            option.focus()
            page.keyboard.press('Escape')
            expect(picker).to_have_count(0)
            expect(dialog).to_be_visible()
            expect(load).to_be_focused()
            # Cancelling a refresh before its response arrives must allow a
            # fresh request when the picker opens again, rather than hanging.
            load.click()
            pending_catalog = []
            page.route('**/__atlas/robots', lambda route: pending_catalog.append(route), times=1)
            with page.expect_request('**/__atlas/robots'):
                picker.get_by_role('button', name='刷新机器人列表').click()
            expect(picker.locator('.is-spinning')).to_have_count(1)
            picker.get_by_role('button', name='刷新机器人列表').press('Escape')
            expect(picker).to_have_count(0)
            assert pending_catalog
            pending_catalog[0].abort()
            load.click()
            expect(option).to_be_visible()
            expect(picker.locator('.is-spinning')).to_have_count(0)
            page.screenshot(path=str(ARTIFACTS / 'choose-robot.png'), full_page=True)

            # Fail the first actual model load, then retry the same model.
            page.route('**/robot-files/**/botx_abx_zivid_m70.urdf',
                lambda route: route.fulfill(status=503, body='test model unavailable'), times=1)
            option.click()
            expect(dialog).to_contain_text('机器人加载失败')
            expect(start).to_be_disabled()
            expect(tolerance).to_have_value('7.5')
            load.click()
            option.click()
            expect(page.locator('.three-canvas')).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            expect(start).to_be_enabled()
            expect(tolerance).to_have_value('7.5')
            expect(dialog).not_to_contain_text('机器人加载失败')
            assert dialog.evaluate('(el) => el.contains(document.activeElement)')
            page.screenshot(path=str(ARTIFACTS / 'ready-to-calculate.png'), full_page=True)
            assert dialog.locator('.mobile-solve-dialog').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')

            dialog.get_by_role('combobox', name='停车点策略').select_option('fixed')
            dialog.get_by_role('checkbox', name='碰撞筛选').uncheck()
            start.click()
            expect(dialog).to_have_count(0)
            dock = page.get_by_role('region', name='设备姿态后台计算')
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            expect(dock.get_by_role('button', name='动态预览', exact=True)).to_be_disabled()
            expect(dock).to_contain_text('未找到可达姿态，暂无法动态预览')
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            tasks = config['project']['virtualTeaching']['tasks']
            assert len(tasks) == 1 and tasks[0]['mobileCapture'] == result
            assert tasks[0]['mobileSolve']['options']['positionTolerance']['x'] == 0.075
            assert len(tasks[0]['mobileSolve']['rows']) == 1
            assert len(received) == 1, 'loading a robot must not receive/import the capture again'

            trajectory = copy.deepcopy(archive)
            trajectory['result']['id'] = str(uuid.uuid4())
            trajectory['result']['samples'][0]['kind'] = 'trajectory'
            import_result(page, trajectory)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            expect(start).to_be_disabled()
            expect(dialog).to_contain_text('没有手动记录点')
            dialog.get_by_role('checkbox', name='仅计算手动记录点').uncheck()
            expect(start).to_be_enabled()
            expect(dialog).not_to_contain_text('没有手动记录点')
            assert not errors, errors
        finally:
            browser.close()
    print('QR sync to solve passed: in-dialog robot loading, catalog/model retry, nested keyboard focus, preserved capture/options, real worker completion and trajectory-only guidance.')


if __name__ == '__main__':
    run()
