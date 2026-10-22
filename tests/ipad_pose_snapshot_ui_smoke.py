import copy
import hashlib
import json
import os
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright
from ipad_menu_helpers import open_ipad_dialog

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22041')
ARTIFACTS = Path(os.environ.get('ATLAS_TEST_ARTIFACTS', ROOT / 'test-artifacts/ipad-pose-snapshot'))
FIXTURE = ROOT / 'tests/fixtures/rotation-map.ply'


def ready(page):
    page.locator('[data-session-state="ready"]').wait_for(state='attached')
    page.locator('.loading-curtain').wait_for(state='hidden')


def pair(ticket):
    request = Request(BASE + '/__atlas/ipad/pair', data=json.dumps({
        'code': ticket['pairingCode'], 'deviceId': str(uuid.uuid4()), 'deviceName': 'iPad Pose snapshot test',
    }).encode(), headers={'Content-Type': 'application/json'})
    with urlopen(request) as response:
        return json.load(response)


project = json.loads((ROOT / 'tests/fixtures/teaching-pose-preview.json').read_text())
source_hash = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
project['map'].update(fileName=FIXTURE.name, sourceHash=source_hash)
task = project['virtualTeaching']['tasks'][0]
task['map'].update(fileName=FIXTURE.name, sourceHash=source_hash)
parking = task['parkingPoints'][0]
prototype = parking['poses'][0]
parking['poses'] = []
for index in range(3):
    pose = copy.deepcopy(prototype)
    pose.update(id=f'mac-pose-{index}', name=f'Mac Pose {index + 1}', sequence=index + 1)
    pose.pop('cameraCapture', None)
    pose['opticalTargets'] = {'left': {'frameName': 'zivid_left_optical_frame',
        'position': {'x': index, 'y': 0, 'z': 1}, 'quaternion': {'x': 1, 'y': 0, 'z': 0, 'w': 0}}}
    pose['opticalTargets']['right'] = copy.deepcopy(pose['opticalTargets']['left'])
    pose['opticalTargets']['right']['frameName'] = 'zivid_right_optical_frame'
    pose['opticalTargets']['right']['position']['x'] += 0.3
    parking['poses'].append(pose)

ARTIFACTS.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True,
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(30000)
    errors, created = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('response', lambda response: created.append(response.json())
        if response.url == BASE + '/__atlas/ipad/sessions' and response.request.method == 'POST'
        and response.status == 201 else None)
    try:
        page.goto(BASE + '/workbench', wait_until='networkidle')
        ready(page)
        page.locator('[data-independent-teaching-input]').set_input_files(str(FIXTURE))
        ready(page)
        dialog = open_ipad_dialog(page)
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        expect(dialog.locator('.ipad-pose-summary')).to_contain_text('携带 0 个相机 Pose')
        assert len(created) == 1
        old = created[0]
        pair(old)
        dialog.get_by_role('button', name='关闭设备示教窗口').click()

        def import_poses():
            page.locator('[data-project-guide-input]').set_input_files({
                'name': 'three-mac-poses.json', 'mimeType': 'application/json',
                'buffer': json.dumps(project).encode(),
            })
            ready(page)
            expect(page.locator('.teaching-capture-tree-card')).to_have_attribute('data-active-task', task['id'])

        import_poses()
        dialog = open_ipad_dialog(page)
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        expect(dialog.locator('.ipad-pose-summary')).to_contain_text('携带 6 个相机 Pose：左臂 3 个（青色）')
        expect(dialog.locator('.ipad-pose-summary')).to_contain_text('右臂 3 个（金黄色）')
        assert len(created) == 2
        current = created[-1]
        assert current['id'] != old['id'] and current['referencePoseCount'] == 6
        received = pair(current)
        assert len(received['poseSeed']['samples']) == 6
        assert [sample['arm'] for sample in received['poseSeed']['samples']] == ['left', 'right'] * 3
        assert all(sample['origin'] == 'desktop' for sample in received['poseSeed']['samples'])
        page.screenshot(path=str(ARTIFACTS / 'six-camera-poses.png'), full_page=True)
        dialog.get_by_role('button', name='关闭设备示教窗口').click()
        dialog = open_ipad_dialog(page)
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        assert len(created) == 2, 'unchanged poses reuse the current transfer'
        dialog.get_by_role('button', name='刷新二维码').click()
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        expect(dialog.get_by_role('button', name='关闭设备示教窗口')).to_be_enabled()
        assert len(created) == 2

        # Choosing a historical zero-Pose snapshot must remain an explicit choice.
        dialog.locator('.ipad-history select').select_option(old['id'])
        expect(dialog.locator('.ipad-pose-summary')).to_contain_text('携带 0 个相机 Pose')
        dialog.get_by_role('button', name='刷新二维码').click()
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        assert len(created) == 2
        dialog.get_by_role('button', name='关闭设备示教窗口').click()

        parking['poses'][0]['opticalTargets']['left']['position']['x'] = 0.25
        import_poses()
        dialog = open_ipad_dialog(page)
        expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
        expect(dialog.locator('.ipad-pose-summary')).to_contain_text('携带 6 个相机 Pose')
        assert len(created) == 3, 'same-count edits must also produce a current QR'
        assert created[-1]['referencePoseHash'] != current['referencePoseHash']
        assert not errors, errors
        print('UI: old model-only QR → 3 left + 3 right camera poses; payload, reuse, history and same-count edits passed.')
    finally:
        browser.close()
