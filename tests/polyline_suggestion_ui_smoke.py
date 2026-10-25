"""Real approach failures produce checked ghosts without moving the live robot."""
import json
import math
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_base_ui_smoke import base_pose
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-suggestion'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        try:
            for rotary in [True, False]:
                page = browser.new_page(viewport={'width': 1680, 'height': 1100})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                                  format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
                name = 'polyline-suggestion-robot.urdf' if rotary else 'polyline-robot.urdf'
                urdf = (ROOT / 'tests/fixtures' / name).read_text().replace('lower="-1" upper="1"', 'lower="-0.12" upper="0.12"')
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
                    vertices = [[.47, .3, .55], [.42, .35, .55]] if rotary else [[.65, .3, .55], [.65, .4, .55]]
                    for point in vertices:
                        xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
                    expect(panel).to_have_attribute('data-point-count', '2')
                    speed = panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True)
                    speed.fill('200'); speed.press('Enter')
                    before_joints, before_base = canvas.get_attribute('data-robot-joint-values'), base_pose(canvas)
                    panel.get_by_role('button', name='检查路径', exact=True).click()
                    expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
                    expect(panel).to_have_attribute('data-suggestion-found', 'true')
                    expect(panel.locator('[role=status]')).to_contain_text('到起点的移动：未找到满足沿线精度和固定朝向的连续逆解')
                    expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
                    note = panel.get_by_role('note', name='可行起始姿态建议', exact=True)
                    expect(note).to_contain_text('底盘位置保持不变' if rotary else '建议底盘平移')
                    expect(note).to_contain_text('到虚影位置的移动未规划')
                    expect(canvas).to_have_attribute('data-polyline-ghost-state', 'visible')
                    assert int(canvas.get_attribute('data-polyline-ghost-mesh-count')) > 0
                    assert canvas.get_attribute('data-robot-joint-values') == before_joints
                    assert base_pose(canvas) == before_base, 'suggestions must not move the current robot'
                    ghost_pose = json.loads(canvas.get_attribute('data-polyline-ghost-base-pose'))
                    if rotary:
                        assert math.dist(ghost_pose['position'], before_base[:3]) < 1e-8
                    else:
                        assert math.dist(ghost_pose['position'], before_base[:3]) > .05
                    page.screenshot(path=str(ARTIFACTS / ('arm-ghost.png' if rotary else 'base-ghost.png')), full_page=True)

                    if rotary:
                        toggle = note.get_by_role('checkbox', name='显示参考虚影', exact=True)
                        toggle.uncheck(); expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                        toggle.check(); expect(canvas).to_have_attribute('data-polyline-ghost-state', 'visible')
                        page.get_by_role('button', name='显示设置', exact=True).click()
                        display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
                        model = display.get_by_role('switch', name='显示机器人模型', exact=True)
                        model.click(); expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                        model.click(); expect(canvas).to_have_attribute('data-polyline-ghost-state', 'visible')
                        display.get_by_role('button', name='关闭显示设置', exact=True).click()
                        # A constraint-only change must invalidate the ghost,
                        # even when the current joint values do not change.
                        robot_menu = page.locator('[data-workbench-menu-trigger="robot"]')
                        robot_menu.click()
                        soft_limit = page.get_by_role('spinbutton', name='关节软限位百分比', exact=True)
                        soft_limit.fill('90'); soft_limit.press('Enter')
                        expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                        expect(note).to_have_count(0)
                        soft_limit.fill('95'); soft_limit.press('Enter'); robot_menu.click()
                        panel.get_by_role('button', name='检查路径', exact=True).click()
                        expect(panel).to_have_attribute('data-suggestion-found', 'true', timeout=60000)
                        # Editing a parameter invalidates the checked ghost.
                        speed.fill('150'); speed.press('Enter')
                        expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                        expect(note).to_have_count(0)
                        panel.get_by_role('button', name='检查路径', exact=True).click()
                        expect(panel).to_have_attribute('data-suggestion-found', 'true', timeout=60000)
                        page.get_by_role('button', name='图谱控制台', exact=True).click()
                        expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                        page.get_by_role('button', name='表面折线示教', exact=True).click()
                        expect(note).to_have_count(0)
                        panel.get_by_role('button', name='检查路径', exact=True).click()
                        expect(panel).to_have_attribute('data-suggestion-found', 'true', timeout=60000)

                    # Applying is a separate explicit user action, followed by
                    # a fresh check. It never bypasses normal execution checks.
                    note.get_by_role('button', name='采用虚影并重新检查', exact=True).click()
                    expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                    expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                    expect(panel.get_by_role('checkbox', name='静止', exact=True)).to_be_checked()
                    adopted_base = base_pose(canvas)
                    assert math.dist(adopted_base[:3], ghost_pose['position']) < 1e-6, (adopted_base, ghost_pose)
                    panel.get_by_role('button', name='执行划线', exact=True).click()
                    expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
                    assert base_pose(canvas) == adopted_base
                    joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
                    assert joints['right_J1'] == json.loads(before_joints)['right_J1']
                    if rotary:
                        a, b = math.radians(joints['left_J2']), math.radians(joints['left_J3'])
                        tip = [.3 * math.cos(a) + .3 * math.cos(a + b),
                               .3 + .3 * math.sin(a) + .3 * math.sin(a + b),
                               adopted_base[2] + .5 + joints['left_J1']]
                    else:
                        tip = [adopted_base[i] + offset + joints[f'left_J{i + 1}'] for i, offset in enumerate([.4, .3, .5])]
                    assert math.dist(tip, vertices[-1]) < .002, (tip, vertices[-1])
                    if not rotary:
                        distance = panel.get_by_role('spinbutton', name='末端距线段 mm', exact=True)
                        distance.fill('1000'); distance.press('Enter')
                        panel.get_by_role('combobox', name='末端距线段方向', exact=True).select_option('1')
                        panel.get_by_role('button', name='检查路径', exact=True).click()
                        expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
                        expect(panel).to_have_attribute('data-suggestion-found', 'false')
                        expect(panel.locator('[role=status]')).to_contain_text('未找到通过完整路线验证的参考姿态')
                        expect(canvas).to_have_attribute('data-polyline-ghost-state', 'hidden')
                    assert not errors, errors
                except Exception:
                    page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
                    print('errors:', errors, flush=True)
                    print('panel:', page.locator('.polyline-teaching').inner_text(), flush=True)
                    raise
                finally:
                    page.close()
            print('Polyline suggestion UI: real IK failure, stationary/relocated ghosts, live isolation, visibility, invalidation, explicit adoption/recheck, complete playback and no-solution feedback passed.')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
