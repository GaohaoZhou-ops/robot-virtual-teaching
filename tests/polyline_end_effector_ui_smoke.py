"""Surface picking and arm pose editing share real pointer gestures in the sidebar."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from end_effector_control_smoke import double_click_tool
from polyline_teaching_ui_smoke import BASE, project_point, rotate_scene
from robot_drag_undo_smoke import assert_restored, drag, state
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-end-effector'


def edit_field(panel, label, value):
    field = panel.get_by_role('spinbutton', name=label, exact=True)
    field.fill(str(value)); field.press('Tab')


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # Add an independently movable wrist to each simple Cartesian test arm so
    # the test verifies actual world orientation, not just the requested target.
    urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()
    for side, parent, index in [('left', 'left_L3', 4), ('right', 'right_L1', 2)]:
        urdf = urdf.replace(f'<parent link="{parent}"/><child link="tool_{side}"/>',
                            f'<parent link="{side}_wrist"/><child link="tool_{side}"/>')
        urdf = urdf.replace('</robot>', f'''
          <link name="{side}_wrist"/>
          <joint name="{side}_J{index}" type="revolute">
            <parent link="{parent}"/><child link="{side}_wrist"/><axis xyz="0 0 1"/>
            <limit lower="-3.14" upper="3.14" effort="10" velocity="1"/>
          </joint></robot>''')
    descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                      format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
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
            viewer_tool(page, name='定位机器人模型').click()
            page.wait_for_timeout(400)
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            arm = page.get_by_role('region', name='机械臂末端空间球', exact=True)
            inspector = page.locator('.inspector-panel')
            vertices = [[.3, .35, .55], [.45, .45, .55]]
            for point in vertices:
                xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            point_history = panel.get_attribute('data-undo-count')
            before = state(canvas)
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)

            double_click_tool(page, canvas, 'left')
            expect(arm).to_be_visible()
            expect(arm).to_have_attribute('data-end-effector-side', 'left')
            expect(inspector).to_have_attribute('data-panel-mode', 'polyline')
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(panel).to_have_attribute('data-undo-count', point_history)
            expect(panel).to_have_attribute('data-status', 'ready')
            edit_field(arm, '末端 YAW (°)', 15)
            expect(panel).to_have_attribute('data-status', 'editing')
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            actual = state(canvas)
            assert abs(actual['joints']['left_J4'] - 15) < .5, actual
            assert actual['pose'] == before['pose']
            assert all(value == before['joints'][name] for name, value in actual['joints'].items() if name.startswith('right_'))

            # Actual TransformControls dragging and its undo must not touch the
            # polyline, even when the handle projects onto the source surface.
            before_drag = state(canvas)
            drag(page, canvas, dx=14, dy=-8)
            assert state(canvas)['joints'] != before_drag['joints']
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(panel).to_have_attribute('data-undo-count', point_history)
            page.keyboard.press('Control+z')
            assert_restored(canvas, before_drag, target=True)
            page.keyboard.press('Escape')
            expect(arm).to_be_hidden()
            expect(panel).to_be_visible()
            assert_restored(canvas, before)

            # Switching between hands keeps the teaching sidebar; closing the
            # space-ball panel keeps the edited pose instead of cancelling it.
            points_text = panel.get_by_role('list', name='折线点列表', exact=True).inner_text()
            panel.get_by_role('button', name='在选中点后插入', exact=True).click()
            double_click_tool(page, canvas, 'right')
            expect(arm).to_have_attribute('data-end-effector-side', 'right')
            edit_field(arm, '末端 YAW (°)', -17)
            assert abs(state(canvas)['joints']['right_J2'] + 17) < .5
            accepted = state(canvas)
            canvas.press('Enter')
            expect(arm).to_be_hidden()
            expect(panel).to_be_visible()
            assert_restored(canvas, accepted)
            panel.get_by_role('button', name='移动选中点', exact=True).click()
            double_click_tool(page, canvas, 'left')
            expect(arm).to_have_attribute('data-end-effector-side', 'left')
            edit_field(arm, '末端 YAW (°)', 12)
            assert abs(state(canvas)['joints']['left_J4'] - 12) < .5
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(panel).to_have_attribute('data-undo-count', point_history)
            assert panel.get_by_role('list', name='折线点列表', exact=True).inner_text() == points_text

            # A normal surface click still adds a point while the gizmo is open.
            panel.get_by_role('button', name='连续点选', exact=True).click()
            xy = project_point(page, [.24, .52, .55]); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '3')
            rotate_scene(page, panel, [.8, 0, .25])
            page.screenshot(path=str(ARTIFACTS / 'editing-in-sidebar.png'), full_page=True)
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(arm).to_be_hidden()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            # A checked plan remains ready on simply opening the space ball;
            # starting playback detaches it, and paused playback stays locked.
            double_click_tool(page, canvas, 'left')
            expect(arm).to_be_visible()
            expect(panel).to_have_attribute('data-status', 'ready')
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(arm).to_be_hidden()
            expect(panel).to_have_attribute('data-status', 'playing')
            double_click_tool(page, canvas, 'right')
            expect(arm).to_be_hidden()
            panel.get_by_role('button', name='暂停', exact=True).click()
            paused = state(canvas)
            assert abs(paused['joints']['left_J4'] - 12) < .5, 'the new check must use the edited tool orientation'
            double_click_tool(page, canvas, 'left')
            double_click_tool(page, canvas, 'right')
            expect(arm).to_be_hidden()
            expect(panel).to_have_attribute('data-status', 'paused')
            expect(panel).to_have_attribute('data-point-count', '3')
            assert_restored(canvas, paused)
            panel.get_by_role('button', name='停止折线任务', exact=True).click()
            double_click_tool(page, canvas, 'left')
            expect(arm).to_be_visible()
            arm.get_by_role('button', name='退出机械臂末端控制', exact=True).click()
            expect(panel).to_be_visible()

            # Existing marker editing stays intact after arm interaction.
            old_history = int(panel.get_attribute('data-undo-count'))
            start, end = project_point(page, vertices[0]), project_point(page, [.42, .30, .55])
            page.mouse.move(start['x'], start['y']); page.mouse.down()
            page.mouse.move(end['x'], end['y'], steps=8); page.mouse.up()
            expect(panel).to_have_attribute('data-point-count', '3')
            expect(panel).to_have_attribute('data-undo-count', str(old_history + 1))

            # The hidden robot cannot acquire an invisible tool control.
            page.get_by_role('button', name='显示设置', exact=True).click()
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            xy = project_point(page, [.6, .25, .55]); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '4')
            expect(arm).to_be_hidden()
            assert not errors, errors
            print('Polyline tool editing: both arms, pose changes, drag/undo/Escape, picking, camera, plan invalidation and playback locks passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            (ARTIFACTS / 'failure.json').write_text(json.dumps({'errors': errors, 'dataset': canvas.evaluate('c => ({...c.dataset})'), 'text': page.locator('body').inner_text()}, ensure_ascii=False, indent=2))
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
