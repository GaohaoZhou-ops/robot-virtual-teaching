"""Import/export native task and route files using a fresh browser profile."""
import io
import json
from pathlib import Path
import tempfile
import time
import zipfile

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME, seed


with tempfile.TemporaryDirectory(prefix='atlas-abx-exchange-ui-') as folder, sync_playwright() as p:
    browser = p.chromium.launch(executable_path=str(CHROME), headless=True)
    page = browser.new_page(viewport=dict(width=1440, height=1000), accept_downloads=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        seed(page)
        fixture = page.evaluate("""async () => {
          const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
          const { buildAbxTeachingExport } = await import('/src/lib/abxTeachingExport.js');
          const { payload, robotPackage } = abxTeachingFixture();
          const bundle = await buildAbxTeachingExport(payload, { robotPackage });
          return Object.entries(bundle.files).map(([name, bytes]) => ({ name: name.slice(4), bytes: Array.from(bytes) }));
        }""")
        # A newer native input carries a route; the UI must still read it and
        # export the supported task records as v11 without embedding that route.
        native_input = io.BytesIO()
        with zipfile.ZipFile(native_input, 'w', zipfile.ZIP_STORED) as bundle:
            for entry in fixture:
                bundle.writestr(entry['name'], bytes(entry['bytes']))
        page.get_by_label('机器人示教文件', exact=True).set_input_files(dict(
            name='robot-fixture.zip', mimeType='application/zip', buffer=native_input.getvalue()))
        expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '4')
        expect(page.get_by_role('status').filter(has_text='机器人示教已导入')).to_be_visible()
        expect(page.get_by_role('note').filter(has_text='机器人原生任务')).to_be_visible()
        page.get_by_text('查看原生步骤顺序', exact=True).click()
        expect(page.get_by_role('note').filter(has_text='机器人原生任务')).to_contain_text('route_navigation')
        # Wait for the actual persisted state, then reload through the normal UI.
        def saved_task_count():
            return page.evaluate("""async () => {
          const store = await import('/src/lib/sessionStore.js');
          const { sessionId } = await store.fetchServiceSession();
          const saved = await store.loadWorkspaceSnapshot(sessionId, 'map');
          return saved?.config?.config?.project?.virtualTeaching?.tasks?.length;
        }""")
        deadline = time.monotonic() + 10
        while saved_task_count() != 4 and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        assert saved_task_count() == 4
        page.reload(wait_until='networkidle')
        expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '4')
        expect(page.get_by_role('note').filter(has_text='机器人原生任务')).to_be_visible()
        page.get_by_role('button', name='导出示教数据', exact=True).click()
        dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
        download_button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
        expect(download_button).to_be_enabled(timeout=20000)
        with page.expect_download() as pending:
            download_button.click()
        target = Path(folder) / 'tasks.zip'
        pending.value.save_as(target)
        with zipfile.ZipFile(target) as bundle:
            manifest = json.loads(bundle.read('manifest.json'))
            assert len(manifest['tasks']) == 4
            assert set(bundle.namelist()) == {'manifest.json', 'README.txt', *[entry['file'] for entry in manifest['tasks']]}
            assert all(json.loads(bundle.read(entry['file']).splitlines()[0])['version'] == 11 for entry in manifest['tasks'])
        page.keyboard.press('Escape')
        page.get_by_role('button', name='继续工作 · 返回主工作台继续示教', exact=True).click()
        page.get_by_role('button', name='示教菜单', exact=True).click()
        expect(page.get_by_role('button', name='导入机器人路径', exact=True)).to_be_enabled()
        page.get_by_role('button', name='导出机器人路径', exact=True).click()
        route_dialog = page.get_by_role('dialog', name='导出机器人路径', exact=True)
        with page.expect_download() as pending:
            route_dialog.get_by_role('button', name='下载机器人路径文件').click()
        route_path = Path(folder) / pending.value.suggested_filename
        pending.value.save_as(route_path)
        route = json.loads(route_path.read_text())
        assert set(route) == {'schema_version', 'id', 'name', 'scene_name', 'nodes', 'edges'}
        assert route_path.name.endswith('.route.json')
        page.keyboard.press('Escape')
        # Import an additional route; no existing points or tasks are replaced.
        route.update(id='ui-route', name='往返测试路径', scene_name='现场地图')
        route['nodes'] = [dict(id=0, label='', x_m=10, y_m=20, yaw_rad=None),
                          dict(id=42, label='工位', x_m=12, y_m=20, yaw_rad=1.5)]
        route['edges'] = [dict(id=100, start=0, end=42)]
        inspector = page.get_by_role('complementary', name='图谱控制台', exact=True)
        with page.expect_file_chooser() as chooser:
            inspector.get_by_role('button', name='导入路径', exact=True).click()
        chooser.value.set_files(dict(
            name='ui-route.route.json', mimeType='application/json', buffer=json.dumps(route).encode()))
        expect(page.get_by_role('status').filter(has_text='机器人路径已导入')).to_be_visible()
        expect(inspector).to_have_attribute('data-active-page', 'navigation')
        expect(inspector.get_by_label('搜索导航点')).to_contain_text('工位')
        page.get_by_role('button', name='示教菜单', exact=True).click()
        page.get_by_role('button', name='导出机器人路径', exact=True).click()
        route_dialog.get_by_label('选择导出路网').select_option(label='往返测试路径')
        with page.expect_download() as pending:
            route_dialog.get_by_role('button', name='下载机器人路径文件').click()
        roundtrip = Path(folder) / 'roundtrip.route.json'
        pending.value.save_as(roundtrip)
        assert json.loads(roundtrip.read_text()) == route
        page.screenshot(path='/tmp/atlas-abx-exchange-paths.png', full_page=True)
        page.keyboard.press('Escape')
        invalid = dict(route, edges=[dict(id=100, start=0, end=999)])
        page.get_by_label('机器人路径文件', exact=True).set_input_files(dict(
            name='invalid.route.json', mimeType='application/json', buffer=json.dumps(invalid).encode()))
        expect(page.get_by_role('status').filter(has_text='机器人路径导入失败')).to_be_visible()
        assert not errors, errors
        print('Native task import, persisted reload, mixed export, route UI round-trip and invalid-file rejection passed')
    finally:
        browser.close()
