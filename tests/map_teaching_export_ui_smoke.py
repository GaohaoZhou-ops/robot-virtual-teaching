"""Scene alignment must never change the robot files downloaded from the UI."""
import json
import tempfile
import zipfile
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME, seed
from map_teaching_transform_ui_smoke import QUARTER, SAMPLE, choose, matrix_file
from teaching_transfer_ui_smoke import ready, snapshot
from archive_helpers import start_project_download, read_exported_project


def robot_download(page, directory, name, aligned=False):
    page.goto(BASE_URL + '/teaching-data', wait_until='networkidle')
    page.locator('.loading-curtain').wait_for(state='hidden')
    page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True).click()
    page.get_by_role('button', name='导出示教数据', exact=True).click()
    dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
    button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
    expect(button).to_be_enabled()
    if aligned:
        expect(dialog.get_by_label('转换关系保存范围')).to_contain_text('对齐前的机器人地图坐标')
    with page.expect_download() as downloaded:
        button.click()
    archive = directory / name
    downloaded.value.save_as(archive)
    with zipfile.ZipFile(archive) as bundle:
        manifest = json.loads(bundle.read('manifest.json'))
        tasks = {task['file']: bundle.read(task['file']) for task in manifest['tasks']}
        navigation = json.loads(bundle.read('navigation.json'))
        assert 'config/project.json' not in bundle.namelist()
        for filename in bundle.namelist():
            text = bundle.read(filename).decode()
            assert 'mapTransform' not in text and 'sourceCoordinates' not in text
    with page.expect_download() as downloaded:
        dialog.get_by_role('button', name='下载导航清单', exact=True).click()
    nav_path = directory / (name + '.json')
    downloaded.value.save_as(nav_path)
    assert json.loads(nav_path.read_text()) == navigation
    if aligned:
        page.screenshot(path='/tmp/atlas-map-display-export.png', full_page=True)
    dialog.get_by_role('button', name='关闭机器人示教导出', exact=True).click()
    return tasks, navigation['routes']


def run():
    errors = []
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='atlas-display-export-') as temporary:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page)
            directory = Path(temporary)
            original = robot_download(page, directory, 'original.zip')
            page.goto(BASE_URL + '/workbench', wait_until='networkidle')
            ready(page, 'map')
            before = snapshot(page, 'map')
            choose(page, matrix_file(QUARTER))
            aligned = snapshot(page, 'map')
            assert aligned['project']['waypoints'] != before['project']['waypoints']
            assert aligned['project']['workspace']['mapTransform']['sourceCoordinates']['waypoints'] == [
                {'id': point['id'], 'pose': point['pose']} for point in before['project']['waypoints']]
            assert robot_download(page, directory, 'aligned.zip', aligned=True) == original
            page.goto(BASE_URL + '/workbench', wait_until='networkidle')
            ready(page, 'map')
            with page.expect_download() as downloaded:
                start_project_download(page, 'display-alignment')
            project = read_exported_project(downloaded.value)
            assert project['workspace']['mapTransform'] == aligned['project']['workspace']['mapTransform']
            assert project['waypoints'] == aligned['project']['waypoints']
            choose(page, str(SAMPLE))
            assert robot_download(page, directory, 'replaced.zip', aligned=True) == original
            assert not errors, errors
            print('PASS: aligned/replaced scene, unchanged robot task bytes and routes, navigation download, full project coordinates')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
