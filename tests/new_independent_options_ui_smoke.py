"""Create-time route synchronization and atomic map placement in isolated browsers."""
import math
import re

from playwright.sync_api import expect, sync_playwright

from independent_teaching_history_ui_smoke import history, open_new_group, choose_new_model
from new_independent_teaching_ui_smoke import choose_new_matrix, enter_current_independent, new_page
from teaching_transfer_ui_smoke import CHROME, ready, seed, snapshot
from topbar_tools_helpers import topbar_action

MATRIX = {"name": "rotated-placement.txt", "mimeType": "text/plain",
          "buffer": b"0 -1 0 5\n1 0 0 -3\n0 0 1 1\n0 0 0 1\n"}


def options(dialog):
    return (dialog.get_by_role("button", name="同步路网", exact=True),
            dialog.get_by_role("button", name="放置进入地图", exact=True))


def submit(page, dialog, mode="independent"):
    with page.expect_navigation(wait_until="networkidle"):
        dialog.get_by_role("button", name="创建独立示教", exact=True).click()
    ready(page, mode)


def route_enabled(page):
    return page.evaluate("""async () => {
      const store = await import('/src/features/workspace/model/sessionStore.js');
      return (await store.loadWorkspaceConfig((await store.fetchServiceSession()).sessionId,
        'independent')).config.ui.mapRouteSyncEnabled === true;
    }""")


def stable(snapshot_value):
    value = dict(snapshot_value)
    value['project'] = {key: item for key, item in value['project'].items()
                        if key not in ('exportedAt', 'view2d', 'view3d')}
    return value


def equivalent(actual, expected):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), (actual.keys(), expected.keys())
        for key in expected:
            equivalent(actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for left, right in zip(actual, expected):
            equivalent(left, right)
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-8), (actual, expected)
    else:
        assert actual == expected, (actual, expected)


def check_synced_route(page, original_map):
    page.get_by_role('tab', name='路径与导航', exact=True).click()
    expected_count = len(original_map['project']['waypoints'])
    expect(page.get_by_label('搜索导航点', exact=True).locator('option[value^="map-route-"]')).to_have_count(expected_count)
    expect(page.locator('.three-canvas')).to_have_attribute('data-map-origin-position', re.compile(r'^\['))
    origin = page.locator('.three-canvas').evaluate("element => JSON.parse(element.dataset.mapOriginPosition)")
    assert all(math.isclose(a, b, abs_tol=1e-8) for a, b in zip(origin, [3, 5, -1])), origin
    assert route_enabled(page)
    # The projected route is disposable: it must not enter the saved local graph.
    assert snapshot(page, 'independent')['project']['waypoints'] == []


