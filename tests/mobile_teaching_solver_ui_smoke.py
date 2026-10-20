from topbar_tools_helpers import topbar_action

import copy
import json
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from archive_helpers import start_project_download, read_exported_project

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990')
ARTIFACTS = ROOT / 'test-artifacts/mobile-teaching-solve'
CHROME = os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def workspace(page):
    return page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('atlas-route-studio', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const value = await new Promise((resolve, reject) => {
        const r = db.transaction('workspace-session').objectStore('workspace-session').get('workspace-config:independent');
        r.onsuccess = () => resolve(r.result?.config); r.onerror = () => reject(r.error);
      }); db.close(); return value;
    }''')


def await_saved(page, predicate):
    end = time.monotonic() + 30
    while time.monotonic() < end:
        value = workspace(page)
        if value and predicate(value):
            return value
        page.wait_for_timeout(100)
    raise AssertionError('Expected calculation was not saved')


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.route('**/__atlas/ipad/**', lambda route: route.fulfill(status=503, content_type='application/json', body='{"error":"文件导入测试"}'))
            page.goto(BASE + '/workbench', wait_until='networkidle')
            ready(page)
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.zividLeftOpticalPosition")
            position = [float(n) for n in canvas.get_attribute('data-zivid-left-optical-position').split(',')]
            quaternion = [float(n) for n in canvas.get_attribute('data-zivid-left-optical-quaternion').split(',')]
            archive['result']['samples'][0]['cameraPose'].update(position=dict(zip('xyz', [position[0] + .075, position[1], position[2]])), quaternion=dict(zip('xyzw', quaternion)))
            archive['result']['samples'][1]['cameraPose'].update(position={'x': 20, 'y': 20, 'z': 20}, quaternion=dict(zip('xyzw', quaternion)))
            original_capture = copy.deepcopy(archive['result'])
            import_result(page, archive)
            sources = page.get_by_role('group', name='示教来源', exact=True)
            expect(sources.get_by_role('button', name='iPad 示教', exact=True)).to_have_attribute('aria-pressed', 'true')
            sample = page.get_by_role('treeitem', name='预览采样 Pose Pose 001', exact=True)
            expect(sample).to_be_visible()
            sample.click()
            expect(canvas).to_have_attribute('data-mobile-selected-sample', original_capture['samples'][0]['id'])
            expect(page.get_by_label('采样 Pose 详情', exact=True)).to_contain_text('待计算')
            expect(page.get_by_role('region', name='设备姿态保存')).to_have_count(0)
            expect(canvas).to_have_attribute('data-synchronized-focus-state', 'settled')
            page.screenshot(path=str(ARTIFACTS / 'sampling-poses.png'), full_page=True)
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            for axis in ['X', 'Y', 'Z']:
                expect(dialog.get_by_role('spinbutton', name=f'{axis} 位置容差 (cm)')).to_have_value('5')
            for axis in ['ROLL', 'PITCH', 'YAW']:
                expect(dialog.get_by_role('spinbutton', name=f'{axis} 角度容差 (°)')).to_have_value('5')
            expect(dialog.get_by_role('checkbox', name='前胸垂直锁定')).to_be_checked()
            expect(dialog.get_by_role('combobox', name='参与求解机械臂')).to_have_value('both')
            expect(dialog).to_contain_text('每个姿态只分配给一侧')
            expect(dialog.get_by_role('combobox', name='停车点策略')).to_have_value('auto')
            expect(dialog.get_by_role('checkbox', name='碰撞筛选')).to_be_checked()
            # Preserve this test's fixed-base FK/editing contract. Distributed
            # parking and collision screening have their own end-to-end test.
            dialog.get_by_role('combobox', name='停车点策略').select_option('fixed')
            dialog.get_by_role('checkbox', name='碰撞筛选').uncheck()
            expect(dialog.get_by_role('button', name='开始计算', exact=True)).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'configuration.png'), full_page=True)
            started = time.monotonic()
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            expect(dialog).to_have_count(0)
            dock = page.get_by_role('region', name='设备姿态后台计算')
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            expect(dock.get_by_role('button', name='保存可达姿态', exact=True)).to_be_enabled()
            expect(dock).to_contain_text('可达姿态待保存')
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'visible')
            expect(canvas).to_have_attribute('data-parking-ghost-kind', 'mobile-solve')
            expect(canvas).to_have_attribute('data-parking-ghost-opacity', '0.24')
            dock.get_by_role('button', name='查看结果', exact=True).click()
            expect(dialog.get_by_role('button', name='重新计算', exact=True)).to_be_enabled(timeout=120000)
            assert canvas.get_attribute('data-zivid-left-optical-position') == ','.join(f'{n:.6f}' for n in position), 'calculation must not move live robot'
            expect(dialog.locator('.mobile-solve-results-heading')).to_contain_text('1 / 2 可达')
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'results.png'), full_page=True)
            print('Real URDF two-target calculation seconds:', round(time.monotonic() - started, 2))
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            source = config['project']['virtualTeaching']['tasks'][0]
            assert source['mobileCapture'] == original_capture
            assert source['mobileSolve']['rows'][0]['solutions']['left']['feasible']
            dialog.get_by_role('spinbutton', name='X 位置容差 (cm)').fill('')
            expect(dialog.get_by_role('alert')).to_be_visible()
            expect(dialog.get_by_role('button', name='重新计算', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='关闭姿态计算').click()
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog.get_by_role('button', name='应用左臂解', exact=True).click()
            expect(dialog).to_have_count(0)
            page.wait_for_function('''([x]) => Math.abs(Number(document.querySelector('.three-canvas').dataset.zividLeftOpticalPosition.split(',')[0]) - x) > .02''', arg=[position[0]])
            actual = [float(n) for n in canvas.get_attribute('data-zivid-left-optical-position').split(',')]
            for a, t in zip(actual, archive['result']['samples'][0]['cameraPose']['position'].values()):
                assert abs(a - t) <= .050001, (actual, t)
            # A completed report must remain directly saveable after its dock
            # has closed and the page has restored the unsaved calculation.
            page.reload(wait_until='networkidle')
            ready(page)
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=180000)
            save_panel = page.get_by_role('region', name='设备姿态保存')
            expect(sample).to_contain_text('可达 · 待保存')
            expect(save_panel).to_contain_text('保存后将生成停车点和对应机器人姿态')
            save_panel.get_by_role('button', name='保存可达姿态', exact=True).click()
            expect(dialog).to_have_count(0)
            config = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            tasks = config['project']['virtualTeaching']['tasks']
            assert tasks[0]['mobileCapture'] == original_capture
            assert tasks[0]['mobileSolve']['savedTaskId'] == tasks[1]['id']
            assert len(tasks[1]['parkingPoints']) == 1
            assert len(tasks[1]['parkingPoints'][0]['poses']) == 1, 'unreachable samples must not be saved'
            assert tasks[1]['parkingPoints'][0]['poses'][0]['mobileSampleId'] == original_capture['samples'][0]['id']
            assert tasks[1]['parkingPoints'][0]['poses'][0]['opticalTargets']['left']['position'] == archive['result']['samples'][0]['cameraPose']['position']
            expect(sources.get_by_role('button', name='机器人示教', exact=True)).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('button', name='查看来源采样', exact=True).click()
            sample.click()
            expect(page.get_by_label('采样 Pose 详情', exact=True)).to_contain_text('已保存 · 可精修')
            page.get_by_role('button', name='打开机器人姿态', exact=True).click()
            robot_pose = tasks[1]['parkingPoints'][0]['poses'][0]
            card = page.get_by_label('停车点机器人虚影', exact=True)
            expect(card).to_have_attribute('data-pose-id', robot_pose['id'])
            page.get_by_role('button', name='调整选中姿态', exact=True).click()
            expect(card).to_have_attribute('data-pose-edit-state', 'editing')
            expect(page.get_by_role('dialog', name='全关节控制浮动窗口')).to_be_visible()
            page.get_by_role('spinbutton', name='right_J1 关节值', exact=True).fill('12')
            card.get_by_role('button', name='确认修改', exact=True).click()
            expect(card).to_have_attribute('data-pose-edit-state', 'idle')
            refined = await_saved(page, lambda c: abs(c['project']['virtualTeaching']['tasks'][1]['parkingPoints'][0]['poses'][0]['fullBodyJoints']['values'].get('right_J1', 0) - 12) < 1e-6)
            refined_pose = refined['project']['virtualTeaching']['tasks'][1]['parkingPoints'][0]['poses'][0]
            assert refined_pose['id'] == robot_pose['id']
            assert refined_pose['mobileSampleId'] == original_capture['samples'][0]['id']
            assert refined['project']['virtualTeaching']['tasks'][0]['mobileCapture'] == original_capture
            page.screenshot(path=str(ARTIFACTS / 'refined-robot-pose.png'), full_page=True)
            page.reload(wait_until='networkidle')
            ready(page)
            sources.get_by_role('button', name='iPad 示教', exact=True).click()
            page.get_by_role('treeitem', name='预览采样 Pose Pose 002', exact=True).click()
            page.get_by_role('button', name='查看此 Pose 的计算结果', exact=True).click()
            expect(dialog.locator('.mobile-solve-detail h4')).to_contain_text('Pose 002')
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='关闭姿态计算').click()
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            expect(dialog.locator('.mobile-solve-results-heading')).to_contain_text('1 / 2 可达')
            expect(dialog.get_by_role('button', name='查看已保存任务')).to_be_enabled()
            dialog.get_by_role('button', name='重新计算', exact=True).click()
            expect(dialog).to_have_count(0)
            dock.get_by_role('button', name='取消姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'cancelled')
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'hidden')
            dock.get_by_role('button', name='计算配置', exact=True).click()
            expect(dialog.get_by_role('button', name='查看已保存任务')).to_be_enabled()
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.screenshot(path=str(ARTIFACTS / 'compact.png'), full_page=True)
            assert dialog.locator('.mobile-solve-dialog').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            dialog.get_by_role('button', name='关闭姿态计算').click()
            topbar_action(page, name='打开示教数据管理页').click()
            page.get_by_role('region', name='设备姿态保存').get_by_role('button', name='查看已保存任务', exact=True).click()
            config = await_saved(page, lambda c: c['ui'].get('activeTeachingTaskId') == tasks[1]['id'])
            assert len(config['project']['virtualTeaching']['tasks']) == 2, 'saving twice must not duplicate the output task'
            topbar_action(page, name='打开示教数据管理页').click()
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)['virtualTeaching']['tasks']
            assert exported[0]['mobileCapture'] == original_capture
            assert exported[0]['mobileSolve']['feasibleCount'] == 1
            assert len(exported[1]['parkingPoints'][0]['poses']) == 1
            exported_pose = exported[1]['parkingPoints'][0]['poses'][0]
            for field in ['id', 'mobileSampleId', 'mapPose', 'opticalTargets']:
                assert exported_pose[field] == refined_pose[field], f'reopening a saved solve must preserve {field}'
            assert exported_pose['fullBodyJoints']['values'] == refined_pose['fullBodyJoints']['values']
            assert exported_pose['cameraCapture']['capturedAt'] == refined_pose['cameraCapture']['capturedAt']
            assert not errors, errors
        finally:
            browser.close()
    print('Mobile solve UI: real URDF IK, persistent save action after reload, linked robot refinement, data-page saved-task navigation, cancellation, idempotent save and ZIP export passed.')


if __name__ == '__main__':
    run()
