"""Exercise editor shortcuts with real keyboard input, drags and PLY exports."""
from playwright.sync_api import expect, sync_playwright

from model_editor_origin_gizmo_ui_smoke import FIELDS, POINTS, distance, fixture, transformed
from model_editor_ui_smoke import BASE_URL, CHROME, read_export


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
        picker = page.get_by_label('导入模型文件', exact=True)
        picker.set_input_files({'name': 'shortcuts-box.ply', 'mimeType': 'application/octet-stream', 'buffer': fixture()})
        editor = page.locator('[data-app-page="model-editor"]')
        canvas = page.get_by_label('模型编辑三维预览', exact=True)

        def ready():
            expect(editor).to_have_attribute('data-editor-state', 'ready')
            expect(canvas).to_have_attribute('data-render-state', 'ready')

        def origin():
            return [float(page.get_by_label(f'原点 {field}', exact=True).input_value()) for field in FIELDS]

        def view_reference():
            return [canvas.get_attribute(f'data-{field}') for field in ['camera-position', 'camera-target', 'camera-up', 'ground-transform']]

        def drag(mode='移动模型', dx=65, dy=-25, release=True):
            page.get_by_role('button', name=mode, exact=True).click()
            box = canvas.bounding_box()
            x, y = box['x'] + box['width'] * 0.15, box['y'] + box['height'] * 0.18
            page.mouse.move(x, y)
            expect(canvas).to_have_attribute('data-origin-gizmo-axis', '')
            page.mouse.down()
            page.mouse.move(x + dx, y + dy, steps=16)
            expect(canvas).to_have_attribute('data-origin-dragging', 'true')
            if release:
                page.mouse.up(); ready()

        def undo(shortcut='Control+z'):
            page.keyboard.press(shortcut)
            ready()

        def check_export(name):
            with page.expect_download() as event:
                page.get_by_role('button', name='导出 PLY', exact=True).click()
            path = f'/tmp/{name}.ply'
            event.value.save_as(path); ready()
            points, faces = read_export(path)
            assert len(points) == 8 and faces == 12
            for actual, source in zip(points, POINTS):
                assert distance(actual, transformed(source, origin())) < 1e-5

        ready()
        reference = view_reference()
        for mode in ['移动模型', '旋转模型']:
            page.get_by_role('button', name=mode, exact=True).click()
            page.keyboard.press('Escape')
            expect(page.get_by_role('button', name='浏览视图', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(canvas).to_have_attribute('data-origin-gizmo-visible', 'false')
            expect(canvas).to_have_attribute('data-origin-locked', 'false')
            assert origin() == [0] * 6 and view_reference() == reference

        # Each complete drag is one undo step, including rotation, even when
        # many pointer events and worker preview updates have occurred.
        drag(); first = origin()
        drag('旋转模型', dx=50, dy=35); second = origin()
        assert distance(first, second) > 0.01
        page.keyboard.press('Escape')
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'view')
        assert origin() == second  # Exiting a tool keeps completed edits.
        undo(); assert origin() == first
        check_export('model-editor-shortcut-undo-rotate')
        canvas.focus(); undo('Meta+z'); assert origin() == [0] * 6
        undo(); assert origin() == [0] * 6
        assert view_reference() == reference

        # Cancelled and zero-motion drags must not consume undo history.
        drag(); first = origin()
        drag('旋转模型', release=False)
        page.keyboard.press('Escape'); page.mouse.up(); ready()
        assert origin() == first
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'view')
        undo(); assert origin() == [0] * 6
        drag(); first = origin()
        drag(dx=0, dy=0)
        undo(); assert origin() == [0] * 6

        # Ctrl+Z during a drag cancels that gesture; the next press undoes the
        # previous completed operation. The edit tool remains selected.
        drag(); first = origin()
        drag('旋转模型', release=False)
        undo(); page.mouse.up()
        assert origin() == first
        expect(canvas).to_have_attribute('data-origin-dragging', 'false')
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'rotate')
        undo(); assert origin() == [0] * 6
        page.keyboard.press('Escape')

        # Multiple keystrokes in one numeric edit undo together, including
        # Ctrl+Z while the input still has focus and a later edit in that field.
        field = page.get_by_label('原点 X', exact=True)
        field.fill(''); field.press_sequentially('1.25'); ready()
        undo(); expect(field).to_have_value('0')
        field.fill(''); field.press_sequentially('2.5'); ready()
        undo(); expect(field).to_have_value('0')
        field.fill('')
        expect(editor).to_have_attribute('data-editor-state', 'error')
        undo(); expect(field).to_have_value('0')
        expect(page.get_by_role('alert')).to_have_count(0)
        field.fill('0.25'); field.press('Enter'); ready()
        field.fill('0.5'); field.press('Enter'); ready()
        undo(); expect(field).to_have_value('0.25')
        undo(); expect(field).to_have_value('0')

        # Undo covers crop/simplification settings and resets as single edits.
        crop = page.get_by_label('启用模型裁剪')
        crop.check(); ready()
        lower = page.get_by_label('裁剪 X 下限', exact=True)
        lower.fill('0.5'); ready()
        undo(); expect(lower).to_have_value('0')
        canvas.focus(); undo(); expect(crop).not_to_be_checked()
        reduction = page.get_by_label('降采样方式', exact=True)
        reduction.select_option('voxel'); ready()
        voxel = page.get_by_label('体素尺寸', exact=True)
        voxel_before = voxel.input_value()
        voxel.fill('0'); expect(editor).to_have_attribute('data-editor-state', 'error')
        undo(); expect(voxel).to_have_value(voxel_before)
        canvas.focus(); undo(); expect(reduction).to_have_value('none')
        field.fill('0.25'); canvas.focus(); ready()
        crop.check(); ready()
        page.get_by_role('button', name='重置全部', exact=True).click(); ready()
        assert origin() == [0] * 6
        undo(); expect(field).to_have_value('0.25'); expect(crop).to_be_checked()
        undo(); expect(crop).not_to_be_checked()
        undo(); assert origin() == [0] * 6
        check_export('model-editor-shortcut-undo-parameters')

        # Undo can supersede a worker edit before its result has arrived.
        field.fill('0.2'); canvas.focus()
        field.fill('0.4'); canvas.focus()
        page.wait_for_timeout(285)
        page.keyboard.press('Control+z'); page.keyboard.press('Control+z'); ready()
        assert origin() == [0] * 6
        check_export('model-editor-shortcut-undo-pending')

        # Preview controls and mode changes do not replace edit history.
        field.fill('0.25'); canvas.focus(); ready()
        page.get_by_label('显示质量', exact=True).select_option('performance'); ready()
        page.get_by_role('button', name='移动模型', exact=True).click()
        field.focus(); page.keyboard.press('Escape')
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'view')
        undo(); assert origin() == [0] * 6
        expect(page.get_by_label('显示质量', exact=True)).to_have_value('performance')

        # Returning home keeps edit history; successfully loading a new model
        # starts a new history so Undo cannot apply another file's settings.
        drag(); first = origin()
        page.keyboard.press('Escape')
        page.get_by_role('button', name='主页面', exact=True).click()
        page.get_by_role('button', name='模型编辑', exact=True).click(); ready()
        assert origin() == first
        undo(); assert origin() == [0] * 6
        drag(); page.keyboard.press('Escape')
        picker.set_input_files({'name': 'new-shortcuts-box.ply', 'mimeType': 'application/octet-stream', 'buffer': fixture()})
        ready(); canvas.focus(); undo()
        assert origin() == [0] * 6
        check_export('model-editor-shortcut-new-file')
        assert not errors, errors
        browser.close()
        print('editor shortcuts: Escape exits/cancels, grouped drag/parameter undo, Ctrl+Z/Cmd+Z, repeated undo, invalid/pending edits, reset, exports and per-file history passed')


if __name__ == '__main__':
    run()
