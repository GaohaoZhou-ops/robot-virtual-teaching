"""Batch import naming, pairing, atomic storage, placement and workspace retention."""
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import CHROME, ready, seed, snapshot
from independent_teaching_history_ui_smoke import PLY, history
from topbar_tools_helpers import topbar_action

ARTIFACTS = Path(__file__).resolve().parents[1] / 'test-artifacts' / 'independent-batch'
PLY_BYTES = PLY.read_bytes()


def model(name='model_0.ply', data=PLY_BYTES):
    return {'name': name, 'mimeType': 'application/octet-stream', 'buffer': data}


def matrix(name='position_0.txt', x=5):
    return {'name': name, 'mimeType': 'text/plain',
            'buffer': f'1 0 0 {x}\n0 1 0 0\n0 0 1 1\n0 0 0 1\n'.encode()}


def open_batch(page):
    topbar_action(page, '批量导入独立示教', exact=True).click()
    dialog = page.get_by_role('dialog', name='批量导入独立示教', exact=True)
    expect(dialog).to_be_visible()
    expect(dialog.get_by_text('正在读取目标地图…', exact=True)).to_have_count(0)
    return dialog


def add(dialog, files):
    dialog.get_by_label('批量模型和矩阵', exact=True).set_input_files(files)
    expect(dialog.get_by_text('正在读取矩阵…', exact=True)).to_have_count(0)


def choose_matrix(page, dialog, index, file):
    with page.expect_file_chooser() as chooser:
        dialog.get_by_role('button', name=f'加载第 {index} 组转换矩阵', exact=True).click()
    assert not chooser.value.is_multiple()
    chooser.value.set_files(file)
    expect(dialog.get_by_text('正在读取矩阵…', exact=True)).to_have_count(0)


def groups(page):
    return page.evaluate("""async () => {
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const {sessionId} = await store.fetchServiceSession();
      const result = await store.loadProjectCompanions(sessionId, 'map');
      return [result.companionWorkspace, ...result.independentHistory].filter(Boolean).map(item => ({
        id: item.map.mapId, groupId: item.map.teachingGroupId, name: item.config.config.project.workspace.independentTeachingName,
        hash: item.map.sourceHash, transfer: item.config.config.project.workspace.transfer,
        sync: item.config.config.ui.mapRouteSyncEnabled, count: item.map.pointCount,
      }));
    }""")


