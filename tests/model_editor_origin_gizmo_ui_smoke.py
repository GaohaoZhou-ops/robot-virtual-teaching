import json
import math

from playwright.sync_api import expect, sync_playwright

from model_editor_ui_smoke import BASE_URL, CHROME, read_export, start_model_download


FIELDS = ['X', 'Y', 'Z', 'roll', 'pitch', 'yaw']
POINTS = [(0, 0, 0), (2, 0, 0), (2, 1, 0), (0, 1, 0), (0, 0, 1.5), (2, 0, 1.5), (2, 1, 1.5), (0, 1, 1.5)]
FACES = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]


def fixture():
    header = 'ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n'
    return (header + ''.join(' '.join(map(str, point)) + '\n' for point in POINTS) + ''.join('3 ' + ' '.join(map(str, face)) + '\n' for face in FACES)).encode()


def transformed(point, origin):
    x, y, z, roll, pitch, yaw = origin
    r, p, a = [math.radians(value) for value in [roll, pitch, yaw]]
    cr, sr, cp, sp, ca, sa = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(a), math.sin(a)
    rotation = [[ca * cp, ca * sp * sr - sa * cr, ca * sp * cr + sa * sr], [sa * cp, sa * sp * sr + ca * cr, sa * sp * cr - ca * sr], [-sp, cp * sr, cp * cr]]
    offset = [point[0] - x, point[1] - y, point[2] - z]
    return [sum(rotation[row][column] * offset[row] for row in range(3)) for column in range(3)]


def distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_default_timeout(30000)
        page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
        page.get_by_label('导入模型文件', exact=True).set_input_files({'name': 'origin-gizmo-box.ply', 'mimeType': 'application/octet-stream', 'buffer': fixture()})
        editor = page.locator('[data-app-page="model-editor"]')
        canvas = page.get_by_label('模型编辑三维预览', exact=True)

        def ready():
            expect(editor).to_have_attribute('data-editor-state', 'ready')
            expect(canvas).to_have_attribute('data-render-state', 'ready')

        def origin():
            return [float(page.get_by_label(f'原点 {field}', exact=True).input_value()) for field in FIELDS]

        def camera():
            return [canvas.get_attribute(f'data-camera-{field}') for field in ['position', 'target', 'up']]

        def origin_screen():
            return json.loads(canvas.get_attribute('data-origin-screen-position'))

        def ground():
            return json.loads(canvas.get_attribute('data-ground-transform'))

        def assert_fixed(reference):
            assert distance(origin_screen(), reference) < 0.01, (origin_screen(), reference)
            assert ground() == initial_ground, 'The ground reference moved or changed scale while editing'

        def check_mode_switches():
            before_pose, before_camera = origin(), camera()
            for mode, label in [('translate', '移动模型'), ('view', '浏览视图'), ('rotate', '旋转模型'), ('translate', '移动模型'), ('rotate', '旋转模型'), ('view', '浏览视图')]:
                page.get_by_role('button', name=label, exact=True).click()
                expect(canvas).to_have_attribute('data-origin-edit-mode', mode)
                # Compare the actual rendered world matrix after the next frame.
                page.wait_for_timeout(50)
                assert ground() == initial_ground, (mode, ground(), initial_ground)
                assert origin() == before_pose and camera() == before_camera
            assert initial_ground[12:15] == [0, 0, 0], 'The ground must coincide with the world Z = 0 plane'


        def free_drag(dx=55, dy=25, button='left', release=True):
            box = canvas.bounding_box()
            x, y = box['x'] + box['width'] * 0.15, box['y'] + box['height'] * 0.18
            page.mouse.move(x, y)
            expect(canvas).to_have_attribute('data-origin-gizmo-axis', '')
            page.mouse.down(button=button)
            expect(canvas).to_have_attribute('data-origin-dragging', 'true')
            expect(canvas).to_have_attribute('data-origin-drag-kind', 'free')
            page.mouse.move(x + dx, y + dy, steps=12)
            if release:
                page.mouse.up(button=button)
                ready()

        def handle(axis):
            box = canvas.bounding_box()
            center = json.loads(canvas.get_attribute('data-origin-gizmo-center'))
            for radius in [28, 42, 56, 70, 84, 98, 112]:
                for degrees in range(0, 360, 15):
                    x = box['x'] + center[0] + radius * math.cos(math.radians(degrees))
                    y = box['y'] + center[1] + radius * math.sin(math.radians(degrees))
                    if not (box['x'] < x < box['x'] + box['width'] and box['y'] < y < box['y'] + box['height']):
                        continue
                    page.mouse.move(x, y)
                    if canvas.get_attribute('data-origin-gizmo-axis') == axis:
                        return x, y
            page.screenshot(path='/tmp/model-editor-missing-origin-handle.png')
            raise AssertionError(f'No real {axis} handle found')

        def start_drag(axis, dx=50, dy=-25):
            x, y = handle(axis)
            page.mouse.down()
            expect(canvas).to_have_attribute('data-origin-dragging', 'true')
            page.mouse.move(x + dx, y + dy, steps=12)

        def check_export(name):
            with page.expect_download() as event:
                start_model_download(page)
            path = f'/tmp/{name}.ply'
            event.value.save_as(path)
            ready()
            points, faces = read_export(path)
            assert len(points) == 8 and faces == 12
            for point, source in zip(points, POINTS):
                assert distance(point, transformed(source, origin())) < 1e-5, (point, origin())

        ready()
        expect(canvas).to_have_attribute('data-origin-gizmo-visible', 'false')
        initial_ground = ground()
        check_mode_switches()
        original_anchor = origin_screen()
        page.get_by_role('button', name='移动模型', exact=True).click()
        expect(canvas).to_have_attribute('data-origin-gizmo-visible', 'true')
        expect(canvas).to_have_attribute('data-origin-locked', 'true')
        expect(page.locator('.model-editor__interaction-mode')).to_have_attribute('data-base-mode', 'pan')
        assert_fixed(original_anchor)
        initial_camera = camera()
        initial_image = canvas.screenshot()
        start_drag('X')
        page.wait_for_timeout(400)  # Longer than the normal editing debounce.
        assert abs(origin()[0]) > 0.01
        assert max(abs(value) for value in origin()[1:]) < 1e-7
        expect(editor).to_have_attribute('data-editor-state', 'processing')
        expect(page.get_by_role('button', name='导出 PLY', exact=True)).to_be_disabled()
        assert camera() == initial_camera
        assert canvas.screenshot() != initial_image
        matrix = json.loads(canvas.get_attribute('data-model-transform'))
        assert abs(matrix[12]) > 0.01  # Immediate GPU transform before worker completion.
        page.mouse.up(); ready()
        assert camera() == initial_camera
        assert_fixed(original_anchor)
        matrix = json.loads(canvas.get_attribute('data-model-transform'))
        assert max(abs(value - (1 if index % 5 == 0 else 0)) for index, value in enumerate(matrix)) < 1e-8
        check_export('model-editor-gizmo-translate')

        # Any part of the canvas can move the model, without finding a handle.
        pivot_before = json.loads(canvas.get_attribute('data-origin-gizmo-center'))
        free_drag(dx=60, dy=-30)
        pivot_after = json.loads(canvas.get_attribute('data-origin-gizmo-center'))
        assert distance([pivot_after[0] - pivot_before[0], pivot_after[1] - pivot_before[1]], [60, -30]) < 0.1
        assert camera() == initial_camera
        assert_fixed(original_anchor)
        check_export('model-editor-direct-translate')

        # Numeric entries also position/orient the actual gizmo, including
        # non-commuting RPY; rotate around the model's center afterwards.
        for field, value in zip(FIELDS, [0.25, -0.5, 0.7, 23, -31, 47]):
            page.get_by_label(f'原点 {field}', exact=True).fill(str(value))
        ready()
        assert_fixed(original_anchor)
        # The rotated model now crosses Z = 0; browsing must not lower the
        # floor to its minimum Z or resize the reference to its new bounds.
        check_mode_switches()
        center = transformed((1, 0.5, 0.75), origin())
        assert distance(json.loads(canvas.get_attribute('data-model-pivot-position')), center) < 1e-7
        page.get_by_role('button', name='旋转模型', exact=True).click()
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'rotate')
        before = origin()
        start_drag('Z', dx=42, dy=25)
        assert distance(origin()[3:], before[3:]) > 0.1
        assert camera() == initial_camera
        page.mouse.up(); ready()
        assert distance(json.loads(canvas.get_attribute('data-model-pivot-position')), center) < 1e-7
        assert_fixed(original_anchor)
        check_export('model-editor-gizmo-rotate')

        # Free rotation keeps the model center and camera still and uses the
        # same angular sensitivity as the other pages' trackball gestures.
        rotation_before = json.loads(canvas.get_attribute('data-model-pivot-quaternion'))
        free_drag(dx=60, dy=45)
        rotation_after = json.loads(canvas.get_attribute('data-model-pivot-quaternion'))
        angle = 2 * math.acos(min(1, abs(sum(a * b for a, b in zip(rotation_before, rotation_after)))))
        assert abs(angle - 2 * 75 / canvas.evaluate('element => element.clientWidth') * 1.35) < 1e-5
        assert distance(json.loads(canvas.get_attribute('data-model-pivot-position')), center) < 1e-7
        assert camera() == initial_camera
        assert_fixed(original_anchor)
        check_export('model-editor-direct-rotate')
        page.screenshot(path='/tmp/model-editor-origin-gizmo.png')

        # Escape cancels the whole drag, restores its pose and exits to browsing.
        page.get_by_role('button', name='移动模型', exact=True).click()
        before = origin()
        start_drag('Y', dx=-45, dy=-30)
        assert distance(origin(), before) > 0.01
        page.keyboard.press('Escape'); page.mouse.up(); ready()
        assert origin() == before
        expect(canvas).to_have_attribute('data-origin-dragging', 'false')
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'view')

        page.get_by_role('button', name='移动模型', exact=True).click()
        free_drag(release=False)
        assert distance(origin(), before) > 0.01
        page.keyboard.press('Escape'); page.mouse.up(); ready()
        assert origin() == before
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'view')

        # Shift and right-button pan move the model in editing mode, including
        # over a handle; the world origin stays at exactly the same screen pixel.
        page.get_by_role('button', name='移动模型', exact=True).click()
        x, y = handle('X')
        camera_before_pan = camera()
        canvas.focus(); page.keyboard.down('Shift')
        page.mouse.down(); page.mouse.move(x + 55, y + 25, steps=8); page.mouse.up(); page.keyboard.up('Shift')
        ready()
        assert distance(origin(), before) > 0.01 and camera() == camera_before_pan
        assert origin()[3:] == before[3:]
        assert_fixed(original_anchor)
        expect(canvas).to_have_attribute('data-origin-dragging', 'false')
        expect(canvas).to_have_attribute('data-last-pointer-gesture', 'model-translate')
        before = origin()
        free_drag(button='right')
        assert distance(origin(), before) > 0.01 and origin()[3:] == before[3:]
        assert camera() == camera_before_pan
        assert_fixed(original_anchor)
        check_export('model-editor-direct-right-pan')

        # The canvas toggle follows the sidebar tool instead of changing the camera.
        page.locator('.model-editor__interaction-mode').click()
        expect(page.get_by_role('button', name='旋转模型', exact=True)).to_have_attribute('aria-pressed', 'true')
        before = origin()
        free_drag(release=False)
        rotated = origin()
        page.keyboard.down('Shift')
        box = canvas.bounding_box()
        page.mouse.move(box['x'] + box['width'] * 0.15 + 100, box['y'] + box['height'] * 0.18 + 50, steps=8)
        page.mouse.up(); page.keyboard.up('Shift'); ready()
        assert distance(rotated[3:], before[3:]) > 0.1
        assert origin()[3:] == rotated[3:] and distance(origin()[:3], rotated[:3]) > 0.01
        assert_fixed(original_anchor)
        assert camera() == initial_camera

        # Zoom remains usable while preserving the fixed origin on screen.
        before = origin()
        distance_before = float(canvas.get_attribute('data-effective-camera-distance'))
        page.mouse.wheel(0, -120)
        page.wait_for_timeout(100)
        assert float(canvas.get_attribute('data-effective-camera-distance')) < distance_before
        assert origin() == before
        assert_fixed(original_anchor)

        comparison_camera = camera()
        page.get_by_role('button', name='原始模型', exact=True).click()
        expect(canvas).to_have_attribute('data-original-visible', 'true')
        expect(canvas).to_have_attribute('data-origin-locked', 'true')
        expect(canvas).to_have_attribute('data-origin-gizmo-visible', 'true')
        expect(page.get_by_role('button', name='旋转模型', exact=True)).to_have_attribute('aria-pressed', 'true')
        assert origin() == before
        assert camera() == comparison_camera
        original_transform = canvas.get_attribute('data-original-transform')
        free_drag(release=False)
        assert origin() != before
        assert canvas.get_attribute('data-original-transform') == original_transform
        page.mouse.up(); ready()
        assert camera() == comparison_camera
        assert_fixed(original_anchor)
        check_export('model-editor-ghost-drag')
        canvas.focus(); page.keyboard.press('Control+z'); ready()
        assert origin() == before
        expect(canvas).to_have_attribute('data-original-visible', 'true')
        # Escape closes model details without also leaving the active edit tool.
        page.get_by_role('button', name='模型详情', exact=True).click()
        page.keyboard.press('Escape')
        expect(page.get_by_role('dialog', name='模型详情', exact=True)).to_have_count(0)
        expect(canvas).to_have_attribute('data-origin-edit-mode', 'rotate')
        page.get_by_label('显示质量', exact=True).select_option('performance')
        expect(canvas).to_have_attribute('data-display-quality', 'performance')
        expect(canvas).to_have_attribute('data-original-quality', 'performance')
        ready()
        assert origin() == before
        assert ground() == initial_ground
        page.get_by_role('button', name='继续编辑', exact=True).click()
        expect(canvas).to_have_attribute('data-original-visible', 'false')
        page.get_by_role('button', name='归零', exact=True).click(); ready()
        assert origin() == [0] * 6
        check_export('model-editor-gizmo-reset')
        page.set_viewport_size({'width': 1024, 'height': 768})
        page.screenshot(path='/tmp/model-editor-origin-gizmo-1024.png')

        # Browsing restores camera gestures and leaves the origin parameters alone.
        page.get_by_role('button', name='浏览视图', exact=True).click()
        expect(canvas).to_have_attribute('data-origin-locked', 'false')
        before_camera = camera()
        box = canvas.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y); page.mouse.down()
        page.mouse.move(x + 60, y + 40, steps=8); page.mouse.up()
        page.wait_for_timeout(80)
        assert camera() != before_camera and origin() == [0] * 6

        # A model far from (0, 0, 0) must bring the origin into view on entry.
        page.get_by_label('原点 X', exact=True).fill('100'); ready()
        page.get_by_role('button', name='适应模型视图', exact=True).click()
        page.wait_for_timeout(80)
        assert not (0 < origin_screen()[0] < box['width'] and 0 < origin_screen()[1] < box['height'])
        page.get_by_role('button', name='移动模型', exact=True).click()
        expect(canvas).to_have_attribute('data-origin-locked', 'true')
        page.wait_for_timeout(80)
        anchor = origin_screen()
        assert distance(anchor, [box['width'] / 2, box['height'] / 2]) < 1
        assert origin() == [100, 0, 0, 0, 0, 0]
        free_drag()
        assert_fixed(anchor)
        assert not errors, errors
        browser.close()
        print('origin editing: stable Z=0 ground across all mode switches, fixed screen origin, direct model/handle drags, Shift/right pan, zoom, numeric sync, full exports, Escape, offscreen origin recovery and browse navigation passed')


if __name__ == '__main__':
    run()
