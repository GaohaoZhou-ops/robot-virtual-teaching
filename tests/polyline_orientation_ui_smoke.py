"""Rechecking and replaying saved polylines adopt the live tool orientation."""
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project, start_project_download
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-orientation'


def exported_path(page):
    with page.expect_download() as download:
        start_project_download(page)
    return read_exported_project(download.value)['virtualTeaching']['tasks'][0]['polylines'][0]


def set_orientation(page, degrees):
    page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
    field = page.get_by_role('spinbutton', name='left_J4 关节值', exact=True)
    field.fill(str(degrees)); field.press('Enter')
    page.wait_for_function('''angle => Math.abs(JSON.parse(
        document.querySelector('.three-canvas').dataset.robotJointValues).left_J4 - angle) < 1e-6''', arg=degrees)
    page.get_by_role('button', name='关闭全关节浮动窗口', exact=True).click()


def observe_motion(page):
    page.evaluate('''() => {
      const canvas = document.querySelector('.three-canvas');
      window.orientationSamples = [];
      window.orientationObserver = new MutationObserver(() => {
        window.orientationSamples.push(JSON.parse(canvas.dataset.robotJointValues));
      });
      window.orientationObserver.observe(canvas, {attributes: true, attributeFilter: ['data-robot-joint-values']});
    }''')


def verify_motion(page, panel, canvas, degrees, endpoint, base_pose):
    expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
    samples = page.evaluate('''() => {
      window.orientationObserver.disconnect();
      return window.orientationSamples;
    }''')
    assert len(samples) > 10, 'replay must move the robot'
    drift = max(abs(sample['left_J4'] - degrees) for sample in samples)
    assert drift <= .5, f'tool orientation must stay within the planning tolerance throughout playback: {drift} degrees'
    assert all(sample['right_J1'] == 0 for sample in samples), 'opposite arm must remain locked'
    assert [canvas.get_attribute('data-robot-' + axis) for axis in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']] == base_pose
    joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
    angle = math.radians(joints['left_J4'])
    # Forward kinematics of the fixture, including the rotated 200 mm TCP offset.
    tip = [float(base_pose[0]) + .4 + joints['left_J1'] - .2 * math.sin(angle),
           float(base_pose[1]) + .3 + joints['left_J2'],
           float(base_pose[2]) + .7 + joints['left_J3'] - .2 * math.cos(angle)]
    assert math.dist(tip, endpoint) < .0011, (tip, endpoint)


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                          format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
        # Add an independently adjustable pitch joint to the XYZ test arm.
        urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text().replace(
            '<joint name="left_tool_fixed" type="fixed"><parent link="left_L3"/><child link="tool_left"/><origin xyz="0 0 -0.1"/></joint>',
            '<joint name="left_J4" type="revolute"><parent link="left_L3"/><child link="tool_left"/><origin xyz="0 0 -0.1"/>'
            '<axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="10" velocity="1"/></joint>')
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
            base_pose = [canvas.get_attribute('data-robot-' + axis) for axis in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']]
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            expect(panel.get_by_role('button', name='采用当前朝向', exact=True)).to_have_count(0)
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('自动朝向折线')
            speed = panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True)
            speed.fill('200'); speed.press('Enter')
            for point in [[.4, .3, .55], [.5, .3, .55]]:
                xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)

            # The second check must discard the first check's orientation.
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            set_orientation(page, 25)
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            before = canvas.get_attribute('data-robot-joint-values')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            assert canvas.get_attribute('data-robot-joint-values') == before, 'checking must not move the live robot'
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            page.screenshot(path=str(ARTIFACTS / 'current-orientation-ready.png'), full_page=True)
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            saved = exported_path(page)
            expected_q = [0, math.sin(math.radians(25) / 2), 0, math.cos(math.radians(25) / 2)]
            assert abs(sum(a * b for a, b in zip(saved['quaternion'], expected_q))) > 1 - 1e-8
            endpoint = saved['points'][-1]['position']

            # Recheck the same authored path again with a different live posture.
            set_orientation(page, -20)
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            observe_motion(page)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            verify_motion(page, panel, canvas, -20, endpoint, base_pose)
            page.get_by_role('button', name='图谱控制台', exact=True).click()

            # Saved records still contain 25 degrees. Both automatic replay
            # entry points must instead plan with the new live orientation.
            set_orientation(page, 40)
            observe_motion(page)
            tree = page.get_by_role('tree', name='虚拟示教任务停车点层级', exact=True)
            tree.get_by_role('button', name='回放折线 自动朝向折线', exact=True).click()
            verify_motion(page, panel, canvas, 40, endpoint, base_pose)
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            set_orientation(page, -35)
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            observe_motion(page)
            archive = page.get_by_role('region', name='示教数据管理', exact=True)
            archive.get_by_role('button', name='播放示教任务 折线示教', exact=True).click()
            expect(page).to_have_url(BASE + '/workbench')
            verify_motion(page, panel, canvas, -35, endpoint, base_pose)
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            assert exported_path(page) == saved, 'checking/replaying must not silently overwrite saved authoring data'
            assert not errors, errors
            print('Polyline orientation: button removed, repeated live-orientation checks, saved orientation, fixed-direction TCP playback, sidebar/data-center replay and unchanged saved records passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('errors:', errors, flush=True)
            print('panel:', page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else page.locator('body').inner_text()[:2000], flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
