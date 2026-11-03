"""Export measured stations after ordinary/aligned movement and legacy restore."""
import base64
import json
import os
from pathlib import Path
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME
from topbar_tools_helpers import topbar_action
from map_teaching_transform_ui_smoke import SAMPLE, choose
from teaching_transfer_ui_smoke import ready


def run(alignment=''):
    wanted = [31, 98] if alignment else [31, 62]
    reference = Path(__file__).resolve().parent.parent / '1019平地路网终版测试.json'
    if reference.exists():
        route = json.loads(reference.read_text())
    else:
        route = dict(schema_version=1, id='ui-route', name='重名路网', scene_name='map',
                     nodes=[dict(id=i, label='停车点1', x_m=x, y_m=20, yaw_rad=0.5)
                            for i, x in [(1, 10), (31, 15), (62, 20), (98, 25)]],
                     edges=[dict(id=40, start=31, end=62)])
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-route-identity-') as folder, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport=dict(width=1440, height=1000), accept_downloads=True)
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(BASE_URL, wait_until='networkidle')
            page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            page.evaluate("""async () => {
              const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
              const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const fixture = teachingTransferFixture('map');
              const { payload, robotPackage, values } = abxTeachingFixture();
              const joints = Object.keys(values).map(name => `<link name="${name}_link"/>
                <joint name="${name}" type="revolute"><parent link="base_link"/><child link="${name}_link"/>
                <axis xyz="0 0 1"/><limit lower="-4" upper="4" effort="10" velocity="1"/></joint>`).join('');
              robotPackage.files[0].bytes = new TextEncoder().encode(`<robot name="botx_abx_zivid_m70">
                <link name="base_link"><visual><geometry><box size="0.3 0.2 0.1"/></geometry></visual></link>${joints}</robot>`);
              payload.virtualTeaching.tasks = []; payload.waypoints = []; payload.paths = [];
              fixture.map.name = payload.map.fileName; fixture.map.sourceHash = payload.map.sourceHash;
              fixture.map.portableRobotPackage = robotPackage;
              fixture.config.config.project = payload; fixture.config.config.ui.selectedRobot = payload.robot;
              await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'map');
              await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, 'map');
              await store.activateWorkspaceMode(sessionId, 'map');
            }""")
            page.goto(BASE_URL + '/workbench', wait_until='networkidle')
            page.locator('.loading-curtain').wait_for(state='hidden')
            page.locator('.three-canvas[data-robot-model-state="loaded"]').wait_for()
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            page.get_by_label('机器人路径文件', exact=True).set_input_files(dict(
                name='1019平地路网终版测试.json', mimeType='application/json',
                buffer=json.dumps(route, ensure_ascii=False).encode()))
            search = page.get_by_label('搜索导航点', exact=True)
            for node_id in [1, 31, 62, 98]:
                expect(search).to_contain_text(f'N{node_id} · 停车点1')
            if alignment:
                choose(page, str(SAMPLE))
            for index, node_id in enumerate(wanted):
                page.get_by_role('tab', name='路径与导航', exact=True).click()
                search.select_option(f'abx-route:{route["id"]}:N{node_id}')
                expect(page.locator('.property-editor h3')).to_contain_text(f'N{node_id} · 停车点1')
                page.get_by_role('button', name='运动到该点', exact=True).click()
                page.get_by_role('tab', name='示教', exact=True).click()
                if index == 0:
                    page.get_by_role('button', name='新建示教任务', exact=True).click()
                    dialog = page.get_by_role('dialog', name='新建示教任务', exact=True)
                    dialog.get_by_label('新示教任务名称').fill('路网编号回归')
                    dialog.get_by_role('button', name='添加当前位置为停车点', exact=True).click()
                    dialog.get_by_role('button', name='创建任务', exact=True).click()
                else:
                    page.get_by_role('button', name='新增停车点', exact=True).click()
                expect(page.get_by_role('button', name=f'选择当前停车点 N{node_id} · 停车点1', exact=True)).to_be_visible()
                page.get_by_role('button', name='记录当前姿态', exact=True).click()
            saved = page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const {sessionId} = await store.fetchServiceSession();
              const deadline = Date.now() + 20000;
              while (Date.now() < deadline) {
                const saved = await store.loadWorkspaceConfig(sessionId, 'map');
                if (saved?.config.project.virtualTeaching.tasks[0]?.parkingPoints?.filter(p => p.poses.length === 1).length === 2) return saved;
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              throw new Error('The two recorded stations were not persisted');
            }""")
            if alignment == 'legacy':
                # Restore already-saved captures from the old map-mode command:
                # the displayed route XY was retained while only Z changed.
                # Unload the editor first so autosave cannot replace the fixture.
                page.goto(BASE_URL + '/tests/fixtures/virtual2map.txt')
                page.evaluate("""async saved => {
                  const store = await import('/src/features/workspace/model/sessionStore.js');
                  const {sessionId} = await store.fetchServiceSession();
                  const project = saved.config.project;
                  for (const parking of project.virtualTeaching.tasks[0].parkingPoints) {
                    const node = project.waypoints.find(point => point.abx && point.name === parking.name);
                    parking.mapPose.position.x = node.pose.x;
                    parking.mapPose.position.y = node.pose.y;
                    parking.poses.forEach(pose => { pose.mapPose = structuredClone(parking.mapPose); });
                  }
                  await store.saveWorkspaceConfig(sessionId, saved.mapId, saved.config, 'map');
                }""", saved)
                page.goto(BASE_URL + '/workbench', wait_until='networkidle')
                ready(page, 'map')
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            page.locator('.loading-curtain').wait_for(state='hidden')
            expect(page.locator('[data-page="teaching-data"]')).to_have_attribute('data-teaching-task-count', '1')
            page.get_by_role('button', name='选择示教任务 路网编号回归', exact=True).click()
            page.get_by_role('button', name='导出示教数据', exact=True).click()
            dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
            button = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
            try:
                expect(button).to_be_enabled()
            except AssertionError as error:
                page.screenshot(path='/tmp/atlas-abx-route-identity-error.png', full_page=True)
                raise AssertionError(dialog.inner_text()) from error
            table = dialog.get_by_role('table', name='路网导航目标预览')
            expect(dialog.get_by_label('随包路网')).to_contain_text(f"1 个路网 · {len(route['nodes'])} 个节点 · {len(route['edges'])} 条有向边")
            for node_id in wanted:
                expect(table).to_contain_text(f'N{node_id} · 停车点1')
            with page.expect_download() as pending:
                button.click()
            output = Path(folder) / 'route-teaching.zip'
            pending.value.save_as(output)
            with zipfile.ZipFile(output) as bundle:
                manifest = json.loads(bundle.read('manifest.json'))
                rows = [json.loads(line) for line in bundle.read(manifest['tasks'][0]['file']).splitlines()]
                assert [row['name'] for row in rows if row['type'] == 'parking'] == [f'N{node_id} · 停车点1' for node_id in wanted]
                assert [row['record']['node_id'] for row in rows if row.get('record', {}).get('type') == 'route_navigation'] == [f'N{node_id}' for node_id in wanted]
                assert rows[0]['version'] == 23
                context = json.loads(b''.join(base64.b64decode(row['data']) for row in rows if row['type'] == 'navigation_chunk'))
                assert context['routes'] == [route], 'the complete graph, not just visited stations, must be embedded'
                assert json.loads(bundle.read(manifest['tasks'][0]['navigation']['routes'][0])) == route
                navigation = json.loads(bundle.read('navigation.json'))
                assert navigation['routeImportIncluded'] is True
                assert any('历史示教记录中的高度偏移' in warning for warning in navigation['warnings']) == (alignment == 'legacy')
            saved_route = page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const saved = await store.loadWorkspaceConfig((await store.fetchServiceSession()).sessionId, 'map');
              const { buildAbxRouteDocuments } = await import('/src/features/navigation/model/abxRoute.js');
              return (await buildAbxRouteDocuments(saved.config.project)).routes[0];
            }""")
            assert saved_route == route, 'teaching must not change the native road graph or create duplicate stations'
            page.screenshot(path=f'/tmp/atlas-abx-route-identity-{alignment or "original"}.png', full_page=True)
            assert not errors, errors
        finally:
            browser.close()
    print(f'Route {wanted}, {alignment or "original"} movement/captures, persisted snapshot, ZIP station mapping and unchanged measured graph passed')


if __name__ == '__main__':
    run(os.environ.get('ATLAS_MAP_DISPLAY_ALIGNMENT', ''))
