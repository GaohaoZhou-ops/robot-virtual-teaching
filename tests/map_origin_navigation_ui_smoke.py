"""Origin selection/navigation in a fresh browser with synthetic workspaces."""
import json
import math
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from parking_ghost_smoke import read_robot_pose, wait_for_pose
from robot_height_navigation_ui_smoke import seed_height_workspaces
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from three_selection_smoke import project_to_canvas
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool


def focus_origin(page, absolute=False):
    viewer_tool(page, '地图原点' if absolute else '原点').click()
    page.keyboard.press('Escape')
    if absolute:
        expect(page.locator('.three-canvas')).to_have_attribute('data-map-origin-screen-visible', 'true')
    else:
        page.wait_for_function("""() => ['X', 'Y', 'Z'].every(axis =>
          Math.abs(Number(document.querySelector('.three-canvas').dataset[`target${axis}`])) < 1e-6)
        """)


def origin_panel(page, enabled=True):
    expect(page.get_by_role('tab', name='路径与导航', exact=True)).to_have_attribute('aria-selected', 'true')
    panel = page.locator('#inspector-page-navigation')
    expect(panel.get_by_role('button')).to_have_count(1)
    expect(panel.locator('input, select')).to_have_count(0)
    button = panel.get_by_role('button', name='运动到地图原点', exact=True)
    (expect(button).to_be_enabled if enabled else expect(button).to_be_disabled)()
    return button


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30_000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed_height_workspaces(page)
            original = snapshot(page, 'map')['project']
            canvas = page.locator('.three-canvas')
            height = read_robot_pose(canvas)['z']
            joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            focus_origin(page)
            x, y = project_to_canvas(canvas, (0, 0, 0))
            page.mouse.move(x, y)
            expect(canvas).to_have_attribute('data-hover-pick-type', 'map-origin')
            page.mouse.click(x, y)
            origin_panel(page).click()
            wait_for_pose(page, {'x': 0, 'y': 0, 'z': height, 'roll': 0, 'pitch': 0, 'yaw': 0})
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == joints
            origin_panel(page)

            # Clicking the navigation tab restores the complete route controls.
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            expect(page.get_by_label('搜索导航点', exact=True)).to_be_visible()
            expect(page.locator('.waypoint-chips [aria-current="location"]')).to_have_count(0)
            page.get_by_label('搜索导航点', exact=True).select_option('wp-1')
            page.get_by_role('button', name='运动到该点', exact=True).click()
            wait_for_pose(page, {'x': 11, 'y': 20, 'z': height, 'yaw': -35})

            # 2D selection opens the same minimal panel; it does not add a point.
            marker = page.get_by_role('button', name='二维坐标原点', exact=True)
            marker.click()
            expect(marker).to_have_attribute('aria-pressed', 'true')
            origin_panel(page).click()
            wait_for_pose(page, {'x': 0, 'y': 0, 'z': height, 'yaw': 0})
            artifact = Path('test-artifacts/map-origin-navigation')
            artifact.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(artifact / 'origin-panel.png'), animations='disabled')

            # Empty-space clicks clear the origin; dragging an axis still orbits.
            box = canvas.bounding_box()
            page.mouse.click(box['x'] + 30, box['y'] + 45)
            expect(page.get_by_label('搜索导航点', exact=True)).to_be_visible()
            expect(marker).to_have_attribute('aria-pressed', 'false')
            focus_origin(page)
            x, y = project_to_canvas(canvas, (0, 0, 0))
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 60, y + 25, steps=8)
            page.mouse.up()
            expect(page.get_by_role('button', name='运动到地图原点', exact=True)).to_have_count(0)
            saved = snapshot(page, 'map')['project']
            assert saved['waypoints'] == original['waypoints']
            assert saved['paths'] == original['paths']

            # Independent mode navigates the transformed MAP origin, including
            # a tilted map vertical, while keeping the calibrated local height.
            page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { createTeachingAlignment } = await import('/src/features/teaching/model/teachingTransfer.js');
              const { sessionId } = await store.fetchServiceSession();
              const target = await store.loadWorkspaceSnapshot(sessionId, 'map');
              const local = await store.loadWorkspaceConfig(sessionId, 'independent');
              const localToMap = { position: {x: 5, y: -3, z: 1}, rpy: {roll: 12, pitch: -8, yaw: 90} };
              local.config.project.workspace.transfer = await createTeachingAlignment(target, { localToMap });
              local.config.ui.mapRouteSyncEnabled = true;
              await store.saveWorkspaceConfig(sessionId, local.mapId, local.config, 'independent');
            }""")
            topbar_action(page, '切换到独立示教', exact=True).click()
            ready(page, 'independent')
            expect(canvas).to_have_attribute('data-map-origin-position', re.compile(r'^\['))
            local_height = read_robot_pose(canvas)['z']
            local_joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            focus_origin(page, absolute=True)
            origin = json.loads(canvas.get_attribute('data-map-origin-position'))
            page.mouse.click(*project_to_canvas(canvas, origin))
            origin_panel(page)
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            page.get_by_role('button', name='选择地图原点', exact=True).click()
            origin_panel(page).click()
            page.wait_for_function("""() => Math.abs(Number(document.querySelector('.three-canvas').dataset.robotYaw)) > 40""")
            actual = read_robot_pose(canvas)
            assert math.isclose(actual['z'], local_height, abs_tol=1e-6)
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == local_joints
            result = page.evaluate("""async pose => {
              const { transferMatrix, transformTeachingPose } = await import('/src/features/teaching/model/teachingTransfer.js');
              return transformTeachingPose({position: pose, rpy: pose}, transferMatrix({
                position: {x: 5, y: -3, z: 1}, rpy: {roll: 12, pitch: -8, yaw: 90} }));
            }""", actual)
            assert math.hypot(result['position']['x'], result['position']['y']) < 1e-5, result
            assert all(abs(value) < 1e-4 for value in result['rpy'].values()), result

            # A map with no robot still permits selecting its origin, but not moving.
            empty = browser.new_page(viewport={'width': 1440, 'height': 1000})
            empty.on('pageerror', lambda error: errors.append(str(error)))
            empty.goto(f'{BASE_URL}/workbench', wait_until='networkidle')
            empty.locator('[data-session-state="ready"]').wait_for()
            empty.locator('input[type="file"][accept=".ply"]').set_input_files(
                str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
            empty.locator('.loading-curtain').wait_for(state='hidden')
            empty.get_by_role('button', name='二维坐标原点', exact=True).click()
            origin_panel(empty, enabled=False)
            assert not errors, errors
            print('3D/2D origin picking, minimal panel, movement, unchanged height/joints/graph, '
                  'drag gestures, transformed origin and unloaded-robot guard passed', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
