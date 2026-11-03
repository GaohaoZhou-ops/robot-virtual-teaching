"""Import a supplied legacy project and verify its unchanged robot coordinates."""
import json
from pathlib import Path
import sys
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright
from export_separation_ui_smoke import CHROME, load_project, wait_ready
from topbar_tools_helpers import topbar_action


def run(project_path):
    with zipfile.ZipFile(project_path) as bundle:
        source = json.loads(bundle.read('workspaces/map/config/project.json'))
    source_task = source['virtualTeaching']['tasks'][0]
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-route-identity-') as folder, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport=dict(width=1440, height=1000), accept_downloads=True)
        page.set_default_timeout(60000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            load_project(page, 'map', project_path)
            page.reload(wait_until='networkidle')
            wait_ready(page)
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            page.get_by_role('button', name=f'选择示教任务 {source_task["name"]}', exact=True).click()
            page.get_by_role('button', name='导出示教数据', exact=True).click()
            dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
            button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
            try:
                expect(button).to_be_enabled(timeout=30000)
            except AssertionError as error:
                raise AssertionError(dialog.inner_text()) from error
            with page.expect_download() as pending:
                button.click()
            output = Path(folder) / 'robot-teaching.zip'
            pending.value.save_as(output)
            with zipfile.ZipFile(output) as bundle:
                routes = [json.loads(bundle.read(name)) for name in bundle.namelist() if name.endswith('.route.json')]
                assert routes == source['abxRoutes'], 'native road graph must remain exactly unchanged'
                mapping = json.loads(bundle.read('source-mapping.json'))
                parkings = mapping['tasks'][0]['parkings']
                assert len(parkings) == len(source_task['parkingPoints'])
                for parking, original in zip(parkings, source_task['parkingPoints']):
                    assert parking['mapPose'] == original['mapPose']
                    assert [pose['mapPose'] for pose in parking['poses']] == [pose['mapPose'] for pose in original['poses']]
                for name in bundle.namelist():
                    assert b'"mapTransform"' not in bundle.read(name), name
            page.screenshot(path='/tmp/atlas-reported-project-export.png', full_page=True)
            assert not errors, errors
        finally:
            browser.close()
    print('Supplied project imported, refreshed and downloaded; original road graph and captured poses preserved')


if __name__ == '__main__':
    run(Path(sys.argv[1]).resolve())
