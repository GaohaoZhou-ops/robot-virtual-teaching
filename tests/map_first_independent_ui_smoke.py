"""First independent group starts from the live map, using disposable profiles."""
from playwright.sync_api import expect, sync_playwright

from independent_teaching_history_ui_smoke import PLY, history
from linked_project_ui_smoke import state
from new_independent_options_ui_smoke import MATRIX, check_synced_route, equivalent, options, stable, submit
from new_independent_teaching_ui_smoke import choose_new_matrix, new_page
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, seed, snapshot
from topbar_tools_helpers import topbar_action


def open_from_map(page):
    topbar_action(page, '切换到独立示教', exact=True).click()
    dialog = page.get_by_role('dialog', name='新增独立示教', exact=True)
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('button', name='加载转换矩阵', exact=True)).to_be_enabled()
    expect(page).to_have_url(f'{BASE_URL}/workbench')
    expect(page.locator('.app-shell[data-app-page="workbench"]')).to_have_attribute('data-teaching-space-mode', 'map')
    expect(dialog).to_contain_text('当前地图示教将保留')
    return dialog


def independent_entries(page):
    return page.evaluate("""async () => {
      const store = await import('/src/features/workspace/model/sessionStore.js');
      return store.listIndependentWorkspaces((await store.fetchServiceSession()).sessionId);
    }""")


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for place_map in (False, True):
                context, page = new_page(browser, errors)
                seed(page, ['map'], 'map')
                dialog = open_from_map(page)
                original_map = snapshot(page, 'map')
                for close in ('cancel', 'escape'):
                    if close == 'cancel':
                        dialog.get_by_role('button', name='取消', exact=True).click()
                    else:
                        page.keyboard.press('Escape')
                    expect(dialog).to_have_count(0)
                    ready(page, 'map')
                    assert independent_entries(page) == []
                    equivalent(stable(snapshot(page, 'map')), stable(original_map))
                    dialog = open_from_map(page)

                # A failed first creation keeps the map open and creates no cache slot.
                page.get_by_label('新增独立示教模型', exact=True).set_input_files({
                    'name': 'empty.ply', 'mimeType': 'application/octet-stream',
                    'buffer': b'ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n',
                })
                dialog.get_by_role('button', name='创建独立示教', exact=True).click()
                expect(dialog.get_by_role('alert')).to_contain_text('没有有效的顶点坐标')
                assert independent_entries(page) == []
                equivalent(stable(snapshot(page, 'map')), stable(original_map))
                page.get_by_label('新增独立示教模型', exact=True).set_input_files(str(PLY))
                choose_new_matrix(page, dialog, MATRIX)
                route, place = options(dialog)
                expect(route).to_have_attribute('aria-pressed', 'true')
                expect(place).to_have_attribute('aria-pressed', 'true')
                if not place_map:
                    place.click()
                if place_map:
                    # Abort after both workspaces' writes were queued, then retry.
                    page.evaluate("""() => {
                      const put = IDBObjectStore.prototype.put;
                      window.restoreFirstGroupPut = () => { IDBObjectStore.prototype.put = put; };
                      IDBObjectStore.prototype.put = function(record, ...args) {
                        if (this.name === 'workspace-session' && record.key === 'independent-history') {
                          throw new DOMException('测试首次创建缓存写入失败', 'QuotaExceededError');
                        }
                        return put.call(this, record, ...args);
                      };
                    }""")
                    dialog.get_by_role('button', name='创建独立示教', exact=True).click()
                    expect(dialog.get_by_role('alert')).to_contain_text('测试首次创建缓存写入失败')
                    assert independent_entries(page) == []
                    assert history(page) == []
                    equivalent(stable(snapshot(page, 'map')), stable(original_map))
                    page.evaluate('window.restoreFirstGroupPut()')
                else:
                    page.screenshot(path='/tmp/atlas-map-first-independent-dialog.png', full_page=True)

                submit(page, dialog, 'map' if place_map else 'independent')
                local = snapshot(page, 'independent')
                result_map = snapshot(page, 'map')
                relation = local['project']['workspace']['transfer']
                assert relation['kind'] == 'alignment'
                assert relation['sourceMap']['mapId'] == original_map['mapId']
                assert local['project']['virtualTeaching']['tasks'] == []
                assert history(page) == []
                assert len(independent_entries(page)) == 1
                pair = state(page)['states']
                assert pair['independent']['robotFiles'] == pair['map']['robotFiles']
                assert pair['independent']['robotFiles'], 'The embedded robot must survive the first creation'
                original_tasks = original_map['project']['virtualTeaching']['tasks']
                result_tasks = result_map['project']['virtualTeaching']['tasks']
                assert len(result_tasks) == len(original_tasks)
                for before, after in zip(original_tasks, result_tasks):
                    assert after['id'] == before['id'] and after['name'] == before['name']
                    equivalent(after['parkingPoints'], before['parkingPoints'])
                    assert after['map']['id'] == result_map['mapId']
                equivalent(result_map['project']['waypoints'], original_map['project']['waypoints'])
                if place_map:
                    assert result_map['pointCount'] == original_map['pointCount'] + local['pointCount']
                    assert result_map['positions'][:len(original_map['positions'])] == original_map['positions']
                    with page.expect_navigation(wait_until='networkidle'):
                        topbar_action(page, '切换到独立示教', exact=True).click()
                    ready(page, 'independent')
                else:
                    equivalent(stable(result_map), stable(original_map))
                check_synced_route(page, original_map)
                page.reload(wait_until='networkidle')
                ready(page, 'independent')
                check_synced_route(page, original_map)
                assert history(page) == []
                context.close()
                print(f'PASS: map-first creation place={place_map}, cancel, invalid model, route, robot, map preservation and reload', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
