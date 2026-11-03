"""Independent calibration fallback, portable archives and live camera projection."""
from pathlib import Path
import base64
import json
import math

from playwright.sync_api import expect, sync_playwright
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready
from viewer_tools_helpers import viewer_tool, display_settings_section


def run():
    artifacts = Path(__file__).resolve().parents[1] / 'test-artifacts' / 'camera-calibration'
    artifacts.mkdir(parents=True, exist_ok=True)
    errors = []
    cases = [
        ('missing-directory', 'missing', 'missing'),
        ('left-only', 'loaded', 'missing'),
        ('right-only', 'missing', 'loaded'),
        ('both-valid', 'loaded', 'loaded'),
        ('invalid-json', 'invalid', 'loaded'),
        ('invalid-matrix', 'loaded', 'invalid'),
        ('both-invalid', 'invalid', 'invalid'),
        ('legacy-both-local', 'loaded', 'loaded'),
        ('legacy-left-local', 'loaded', 'missing'),
        ('legacy-invalid-local', 'invalid', 'loaded'),
        ('legacy-read-failed', 'loaded', 'unavailable'),
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for name, left, right in cases:
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(BASE_URL, wait_until='networkidle')
                page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
                resource_files = page.evaluate('''async name => {
                  const { handEyeReport, calibrationRobotPackage } = await import('/tests/fixtures/hand_eye_calibration.mjs');
                  const files = {};
                  if (!['missing-directory', 'right-only'].includes(name)) files.left = handEyeReport();
                  if (!['missing-directory', 'left-only', 'legacy-left-local'].includes(name)) files.right = handEyeReport('right');
                  if (['invalid-json', 'both-invalid', 'legacy-invalid-local'].includes(name)) files.left = '{broken';
                  if (name === 'both-invalid') files.right = { format: 'wrong' };
                  if (name === 'invalid-matrix') files.right.methods.Park.camera_to_tool.rotation[0][0] = 4;
                  const pkg = calibrationRobotPackage(files);
                  window.calibrationTestPackage = pkg;
                  return Object.fromEntries(pkg.files.map(file => [file.path, btoa(String.fromCharCode(...file.bytes))]));
                }''', name)

                requests = []

                def resource_route(route):
                    path = route.request.url.split('/__atlas/robot-files/', 1)[1]
                    requests.append(path)
                    if name == 'legacy-read-failed' and path.endswith('/handeye_right_real_report.json'):
                        route.fulfill(status=503, body='calibration unavailable')
                    elif path in resource_files:
                        route.fulfill(status=200, body=base64.b64decode(resource_files[path]))
                    else:
                        route.fulfill(status=404, body='missing')

                page.route('**/__atlas/robot-files/calibration_fixture/**', resource_route)
                # Real catalog loading + collection/export/import, with no private assets.
                result = page.evaluate('''async name => {
                  const loader = await import('/src/features/robot/model/robotLoader.js');
                  const archive = await import('/src/features/workspace/model/projectArchive.js');
                  const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
                  const fixture = teachingTransferFixture('map');
                  const robot = loader.normalizeRobotDescriptor({ ...window.calibrationTestPackage, name: 'Zivid M70 calibration test' });
                  const model = await loader.loadRobotModel(robot);
                  const states = Object.values(model.userData.robot.cameraCalibration).map(s => s.status);
                  const matrices = ['left', 'right'].map(s => model.getObjectByName(`zivid_${s}_optical_frame`).matrixWorld.toArray());
                  loader.disposeRobotModel(model);
                  const pkg = await archive.collectProjectRobotResources(robot);
                  // Restore an older workspace whose robot package contains
                  // geometry only; the calibration exists solely on disk.
                  if (name.startsWith('legacy-')) pkg.files = pkg.files.filter(file => !file.path.includes('/calib/'));
                  fixture.map.portableRobotPackage = pkg;
                  const project = fixture.config.config.project;
                  project.robot = { ...robot, origin: { position: {x: 10, y: 20, z: 0}, rpy: {roll: 0, pitch: 0, yaw: 0} }, joints: {} };
                  project.virtualTeaching.tasks = [];
                  project.virtualTeaching.jointPoses = [];
                  fixture.config.config.ui.selectedRobot = project.robot;
                  // Imported descriptors omit the catalog-source marker.
                  delete project.robot.portableResourceId;
                  const built = await archive.buildProjectArchive(project, { mapResource: fixture.map, existingRobotPackage: pkg });
                  const restored = await archive.readProjectArchive(built.bytes);
                  const id = loader.registerPortableRobotPackage(restored.resources.robot);
                  const originalFetch = window.fetch;
                  // Import the exported archive with local robot files removed.
                  // Valid supplements must now be carried by the archive itself.
                  if (name.startsWith('legacy-') && name !== 'legacy-read-failed') {
                    window.fetch = (url, options) => String(url).includes('/__atlas/robot-files/')
                      ? Promise.resolve(new Response('local files removed', { status: 404 })) : originalFetch(url, options);
                  }
                  try {
                    const portable = await loader.loadRobotModel({ ...project.robot, portableResourceId: id });
                    const roundtrip = Object.values(portable.userData.robot.cameraCalibration).map(s => s.status);
                    const restoredMatrices = ['left', 'right'].map(s => portable.getObjectByName(`zivid_${s}_optical_frame`).matrixWorld.toArray());
                    loader.disposeRobotModel(portable);
                    window.calibrationTestFixture = fixture;
                    const allowedLookups = ['left', 'right'].map(side => `calibration_fixture/calib/handeye_${side}_real_report.json`)
                      .filter(path => !pkg.files.some(file => file.path === path));
                    return {states, roundtrip, matrices, restoredMatrices, allowedLookups,
                      fileCount: restored.resources.robot.files.length};
                  } finally { window.fetch = originalFetch; loader.releasePortableRobotPackage(id); }
                }''', name)
                assert result['states'] == [left, right], (name, result)
                assert result['roundtrip'] == [left, right], (name, result)
                assert result['matrices'] == result['restoredMatrices']
                requests.clear()
                await_seed = '''async () => {
                  const store = await import('/src/features/workspace/model/sessionStore.js');
                  const {sessionId} = await store.fetchServiceSession();
                  const fixture = window.calibrationTestFixture;
                  await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, 'map');
                  await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, 'map');
                  await store.activateWorkspaceMode(sessionId, 'map');
                }'''
                page.evaluate(await_seed)
                page.goto(f'{BASE_URL}/workbench', wait_until='networkidle')
                ready(page, 'map')
                status = page.get_by_role('status', name='机器人相机标定', exact=True)
                expect(status).to_be_visible()
                for side, state in [('left', left), ('right', right)]:
                    expect(status.locator(f'[data-side="{side}"]')).to_have_attribute('data-calibration-state', state)
                if left != 'loaded' or right != 'loaded':
                    expect(status).to_contain_text('默认方案')
                page.get_by_role('tab', name='相机', exact=True).click()
                for side, state in [('left', left), ('right', right)]:
                    panel = page.locator(f'.zivid-camera-panel[data-camera-slot="{side}"]')
                    expect(panel).to_have_attribute('data-renderer-status', 'ready')
                    expect(panel).to_have_attribute('data-calibration-state', state)
                    projection = [float(v) for v in panel.locator('.zivid-camera-canvas').get_attribute('data-projection').split(',')]
                    expected_x = 2 * (1600 if side == 'left' else 1500) / 1944 if state == 'loaded' else 1 / math.tan(math.radians(56.6 / 2))
                    assert abs(projection[0] - expected_x) < 1e-8, (name, projection)
                    assert abs(projection[8] - (1 - 2000 / 1944 if state == 'loaded' else 0)) < 1e-8
                viewer_tool(page, name='定位机器人模型').click()
                expect(page.locator('.three-canvas')).to_have_attribute('data-robot-control-enabled', 'true')
                page.screenshot(path=str(artifacts / f'{name}.png'))
                if name in ['both-valid', 'invalid-json']:
                    settings = display_settings_section(page, '机器人与相机')
                    calibration_toggle = settings.get_by_role('checkbox', name='显示标定结果提示', exact=True)
                    optical_toggle = settings.get_by_role('checkbox', name='显示 Zivid 光学坐标系', exact=True)
                    expect(calibration_toggle).to_be_checked()
                    page.screenshot(path=str(artifacts / f'{name}-display-settings.png'))
                    calibration_toggle.uncheck()
                    expect(status).to_have_count(0)
                    expect(optical_toggle).not_to_be_checked()
                    expect(page.locator('.zivid-camera-panel[data-camera-slot="right"]')).to_have_attribute('data-calibration-state', right)
                    calibration_toggle.check()
                    expect(status).to_be_visible()
                    page.get_by_role('button', name='显示设置', exact=True).click()
                if name in ['left-only', 'both-valid', 'legacy-both-local', 'legacy-left-local']:
                    page.reload(wait_until='networkidle')
                    ready(page, 'map')
                    expect(status.locator('[data-side="left"]')).to_have_attribute('data-calibration-state', left)
                    expect(status.locator('[data-side="right"]')).to_have_attribute('data-calibration-state', right)
                assert set(requests).issubset(result['allowedLookups']), f'Unexpected catalog fallback: {requests}'
                if name.startswith('legacy-'):
                    assert set(result['allowedLookups']).issubset(requests), f'Local calibration was never requested: {requests}'
                print(json.dumps({'case': name, 'states': result['states'], 'archiveFiles': result['fileCount']}, ensure_ascii=False), flush=True)
                context.close()
            assert not errors, errors
            print('Calibration UI, catalog/portable fallback, projection and reload passed.', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
