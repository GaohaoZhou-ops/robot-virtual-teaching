import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from export_separation_ui_smoke import CHROME, ROOT, load_project


def make_fixtures(directory):
    subprocess.run(['node', '--input-type=module', '-e', '''
      import { writeFile } from 'node:fs/promises';
      import { teachingTransferFixture } from './tests/teaching_transfer_helpers.mjs';
      import { buildProjectArchive } from './src/lib/projectArchive.js';
      for (const state of ['near', 'mixed', 'safe']) {
        const fixture = teachingTransferFixture('map');
        const project = fixture.config.config.project;
        const geometry = '<geometry><box size="0.2 0.2 0.2"/></geometry>';
        fixture.map.portableRobotPackage.files[0].bytes = new TextEncoder().encode(
          '<robot name="distance_fixture"><link name="base_link"/>' +
          [['left_L1', 0.6], ['right_L1', -0.6], ['torso_link', 0]].map(([name, y]) =>
            `<link name="${name}"><visual>${geometry}</visual><collision>${geometry}</collision></link>` +
            `<joint name="${name}_mount" type="fixed"><parent link="base_link"/><child link="${name}"/>` +
            `<origin xyz="0 ${y} 1"/></joint>`).join('') + '</robot>');
        const x = state === 'safe' ? 0.5 : 0.15;
        const positions = new Float32Array([
          state === 'mixed' ? 0 : x, 0.6, 1, x, -0.6, 1, x, 0, 1,
          -2, -2, 0, 2, 2, 2,
        ]);
        const bounds = { min: { x: -2, y: -2, z: 0 }, max: { x: 2, y: 2, z: 2 } };
        Object.assign(fixture.map, {
          positionBuffer: positions.buffer, colorBuffer: null, indexBuffer: null,
          indexComponentType: null, pointCount: 5, faceCount: 0, bounds,
        });
        Object.assign(project.map, { pointCount: 5, faceCount: 0, bounds });
        project.robot.origin = { position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
        project.robot.joints = {};
        project.virtualTeaching.tasks = [];
        project.virtualTeaching.jointPoses = [];
        const archive = await buildProjectArchive(project, {
          mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage,
        });
        await writeFile(`${process.argv[1]}/${state}.zip`, archive.bytes);
      }
    ''', str(directory)], cwd=ROOT, check=True)


def run():
    with tempfile.TemporaryDirectory(prefix='atlas-distance-warning-') as temporary:
        directory = Path(temporary)
        make_fixtures(directory)
        with sync_playwright() as playwright:
            executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
            if not executable and CHROME.exists():
                executable = str(CHROME)
            browser = playwright.chromium.launch(headless=True, executable_path=executable)
            errors = []
            for state in ('near', 'mixed', 'safe'):
                context = browser.new_context(viewport={'width': 1600, 'height': 960})
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                load_project(page, 'map', directory / f'{state}.zip')
                canvas = page.locator('.three-canvas')
                expected_state = 'collision' if state == 'mixed' else state
                expect(canvas).to_have_attribute('data-collision-state', expected_state)
                warning = page.get_by_label('机器人距离警告', exact=True)
                if state == 'safe':
                    expect(warning).to_have_count(0)
                else:
                    expect(warning).to_have_count(1)
                    expect(warning).to_be_visible()
                    expect(warning.locator('[data-collision-side="left"]')).to_have_attribute(
                        'data-collision-state', 'collision' if state == 'mixed' else 'near')
                    expect(warning.locator('[data-collision-side="right"]')).to_have_attribute('data-collision-state', 'near')
                    expect(warning.locator('[data-collision-side="body"]')).to_have_attribute('data-collision-state', 'near')
                    for width in (1600, 1024):
                        page.set_viewport_size({'width': width, 'height': 960})
                        bounds, viewport = warning.evaluate('''(el) => [
                            el.getBoundingClientRect().toJSON(),
                            el.closest('.point-cloud-view').getBoundingClientRect().toJSON(),
                        ]''')
                        assert abs(bounds['y'] - viewport['y'] - 10) < 2
                        assert abs(viewport['x'] + viewport['width'] - bounds['x'] - bounds['width'] - 12) < 2
                        assert bounds['x'] >= viewport['x']
                        assert warning.evaluate('(el) => getComputedStyle(el).pointerEvents') == 'none'
                    page.set_viewport_size({'width': 1600, 'height': 960})
                    page.screenshot(path=f'/tmp/atlas-distance-warning-{state}.png', full_page=True)
                    page.get_by_role('button', name='显示设置', exact=True).click()
                    switch = page.get_by_role('switch', name='显示距离警告', exact=True)
                    expect(switch).to_be_checked()
                    switch.click()
                    expect(switch).not_to_be_checked()
                    expect(warning).to_have_count(0)
                    expect(canvas).to_have_attribute('data-collision-protection-enabled', 'true')
                    expect(canvas).to_have_attribute('data-collision-state', expected_state)
                    expect(canvas).to_have_attribute('data-collision-worker', 'dedicated')
                    page.get_by_role('button', name='关闭显示设置', exact=True).click()
                    page.get_by_role('button', name='显示设置', exact=True).click()
                    expect(switch).not_to_be_checked()
                    switch.focus()
                    page.keyboard.press('Space')
                    expect(switch).to_be_checked()
                    expect(warning).to_be_visible()
                    page.screenshot(path=f'/tmp/atlas-distance-warning-settings-{state}.png', full_page=True)
                assert page.locator('.zivid-camera-collision-alert').count() == 0
                context.close()
                print(f'distance_warning_{state}=ok', flush=True)
            assert not errors, errors
            browser.close()


if __name__ == '__main__':
    run()
