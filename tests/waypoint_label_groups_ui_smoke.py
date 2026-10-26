"""Repeated route/teaching labels in isolated map and independent workspaces."""
from viewer_tools_helpers import display_settings_section
import json

from playwright.sync_api import expect, sync_playwright
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from waypoint_names_ui_smoke import display_settings, switch_mode


def seed(page):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async () => {
      const { teachingTransfer3DFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const { abxRouteToProject } = await import('/src/lib/abxRoute.js');
      const { buildExport, normalizeTeachingTasks } = await import('/src/lib/io.js');
      const { buildTeachingWaypoints } = await import('/src/lib/teachingNavigation.js');
      const { transferMatrix, transformTeachingTasks } = await import('/src/lib/teachingTransfer.js');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const map = teachingTransfer3DFixture('map'), local = teachingTransfer3DFixture('independent');
      const route = {schema_version: 1, id: 'label-route', name: '重复标签测试', scene_name: 'map',
        nodes: [{id: 1, label: '停车点1', x_m: 10, y_m: 20, yaw_rad: 0},
          {id: 2, label: '停车点2', x_m: 13, y_m: 21, yaw_rad: 0},
          {id: 31, label: '停车点1', x_m: 20, y_m: 24, yaw_rad: 0}],
        edges: [{id: 257, start: 1, end: 2}, {id: 258, start: 2, end: 31}]};
      const graph = abxRouteToProject(route);
      const task = normalizeTeachingTasks(map.config.config.project)[0];
      task.id = 'label-task'; task.name = '路网站点示教';
      task.parkingPoints.forEach((parking, index) => {
        const point = graph.waypoints[index];
        parking.id = `parking-${index + 1}`; parking.name = point.name;
        parking.mapPose = {frameId: 'map', position: {x: point.pose.x + 0.003, y: point.pose.y - 0.002, z: 0.3},
          rpy: {roll: 0, pitch: 0, yaw: 0}};
        parking.poses.forEach(pose => {pose.mapPose = structuredClone(parking.mapPose); pose.cameraCapture = null;});
      });
      const localToMap = {position: {x: 0.5, y: -0.3, z: 0.1}, rpy: {roll: 5, pitch: -3, yaw: 2}};
      for (const fixture of [map, local]) {
        const independent = fixture === local;
        const tasks = independent ? transformTeachingTasks([task], transferMatrix(localToMap).invert(), 'independent', fixture.map) : [task];
        const waypoints = independent ? [] : buildTeachingWaypoints(graph.waypoints, tasks, {mapData: fixture.map, coordinateFrame: 'map'});
        const project = buildExport({mapData: fixture.map, teachingSpaceMode: fixture.mode, heightRange: [0, 3],
          waypoints, edges: independent ? [] : graph.edges, abxRoutes: independent ? [] : graph.abxRoutes,
          robot: fixture.config.config.project.robot, teachingTasks: tasks,
          transfer: independent ? {version: 1, kind: 'alignment', localToMap,
            sourceMap: {mapId: map.map.mapId, sourceHash: map.map.sourceHash}} : null});
        await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, fixture.mode);
        await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, {schemaVersion: 1, project,
          ui: {selectedRobot: project.robot, mapRouteSyncEnabled: independent}}, fixture.mode);
      }
      await store.activateWorkspaceMode(sessionId, 'map');
    }""")
    page.goto(BASE_URL + '/workbench', wait_until='networkidle')
    ready(page, 'map')


def check_labels(page, mode):
    labels = page.locator('.waypoint-name-label')
    expect(labels).to_have_count(3)
    assert sorted(labels.all_text_contents()) == ['N1 · 停车点1', 'N2 · 停车点2', 'N31 · 停车点1']
    expect(page.locator('.three-canvas')).to_have_attribute('data-rendered-waypoint-count', '7' if mode == 'independent' else '5')
    expect(page.locator('.three-canvas')).to_have_attribute('data-route-edge-count', '2')
    page.get_by_role('tab', name='示教', exact=True).click()
    for index in (1, 2):
        name = f'N{index} · 停车点{index}'
        label = labels.filter(has_text=name)
        members = json.loads(label.get_attribute('data-waypoint-ids'))
        assert f'parking-{index}' in members
        assert len(members) == (3 if mode == 'independent' else 2)
        page.get_by_role('button', name=f'选择当前停车点 {name}', exact=True).click()
        expect(label).to_have_class('waypoint-name-label is-selected')
        expect(label).to_have_css('visibility', 'visible')
        expect(label).to_have_css('pointer-events', 'none')
        expect(page.locator('.three-canvas')).to_have_attribute('data-selected-waypoint-pulse-state', 'active')
    page.screenshot(path=f'/tmp/atlas-waypoint-labels-{mode}.png', full_page=True)
    # Navigation and teaching selection highlight the same shared label.
    label = labels.filter(has_text='N1 · 停车点1')
    route_id = label.get_attribute('data-waypoint-id')
    page.get_by_role('tab', name='路径与导航', exact=True).click()
    page.get_by_label('搜索导航点', exact=True).select_option(route_id)
    expect(label).to_have_class('waypoint-name-label is-selected')
    settings = display_settings(page)
    display_settings_section(page, '路径与标注').get_by_role('button', name='隐藏停车点名', exact=True).click()
    expect(labels).to_have_count(0)
    display_settings_section(page, '路径与标注').get_by_role('button', name='显示停车点名', exact=True).click()
    expect(labels).to_have_count(3)
    page.keyboard.press('Escape')


def recorded_data(page, mode):
    project = snapshot(page, mode)['project']
    return {key: project.get(key) for key in ['virtualTeaching', 'waypoints', 'abxRoutes', 'paths']}


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport=dict(width=1440, height=1000))
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page)
            # Normalize both cached workspaces before the immutable-data check.
            switch_mode(page, 'independent')
            switch_mode(page, 'map')
            original = {mode: recorded_data(page, mode) for mode in ['map', 'independent']}
            check_labels(page, 'map')
            switch_mode(page, 'independent')
            check_labels(page, 'independent')
            page.reload(wait_until='networkidle')
            ready(page, 'independent')
            expect(page.locator('.waypoint-name-label')).to_have_count(3)
            switch_mode(page, 'map')
            expect(page.locator('.waypoint-name-label')).to_have_count(3)
            for mode in original:
                assert recorded_data(page, mode) == original[mode], f'{mode} data changed during label display/selection'
            assert not errors, errors
        finally:
            browser.close()
    print('Shared map/independent labels, height projection, selection highlighting, toggles, reload and unchanged navigation/teaching passed')


if __name__ == '__main__':
    run()
