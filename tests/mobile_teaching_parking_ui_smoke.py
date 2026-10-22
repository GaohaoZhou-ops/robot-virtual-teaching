import copy
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from topbar_tools_helpers import topbar_action
from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from mobile_teaching_solver_ui_smoke import ARTIFACTS, BASE, CHROME, ROOT, await_saved
from archive_helpers import start_project_download, read_exported_project
from torso_control_ui_smoke import enter_torso, set_value
from viewer_tools_helpers import viewer_tool
from robot_drag_undo_smoke import state


def pose_values(pose):
    return [pose['position'][a] for a in 'xyz'] + [pose['rpy'][a] for a in ['roll', 'pitch', 'yaw']]


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
    fixture = json.loads((ROOT / 'tests/fixtures/mobile-teaching-botx.json').read_text())
    template = archive['result']['samples'][0]
    archive['result']['samples'] = []
    for i, target in enumerate([fixture['targets'][0], fixture['targets'][7], fixture['targets'][9]]):
        sample = copy.deepcopy(template)
        sample.update(id=f'distributed-{i}', name=f'分布式 Pose {i + 1}', cameraPose=target)
        archive['result']['samples'].append(sample)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(BASE + '/workbench', wait_until='networkidle')
            ready(page)
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            viewer_tool(page, name='定位机器人模型').click()
            page.wait_for_timeout(400)  # Wait for the camera-focus animation before picking the chest.
            enter_torso(page, canvas)
            set_value(page, '躯干高度 (m)', float(canvas.get_attribute('data-torso-height')) - 0.15)
            set_value(page, '躯干YAW (°)', 22)
            set_value(page, '躯干PITCH (°)', 12)
            page.get_by_role('button', name='完成调整', exact=True).click()
            initial_joints = state(canvas)['joints']
            assert abs(sum(initial_joints[n] for n in ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'])) > 10
            import_result(page, archive)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            expect(dialog.get_by_role('checkbox', name='碰撞筛选')).to_be_checked()
            clearance = dialog.get_by_role('spinbutton', name='躯干避让间距 (cm)', exact=True)
            expect(clearance).to_have_value('5')
            clearance.fill('31')
            expect(dialog.get_by_role('button', name='开始计算', exact=True)).to_be_disabled()
            clearance.fill('5')
            dialog.get_by_role('checkbox', name='碰撞筛选').uncheck()
            expect(clearance).to_be_disabled()
            dialog.get_by_role('checkbox', name='碰撞筛选').check()
            expect(clearance).to_be_enabled()
            expect(dialog.get_by_role('checkbox', name='自动调节胸部高度')).to_be_checked()
            expect(dialog.get_by_role('checkbox', name='前胸垂直锁定')).to_be_checked()
            expect(dialog.get_by_role('checkbox', name='前胸垂直锁定')).to_be_disabled()
            dialog.get_by_role('combobox', name='停车点策略').select_option('per-pose')
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            dock = page.get_by_role('region', name='设备姿态后台计算')
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=240000)
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            report = config['project']['virtualTeaching']['tasks'][0]['mobileSolve']
            assert report['feasibleCount'] == 3, report['rows']
            assert report['parkingCount'] == 3
            assert report['collisionScreening']['enabled']
            assert report['collisionScreening']['environmentKind'] == 'points'
            assert report['options']['allowTorsoHeight']
            assert report['options']['armBodyClearance'] == 0.05
            assert state(canvas)['joints'] == initial_joints, 'the worker must leave the live tilted robot alone'
            for row in reversed(report['rows']):
                expected_pose = pose_values(row['mapPose'])
                actual = [float(v) for v in canvas.get_attribute('data-parking-ghost-target-pose').split(',')]
                assert all(abs(a - b) < 1e-6 for a, b in zip(actual, expected_pose)), (actual, expected_pose)
                assert row['solutions'][row['selectedSide']]['collision']['clear']
                margin = row['solutions'][row['selectedSide']]['collision']['armBodyClearance']
                assert margin['checked'] and margin['clear'] and margin['minimum'] >= 0.05
                assert all(value >= 0.05 for value in margin['bySide'].values())
                assert row['solutions'][row['selectedSide']]['chestTilt'] <= 0.25
                assert row['mapPose']['position']['z'] == 0
                if row != report['rows'][0]:
                    dock.get_by_role('button', name='上一个计算姿态').click()
                    expect(canvas).to_have_attribute('data-parking-ghost-pose-id', report['rows'][report['rows'].index(row) - 1]['sampleId'])
            dock.get_by_role('button', name='查看结果', exact=True).click()
            expect(dialog.locator('.mobile-solve-results-heading')).to_contain_text('3 个停车点')
            expect(dialog).to_contain_text('胸部坐标系距支撑平面')
            expect(dialog).to_contain_text('本报告自动升降已开启')
            expect(dialog).to_contain_text('躯干间距保守下界')
            expect(dialog).to_contain_text('要求 ≥ 5.00 cm')
            with page.expect_download() as report_download:
                dialog.get_by_role('button', name='导出计算报告', exact=True).click()
            diagnosis = json.loads(Path(report_download.value.path()).read_text())
            assert diagnosis['format'] == 'atlas-mobile-solve-report/1'
            assert diagnosis['report'] == report
            assert diagnosis['task']['mobileCapture'] == archive['result']
            dialog.get_by_role('button', name='分布式 Pose 3', exact=True).click()
            side = report['rows'][2]['selectedSide']
            dialog.get_by_role('button', name=f"应用{'左' if side == 'left' else '右'}臂解", exact=True).click()
            page.wait_for_function('''([target]) => {
              const d=document.querySelector('.three-canvas').dataset;
              return ['x','y','z'].every(a=>Math.abs(Number(d['robot'+a.toUpperCase()])-target.position[a]) < 1e-5);
            }''', arg=[report['rows'][2]['mapPose']])
            applied = state(canvas)['joints']
            assert abs(sum(applied[n] for n in ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J'])) <= 0.25
            for name, value in report['rows'][2]['solutions'][side]['jointValues'].items():
                assert abs(applied[name] - value) < 1e-5
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            page.screenshot(path=str(ARTIFACTS / 'multiple-parking-results.png'), full_page=True)
            dialog.get_by_role('button', name='关闭姿态计算', exact=True).click()
            topbar_action(page, name='打开示教数据管理页').click()
            page.get_by_role('region', name='设备姿态保存').get_by_role('button', name='保存可达姿态', exact=True).click()
            config = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            solved = config['project']['virtualTeaching']['tasks'][1]
            assert len(solved['parkingPoints']) == 3
            for parking, row in zip(solved['parkingPoints'], report['rows']):
                assert parking['mapPose']['position'] == row['mapPose']['position']
                assert parking['poses'][0]['mapPose'] == parking['mapPose']
                assert parking['poses'][0]['mobileSampleId'] == row['sampleId']
                assert parking['poses'][0]['fullBodyJoints']['values'] == row['solutions'][row['selectedSide']]['jointValues']
            # Playback's stop/pose targets must retain the independent bases.
            trajectory = page.evaluate('''async (task) => {
              const {buildTeachingTaskTrajectory}=await import('/src/lib/teachingPlayback.js');
              return buildTeachingTaskTrajectory({task});
            }''', solved)
            assert trajectory['poseCount'] == 3
            assert trajectory['parkingPointCount'] == 3
            page.reload(wait_until='networkidle')
            ready(page)
            saved = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            assert saved['project']['virtualTeaching']['tasks'][1]['parkingPoints'] == solved['parkingPoints']
            topbar_action(page, name='打开示教数据管理页').click()
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)['virtualTeaching']['tasks']
            assert exported[1]['parkingPoints'] == solved['parkingPoints']
            # v3 preserves its height setting while requesting new assignment.
            # Earlier versions request height control; v1 also enables parking.
            await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            for version in [5, 4, 3, 2, 1]:
                page.evaluate('''async (version) => {
              const db=await new Promise((resolve,reject)=>{
                const r=indexedDB.open('atlas-route-studio',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
              });
              await new Promise((resolve,reject)=>{
                const tx=db.transaction('workspace-session','readwrite'),store=tx.objectStore('workspace-session');
                const r=store.get('workspace-config:independent');
                r.onsuccess=()=>{
                  const record=r.result,report=record.config.project.virtualTeaching.tasks[0].mobileSolve;
                  report.version=version;
                  if(version>=3)report.options.allowTorsoHeight=false;else delete report.options.allowTorsoHeight;
                  if(version===1){
                    delete report.options.parkingMode;delete report.options.checkCollisions;
                    delete report.collisionScreening;delete report.parkingCount;
                    for(const row of report.rows){delete row.mapPose;delete row.parkingId;
                      for(const solution of Object.values(row.solutions)){delete solution.mapPose;delete solution.collision;}}
                  }
                  store.put(record);
                };
                tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
              });db.close();
                }''', version)
                page.goto(BASE + '/workbench', wait_until='networkidle')
                ready(page)
                page.get_by_role('group', name='示教来源', exact=True).get_by_role('button', name='iPad / iPhone 示教', exact=True).click()
                page.get_by_role('button', name='计算机器人姿态', exact=True).click()
                if version < 4:
                    expect(dialog).to_contain_text('已有报告尚未采用双臂分工与停车点覆盖优化')
                if version < 5:
                    expect(dialog).to_contain_text('重新计算可在同一停车点生成双臂同步动作')
                expect(dialog).to_contain_text('已有报告未检查躯干避让间距')
                expect(dialog.get_by_role('spinbutton', name='躯干避让间距 (cm)', exact=True)).to_have_value('5')
                if version >= 3:
                    expect(dialog.get_by_role('checkbox', name='自动调节胸部高度')).not_to_be_checked()
                    expect(dialog.get_by_role('checkbox', name='前胸垂直锁定')).to_be_enabled()
                    expect(dialog).not_to_contain_text('已有报告未使用自动胸部升降')
                else:
                    expect(dialog.get_by_role('checkbox', name='自动调节胸部高度')).to_be_checked()
                    expect(dialog.get_by_role('checkbox', name='前胸垂直锁定')).to_be_disabled()
                    expect(dialog).to_contain_text('已有报告未使用自动胸部升降')
                expect(dialog).to_contain_text('本报告自动升降未开启')
                if version == 1:
                    expect(dialog.get_by_role('combobox', name='停车点策略')).to_have_value('auto')
                    expect(dialog.get_by_role('checkbox', name='碰撞筛选')).to_be_checked()
                    expect(dialog).to_contain_text('已有报告采用固定停车点且未筛选碰撞')
                expect(dialog.get_by_role('button', name='查看已保存任务')).to_be_disabled()
            # A stale background bundle must not silently replace a newer
            # report, or present an old failure as the result of this run.
            outdated = copy.deepcopy(report)
            outdated['version'] = 2
            page.route('**/*mobileTeachingSolver.worker*', lambda route: route.fulfill(
                status=200, content_type='text/javascript',
                body='self.onmessage=e=>{if(e.data.type==="solve")self.postMessage({type:"complete",value:' + json.dumps(outdated) + '})};',
            ))
            dialog.get_by_role('button', name='重新计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'error')
            expect(dock).to_contain_text('后台求解器版本已过期')
            dock.get_by_role('button', name='计算详情', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('下方保留上次报告，不是本次结果')
            expect(dialog.get_by_role('heading', name='旧版计算结果', exact=True)).to_be_visible()
            unchanged = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0]['mobileSolve']['version'] == 1)
            assert unchanged['project']['virtualTeaching']['tasks'][0]['mobileSolve']['computedAt'] == report['computedAt']
            assert not errors, errors
        finally:
            browser.close()
    print('Multi-parking/height UI: torso clearance setting/report, tilted torso, upright collision-screened worker results, each ghost/apply base and joints, save, playback targets, reload, legacy v1-v5 and ZIP export passed.')


if __name__ == '__main__':
    run()
