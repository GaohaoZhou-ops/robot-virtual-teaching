"""Computed poses can use the task player before saving, and after every rerun."""
import copy
import json

from playwright.sync_api import expect, sync_playwright

from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from mobile_teaching_solver_ui_smoke import BASE, CHROME, ROOT, await_saved
from topbar_tools_helpers import topbar_action

ARTIFACTS = ROOT / 'test-artifacts/mobile-teaching-playback'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
    fixture = json.loads((ROOT / 'tests/fixtures/mobile-teaching-botx.json').read_text())
    template = archive['result']['samples'][0]
    samples = []
    for index, target in enumerate([fixture['targets'][0], fixture['targets'][7]]):
        sample = copy.deepcopy(template)
        sample.update(id=f'preview-{index}', name=f'动态预览 Pose {index + 1}', cameraPose=target)
        samples.append(sample)
    unreachable = copy.deepcopy(samples[0])
    unreachable.update(id='preview-unreachable', name='不可达 Pose')
    unreachable['cameraPose']['position'] = dict(x=20, y=20, z=20)
    archive['result']['samples'] = [*samples, unreachable]
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/__atlas/ipad/**', lambda route: route.fulfill(
                status=503, content_type='application/json', body='{"error":"文件导入测试"}'))
            page.goto(BASE + '/workbench', wait_until='networkidle')
            ready(page)
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            import_result(page, archive)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            dialog.get_by_role('combobox', name='停车点策略').select_option('per-pose')
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            computation = page.get_by_role('region', name='设备姿态后台计算')
            expect(computation).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            source = config['project']['virtualTeaching']['tasks'][0]
            report = source['mobileSolve']
            assert report['feasibleCount'] == 2, report['rows']
            assert report['parkingCount'] == 2
            expect(computation.get_by_role('button', name='动态预览', exact=True)).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'completed.png'), full_page=True)
            computation.get_by_role('button', name='动态预览', exact=True).click()
            playback = page.get_by_role('region', name='示教任务轨迹播放控制', exact=True)
            expect(playback).to_have_attribute('data-playback-status', 'playing')
            expect(playback).to_have_attribute('data-playback-pose', '1/2')
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'hidden')
            first_preview = playback.get_attribute('data-playback-task')
            playback.get_by_role('button', name='暂停示教轨迹播放', exact=True).click()
            expect(playback).to_have_attribute('data-playback-status', 'paused')
            elapsed = playback.get_attribute('data-playback-elapsed-ms')
            joints = canvas.get_attribute('data-robot-joint-values')
            page.wait_for_timeout(250)
            expect(playback).to_have_attribute('data-playback-elapsed-ms', elapsed)
            expect(canvas).to_have_attribute('data-robot-joint-values', joints)
            playback.get_by_role('combobox', name='示教轨迹播放速度').select_option('5')
            playback.get_by_role('switch', name='跟随机器人', exact=True).click()
            expect(playback).to_have_attribute('data-follow-robot', 'true')
            playback.get_by_role('button', name='继续示教轨迹播放', exact=True).click()

            # Observe the actual base and all joints at the second solved pose.
            # The unreachable input must not become a third playback target.
            row = [row for row in report['rows'] if row['feasible']][1]
            expected_pose = {**row['mapPose']['position'], **row['mapPose']['rpy']}
            expected_joints = row['solutions'][row['selectedSide']]['jointValues']
            page.wait_for_function('''([pose, joints]) => {
                const player = document.querySelector('.teaching-playback-dock')?.dataset;
                const data = document.querySelector('.three-canvas')?.dataset;
                if (player?.playbackPose !== '2/2' || player.playbackPhase !== 'hold' || !data) return false;
                const actualJoints = JSON.parse(data.robotJointValues || '{}');
                return Object.entries(pose).every(([axis, value]) =>
                    Math.abs(Number(data['robot' + axis[0].toUpperCase() + axis.slice(1)]) - value) < 0.0001)
                    && Object.entries(joints).every(([name, value]) => Math.abs(actualJoints[name] - value) < 0.001);
            }''', arg=[expected_pose, expected_joints], timeout=90000)
            page.screenshot(path=str(ARTIFACTS / 'dynamic-preview.png'), full_page=True)
            page.keyboard.press('Escape')
            expect(playback).to_have_count(0)
            config = await_saved(page, lambda c: c['ui'].get('activeTeachingTaskId') == source['id'])
            assert len(config['project']['virtualTeaching']['tasks']) == 1
            assert config['project']['virtualTeaching']['tasks'][0]['mobileSolve'] == report
            assert config['project']['virtualTeaching']['tasks'][0]['mobileCapture'] == archive['result']
            assert config['ui'].get('activeTeachingParkingPointId') is None

            # The same completed report is reachable from the result dialog.
            computation.get_by_role('button', name='查看结果', exact=True).click()
            preview = dialog.get_by_role('button', name='动态预览', exact=True)
            expect(preview).to_be_enabled()
            dialog.get_by_role('spinbutton', name='X 位置容差 (cm)').fill('6')
            expect(preview).to_be_disabled()
            dialog.get_by_role('button', name='关闭姿态计算').click()
            computation.get_by_role('button', name='查看结果', exact=True).click()
            page.set_viewport_size({'width': 1280, 'height': 800})
            expect(preview).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'results-with-preview.png'), full_page=True)
            assert dialog.locator('.mobile-solve-dialog').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            preview.click()
            expect(dialog).to_have_count(0)
            expect(playback).to_have_attribute('data-playback-status', 'playing')
            assert playback.get_attribute('data-playback-task') != first_preview

            # A rerun stops playback and exposes only its newly completed report.
            computation.get_by_role('button', name='重新计算姿态', exact=True).click()
            expect(playback).to_have_count(0)
            expect(computation).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0]['mobileSolve']['computedAt'] != report['computedAt'])
            newest = config['project']['virtualTeaching']['tasks'][0]['mobileSolve']
            assert newest['feasibleCount'] == 2
            computation.get_by_role('button', name='动态预览', exact=True).click()
            expect(playback).to_have_attribute('data-playback-status', 'playing')
            duration = playback.get_attribute('data-playback-total-ms')
            computation.get_by_role('button', name='保存可达姿态', exact=True).click()
            expect(playback).to_have_count(0)
            saved = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            solved = saved['project']['virtualTeaching']['tasks'][1]
            topbar_action(page, name='打开示教数据管理页').click()
            page.get_by_role('button', name='选择示教任务 ' + solved['name'], exact=True).click()
            page.get_by_role('button', name='播放示教任务 ' + solved['name'], exact=True).click()
            expect(playback).to_have_attribute('data-playback-task', solved['id'])
            expect(playback).to_have_attribute('data-playback-status', 'playing')
            expect(playback).to_have_attribute('data-playback-total-ms', duration)
            playback.get_by_role('button', name='停止示教轨迹播放', exact=True).click()

            # Persisted reports retain dynamic preview after reloading.
            page.reload(wait_until='networkidle')
            ready(page)
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            page.get_by_role('group', name='示教来源', exact=True).get_by_role('button', name='iPad / iPhone 示教', exact=True).click()
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            expect(preview).to_be_enabled()
            preview.click()
            expect(playback).to_have_attribute('data-playback-status', 'playing')
            expect(playback).to_have_attribute('data-playback-total-ms', duration)
            config = await_saved(page, lambda c: c['ui'].get('activeTeachingTaskId') == source['id'])
            assert len(config['project']['virtualTeaching']['tasks']) == 2
            assert not errors, errors
        finally:
            browser.close()
    print('Mobile dynamic preview passed: real calculated base/joints, unreachable filtering, pause/speed/follow/stop, no implicit save, rerun, result dialog, saved-player equivalence and reload.')


if __name__ == '__main__':
    run()
