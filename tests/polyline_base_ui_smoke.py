"""Worker/UI integration for chassis modes, live base playback and persistence."""
import json
import math
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import project_point, rotate_scene
from topbar_tools_helpers import topbar_action
from archive_helpers import start_project_download, read_exported_project

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22199')
ARTIFACTS = ROOT / 'test-artifacts/polyline-base'


def base_pose(canvas):
    return [float(canvas.get_attribute('data-robot-' + key)) for key in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']]


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
        for sync, search in [(True, False), (False, True), (True, True)]:
            mode = f'sync-{sync}-search-{search}'
            page = browser.new_page(viewport={'width': 1680, 'height': 1100})
            page.set_default_timeout(30000)
            page.add_init_script('''
                window.polylineRequests = 0; window.polylineSearchResult = null;
                const OriginalWorker = window.Worker;
                window.Worker = class extends OriginalWorker {
                    constructor(...args) {
                        super(...args);
                        this.addEventListener('message', ({data}) => {
                            if (data.type === 'complete' && data.value?.baseSearch) window.polylineSearchResult = data.value;
                        });
                    }
                    postMessage(data, ...rest) {
                        if (data?.path?.settings) window.polylineRequests++;
                        return super.postMessage(data, ...rest);
                    }
                };
            ''')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                              format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
            urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text().replace('lower="-1" upper="1"', 'lower="-0.08" upper="0.08"')
            page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
            page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=urdf))
            try:
                page.goto(BASE + '/workbench', wait_until='networkidle')
                page.locator('[data-session-state=ready]').wait_for()
                page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface.ply'))
                page.locator('.loading-curtain').wait_for(state='hidden')
                topbar_action(page, name='加载机器人', exact=True).click()
                page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
                canvas = page.locator('.three-canvas')
                expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
                page.get_by_role('button', name='表面折线示教', exact=True).click()
                panel = page.get_by_role('region', name='表面折线示教', exact=True)
                fixed = panel.get_by_role('checkbox', name='静止', exact=True)
                together = panel.get_by_role('checkbox', name='移动', exact=True)
                automatic = panel.get_by_role('checkbox', name='自搜索', exact=True)
                position_button = panel.get_by_role('button', name='到达搜索位置', exact=True)
                expect(fixed).to_be_checked(); expect(together).not_to_be_checked(); expect(automatic).not_to_be_checked()
                expect(position_button).to_have_count(0)
                together.check(); automatic.check(); expect(fixed).not_to_be_checked()
                expect(position_button).to_be_visible(); expect(position_button).to_be_disabled()
                fixed.check(); expect(together).not_to_be_checked(); expect(automatic).not_to_be_checked()
                expect(position_button).to_have_count(0)
                together.check(); together.uncheck(); expect(fixed).to_be_checked()
                initial = base_pose(canvas)
                initial_joints = canvas.get_attribute('data-robot-joint-values')
                for point in [[.58, .3, .55], [.65, .42, .55]]:
                    xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
                expect(panel).to_have_attribute('data-point-count', '2')
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
                assert base_pose(canvas) == initial and canvas.get_attribute('data-robot-joint-values') == initial_joints
                if sync:
                    together.check()
                if search:
                    automatic.check()
                panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True).fill('0.8')
                panel.get_by_role('spinbutton', name='底盘转向范围 °', exact=True).fill('0')
                panel.get_by_role('textbox', name='折线名称', exact=True).fill('底盘模式回归')
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                assert base_pose(canvas) == initial and canvas.get_attribute('data-robot-joint-values') == initial_joints, 'worker search must leave the live robot untouched'
                if search:
                    expect(panel.get_by_label('底盘搜索结果', exact=True)).to_be_visible()
                    expect(position_button).to_be_enabled()
                panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True).fill('0.9')
                panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True).press('Enter')
                expect(panel).to_have_attribute('data-status', 'editing')
                expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
                if search:
                    expect(position_button).to_be_disabled()
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                page.screenshot(path=str(ARTIFACTS / (mode + '-checked.png')), full_page=True)
                page.evaluate('''() => {
                    window.baseFrames = [];
                    window.baseTimer = setInterval(() => {
                        const canvas = document.querySelector('.three-canvas');
                        const panel = document.querySelector('.polyline-teaching');
                        window.baseFrames.push({pose: [...'XYZ'].map(k => Number(canvas.dataset['robot' + k])),
                            status: panel.dataset.status, message: panel.querySelector('[role=status]').textContent});
                    }, 40);
                }''')
                panel.get_by_role('button', name='执行划线', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'playing')
                expect(fixed).to_be_disabled(); expect(together).to_be_disabled(); expect(automatic).to_be_disabled()
                if search:
                    expect(position_button).to_be_disabled()
                page.wait_for_function('initial => Math.hypot(...[..."XY"].map((k, i) => Number(document.querySelector(".three-canvas").dataset["robot" + k]) - initial[i])) > .01', arg=initial[:2])
                expect(panel.get_by_label('划线实际移动距离', exact=True)).to_be_visible()
                assert float(panel.get_attribute('data-elapsed-ms')) < 3000, 'the initial base motion must not take many seconds to become visible'
                panel.get_by_role('button', name='暂停', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'paused')
                if search:
                    expect(position_button).to_be_disabled()
                paused = base_pose(canvas)
                paused_travel = panel.get_attribute('data-base-travel-mm')
                assert float(paused_travel) > 9
                rotate_scene(page, panel)
                assert base_pose(canvas) == paused
                assert panel.get_attribute('data-base-travel-mm') == paused_travel
                panel.get_by_role('button', name='继续', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
                frames = page.evaluate('() => { clearInterval(window.baseTimer); return window.baseFrames; }')
                drawing = [frame['pose'] for frame in frames if frame['status'] == 'playing' and frame['message'].startswith('划线 P')]
                assert len(drawing) > 5
                spread = max(math.dist(value, drawing[0]) for value in drawing)
                assert spread > .02 if sync else spread < .000003, (mode, spread)
                end = base_pose(canvas)
                assert math.dist(end[:2], initial[:2]) > .1
                assert float(panel.get_attribute('data-base-travel-mm')) >= math.dist(end[:2], initial[:2]) * 1000 - .1
                assert float(panel.get_attribute('data-tool-travel-mm')) > 200
                assert abs(end[2] - initial[2]) < .000001
                joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
                # Tool-position DOM metadata is a load-time snapshot. Compute
                # independent FK from the live base and prismatic arm values.
                assert max(abs(angle) for angle in end[3:]) < .000001
                actual_tool = [end[i] + offset + joints[f'left_J{i + 1}'] for i, offset in enumerate([.4, .3, .7])]
                assert math.dist(actual_tool, [.65, .42, .75]) < .002, actual_tool
                assert json.loads(canvas.get_attribute('data-robot-joint-values'))['right_J1'] == 0
                page.screenshot(path=str(ARTIFACTS / (mode + '-completed.png')), full_page=True)
                if search:
                    checked = page.evaluate('window.polylineSearchResult')
                    requests = page.evaluate('window.polylineRequests')
                    first_drawing = next(segment for segment in checked['segments'] if segment['index'] >= 0)
                    first = first_drawing['samples'][0]
                    expect(position_button).to_be_enabled()
                    position_button.click()
                    expect(panel).to_have_attribute('data-status', 'ready')
                    expect(position_button).to_have_text('已到达搜索位置')
                    expect(position_button).to_be_disabled()
                    expect(panel).to_have_attribute('data-elapsed-ms', '0')
                    expect(panel).to_have_attribute('data-tool-travel-mm', '0')
                    expect(canvas).to_have_attribute('data-polyline-trace-points', '0')
                    placed = base_pose(canvas)
                    expected_position = [checked['baseReference']['position'][i] + first['base'][axis] for i, axis in enumerate(['x', 'y'])]
                    assert math.dist(placed[:2], expected_position) < .000001
                    joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
                    assert all(abs(joints[name] - value) < 1e-8 for name, value in first['joints'].items())
                    actual_tip = [placed[i] + offset + joints[f'left_J{i + 1}'] for i, offset in enumerate([.4, .3, .5])]
                    assert math.dist(actual_tip, [.58, .3, .55]) < .002, 'placement must include the checked arm pose at P0'
                    assert abs(float(panel.get_attribute('data-duration-ms')) - (checked['durationMs'] - first_drawing['startMs'])) < .01
                    if not sync:
                        page.set_viewport_size({'width': 1000, 'height': 720})
                        position_button.scroll_into_view_if_needed()
                        box = position_button.bounding_box()
                        assert 0 <= box['x'] and box['x'] + box['width'] <= 1000
                        page.screenshot(path=str(ARTIFACTS / 'search-placement-compact.png'), full_page=True)
                        page.set_viewport_size({'width': 1680, 'height': 1100})
                    panel.get_by_role('button', name='执行划线', exact=True).click()
                    expect(panel).to_have_attribute('data-status', 'playing')
                    expect(position_button).to_be_disabled()
                    expect(panel.get_by_role('status')).to_contain_text('划线 P')
                    expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
                    assert math.dist(base_pose(canvas), end) < .00001, 'the positioned stroke reaches the same checked end pose'
                    assert float(panel.get_attribute('data-base-travel-mm')) > 20 if sync else float(panel.get_attribute('data-base-travel-mm')) < .003
                    assert page.evaluate('window.polylineRequests') == requests, 'placement and execution reuse the checked plan without another IK/search request'
                if sync and search:
                    panel.get_by_role('button', name='保存', exact=True).click()
                    expect(panel).to_contain_text('已保存至当前示教任务')
                    page.reload(wait_until='networkidle')
                    page.locator('[data-session-state=ready]').wait_for()
                    expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
                    assert math.dist(base_pose(canvas), end) < .00001, 'live base position is persisted with the project'
                    page.get_by_role('button', name='表面折线示教', exact=True).click()
                    panel.locator('summary').filter(has_text='已保存折线').click()
                    panel.get_by_role('button').filter(has_text='底盘模式回归').click()
                    expect(together).to_be_checked(); expect(automatic).to_be_checked(); expect(fixed).not_to_be_checked()
                    expect(panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True)).to_have_value('0.9')
                    expect(panel.get_by_role('spinbutton', name='底盘转向范围 °', exact=True)).to_have_value('0')
                    expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
                    page.get_by_role('button', name='关闭折线示教', exact=True).click()
                    with page.expect_download() as download_info:
                        start_project_download(page)
                    archive = read_exported_project(download_info.value)
                    saved = [path for task in archive['virtualTeaching']['tasks'] for path in task.get('polylines', [])]
                    assert saved[0]['base'] == dict(sync=True, search=True, allowPartial=False, waistAssist=False, range=.9, yawRange=0), saved[0]['base']
                assert not errors, errors
                print(mode, 'passed', flush=True)
            except Exception as error:
                page.screenshot(path=str(ARTIFACTS / (mode + '-failure.png')), full_page=True)
                print('failure:', repr(error), 'page errors:', errors, flush=True)
                print('panel:', page.locator('.polyline-teaching').all_text_contents(), flush=True)
                raise
            finally:
                page.close()
        browser.close()
        print('Chassis UI: exclusivity, worker isolation, joint/base playback, fixed parking, search placement and direct execution, no replanning, pause/resume, FK, saved pose and ZIP configuration passed.')


if __name__ == '__main__':
    run()
