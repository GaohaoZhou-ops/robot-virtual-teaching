"""Import/export native task and route files using a fresh browser profile."""
import io
import json
from pathlib import Path
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME, seed
from teaching_preset_insertion_ui_smoke import saved_project, wait_for_saved


with tempfile.TemporaryDirectory(prefix='atlas-abx-exchange-ui-') as folder, sync_playwright() as p:
    browser = p.chromium.launch(executable_path=str(CHROME), headless=True)
    page = browser.new_page(viewport=dict(width=1440, height=1000), accept_downloads=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        seed(page)
        toolbar = page.locator('.teaching-tree-toolbar')
        import_button = toolbar.get_by_role('button', name='导入机器人示教', exact=True)
        expect(import_button).to_be_enabled()
        # Preserve local edits even when the incoming tasks have the same names.
        page.get_by_role('button', name='选择停车点 停车点 A', exact=True).click()
        expect(import_button).to_have_count(0)
        page.get_by_label('停车点名称', exact=True).fill('本地已编辑停车点')
        page.get_by_label('停车点名称', exact=True).press('Enter')
        page.get_by_role('button', name='查看机械臂姿态 姿态 a1', exact=True).click()
        expect(import_button).to_have_count(0)
        page.get_by_label('机械臂姿态名称', exact=True).fill('本地已编辑姿态')
        page.get_by_label('机械臂姿态名称', exact=True).press('Enter')
        page.get_by_role('button', name='选择示教任务 装配任务：中文校验', exact=True).click()
        expect(import_button).to_be_enabled()
        original = wait_for_saved(page, lambda project:
                                  project['virtualTeaching']['tasks'][0]['parkingPoints'][0]['poses'][0]['name']
                                  == '本地已编辑姿态')
        original_tasks = original['virtualTeaching']['tasks']
        toolbar.screenshot(path='/tmp/atlas-task-import-toolbar.png')
        fixture = page.evaluate("""async () => {
          const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
          const { buildAbxTeachingExport } = await import('/src/features/teaching/model/abxTeachingExport.js');
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
        with page.expect_file_chooser() as chooser:
            import_button.click()
        chooser.value.set_files(dict(
            name='robot-fixture.zip', mimeType='application/zip', buffer=native_input.getvalue()))
        expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '4')
        expect(page.get_by_role('status').filter(has_text='机器人示教已导入')).to_contain_text('原有任务已保留')
        expect(page.get_by_role('note').filter(has_text='机器人原生任务')).to_be_visible()
        page.get_by_text('查看原生步骤顺序', exact=True).click()
        expect(page.get_by_role('note').filter(has_text='机器人原生任务')).to_contain_text('route_navigation')
        imported = wait_for_saved(page, lambda project: len(project['virtualTeaching']['tasks']) == 4)
        imported_tasks = imported['virtualTeaching']['tasks']
        assert imported_tasks[:2] == original_tasks, 'existing task, parking and pose data must remain unchanged'
        assert imported_tasks[2]['name'] == original_tasks[0]['name']
        # Reimport while the newly imported task is selected: it also must survive.
        expect(import_button).to_be_enabled()
        with page.expect_file_chooser() as chooser:
            import_button.click()
        chooser.value.set_files(dict(
            name='robot-fixture.zip', mimeType='application/zip', buffer=native_input.getvalue()))
        expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '6')
        repeated = wait_for_saved(page, lambda project: len(project['virtualTeaching']['tasks']) == 6)
        repeated_tasks = repeated['virtualTeaching']['tasks']
        assert repeated_tasks[:4] == imported_tasks
        assert len({task['id'] for task in repeated_tasks}) == 6
        assert repeated['abxRoutes'] == imported['abxRoutes']
        assert repeated['waypoints'] == imported['waypoints']
        assert repeated['paths'] == imported['paths']
        page.reload(wait_until='networkidle')
        expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '6')
        assert saved_project(page)['virtualTeaching']['tasks'] == repeated_tasks
        expect(page.get_by_role('note').filter(has_text='机器人原生任务')).to_be_visible()
        page.locator('.teaching-tree-branch--task[aria-expanded="true"] > .teaching-tree-node--task .teaching-tree-label').first.click()
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
            assert len(manifest['tasks']) == 6
            assert set(bundle.namelist()) == {'manifest.json', 'README.txt', *[entry['file'] for entry in manifest['tasks']]}
            assert all(json.loads(bundle.read(entry['file']).splitlines()[0])['version'] == 11 for entry in manifest['tasks'])
        page.keyboard.press('Escape')
        page.get_by_role('button', name='继续工作 · 返回主工作台继续示教', exact=True).click()
        page.get_by_role('button', name='示教菜单', exact=True).click()
        expect(page.get_by_role('button', name='导入机器人路径', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='导出机器人路径', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='导入机器人示教', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='导出机器人示教', exact=True)).to_have_count(0)
        expect(page.get_by_role('button', name='打开示教数据管理页', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='打开示教转换', exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        inspector = page.get_by_role('complementary', name='图谱控制台', exact=True)
        expect(inspector.get_by_role('group', name='路径导入导出', exact=True)).to_have_count(0)
        expect(inspector.locator('.inspector-heading').get_by_role('button', name='导入路径', exact=True)).to_have_count(0)
        inspector.get_by_role('tab', name='路径与导航', exact=True).click()
        actions = inspector.get_by_role('group', name='路径导入导出', exact=True)
        expect(actions.get_by_role('button', name='导入路径', exact=True)).to_be_enabled()
        expect(actions.get_by_role('button', name='导出路径', exact=True)).to_be_enabled()
        for width, height in [(1440, 1000), (1024, 768)]:
            page.set_viewport_size(dict(width=width, height=height))
            layout = inspector.evaluate("""node => {
              const rect = selector => {
                const { x, y, width, height, right, bottom } = node.querySelector(selector).getBoundingClientRect();
                return { x, y, width, height, right, bottom };
              };
              return { row: rect('.inspector-route-actions'), operations: rect('.inspector-navigation-actions'),
                first: rect('.inspector-route-actions button:first-child'),
                second: rect('.inspector-route-actions button:last-child') };
            }""")
            assert layout['first']['y'] == layout['second']['y']
            assert layout['first']['height'] == layout['second']['height'] == 32
            assert abs(layout['first']['width'] - layout['second']['width']) < 1
            assert layout['first']['right'] < layout['second']['x']
            assert layout['row']['bottom'] < layout['operations']['y']
            expect(inspector.get_by_role('button', name='路径测试', exact=True)).to_be_visible()
            expect(inspector.locator('.connectivity-card')).to_have_count(0)
            expect(actions.get_by_role('button', name='导出路径', exact=True)).to_be_in_viewport()
        inspector.screenshot(path='/tmp/atlas-route-actions.png')
        page.set_viewport_size(dict(width=1440, height=1000))
        inspector.get_by_role('tab', name='相机', exact=True).click()
        expect(actions).to_have_count(0)
        inspector.get_by_role('tab', name='路径与导航', exact=True).click()
        actions.get_by_role('button', name='导出路径', exact=True).click()
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
        with page.expect_file_chooser() as chooser:
            inspector.get_by_role('button', name='导入路径', exact=True).click()
        chooser.value.set_files(dict(
            name='ui-route.route.json', mimeType='application/json', buffer=json.dumps(route).encode()))
        expect(page.get_by_role('status').filter(has_text='机器人路径已导入')).to_be_visible()
        expect(inspector).to_have_attribute('data-active-page', 'navigation')
        expect(inspector.get_by_label('搜索导航点')).to_contain_text('工位')
        inspector.get_by_role('button', name='导出路径', exact=True).click()
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
        print('Task-only import, same-name/repeated import preservation, reload/export, topbar cleanup, route toolbar and file round-trip passed')
    finally:
        browser.close()
