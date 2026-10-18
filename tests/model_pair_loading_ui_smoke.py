"""Independent A/B loading, interactive previews, explicit start and import races."""
import json
from playwright.sync_api import expect, sync_playwright
from model_editor_ui_smoke import BASE_URL, CHROME, read_export, start_model_download
from model_pair_editor_ui_smoke import POINTS_A, POINTS_B, FACES_B, IDENTITY, fixture


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page.set_default_timeout(30000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            # Hold real worker requests or responses so races are deterministic.
            # Parsing, rendering, composition and exports still use the real code.
            page.add_init_script('''
                window.__loadDelays = {};
                window.__heldLoads = {};
                window.__receivedLoads = {};
                const NativeWorker = window.Worker;
                window.Worker = class extends NativeWorker {
                    constructor(...args) {
                        super(...args);
                        this.loadNames = new Map();
                        this.addEventListener('message', event => {
                            const name = this.loadNames.get(event.data.id);
                            if (!name) return;
                            if (window.__loadDelays[name] === 'response') {
                                event.stopImmediatePropagation();
                                window.__heldLoads[name] = () => {
                                    delete window.__loadDelays[name];
                                    this.dispatchEvent(new MessageEvent('message', { data: event.data }));
                                };
                            } else window.__receivedLoads[name] = event.data;
                        });
                    }
                    postMessage(message, ...args) {
                        if (message.type === 'load' && message.slot) {
                            const name = message.file.name;
                            this.loadNames.set(message.id, name);
                            if (window.__loadDelays[name] === 'request') {
                                window.__heldLoads[name] = () => {
                                    delete window.__loadDelays[name];
                                    super.postMessage(message, ...args);
                                };
                                return;
                            }
                        }
                        super.postMessage(message, ...args);
                    }
                };
                window.__releaseLoad = name => { window.__heldLoads[name](); delete window.__heldLoads[name]; };
            ''')
            page.goto(f'{BASE_URL}/model-editor/dual', wait_until='networkidle')
            editor = page.locator('[data-app-page="model-pair-editor"]')
            start = page.get_by_role('button', name='开始编辑', exact=True)
            export = page.get_by_role('button', name='导出 PLY', exact=True)
            combined = page.get_by_label('模型编辑三维预览', exact=True)

            def panel(slot):
                return page.get_by_role('region', name=f'模型 {slot} 加载与预览', exact=True)

            def canvas(slot):
                return page.get_by_label(f'模型 {slot} 三维预览', exact=True)

            def load(slot, name, points=POINTS_A, faces=(), raw=None):
                page.get_by_label(f'导入模型 {slot} 文件', exact=True).set_input_files({
                    'name': name, 'buffer': raw if raw is not None else fixture(points, faces),
                    'mimeType': 'application/octet-stream'})

            def loaded(slot):
                expect(panel(slot)).to_have_attribute('data-load-state', 'ready')
                expect(canvas(slot)).to_have_attribute('data-render-state', 'ready')

            def hold(name, kind='request'):
                page.evaluate('([name, kind]) => window.__loadDelays[name] = kind', [name, kind])

            def release(name):
                page.wait_for_function('name => Boolean(window.__heldLoads[name])', arg=name)
                page.evaluate('name => window.__releaseLoad(name)', name)
                page.wait_for_function('name => Boolean(window.__receivedLoads[name])', arg=name)

            def camera(slot):
                return [canvas(slot).get_attribute(f'data-{key}') for key in ['camera-position', 'camera-target', 'camera-up', 'optical-zoom']]

            def begin_edit():
                start.click()
                expect(editor).to_have_attribute('data-workspace-stage', 'editing')
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                expect(combined).to_have_attribute('data-render-state', 'ready')

            expect(start).to_have_count(0)
            hold('slow-a.ply'); hold('slow-b.ply')
            load('A', 'slow-a.ply')
            expect(panel('A')).to_have_attribute('data-load-state', 'loading')
            expect(page.get_by_role('button', name='加载模型 B', exact=True)).to_be_enabled()
            load('B', 'slow-b.ply', POINTS_B, FACES_B)
            expect(panel('B')).to_have_attribute('data-load-state', 'loading')
            expect(start).to_have_count(0)
            expect(page.locator('.model-editor__busy')).to_have_count(0)
            # Cancelling a new selection while reading preserves the pending load.
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='重新加载模型 A', exact=True).click()
            chooser.value.set_files([])
            expect(panel('A')).to_have_attribute('data-load-state', 'loading')
            release('slow-b.ply'); loaded('B')
            expect(canvas('A')).to_have_count(0)
            expect(start).to_have_count(0)
            expect(combined).to_have_count(0)
            page.screenshot(path='/tmp/model-editor-pair-loading-one.png')

            # A completed preview stays usable while the other file is reading.
            before = camera('B'); rect = canvas('B').bounding_box()
            x, y = rect['x'] + rect['width'] * .4, rect['y'] + rect['height'] * .45
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 65, y + 35, steps=12); page.mouse.up()
            assert camera('B') != before
            panel('B').get_by_role('button', name='俯视', exact=True).click()
            before = camera('B')
            panel('B').locator('.model-editor__interaction-mode').click()
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 35, y + 20, steps=10); page.mouse.up()
            assert camera('B') != before
            before = canvas('B').get_attribute('data-camera-distance')
            page.mouse.wheel(0, -300)
            expect(canvas('B')).not_to_have_attribute('data-camera-distance', before)
            panel('B').get_by_label('显示质量', exact=True).select_option('performance')
            expect(canvas('B')).to_have_attribute('data-display-quality', 'performance')
            panel('B').get_by_label('点大小', exact=True).fill('5')
            assert json.loads(canvas('B').get_attribute('data-model-transform')) == IDENTITY
            before = camera('B')
            release('slow-a.ply'); loaded('A')
            assert camera('B') == before, 'Loading A reset the independent B camera'
            expect(panel('A').get_by_label('显示质量', exact=True)).to_have_value('balanced')
            expect(panel('A').get_by_label('点大小', exact=True)).to_have_value('3')
            expect(panel('B').get_by_label('点大小', exact=True)).to_have_value('5')
            expect(start).to_be_enabled()
            expect(combined).to_have_count(0)
            expect(page.get_by_label('模型 B X', exact=True)).to_have_count(0)
            page.screenshot(path='/tmp/model-editor-pair-loading-ready.png')

            # Both the desktop split and mobile stacked layout keep usable canvases.
            for width, height in [(1024, 768), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(200)
                assert page.locator('.model-editor__main').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                for slot in ['A', 'B']:
                    assert canvas(slot).bounding_box()['height'] >= 300
                    assert panel(slot).evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                page.screenshot(path=f'/tmp/model-editor-pair-loading-{width}.png')
            page.set_viewport_size({'width': 1440, 'height': 1000})
            begin_edit()
            expect(page.get_by_label('模型 B X', exact=True)).to_have_value('0')
            page.get_by_label('模型 B X', exact=True).fill('0.5')
            page.get_by_role('button', name='模型加载', exact=True).click()
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='重新加载模型 B', exact=True).click()
            chooser.value.set_files([])
            expect(start).to_be_enabled()
            begin_edit()
            expect(page.get_by_label('模型 B X', exact=True)).to_have_value('0.5')

            # An older request arriving last must not replace the latest source
            # inside the worker or the visible filename and preview.
            hold('stale-a.ply')
            load('A', 'stale-a.ply', [(100, 0, 0)])
            expect(panel('A')).to_have_attribute('data-load-state', 'loading')
            expect(start).to_have_count(0)
            expect(page.get_by_role('button', name='重新加载模型 A', exact=True)).to_be_enabled()
            latest_a = [(7, 0, 0), (8, 1, 0), (9, 0, 0)]
            load('A', 'latest-a.ply', latest_a); loaded('A')
            release('stale-a.ply')
            assert page.evaluate('window.__receivedLoads["stale-a.ply"].data.stale')
            expect(panel('A').get_by_text('latest-a.ply', exact=True)).to_be_visible()
            expect(panel('B').get_by_text('slow-b.ply', exact=True)).to_be_visible()

            # An already parsed older response arriving last must also be ignored.
            hold('stale-b.ply', 'response')
            load('B', 'stale-b.ply', [(200, 0, 0)])
            page.wait_for_function('Boolean(window.__heldLoads["stale-b.ply"])')
            load('B', 'latest-b.ply', POINTS_B, FACES_B); loaded('B')
            release('stale-b.ply')
            expect(panel('B').get_by_text('latest-b.ply', exact=True)).to_be_visible()
            expect(canvas('B')).to_have_attribute('data-preview-faces', '12')
            begin_edit()
            expect(page.get_by_label('模型 B X', exact=True)).to_have_value('0')
            page.get_by_role('radio', name='合并', exact=False).check()
            page.get_by_role('button', name='确定双模型处理', exact=True).click()
            expect(export).to_be_enabled()
            with page.expect_download() as download:
                start_model_download(page)
            target = '/tmp/model-editor-pair-loading-race.ply'; download.value.save_as(target)
            points, faces = read_export(target)
            assert points == latest_a + POINTS_B and faces == 12, 'Preview and exported sources disagree after reloading'

            # Failure remains local, preserves both previews and hides Start until retry succeeds.
            load('B', 'invalid.ply', raw=b'invalid')
            expect(panel('B')).to_have_attribute('data-load-state', 'error')
            expect(panel('B').get_by_role('alert')).to_contain_text('加载失败')
            expect(panel('A')).to_have_attribute('data-load-state', 'ready')
            expect(canvas('B')).to_have_attribute('data-render-state', 'ready')
            expect(start).to_have_count(0)
            expect(export).to_be_disabled()
            load('B', 'wrong.txt', raw=b'invalid')
            expect(panel('B').get_by_role('alert')).to_contain_text('.ply')
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='重新加载模型 B', exact=True).click()
            chooser.value.set_files({'name': 'latest-b.ply', 'buffer': fixture(POINTS_B, FACES_B), 'mimeType': 'application/octet-stream'})
            loaded('B'); expect(start).to_be_enabled()
            # Clearing the native input lets the identical file be selected again.
            assert page.get_by_label('导入模型 B 文件', exact=True).input_value() == ''
            load('B', 'latest-b.ply', POINTS_B, FACES_B); loaded('B')
            expect(start).to_be_enabled()
            expect(panel('B').get_by_role('alert')).to_have_count(0)
            assert not errors, errors
            print('split loading UI: independent pending/ready panels, camera/quality controls, explicit start, cancel/retry/same-file reload, request/response races, full exports and responsive layouts passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
