"""Exercise exports in a fresh browser profile; never open the user's workspaces."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
CHROME = Path(os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
SHOTS = Path(os.environ.get('OUTPUT_DIR', '/tmp/atlas-abx-ui-shots'))


def seed(page, invalid=False):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate('''async invalid => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransferFixture('map');
      const { payload, robotPackage } = abxTeachingFixture();
      for (const task of payload.virtualTeaching.tasks) {
        task.parkingPoints.sort((a, b) => a.sequence - b.sequence);
        for (const parking of task.parkingPoints) parking.poses.sort((a, b) => a.sequence - b.sequence);
      }
      fixture.map.name = payload.map.fileName;
      fixture.map.sourceHash = payload.map.sourceHash;
      fixture.map.portableRobotPackage = robotPackage;
      fixture.config.config.project = payload;
      fixture.config.config.ui.selectedRobot = payload.robot;
      if (invalid) delete payload.virtualTeaching.tasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.head_yaw_J;
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'map');
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, 'map');
      await store.activateWorkspaceMode(sessionId, 'map');
    }''', invalid)
    page.goto(BASE_URL + '/teaching-data', wait_until='networkidle')
    page.locator('.loading-curtain').wait_for(state='hidden')
    page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True).click()
    page.get_by_role('button', name='导出示教数据', exact=True).wait_for()


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-abx-ui-') as directory, sync_playwright() as playwright:
        options = dict(headless=True)
        if CHROME.exists():
            options['executable_path'] = str(CHROME)
        browser = playwright.chromium.launch(**options)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page)
            export = page.get_by_role('button', name='导出示教数据', exact=True)
            export.click()
            dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
            bundle_button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
            expect(bundle_button).to_be_enabled()
            expect(dialog.get_by_role('table', name='路网导航目标预览')).to_be_visible()
            expect(dialog.get_by_role('note')).to_contain_text('任务与路网导入包')
            expect(dialog.get_by_role('note')).to_contain_text('任务及其路网会一并导入并自动关联')
            expect(dialog.get_by_label('随包路网')).to_contain_text('1 个路网')
            expect(dialog.get_by_label('路网导出提示')).to_contain_text('没有入向连线')
            page.screenshot(path=str(SHOTS / 'robot-export-desktop.png'), full_page=True)
            with page.expect_download() as waiting:
                bundle_button.click()
            download = waiting.value
            assert download.suggested_filename.startswith('robot-teaching-')
            bundle_path = Path(directory) / download.suggested_filename
            download.save_as(bundle_path)
            with zipfile.ZipFile(bundle_path) as bundle:
                manifest = json.loads(bundle.read('manifest.json'))
                assert manifest['schema'] == 'abx-teaching-export' and len(manifest['tasks']) == 2
                assert all(entry.compress_type == zipfile.ZIP_STORED for entry in bundle.infolist())
                task = bundle.read(manifest['tasks'][0]['file']).decode()
                lines = task.splitlines(keepends=True)
                records = [json.loads(line) for line in lines]
                assert records[0]['version'] == 23 and records[0]['point_count'] == '5'
                assert 'navigation.json' in bundle.namelist()
                assert records[0]['basic_pose_count'] == '0'
                chunks = [entry for entry in records if entry['type'] == 'navigation_chunk']
                assert records[0]['navigation']['chunks'] == str(len(chunks))
                navigation = json.loads(b''.join(base64.b64decode(chunk['data']) for chunk in chunks))
                assert len(navigation['routes']) == 1
                assert json.loads(bundle.read(manifest['tasks'][0]['navigation']['routes'][0])) == navigation['routes'][0]
                expect(dialog.get_by_label('随包路网')).to_contain_text(f"{len(navigation['routes'][0]['nodes'])} 个节点 · {len(navigation['routes'][0]['edges'])} 条有向边")
                assert records[-1]['sha256'] == hashlib.sha256(''.join(lines[1:-1]).encode()).hexdigest()
                actions = [entry['record'] for entry in records if entry['type'] == 'point']
                assert [action.get('type', 'pose') for action in actions] == ['route_navigation', 'pose', 'pose', 'route_navigation', 'pose']
                poses = [action for action in actions if 'joints_rad' in action]
                assert all('type' not in pose and pose['component'] == 'auto' for pose in poses)
                assert all(action['route_id'] == navigation['routes'][0]['id'] for action in actions if action.get('type') == 'route_navigation')
                assert math.isclose(poses[0]['joints_rad']['head'][0], math.radians(20))
            with page.expect_download() as waiting:
                dialog.get_by_role('button', name='下载导航清单', exact=True).click()
            nav_path = Path(directory) / 'navigation.json'
            waiting.value.save_as(nav_path)
            targets = json.loads(nav_path.read_text())
            assert targets['waypoints'][0]['target'] == {'x_m': 1.25, 'y_m': -2.5, 'yaw_rad': math.pi / 2}
            assert targets['nativeTaskNavigationSupported'] is True
            assert targets['routeImportIncluded'] is True and targets['taskVersion'] == 23
            assert targets['route']['edges'] == [{'id': 257, 'start': 1, 'end': 2}]
            page.set_viewport_size({'width': 1000, 'height': 768})
            expect(bundle_button).to_be_in_viewport()
            page.screenshot(path=str(SHOTS / 'robot-export-compact.png'), full_page=True)
            page.keyboard.press('Escape')
            expect(dialog).not_to_be_visible()
            expect(export).to_be_focused()
            reference = Path(__file__).resolve().parent.parent / '380B平地巡检.zip'
            if reference.exists():
                page.get_by_label('机器人示教文件', exact=True).set_input_files(str(reference))
                expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '3')
                export.click()
                expect(bundle_button).to_be_enabled()
                expect(dialog.get_by_role('table')).to_contain_text('N0')
                expect(dialog).to_contain_text('未提供对应地图坐标')
                with page.expect_download() as waiting:
                    bundle_button.click()
                reference_output = Path(directory) / 'reference-roundtrip.zip'
                waiting.value.save_as(reference_output)
                with zipfile.ZipFile(reference) as original, zipfile.ZipFile(reference_output) as output:
                    original_entry = json.loads(original.read('manifest.json'))['tasks'][0]
                    output_entry = next(entry for entry in json.loads(output.read('manifest.json'))['tasks']
                                        if entry['name'] == original_entry['name'])
                    assert output.read(output_entry['file']) == original.read(original_entry['file'])
                page.keyboard.press('Escape')
            seed(page, invalid=True)
            page.get_by_role('button', name='导出示教数据', exact=True).click()
            dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
            expect(dialog.get_by_role('alert')).to_contain_text('head_yaw_J')
            expect(dialog.get_by_role('button', name='下载机器人导入包', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='下载导航清单', exact=True)).to_be_disabled()
            assert not errors, errors
        finally:
            browser.close()
    print('Teaching Data Center export UI, native ZIP, route/Pose sequence, navigation JSON, compact layout and invalid Pose rejection passed')


if __name__ == '__main__':
    run()
