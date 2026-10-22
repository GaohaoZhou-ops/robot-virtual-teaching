"""Sync tabs, offline import, Wi-Fi receipts, keyboard navigation and compact layouts."""
import copy
import json
import os
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright
from ipad_menu_helpers import open_ipad_dialog
from ipad_teaching_source_ui_smoke import fixture_data, ready, saved_workspace

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22051')
ARTIFACTS = Path(os.environ.get('ATLAS_TEST_ARTIFACTS', 'test-artifacts/ipad-sync'))
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def api(path, body, token=None):
    request = Request(BASE + '/__atlas/ipad' + path, data=json.dumps(body).encode(),
                      headers={'Content-Type': 'application/json',
                               **({'Authorization': 'Bearer ' + token} if token else {})})
    with urlopen(request) as response:
        return json.load(response)


_, archive = fixture_data()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True,
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 850})
        page.set_default_timeout(15000)
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: requests.append(request.url)
                if '/__atlas/ipad/' in request.url else None)
        page.goto(BASE + '/workbench', wait_until='networkidle')
        ready(page)
        page.locator('[data-independent-teaching-input]').set_input_files(
            str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
        ready(page)
        dialog = open_ipad_dialog(page, '导入结果文件')
        expect(dialog.get_by_role('tab')).to_have_text(['文件导入', '扫码', 'Wi-Fi'])
        expect(dialog.get_by_role('tab', name='文件导入')).to_have_attribute('aria-selected', 'true')
        assert not requests, 'opening file import must not prepare or poll a device transfer'
        page.route('**/__atlas/ipad/**', lambda route: route.fulfill(status=503,
            content_type='application/json', body='{"error":"局域网离线"}'))
        dialog.locator('[data-ipad-result-input]').set_input_files({
            'name': 'result.atlas-teaching.json', 'mimeType': 'application/json',
            'buffer': json.dumps(archive).encode()})
        expect(dialog.get_by_role('heading', name='同步完成', exact=True)).to_be_visible()
        expect(dialog.get_by_role('button', name='查看示教')).to_be_focused()
        assert dialog.locator('.ipad-sync-success__check').evaluate(
            "el => getComputedStyle(el).animationName") == 'ipad-sync-check'
        saved_workspace(page, 'ipad-' + archive['result']['id'], 1)
        page.screenshot(path=str(ARTIFACTS / 'success.png'), animations='disabled')
        dialog.get_by_role('button', name='继续同步').click()
        expect(dialog.get_by_role('tab', name='文件导入')).to_be_focused()

        # Keyboard selection and failure recovery; no QR request on the Wi-Fi tab.
        dialog.get_by_role('tab', name='文件导入').press('End')
        expect(dialog.get_by_role('tab', name='Wi-Fi', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(dialog.get_by_role('alert')).to_contain_text('局域网离线')
        page.unroute('**/__atlas/ipad/**')
        dialog.get_by_role('button', name='重试准备配对信息').click()
        expect(dialog.locator('.ipad-wifi-code .ipad-code')).to_be_visible()
        assert not any(url.endswith('/pairing-qr') for url in requests)
        ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
        code = dialog.locator('.ipad-code').inner_text().replace('\n', '')
        dialog.get_by_role('tab', name='扫码', exact=True).click()
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        expect(dialog.locator('.ipad-code')).to_have_text(code)
        dialog.get_by_role('tab', name='Wi-Fi', exact=True).click()
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_have_count(0)
        assert page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0].id") == ticket['id']

        # A lost server acknowledgement must not hide a successful local save.
        paired = api('/pair', {'code': ticket['pairingCode'], 'deviceId': str(uuid.uuid4()), 'deviceName': 'Test iPad'})
        result = {**copy.deepcopy(archive['result']), 'sessionId': ticket['id']}
        api('/sessions/' + ticket['id'] + '/result', result, paired['deviceToken'])
        expect(dialog.get_by_role('button', name='接收示教结果', exact=True)).to_be_enabled()
        page.route('**/imported', lambda route: route.fulfill(status=503,
            content_type='application/json', body='{"error":"回执中断"}'))
        dialog.get_by_role('button', name='接收示教结果', exact=True).click()
        expect(dialog.locator('.ipad-sync-receipt-notice')).to_contain_text('Pose 已保存')
        expect(dialog.get_by_role('heading', name='同步完成', exact=True)).to_be_visible()
        saved_workspace(page, 'ipad-' + result['id'], 1)
        page.unroute('**/imported')
        dialog.get_by_role('button', name='继续同步').click()
        dialog.get_by_role('button', name='接收示教结果', exact=True).click()
        expect(dialog.get_by_role('button', name='查看示教')).to_be_focused()
        expect(dialog.locator('.ipad-sync-receipt-notice')).to_have_count(0)
        saved_workspace(page, 'ipad-' + result['id'], 1)
        dialog.get_by_role('button', name='查看示教').click()
        expect(dialog).not_to_be_visible()

        # The direct menu entry, tab focus loop and reduced motion work on narrow screens.
        dialog = open_ipad_dialog(page, 'Wi-Fi 同步')
        expect(dialog.get_by_role('tab', name='Wi-Fi', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(dialog.get_by_role('button', name='关闭设备示教窗口')).to_be_enabled()
        page.set_viewport_size({'width': 390, 'height': 844})
        page.emulate_media(reduced_motion='reduce')
        dialog.get_by_role('tab', name='Wi-Fi', exact=True).press('Home')
        expect(dialog.get_by_role('tab', name='文件导入')).to_be_focused()
        assert dialog.evaluate('el => el.scrollWidth <= el.clientWidth')
        assert dialog.evaluate('el => getComputedStyle(el).animationName') == 'none'
        dialog.get_by_role('button', name='关闭设备示教窗口').press('Shift+Tab')
        expect(dialog.locator('.ipad-sync-details > summary')).to_be_focused()
        dialog.locator('.ipad-sync-details > summary').press('Tab')
        expect(dialog.get_by_role('button', name='关闭设备示教窗口')).to_be_focused()
        page.screenshot(path=str(ARTIFACTS / 'mobile-file.png'), animations='disabled')
        dialog.press('Escape')
        expect(dialog).not_to_be_visible()
        assert not errors, errors
    finally:
        browser.close()
print('Sync methods passed: offline file import, Wi-Fi/QR switching, real result receipt, lost acknowledgement, deduplication, keyboard focus and reduced motion.')
