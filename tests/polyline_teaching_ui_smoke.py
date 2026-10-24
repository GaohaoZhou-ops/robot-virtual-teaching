"""Real pointer picking + background planning, playback, save/reload and cancellation."""
import json
import math
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from topbar_tools_helpers import topbar_action
from archive_helpers import start_project_download, read_exported_project

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22199')
ARTIFACTS = ROOT / 'test-artifacts/polyline-teaching'


def project_point(page, point):
    canvas = page.locator('.three-canvas')
    data = canvas.evaluate('canvas => ({...canvas.dataset})')
    rect = canvas.bounding_box()
    read = lambda prefix: [float(data[prefix + axis]) for axis in 'XYZ']
    dot = lambda a, b: sum(x * y for x, y in zip(a, b))
    unit = lambda v: [n / math.sqrt(dot(v, v)) for n in v]
    cross = lambda a, b: [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    origin = read('camera')
    forward = unit([t - c for t, c in zip(read('target'), origin)])
    right = unit(cross(forward, read('cameraUp')))
    up = cross(right, forward)
    relative = [p - c for p, c in zip(point, origin)]
    half_height = dot(relative, forward) * math.tan(math.radians(float(data['cameraFov']) / 2)) / float(data['opticalZoom'])
    x = dot(relative, right) / (half_height * rect['width'] / rect['height'])
    y = dot(relative, up) / half_height
    return dict(x=rect['x'] + (x + 1) * rect['width'] / 2, y=rect['y'] + (1 - y) * rect['height'] / 2)


def camera_state(canvas):
    data = canvas.evaluate('canvas => ({...canvas.dataset})')
    return {prefix: [float(data[prefix + axis]) for axis in 'XYZ'] for prefix in ['camera', 'target', 'cameraUp']}


def rotate_scene(page, panel, point=None):
    canvas = page.locator('.three-canvas')
    before = camera_state(canvas)
    count, undo = panel.get_attribute('data-point-count'), panel.get_attribute('data-undo-count')
    rect = canvas.bounding_box()
    start = project_point(page, point) if point else dict(x=rect['x'] + rect['width'] * .2, y=rect['y'] + rect['height'] * .5)
    page.mouse.move(start['x'], start['y']); page.mouse.down()
    page.mouse.move(start['x'] + 35, start['y'] + 18, steps=8); page.mouse.up()
    page.wait_for_function('before => [..."XYZ"].some((axis, i) => Math.abs(Number(document.querySelector(".three-canvas").dataset["camera" + axis]) - before[i]) > 1e-4)', arg=before['camera'])
    after = camera_state(canvas)
    assert math.dist(before['target'], after['target']) < 1e-6, 'rotation must keep the camera target fixed'
    assert abs(math.dist(before['camera'], before['target']) - math.dist(after['camera'], after['target'])) < 1e-6
    expect(panel).to_have_attribute('data-point-count', count)
    expect(panel).to_have_attribute('data-undo-count', undo)
    expect(canvas).to_have_attribute('data-pointer-gesture-state', 'ended')
    assert not canvas.evaluate('canvas => canvas.hasPointerCapture(1)'), 'camera drag must release the pointer'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                          format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            global_robot = display.get_by_role('switch', name='显示机器人模型', exact=True)
            opacity = display.get_by_role('slider', name='机器人模型透明度', exact=True)
            page.get_by_role('button', name='显示设置', exact=True).click()
            expect(global_robot).to_be_disabled(); expect(opacity).to_be_disabled()
            expect(opacity).to_have_value('100')
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            expect(canvas).to_have_attribute('data-robot-model-opacity', '1')
            page.get_by_role('button', name='显示设置', exact=True).click()
            expect(global_robot).to_have_attribute('aria-checked', 'true')
            opacity.press('Home')
            for _ in range(35):
                opacity.press('ArrowRight')
            expect(opacity).to_have_value('35')
            expect(canvas).to_have_attribute('data-robot-model-opacity', '0.35')
            page.screenshot(path=str(ARTIFACTS / 'robot-opacity-settings.png'), full_page=True)
            global_robot.click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            page.get_by_role('button', name='折叠图谱控制台', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            expect(panel).to_be_visible()
            inspector = page.locator('.inspector-panel')
            expect(inspector).to_have_attribute('data-panel-mode', 'polyline')
            expect(inspector).to_have_attribute('data-collapsed', 'false')
            expect(page.locator('#inspector-panel-content')).to_be_hidden()
            expect(page.get_by_role('button', name='图谱控制台', exact=True)).to_have_text('图谱控制台')
            assert panel.evaluate('el => el.parentElement.id') == 'inspector-polyline-content'
            page.wait_for_function('''() => {
                const p = document.querySelector('.polyline-teaching').getBoundingClientRect();
                const i = document.querySelector('.inspector-panel').getBoundingClientRect();
                const c = document.querySelector('.three-canvas').getBoundingClientRect();
                return i.width > 300 && p.x >= i.x && p.right <= i.right
                    && p.y >= i.y && p.bottom <= i.bottom && p.x > c.right;
            }''')
            # The body scrolls inside the sidebar and the action footer stays visible.
            page.set_viewport_size({'width': 1200, 'height': 760})
            expect(panel.get_by_role('button', name='检查路径', exact=True)).to_be_in_viewport()
            assert panel.evaluate('el => el.scrollWidth <= el.clientWidth')
            page.screenshot(path=str(ARTIFACTS / 'sidebar-compact.png'), full_page=True)
            page.set_viewport_size({'width': 1680, 'height': 1100})
            expect(panel.get_by_role('checkbox', name='显示机器人模型', exact=True)).to_have_count(0)
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            expect(canvas).to_have_attribute('data-robot-model-opacity', '0.35')
            page.get_by_role('button', name='折叠折线示教', exact=True).click()
            expect(inspector).to_have_attribute('data-collapsed', 'true')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(panel).to_be_hidden()
            expect(inspector).to_have_attribute('data-panel-mode', 'console')
            expect(inspector).to_have_attribute('data-collapsed', 'false')
            expect(page.get_by_role('tab', name='路径与导航', exact=True)).to_have_attribute('aria-selected', 'true')
            expect(page.get_by_role('button', name='表面折线示教', exact=True)).to_have_text('折线示教')
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            page.get_by_role('button', name='显示设置', exact=True).click()
            expect(global_robot).to_have_attribute('aria-checked', 'false')
            global_robot.click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'true')
            opacity.press('Home')
            expect(canvas).to_have_attribute('data-robot-model-opacity', '0')
            opacity.press('End')
            expect(canvas).to_have_attribute('data-robot-model-opacity', '1')
            global_robot.click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            preview = panel.get_by_role('checkbox', name='显示笔尖路径预览', exact=True)
            expect(preview).to_be_checked()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            initial_joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            initial_tool = [float(value) for value in canvas.get_attribute('data-robot-left-tool-position').split(',')]
            distance = panel.get_by_role('spinbutton', name='末端距线段 mm', exact=True)
            direction = panel.get_by_role('combobox', name='末端距线段方向', exact=True)
            expect(distance).to_have_value('200')
            expect(direction).to_have_value('-1')
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            offset_z = panel.get_by_role('spinbutton', name='笔尖偏移 Z mm', exact=True)
            offset_x = panel.get_by_role('spinbutton', name='笔尖偏移 X mm', exact=True)
            # Zero distance retains the chosen direction for the next edit.
            distance.fill('0'); distance.press('Enter'); direction.select_option('1'); distance.fill('80'); distance.press('Enter')
            expect(offset_z).to_have_value('80')
            offset_x.fill('5'); distance.fill('100')
            expect(offset_x).to_have_value('5')
            # Focus commits the linked distance before replacing Z with a negative value.
            offset_z.click(); offset_z.press('ControlOrMeta+A')
            offset_z.press_sequentially('-150'); offset_z.press('Enter')
            expect(distance).to_have_value('150')
            expect(direction).to_have_value('-1')
            offset_x.fill('0'); distance.fill('250'); distance.press('Enter')
            expect(offset_z).to_have_value('-250')
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            # A default left drag rotates immediately, without switching modes.
            rotate_scene(page, panel)
            for i, point in enumerate([[.4, .3, .55], [.51, .3, .55], [.51, .43, .55]]):
                xy = project_point(page, point)
                page.mouse.click(xy['x'], xy['y'])
                expect(canvas).to_have_attribute('data-polyline-preview-segments', str(i))
                expect(canvas).to_have_attribute('data-polyline-preview-visible', str(i > 0).lower())
            expect(panel).to_have_attribute('data-point-count', '3')
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == initial_joints, 'immediate preview must not move the robot'
            preview.scroll_into_view_if_needed()
            page.screenshot(path=str(ARTIFACTS / 'preview-visible.png'), full_page=True)
            preview.uncheck()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            page.screenshot(path=str(ARTIFACTS / 'preview-hidden.png'), full_page=True)
            # Closing hides all previews without losing the points or toggle.
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            expect(preview).not_to_be_checked()
            preview.check()
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '0')
            page.screenshot(path=str(ARTIFACTS / 'preview-panel-closed.png'), full_page=True)
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            expect(preview).to_be_checked()
            expect(panel).to_have_attribute('data-point-count', '3')
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'true')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '2')
            panel.get_by_role('checkbox', name='闭合折线', exact=True).check()
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '3')
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '2')
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '2')
            rotate_scene(page, panel, [.58, .18, .55])
            expect(panel).to_have_attribute('data-status', 'editing')
            # Delete/undo and insertion preserve explicit polyline order.
            panel.get_by_role('button', name='删除折线点 P1', exact=True).click()
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '1')
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(panel).to_have_attribute('data-point-count', '3')
            panel.get_by_role('button', name='选择折线点 P0', exact=True).click()
            panel.get_by_role('button', name='在选中点后插入', exact=True).click()
            xy = project_point(page, [.455, .3, .55])
            page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '4')
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(panel).to_have_attribute('data-point-count', '3')
            before_point_drag = camera_state(canvas)
            start, end = project_point(page, [.51, .3, .55]), project_point(page, [.53, .3, .55])
            page.mouse.move(start['x'], start['y']); page.mouse.down()
            page.mouse.move(end['x'], end['y'], steps=5); page.mouse.up()
            expect(panel.get_by_role('button', name='选择折线点 P1', exact=True)).to_contain_text('0.530')
            assert camera_state(canvas) == before_point_drag, 'dragging a polyline point must not rotate the camera'
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(panel.get_by_role('button', name='选择折线点 P1', exact=True)).to_contain_text('0.510')
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('折线回归样例')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == initial_joints, 'planning must not move the live robot'
            distance.fill('300'); distance.press('Enter')
            expect(panel).to_have_attribute('data-status', 'editing')
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            checked_duration = panel.get_attribute('data-duration-ms')
            preview.uncheck(); preview.check()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            expect(panel).to_have_attribute('data-status', 'ready')
            expect(panel).to_have_attribute('data-duration-ms', checked_duration)
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_enabled()
            expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
            pending_colors = set(json.loads(canvas.get_attribute('data-polyline-preview-colors')))
            assert 'ffb02e' not in pending_colors
            page.screenshot(path=str(ARTIFACTS / 'checked.png'), full_page=True)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            expect(distance).to_be_disabled(); expect(direction).to_be_disabled()
            rotate_scene(page, panel)
            expect(panel).to_have_attribute('data-status', 'playing')
            page.get_by_role('button', name='显示设置', exact=True).click()
            global_robot.click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'true')
            global_robot.click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.wait_for_function('''() => {
                const data = document.querySelector('.three-canvas').dataset;
                return Number(data.polylineCompletedMm) > 25 && Number(data.polylineRemainingMm) > 30;
            }''')
            preview.uncheck()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            expect(panel).to_have_attribute('data-status', 'playing')
            panel.get_by_role('button', name='暂停', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'paused')
            stopped = canvas.get_attribute('data-robot-joint-values')
            paused_time = panel.get_attribute('data-elapsed-ms')
            preview.check()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'true')
            expect(panel).to_have_attribute('data-status', 'paused')
            expect(panel).to_have_attribute('data-elapsed-ms', paused_time)
            completed_mm = canvas.get_attribute('data-polyline-completed-mm')
            assert 25 < float(completed_mm) < 200
            assert set(json.loads(canvas.get_attribute('data-polyline-preview-colors'))) == pending_colors | {'ffb02e'}
            page.screenshot(path=str(ARTIFACTS / 'progress-paused.png'), full_page=True)
            page.wait_for_timeout(250)
            expect(canvas).to_have_attribute('data-polyline-completed-mm', completed_mm)
            rotate_scene(page, panel)
            expect(panel).to_have_attribute('data-status', 'paused')
            assert canvas.get_attribute('data-robot-joint-values') == stopped
            panel.get_by_role('button', name='继续', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            expect(canvas).to_have_attribute('data-polyline-preview-colors', '["ffb02e"]')
            expect(canvas).to_have_attribute('data-polyline-remaining-mm', '0')
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert abs(joints['left_J1'] - .11) < .002 and abs(joints['left_J2'] - .13) < .002, joints
            assert joints['right_J1'] == initial_joints['right_J1']
            # Independent FK for this XYZ-prismatic fixture: the actual tool
            # origin stays 300 mm above its corresponding point on the line.
            actual_tool = [initial_tool[i] + joints[f'left_J{i + 1}'] - initial_joints[f'left_J{i + 1}'] for i in range(3)]
            assert math.dist(actual_tool, [.51, .43, .85]) < .002, actual_tool
            page.get_by_role('button', name='显示设置', exact=True).click()
            global_robot.click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'true')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            page.screenshot(path=str(ARTIFACTS / 'completed.png'), full_page=True)
            page.get_by_role('button', name='关闭折线示教', exact=True).click()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'true')
            with page.expect_download() as download_info:
                start_project_download(page)
            exported = read_exported_project(download_info.value)
            saved = [path for task in exported['virtualTeaching']['tasks'] for path in task.get('polylines', [])]
            assert len(saved) == 1 and saved[0]['name'] == '折线回归样例'
            assert saved[0]['tcpOffset'] == [0, 0, -.3]
            assert saved[0]['toolAxisDirection'] == -1
            page.reload(wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.locator('summary').filter(has_text='已保存折线').click()
            panel.get_by_role('button').filter(has_text='折线回归样例').click()
            expect(panel).to_have_attribute('data-point-count', '3')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '2')
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'true')
            expect(distance).to_have_value('300'); expect(direction).to_have_value('-1')
            expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            page.wait_for_function('''() => Number(document.querySelector('.three-canvas').dataset.polylineCompletedMm) > 20''')
            page.keyboard.press('Escape')
            expect(panel).to_have_attribute('data-status', 'editing')
            stopped_color_length = canvas.get_attribute('data-polyline-completed-mm')
            assert float(stopped_color_length) > 20
            page.wait_for_timeout(250)
            expect(canvas).to_have_attribute('data-polyline-completed-mm', stopped_color_length)
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            panel.get_by_role('spinbutton', name='笔尖偏移 Z mm', exact=True).fill('1000')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            distance.fill('0'); distance.press('Enter'); direction.select_option('1')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            page.reload(wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.locator('summary').filter(has_text='已保存折线').click()
            panel.get_by_role('button').filter(has_text='折线回归样例').click()
            expect(distance).to_have_value('0'); expect(direction).to_have_value('1')
            assert not errors, errors
            print('Polyline UI: docked sidebar switching, console tab restoration, auto-expand, compact layout/footer, robot opacity and visibility, immediate TCP preview, tool distance, camera rotation, point editing, playback, ZIP save/reload and stop passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('errors:', errors, flush=True)
            print('panel:', page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else page.locator('body').inner_text()[:1200], flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