def check_preference_memory(browser, errors):
    context, page = new_page(browser, errors)
    seed(page, ['map', 'independent'], 'independent')
    dialog = open_new_group(page)
    choose_new_matrix(page, dialog, MATRIX)
    for button in options(dialog):
        expect(button).to_be_disabled()  # A matrix alone is not enough.
        expect(button).to_have_attribute('aria-pressed', 'false')
    choose_new_model(page, dialog)
    route, place = options(dialog)
    for button in (route, place):
        expect(button).to_have_attribute('aria-pressed', 'true')
        expect(button).to_have_css('animation-name', 'independent-option-breathe')
    note = dialog.locator('#new-independent-options-note')
    expect(note).to_contain_text('默认自动开启')
    expect(note).to_contain_text('下次沿用上次选择')
    page.emulate_media(reduced_motion='reduce')
    for button in (route, place):
        expect(button).to_have_css('animation-name', 'none')
    page.emulate_media(reduced_motion='no-preference')
    route.click()  # Remember a mixed selection, even if the dialog is cancelled.
    expect(route).to_have_css('animation-name', 'none')
    dialog.get_by_role('button', name='取消', exact=True).click()
    dialog = open_new_group(page)
    for button in options(dialog):
        expect(button).to_be_disabled()
        expect(button).to_have_attribute('aria-pressed', 'false')
    choose_new_model(page, dialog)
    choose_new_matrix(page, dialog, MATRIX)
    route, place = options(dialog)
    expect(route).to_have_attribute('aria-pressed', 'false')
    expect(place).to_have_attribute('aria-pressed', 'true')
    place.click()
    # Removing or replacing a matrix must never overwrite either remembered choice.
    dialog.get_by_role('button', name='移除矩阵', exact=True).click()
    choose_new_matrix(page, dialog, {'name': 'invalid.txt', 'mimeType': 'text/plain', 'buffer': b'bad'})
    expect(dialog.get_by_role('alert')).to_be_visible()
    for button in options(dialog):
        expect(button).to_be_disabled()
    dialog.get_by_role('button', name='移除矩阵', exact=True).click()
    choose_new_matrix(page, dialog, MATRIX)
    for button in options(dialog):
        expect(button).to_have_attribute('aria-pressed', 'false')
    dialog.get_by_role('button', name='取消', exact=True).click()
    page.reload(wait_until='networkidle')
    ready(page, 'independent')
    dialog = open_new_group(page)
    choose_new_model(page, dialog)
    choose_new_matrix(page, dialog, MATRIX)
    for button in options(dialog):
        expect(button).to_have_attribute('aria-pressed', 'false')
    options(dialog)[0].click()
    dialog.get_by_role('button', name='取消', exact=True).click()
    topbar_action(page, '切换到地图示教', exact=True).click()
    ready(page, 'map')
    topbar_action(page, '切换到独立示教', exact=True).click()
    ready(page, 'independent')
    dialog = open_new_group(page)
    choose_new_model(page, dialog)
    choose_new_matrix(page, dialog, MATRIX)
    route, place = options(dialog)
    expect(route).to_have_attribute('aria-pressed', 'true')
    expect(place).to_have_attribute('aria-pressed', 'false')
    context.close()
    print('preference memory: defaults, matrix-before-model, mixed/off choices, cancel/reopen, '
          'invalid matrix, refresh, cross-workspace reuse and reduced motion passed', flush=True)


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            check_preference_memory(browser, errors)
            context, page = new_page(browser, errors)
            seed(page, ['independent'], 'independent')
            dialog = open_new_group(page)
            expect(dialog.get_by_text('选择模型后自动填写，可按工位或对象命名，便于在缓存列表中查找。', exact=True)).to_have_count(0)
            for button in options(dialog):
                expect(button).to_be_disabled()
                expect(button).to_have_attribute('aria-pressed', 'false')
            context.close()

            # A complete map without navigation offers an optional route import.
            context, page = new_page(browser, errors)
            seed(page, ['map', 'independent'], 'independent')
            page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { sessionId } = await store.fetchServiceSession();
              const config = await store.loadWorkspaceConfig(sessionId, 'map');
              config.config.project.waypoints = []; config.config.project.paths = [];
              await store.saveWorkspaceConfig(sessionId, config.mapId, config.config, 'map');
            }""")
            dialog = open_new_group(page)
            choose_new_matrix(page, dialog, MATRIX)
            expect(dialog.get_by_role('button', name='加载路网', exact=True)).to_be_enabled()
            expect(dialog.get_by_role('button', name='放置进入地图', exact=True)).to_be_disabled()
            choose_new_model(page, dialog)
            expect(dialog.get_by_role('button', name='放置进入地图', exact=True)).to_be_enabled()
            expect(dialog.get_by_role('button', name='放置进入地图', exact=True)).to_have_attribute('aria-pressed', 'true')
            context.close()

            for sync_route, place_map in [(False, False), (True, False), (False, True), (True, True)]:
                context, page = new_page(browser, errors)
                seed(page, ['map', 'independent'], 'map')
                topbar_action(page, '切换到独立示教', exact=True).click()
                ready(page, 'independent')
                original_map = snapshot(page, 'map')
                original_local = snapshot(page, 'independent')
                dialog = open_new_group(page)
                route, place = options(dialog)
                for button in (route, place):
                    expect(button).to_be_disabled()  # A map alone does not establish coordinates.
                choose_new_model(page, dialog)
                choose_new_matrix(page, dialog, MATRIX)
                for button in (route, place):
                    expect(button).to_be_enabled()
                    expect(button).to_have_attribute('aria-pressed', 'true')
                page.mouse.move(0, 0)
                for button in (route, place):
                    expect(button).to_have_css('color', 'rgb(244, 201, 93)')
                page.set_viewport_size({'width': 430, 'height': 900})
                left, right = route.bounding_box(), place.bounding_box()
                assert math.isclose(left['y'], right['y']) and left['x'] + left['width'] < right['x']
                assert dialog.evaluate('element => element.scrollWidth <= element.clientWidth')
                if sync_route and place_map:
                    page.screenshot(path='/tmp/atlas-new-independent-options.png', animations='disabled')
                page.set_viewport_size({'width': 1440, 'height': 1000})
                dialog.get_by_role('button', name='移除矩阵', exact=True).click()
                for button in (route, place):
                    expect(button).to_be_disabled()
                    expect(button).to_have_attribute('aria-pressed', 'false')
                choose_new_matrix(page, dialog, MATRIX)
                if not sync_route:
                    route.click()
                if not place_map:
                    place.click()
                submit(page, dialog, 'map' if place_map else 'independent')
                local = snapshot(page, 'independent')
                assert local['mapId'] != original_local['mapId']
                assert local['project']['workspace']['transfer']['kind'] == 'alignment'
                assert len(history(page)) == 1 and history(page)[0]['mapId'] == original_local['mapId']
                assert route_enabled(page) is sync_route
                result_map = snapshot(page, 'map')
                if place_map:
                    assert result_map['pointCount'] == original_map['pointCount'] + local['pointCount']
                    assert result_map['positions'][:len(original_map['positions'])] == original_map['positions']
                    transformed = []
                    for index in range(0, len(local['positions']), 3):
                        x, y, z = local['positions'][index:index + 3]
                        transformed.extend([-y + 5, x - 3, z + 1])
                    assert all(math.isclose(a, b, abs_tol=1e-5) for a, b in
                               zip(result_map['positions'][len(original_map['positions']):], transformed))
                    equivalent(result_map['project']['waypoints'], original_map['project']['waypoints'])
                    # Changed geometry invalidates connectivity, but never changes the route itself.
                    equivalent([{k: v for k, v in edge.items() if k != 'connectivity'}
                                for edge in result_map['project']['paths']],
                               [{k: v for k, v in edge.items() if k != 'connectivity'}
                                for edge in original_map['project']['paths']])
                    original_tasks = original_map['project']['virtualTeaching']['tasks']
                    result_tasks = result_map['project']['virtualTeaching']['tasks']
                    assert len(result_tasks) == len(original_tasks)
                    for before, after in zip(original_tasks, result_tasks):
                        assert before['id'] == after['id']
                        equivalent(after['parkingPoints'], before['parkingPoints'])
                    enter_current_independent(page)
                else:
                    assert result_map == original_map
                if sync_route:
                    check_synced_route(page, original_map)
                    page.reload(wait_until='networkidle')
                    ready(page, 'independent')
                    check_synced_route(page, original_map)
                else:
                    expect(page.locator('.map-origin-label')).to_have_count(0)
                context.close()
                print(f'create_sync={sync_route}_place={place_map}: geometry, route, history and refresh passed', flush=True)

            # Fail after local/history and map geometry writes are queued: all must roll back.
            context, page = new_page(browser, errors)
            seed(page, ['map', 'independent'], 'independent')
            before_map, before_local = snapshot(page, 'map'), snapshot(page, 'independent')
            dialog = open_new_group(page)
            choose_new_model(page, dialog)
            choose_new_matrix(page, dialog, MATRIX)
            for button in options(dialog):
                expect(button).to_have_attribute('aria-pressed', 'true')
            page.evaluate("""() => {
              const original = IDBObjectStore.prototype.put;
              window.restorePlacementPut = () => { IDBObjectStore.prototype.put = original; };
              IDBObjectStore.prototype.put = function(record, ...args) {
                if (this.name === 'workspace-session' && record.key === 'workspace-config:map') {
                  throw new DOMException('测试放置缓存写入失败', 'QuotaExceededError');
                }
                return original.call(this, record, ...args);
              };
            }""")
            dialog.get_by_role('button', name='创建独立示教', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('测试放置缓存写入失败')
            page.evaluate('window.restorePlacementPut()')
            assert snapshot(page, 'map') == before_map
            assert stable(snapshot(page, 'independent')) == stable(before_local)
            assert history(page) == []
            expect(dialog.get_by_role('button', name='创建独立示教', exact=True)).to_be_enabled()
            submit(page, dialog, 'map')
            assert len(history(page)) == 1
            context.close()
            assert not errors, errors
            print('missing prerequisites, yellow breathing toggles, narrow layout and atomic placement rollback passed', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
