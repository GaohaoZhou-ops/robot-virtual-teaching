"""Real file picker, matrix replacement, geometry persistence and mode isolation."""
import tempfile
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, seed, snapshot
from topbar_tools_helpers import topbar_action
from archive_helpers import start_project_download, read_exported_project
from export_separation_ui_smoke import load_project

SAMPLE = Path(__file__).parent / 'fixtures' / 'virtual2map.txt'
QUARTER = b'0 -1 0 4\n1 0 0 -2\n0 0 1 .5\n0 0 0 1'


def choose(page, payload, reload=True):
    def pick():
        with page.expect_file_chooser() as chooser:
            topbar_action(page, '转换矩阵', exact=True).click()
        chooser.value.set_files(payload)
    if reload:
        with page.expect_navigation(wait_until='networkidle'):
            pick()
        ready(page, 'map')
    else:
        pick()


def matrix_file(content, name='matrix.txt'):
    return {'name': name, 'mimeType': 'text/plain', 'buffer': content}


def compare(actual, expected, tolerance=5e-6):
    assert len(actual) == len(expected)
    assert all(abs(a - b) < tolerance for a, b in zip(actual, expected)), (actual[:9], expected[:9])


def run():
    errors = []
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='map-matrix-') as temporary:
        browser = p.chromium.launch(headless=True, **({'executable_path': str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page, ['map', 'independent'], 'map', fixture_name='teachingTransferColored3DFixture')
            background_count = page.evaluate('''async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const {placeTeachingWorkspace, identityTransferPose} = await import('/src/features/teaching/model/teachingTransfer.js');
              const {sessionId} = await store.fetchServiceSession();
              const source = await store.loadWorkspaceSnapshot(sessionId, 'independent');
              const target = await store.loadWorkspaceSnapshot(sessionId, 'map');
              const result = await placeTeachingWorkspace(source, target, {localToMap:identityTransferPose()});
              await store.commitWorkspaceTransfer(sessionId, target, target, result);
              return target.map.pointCount;
            }''')
            page.reload(wait_until='networkidle')
            ready(page, 'map')
            original = snapshot(page, 'map')
            independent = snapshot(page, 'independent')
            action = topbar_action(page, '转换矩阵', exact=True)
            expect(action).to_be_enabled()
            panel = page.locator('[data-workbench-menu="teaching"]')
            line = panel.get_by_role('separator')
            expect(line).to_have_count(1)
            assert line.evaluate('el => getComputedStyle(el).borderTopStyle') == 'dashed'
            switch = panel.get_by_role('button', name='切换到独立示教', exact=True)
            assert action.bounding_box()['y'] < line.bounding_box()['y'] < switch.bounding_box()['y']
            page.screenshot(path='/tmp/atlas-map-matrix-menu.png', full_page=True)

            # Cancelling a chooser must leave the workspace untouched.
            choose(page, [], reload=False)
            assert snapshot(page, 'map')['positions'] == original['positions']
            choose(page, str(SAMPLE))
            first = snapshot(page, 'map')
            expect(topbar_action(page, '转换矩阵', exact=True)).to_contain_text('已加载')
            assert first['project']['workspace']['mapTransform']['name'] == 'virtual2map.txt'
            page.keyboard.press('Escape')
            page.screenshot(path='/tmp/atlas-map-matrix-applied.png', full_page=True)
            rows = [list(map(float, row.split())) for row in SAMPLE.read_text().strip().splitlines()]
            for before, after in zip(original['project']['waypoints'], first['project']['waypoints']):
                v = [before['pose'][axis] for axis in ('x', 'y', 'z')] + [1]
                compare([after['pose'][axis] for axis in ('x', 'y', 'z')],
                        [sum(a * b for a, b in zip(row, v)) for row in rows[:3]], 4e-5)
            assert first['positions'][:background_count * 3] == original['positions'][:background_count * 3]
            assert first['positions'][background_count * 3:] != original['positions'][background_count * 3:]
            assert snapshot(page, 'independent') == independent

            # The same file triggers change again, including after full hydration.
            choose(page, str(SAMPLE))
            repeat = snapshot(page, 'map')
            assert repeat['positions'] == first['positions']
            assert repeat['project']['waypoints'] == first['project']['waypoints']
            assert repeat['project']['virtualTeaching'] == first['project']['virtualTeaching']

            choose(page, matrix_file(QUARTER))
            replaced = snapshot(page, 'map')
            for before, after in zip(original['project']['waypoints'], replaced['project']['waypoints']):
                v = before['pose']
                compare([after['pose'][axis] for axis in ('x', 'y', 'z')], [-v['y'] + 4, v['x'] - 2, v['z'] + .5])
            expected_positions = list(original['positions'][:background_count * 3])
            for index in range(background_count * 3, len(original['positions']), 3):
                x, y, z = original['positions'][index:index + 3]
                expected_positions.extend([-y + 4, x - 2, z + .5])
            compare(replaced['positions'], expected_positions)

            choose(page, matrix_file(b'1 2 3', 'invalid.txt'), reload=False)
            expect(page.locator('.toast-message:visible')).to_contain_text('转换矩阵必须为 4 行')
            expect(page.locator('.loading-curtain')).to_be_hidden()
            failed = snapshot(page, 'map')
            assert failed['positions'] == replaced['positions']
            assert failed['project']['waypoints'] == replaced['project']['waypoints']
            assert failed['project']['workspace']['mapTransform'] == replaced['project']['workspace']['mapTransform']

            # Save through the actual UI, restore in a fresh browser context,
            # and reload the same matrix without applying it twice.
            with page.expect_download() as downloaded:
                start_project_download(page, 'matrix-transform')
            assert read_exported_project(downloaded.value)['workspace']['mapTransform'] == replaced['project']['workspace']['mapTransform']
            archive = Path(temporary) / 'matrix-transform.zip'
            downloaded.value.save_as(archive)
            restored = browser.new_page(viewport={'width': 1440, 'height': 1000})
            restored.on('pageerror', lambda error: errors.append(str(error)))
            load_project(restored, 'map', archive)
            restored_before = snapshot(restored, 'map')
            choose(restored, matrix_file(QUARTER))
            restored_after = snapshot(restored, 'map')
            assert restored_after['positions'] == restored_before['positions']
            assert restored_after['project']['waypoints'] == restored_before['project']['waypoints']
            restored.close()

            other = browser.new_page(viewport={'width': 1440, 'height': 1000})
            other.on('pageerror', lambda error: errors.append(str(error)))
            seed(other, ['independent'], 'independent')
            other.locator('[data-workbench-menu-trigger="teaching"]').click()
            expect(other.get_by_role('button', name='转换矩阵', exact=True, include_hidden=True)).to_have_count(0)
            assert not errors, errors
            print('PASS: menu separator, file picker/cancel, sample, replacement, reload, invalid file, ZIP and mode isolation')
        finally:
            browser.close()


if __name__ == '__main__':
    run()
