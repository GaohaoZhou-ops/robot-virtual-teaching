"""Two-model loading, shared pose controls, rotated replacement and merged exports."""
import json
import math
from playwright.sync_api import expect, sync_playwright
from model_editor_ui_smoke import BASE_URL, CHROME, read_export, start_model_download

POINTS_A = [(x / 2, y / 2, 0) for x in range(-4, 5) for y in range(-4, 5)]
POINTS_B = [(-1, -.25, -.5), (1, -.25, -.5), (1, .25, -.5), (-1, .25, -.5),
            (-1, -.25, .5), (1, -.25, .5), (1, .25, .5), (-1, .25, .5)]
FACES_B = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
           (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def fixture(points, faces=(), color=(133, 185, 205)):
    header = f'ply\nformat ascii 1.0\nelement vertex {len(points)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\n'
    if faces:
        header += f'element face {len(faces)}\nproperty list uchar int vertex_indices\n'
    body = ''.join(' '.join(map(str, (*point, *color))) + '\n' for point in points)
    body += ''.join('3 ' + ' '.join(map(str, face)) + '\n' for face in faces)
    return (header + 'end_header\n' + body).encode()


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page.set_default_timeout(30000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
            expect(page.get_by_role('heading', name='单模型处理', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='选择 PLY 模型', exact=True)).to_be_enabled()
            page.get_by_role('button', name='打开双模型处理', exact=True).click()
            expect(page).to_have_url(f'{BASE_URL}/model-editor/dual')
            expect(page).to_have_title('双模型处理 · 虚拟示教平台')
            editor = page.locator('[data-app-page="model-pair-editor"]')
            canvas = page.get_by_label('模型编辑三维预览', exact=True)
            export = page.get_by_role('button', name='导出 PLY', exact=True)
            confirm = page.get_by_role('button', name='确定双模型处理', exact=True)
            replace, merge = [page.get_by_role('radio', name=name, exact=False) for name in ['替换', '合并']]

            def ready():
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                expect(canvas).to_have_attribute('data-render-state', 'ready')

            def field(name):
                return page.get_by_label(f'模型 B {name}', exact=True)

            def pose():
                return [float(field(name).input_value()) for name in ['X', 'Y', 'Z', 'ROLL', 'PITCH', 'YAW']]

            def camera():
                return [canvas.get_attribute(f'data-{name}') for name in ['camera-position', 'camera-target', 'camera-up', 'ground-transform', 'origin-screen-position']]

            def download(name):
                with page.expect_download() as event:
                    start_model_download(page)
                target = f'/tmp/model-editor-pair-{name}.ply'
                event.value.save_as(target); ready()
                return read_export(target)

            def load(slot, points, faces=()):
                page.get_by_label(f'导入模型 {slot} 文件', exact=True).set_input_files({
                    'name': f'model-{slot}.ply', 'mimeType': 'application/octet-stream',
                    'buffer': fixture(points, faces, (228, 186, 90) if slot == 'B' else (133, 185, 205))})
                expect(page.get_by_role('region', name=f'模型 {slot} 加载与预览', exact=True)).to_have_attribute('data-load-state', 'ready')
                expect(page.get_by_label(f'模型 {slot} 三维预览', exact=True)).to_have_attribute('data-render-state', 'ready')

            def start():
                page.get_by_role('button', name='开始编辑', exact=True).click()
                expect(editor).to_have_attribute('data-workspace-stage', 'editing'); ready()

            expect(export).to_be_disabled()
            # B may be imported first; importing A initializes the common origin.
            load('B', POINTS_B, FACES_B)
            expect(page.get_by_role('button', name='开始编辑', exact=True)).to_have_count(0)
            expect(confirm).to_have_count(0)
            load('A', POINTS_A)
            start()
            assert pose() == [0] * 6
            assert json.loads(canvas.get_attribute('data-model-transform')) == IDENTITY
            assert json.loads(canvas.get_attribute('data-base-model-transform')) == IDENTITY
            expect(canvas).to_have_attribute('data-envelope-visible', 'true')
            expect(replace).to_be_checked(); expect(merge).not_to_be_checked()
            expect(export).to_be_disabled()
            confirm.click(); ready()
            points, faces = download('replace-zero')
            assert len(points) == 84 and faces == 12
            expected_a = [point for point in POINTS_A if not (-1 <= point[0] <= 1 and abs(point[1]) <= .25)]
            assert points[:-8] == expected_a and points[-8:] == POINTS_B

            page.evaluate('''() => {
                window.__compositions = 0;
                const post = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function(message, ...args) {
                    if (message.type === 'compose') window.__compositions++;
                    return post.call(this, message, ...args);
                };
            }''')
            field('YAW').fill('45')
            expect(export).to_be_disabled()
            merge.check(); expect(replace).not_to_be_checked()
            expect(canvas).to_have_attribute('data-removed-visible', 'false')
            replace.check()
            expect(canvas).to_have_attribute('data-removed-color', 'ffa12f')
            page.wait_for_timeout(350)
            assert page.evaluate('window.__compositions') == 0
            assert json.loads(canvas.get_attribute('data-envelope-transform')) == json.loads(canvas.get_attribute('data-model-transform'))
            confirm.click(); ready()
            points, faces = download('rotated-replace')
            assert len(points) == 86 and faces == 12
            assert (.5, -.5, 0) in points[:-8], 'AABB clipping incorrectly removed a point outside the rotated box'
            assert (.5, .5, 0) not in points[:-8]
            for actual, (x, y, z) in zip(points[-8:], POINTS_B):
                assert math.dist(actual, ((x - y) / math.sqrt(2), (x + y) / math.sqrt(2), z)) < 1e-6
            page.screenshot(path='/tmp/model-editor-pair-replace-review.png')

            # Dragging B shares the single-model controls, while A and the floor stay fixed.
            page.get_by_role('button', name='移动模型', exact=True).click()
            before, fixed = pose(), camera()
            rect = canvas.bounding_box(); x, y = rect['x'] + 80, rect['y'] + 95
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 45, y + 20, steps=12); page.mouse.up()
            assert pose() != before
            assert camera() == fixed
            assert json.loads(canvas.get_attribute('data-base-model-transform')) == IDENTITY
            canvas.focus(); page.keyboard.press('Control+z')
            assert pose() == before
            page.get_by_role('button', name='旋转模型', exact=True).click()
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 35, y + 30, steps=10); page.mouse.up()
            assert pose()[3:] != before[3:]
            assert camera() == fixed
            canvas.focus(); page.keyboard.press('Control+z'); assert pose() == before
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 25, y + 15, steps=8)
            page.keyboard.press('Escape'); page.mouse.up()
            assert pose() == before
            expect(canvas).to_have_attribute('data-origin-edit-mode', 'view')
            field('X').fill('')
            expect(page.get_by_role('alert')).to_contain_text('XYZ 和 RPY')
            expect(confirm).to_be_disabled(); expect(export).to_be_disabled()
            page.keyboard.press('Control+z'); expect(field('X')).to_have_value('0')

            merge.check(); expect(replace).not_to_be_checked(); expect(export).to_be_disabled()
            field('X').fill('0.5'); field('Y').fill('-0.25'); field('Z').fill('0.1')
            confirm.click(); ready()
            points, faces = download('merge')
            assert len(points) == 89 and faces == 12 and points[:81] == POINTS_A
            for actual, (x, y, z) in zip(points[-8:], POINTS_B):
                assert math.dist(actual, ((x - y) / math.sqrt(2) + .5, (x + y) / math.sqrt(2) - .25, z + .1)) < 1e-6
            fixed = camera()
            page.get_by_label('模型 A 显示质量', exact=True).select_option('performance'); ready()
            expect(canvas).to_have_attribute('data-display-quality', 'balanced')
            expect(canvas).to_have_attribute('data-base-model-quality', 'performance')
            page.get_by_label('模型 B 显示质量', exact=True).select_option('detail'); ready()
            expect(canvas).to_have_attribute('data-display-quality', 'detail')
            expect(canvas).to_have_attribute('data-base-model-quality', 'performance')
            assert camera() == fixed
            assert download('quality-independent') == (points, faces)
            page.get_by_label('显示 B 外包络', exact=True).uncheck()
            expect(canvas).to_have_attribute('data-envelope-visible', 'false')
            page.get_by_label('显示 B 外包络', exact=True).check()
            page.screenshot(path='/tmp/model-editor-pair-merge-review.png')

            # The native picker is invoked during the click and writes the confirmed PLY.
            page.evaluate('''() => {
                window.__nativeSave = null;
                window.showSaveFilePicker = async options => {
                    window.__nativeSave = { options, active: navigator.userActivation.isActive };
                    return { name: 'combined.ply', createWritable: async () => ({
                        write: async buffer => { window.__nativeSave.bytes = buffer.byteLength; },
                        close: async () => { window.__nativeSave.closed = true; },
                        abort: async () => { window.__nativeSave.aborted = true; },
                    }) };
                };
            }''')
            export.click(); ready()
            native = page.evaluate('window.__nativeSave')
            assert native['active'] and native['closed'] and native['bytes'] > 100
            assert native['options']['suggestedName'] == 'model-A-merged.ply'

            page.get_by_role('button', name='模型详情', exact=True).click()
            details = page.get_by_role('dialog', name='模型详情', exact=True)
            expect(details).to_contain_text('模型 A'); expect(details).to_contain_text('模型 B'); expect(details).to_contain_text('89')
            page.get_by_role('button', name='关闭模型详情', exact=True).click()
            page.get_by_role('button', name='模型编辑', exact=True).click()
            expect(page.get_by_role('heading', name='模型编辑空间', exact=True)).to_be_visible()
            page.go_back(); ready()
            assert pose() == [.5, -.25, .1, 0, 0, 45]
            expect(export).to_be_enabled()
            # A failed reload keeps the existing preview, but requires a successful
            # selection before entering the joint editor again.
            page.get_by_label('导入模型 B 文件', exact=True).set_input_files({'name': 'invalid.ply', 'buffer': b'invalid', 'mimeType': 'application/octet-stream'})
            expect(page.get_by_role('alert')).to_contain_text('有效')
            expect(export).to_be_disabled()
            expect(page.get_by_role('button', name='开始编辑', exact=True)).to_have_count(0)
            expect(page.get_by_label('模型 B 三维预览', exact=True)).to_have_attribute('data-render-state', 'ready')
            load('B', POINTS_B, FACES_B)
            start()
            assert pose() == [0] * 6
            expect(export).to_be_disabled()
            canvas.focus(); page.keyboard.press('Control+z'); assert pose() == [0] * 6

            for width, height in [(1024, 768), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height}); page.wait_for_timeout(150)
                assert page.locator('.model-editor__main').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                assert canvas.bounding_box()['height'] >= 300
                page.screenshot(path=f'/tmp/model-editor-pair-{width}.png')
            page.reload(wait_until='networkidle')
            expect(page.get_by_role('heading', name='双模型处理空间', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='加载模型 A', exact=True)).to_be_enabled()
            expect(page.get_by_role('button', name='加载模型 B', exact=True)).to_be_enabled()
            expect(export).to_be_disabled()
            assert not errors, errors
            print('two-model UI: hub/navigation, A/B loading, shared origin, numeric and real drag/rotate, fixed A, rotated envelope, replace/merge exports, undo/Esc, quality, native save, reimport and responsive layout passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
