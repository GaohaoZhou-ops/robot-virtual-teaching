"""Independent A/B preview budgets, requests, persistence and full-quality exports."""
import hashlib
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from model_editor_ui_smoke import BASE_URL, CHROME, start_model_download
from model_editor_viewport_ui_smoke import point_cloud, dense_mesh


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page.set_default_timeout(30000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'{BASE_URL}/model-editor/dual', wait_until='networkidle')
            editor = page.locator('[data-app-page="model-pair-editor"]')
            canvas = page.get_by_label('模型编辑三维预览', exact=True)
            a_count = 240000
            mesh, b_vertices, b_faces = dense_mesh()
            for slot, payload in [('A', point_cloud(a_count)), ('B', mesh)]:
                page.get_by_label(f'导入模型 {slot} 文件', exact=True).set_input_files({
                    'name': f'quality-{slot}.ply', 'buffer': payload, 'mimeType': 'application/octet-stream'})
                expect(page.get_by_role('region', name=f'模型 {slot} 加载与预览', exact=True)).to_have_attribute('data-load-state', 'ready')
            for slot, quality in [('A', 'performance'), ('B', 'detail')]:
                page.get_by_role('region', name=f'模型 {slot} 加载与预览', exact=True).get_by_label('显示质量', exact=True).select_option(quality)
                expect(page.get_by_label(f'模型 {slot} 三维预览', exact=True)).to_have_attribute('data-display-quality', quality)
            page.evaluate('''() => {
                window.__previewRequests = []; window.__compositions = 0;
                const post = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function(message, ...args) {
                    if (message.type === 'compose') window.__compositions++;
                    if (message.type === 'preview') {
                        window.__previewRequests.push({ slot: message.slot, quality: message.quality });
                        if (message.slot === 'a' && window.__holdA) {
                            window.__releaseA = () => { window.__holdA = false; post.call(this, message, ...args); };
                            return;
                        }
                    }
                    return post.call(this, message, ...args);
                };
            }''')

            def ready():
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                expect(canvas).to_have_attribute('data-render-state', 'ready')

            def quality(slot):
                return page.get_by_label(f'模型 {slot} 显示质量', exact=True)

            def view():
                return [canvas.get_attribute(f'data-{key}') for key in ['camera-position', 'camera-target', 'camera-up',
                    'optical-zoom', 'precision-pan-x', 'precision-pan-y', 'ground-transform', 'origin-screen-position',
                    'model-transform', 'base-model-transform']]

            def download(name):
                with page.expect_download() as event:
                    start_model_download(page)
                target = Path(f'/tmp/model-editor-pair-quality-{name}.ply')
                event.value.save_as(target); ready()
                raw = target.read_bytes(); header = raw.split(b'end_header\n', 1)[0].decode()
                assert f'element vertex {a_count + b_vertices}\n' in header
                assert f'element face {b_faces}\n' in header
                return hashlib.sha256(raw).hexdigest()

            page.get_by_role('button', name='开始编辑', exact=True).click(); ready()
            expect(quality('A')).to_have_value('performance'); expect(quality('B')).to_have_value('detail')
            expect(canvas).to_have_attribute('data-base-model-quality', 'performance')
            expect(canvas).to_have_attribute('data-display-quality', 'detail')
            expect(canvas).to_have_attribute('data-base-model-points', '80000')
            expect(canvas).to_have_attribute('data-preview-faces', str(b_faces))
            assert page.evaluate('window.__previewRequests') == [], 'Entering joint editing regenerated the loaded previews'

            page.get_by_label('模型 B X', exact=True).fill('0.5')
            page.get_by_label('模型 B YAW', exact=True).fill('30')
            rect = canvas.bounding_box(); x, y = rect['x'] + rect['width'] * .4, rect['y'] + rect['height'] * .4
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 40, y + 25, steps=10); page.mouse.up()
            fixed = view()
            # Hold A's request while changing B. B must finish independently,
            # without repeating A or waiting for its preview.
            page.evaluate('window.__holdA = true')
            quality('A').select_option('full')
            page.wait_for_function('Boolean(window.__releaseA)')
            quality('B').select_option('performance')
            expect(canvas).to_have_attribute('data-display-quality', 'performance')
            expect(canvas).to_have_attribute('data-base-model-quality', 'performance')
            assert int(canvas.get_attribute('data-preview-faces')) <= 180000 < b_faces
            expect(canvas).to_have_attribute('data-base-model-points', '80000')
            assert page.evaluate('window.__previewRequests') == [{'slot': 'a', 'quality': 'full'}, {'slot': 'b', 'quality': 'performance'}]
            assert view() == fixed
            page.evaluate('window.__releaseA()'); ready()
            expect(canvas).to_have_attribute('data-base-model-quality', 'full')
            expect(canvas).to_have_attribute('data-base-model-points', str(a_count))
            expect(canvas).to_have_attribute('data-removed-quality', 'full')
            expect(canvas).to_have_attribute('data-display-quality', 'performance')
            assert view() == fixed

            quality('A').select_option('performance'); ready()
            expect(canvas).to_have_attribute('data-base-model-points', '80000')
            expect(canvas).to_have_attribute('data-removed-points', '80000')
            expect(canvas).to_have_attribute('data-removed-quality', 'performance')
            quality('B').select_option('full'); ready()
            expect(canvas).to_have_attribute('data-preview-faces', str(b_faces))
            expect(canvas).to_have_attribute('data-base-model-quality', 'performance')
            assert page.evaluate('window.__previewRequests.slice(2)') == [{'slot': 'a', 'quality': 'performance'}, {'slot': 'b', 'quality': 'full'}]
            assert page.evaluate('window.__compositions') == 0
            assert view() == fixed

            page.get_by_role('radio', name='合并', exact=False).check()
            page.get_by_role('button', name='确定双模型处理', exact=True).click(); ready()
            baseline = download('before')
            quality('A').select_option('balanced')
            quality('B').select_option('balanced')
            quality('A').select_option('detail')
            quality('B').select_option('performance'); ready()
            expect(canvas).to_have_attribute('data-base-model-quality', 'detail')
            expect(canvas).to_have_attribute('data-display-quality', 'performance')
            expect(editor).to_have_attribute('data-composition-state', 'applied')
            assert page.evaluate('window.__compositions') == 1
            assert view() == fixed
            assert download('after') == baseline, 'Display budgets changed the full exported geometry'

            # The same per-model preferences survive both directions of navigation.
            requests_before = page.evaluate('window.__previewRequests')
            page.get_by_role('button', name='模型加载', exact=True).click()
            for slot, expected in [('A', 'detail'), ('B', 'performance')]:
                expect(page.get_by_role('region', name=f'模型 {slot} 加载与预览', exact=True).get_by_label('显示质量', exact=True)).to_have_value(expected)
                expect(page.get_by_label(f'模型 {slot} 三维预览', exact=True)).to_have_attribute('data-display-quality', expected)
            page.get_by_role('button', name='开始编辑', exact=True).click(); ready()
            assert page.evaluate('window.__previewRequests') == requests_before
            expect(quality('A')).to_have_value('detail'); expect(quality('B')).to_have_value('performance')
            expect(page.get_by_role('button', name='导出 PLY', exact=True)).to_be_enabled()
            page.screenshot(path='/tmp/model-editor-pair-quality-desktop.png')
            for width, height in [(1024, 768), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height}); page.wait_for_timeout(200)
                assert page.locator('.model-editor__main').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                assert page.locator('.model-editor__view-toolbar').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                expect(quality('A')).to_be_visible(); expect(quality('B')).to_be_visible()
                assert canvas.bounding_box()['height'] >= 300
                page.screenshot(path=f'/tmp/model-editor-pair-quality-{width}.png')
            assert not errors, errors
            print('independent A/B quality: real point/mesh budgets, isolated overlapping requests, ghost budget, preserved pose/camera, loading/editing persistence, full export hashes and responsive controls passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
