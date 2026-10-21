"""Optional map-route import from first and later independent-group dialogs."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from independent_teaching_history_ui_smoke import choose_new_model, history, open_new_group
from map_first_independent_ui_smoke import open_from_map
from new_independent_options_ui_smoke import MATRIX, check_synced_route, equivalent, stable, submit
from new_independent_teaching_ui_smoke import choose_new_matrix, new_page
from teaching_transfer_ui_smoke import CHROME, ready, seed, snapshot


def route_file():
    reference = Path(__file__).resolve().parent.parent / '1019平地路网终版测试.json'
    route = json.loads(reference.read_text()) if reference.exists() else {
        'schema_version': 1, 'id': 'optional-map-route', 'name': '补充路网', 'scene_name': 'map',
        'nodes': [{'id': i, 'label': f'停车点{i}', 'x_m': x, 'y_m': 20, 'yaw_rad': 0}
                  for i, x in [(1, 10), (2, 11)]],
        'edges': [{'id': 3, 'start': 1, 'end': 2}],
    }
    return route, {'name': reference.name, 'mimeType': 'application/json',
                   'buffer': json.dumps(route, ensure_ascii=False).encode()}


def seed_without_route(page, mode):
    seed(page, ['map'] if mode == 'map' else ['map', 'independent'], mode)
    page.evaluate("""async activeMode => {
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const record = await store.loadWorkspaceConfig(sessionId, 'map');
      record.config.project.waypoints = []; record.config.project.paths = []; record.config.project.abxRoutes = [];
      await store.saveWorkspaceConfig(sessionId, record.mapId, record.config, 'map');
      await store.activateWorkspaceMode(sessionId, activeMode);
    }""", mode)
    page.reload(wait_until='networkidle')
    ready(page, mode)


def choose_route(page, dialog, file):
    with page.expect_file_chooser() as chooser:
        dialog.get_by_role('button', name='加载路网', exact=True).click()
    chooser.value.set_files(file)


def active_mode(page):
    return page.evaluate("""async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('atlas-route-studio'); r.onsuccess = () => resolve(r.result); });
      try { return await new Promise(resolve => { const r = db.transaction('workspace-session').objectStore('workspace-session').get('workspace-slots'); r.onsuccess = () => resolve(r.result.activeMode); }); }
      finally { db.close(); }
    }""")


def run():
    route, file = route_file()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for mode in ('map', 'independent'):
                context, page = new_page(browser, errors)
                seed_without_route(page, mode)
                if mode == 'independent':
                    # Skipping the optional route still creates a separate group and archives the old one.
                    original = snapshot(page, 'independent')
                    dialog = open_new_group(page)
                    choose_new_model(page, dialog)
                    expect(dialog.get_by_role('button', name='加载路网', exact=True)).to_be_enabled()
                    submit(page, dialog)
                    assert history(page)[0]['mapId'] == original['mapId']
                    assert snapshot(page, 'map')['project']['waypoints'] == []
                    assert snapshot(page, 'independent')['project']['workspace'].get('transfer') is None
                open_dialog = open_from_map if mode == 'map' else open_new_group
                dialog = open_dialog(page)
                expect(dialog.get_by_role('button', name='加载路网', exact=True)).to_be_enabled()
                choose_new_model(page, dialog)
                before_map, before_local = snapshot(page, 'map'), snapshot(page, 'independent')
                before_history = history(page)
                create = dialog.get_by_role('button', name='创建独立示教', exact=True)
                expect(create).to_be_enabled()
                choose_route(page, dialog, [])
                expect(create).to_be_enabled()
                choose_route(page, dialog, {'name': 'bad.json', 'mimeType': 'application/json', 'buffer': b'{invalid'})
                expect(dialog.get_by_role('alert')).to_be_visible()
                expect(create).to_be_enabled()
                equivalent(stable(snapshot(page, 'map')), stable(before_map))
                assert history(page) == before_history

                # Fail the cache-index write after the new map config is queued.
                page.evaluate("""routeId => {
                  const put = IDBObjectStore.prototype.put;
                  let importing = false;
                  window.restoreRoutePut = () => { IDBObjectStore.prototype.put = put; };
                  IDBObjectStore.prototype.put = function(record, ...args) {
                    if (this.name === 'workspace-session' && record.key === 'workspace-config:map'
                      && record.config.project.abxRoutes?.some(route => route.id === routeId)) importing = true;
                    if (importing && record.key === 'workspace-slots') throw new Error('测试路网写入失败');
                    return put.call(this, record, ...args);
                  };
                }""", route['id'])
                choose_route(page, dialog, file)
                expect(dialog.get_by_role('alert')).to_contain_text('测试路网写入失败')
                expect(create).to_be_enabled()
                page.evaluate('window.restoreRoutePut()')
                equivalent(stable(snapshot(page, 'map')), stable(before_map))
                assert active_mode(page) == mode
                assert history(page) == before_history

                choose_route(page, dialog, file)
                sync = dialog.get_by_role('button', name='同步路网', exact=True)
                expect(sync).to_be_visible()
                expect(sync).to_be_disabled()  # Import does not require or imply a transformation matrix.
                expect(create).to_be_enabled()
                expect(dialog.get_by_role('status').filter(has_text='路网已加载到地图')).to_be_visible()
                with_route = snapshot(page, 'map')
                assert with_route['project']['abxRoutes'] == [route]
                imported_points = [point for point in with_route['project']['waypoints']
                                   if point.get('abx', {}).get('routeId') == route['id']]
                assert len(imported_points) == len(route['nodes'])
                assert {point['id'] for point in before_map['project']['waypoints']}.issubset(
                    {point['id'] for point in with_route['project']['waypoints']})
                assert len(with_route['project']['paths']) == len(route['edges'])
                assert with_route['positions'] == before_map['positions']
                equivalent(with_route['project']['virtualTeaching'], before_map['project']['virtualTeaching'])
                assert active_mode(page) == mode
                assert history(page) == before_history
                if mode == 'independent':
                    equivalent(stable(snapshot(page, 'independent')), stable(before_local))
                else:
                    # Loading a route is committed even if creating the new object is cancelled.
                    dialog.get_by_role('button', name='取消', exact=True).click()
                    page.reload(wait_until='networkidle'); ready(page, 'map')
                    assert snapshot(page, 'map')['project']['abxRoutes'] == [route]
                    dialog = open_dialog(page)
                    expect(dialog.get_by_role('button', name='加载路网', exact=True)).to_have_count(0)
                    choose_new_model(page, dialog)
                    sync = dialog.get_by_role('button', name='同步路网', exact=True)
                choose_new_matrix(page, dialog, MATRIX)
                expect(sync).to_be_enabled()
                expect(sync).to_have_attribute('aria-pressed', 'false')
                sync.click()
                if mode == 'independent':
                    page.screenshot(path='/tmp/atlas-new-independent-loaded-route.png', full_page=True)
                submit(page, dialog)
                check_synced_route(page, with_route)
                assert snapshot(page, 'map')['project']['abxRoutes'] == [route]
                assert len(history(page)) == len(before_history) + (1 if mode == 'independent' else 0)
                page.reload(wait_until='networkidle'); ready(page, 'independent')
                check_synced_route(page, with_route)
                context.close()
                print(f'PASS: {mode} optional route import, cancel, validation, atomic retry, route sync, cache preservation and reload', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
