from topbar_tools_helpers import topbar_action

import copy
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download, read_exported_project
from ipad_menu_helpers import open_ipad_dialog, open_ipad_menu, select_teaching_source


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
    open_ipad_dialog(page, '导入结果文件')
    dialog = page.get_by_role('dialog', name='iPad 示教')
    expect(dialog.get_by_role('alert')).to_have_count(0)
    expect(dialog.get_by_role('button', name='导入结果文件')).to_be_enabled()
    dialog.locator('[data-ipad-result-input]').set_input_files({
        'name': 'test.atlas-teaching.json', 'mimeType': 'application/json', 'buffer': json.dumps(archive).encode(),
    })
    result = archive['result']
    count = sum(result['device'].get('platform') == 'visionOS' or sample.get('origin') != 'desktop'
                for sample in result['samples'])
    expect(dialog.locator('.ipad-result-file__receipt')).to_contain_text(f"已接收 {count} 个 Pose")
    page.get_by_role('button', name='关闭设备示教窗口').click()


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    project, archive = fixture_data()
    archive['result']['samples'][0]['origin'] = 'ipad'
    captured_result = copy.deepcopy(archive['result'])
    for side in ['left', 'right']:
        reference = copy.deepcopy(archive['result']['samples'][0])
        reference.update(id=f'desktop-reference-{side}', name=f'电脑参考 {side}', origin='desktop', arm=side)
        archive['result']['samples'].append(reference)
    mobile_id = 'ipad-' + archive['result']['id']
    errors, lan_requests = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: lan_requests.append(request.url) if '/__atlas/ipad/' in request.url else None)
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
            # Keyboard navigation traverses both menu levels and returns focus to the trigger.
            trigger = topbar_action(page, name='iPad', exact=True)
            trigger.focus()
            trigger.press('Enter')
            page.get_by_role('menu', name='iPad', exact=True).press('ArrowDown')
            parent = page.get_by_role('menuitem', name='示教来源', exact=True)
            expect(parent).to_be_focused()
            parent.press('ArrowRight')
            source_item = page.get_by_role('menuitemradio', name='查看独立示教', exact=True)
            expect(source_item).to_be_focused()
            expect(page.get_by_role('menuitemradio', name='查看 iPad 示教', exact=True)).to_have_count(0)
            source_item.press('ArrowLeft')
            expect(parent).to_be_focused()
            parent.press('ArrowDown')
            sync_parent = page.get_by_role('menuitem', name='同步与接收', exact=True)
            expect(sync_parent).to_be_focused()
            sync_parent.press('ArrowRight')
            first = page.get_by_role('menuitem', name='扫码配对', exact=True)
            expect(first).to_be_focused()
            first.press('End')
            expect(page.get_by_role('menuitem', name='新建传输', exact=True)).to_be_focused()
            page.keyboard.press('Home')
            expect(first).to_be_focused()
            first.press('Escape')
            expect(sync_parent).to_be_focused()
            sync_parent.press('Escape')
            expect(page.get_by_role('button', name='设备菜单', exact=True)).to_be_focused()
            expect(trigger).to_have_attribute('aria-expanded', 'false')
            topbar_action(page, name='iPad', exact=True).click()
            parent.hover()
            expect(source_item).to_be_visible()
            page.locator('.panel-3d .panel-heading').click(position={'x': 30, 'y': 20})
            expect(trigger).to_have_attribute('aria-expanded', 'false')
            import_result(page, archive)
            assert not lan_requests, 'file entry and menu browsing need no LAN session'
            # An iPad-only project must not advertise those Poses under Vision Pro.
            vision_sources = open_ipad_menu(page, '示教来源', 'Vision Pro')
            expect(vision_sources).to_contain_text('暂无 Vision Pro 示教')
            expect(page.get_by_role('menu', name='Vision Pro', exact=True)).not_to_contain_text('iPad')
            expect(vision_sources.get_by_role('menuitemradio', name='查看 iPad 示教')).to_have_count(0)
            canvas = page.locator('.three-canvas')
            desktop = page.get_by_role('menuitemradio', name='查看独立示教', exact=True)
            mobile = page.get_by_role('menuitemradio', name='查看 iPad 示教', exact=True)
            open_ipad_menu(page, '示教来源')
            expect(mobile).to_have_attribute('aria-checked', 'true')
            expect(tree).to_have_attribute('data-task-count', '1')
            expect(tree).to_contain_text('iPad · 2 个 Pose')
            expect(tree.locator('[data-mobile-sample-id]')).to_have_count(2)
            expect(tree).not_to_contain_text('电脑参考')
            expect(page.get_by_role('button', name='电脑端示教', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='机器人示教', exact=True)).to_have_count(0)
            expect(canvas).to_have_attribute('data-mobile-capture-visible', 'true')
            saved_workspace(page, mobile_id, 3)
            view = camera_view(canvas)
            page.screenshot(path=str(ARTIFACTS / 'ipad-view.png'), full_page=True)
            for _ in range(3):
                select_teaching_source(page, '查看独立示教')
                expect(canvas).to_have_attribute('data-mobile-capture-visible', 'false')
                expect(tree).to_have_attribute('data-task-count', '2')
                expect(tree).to_have_attribute('data-active-task', 'desktop-task-1')
                expect(tree).to_have_attribute('data-active-parking-point', 'stop-1-1')
                assert camera_view(canvas) == view, 'source switching must not move the 3D camera'
                select_teaching_source(page, '查看 iPad 示教')
                expect(canvas).to_have_attribute('data-mobile-capture-visible', 'true')
                expect(tree).to_have_attribute('data-active-task', mobile_id)
            select_teaching_source(page, '查看独立示教')
            saved = saved_workspace(page, 'desktop-task-1', 3)
            assert saved['project']['virtualTeaching']['tasks'][:2] == original
            assert saved['project']['virtualTeaching']['tasks'][2]['mobileCapture'] == captured_result
            page.reload(wait_until='networkidle')
            ready(page)
            open_ipad_menu(page, '示教来源')
            expect(desktop).to_have_attribute('aria-checked', 'true')
            expect(canvas).to_have_attribute('data-mobile-capture-visible', 'false')
            expect(tree).to_have_attribute('data-active-parking-point', 'stop-1-1')
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.wait_for_function('''() => [...document.querySelectorAll('.ipad-nav-submenu button')].every(button => {
                const r = button.getBoundingClientRect();
                return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight
                    && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            })''')
            page.screenshot(path=str(ARTIFACTS / 'desktop-view-1280.png'), full_page=True)
            topbar_action(page, name='打开示教数据管理页').click()
            expect(page.locator('.teaching-data-page')).to_have_attribute('data-teaching-task-count', '3')
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)['virtualTeaching']['tasks']
            assert exported[:2] == original
            assert exported[2]['mobileCapture'] == captured_result, 'exports contain only the iPad recordings'

            # Reopen an older project that already contains the returned desktop references.
            legacy_project = copy.deepcopy(project)
            legacy_task = copy.deepcopy(exported[2])
            legacy_task['mobileCapture'] = copy.deepcopy(archive['result'])
            legacy_project['virtualTeaching']['tasks'].append(legacy_task)
            legacy_project['workspace'].update(activeTeachingTaskId=mobile_id, activeTeachingParkingPointId=None)
            page.get_by_role('button', name='继续工作 · 返回主工作台继续示教').click()
            page.locator('[data-project-guide-input]').set_input_files({
                'name': 'legacy-mixed-origins.json', 'mimeType': 'application/json', 'buffer': json.dumps(legacy_project).encode(),
            })
            expect(tree).to_have_attribute('data-active-task', mobile_id)
            expect(tree.locator('[data-mobile-sample-id]')).to_have_count(2)
            legacy_saved = saved_workspace(page, mobile_id, 3)['project']['virtualTeaching']['tasks']
            assert legacy_saved[:2] == original
            assert legacy_saved[2]['mobileCapture'] == captured_result
            page.reload(wait_until='networkidle')
            ready(page)
            expect(tree.locator('[data-mobile-sample-id]')).to_have_count(2)
            expect(tree).not_to_contain_text('电脑参考')
            import_result(page, archive)
            assert len(saved_workspace(page, mobile_id, 3)['project']['virtualTeaching']['tasks']) == 3

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
            select_teaching_source(empty, '查看独立示教')
            saved_workspace(empty, None, 1)
            empty.reload(wait_until='networkidle')
            ready(empty)
            open_ipad_menu(empty, '示教来源')
            expect(empty.get_by_role('menuitemradio', name='查看独立示教', exact=True)).to_have_attribute('aria-checked', 'true')
            expect(empty.locator('.teaching-capture-tree-card')).to_have_attribute('data-task-count', '0')
            expect(empty.locator('.three-canvas')).to_have_attribute('data-mobile-capture-visible', 'false')
            select_teaching_source(empty, '查看 iPad 示教')
            expect(empty.locator('.three-canvas')).to_have_attribute('data-mobile-capture-visible', 'true')

            # Mixed-device projects retain all data while each source shows only its own tasks.
            second_ipad = copy.deepcopy(archive)
            second_ipad['result'].update(id=str(uuid.uuid4()), sessionId=str(uuid.uuid4()))
            import_result(empty, second_ipad)
            vision = copy.deepcopy(archive)
            vision['result']['samples'] = copy.deepcopy(captured_result['samples'])
            vision['result'].update(id=str(uuid.uuid4()), sessionId=str(uuid.uuid4()),
                                    device={'platform': 'visionOS', 'model': 'Apple Vision Pro',
                                            'lidar': False, 'poseSource': 'deviceAnchor'})
            for sample in vision['result']['samples']:
                sample['cameraPose']['frameName'] = 'visionpro_head_optical_frame'
                sample.pop('surfacePoint', None)
            import_result(empty, vision)
            vision_id = 'ipad-' + vision['result']['id']
            second_ipad_id = 'ipad-' + second_ipad['result']['id']
            mixed_tree = empty.locator('.teaching-capture-tree-card')
            expect(mixed_tree).to_have_attribute('data-active-task', vision_id)
            expect(mixed_tree).to_have_attribute('data-task-count', '1')
            expect(mixed_tree).to_contain_text('Vision Pro · 2 个 Pose')
            mixed_view = camera_view(empty.locator('.three-canvas'))
            for _ in range(2):
                ipad_sources = open_ipad_menu(empty, '示教来源')
                expect(ipad_sources.get_by_role('menuitemradio', name='查看 Vision Pro 示教')).to_have_count(0)
                expect(ipad_sources.get_by_role('menuitemradio', name='查看 iPad 示教')).to_have_attribute('aria-checked', 'false')
                select_teaching_source(empty, '查看 iPad 示教')
                expect(mixed_tree).to_have_attribute('data-active-task', second_ipad_id)
                expect(mixed_tree).to_have_attribute('data-task-count', '2')
                expect(mixed_tree).not_to_contain_text('Vision Pro')
                vision_sources = open_ipad_menu(empty, '示教来源', 'Vision Pro')
                expect(vision_sources.get_by_role('menuitemradio', name='查看 iPad 示教')).to_have_count(0)
                expect(vision_sources.get_by_role('menuitemradio', name='查看 Vision Pro 示教')).to_have_attribute('aria-checked', 'false')
                select_teaching_source(empty, '查看 Vision Pro 示教', 'Vision Pro')
                expect(mixed_tree).to_have_attribute('data-active-task', vision_id)
                expect(mixed_tree).to_have_attribute('data-task-count', '1')
                assert camera_view(empty.locator('.three-canvas')) == mixed_view
            saved_workspace(empty, vision_id, 3)
            empty.reload(wait_until='networkidle')
            ready(empty)
            expect(mixed_tree).to_have_attribute('data-active-task', vision_id)
            expect(mixed_tree).to_have_attribute('data-task-count', '1')
            open_ipad_menu(empty, '示教来源', 'Vision Pro')
            expect(empty.get_by_role('menuitemradio', name='查看 Vision Pro 示教')).to_have_attribute('aria-checked', 'true')
            empty.screenshot(path=str(ARTIFACTS / 'vision-source-filtered.png'), full_page=True)
            topbar_action(empty, name='打开示教数据管理页').click()
            expect(empty.locator('.teaching-data-page')).to_have_attribute('data-teaching-task-count', '3')
            with empty.expect_download() as download:
                start_project_download(empty)
            mixed_export = read_exported_project(download.value)['virtualTeaching']['tasks']
            assert {task['mobileCapture']['id'] for task in mixed_export} == {
                archive['result']['id'], second_ipad['result']['id'], vision['result']['id']}

            # Large Vision Pro captures remain browsable without loading a robot.
            large_archive = copy.deepcopy(vision)
            large_archive['result'].update(id=str(uuid.uuid4()), sessionId=str(uuid.uuid4()))
            large_archive['result']['samples'] = [
                {**copy.deepcopy(vision['result']['samples'][0]), 'id': f'vision-{i}', 'name': f'Pose {i + 1:03}'}
                for i in range(55)]
            large = browser.new_page(viewport={'width': 1280, 'height': 800})
            large.on('pageerror', lambda error: errors.append(str(error)))
            large.route('**/__atlas/ipad/**', lambda route: route.fulfill(
                status=503, content_type='application/json', body='{"error":"文件导入测试"}'))
            large.goto(BASE + '/workbench', wait_until='networkidle')
            ready(large)
            large.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(large)
            import_result(large, large_archive)
            expect(large.locator('[data-mobile-sample-id]')).to_have_count(50)
            large.get_by_role('button', name='下一页采样 Pose').click()
            expect(large.locator('[data-mobile-sample-id]')).to_have_count(5)
            large.get_by_role('treeitem', name='预览采样 Pose Pose 055', exact=True).click()
            large_canvas = large.locator('.three-canvas')
            expect(large_canvas).to_have_attribute('data-mobile-selected-sample', 'vision-54')
            expect(large_canvas).to_have_attribute('data-synchronized-focus-state', 'settled')
            large.get_by_role('button', name='计算机器人姿态', exact=True).click()
            solve = large.get_by_role('dialog', name='计算机器人姿态', exact=True)
            expect(solve.get_by_role('button', name='开始计算', exact=True)).to_be_disabled()
            expect(solve).to_contain_text('请先在本窗口加载机器人')
            expect(solve.get_by_role('button', name='加载机器人', exact=True)).to_be_enabled()
            solve.get_by_role('button', name='关闭姿态计算').click()
            large.screenshot(path=str(ARTIFACTS / 'vision-poses-paginated.png'), full_page=True)
            sources = large.get_by_role('group', name='示教来源', exact=True)
            view = camera_view(large_canvas)
            sources.get_by_role('button', name='电脑端示教', exact=True).click()
            expect(large_canvas).to_have_attribute('data-mobile-capture-visible', 'false')
            assert large_canvas.get_attribute('data-mobile-selected-sample') is None
            assert camera_view(large_canvas) == view
            sources.get_by_role('button', name='Vision Pro 示教', exact=True).click()
            expect(sources).to_contain_text('55 Pose')
            assert large.locator('.teaching-review-sources').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            assert not errors, errors
        finally:
            browser.close()
    print('Teaching source switching passed: device isolation, per-device selection, layer visibility, camera preservation, reload, complete export, narrow layout and empty desktop workspace.')


if __name__ == '__main__':
    run()
