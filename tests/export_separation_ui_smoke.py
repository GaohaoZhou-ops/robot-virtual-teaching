from topbar_tools_helpers import topbar_action

from archive_helpers import start_project_download

import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def make_fixtures(directory):
    subprocess.run(['node', '--input-type=module', '-e', '''
      import { writeFile } from 'node:fs/promises';
      import { teachingTransferFixture } from './tests/teaching_transfer_helpers.mjs';
      import { buildProjectArchive } from './src/lib/projectArchive.js';
      import { buildTeachingDataExport } from './src/lib/teachingData.js';
      for (const mode of ['map', 'independent']) {
        const fixture = teachingTransferFixture(mode);
        const project = fixture.config.config.project;
        project.virtualTeaching.tasks.forEach(task => task.parkingPoints.forEach(parking =>
          parking.poses.forEach(pose => { pose.cameraCapture = null; })));
        const archive = await buildProjectArchive(project, {
          mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage,
        });
        await writeFile(`${process.argv[1]}/${mode}.zip`, archive.bytes);
        await writeFile(`${process.argv[1]}/${mode}-legacy-teaching.json`, JSON.stringify(buildTeachingDataExport(project)));
      }
    ''', str(directory)], cwd=ROOT, check=True)


def wait_ready(page):
    page.locator('[data-session-state="ready"]:visible').first.wait_for()
    page.locator('.loading-curtain').wait_for(state='hidden')


def load_project(page, mode, path):
    page.add_init_script('window.showOpenFilePicker = undefined;')
    page.goto(BASE_URL, wait_until='networkidle')
    wait_ready(page)
    assert len(page.get_by_role('radio').all_text_contents()) == 2
    page.get_by_role('radio', name='独立示教' if mode == 'independent' else '地图示教').click()
    page.get_by_role('button', name='加载工程', exact=True).click()
    with page.expect_file_chooser() as chooser:
        page.get_by_role('button', name='加载工程引导文件', exact=True).click()
    chooser.value.set_files(str(path))
    page.wait_for_url(f'{BASE_URL}/workbench')
    wait_ready(page)
    page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")


