"""Tilted independent alignment: navigate, edit arms, record, place and export."""
import json
import math
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME
from parking_ghost_smoke import read_robot_pose
from teaching_transfer_ui_smoke import open_transfer, ready, snapshot
from topbar_tools_helpers import topbar_action


def export_package(page, folder, legacy=False):
    page.get_by_role('button', name='选择示教任务 倾斜路网示教', exact=True).click()
    page.get_by_role('button', name='导出示教数据', exact=True).click()
    dialog = page.get_by_role('dialog', name='导出机器人示教', exact=True)
    download = dialog.get_by_role('button', name='下载机器人导入包', exact=True)
    try:
        expect(download).to_be_enabled()
    except AssertionError as error:
        raise AssertionError(dialog.inner_text()) from error
    if legacy:
        expect(dialog.get_by_label('路网导出提示')).to_contain_text('历史示教记录中的高度偏移')
    expect(dialog.get_by_role('table', name='路网导航目标预览')).to_contain_text('N1 · 停车点1')
    with page.expect_download() as pending:
        download.click()
    path = Path(folder) / ('legacy.zip' if legacy else 'tilted.zip')
    pending.value.save_as(path)
    with zipfile.ZipFile(path) as bundle:
        manifest = json.loads(bundle.read('manifest.json'))
        task = manifest['tasks'][0]
        records = [json.loads(line) for line in bundle.read(task['file']).splitlines()]
        actions = [row['record'] for row in records if row['type'] == 'point']
        assert [action.get('type', 'pose') for action in actions] == ['route_navigation', 'pose', 'pose']
        assert actions[0]['node_id'] == 'N1'
        for action, angles in zip(actions[1:], [(15, -20), (35, -40)]):
            assert math.isclose(action['joints_rad']['left_arm'][0], math.radians(angles[0]), abs_tol=1e-8)
            assert math.isclose(action['joints_rad']['right_arm'][0], math.radians(angles[1]), abs_tol=1e-8)
        route = json.loads(bundle.read(task['navigation']['routes'][0]))
        assert len(route['nodes']) == 2 and len(route['edges']) == 1
        assert [node['id'] for node in route['nodes']] == [1, 31]
    page.screenshot(path=f'/tmp/atlas-tilted-route-export-{"legacy" if legacy else "new"}.png', full_page=True)
    return route


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-tilted-route-') as folder, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport=dict(width=1440, height=1000), accept_downloads=True)
        page.set_default_timeout(30000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(BASE_URL, wait_until='networkidle')
            page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            route = page.evaluate("""async () => {
              const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
              const { abxTeachingFixture } = await import('/tests/abx_teaching_helpers.mjs');
              const { abxRouteToProject } = await import('/src/features/navigation/model/abxRoute.js');
              const { buildExport } = await import('/src/features/workspace/model/io.js');
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const { payload, robotPackage, values } = abxTeachingFixture();
              const joints = Object.keys(values).map(name => `<link name="${name}_link"/>
                <joint name="${name}" type="revolute"><parent link="base_link"/><child link="${name}_link"/>
                <axis xyz="0 0 1"/><limit lower="-4" upper="4" effort="10" velocity="1"/></joint>`).join('');
              robotPackage.files[0].bytes = new TextEncoder().encode(`<robot name="botx_abx_zivid_m70">
                <link name="base_link"><visual><geometry><box size="0.3 0.2 0.1"/></geometry></visual></link>${joints}</robot>`);
              const route = {schema_version: 1, id: 'tilted-route', name: '倾斜路网', scene_name: 'map',
                nodes: [{id: 1, label: '停车点1', x_m: 5.744287014007568, y_m: -2.677, yaw_rad: 3.1328682899475098},
                  {id: 31, label: '停车点1', x_m: 6, y_m: -4, yaw_rad: 0.5}],
                edges: [{id: 257, start: 31, end: 1}]};
              const localToMap = {position: {x: 4.087704, y: -7.297507, z: 0.100661},
                rpy: {roll: -0.27501951721487344, pitch: -0.0019406646615915792, yaw: 179.27496036793707}};
              const map = teachingTransferFixture('map'), local = teachingTransferFixture('independent');
              for (const fixture of [map, local]) {
                const independent = fixture.mode === 'independent';
                fixture.map.portableRobotPackage = robotPackage;
                const graph = independent ? {waypoints: [], edges: [], abxRoutes: []} : abxRouteToProject(route);
                const project = buildExport({mapData: fixture.map, teachingSpaceMode: fixture.mode,
                  ...graph, heightRange: [0, 2], robot: payload.robot, robotJointValues: values,
                  robotPose: {position: {x: 0, y: 0, z: 0.3}, rpy: {roll: 0, pitch: 0, yaw: 0}},
                  teachingTasks: [], transfer: independent ? {version: 1, kind: 'alignment', localToMap,
                    sourceMap: {mapId: map.map.mapId, sourceHash: map.map.sourceHash, name: map.map.name}} : null});
                await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, fixture.mode);
                await store.saveWorkspaceConfig(sessionId, fixture.map.mapId,
                  {schemaVersion: 1, project, ui: {selectedRobot: project.robot, mapRouteSyncEnabled: independent}}, fixture.mode);
              }
              await store.activateWorkspaceMode(sessionId, 'independent');
              return route;
            }""")
            page.goto(BASE_URL + '/workbench', wait_until='networkidle')
            ready(page, 'independent')
            canvas = page.locator('.three-canvas')
            initial_height = read_robot_pose(canvas)['z']
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            search = page.get_by_label('搜索导航点', exact=True)
            option = search.locator('option').filter(has_text='N1 · 停车点1')
            expect(option).to_have_count(1)
            search.select_option(option.get_attribute('value'))
            page.get_by_role('button', name='运动到该点', exact=True).click()
            page.get_by_role('button', name='返回路径与导航', exact=True).click()
            expect(page.locator('.waypoint-chips button[aria-current="location"]')).to_contain_text('N1 · 停车点1')
            assert math.isclose(read_robot_pose(canvas)['z'], initial_height, abs_tol=1e-10)
            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='新建示教任务', exact=True).click()
            dialog = page.get_by_role('dialog', name='新建示教任务', exact=True)
            dialog.get_by_label('新示教任务名称').fill('倾斜路网示教')
            dialog.get_by_role('button', name='添加当前位置为停车点', exact=True).click()
            dialog.get_by_role('button', name='创建任务', exact=True).click()
            expect(page.get_by_role('button', name='选择当前停车点 N1 · 停车点1', exact=True)).to_be_visible()
            for left, right in [(15, -20), (35, -40)]:
                page.get_by_role('button', name='打开全关节浮动窗口', exact=True).click()
                for name, value in [('left_J1', left), ('right_J1', right)]:
                    field = page.get_by_role('spinbutton', name=f'{name} 关节值', exact=True)
                    field.fill(str(value))
                    field.press('Tab')
                page.get_by_role('button', name='关闭全关节浮动窗口', exact=True).click()
                page.get_by_role('button', name='记录当前姿态', exact=True).click()
            for _ in range(100):
                tasks = snapshot(page, 'independent')['project']['virtualTeaching']['tasks']
                if tasks and len(tasks[0]['parkingPoints'][0]['poses']) == 2:
                    break
                page.wait_for_timeout(100)
            else:
                raise AssertionError('Recorded poses did not persist')
            page.reload(wait_until='networkidle')
            ready(page, 'independent')
            page.get_by_role('tab', name='路径与导航', exact=True).click()
            if page.get_by_role('button', name='返回路径与导航', exact=True).count():
                page.get_by_role('button', name='返回路径与导航', exact=True).click()
            expect(page.locator('.waypoint-chips button[aria-current="location"]')).to_contain_text('N1 · 停车点1')
            dialog = open_transfer(page)
            expect(dialog.get_by_text('已沿用绑定关系，可直接放置。', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='放置并进入地图', exact=True).click()
            ready(page, 'map')
            saved = snapshot(page, 'map')['project']
            stop = saved['virtualTeaching']['tasks'][0]['parkingPoints'][0]
            assert len(stop['poses']) == 2
            for pose in [stop['mapPose']] + [item['mapPose'] for item in stop['poses']]:
                assert math.isclose(pose['position']['x'], route['nodes'][0]['x_m'], abs_tol=1e-10)
                assert math.isclose(pose['position']['y'], route['nodes'][0]['y_m'], abs_tol=1e-10)
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            page.locator('.loading-curtain').wait_for(state='hidden')
            assert export_package(page, folder) == route
            page.keyboard.press('Escape')

            # Reload a copy of the same task with the historical height error.
            # Only this isolated browser's IndexedDB is changed.
            page.goto(BASE_URL, wait_until='networkidle')
            legacy = page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { transferMatrix, transformTeachingPose } = await import('/src/features/teaching/model/teachingTransfer.js');
              const { sessionId } = await store.fetchServiceSession();
              const saved = await store.loadWorkspaceConfig(sessionId, 'map');
              const project = saved.config.project, matrix = transferMatrix(project.workspace.transfer.localToMap);
              const node = project.abxRoutes[0].nodes[0];
              const original = transformTeachingPose({position: {x: node.x_m, y: node.y_m, z: 0},
                rpy: {roll: 0, pitch: 0, yaw: node.yaw_rad * 180 / Math.PI}}, matrix.clone().invert());
              original.position.z = 0.3;
              const legacy = transformTeachingPose(original, matrix, 'map');
              const parking = project.virtualTeaching.tasks[0].parkingPoints[0];
              parking.mapPose = legacy;
              parking.poses.forEach(pose => { pose.mapPose = structuredClone(legacy); });
              const marker = project.waypoints.find(point => point.id === parking.id);
              if (marker) marker.pose = {...legacy.position, ...legacy.rpy};
              await store.saveWorkspaceConfig(sessionId, saved.mapId, saved.config, 'map');
              return legacy;
            }""")
            page.goto(BASE_URL + '/teaching-data', wait_until='networkidle')
            page.locator('.loading-curtain').wait_for(state='hidden')
            assert export_package(page, folder, legacy=True) == route
            after = snapshot(page, 'map')['project']
            assert after['virtualTeaching']['tasks'][0]['parkingPoints'][0]['mapPose'] == legacy
            assert after['abxRoutes'] == [route]
            assert not errors, errors
        finally:
            browser.close()
    print('PASS: tilted navigation preserves height, arm captures and arrival; new/legacy ZIPs retain N1 and the original route')


if __name__ == '__main__':
    run()
