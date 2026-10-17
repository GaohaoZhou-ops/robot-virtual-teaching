import copy
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
ARTIFACTS = Path(os.environ.get('ATLAS_TEST_ARTIFACTS', ROOT / 'test-artifacts/teaching-source-switch'))
CHROME = os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def ready(page):
    page.locator('[data-session-state="ready"]').wait_for(state='attached')
    page.locator('.loading-curtain').wait_for(state='hidden')


def saved_workspace(page, task_id, count):
    read_config = '''async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('atlas-route-studio', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const config = await new Promise((resolve, reject) => {
            const request = db.transaction('workspace-session', 'readonly')
                .objectStore('workspace-session').get('workspace-config:independent');
            request.onsuccess = () => resolve(request.result?.config);
            request.onerror = () => reject(request.error);
        });
        db.close();
        return config;
    }'''
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        config = page.evaluate(read_config)
        if config and config.get('ui', {}).get('activeTeachingTaskId') == task_id \
                and len(config.get('project', {}).get('virtualTeaching', {}).get('tasks', [])) == count:
            return config
        page.wait_for_timeout(100)
    raise AssertionError(f'Workspace was not saved for {task_id}, {count} tasks')


def camera_view(canvas):
    return canvas.evaluate('''canvas => Object.fromEntries(
        ['cameraX', 'cameraY', 'cameraZ', 'targetX', 'targetY', 'targetZ', 'cameraUpX', 'cameraUpY', 'cameraUpZ']
            .map(key => [key, canvas.dataset[key]]))''')


