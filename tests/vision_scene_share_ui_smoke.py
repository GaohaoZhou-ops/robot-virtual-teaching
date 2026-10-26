import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22071')
ARTIFACTS = ROOT / 'vision/test-artifacts/scene-review'
ARTIFACTS.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    page.set_default_timeout(30000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('response', lambda response: print('Unexpected HTML:', response.url) if '/__atlas/' in response.url and 'text/html' in response.headers.get('content-type', '') else None)
    page.route('**/xian_map.ply', lambda route: route.fulfill(body=(ROOT / 'tests/fixtures/rotation-map.ply').read_bytes(), content_type='application/octet-stream'))
    page.goto(BASE + '/workbench')
    page.wait_for_load_state('networkidle')
    page.locator('[data-session-state="ready"]').wait_for(state='attached')
    page.locator('.loading-curtain').wait_for(state='hidden')
    print('Workbench ready; device controls:', page.locator('[data-workbench-menu-trigger]').all_text_contents())
    page.locator('input[type="file"][accept=".ply"]').first.set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
    page.locator('.loading-curtain').wait_for(state='hidden')
    topbar_action(page, 'Vision Pro', exact=True).click()
    page.get_by_role('menuitem', name='完整工程空间查看', exact=True).click()
    dialog = page.get_by_role('dialog', name='在 Vision Pro 查看完整工程')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('status')).to_contain_text('已准备好', timeout=60000)
    expect(dialog.locator('input')).to_have_count(0)
    expect(dialog.get_by_role('button')).to_have_count(1)
    bounds = dialog.bounding_box()
    assert bounds['x'] > 0 and bounds['y'] > 0 and bounds['y'] + bounds['height'] < 960
    expect(page.locator('.toast-message.error')).to_have_count(0)
    page.screenshot(path=str(ARTIFACTS / 'desktop-sharing.png'), full_page=True)
    scenes = page.request.get(BASE + '/__atlas/vision-scenes').json()['scenes']
    assert len(scenes) == 1, 'StrictMode must publish only one snapshot'
    page.keyboard.press('Tab')
    expect(dialog.get_by_role('button', name='关闭空间工程共享')).to_be_focused()
    with page.expect_response(lambda response: response.request.method == 'DELETE' and '/__atlas/vision-scenes/' in response.url) as revoked:
        page.keyboard.press('Escape')
    assert revoked.value.status == 200
    expect(dialog).not_to_be_visible()
    assert page.request.get(BASE + '/__atlas/vision-scenes').json()['scenes'] == []
    assert not errors, errors
    browser.close()
print('Desktop scene sharing passed: map-mode entry, actual geometry publication, modal layout, focus, and closing revokes sharing.')
