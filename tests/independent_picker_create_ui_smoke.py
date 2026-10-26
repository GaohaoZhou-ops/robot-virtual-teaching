"""Create an independent group directly from the map's existing-group picker."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from independent_teaching_history_ui_smoke import choose_new_model, history, new_group
from independent_teaching_picker_ui_smoke import choose, open_picker
from linked_project_ui_smoke import seed_linked
from new_independent_options_ui_smoke import MATRIX, check_synced_route, equivalent, options, stable, submit
from new_independent_teaching_ui_smoke import choose_new_matrix, new_page
from project_save_target_ui_smoke import switch_mode
from teaching_transfer_ui_smoke import CHROME, snapshot


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            context, page = new_page(browser, errors)
            seed_linked(page, 'independent')
            new_group(page)
            switch_mode(page, 'map')
            previous_local = snapshot(page, 'independent')
            previous_history = history(page)
            previous_map = snapshot(page, 'map')
            picker = open_picker(page)
            expect(picker.locator('li')).to_have_count(2)
            create = picker.get_by_role('button', name='新增独立示教', exact=True)
            expect(create).to_be_enabled()
            artifacts = Path('test-artifacts/independent-picker-create')
            artifacts.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(artifacts / 'picker-desktop.png'), animations='disabled')
            page.set_viewport_size({'width': 430, 'height': 900})
            panel = picker.locator('.project-load-dialog')
            page.screenshot(path=str(artifacts / 'picker-narrow.png'), animations='disabled')
            # The existing decorative corner extends 1 px beyond the content box.
            assert panel.evaluate('element => element.scrollWidth <= element.clientWidth + 1 '
                                  '&& [...element.children].every(child => child.scrollWidth <= child.clientWidth)')
            left = create.bounding_box()
            right = picker.get_by_role('button', name='取消', exact=True).bounding_box()
            assert left['x'] + left['width'] < right['x']
            page.set_viewport_size({'width': 1440, 'height': 1000})

            # Both Cancel and Escape return to the picker without switching any workspace.
            for close in ('cancel', 'escape'):
                create.click()
                dialog = page.get_by_role('dialog', name='新增独立示教', exact=True)
                expect(dialog).to_be_visible()
                expect(picker).to_have_count(0)
                expect(dialog.get_by_role('button', name='选择模型', exact=True)).to_be_focused()
                expect(page.locator('.app-shell[data-app-page="workbench"]')).to_have_attribute('data-teaching-space-mode', 'map')
                choose_new_model(page, dialog)
                choose_new_matrix(page, dialog, MATRIX)
                route, place = options(dialog)
                expect(route).to_have_attribute('aria-pressed', 'true')
                expect(place).to_have_attribute('aria-pressed', 'true' if close == 'cancel' else 'false')
                if close == 'cancel':
                    place.click()  # This entrance shares the same preference memory.
                    dialog.get_by_role('button', name='取消', exact=True).click()
                else:
                    place.click()
                    page.keyboard.press('Escape')
                expect(picker).to_be_visible()
                expect(picker.locator('li')).to_have_count(2)
                equivalent(stable(snapshot(page, 'map')), stable(previous_map))
                assert snapshot(page, 'independent') == previous_local
                assert history(page) == previous_history

            create.click()
            dialog = page.get_by_role('dialog', name='新增独立示教', exact=True)
            choose_new_model(page, dialog)
            dialog.get_by_label('独立示教名称', exact=True).fill('地图中直接新增')
            choose_new_matrix(page, dialog, MATRIX)
            for button in options(dialog):
                expect(button).to_have_attribute('aria-pressed', 'true')
            page.screenshot(path=str(artifacts / 'create-from-map.png'), animations='disabled')
            # A failed write must leave both existing groups and the map intact.
            page.evaluate("""() => {
              const put = IDBObjectStore.prototype.put;
              window.restorePickerCreatePut = () => { IDBObjectStore.prototype.put = put; };
              IDBObjectStore.prototype.put = function(record, ...args) {
                if (this.name === 'workspace-session' && record.key === 'independent-history') {
                  throw new DOMException('测试选择弹窗新增失败', 'QuotaExceededError');
                }
                return put.call(this, record, ...args);
              };
            }""")
            dialog.get_by_role('button', name='创建独立示教', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('测试选择弹窗新增失败')
            page.evaluate('window.restorePickerCreatePut()')
            equivalent(stable(snapshot(page, 'map')), stable(previous_map))
            assert snapshot(page, 'independent') == previous_local
            assert history(page) == previous_history
            submit(page, dialog, 'map')
            created = snapshot(page, 'independent')
            assert created['mapId'] != previous_local['mapId']
            assert created['project']['workspace']['independentTeachingName'] == '地图中直接新增'
            assert created['project']['workspace']['transfer']['localToMap']['position'] == {'x': 5, 'y': -3, 'z': 1}
            archived = history(page)
            assert len(archived) == len(previous_history) + 1
            assert {entry['mapId'] for entry in archived} == {previous_local['mapId'], *[entry['mapId'] for entry in previous_history]}
            placed = snapshot(page, 'map')
            assert placed['pointCount'] == previous_map['pointCount'] + created['pointCount']
            assert placed['positions'][:len(previous_map['positions'])] == previous_map['positions']
            equivalent(placed['project']['waypoints'], previous_map['project']['waypoints'])
            for before, after in zip(previous_map['project']['virtualTeaching']['tasks'], placed['project']['virtualTeaching']['tasks']):
                assert before['id'] == after['id']
                equivalent(before['parkingPoints'], after['parkingPoints'])
            picker = open_picker(page)
            expect(picker.locator('li')).to_have_count(3)
            choose(page, picker, created['mapId'])
            check_synced_route(page, previous_map)
            assert not errors, errors
            context.close()
            print('Map picker creation: direct entry, desktop/narrow layout, cancel/Escape return, '
                  'shared preference memory, rollback/retry, archived groups, placement and route sync passed', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
