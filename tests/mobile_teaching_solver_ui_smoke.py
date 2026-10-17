import copy
import json
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from ipad_teaching_source_ui_smoke import fixture_data, import_result, ready
from ipad_menu_helpers import select_teaching_source
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
            page.get_by_role('button', name='加载机器人', exact=True).click()
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
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
            for axis in ['X', 'Y', 'Z']:
                expect(dialog.get_by_role('spinbutton', name=f'{axis} 位置容差 (cm)')).to_have_value('5')
            for axis in ['ROLL', 'PITCH', 'YAW']:
                expect(dialog.get_by_role('spinbutton', name=f'{axis} 角度容差 (°)')).to_have_value('5')
            expect(dialog.get_by_role('checkbox', name='前胸垂直锁定')).to_be_checked()
            expect(dialog.get_by_role('checkbox', name='允许仅单臂可达')).to_be_checked()
            expect(dialog.get_by_role('button', name='开始计算', exact=True)).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'configuration.png'), full_page=True)
            started = time.monotonic()
            dialog.get_by_role('button', name='开始计算', exact=True).click()
            expect(dialog).to_have_count(0)
            dock = page.get_by_role('region', name='设备姿态后台计算')
            expect(dock).to_have_attribute('data-compute-status', 'completed', timeout=120000)
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
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            dialog.get_by_role('button', name='保存可达姿态', exact=True).click()
            expect(dialog).to_have_count(0)
            config = await_saved(page, lambda c: len(c['project']['virtualTeaching']['tasks']) == 2)
            tasks = config['project']['virtualTeaching']['tasks']
            assert tasks[0]['mobileCapture'] == original_capture
            assert tasks[1]['parkingPoints'][0]['poses'][0]['mobileSampleId'] == original_capture['samples'][0]['id']
            assert tasks[1]['parkingPoints'][0]['poses'][0]['opticalTargets']['left']['position'] == archive['result']['samples'][0]['cameraPose']['position']
            page.reload(wait_until='networkidle')
            ready(page)
            select_teaching_source(page, '查看 iPad 示教')
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
            page.get_by_role('button', name='打开示教数据管理页').click()
            page.get_by_role('button', name='计算机器人姿态', exact=True).click()
            expect(dialog.locator('.mobile-solve-results-heading')).to_contain_text('1 / 2 可达')
            dialog.get_by_role('button', name='查看已保存任务').click()
            config = await_saved(page, lambda c: c['ui'].get('activeTeachingTaskId') == tasks[1]['id'])
            assert len(config['project']['virtualTeaching']['tasks']) == 2, 'saving twice must not duplicate the output task'
            page.get_by_role('button', name='打开示教数据管理页').click()
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)['virtualTeaching']['tasks']
            assert exported[0]['mobileCapture'] == original_capture
            assert exported[0]['mobileSolve']['feasibleCount'] == 1
            assert len(exported[1]['parkingPoints'][0]['poses']) == 1
            assert not errors, errors
        finally:
            browser.close()
    print('Mobile solve UI: real URDF IK, defaults, validation, live application, persistence, cancellation, data page, idempotent save and ZIP export passed.')


if __name__ == '__main__':
    run()
