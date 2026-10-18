import hashlib
import json
import math
import struct

from playwright.sync_api import expect, sync_playwright

from model_editor_ui_smoke import BASE_URL, CHROME, FIXTURES, read_export


def distance(left, right):
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right)))


def point_cloud(count):
    header = f'ply\nformat binary_little_endian 1.0\nelement vertex {count}\nproperty float x\nproperty float y\nproperty float z\nend_header\n'.encode()
    body = bytearray(count * 12)
    for index in range(count):
        struct.pack_into('<fff', body, index * 12, (index % 500) / 100, (index // 500) / 100, (index % 13) / 100)
    return header + body


def dense_mesh(side=400):
    vertices, faces = (side + 1) ** 2, side * side * 2
    header = f'ply\nformat binary_little_endian 1.0\nelement vertex {vertices}\nproperty float x\nproperty float y\nproperty float z\nelement face {faces}\nproperty list uchar int vertex_indices\nend_header\n'.encode()
    body = bytearray(vertices * 12 + faces * 13)
    for y in range(side + 1):
        for x in range(side + 1):
            struct.pack_into('<fff', body, (y * (side + 1) + x) * 12, x / 100, y / 100, 0)
    offset = vertices * 12
    for y in range(side):
        for x in range(side):
            a = y * (side + 1) + x
            struct.pack_into('<BiiiBiii', body, offset, 3, a, a + 1, a + side + 2, 3, a, a + side + 2, a + side + 1)
            offset += 26
    return header + body, vertices, faces


def run():
    with sync_playwright() as playwright:
        options = {'headless': True}
        if CHROME.exists():
            options['executable_path'] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.set_default_timeout(30_000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'{BASE_URL}/model-editor', wait_until='networkidle')
        picker = page.get_by_label('导入模型文件', exact=True)
        picker.set_input_files(str(FIXTURES / 'rotation-map.ply'))
        editor = page.locator('[data-app-page="model-editor"]')
        canvas = page.get_by_label('模型编辑三维预览', exact=True)
        quality = page.get_by_label('显示质量', exact=True)

        def ready():
            expect(editor).to_have_attribute('data-editor-state', 'ready')
            expect(canvas).to_have_attribute('data-render-state', 'ready')

        def camera():
            return {name: json.loads(canvas.get_attribute(f'data-camera-{name}')) for name in ['position', 'target', 'up', 'distance']}

        def drag(button, dx, dy):
            rect = canvas.bounding_box()
            x, y = rect['x'] + rect['width'] * 0.5, rect['y'] + rect['height'] * 0.5
            page.mouse.move(x, y)
            page.mouse.down(button=button)
            page.mouse.move(x + dx, y + dy, steps=16)
            page.mouse.up(button=button)

        def select_quality(value):
            quality.select_option(value)
            expect(canvas).to_have_attribute('data-display-quality', value)
            ready()

        ready()
        # Let the on-demand renderer settle before real mouse input.
        page.wait_for_timeout(200)
        original = camera()
        image_before = hashlib.sha256(canvas.screenshot()).hexdigest()
        drag('left', 145, 65)
        expect(canvas).not_to_have_attribute('data-camera-position', json.dumps(original['position'], separators=(',', ':')))
        page.wait_for_timeout(150)
        rotated = camera()
        assert distance(rotated['position'], original['position']) > 0.1
        assert distance(rotated['target'], original['target']) < 1e-6
        assert abs(rotated['distance'] - original['distance']) < 1e-6
        assert hashlib.sha256(canvas.screenshot()).hexdigest() != image_before
        assert page.locator('.model-editor__directions button[aria-pressed="true"]').count() == 0

        drag('right', 70, -35)
        page.wait_for_function('old => document.querySelector(".model-editor__viewport canvas").dataset.cameraTarget !== old', arg=json.dumps(rotated['target'], separators=(',', ':')))
        panned = camera()
        assert distance(panned['target'], rotated['target']) > 0.01
        assert abs(panned['distance'] - rotated['distance']) < 1e-6
        page.mouse.wheel(0, -350)
        page.wait_for_function('old => Number(document.querySelector(".model-editor__viewport canvas").dataset.cameraDistance) < old', arg=panned['distance'])
        zoomed = camera()
        assert distance(zoomed['target'], panned['target']) < 1e-6
        page.get_by_role('button', name='俯视', exact=True).click()
        page.wait_for_timeout(100)
        top = camera()
        assert abs(top['position'][0] - top['target'][0]) < 1e-6
        assert abs(top['position'][1] - top['target'][1]) < 1e-6
        drag('left', -85, 50)
        page.wait_for_timeout(100)
        assert distance(camera()['position'], top['position']) > 0.1

        point_size = page.get_by_label('点大小', exact=True)
        point_size.press('End')
        expect(canvas).to_have_attribute('data-point-size', '8')
        assert page.get_by_label('原点 yaw', exact=True).input_value() == '0'

        # A real cloud above the display budgets proves quality changes geometry
        # sent to the renderer, while full export and editing statistics stay fixed.
        count = 200001
        picker.set_input_files({'name': 'display-cloud.ply', 'mimeType': 'application/octet-stream', 'buffer': point_cloud(count)})
        ready()
        balanced = int(canvas.get_attribute('data-preview-points'))
        assert balanced <= 160000 < count
        select_quality('performance')
        assert int(canvas.get_attribute('data-preview-points')) <= 80000 < balanced
        drag('left', 80, -40)
        page.wait_for_timeout(100)
        user_camera = camera()
        select_quality('full')
        expect(canvas).to_have_attribute('data-preview-points', str(count))
        assert all(distance(camera()[key], user_camera[key]) < 1e-6 for key in ['position', 'target', 'up'])
        expect(page.locator('[data-model-point-count]')).to_have_attribute('data-model-point-count', str(count))
        select_quality('detail')
        expect(canvas).to_have_attribute('data-preview-points', str(count))
        page.get_by_role('button', name='原始模型', exact=True).click()
        expect(canvas).to_have_attribute('data-display-quality', 'detail')
        expect(canvas).to_have_attribute('data-preview-points', str(count))
        select_quality('performance')
        page.get_by_role('button', name='编辑结果', exact=True).click()
        expect(canvas).to_have_attribute('data-display-quality', 'performance')
        expect(page.get_by_label('降采样方式', exact=True)).to_have_value('none')
        ready()
        with page.expect_download() as download:
            page.get_by_role('button', name='导出 PLY', exact=True).click()
        export_path = '/tmp/model-editor-display-full-export.ply'
        download.value.save_as(export_path)
        points, faces = read_export(export_path)
        assert len(points) == count and faces == 0
        ready()
        page.get_by_role('button', name='关闭提示').click()
        page.screenshot(path='/tmp/model-editor-display-controls.png', full_page=True)

        mesh, vertices, face_count = dense_mesh()
        picker.set_input_files({'name': 'display-mesh.ply', 'mimeType': 'application/octet-stream', 'buffer': mesh})
        ready()
        expect(canvas).to_have_attribute('data-preview-faces', '180000')
        select_quality('full')
        expect(canvas).to_have_attribute('data-preview-faces', str(face_count))
        expect(page.locator('[data-model-face-count]')).to_have_attribute('data-model-face-count', str(face_count))
        expect(page.locator('[data-model-point-count]')).to_have_attribute('data-model-point-count', str(vertices))
        select_quality('balanced')
        expect(canvas).to_have_attribute('data-preview-faces', str(face_count))
        page.set_viewport_size({'width': 1024, 'height': 768})
        page.wait_for_timeout(200)
        expect(quality).to_be_visible()
        rect = quality.bounding_box()
        assert rect['x'] + rect['width'] <= 1024
        page.screenshot(path='/tmp/model-editor-display-1024.png', full_page=True)
        assert not errors, errors
        browser.close()
        print('model editor viewport: real rotation, pan, wheel zoom, point size, quality budgets, camera preservation, full export, and mesh quality passed')


if __name__ == '__main__':
    run()
