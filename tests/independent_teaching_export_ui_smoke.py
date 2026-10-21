"""Export choices in disposable browser profiles; never open user caches."""
import json
import math
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from abx_teaching_export_ui_smoke import BASE_URL, CHROME
from teaching_transfer_ui_smoke import snapshot


def seed(page, variant='linked'):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    fixture = page.evaluate("""async variant => {
      const { independentTeachingExportFixture } = await import('/tests/independent_teaching_export_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = independentTeachingExportFixture();
      if (variant === 'no-sync') fixture.local.config.config.ui.mapRouteSyncEnabled = false;
      if (variant === 'unbound') delete fixture.local.config.config.project.workspace.transfer;
      if (variant === 'no-route') Object.assign(fixture.map.config.config.project, {waypoints: [], paths: [], abxRoutes: []});
      if (variant === 'invalid') delete fixture.local.config.config.project.virtualTeaching.tasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.head_yaw_J;
      for (const entry of variant === 'no-map' ? [fixture.local] : [fixture.map, fixture.local]) {
        await store.saveWorkspaceMap(sessionId, entry.map.mapId, entry.map.name, entry.map, entry.mode);
        await store.saveWorkspaceConfig(sessionId, entry.map.mapId, entry.config.config, entry.mode);
      }
      await store.activateWorkspaceMode(sessionId, variant === 'map' ? 'map' : 'independent');
      return {route: fixture.route, local: fixture.local.config.config.project};
    }""", variant)
    page.goto(BASE_URL + '/teaching-data', wait_until='networkidle')
    page.locator('[data-app-page="teaching-data"]').wait_for()
    page.locator('.loading-curtain').wait_for(state='hidden')
    name = '地图已有旧任务' if variant == 'map' else '当前独立任务'
    page.get_by_role('button', name=f'选择示教任务 {name}', exact=True).click()
    return fixture


def json_download(page, button, folder, fixture):
    with page.expect_download() as pending:
        button.click()
    assert pending.value.suggested_filename.startswith('atlas-teaching-independent-')
    path = Path(folder) / 'independent.json'
    pending.value.save_as(path)
    data = json.loads(path.read_text())
    assert data['source']['teachingSpaceMode'] == 'independent'
    assert data['coordinateSystem']['frameId'] == 'virtual_origin'
    assert len(data['tasks']) == 1 and data['statistics']['poseCount'] == 3
    actual = data['tasks'][0]['parkingPoints'][0]
    original = fixture['local']['virtualTeaching']['tasks'][0]['parkingPoints'][0]
    assert actual['mapPose']['position'] == original['mapPose']['position']
    assert actual['poses'][0]['fullBodyJoints']['values'] == original['poses'][0]['fullBodyJoints']['values']


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix='atlas-independent-export-') as folder, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for variant in ['linked', 'no-sync', 'unbound', 'no-route', 'no-map', 'invalid', 'map']:
                context = browser.new_context(viewport=dict(width=1440, height=1000), accept_downloads=True)
                page = context.new_page()
                page.set_default_timeout(30000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                fixture = seed(page, variant)
                export = page.get_by_role('button', name='导出示教数据', exact=True)
                choice = page.get_by_role('dialog', name='导出示教数据', exact=True)
                native = page.get_by_role('dialog', name='导出机器人示教', exact=True)
                if variant in ['no-sync', 'unbound', 'no-route', 'no-map']:
                    json_download(page, export, folder, fixture)
                    expect(choice).to_have_count(0)
                    expect(native).to_have_count(0)
                elif variant == 'map':
                    export.click()
                    expect(choice).to_have_count(0)
                    expect(native.get_by_role('button', name='下载机器人导入包')).to_be_enabled()
                else:
                    original_map = snapshot(page, 'map')
                    local_tasks = snapshot(page, 'independent')['project']['virtualTeaching']['tasks']
                    export.click()
                    expect(choice).to_contain_text('已绑定地图示教并启用路网同步')
                    if variant == 'linked':
                        page.screenshot(path='/tmp/atlas-independent-export-desktop.png', full_page=True)
                        # Native modal keyboard containment and explicit cancellation.
                        for _ in range(6):
                            page.keyboard.press('Tab')
                            assert choice.evaluate('(dialog) => dialog.contains(document.activeElement)')
                        page.keyboard.press('Escape')
                        expect(choice).to_have_count(0)
                        expect(export).to_be_focused()
                        export.click()
                        page.set_viewport_size(dict(width=390, height=780))
                        for name in ['地图示教任务 ZIP', '独立示教任务 JSON']:
                            expect(choice.get_by_role('button', name=name, exact=True)).to_be_in_viewport()
                        assert choice.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                        page.screenshot(path='/tmp/atlas-independent-export-compact.png', full_page=True)
                        json_download(page, choice.get_by_role('button', name='独立示教任务 JSON'), folder, fixture)
                        expect(choice).to_have_count(0)
                        page.set_viewport_size(dict(width=1440, height=1000))
                        export.click()
                    choice.get_by_role('button', name='地图示教任务 ZIP').click()
                    expect(choice).to_have_count(0)
                    download = native.get_by_role('button', name='下载机器人导入包')
                    if variant == 'invalid':
                        expect(native.get_by_role('alert')).to_contain_text('head_yaw_J')
                        expect(download).to_be_disabled()
                    else:
                        expect(download).to_be_enabled()
                        with page.expect_download() as pending:
                            download.click()
                        path = Path(folder) / 'map-teaching.zip'
                        pending.value.save_as(path)
                        with zipfile.ZipFile(path) as bundle:
                            manifest = json.loads(bundle.read('manifest.json'))
                            assert len(manifest['tasks']) == 1
                            assert manifest['tasks'][0]['name'] == '当前独立任务'
                            records = [json.loads(line) for line in bundle.read(manifest['tasks'][0]['file']).splitlines()]
                            actions = [row['record'] for row in records if row['type'] == 'point']
                            assert [row['node_id'] for row in actions if row.get('type') == 'route_navigation'] == ['N31', 'N0']
                            poses = [row for row in actions if 'joints_rad' in row]
                            assert len(poses) == 3
                            assert math.isclose(poses[0]['joints_rad']['left_arm'][0], math.radians(42))
                            route_path = manifest['tasks'][0]['navigation']['routes'][0]
                            assert json.loads(bundle.read(route_path)) == fixture['route']
                        page.screenshot(path='/tmp/atlas-independent-map-export.png', full_page=True)
                    page.keyboard.press('Escape')
                    assert page.url.endswith('/teaching-data')
                    assert snapshot(page, 'map') == original_map
                    assert snapshot(page, 'independent')['project']['virtualTeaching']['tasks'] == local_tasks
                    if variant == 'linked':
                        # A replaced map while the choice is open cannot use the old binding.
                        export.click()
                        page.evaluate("""async () => {
                          const store = await import('/src/lib/sessionStore.js');
                          const { sessionId } = await store.fetchServiceSession();
                          const config = await store.loadWorkspaceConfig(sessionId, 'map');
                          config.config.project.map.sourceHash = 'replacement-map';
                          await store.saveWorkspaceConfig(sessionId, config.mapId, config.config, 'map');
                        }""")
                        choice.get_by_role('button', name='地图示教任务 ZIP').click()
                        expect(choice.get_by_role('alert')).to_contain_text('建立转换关系')
                        expect(native).to_have_count(0)
                        json_download(page, choice.get_by_role('button', name='独立示教任务 JSON'), folder, fixture)
                print(f'independent_export_{variant}=passed', flush=True)
                context.close()
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