def fixture_data():
    manifest = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
        import { readFileSync } from 'node:fs';
        import { createHash } from 'node:crypto';
        import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
        import { packIPadModel } from './src/lib/ipadTeaching.js';
        const bytes = readFileSync('tests/fixtures/rotation-map.ply');
        const geometry = new PLYLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        geometry.computeBoundingBox();
        const { manifest } = await packIPadModel({geometry, name: 'rotation-map.ply',
            sourceHash: createHash('sha256').update(bytes).digest('hex'), bounds: geometry.boundingBox});
        console.log(JSON.stringify(manifest));
    '''], cwd=ROOT, text=True))
    project = json.loads((ROOT / 'tests/fixtures/teaching-pose-preview.json').read_text())
    project['map'].update(fileName=manifest['name'], sourceHash=manifest['sourceHash'], bounds=manifest['bounds'])
    original = project['virtualTeaching']['tasks'][0]
    tasks = []
    for index in range(2):
        task = copy.deepcopy(original)
        task.update(id=f'desktop-task-{index}', name=f'电脑原有任务 {index + 1}')
        task['map'].update(fileName=manifest['name'], sourceHash=manifest['sourceHash'])
        parking = task['parkingPoints'][0]
        task['parkingPoints'] = []
        for stop in range(2):
            point = copy.deepcopy(parking)
            point.update(id=f'stop-{index}-{stop}', name=f'停车点 P0{stop + 1}', sequence=stop + 1)
            point['poses'][0]['id'] = f'pose-{index}-{stop}'
            task['parkingPoints'].append(point)
        tasks.append(task)
    project['virtualTeaching']['tasks'] = tasks
    project['workspace'].update(activeTeachingTaskId='desktop-task-1', activeTeachingParkingPointId='stop-1-1')
    timestamp = '2026-10-17T03:00:00Z'
    result = {
        'protocol': 'atlas-ipad-teaching/1', 'id': str(uuid.uuid4()), 'sessionId': str(uuid.uuid4()),
        'modelHash': manifest['modelHash'], 'coordinateFrame': 'virtual_origin',
        'createdAt': timestamp, 'completedAt': timestamp,
        'device': {'platform': 'iPadOS', 'model': 'iPad Pro test', 'lidar': True},
        'calibrations': [{'id': 'segment', 'worldFromModel': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}],
        'samples': [{'id': f'mobile-pose-{index}', 'segmentId': 'segment', 'name': f'Pose {index + 1:03}',
            'kind': 'keyframe', 'tracking': 'normal', 'capturedAt': timestamp,
            'cameraPose': {'frameName': 'ipad_camera_optical_frame',
                'position': {'x': index + 1, 'y': -1, 'z': 2}, 'quaternion': {'x': 0, 'y': 0, 'z': 0, 'w': 1}},
            'surfacePoint': {'x': index + 1, 'y': 0, 'z': 1}} for index in range(2)],
    }
    return project, {'format': 'atlas-teaching-result', 'version': 1, 'manifest': manifest, 'result': result}


def import_result(page, archive):
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    dialog = page.get_by_role('dialog', name='移动到 iPad 或 Vision Pro 上运行')
    expect(dialog.get_by_role('alert')).to_have_text('测试：文件导入')
    expect(dialog.get_by_role('button', name='导入结果文件')).to_be_enabled()
    dialog.locator('[data-ipad-result-input]').set_input_files({
        'name': 'test.atlas-teaching.json', 'mimeType': 'application/json', 'buffer': json.dumps(archive).encode(),
    })
    expect(dialog.locator('.ipad-result-file__receipt')).to_contain_text('已接收 2 个 Pose')
    page.get_by_role('button', name='关闭设备示教窗口').click()


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    project, archive = fixture_data()
    mobile_id = 'ipad-' + archive['result']['id']
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            # Exercise file import without creating transfers in the user's LAN store.
            page.route('**/__atlas/ipad/**', lambda route: route.fulfill(
                status=503, content_type='application/json', body='{"error":"测试：文件导入"}'))
            page.goto(BASE + '/workbench', wait_until='networkidle')
            ready(page)
            expect(page.get_by_role('group', name='示教来源', exact=True)).to_have_count(0)
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            page.locator('[data-project-guide-input]').set_input_files({
                'name': 'desktop.json', 'mimeType': 'application/json', 'buffer': json.dumps(project).encode(),
            })
            tree = page.locator('.teaching-capture-tree-card')
            expect(tree).to_have_attribute('data-active-task', 'desktop-task-1')
            expect(tree).to_have_attribute('data-active-parking-point', 'stop-1-1')
            original = saved_workspace(page, 'desktop-task-1', 2)['project']['virtualTeaching']['tasks']
            import_result(page, archive)
            canvas = page.locator('.three-canvas')
            desktop = page.get_by_role('button', name='查看独立示教', exact=True)
            mobile = page.get_by_role('button', name='查看 iPad 示教', exact=True)
            expect(mobile).to_have_attribute('aria-pressed', 'true')
            expect(tree).to_have_attribute('data-task-count', '1')
            expect(tree).to_contain_text('iPad · 2 个 Pose')
            expect(canvas).to_have_attribute('data-mobile-capture-visible', 'true')
            saved_workspace(page, mobile_id, 3)
            view = camera_view(canvas)
            page.screenshot(path=str(ARTIFACTS / 'ipad-view.png'), full_page=True)
            for _ in range(3):
                desktop.click()
                expect(desktop).to_have_attribute('aria-pressed', 'true')
                expect(canvas).to_have_attribute('data-mobile-capture-visible', 'false')
                expect(tree).to_have_attribute('data-task-count', '2')
                expect(tree).to_have_attribute('data-active-task', 'desktop-task-1')
                expect(tree).to_have_attribute('data-active-parking-point', 'stop-1-1')
                assert camera_view(canvas) == view, 'source switching must not move the 3D camera'
                mobile.click()
                expect(canvas).to_have_attribute('data-mobile-capture-visible', 'true')
                expect(tree).to_have_attribute('data-active-task', mobile_id)
            desktop.click()
            saved = saved_workspace(page, 'desktop-task-1', 3)
            assert saved['project']['virtualTeaching']['tasks'][:2] == original
            assert saved['project']['virtualTeaching']['tasks'][2]['mobileCapture'] == archive['result']
            page.reload(wait_until='networkidle')
            ready(page)
            expect(desktop).to_have_attribute('aria-pressed', 'true')
            expect(canvas).to_have_attribute('data-mobile-capture-visible', 'false')
            expect(tree).to_have_attribute('data-active-parking-point', 'stop-1-1')
            page.set_viewport_size({'width': 1280, 'height': 800})
            for button in [desktop, mobile]:
                assert button.evaluate('''button => {
                    const r = button.getBoundingClientRect();
                    return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight
                        && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
                }'''), 'source buttons must remain reachable at 1280 × 800'
            page.screenshot(path=str(ARTIFACTS / 'desktop-view-1280.png'), full_page=True)
            page.get_by_role('button', name='打开示教数据管理页').click()
            expect(page.locator('.teaching-data-page')).to_have_attribute('data-teaching-task-count', '3')
            with page.expect_download() as download:
                page.get_by_role('button', name='导出示教工程 ZIP', exact=True).click()
            exported = read_exported_project(download.value)['virtualTeaching']['tasks']
            assert exported[:2] == original
            assert exported[2]['mobileCapture'] == archive['result'], 'hidden device data must remain in project exports'

            # With no desktop tasks yet, the desktop view must remain usable and survive reload.
            empty = browser.new_page(viewport={'width': 1280, 'height': 800})
            empty.set_default_timeout(30000)
            empty.on('pageerror', lambda error: errors.append(str(error)))
            empty.route('**/__atlas/ipad/**', lambda route: route.fulfill(
                status=503, content_type='application/json', body='{"error":"测试：文件导入"}'))
            empty.goto(BASE + '/workbench', wait_until='networkidle')
            ready(empty)
            empty.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(empty)
            import_result(empty, archive)
            empty.get_by_role('button', name='查看独立示教', exact=True).click()
            saved_workspace(empty, None, 1)
            empty.reload(wait_until='networkidle')
            ready(empty)
            expect(empty.get_by_role('button', name='查看独立示教', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(empty.locator('.teaching-capture-tree-card')).to_have_attribute('data-task-count', '0')
            expect(empty.locator('.three-canvas')).to_have_attribute('data-mobile-capture-visible', 'false')
            empty.get_by_role('button', name='查看 iPad 示教', exact=True).click()
            expect(empty.locator('.three-canvas')).to_have_attribute('data-mobile-capture-visible', 'true')
            assert not errors, errors
        finally:
            browser.close()
    print('Teaching source switching passed: original task/parking selection, layer visibility, camera preservation, reload, complete export, narrow layout and empty desktop workspace.')


if __name__ == '__main__':
    run()
