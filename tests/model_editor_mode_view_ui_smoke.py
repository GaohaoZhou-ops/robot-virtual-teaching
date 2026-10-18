"""Tool switches preserve a customized view even when the origin is off screen."""
import json
import math

from playwright.sync_api import expect, sync_playwright
from model_editor_ui_smoke import BASE_URL, CHROME
from model_pair_editor_ui_smoke import POINTS_A, POINTS_B, FACES_B, fixture


def check_workspace(page, dual):
    page.goto(f'{BASE_URL}/model-editor' + ('/dual' if dual else ''), wait_until='networkidle')
    payload = {'name': 'view-switch-box.ply', 'buffer': fixture(POINTS_B, FACES_B), 'mimeType': 'application/octet-stream'}
    if dual:
        page.get_by_label('导入模型 A 文件', exact=True).set_input_files({**payload, 'buffer': fixture(POINTS_A)})
        page.get_by_label('导入模型 B 文件', exact=True).set_input_files(payload)
        page.get_by_role('button', name='开始编辑', exact=True).click()
    else:
        page.get_by_label('导入模型文件', exact=True).set_input_files(payload)
    editor = page.locator(f'[data-app-page="{"model-pair-editor" if dual else "model-editor"}"]')
    canvas = page.get_by_label('模型编辑三维预览', exact=True)
    field_names = [f'模型 B {field}' for field in ['X', 'Y', 'Z', 'ROLL', 'PITCH', 'YAW']] if dual else [f'原点 {field}' for field in ['X', 'Y', 'Z', 'roll', 'pitch', 'yaw']]

    def rendered():
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')

    def ready():
        expect(editor).to_have_attribute('data-editor-state', 'ready')
        expect(canvas).to_have_attribute('data-render-state', 'ready')
        rendered()

    def pose():
        return [float(page.get_by_label(name, exact=True).input_value()) for name in field_names]

    def view():
        return {key: json.loads(canvas.get_attribute(f'data-{key}')) for key in [
            'camera-position', 'camera-target', 'camera-up', 'camera-distance',
            'optical-zoom', 'effective-camera-distance', 'precision-pan-x', 'precision-pan-y',
            'origin-screen-position', 'ground-transform']}

    def assert_view(before, context):
        for key, expected in before.items():
            actual = view()[key]
            if isinstance(expected, list):
                assert all(math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-8) for a, b in zip(actual, expected)), (dual, context, key, actual, expected)
            else:
                assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-8), (dual, context, key, actual, expected)

    def drag(button, start_x, dx, dy):
        box = canvas.bounding_box()
        x, y = box['x'] + box['width'] * start_x, box['y'] + box['height'] * .3
        page.mouse.move(x, y); page.mouse.down(button=button)
        page.mouse.move(x + dx, y + dy, steps=12); page.mouse.up(button=button)
        rendered()

    ready()
    page.get_by_role('button', name='俯视', exact=True).click()
    drag('left', .4, 55, 30)
    for detail in [False, True]:
        if detail:
            # Reframing is still available as an explicit action. At high zoom,
            # panning uses a projection offset that a tool switch must also retain.
            before = view()
            page.get_by_role('button', name='适应模型视图', exact=True).click(); rendered()
            assert view() != before
            box = canvas.bounding_box()
            page.mouse.move(box['x'] + box['width'] * .5, box['y'] + box['height'] * .4)
            for _ in range(60):
                page.mouse.wheel(0, -160); rendered()
                if float(canvas.get_attribute('data-optical-zoom')) > 2:
                    break
            assert float(canvas.get_attribute('data-optical-zoom')) > 2
        box = canvas.bounding_box()
        drag('right', .15, box['width'] * .7, 20)
        x, y = view()['origin-screen-position']
        assert not (0 <= x <= box['width'] and 0 <= y <= box['height']), 'The test must put the origin off screen'
        if detail:
            expect(canvas).to_have_attribute('data-pan-implementation', 'precision-offset')
            assert abs(view()['precision-pan-x']) > 1
        before_view, before_pose = view(), pose()
        for mode, label in [('translate', '移动模型'), ('rotate', '旋转模型'), ('view', '浏览视图'),
                            ('rotate', '旋转模型'), ('translate', '移动模型'), ('view', '浏览视图')]:
            page.get_by_role('button', name=label, exact=True).click()
            expect(canvas).to_have_attribute('data-origin-edit-mode', mode); rendered()
            assert_view(before_view, f'{"optical" if detail else "normal"}: {mode}')
            assert pose() == before_pose
        # Moving the model remains usable without recentering the camera; undo
        # and Escape return to the same model pose and view.
        page.get_by_role('button', name='移动模型', exact=True).click(); rendered()
        drag('left', .08, 35, 22); ready()
        assert pose() != before_pose
        assert_view(before_view, 'model drag')
        canvas.focus(); page.keyboard.press('Control+z'); ready()
        assert pose() == before_pose
        page.keyboard.press('Escape')
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'view'); rendered()
        assert_view(before_view, 'undo and Escape')


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            for dual in [False, True]:
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                page.set_default_timeout(30000)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                check_workspace(page, dual)
                assert not errors, errors
                page.close()
            print('view switching: single/dual editors retain off-screen origin, camera orientation/position/zoom, precision pan and ground across move/rotate/view, real model drag, undo and Escape; explicit fit remains usable')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
