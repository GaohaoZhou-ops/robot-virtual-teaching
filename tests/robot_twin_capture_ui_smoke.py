"""Session photo retention, delayed decoding and history selection; no real robot."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22073')
CHROME = Path(os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
ARTIFACTS = Path(__file__).resolve().parents[1] / 'test-artifacts' / 'robot-twin-capture'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
HTML = '''<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Capture regression</title>
<style>body{background:#071310;color:#b9d0c6;font-family:sans-serif}.task-monitor{width:390px;height:94vh;display:flex}
.task-monitor__content{width:100%;display:flex;flex-direction:column}.task-monitor__scroll{overflow:auto}.inspector-collapse-toggle{height:40px}</style>
<div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
</script><script type="module" src="/tests/fixtures/robotTwinCaptureFixture.js"></script></html>'''

with sync_playwright() as p:
    options = {'headless': True}
    if CHROME.exists():
        options['executable_path'] = str(CHROME)
    browser = p.chromium.launch(**options)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/__capture_regression', lambda route: route.fulfill(content_type='text/html', body=HTML))
    try:
        page.goto(BASE + '/__capture_regression', wait_until='networkidle')
        expect(page.get_by_role('complementary', name='任务监控台')).to_be_visible()
        assert '算法结果' in page.locator('body').inner_text()
        panel = page.get_by_role('region', name='Zivid 采集结果', exact=True)
        page.evaluate('captureFixture.add(1)')
        page.evaluate("captureFixture.finish(1, 'left')")
        page.evaluate("captureFixture.finish(1, 'right')")
        expect(panel.locator('img')).to_have_count(2)
        first_urls = panel.locator('img').evaluate_all('(images) => images.map(image => image.src)')
        page.evaluate('captureFixture.startFrames(); captureFixture.add(2); captureFixture.add(3)')
        expect(panel).to_have_attribute('data-capture-id', f'{1:032x}')
        assert page.evaluate('captureFixture.aborted.length') == 0
        assert panel.locator('img').evaluate_all('(images) => images.map(image => image.src)') == first_urls

        # A downloaded PNG is still withheld until the browser finishes decoding.
        page.evaluate('captureFixture.holdDecode = true')
        page.evaluate("captureFixture.finish(2, 'left')")
        page.wait_for_function('captureFixture.decodes.length === 1')
        expect(panel).to_have_attribute('data-capture-id', f'{1:032x}')
        page.evaluate('captureFixture.decodeAll()')
        expect(panel).to_have_attribute('data-capture-id', f'{2:032x}')
        page.evaluate("captureFixture.finish(2, 'right')")
        page.wait_for_function("captureFixture.calls.some(path => path.endsWith('/' + '3'.padStart(32, '0') + '/right/png'))")
        page.evaluate("captureFixture.finish(3, 'left', true)")
        page.evaluate("captureFixture.finish(3, 'right', true)")
        expect(panel).to_have_attribute('data-capture-id', f'{2:032x}')

        panel.get_by_role('button', name='放大双 Zivid 采集结果').click()
        dialog = page.get_by_role('dialog', name='双 Zivid 采集结果', exact=True)
        history = dialog.get_by_role('complementary', name='采集记录列表')
        expect(history.get_by_role('button')).to_have_count(6)
        assert history.locator('[data-history-key]').evaluate_all('(rows) => rows.map(row => row.dataset.historyKey)') == [
            f'{capture_id:032x}:{side}' for capture_id in (1, 2, 3) for side in ('left', 'right')]
        assert page.locator('.task-monitor__result').evaluate_all('(rows) => rows.map(row => row.dataset.resultKey)') == [
            f'{3:032x}:left', f'{3:032x}:right']
        expect(history).to_contain_text('算法执行中')
        history.locator(f'[data-history-key="{3:032x}:left"]').click()
        expect(dialog).to_have_attribute('data-capture-id', f'{2:032x}')
        expect(dialog.locator('img').first).to_be_visible()
        history.locator(f'[data-history-key="{1:032x}:left"]').click()
        expect(dialog).to_have_attribute('data-capture-id', f'{1:032x}')
        assert dialog.locator('img').evaluate_all('(images) => images.map(image => image.src)') == first_urls
        expect(dialog.locator('.robot-twin-capture-info')).to_contain_text('照片 1')
        expect(dialog.locator('.robot-twin-capture__detection-type').first).to_have_text('标注 1')
        page.screenshot(path=str(ARTIFACTS / 'history.png'))
        dialog.get_by_role('button', name='关闭采集结果大窗').click()
        page.wait_for_function("captureFixture.calls.filter(path => path.includes('/' + '3'.padStart(32, '0') + '/')).length >= 4")
        page.evaluate("captureFixture.finish(3, 'left')")
        page.evaluate("captureFixture.finish(3, 'right')")
        page.wait_for_function("captureFixture.ready(3, 'left') && captureFixture.ready(3, 'right')")
        expect(panel).to_have_attribute('data-capture-id', f'{1:032x}')
        panel.get_by_role('button', name='回到最新').click()
        expect(panel).to_have_attribute('data-capture-id', f'{3:032x}')

        page.evaluate('captureFixture.add(4, true)')
        expect(panel).to_have_attribute('data-capture-id', f'{3:032x}')
        page.evaluate('captureFixture.sampling = false')
        assert page.evaluate('captureFixture.frames.length > 5 && captureFixture.frames.every(Boolean)'), 'a ready photo must survive every rendered refresh frame'

        # Leaving the viewer, then entering a new run, preserves all old photos.
        page.evaluate('captureFixture.add(5, false, true); captureFixture.unmount()')
        page.evaluate("captureFixture.finish(5, 'left')")
        page.evaluate("captureFixture.finish(5, 'right')")
        page.wait_for_function("captureFixture.ready(5, 'left') && captureFixture.ready(5, 'right')")
        assert page.evaluate('captureFixture.aborted.length') == 0
        page.evaluate('captureFixture.mount()')
        expect(panel).to_have_attribute('data-capture-id', f'{5:032x}')
        panel.get_by_role('button', name='放大双 Zivid 采集结果').click()
        expect(history.locator('[data-history-key]').first).to_have_attribute('data-history-key', f'{1:032x}:left')
        expect(history.locator('[data-history-key]').last).to_have_attribute('data-history-key', f'{5:032x}:right')
        history.locator(f'[data-history-key="{1:032x}:left"]').click()
        expect(dialog).to_have_attribute('data-capture-id', f'{1:032x}')
        assert dialog.locator('img').evaluate_all('(images) => images.map(image => image.src)') == first_urls
        assert page.evaluate("captureFixture.calls.filter(path => path.includes('/' + '1'.padStart(32, '0') + '/')).length") == 2
        page.evaluate('captureFixture.add(6); captureFixture.disconnect()')
        expect(panel).to_have_count(0)
        assert page.evaluate('captureFixture.urls.size') == 0
        assert not errors, errors
        print('Capture UI passed: no blank frames, decode gating, retry, full history, cross-run selection, unmounted downloads and disconnect cleanup.')
    finally:
        browser.close()
