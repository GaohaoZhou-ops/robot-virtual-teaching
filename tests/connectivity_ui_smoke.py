"""Explain disconnected graphs and locate problems in isolated browser storage."""
import re

from playwright.sync_api import expect, sync_playwright
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready


def seed(page, case, mode):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async ({ caseName, mode }) => {
      const { teachingTransfer3DFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransfer3DFixture(mode), project = fixture.config.config.project;
      const task = project.virtualTeaching.tasks[0];
      task.name = '孤立停车点示教';
      task.parkingPoints = [task.parkingPoints[0]];
      task.parkingPoints[0].name = '停车点 C';
      task.parkingPoints[0].mapPose.position = { x: 24, y: 26, z: 0.2 };
      project.virtualTeaching.tasks = caseName === 'isolated' ? [task] : [];
      project.workspace.activeTeachingTaskId = null;
      project.workspace.activeTeachingParkingPointId = null;
      const nodes = [['A', 12, 15], ['B', 24, 15]];
      let paths = [['AB', 'A', 'B'], ['BA', 'B', 'A']];
      if (caseName === 'disjoint') {
        nodes.push(['C', 24, 26], ['D', 12, 26]);
        paths.push(['CD', 'C', 'D'], ['DC', 'D', 'C']);
      }
      if (caseName === 'one-way') {
        nodes.push(['C', 24, 26]);
        paths.push(['BC', 'B', 'C']);
      }
      if (caseName === 'bidirectional') paths = [['AB', 'A', 'B']];
      project.waypoints = nodes.map(([id, x, y]) => ({ id, name: id,
        pose: { x, y, z: 0.2, roll: 0, pitch: 0, yaw: 0 } }));
      project.paths = paths.map(([id, from, to]) => ({ id, from, to,
        directed: caseName !== 'bidirectional', connectivity: 'connected',
        limits: { minSpeed: 0.1, maxSpeed: 1, minAcceleration: -0.5, maxAcceleration: 0.5 } }));
      // Old caches incorrectly recorded green paths as globally connected.
      fixture.config.config.ui.validation = { status: caseName === 'one-way' ? 'idle' : 'connected',
        unreachableCount: 0, checkedAt: null };
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      await store.activateWorkspaceMode(sessionId, mode);
    }""", dict(caseName=case, mode=mode))
    page.goto(BASE_URL + '/workbench', wait_until='networkidle')
    ready(page, mode)
    page.get_by_role('tab', name='路径与导航', exact=True).click()


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for case, mode, detail in [
                ('isolated', 'map', '1 个孤立导航点未接入路网'),
                ('disjoint', 'independent', '2 组路网互不相连'),
                ('one-way', 'map', '1 条路径无法往返（黄色）'),
                ('bidirectional', 'map', '所有导航点均可往返到达'),
            ]:
                context = browser.new_context(viewport=dict(width=1440, height=1000))
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                seed(page, case, mode)
                test = page.get_by_role('button', name='路径测试', exact=True)
                results = page.get_by_role('dialog', name='路径检测结果', exact=True)
                if case in ('isolated', 'disjoint'):
                    expect(test).to_have_class(re.compile('is-partial'))
                    assert detail in test.get_attribute('title')
                test.click()
                expect(page.get_by_text('检测完成：' + detail, exact=True)).to_be_visible()
                if case == 'bidirectional':
                    expect(results).to_have_count(0)
                    expect(test).to_have_class(re.compile('is-connected'))
                    expect(page.locator('.route-edge.connected')).to_have_count(1)
                    context.close()
                    continue
                expect(results).to_be_visible()
                expect(test).to_have_attribute('aria-expanded', 'true')
                expect(results).to_contain_text(detail)
                if case in ('isolated', 'disjoint'):
                    assert '黄色' not in results.inner_text()
                    expect(page.locator('.route-edge.unreachable')).to_have_count(0)
                if case == 'isolated':
                    expect(results).to_contain_text('孤立停车点示教 · 示教停车点')
                    page.screenshot(path='/tmp/atlas-connectivity-isolated.png', full_page=True)
                    results.get_by_role('button', name='定位导航点 停车点 C', exact=True).click()
                    expect(page.get_by_label('搜索导航点', exact=True)).to_have_value('map-inside')
                elif case == 'disjoint':
                    expect(results.get_by_role('button', name=re.compile('定位路网'))).to_have_count(2)
                    results.get_by_role('button', name='定位路网 2', exact=True).click()
                    expect(page.get_by_label('搜索导航点', exact=True)).to_have_value('C')
                else:
                    expect(page.locator('.route-edge.unreachable')).to_have_count(1)
                    results.get_by_role('button', name='定位路径 B → C', exact=True).click()
                    selected = page.locator('.route-edge.unreachable.is-selected .route-edge__visible')
                    expect(selected).to_have_css('stroke', 'rgb(244, 201, 93)')
                    expect(selected).to_have_attribute('marker-end', 'url(#arrow-unreachable)')
                    page.screenshot(path='/tmp/atlas-connectivity-selected.png', full_page=True)
                expect(results).to_have_count(0)
                test.click()
                expect(results).to_be_visible()
                page.keyboard.press('Escape')
                expect(results).to_have_count(0)
                expect(test).to_be_focused()
                test.click()
                page.get_by_role('tab', name='示教', exact=True).click()
                expect(results).to_have_count(0)
                page.get_by_role('tab', name='路径与导航', exact=True).click()
                # The diagnostic is preserved after an actual browser reload.
                for _ in range(100):
                    if page.evaluate("""async mode => {
                      const store = await import('/src/features/workspace/model/sessionStore.js');
                      const saved = await store.loadWorkspaceConfig((await store.fetchServiceSession()).sessionId, mode);
                      return saved.config.ui.validation?.status === 'partial' && saved.config.ui.validation.checkedAt;
                    }""", mode):
                        break
                    page.wait_for_timeout(100)
                else:
                    raise AssertionError('Connectivity result was not saved')
                page.reload(wait_until='networkidle')
                ready(page, mode)
                page.get_by_role('tab', name='路径与导航', exact=True).click()
                expect(test).to_have_attribute('title', re.compile(re.escape(detail)))
                test.click()
                expect(results).to_contain_text(detail)
                page.set_viewport_size(dict(width=1024, height=768))
                expect(results).to_be_in_viewport()
                box = results.bounding_box()
                assert 0 <= box['x'] and box['x'] + box['width'] <= 1024
                assert 0 <= box['y'] and box['y'] + box['height'] <= 768
                context.close()
            assert not errors, errors
            print('Connectivity UI passed: truthful reports, location, dismissal, selection color, reload, compact layout.')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
