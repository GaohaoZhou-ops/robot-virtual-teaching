from topbar_tools_helpers import topbar_action

import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from ipad_menu_helpers import open_ipad_dialog

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22001')
NATIVE_FILE = Path(os.environ.get('ATLAS_RESULT_FILE_FIXTURE', '/tmp/atlas-ipad-native-result-file.json'))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def ready(page):
    page.locator('[data-session-state="ready"]').wait_for(state='attached', timeout=30000)
    page.locator('.loading-curtain').wait_for(state='hidden', timeout=30000)


def upload(dialog, value):
    data = json.dumps(value).encode() if not isinstance(value, bytes) else value
    dialog.locator('[data-ipad-result-input]').set_input_files({
        'name': 'Atlas-result.atlas-teaching.json', 'mimeType': 'application/json', 'buffer': data,
    })


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.set_default_timeout(30000)
        errors, result_requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: result_requests.append(request.url)
                if '/__atlas/ipad/' in request.url and request.url.endswith('/result') else None)
        page.goto(BASE + '/workbench', wait_until='networkidle')
        ready(page)
        page.locator('[data-independent-teaching-input="true"]').set_input_files(
            str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
        ready(page)
        open_ipad_dialog(page)
        dialog = page.get_by_role('dialog', name='移动到 iPad 或 Vision Pro 上运行')
        expect(dialog.get_by_role('button', name='导入结果文件')).to_be_enabled()
        ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
        archive = json.loads(NATIVE_FILE.read_text())
        # Keep native Swift Poses, using this browser fixture's model identity.
        archive['manifest'] = ticket['manifest']
        archive['result']['modelHash'] = ticket['manifest']['modelHash']
        archive['result']['sessionId'] = ticket['id']

        upload(dialog, b'{broken json')
        expect(dialog.get_by_role('alert')).to_contain_text('有效的 JSON')
        mismatch = json.loads(json.dumps(archive))
        mismatch['manifest']['modelHash'] = mismatch['result']['modelHash'] = '0' * 64
        upload(dialog, mismatch)
        warning = page.get_by_role('alertdialog', name='独立示教地图不一致')
        expect(warning).to_contain_text('模型内容不一致')
        warning.get_by_role('button', name='知道了').click()
        expect(dialog.get_by_role('alert')).to_contain_text('模型内容不一致')
        upload(dialog, archive)
        expect(dialog.locator('.ipad-result-file__receipt')).to_contain_text('已接收 1 个 Pose')
        expect(dialog.get_by_role('alert')).not_to_be_visible()
        upload(dialog, archive)
        expect(dialog.get_by_role('button', name='导入结果文件')).to_be_enabled()
        expect(dialog.locator('.ipad-result-file__receipt')).to_contain_text('已保存到当前工程')
        page.screenshot(path='/tmp/atlas-ipad-file-import.png', full_page=True)
        page.get_by_role('button', name='关闭设备示教窗口').click()
        topbar_action(page, name='打开示教数据管理页').click()
        expect(page.get_by_role('region', name='iPad 示教结果')).to_contain_text('1 个 Pose')
        assert page.locator('.teaching-data-page').get_attribute('data-teaching-task-count') == '1'
        with page.expect_download() as download:
            page.get_by_role('button', name='导出 iPad 示教 JSON').click()
        exported = json.loads(Path(download.value.path()).read_text())
        assert exported.pop('workspaceCoordinateFrame') == 'virtual_origin'
        exported.pop('mobileTransform')
        assert exported == archive['result']
        page.reload(wait_until='networkidle')
        ready(page)
        expect(page.get_by_role('region', name='iPad 示教结果')).to_contain_text('1 个 Pose')

        # No stored pairing credentials and no functioning LAN API: file import still works.
        page.get_by_role('button', name='继续工作 · 返回主工作台继续示教').click()
        page.evaluate("localStorage.removeItem('atlas-ipad-handoffs-v1')")
        page.route('**/__atlas/ipad/**', lambda route: route.fulfill(
            status=503, content_type='application/json', body='{"error":"测试：局域网服务离线"}'))
        open_ipad_dialog(page)
        expect(dialog.get_by_role('alert')).to_contain_text('局域网服务离线')
        expect(dialog.get_by_role('button', name='导入结果文件')).to_be_enabled()
        second = json.loads(json.dumps(archive))
        second['result']['id'] = str(uuid.uuid4())
        second['result']['samples'][0]['name'] = '文件传入 Pose'
        transfer = page.evaluate_handle('''archive => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([JSON.stringify(archive)], 'Atlas-dropped.atlas-teaching.json', {type: 'application/json'}));
            return transfer;
        }''', second)
        dialog.get_by_role('region', name='AirDrop 或文件接收').dispatch_event('drop', {'dataTransfer': transfer})
        expect(dialog.locator('.ipad-result-file__receipt')).to_contain_text('已接收 1 个 Pose')
        expect(dialog.get_by_role('alert')).not_to_be_visible()
        page.get_by_role('button', name='关闭设备示教窗口').click()
        topbar_action(page, name='打开示教数据管理页').click()
        expect(page.locator('.teaching-data-page')).to_have_attribute('data-teaching-task-count', '2')
        page.reload(wait_until='networkidle')
        ready(page)
        expect(page.locator('.teaching-data-page')).to_have_attribute('data-teaching-task-count', '2')
        assert not result_requests, 'file import must not upload results or depend on the LAN result endpoint'
        assert not errors, errors
    finally:
        browser.close()
print('File picker, invalid/mismatched result rejection, duplicate import, exact Pose preservation, reload and drag/drop without LAN credentials/service passed.')
