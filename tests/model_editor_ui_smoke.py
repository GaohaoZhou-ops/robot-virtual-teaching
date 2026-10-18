import hashlib
import math
import os
import struct
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
FIXTURES = Path(__file__).parent / 'fixtures'
CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def start_model_download(page, name=None):
    """Use named-download fallback for tests that inspect exported PLY bytes."""
    page.evaluate('window.showSaveFilePicker = undefined')
    page.get_by_role('button', name='导出 PLY', exact=True).click()
    dialog = page.get_by_role('dialog', name='保存模型副本', exact=True)
    if name is not None:
        dialog.get_by_label('文件名', exact=True).fill(name)
    dialog.get_by_role('button', name='下载 PLY', exact=True).click()


def read_export(path):
    raw = Path(path).read_bytes()
    header, payload = raw.split(b'end_header\n', 1)
    count, faces = 0, 0
    for line in header.decode().splitlines():
        if line.startswith('element vertex '):
            count = int(line.split()[-1])
        if line.startswith('element face '):
            faces = int(line.split()[-1])
    has_normals = b'property float nx' in header
    has_colors = b'property uchar red' in header
    stride = 12 + (12 if has_normals else 0) + (3 if has_colors else 0)
    points = [struct.unpack_from('<fff', payload, i * stride) for i in range(count)]
    assert all(math.isfinite(value) for point in points for value in point)
    for i in range(faces):
        face = struct.unpack_from('<Biii', payload, count * stride + i * 13)
        assert face[0] == 3 and all(0 <= index < count for index in face[1:])
    assert len(payload) == count * stride + faces * 13
    return points, faces


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
        page.goto(BASE_URL, wait_until='networkidle')
        page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
        page.get_by_role('button', name='模型编辑', exact=True).click()
        page.wait_for_url(f'{BASE_URL}/model-editor')
        expect(page).to_have_title('模型编辑 · 虚拟示教平台')
        editor = page.locator('[data-app-page="model-editor"]')
        picker = page.get_by_label('导入模型文件', exact=True)
        export = page.get_by_role('button', name='导出 PLY', exact=True)
        details_button = page.get_by_role('button', name='模型详情', exact=True)
        expect(export).to_be_disabled()
        expect(details_button).to_be_disabled()

        def ready():
            expect(editor).to_have_attribute('data-editor-state', 'ready')
            expect(page.get_by_label('模型编辑三维预览', exact=True)).to_have_attribute('data-render-state', 'ready')

        def point_count(count):
            expect(page.locator('[data-model-point-count]')).to_have_attribute('data-model-point-count', str(count))

        def download(name):
            with page.expect_download() as event:
                start_model_download(page)
            target = f'/tmp/{name}'
            event.value.save_as(target)
            ready()
            return read_export(target)

        picker.set_input_files({'name': 'invalid.ply', 'mimeType': 'application/octet-stream', 'buffer': b'not a PLY'})
        expect(page.get_by_role('alert')).to_contain_text('有效')
        page.get_by_role('button', name='关闭提示').click()
        picker.set_input_files(str(FIXTURES / 'rotation-map.ply'))
        ready()
        point_count(24)
        canvas = page.get_by_label('模型编辑三维预览', exact=True)
        expect(page.locator('.model-editor__scene .model-editor__statistics')).to_have_count(0)
        expect(page.locator('.model-editor__view-label')).to_have_count(0)
        details_button.click()
        details = page.get_by_role('dialog', name='模型详情', exact=True)
        expect(details).to_be_visible()
        expect(details).to_contain_text('rotation-map.ply')
        expect(details.locator('.model-editor__statistics > div').nth(0)).to_contain_text('原始 24')
        expect(details.locator('.model-editor__statistics > div').nth(0).locator('strong')).to_have_text('24')
        expect(details).to_contain_text('结果尺寸 · m')
        page.keyboard.press('Escape')
        expect(details).to_have_count(0)
        expect(details_button).to_be_focused()
        page.locator('.model-editor__viewport canvas[data-render-state="ready"]').wait_for()
        # All six pose controls are editable; the known yaw checks transform direction.
        for axis in ['roll', 'pitch', 'yaw']:
            expect(page.get_by_label(f'原点 {axis}', exact=True)).to_be_enabled()
        page.get_by_label('原点 X', exact=True).fill('1')
        page.get_by_label('原点 yaw', exact=True).fill('90')
        ready()
        points, faces = download('model-editor-origin.ply')
        assert faces == 0 and len(points) == 24
        assert abs(points[0][0]) < 1e-5 and abs(points[0][1] - 1) < 1e-5
        page.get_by_label('启用模型裁剪').check()
        ready()
        point_count(24)
        page.get_by_label('裁剪 X 下限', exact=True).fill('0')
        page.get_by_label('裁剪 X 上限', exact=True).fill('1')
        page.get_by_role('button', name='确定裁剪', exact=True).click()
        ready()
        # Float rotations can move boundary values slightly; export must stay in range.
        page.get_by_label('降采样方式', exact=True).select_option('uniform')
        ready()
        edited_count = int(page.locator('[data-model-point-count]').get_attribute('data-model-point-count'))
        assert 0 < edited_count < 24
        edited_image = hashlib.sha256(canvas.screenshot()).hexdigest()
        page.get_by_role('button', name='原始模型', exact=True).click()
        expect(canvas).to_have_attribute('data-preview-points', str(edited_count))
        expect(canvas).to_have_attribute('data-original-visible', 'true')
        expect(canvas).to_have_attribute('data-original-points', '24')
        assert 0 < float(canvas.get_attribute('data-original-opacity')) < 1
        assert hashlib.sha256(canvas.screenshot()).hexdigest() != edited_image
        expect(page.get_by_role('button', name='继续编辑', exact=True)).to_have_attribute('aria-pressed', 'true')
        # The overlay never enters exports or the edited statistics.
        points, _ = download('model-editor-cropped-sampled.ply')
        assert len(points) == edited_count and all(-1e-6 <= point[0] <= 1 + 1e-6 for point in points)
        details_button.click()
        expect(details.locator('.model-editor__statistics > div').nth(0).locator('strong')).to_have_text(str(edited_count))
        page.get_by_role('button', name='关闭模型详情', exact=True).click()
        expect(details_button).to_be_focused()
        page.get_by_role('button', name='继续编辑', exact=True).click()
        expect(canvas).to_have_attribute('data-original-visible', 'false')
        expect(canvas).to_have_attribute('data-original-points', '0')

        page.get_by_role('button', name='主页面', exact=True).click()
        page.wait_for_url(f'{BASE_URL}/')
        page.get_by_role('button', name='模型编辑', exact=True).click()
        ready()
        point_count(edited_count)
        expect(page.get_by_label('原点 yaw', exact=True)).to_have_value('90')
        page.go_back()
        page.locator('[data-app-page="home"]').wait_for()
        page.go_forward()
        ready()

        page.get_by_label('裁剪 X 下限', exact=True).fill('2')
        expect(page.get_by_role('alert')).to_contain_text('下限不能大于上限')
        expect(export).to_be_disabled()
        page.get_by_role('button', name='使用变换后完整范围').click()
        ready()
        page.get_by_role('button', name='重置全部').click()
        ready()
        point_count(24)
        page.get_by_label('启用模型裁剪').check()
        page.get_by_label('裁剪 X 上限', exact=True).fill('101')
        page.get_by_label('裁剪 X 下限', exact=True).fill('100')
        page.get_by_role('button', name='确定裁剪', exact=True).click()
        ready()
        point_count(0)
        expect(export).to_be_disabled()
        page.get_by_role('button', name='重置全部').click()
        ready()

        # A late worker result cannot supersede a quick reset to previous settings.
        page.get_by_label('原点 X', exact=True).fill('50')
        page.wait_for_timeout(300)
        page.get_by_role('button', name='重置全部').click()
        ready()
        points, _ = download('model-editor-reset.ply')
        assert points[0] == (0, 0, 0)

        picker.set_input_files(str(FIXTURES / 'hybrid-map.ply'))
        ready()
        point_count(7)
        expect(page.locator('[data-model-face-count]')).to_have_attribute('data-model-face-count', '2')
        expect(page.locator('.model-editor__viewport canvas')).to_have_attribute('data-preview-points', '3')
        page.get_by_label('启用模型裁剪').check()
        for axis in ['X', 'Y']:
            page.get_by_label(f'裁剪 {axis} 下限', exact=True).fill('-0.5')
            page.get_by_label(f'裁剪 {axis} 上限', exact=True).fill('0.5')
        page.get_by_role('button', name='确定裁剪', exact=True).click()
        ready()
        points, faces = download('model-editor-mesh-crop.ply')
        assert faces > 0 and all(abs(point[0]) <= 0.5 and abs(point[1]) <= 0.5 for point in points)
        page.get_by_role('button', name='原始模型', exact=True).click()
        expect(canvas).to_have_attribute('data-original-visible', 'true')
        expect(canvas).to_have_attribute('data-original-faces', '2')
        expect(canvas).to_have_attribute('data-original-points', '3')
        assert 0 < float(canvas.get_attribute('data-original-opacity')) < 1
        page.get_by_role('button', name='关闭提示').click()
        page.screenshot(path='/tmp/model-editor-mesh.png', full_page=True)

        vertices = [f'{x / 10} {y / 10} 0' for y in range(11) for x in range(11)]
        triangles = []
        for y in range(10):
            for x in range(10):
                a = y * 11 + x
                triangles.extend([f'3 {a} {a + 1} {a + 12}', f'3 {a} {a + 12} {a + 11}'])
        dense_ply = '\n'.join(['ply', 'format ascii 1.0', 'element vertex 121', 'property float x', 'property float y', 'property float z', 'element face 200', 'property list uchar int vertex_indices', 'end_header'] + vertices + triangles) + '\n'
        picker.set_input_files({'name': 'dense.ply', 'mimeType': 'application/octet-stream', 'buffer': dense_ply.encode()})
        ready()
        expect(canvas).to_have_attribute('data-original-visible', 'false')
        expect(canvas).to_have_attribute('data-original-faces', '0')
        expect(page.get_by_role('button', name='原始模型', exact=True)).to_be_visible()
        page.get_by_label('降采样方式', exact=True).select_option('voxel')
        page.get_by_label('体素尺寸', exact=True).fill('0')
        expect(page.get_by_role('alert')).to_contain_text('体素尺寸必须大于 0')
        expect(export).to_be_disabled()
        page.get_by_label('体素尺寸', exact=True).fill('0.25')
        ready()
        points, faces = download('model-editor-mesh-reduced.ply')
        assert len(points) < 121 and 0 < faces < 200
        page.get_by_role('button', name='关闭提示').click()
        page.get_by_role('button', name='俯视', exact=True).click()
        page.get_by_role('button', name='显示线框', exact=True).click()
        page.wait_for_timeout(200)
        page.screenshot(path='/tmp/model-editor-ready.png', full_page=True)
        page.set_viewport_size({'width': 1024, 'height': 768})
        page.wait_for_timeout(200)
        page.screenshot(path='/tmp/model-editor-1024.png', full_page=True)
        assert page.locator('.model-editor__viewport').bounding_box()['height'] > 300
        page.reload(wait_until='networkidle')
        expect(page.get_by_role('button', name='选择 PLY 模型')).to_be_visible()
        expect(export).to_be_disabled()
        assert not errors, errors
        print('model editor UI: details dialog, point/mesh ghost overlay, import, transforms, crop, simplify, export, validation, reset, navigation, and WebGL passed')
        browser.close()


if __name__ == '__main__':
    run()
