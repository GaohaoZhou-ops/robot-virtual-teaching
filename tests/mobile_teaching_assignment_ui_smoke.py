"""Two targets share one simultaneous full-body motion through the worker/UI/player."""
import copy

from playwright.sync_api import expect, sync_playwright

from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from mobile_teaching_solver_ui_smoke import BASE, CHROME, ROOT, await_saved
from topbar_tools_helpers import topbar_action

ARTIFACTS = ROOT / 'test-artifacts/mobile-teaching-assignment-ui'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
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
            samples = []
            for side in ['left', 'right']:
                position = [float(value) for value in canvas.get_attribute(f'data-zivid-{side}-optical-position').split(',')]
                quaternion = [float(value) for value in canvas.get_attribute(f'data-zivid-{side}-optical-quaternion').split(',')]
                position[0] += 0.075
                # A common XY offset can now preserve both reference arms.
                # Raising both cameras (with torso height locked below) forces
                # actual arm movement, so synchronized playback stays tested.
                position[2] += 0.075
                sample = copy.deepcopy(archive['result']['samples'][0])
                sample.update(id=f'assigned-{side}', name='左侧 Pose' if side == 'left' else '右侧 Pose')
                sample['cameraPose'].update(position=dict(zip('xyz', position)), quaternion=dict(zip('xyzw', quaternion)))
                samples.append(sample)
            archive['result']['samples'] = samples
            original = copy.deepcopy(archive['result'])
            import_result(page, archive)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            expect(dialog.get_by_role('combobox', name='停车点策略')).to_have_value('auto')
            expect(dialog.get_by_role('combobox', name='参与求解机械臂')).to_have_value('both')
            expect(dialog).to_contain_text('每个姿态只分配给一侧')
            dialog.get_by_role('combobox', name='参与求解机械臂').select_option('cooperative')
            expect(dialog).to_contain_text('只有一臂满足约束时，保留单臂可达结果')
            # Isolate assignment here. The real-URDF Node regression separately
            # verifies every generated full-body pose with collision screening.
            dialog.get_by_role('checkbox', name='碰撞筛选').uncheck()
            dialog.get_by_role('checkbox', name='自动调节胸部高度').uncheck()
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            dock = page.get_by_role('region', name='设备姿态后台计算')
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            source = config['project']['virtualTeaching']['tasks'][0]
            report = source['mobileSolve']
            assert report['version'] >= 10
            assert report['options']['armMode'] == 'cooperative'
            assert report['feasibleCount'] == 2, report['rows']
            assert report['parkingCount'] == 1, report['rows']
            assert report['motionCount'] == 1 and report['dualMotionCount'] == 1
            assert {row['selectedSide'] for row in report['rows']} == {'left', 'right'}
            assert all(sum(solution['feasible'] for solution in row['solutions'].values()) == 1 for row in report['rows'])
            assert source['mobileCapture'] == original
            dock.get_by_role('button', name='查看结果', exact=True).click()
            expect(dialog).to_contain_text('左臂 1 个 · 右臂 1 个')
            expect(dialog).to_contain_text('执行动作：1 组 · 双臂同步 1 组 · 单臂 0 组')
            expect(dialog).to_contain_text('本报告参与求解 · 双臂协同')
            expect(dialog).to_contain_text('停车点协同：1 处双臂参与 · 0 处单臂参与')
            selector = dialog.get_by_role('combobox', name='参与求解机械臂')
            selector.select_option('both')
            expect(dialog.get_by_role('button', name='应用双臂解', exact=True)).to_be_disabled()
            selector.select_option('cooperative')
            # A configuration edit invalidates applying the existing report
            # until this dialog is reopened with the persisted configuration.
            dialog.get_by_role('button', name='关闭姿态计算', exact=True).click()
            dock.get_by_role('button', name='查看结果', exact=True).click()
            expect(selector).to_have_value('cooperative')
            expect(dialog.get_by_role('button', name='应用双臂解', exact=True)).to_be_enabled()
            expect(dialog.locator('.mobile-solve-table').get_by_role('cell', name='执行', exact=True)).to_have_count(2)
            expect(dialog.locator('.mobile-solve-table').get_by_role('cell', name='未分配', exact=True)).to_have_count(2)
            page.screenshot(path=str(ARTIFACTS / 'assignment.png'), full_page=True)
            assert dialog.locator('.mobile-solve-dialog').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            dialog.get_by_role('button', name='动态预览', exact=True).click()
            player = page.get_by_role('region', name='示教任务轨迹播放控制', exact=True)
            expect(player).to_have_attribute('data-playback-status', 'playing')
            expect(player).to_have_attribute('data-playback-pose', '1/1')
            duration = player.get_attribute('data-playback-total-ms')
            second = report['rows'][1]
            target_joints = second['solutions'][second['selectedSide']]['jointValues']
            initial = report['initialJointValues']
            moving = [max((name for name in target_joints if name.startswith(side + '_')),
                          key=lambda name: abs(target_joints[name] - initial[name])) for side in ['left', 'right']]
            assert all(abs(target_joints[name] - initial[name]) > .01 for name in moving)
            # Inspect both real arm joints at the same intermediate frame.
            # A serial player cannot put both at the same partial progress.
            page.wait_for_function('''([initial, target, names]) => {
                const player = document.querySelector('.teaching-playback-dock')?.dataset;
                const actual = JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}');
                const progress = names.map(name => (actual[name] - initial[name]) / (target[name] - initial[name]));
                return player?.playbackPhase === 'joints' && progress.every(value => value > .1 && value < .9)
                    && Math.abs(progress[0] - progress[1]) < .001;
            }''', arg=[initial, target_joints, moving], timeout=60000)
            page.screenshot(path=str(ARTIFACTS / 'simultaneous-motion.png'), full_page=True)
            player.get_by_role('combobox', name='示教轨迹播放速度').select_option('5')
            page.wait_for_function('''(joints) => {
                const player = document.querySelector('.teaching-playback-dock')?.dataset;
                const actual = JSON.parse(document.querySelector('.three-canvas')?.dataset.robotJointValues || '{}');
                return player?.playbackPose === '1/1' && player.playbackPhase === 'hold'
                    && Object.entries(joints).every(([name, value]) => Math.abs(actual[name] - value) < 0.001);
            }''', arg=target_joints, timeout=60000)
            player.get_by_role('button', name='停止示教轨迹播放', exact=True).click()
            dock.get_by_role('button', name='保存可达姿态', exact=True).click()
            config = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            solved = config['project']['virtualTeaching']['tasks'][1]
            assert len(solved['parkingPoints']) == 1
            poses = solved['parkingPoints'][0]['poses']
            assert len(poses) == 1
            assert poses[0]['mobileSampleIds'] == [row['sampleId'] for row in report['rows']]
            assert sorted(poses[0]['opticalTargets']) == ['left', 'right']
            for row in report['rows']:
                assert poses[0]['fullBodyJoints']['values'] == row['solutions'][row['selectedSide']]['jointValues']
            topbar_action(page, name='打开示教数据管理页').click()
            page.get_by_role('button', name='选择示教任务 ' + solved['name'], exact=True).click()
            page.get_by_role('button', name='播放示教任务 ' + solved['name'], exact=True).click()
            expect(player).to_have_attribute('data-playback-status', 'playing')
            expect(player).to_have_attribute('data-playback-pose', '1/1')
            expect(player).to_have_attribute('data-playback-total-ms', duration)
            player.get_by_role('button', name='停止示教轨迹播放', exact=True).click()
            page.reload(wait_until='networkidle')
            ready(page)
            restored = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            assert restored['project']['virtualTeaching']['tasks'][1]['parkingPoints'] == solved['parkingPoints']
            assert restored['project']['virtualTeaching']['tasks'][0]['mobileSolve'] == report | {'savedTaskId': solved['id']}
            assert not errors, errors
        finally:
            browser.close()
    print('Cooperative UI passed: mode selection/persistence, shared-stop summary, two targets in one motion, synchronized playback, saved poses and reload.')


if __name__ == '__main__':
    run()