def main():
    errors = []
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            def new_page():
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                return context, page

            context, page = new_page()
            seed(page, ['map', 'independent'], 'map')
            page.evaluate("localStorage.setItem('atlas-route-studio:independent-creation-preferences-v1', JSON.stringify({version: 1, syncRoute: false, placeInMap: false}))")
            previous = snapshot(page, 'independent')
            original_map = snapshot(page, 'map')
            dialog = open_batch(page)
            add(dialog, [model(), matrix(), model('model_1.ply'), matrix('position_1.txt', -8)])
            expect(dialog.locator('[data-batch-row]')).to_have_count(2)
            for index, name in enumerate(['工位 A · 左侧阀门', '工位 B · 右侧阀门'], 1):
                expect(dialog.locator(f'[data-batch-row="{index}"] .batch-independent-matrix-file')).to_contain_text(f'position_{index - 1}.txt')
                for option in ('同步路网', '放入地图'):
                    button = dialog.get_by_role('button', name=f'第 {index} 组{option}', exact=True)
                    expect(button).to_have_attribute('aria-pressed', 'true')
                    expect(button).to_have_css('animation-name', 'independent-option-breathe')
                dialog.get_by_label(f'第 {index} 组名称').fill(name)
            name_box = dialog.get_by_label('第 1 组名称').bounding_box()
            matrix_picker = dialog.get_by_role('button', name='加载第 1 组转换矩阵', exact=True)
            matrix_box = matrix_picker.bounding_box()
            assert abs(name_box['y'] - matrix_box['y']) < 1
            assert abs(name_box['height'] - matrix_box['height']) < 1
            assert matrix_box['width'] <= 170
            route_button = dialog.get_by_role('button', name='第 1 组同步路网', exact=True)
            place_button = dialog.get_by_role('button', name='第 1 组放入地图', exact=True)
            route_box, place_box = route_button.bounding_box(), place_button.bounding_box()
            assert abs(route_box['y'] - place_box['y']) < 1
            assert route_box['x'] + route_box['width'] < place_box['x']
            file_label = dialog.locator('[data-batch-row="1"] .batch-independent-model')
            assert file_label.bounding_box()['y'] >= name_box['y'] + name_box['height']
            assert file_label.locator('..').get_by_label('第 1 组名称').count() == 1
            expect(matrix_picker).to_have_text('加载转换矩阵')
            expect(dialog.locator('select, [role="listbox"]')).to_have_count(0)
            expect(dialog.get_by_text('统一设置', exact=True)).to_have_count(0)
            # Each switch affects only its own row; the other row keeps its choices.
            for index in (1, 2):
                for option in ('同步路网', '放入地图'):
                    button = dialog.get_by_role('button', name=f'第 {index} 组{option}', exact=True)
                    button.click()
                    expect(button).to_have_attribute('aria-pressed', 'false')
                    other = dialog.get_by_role('button', name=f'第 {3 - index} 组{option}', exact=True)
                    expect(other).to_have_attribute('aria-pressed', 'true' if index == 1 else 'false')
            # Loading one row's matrix re-enables only that row, preserving names.
            choose_matrix(page, dialog, 1, matrix('replacement.txt', 12))
            matrix_label = dialog.locator('[data-batch-row="1"] .batch-independent-matrix-file')
            expect(matrix_label).to_contain_text('replacement.txt')
            for option in ('同步路网', '放入地图'):
                expect(dialog.get_by_role('button', name=f'第 1 组{option}', exact=True)).to_have_attribute('aria-pressed', 'true')
                expect(dialog.get_by_role('button', name=f'第 2 组{option}', exact=True)).to_have_attribute('aria-pressed', 'false')
            expect(dialog.get_by_label('第 1 组名称')).to_have_value('工位 A · 左侧阀门')
            choose_matrix(page, dialog, 1, [])
            expect(matrix_label).to_contain_text('replacement.txt')
            choose_matrix(page, dialog, 1, {'name': 'invalid.txt', 'mimeType': 'text/plain', 'buffer': b'bad matrix'})
            expect(matrix_label).to_contain_text('replacement.txt')
            expect(dialog.get_by_role('button', name='批量创建 2 组', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='移除第 1 组矩阵', exact=True).click()
            expect(route_button).to_be_disabled()
            expect(place_button).to_be_disabled()
            choose_matrix(page, dialog, 1, matrix())
            expect(matrix_label).to_contain_text('position_0.txt')
            expect(route_button).to_have_attribute('aria-pressed', 'true')
            expect(place_button).to_have_attribute('aria-pressed', 'true')
            page.screenshot(path=str(ARTIFACTS / 'batch-matrix-file-picker.png'), animations='disabled')
            submit = dialog.get_by_role('button', name='批量创建 2 组', exact=True)
            dialog.get_by_label('第 2 组名称').fill('   ')
            expect(submit).to_be_disabled()
            dialog.get_by_label('第 2 组名称').fill('工位 B · 右侧阀门')
            place_button.click()
            expect(route_button).to_have_attribute('aria-pressed', 'true')
            expect(place_button).to_have_attribute('aria-pressed', 'false')
            for option in ('同步路网', '放入地图'):
                expect(dialog.get_by_role('button', name=f'第 2 组{option}', exact=True)).to_have_attribute('aria-pressed', 'false')
            expect(submit).to_be_enabled()
            # Native file pickers emit a bubbling, non-cancelable input cancel event.
            # None of the four pickers may close the parent dialog or discard row edits.
            for label in ('批量模型和矩阵', '批量导入文件夹', '为当前组选择转换矩阵', '批量导入地图路网'):
                dialog.get_by_label(label, exact=True).dispatch_event('cancel', {'bubbles': True, 'cancelable': False})
                expect(dialog).to_be_visible()
                expect(dialog.locator('[data-batch-row]')).to_have_count(2)
                expect(dialog.get_by_label('第 1 组名称')).to_have_value('工位 A · 左侧阀门')
                expect(dialog.get_by_label('第 2 组名称')).to_have_value('工位 B · 右侧阀门')
                expect(matrix_label).to_contain_text('position_0.txt')
                expect(dialog.locator('[data-batch-row="2"] .batch-independent-matrix-file')).to_contain_text('position_1.txt')
                expect(route_button).to_have_attribute('aria-pressed', 'true')
                expect(place_button).to_have_attribute('aria-pressed', 'false')
                for option in ('同步路网', '放入地图'):
                    expect(dialog.get_by_role('button', name=f'第 2 组{option}', exact=True)).to_have_attribute('aria-pressed', 'false')
                expect(submit).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'batch-desktop.png'), animations='disabled')
            page.set_viewport_size({'width': 430, 'height': 900})
            assert dialog.evaluate('node => node.scrollWidth <= node.clientWidth')
            page.screenshot(path=str(ARTIFACTS / 'batch-mobile.png'), animations='disabled')
            page.set_viewport_size({'width': 1440, 'height': 1000})
            # Fail after group map/config writes have already been enqueued.
            page.evaluate("""() => {
              const put = IDBObjectStore.prototype.put;
              window.restoreBatchPut = () => { IDBObjectStore.prototype.put = put; };
              IDBObjectStore.prototype.put = function(record, ...args) {
                if (this.name === 'workspace-session' && record.key === 'independent-history')
                  throw new DOMException('测试批量事务失败', 'QuotaExceededError');
                return put.call(this, record, ...args);
              };
            }""")
            submit.click()
            expect(dialog.get_by_role('alert')).to_contain_text('测试批量事务失败')
            assert history(page) == []
            assert snapshot(page, 'independent') == previous
            page.evaluate('window.restoreBatchPut()')
            page.evaluate('window.batchNoReload = true')
            submit.click()
            expect(dialog).to_have_count(0)
            assert page.evaluate('window.batchNoReload') is True
            assert snapshot(page, 'independent') == previous
            assert snapshot(page, 'map')['positions'] == original_map['positions']
            actual = groups(page)
            assert {row['name'] for row in actual[1:]} == {'工位 A · 左侧阀门', '工位 B · 右侧阀门'}
            assert len({row['groupId'] for row in actual[1:]}) == 2
            assert {row['name']: row['sync'] for row in actual[1:]} == {
                '工位 A · 左侧阀门': True, '工位 B · 右侧阀门': False,
            }
            page.reload(wait_until='networkidle')
            ready(page, 'map')
            assert groups(page) == actual
            # Escape pressed directly in the batch dialog should still close it.
            escape_dialog = open_batch(page)
            page.keyboard.press('Escape')
            expect(escape_dialog).to_have_count(0)
            topbar_action(page, '切换到独立示教', exact=True).click()
            picker = page.get_by_role('dialog', name='选择独立示教', exact=True)
            with page.expect_navigation(wait_until='networkidle'):
                picker.get_by_role('button', name='进入独立示教 工位 A · 左侧阀门', exact=True).click()
            ready(page, 'independent')
            restored = snapshot(page, 'independent')['project']['workspace']
            assert restored['independentTeachingName'] == '工位 A · 左侧阀门'
            assert restored['transfer']['localToMap']['position']['x'] == 5
            context.close()
            print('batch: file-picker cancellation preserves rows; dialog Escape, independent options, rollback and restore passed', flush=True)

            # One model, multiple transforms, including a manually named first row.
            context, page = new_page()
            seed(page, ['map'], 'map')
            original_map = snapshot(page, 'map')
            dialog = open_batch(page)
            add(dialog, [model('shared.ply')])
            dialog.get_by_label('第 1 组名称').fill('人工命名的主工位')
            add(dialog, [matrix(), matrix('position_1.txt', -8)])
            dialog.get_by_role('button', name='按矩阵生成组', exact=True).click()
            expect(dialog.locator('[data-batch-row]')).to_have_count(2)
            expect(dialog.get_by_label('第 1 组名称')).to_have_value('人工命名的主工位')
            dialog.get_by_label('第 2 组名称').fill('人工命名的第二工位')
            dialog.get_by_role('button', name='第 2 组放入地图', exact=True).click()
            expect(dialog.get_by_role('button', name='第 2 组放入地图', exact=True)).to_have_attribute('aria-pressed', 'false')
            expect(dialog.get_by_role('button', name='第 1 组放入地图', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(dialog.get_by_role('button', name='第 2 组同步路网', exact=True)).to_have_attribute('aria-pressed', 'true')
            with page.expect_navigation(wait_until='networkidle'):
                dialog.get_by_role('button', name='批量创建 2 组', exact=True).click()
            ready(page, 'map')
            actual = groups(page)
            assert [row['name'] for row in actual] == ['人工命名的主工位', '人工命名的第二工位']
            assert actual[0]['hash'] == actual[1]['hash'] and actual[0]['groupId'] != actual[1]['groupId']
            assert [row['transfer']['localToMap']['position']['x'] for row in actual] == [5, -8]
            assert snapshot(page, 'map')['pointCount'] == original_map['pointCount'] + actual[0]['count']
            context.close()
            print('batch: shared model fan-out, names preserved, independent placement, initial slot passed', flush=True)

            context, page = new_page()
            seed(page, ['independent'], 'independent')
            before = snapshot(page, 'independent')
            dialog = open_batch(page)
            add(dialog, [model(), model('broken.ply', b'not a ply')])
            dialog.get_by_role('button', name='批量创建 2 组', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('第 2 组')
            assert history(page) == []
            assert snapshot(page, 'independent')['positions'] == before['positions']
            dialog.get_by_role('button', name='移除第 2 组', exact=True).click()
            dialog.get_by_label('第 1 组名称').fill('无地图的独立工位')
            dialog.get_by_role('button', name='批量创建 1 组', exact=True).click()
            expect(dialog).to_have_count(0)
            assert history(page)[0]['teachingName'] == '无地图的独立工位'
            context.close()
            print('batch: invalid PLY prevents partial writes; model-only import passed', flush=True)

            context, page = new_page()
            seed(page, ['map', 'independent'], 'independent')
            dialog = open_batch(page)
            with tempfile.TemporaryDirectory(prefix='atlas-batch-input-') as directory:
                for index in range(2):
                    folder = Path(directory) / f'工位{index}'
                    folder.mkdir()
                    (folder / 'part.ply').write_bytes(PLY_BYTES)
                    (folder / 'position_0.txt').write_bytes(matrix(x=index + 2)['buffer'])
                dialog.get_by_label('批量导入文件夹', exact=True).set_input_files(directory)
                expect(dialog.locator('[data-batch-row]')).to_have_count(2)
                for index in range(1, 3):
                    expect(dialog.locator(f'[data-batch-row="{index}"] .batch-independent-matrix-file')).to_contain_text('position_0.txt')
                page.evaluate("""async () => {
                  const store = await import('/src/features/workspace/model/sessionStore.js');
                  const {sessionId} = await store.fetchServiceSession();
                  const map = await store.loadWorkspaceConfig(sessionId, 'map');
                  map.config.project.workspace.externalChange = 'another-page';
                  await store.saveWorkspaceConfig(sessionId, map.mapId, map.config, 'map');
                }""")
                dialog.get_by_role('button', name='批量创建 2 组', exact=True).click()
                expect(dialog.get_by_role('alert')).to_contain_text('目标地图已变化')
                assert history(page) == []
            context.close()
            print('batch: directory pairing and concurrent target map protection passed', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    main()
