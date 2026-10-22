"""Browser USB controls; optionally send one disposable model to a real iPhone or iPad."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from ipad_menu_helpers import open_ipad_dialog

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22025')
DEVICE = os.environ.get('ATLAS_USB_DEVICE_ID')
ARTIFACTS = Path(os.environ.get('ATLAS_USB_ARTIFACTS', 'ipad/build/usb-ui-verification'))
ARTIFACTS.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        status = {'supported': True, 'devices': [], 'message': ''}
        def mocked_status(route):
            route.fulfill(content_type='application/json', body=json.dumps(status))
        page.route('**/__atlas/ipad/usb', mocked_status)
        page.goto(BASE + '/workbench', wait_until='networkidle')
        page.locator('[data-session-state="ready"]').wait_for(state='attached')
        page.locator('.loading-curtain').wait_for(state='hidden')
        page.locator('[data-independent-teaching-input="true"]').set_input_files({
            'name': '数据线接收验证（临时）.ply', 'mimeType': 'application/octet-stream',
            'buffer': (Path(__file__).parent / 'fixtures/rotation-map.ply').read_bytes(),
        })
        page.locator('[data-session-state="ready"]').wait_for(state='attached')
        page.locator('.loading-curtain').wait_for(state='hidden')
        open_ipad_dialog(page)
        dialog = page.get_by_role('dialog', name='iPad / iPhone 示教')
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        dialog.get_by_role('tab', name='文件导入').click()
        dialog.locator('.ipad-sync-details > summary').click()
        panel = dialog.get_by_role('region', name='通过数据线发送物体')
        expect(panel).to_be_visible()
        send = panel.get_by_role('button', name='通过数据线发送', exact=True)
        expect(send).to_be_disabled()
        status['devices'] = [{'id': '11111111-1111-4111-8111-111111111111', 'name': 'Fixture iPad', 'ready': True}]
        expect(send).to_be_enabled(timeout=15000)
        status['devices'] = []
        expect(send).to_be_disabled(timeout=15000)

        if DEVICE:
            page.unroute('**/__atlas/ipad/usb', mocked_status)
            expect(panel.get_by_role('combobox', name='数据线连接的 iPhone / iPad')).to_be_visible(timeout=20000)
            panel.get_by_role('combobox', name='数据线连接的 iPhone / iPad').select_option(DEVICE)
            expect(send).to_be_enabled(timeout=20000)
            with page.expect_response(lambda response: response.request.method == 'POST' and response.url.endswith('/usb'), timeout=180000) as response:
                send.click()
            receipt = response.value.json()
            assert response.value.ok, receipt
            (ARTIFACTS / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
            expect(panel.get_by_role('status')).to_contain_text('已传至')
            expect(panel.get_by_role('status')).to_contain_text('方式三')
        else:
            status['devices'] = [{'id': '11111111-1111-4111-8111-111111111111', 'name': 'Fixture iPad', 'ready': True}]
            expect(send).to_be_enabled(timeout=15000)
            page.route('**/__atlas/ipad/sessions/*/usb', lambda route: route.fulfill(
                status=502, content_type='application/json', body=json.dumps({'error': '数据线已断开，请重试'})))
            send.click()
            expect(dialog.get_by_role('alert')).to_have_text('数据线已断开，请重试')
            expect(send).to_be_enabled()
        panel.scroll_into_view_if_needed()
        page.screenshot(path=str(ARTIFACTS / 'desktop-usb-transfer.png'))
        assert not errors, errors
    finally:
        browser.close()
print('USB browser controls: absent cable, connected device, disconnect, send action and receipt checked.')
