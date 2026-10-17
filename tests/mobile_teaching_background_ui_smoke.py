from topbar_tools_helpers import topbar_action

import copy
import json
import time

from playwright.sync_api import expect, sync_playwright

from ipad_menu_helpers import open_ipad_dialog
from ipad_teaching_source_ui_smoke import camera_view, fixture_data, ready
from mobile_teaching_solver_ui_smoke import ARTIFACTS, BASE, CHROME, ROOT, await_saved, workspace


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _, archive = fixture_data()
    errors, workers = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('worker', lambda worker: workers.append(worker.url))
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
            quaternion = dict(zip('xyzw', [float(n) for n in canvas.get_attribute('data-zivid-left-optical-quaternion').split(',')]))
            live_joints = canvas.get_attribute('data-robot-joint-values')
            live_position = canvas.get_attribute('data-zivid-left-optical-position')
            template = archive['result']['samples'][0]
            samples = []
            for index in range(36):
                sample = copy.deepcopy(template)
                sample.update(id=f'progress-pose-{index}', name=f'计算预览 {index + 1:02}')
                reachable = index < 4 or index % 3 == 0
                target = [position[0] + .075 + (index % 3) * .015, position[1], position[2]] if reachable else [20, 20, 20]
                sample['cameraPose'].update(position=dict(zip('xyz', target)), quaternion=quaternion)
                samples.append(sample)
            archive['result']['samples'] = samples
            open_ipad_dialog(page, '导入结果文件')
            ipad = page.get_by_role('dialog', name='iPad 示教')
            ipad.locator('[data-ipad-result-input]').set_input_files({
                'name': 'background.atlas-teaching.json', 'mimeType': 'application/json', 'buffer': json.dumps(archive).encode(),
            })
            expect(ipad.locator('.ipad-result-file__receipt')).to_contain_text('已接收 36 个 Pose')
            page.get_by_role('button', name='关闭设备示教窗口').click()
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            expect(dialog).to_have_count(0)
            dock = page.get_by_role('region', name='设备姿态后台计算')
            first_run = dock.get_attribute('data-compute-run')
            page.wait_for_function("Number(document.querySelector('.mobile-compute-dock')?.dataset.previewCount) >= 2")
            expect(dock).to_have_attribute('data-compute-status', 'running')
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'visible')
            expect(canvas).to_have_attribute('data-parking-ghost-kind', 'mobile-solve')
            expect(canvas).to_have_attribute('data-parking-ghost-opacity', '0.24')
            assert int(canvas.get_attribute('data-parking-ghost-mesh-count')) > 0
            assert int(canvas.get_attribute('data-parking-ghost-joint-count')) > 0
            assert any('mobileTeachingSolver.worker' in url for url in workers), workers
            assert canvas.get_attribute('data-robot-joint-values') == live_joints
            assert canvas.get_attribute('data-zivid-left-optical-position') == live_position
            ghost = page.get_by_label('计算姿态机器人虚影', exact=True)
            expect(ghost.get_by_role('button', name='使用当前姿态', exact=True)).to_have_count(0)

            dock.get_by_role('button', name='暂停姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'paused')
            frozen = dock.get_attribute('data-completed')
            frozen_ghost = canvas.get_attribute('data-parking-ghost-joint-values')
            latest_id = canvas.get_attribute('data-parking-ghost-pose-id')
            page.wait_for_timeout(600)
            expect(dock).to_have_attribute('data-completed', frozen)
            expect(canvas).to_have_attribute('data-parking-ghost-joint-values', frozen_ghost)
            page.screenshot(path=str(ARTIFACTS / 'background-paused.png'), full_page=True)

            dock.get_by_role('button', name='上一个计算姿态', exact=True).click()
            expect(dock.get_by_role('button', name='跟随最新', exact=True)).to_have_attribute('aria-pressed', 'false')
            assert canvas.get_attribute('data-parking-ghost-pose-id') != latest_id
            dock.get_by_role('button', name='跟随最新', exact=True).click()
            expect(canvas).to_have_attribute('data-parking-ghost-pose-id', latest_id)
            ghost.get_by_role('button', name='隐藏计算姿态虚影', exact=True).click()
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'hidden')
            expect(dock.get_by_role('button', name='跟随最新', exact=True)).to_have_attribute('aria-pressed', 'false')
            dock.get_by_role('button', name='跟随最新', exact=True).click()
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'visible')
            dock.get_by_role('button', name='计算配置', exact=True).click()
            expect(dialog.get_by_role('button', name='重新计算', exact=True)).to_be_enabled()
            dialog.get_by_role('button', name='关闭姿态计算').click()
            expect(dock).to_have_attribute('data-compute-status', 'paused')

            dock.get_by_role('button', name='继续姿态计算', exact=True).click()
            page.wait_for_function("old => Number(document.querySelector('.mobile-compute-dock')?.dataset.completed) > old", arg=int(frozen))
            expect(dock).to_have_attribute('data-compute-status', 'running')
            # Orbit the live viewport while the real worker is still solving.
            expect(canvas).to_have_attribute('data-synchronized-focus-state', 'settled')
            before_view = camera_view(canvas)
            bounds = canvas.bounding_box()
            x, y = bounds['x'] + 90, bounds['y'] + bounds['height'] * .5
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 70, y + 35, steps=8)
            page.mouse.up()
            assert camera_view(canvas) != before_view, '3D interaction must remain available during computation'

            # Replacing an in-flight run must immediately discard its preview;
            # messages from the terminated worker cannot overwrite the new run.
            dock.get_by_role('button', name='重新计算姿态', exact=True).click()
            second_run = dock.get_attribute('data-compute-run')
            assert second_run != first_run
            dock.get_by_role('button', name='暂停姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'paused')
            second_completed = dock.get_attribute('data-completed')
            page.wait_for_timeout(500)
            expect(dock).to_have_attribute('data-compute-run', second_run)
            expect(dock).to_have_attribute('data-completed', second_completed)
            dock.get_by_role('button', name='取消姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'cancelled')
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'hidden')
            page.wait_for_timeout(600)
            expect(dock).to_have_attribute('data-preview-count', '0')
            assert not workspace(page)['project']['virtualTeaching']['tasks'][0].get('mobileSolve')

            dock.get_by_role('button', name='重新计算姿态', exact=True).click()
            started = time.monotonic()
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
            print('36-pose background calculation seconds:', round(time.monotonic() - started, 2))
            expect(dock).to_have_attribute('data-completed', '36')
            expect(dock).to_have_attribute('data-feasible', '14')
            expect(dock).to_have_attribute('data-preview-count', '14')
            config = await_saved(page, lambda c: c['project']['virtualTeaching']['tasks'][0].get('mobileSolve'))
            report = config['project']['virtualTeaching']['tasks'][0]['mobileSolve']
            assert len(report['rows']) == 36
            assert report['feasibleCount'] == 14
            assert canvas.get_attribute('data-parking-ghost-pose-id') == 'progress-pose-33'
            assert canvas.get_attribute('data-robot-joint-values') == live_joints
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.screenshot(path=str(ARTIFACTS / 'background-completed-1280.png'), full_page=True)
            assert dock.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')

            # A cancelled recalculation preserves the previous complete report,
            # but changed settings may not be used to apply that old report.
            dock.get_by_role('button', name='查看结果', exact=True).click()
            dialog.get_by_role('spinbutton', name='X 位置容差 (cm)').fill('6')
            dialog.get_by_role('button', name='重新计算', exact=True).click()
            dock.get_by_role('button', name='暂停姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'paused')
            # Switching to the data page preserves the worker and its controls.
            topbar_action(page, name='打开示教数据管理页').click()
            expect(dock).to_have_class('mobile-compute-dock is-paused is-floating')
            dock.get_by_role('button', name='取消姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'cancelled')
            page.wait_for_timeout(600)
            assert workspace(page)['project']['virtualTeaching']['tasks'][0]['mobileSolve'] == report
            dock.get_by_role('button', name='计算配置', exact=True).click()
            expect(dialog.get_by_role('spinbutton', name='X 位置容差 (cm)')).to_have_value('6')
            expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='保存可达姿态', exact=True)).to_be_disabled()
            dialog.get_by_role('button', name='关闭姿态计算').click()
            dock.get_by_role('button', name='关闭计算进度', exact=True).click()
            expect(dock).to_have_count(0)

            # Replacing the workspace also terminates a paused run, so neither
            # the old ghost nor its report can leak into the new project.
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog.get_by_role('button', name='重新计算', exact=True).click()
            dock.get_by_role('button', name='暂停姿态计算', exact=True).click()
            expect(dock).to_have_attribute('data-compute-status', 'paused')
            page.once('dialog', lambda prompt: prompt.accept())
            page.locator('[data-independent-teaching-input]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            ready(page)
            expect(dock).to_have_count(0)
            expect(canvas).to_have_attribute('data-parking-ghost-state', 'hidden')
            await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 0)
            assert not errors, errors
        finally:
            browser.close()
    print('Background UI: worker, progressive ghosts, orbit, pause/resume, history, restart, cancel, report isolation, data-page controls and workspace cleanup passed.')


if __name__ == '__main__':
    run()
