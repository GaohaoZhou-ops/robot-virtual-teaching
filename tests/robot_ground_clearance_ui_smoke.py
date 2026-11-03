"""Raise/lower the robot through real controls in both teaching workspaces."""
from pathlib import Path
import json

from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import display_settings_section, viewer_tool


def seed(page):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate('''async () => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      for (const mode of ['map', 'independent']) {
        const fixture = teachingTransferFixture(mode), project = fixture.config.config.project;
        fixture.map.portableRobotPackage.files[0].bytes = new TextEncoder().encode(`
          <robot name="clearance_fixture">
            <link name="base_link">
              <visual><geometry><box size="0.4 0.3 0.2"/></geometry></visual>
              <collision><geometry><box size="8 8 8"/></geometry></collision>
            </link>
            <link name="wheel_left"><visual><geometry><box size="0.1 0.05 0.1"/></geometry></visual></link>
            <joint name="wheel_mount" type="fixed"><parent link="base_link"/><child link="wheel_left"/><origin xyz="0 0.15 -0.1"/></joint>
          </robot>`);
        project.robot.origin = { position: {x: 10, y: 20, z: 0}, rpy: {roll: 0, pitch: 0, yaw: 15} };
        project.robot.joints = {};
        project.virtualTeaching.tasks = [];
        project.virtualTeaching.jointPoses = [];
        await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
        await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      }
      await store.activateWorkspaceMode(sessionId, 'map');
    }''')
    page.goto(f'{BASE_URL}/workbench', wait_until='networkidle')
    ready(page, 'map')


def move_height(page, key, predicate):
    page.locator('.three-canvas').focus()
    page.keyboard.down(key)
    try:
        page.wait_for_function(f'''() => {{
          const height = Number(document.querySelector('.three-canvas').dataset.robotChassisClearance);
          return {predicate};
        }}''')
    finally:
        page.keyboard.up(key)


def run():
    artifacts = Path(__file__).resolve().parents[1] / 'test-artifacts' / 'robot-ground-clearance'
    artifacts.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(30_000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            seed(page)
            canvas = page.locator('.three-canvas')
            warning = page.get_by_role('status', name='机器人底盘悬空提示')
            for mode in ['map', 'independent']:
                if mode == 'independent':
                    topbar_action(page, name='切换到独立示教', exact=True).click()
                    ready(page, mode)
                expect(canvas).to_have_attribute('data-robot-chassis-clearance', '0.001000')
                expect(warning).to_have_count(0)
                viewer_tool(page, name='定位机器人模型').click()
                expect(canvas).to_have_attribute('data-robot-control-enabled', 'true')
                expect(canvas).to_have_attribute('data-robot-height-locked', 'false')
                move_height(page, 'ArrowUp', 'height > 0.12')
                expect(warning).to_be_visible()
                expect(warning).to_contain_text('超过 5 cm')
                expect(warning).to_contain_text('地面 z=0')
                expect(canvas).to_have_attribute('data-robot-ground-warning', 'true')
                value = float(warning.locator('li strong').inner_text().split()[1])
                assert abs(value / 100 - float(canvas.get_attribute('data-robot-chassis-clearance'))) < .002
                page.screenshot(path=str(artifacts / f'{mode}-airborne.png'))

                display_settings_section(page, '机器人与相机')
                toggle = page.get_by_role('switch', name='显示机器人模型', exact=True)
                toggle.click()
                expect(warning).to_have_count(0)
                expect(canvas).to_have_attribute('data-robot-ground-warning', 'false')
                toggle.click()
                expect(warning).to_be_visible()
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')

                # Escape/hiding the model exits keyboard robot control.
                if canvas.get_attribute('data-robot-control-enabled') != 'true':
                    viewer_tool(page, name='定位机器人模型').click()
                expect(canvas).to_have_attribute('data-robot-control-enabled', 'true')
                move_height(page, 'ArrowDown', 'height < 0.03')
                expect(warning).to_have_count(0)
                expect(canvas).to_have_attribute('data-robot-ground-warning', 'false')
                move_height(page, 'ArrowUp', 'height > 0.12')
                viewer_tool(page, name='锁定机器人高度').click()
                expect(canvas).to_have_attribute('data-robot-height-locked', 'true')
                before = {key: canvas.get_attribute(f'data-robot-{key}')
                          for key in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']}
                joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
                land = warning.get_by_role('button', name='底盘着地', exact=True)
                expect(land).to_be_enabled()
                page.screenshot(path=str(artifacts / f'{mode}-landing-button.png'))
                land.click()
                expect(canvas).to_have_attribute('data-robot-chassis-clearance', '0.001000')
                expect(warning).to_have_count(0)
                expect(canvas).to_have_attribute('data-robot-height-locked', 'true')
                for key in ['x', 'y', 'roll', 'pitch', 'yaw']:
                    assert canvas.get_attribute(f'data-robot-{key}') == before[key]
                assert json.loads(canvas.get_attribute('data-robot-joint-values')) == joints
                assert int(canvas.get_attribute('data-robot-drag-undo-depth')) > 0
                canvas.press('ControlOrMeta+z')
                expect(canvas).to_have_attribute('data-robot-z', before['z'])
                expect(warning).to_be_visible()
                landed_after = page.evaluate('Date.now()')
                land.click()
                expect(canvas).to_have_attribute('data-robot-chassis-clearance', '0.001000')
                expect(warning).to_have_count(0)
                viewer_tool(page, name='定位机器人模型').click()
                landed_z = float(canvas.get_attribute('data-robot-z'))
                page.wait_for_function('''async ({mode, z, after}) => {
                  const store = await import('/src/features/workspace/model/sessionStore.js');
                  const state = await store.loadWorkspaceSnapshot((await store.fetchServiceSession()).sessionId, mode);
                  return state.config?.savedAt >= after
                    && Math.abs(state.config?.config.project.robot.origin.position.z - z) < 1e-6;
                }''', arg={'mode': mode, 'z': landed_z, 'after': landed_after})
                page.reload(wait_until='networkidle')
                ready(page, mode)
                expect(canvas).to_have_attribute('data-robot-chassis-clearance', '0.001000')
                expect(warning).to_have_count(0)
                expect(canvas).to_have_attribute('data-robot-height-locked', 'true')
            assert not errors, errors
            print('PASS: map/independent clearance warnings, landing with height lock, preserved pose/joints, undo, persistence and mode changes')
        except Exception:
            page.screenshot(path=str(artifacts / 'failure.png'))
            print('Browser errors:', errors)
            print('Robot:', page.locator('.three-canvas').evaluate('el => ({z: el.dataset.robotZ, clearance: el.dataset.robotChassisClearance, undo: el.dataset.robotDragUndoDepth})'))
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
