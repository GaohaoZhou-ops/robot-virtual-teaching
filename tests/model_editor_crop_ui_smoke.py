"""Exercise confirmed inside/outside cropping, six face handles and orange ghosts."""
import json
from playwright.sync_api import expect, sync_playwright
from model_editor_origin_gizmo_ui_smoke import fixture
from model_editor_ui_smoke import BASE_URL, CHROME, FIXTURES, read_export, start_model_download


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
            page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
            picker = page.get_by_label('导入模型文件', exact=True)
            picker.set_input_files({'name': 'crop-box.ply', 'buffer': fixture(), 'mimeType': 'application/octet-stream'})
            editor = page.locator('[data-app-page="model-editor"]')
            canvas = page.get_by_label('模型编辑三维预览', exact=True)
            confirm = page.get_by_role('button', name='确定裁剪', exact=True)
            export = page.get_by_role('button', name='导出 PLY', exact=True)
            crop_toggle = page.get_by_label('启用模型裁剪')
            inside, outside = [page.get_by_role('radio', name=name, exact=True) for name in ['取内', '取外']]

            def ready():
                expect(editor).to_have_attribute('data-editor-state', 'ready')
                expect(canvas).to_have_attribute('data-render-state', 'ready')

            def bounds():
                return {f'{axis}-{edge}': float(page.get_by_label(f'裁剪 {axis.upper()} {label}', exact=True).input_value())
                        for axis in 'xyz' for edge, label in [('min', '下限'), ('max', '上限')]}

            def camera():
                return [canvas.get_attribute(f'data-{field}') for field in ['camera-position', 'camera-target', 'camera-up', 'ground-transform']]

            def drag_handle(name, release=True):
                page.wait_for_timeout(50)
                handle = json.loads(canvas.get_attribute('data-crop-handles'))[name]
                rect = canvas.bounding_box()
                x, y = rect['x'] + handle['x'], rect['y'] + handle['y']
                page.mouse.move(x, y)
                expect(canvas).to_have_attribute('data-crop-handle', name)
                page.mouse.down()
                expect(canvas).to_have_attribute('data-crop-dragging', 'true')
                page.mouse.move(x + 25, y + 18, steps=12)
                if release:
                    page.mouse.up(); ready()

            def download(name):
                with page.expect_download() as event:
                    start_model_download(page)
                path = f'/tmp/model-editor-crop-{name}.ply'
                event.value.save_as(path); ready()
                return read_export(path)

            def close_applied_crop(expected_export, name):
                previous_camera = camera()
                previous_counts = [editor.get_attribute(f'data-model-{kind}-count') for kind in ['point', 'face']]
                previous_preview = [canvas.get_attribute(f'data-preview-{kind}') for kind in ['points', 'faces']]
                edit_count = page.evaluate('window.__cropEdits')
                crop_toggle.uncheck(); ready()
                expect(editor).to_have_attribute('data-crop-state', 'applied')
                expect(canvas).to_have_attribute('data-crop-box-visible', 'false')
                expect(canvas).to_have_attribute('data-crop-preview', 'false')
                expect(canvas).to_have_attribute('data-removed-visible', 'true')
                expect(confirm).to_be_disabled(); expect(export).to_be_enabled()
                expect(page.get_by_label('裁剪 X 上限', exact=True)).to_be_disabled()
                expect(inside).to_be_disabled(); expect(outside).to_be_disabled()
                page.wait_for_timeout(350)
                assert page.evaluate('window.__cropEdits') == edit_count
                assert [editor.get_attribute(f'data-model-{kind}-count') for kind in ['point', 'face']] == previous_counts
                assert [canvas.get_attribute(f'data-preview-{kind}') for kind in ['points', 'faces']] == previous_preview
                assert camera() == previous_camera
                assert download(name) == expected_export

            ready()
            expect(page.get_by_text('拖动六面手柄调整长宽高，橘黄色虚影为裁掉部分。', exact=True)).to_have_count(0)
            # Let the initial post-load edit settle before counting draft requests.
            page.wait_for_timeout(400); ready()
            initial_camera = camera()
            page.evaluate('''() => {
                window.__cropEdits = 0;
                const post = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function(message, ...args) {
                    if (message.type === 'edit') window.__cropEdits++;
                    return post.call(this, message, ...args);
                };
            }''')
            crop_toggle.check()
            expect(canvas).to_have_attribute('data-crop-box-visible', 'true')
            expect(inside).to_be_checked(); expect(outside).not_to_be_checked()
            page.get_by_label('裁剪 X 上限', exact=True).fill('1')
            page.wait_for_timeout(350)
            assert page.evaluate('window.__cropEdits') == 0
            expect(editor).to_have_attribute('data-model-point-count', '8')
            expect(editor).to_have_attribute('data-model-face-count', '12')
            expect(editor).to_have_attribute('data-crop-state', 'draft')
            expect(export).to_be_disabled(); expect(confirm).to_be_enabled()
            expect(canvas).to_have_attribute('data-removed-color', 'ffa12f')
            assert 0 < float(canvas.get_attribute('data-removed-opacity')) < 1
            page.screenshot(path='/tmp/model-editor-crop-inside-review.png')
            outside.check(); expect(inside).not_to_be_checked(); expect(outside).to_be_checked()
            page.wait_for_timeout(100)
            page.screenshot(path='/tmp/model-editor-crop-outside-review.png')
            assert camera() == initial_camera
            assert page.evaluate('window.__cropEdits') == 0
            confirm.click(); ready()
            expect(editor).to_have_attribute('data-crop-state', 'applied')
            points, faces = download('outside')
            assert faces > 0 and all(point[0] >= 1 - 1e-6 for point in points)
            expect(canvas).to_have_attribute('data-removed-visible', 'true')

            # Undo confirmation restores the previous result and leaves the box editable.
            canvas.focus(); page.keyboard.press('Control+z'); ready()
            expect(editor).to_have_attribute('data-crop-state', 'draft')
            expect(editor).to_have_attribute('data-model-point-count', '8')
            expect(outside).to_be_checked()
            inside.check(); confirm.click(); ready()
            points, faces = download('inside')
            assert faces > 0 and all(point[0] <= 1 + 1e-6 for point in points)

            # Closing the tool keeps the confirmed geometry, ghost and exported data.
            close_applied_crop((points, faces), 'inside-closed')
            crop_toggle.check()
            expect(canvas).to_have_attribute('data-crop-box-visible', 'true')
            expect(editor).to_have_attribute('data-crop-state', 'applied')
            expect(page.get_by_label('裁剪 X 上限', exact=True)).to_have_value('1')
            expect(inside).to_be_checked(); expect(confirm).to_be_disabled()
            page.get_by_label('裁剪 X 上限', exact=True).fill('0.75')
            outside.check()
            expect(editor).to_have_attribute('data-crop-state', 'draft')
            crop_toggle.uncheck(); ready()
            expect(editor).to_have_attribute('data-crop-state', 'applied')
            expect(canvas).to_have_attribute('data-crop-preview', 'false')
            assert download('discarded-draft') == (points, faces)
            crop_toggle.check()
            expect(inside).to_be_checked(); expect(confirm).to_be_disabled()
            expect(page.get_by_label('裁剪 X 上限', exact=True)).to_have_value('1')

            # Each real face drag changes only that bound, and never the camera or origin.
            fixed_camera = camera()
            for name in ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max']:
                before = bounds(); drag_handle(name); after = bounds()
                assert abs(after[name] - before[name]) > 1e-5, (name, before, after)
                assert all(after[key] == before[key] for key in before if key != name)
                assert camera() == fixed_camera
                expect(editor).to_have_attribute('data-crop-state', 'draft')
                canvas.focus(); page.keyboard.press('Control+z'); ready()
                assert bounds() == before
                expect(editor).to_have_attribute('data-crop-state', 'applied')
            before = bounds(); drag_handle('x-max', release=False)
            page.keyboard.press('Escape'); page.mouse.up(); ready()
            assert bounds() == before
            expect(canvas).to_have_attribute('data-crop-dragging', 'false')
            expect(editor).to_have_attribute('data-crop-state', 'applied')

            # Both references coexist, follow quality, and remain absent from export.
            page.get_by_role('button', name='原始模型', exact=True).click()
            expect(canvas).to_have_attribute('data-original-visible', 'true')
            expect(canvas).to_have_attribute('data-original-color', '8bbdce')
            expect(canvas).to_have_attribute('data-removed-color', 'ffa12f')
            page.get_by_label('显示质量', exact=True).select_option('performance'); ready()
            expect(canvas).to_have_attribute('data-removed-quality', 'performance')
            expect(canvas).to_have_attribute('data-original-quality', 'performance')
            assert camera() == fixed_camera
            page.screenshot(path='/tmp/model-editor-crop-both-ghosts.png')

            # Invalid drafts do not touch the applied result; an empty outside crop can recover.
            page.get_by_label('裁剪 X 下限', exact=True).fill('3')
            expect(page.get_by_role('alert')).to_contain_text('下限不能大于上限')
            expect(confirm).to_be_disabled(); expect(export).to_be_disabled()
            crop_toggle.uncheck(); ready()
            expect(page.get_by_role('alert')).to_have_count(0)
            expect(editor).to_have_attribute('data-crop-state', 'applied')
            expect(export).to_be_enabled()
            crop_toggle.check()
            page.get_by_role('button', name='使用变换后完整范围', exact=True).click()
            outside.check(); confirm.click(); ready()
            expect(editor).to_have_attribute('data-model-point-count', '0')
            expect(canvas).to_have_attribute('data-removed-visible', 'true')
            crop_toggle.uncheck(); ready()
            expect(editor).to_have_attribute('data-model-point-count', '0')
            expect(editor).to_have_attribute('data-crop-state', 'applied')
            expect(canvas).to_have_attribute('data-crop-box-visible', 'false')
            expect(export).to_be_disabled()
            crop_toggle.check()
            page.get_by_label('裁剪 X 上限', exact=True).fill('1')
            confirm.click(); ready()
            points, faces = download('recovered')
            assert all(point[0] >= 1 - 1e-6 for point in points)
            close_applied_crop((points, faces), 'outside-closed')

            # Point clouds use the same preview and confirmation flow, with an enclosing box.
            picker.set_input_files(str(FIXTURES / 'rotation-map.ply')); ready()
            expect(canvas).to_have_attribute('data-crop-box-visible', 'false')
            expect(canvas).to_have_attribute('data-original-visible', 'false')
            crop_toggle.check()
            page.get_by_label('裁剪 X 上限', exact=True).fill('1')
            expect(canvas).to_have_attribute('data-removed-points', '24')
            crop_toggle.uncheck(); ready()
            expect(editor).to_have_attribute('data-crop-state', 'disabled')
            expect(editor).to_have_attribute('data-model-point-count', '24')
            expect(canvas).to_have_attribute('data-removed-visible', 'false')
            expect(canvas).to_have_attribute('data-crop-box-visible', 'false')
            expect(export).to_be_enabled()
            crop_toggle.check()
            page.get_by_label('裁剪 X 上限', exact=True).fill('1')
            confirm.click(); ready()
            points, faces = download('points')
            assert 0 < len(points) < 24 and faces == 0 and all(point[0] <= 1 for point in points)
            close_applied_crop((points, faces), 'points-closed')
            assert not errors, errors
            print('crop UI: six real face drags, numeric sync, draft/confirm, inside/outside, orange and blue ghosts, undo/cancel, quality, closing/reopening tools, discarded drafts, empty recovery and full exports passed')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