def run():
    with tempfile.TemporaryDirectory(prefix='atlas-export-separation-') as temporary:
        directory = Path(temporary)
        make_fixtures(directory)
        with sync_playwright() as p:
            options = {'headless': True}
            if CHROME.exists():
                options['executable_path'] = str(CHROME)
            browser = p.chromium.launch(**options)
            errors = []
            for mode in ('map', 'independent'):
                context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
                page = context.new_page()
                page.set_default_timeout(60_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                load_project(page, mode, directory / f'{mode}.zip')
                # Inspect the rendered controls before exercising the new entry points.
                print(f'{mode}_workbench_buttons=', topbar_action(page, name='另存为工程', exact=True).all_text_contents())
                assert topbar_action(page, name='另存为工程', exact=True).is_enabled()
                topbar_action(page, name='另存为工程', exact=True).scroll_into_view_if_needed()
                page.screenshot(path=f'/tmp/atlas-export-{mode}-workbench.png', full_page=True)
                with page.expect_download() as download:
                    start_project_download(page)
                archive_path = directory / f'{mode}-exported.zip'
                download.value.save_as(archive_path)
                assert download.value.suggested_filename.startswith(f'atlas-project-{mode}-')
                with zipfile.ZipFile(archive_path) as archive:
                    names = set(archive.namelist())
                    assert 'environment/positions.f32le' in names
                    assert 'robot/files/transfer/robot.urdf' in names
                    assert not any(name.startswith('abx/') for name in names)
                    project = json.loads(archive.read('config/project.json'))
                    assert project['workspace']['teachingSpaceMode'] == mode
                    assert project['virtualTeaching']['tasks'][0]['id'] == f'{mode}-task'

                topbar_action(page, name='打开示教数据管理页').click()
                data_page = page.locator('[data-app-page="teaching-data"]')
                data_page.wait_for()
                tree = data_page.locator('.teaching-archive-tree')
                assert tree.get_by_role('button', name='导出工程', exact=True).count() == 0
                assert data_page.get_by_role('button', name='导出工程', exact=True).is_visible()
                tree.locator('.teaching-tree-node--task .teaching-tree-label').first.click()
                if mode == 'map':
                    tree.get_by_role('button', name='导出示教数据', exact=True).click()
                    dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
                    # This fixture intentionally has a generic "shoulder" joint,
                    # so native export is blocked while its full backup works.
                    expect(dialog.get_by_role('alert')).to_contain_text('ABX 20 关节格式无法表达')
                    expect(dialog.get_by_role('button', name='下载机器人导入包')).to_be_disabled()
                    page.keyboard.press('Escape')
                    lightweight_path = directory / 'map-legacy-teaching.json'
                else:
                    with page.expect_download() as download:
                        tree.get_by_role('button', name='导出示教数据', exact=True).click()
                    assert download.value.suggested_filename.startswith(f'atlas-teaching-{mode}-')
                    lightweight_path = directory / f'{mode}-teaching.json'
                    download.value.save_as(lightweight_path)
                    data = json.loads(lightweight_path.read_text())
                    assert data['format'] == 'atlas-route-studio-teaching-data'
                    assert data['source']['teachingSpaceMode'] == mode
                    assert data['statistics']['parkingPointCount'] == 2
                    assert data['statistics']['poseCount'] == 2
                    assert data['tasks'][0]['parkingPoints'][0]['poses'][0]['fullBodyJoints']['values']['shoulder'] == 12
                    assert data['robot']['mapPose']['position']['x'] == 10
                    assert 'cameraCapture' not in lightweight_path.read_text()
                    assert 'view3d' not in data
                toolbar = tree.locator('.teaching-tree-toolbar').bounding_box()
                workspace = tree.locator('.teaching-tree-workspace').bounding_box()
                archive = tree.bounding_box()
                assert toolbar and workspace and archive
                assert abs(workspace['y'] - toolbar['y'] - toolbar['height']) < 2, 'workspace must follow the toolbar without a gap'
                assert abs(archive['y'] + archive['height'] - workspace['y'] - workspace['height']) < 2, 'archive must not retain an empty grid row'
                page.screenshot(path=f'/tmp/atlas-export-{mode}-data.png', full_page=True)

                # Import on a fresh browser profile with no project cache or robot files.
                other = browser.new_context(viewport={'width': 1440, 'height': 1000})
                restored = other.new_page()
                restored.set_default_timeout(60_000)
                restored.on('pageerror', lambda error: errors.append(str(error)))
                robot_requests = []
                restored.on('request', lambda request: robot_requests.append(request.url)
                    if '/__atlas/robot-files/transfer/' in request.url else None)
                load_project(restored, mode, archive_path)
                assert not robot_requests, 'complete project must use its bundled robot resources'
                assert restored.locator('.map-identity strong').inner_text() == f'{mode}-transfer.ply'

                # A lightweight export cannot silently replace the working project.
                restored.locator('input[data-project-guide-input="true"]').set_input_files(str(lightweight_path))
                restored.get_by_text('这是轻量示教数据文件', exact=False).wait_for()
                restored.get_by_role('button', name='关闭工程加载错误', exact=True).click()
                wait_ready(restored)
                assert restored.locator('.map-identity strong').inner_text() == f'{mode}-transfer.ply'
                topbar_action(restored, name='打开示教数据管理页').click()
                assert restored.locator('.teaching-archive-tree').get_attribute('data-teaching-task-count') == '1'
                other.close()
                context.close()
                print(f'{mode}_project_and_teaching_exports=ok')
                print(f'{mode}_fresh_profile_restore_and_wrong_file_rejection=ok')
            assert not errors, errors
            browser.close()


if __name__ == '__main__':
    run()
