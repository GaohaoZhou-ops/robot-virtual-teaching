"""Fixed-base partial planning, real playback and saved-record replay."""
import json
import math
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_base_ui_smoke import base_pose
from topbar_tools_helpers import topbar_action
from archive_helpers import start_project_download, read_exported_project

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-partial'


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                          format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
        urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text().replace('lower="-1" upper="1"', 'lower="-1" upper="0.12"', 1)
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=urdf))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            fixed = panel.get_by_role('checkbox', name='底盘静止', exact=True)
            maximum = panel.get_by_role('checkbox', name='最大保障', exact=True)
            sync = panel.get_by_role('checkbox', name='底盘同步', exact=True)
            search = panel.get_by_role('checkbox', name='底盘自搜索', exact=True)
            expect(fixed).to_be_checked(); expect(maximum).not_to_be_checked(); expect(maximum).to_be_enabled()
            assert abs(fixed.bounding_box()['y'] - maximum.bounding_box()['y']) < 1
            assert sync.bounding_box()['y'] > fixed.bounding_box()['y'] + 10
            maximum.check()
            sync.check(); expect(maximum).to_be_disabled(); expect(maximum).to_be_checked()
            search.check(); expect(maximum).to_be_disabled()
            sync.uncheck(); expect(maximum).to_be_disabled()
            fixed.check(); expect(maximum).to_be_enabled(); expect(maximum).to_be_checked()
            maximum.uncheck()
            vertices = [[.4, .3, .55], [.48, .3, .55], [.66, .3, .55], [.45, .4, .55]]
            for point in vertices:
                xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '4')
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('最大保障折线')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            with page.expect_download() as original_download:
                start_project_download(page)
            authored = read_exported_project(original_download.value)['virtualTeaching']['tasks'][0]['polylines'][0]
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            before_base, before_joints = base_pose(canvas), canvas.get_attribute('data-robot-joint-values')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            maximum.check()
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(panel).to_have_attribute('data-plan-partial', 'true')
            expect(panel).to_have_attribute('data-plan-executable', 'true')
            assert canvas.get_attribute('data-robot-joint-values') == before_joints
            assert base_pose(canvas) == before_base
            end = json.loads(panel.get_attribute('data-planned-end'))
            assert .515 < end[0] < .522 and abs(end[1] - .3) < .001
            note = panel.get_by_role('note', name='最大保障结果', exact=True)
            expect(note).to_contain_text('P1 → P2')
            expect(note).to_contain_text('停止原因')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '4')
            expect(canvas).to_have_attribute('data-polyline-completed-mm', '0')
            assert set(json.loads(canvas.get_attribute('data-polyline-preview-colors'))) == {'72dfb6', 'ff796b'}
            note.scroll_into_view_if_needed()
            page.screenshot(path=str(ARTIFACTS / 'partial-ready.png'), full_page=True)
            panel.get_by_role('button', name='执行可达部分', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            expect(maximum).to_be_disabled()
            page.wait_for_function('''() => Number(document.querySelector('.three-canvas').dataset.polylineCompletedMm) > 20''')
            panel.get_by_role('button', name='暂停', exact=True).click()
            stopped = canvas.get_attribute('data-robot-joint-values')
            completed_mm = canvas.get_attribute('data-polyline-completed-mm')
            assert set(json.loads(canvas.get_attribute('data-polyline-preview-colors'))) == {'ffb02e', '72dfb6', 'ff796b'}
            page.wait_for_timeout(250)
            expect(canvas).to_have_attribute('data-polyline-completed-mm', completed_mm)
            assert canvas.get_attribute('data-robot-joint-values') == stopped
            panel.get_by_role('button', name='继续', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            assert set(json.loads(canvas.get_attribute('data-polyline-preview-colors'))) == {'ffb02e', 'ff796b'}
            assert abs(float(canvas.get_attribute('data-polyline-completed-mm')) - float(panel.get_attribute('data-planned-distance')) * 1000) < .001
            expect(panel.locator('[role=status]')).to_contain_text('已完成可执行部分')
            after = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert .11 < after['left_J1'] <= .12000001 and abs(after['left_J2']) < .001
            assert abs(.4 + after['left_J1'] - end[0]) < .0011
            assert after['right_J1'] == json.loads(before_joints)['right_J1']
            assert base_pose(canvas) == before_base
            expect(panel).to_have_attribute('data-point-count', '4')
            page.screenshot(path=str(ARTIFACTS / 'partial-completed.png'), full_page=True)
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            path_id = panel.get_attribute('data-path-id')
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            with page.expect_download() as download:
                start_project_download(page)
            saved = read_exported_project(download.value)['virtualTeaching']['tasks'][0]['polylines'][0]
            assert saved['base']['allowPartial'] is True
            assert len(saved['points']) == 4
            assert saved['points'] == authored['points'], 'planning and playback must not truncate the saved source curve'
            for actual, intended in zip(saved['points'], vertices):
                assert math.dist(actual['position'], intended) < .002, (actual, intended)
            # Saved replay from the data center must accept the checked prefix.
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            page.get_by_role('button', name='播放示教任务 折线示教', exact=True).click()
            expect(panel).to_have_attribute('data-path-id', path_id)
            expect(panel).to_have_attribute('data-plan-partial', 'true', timeout=60000)
            expect(panel).to_have_attribute('data-status', 'playing', timeout=60000)
            expect(maximum).to_be_checked()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            assert base_pose(canvas) == before_base
            maximum.uncheck()
            expect(panel).to_have_attribute('data-plan-executable', 'false')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(maximum).not_to_be_checked()
            maximum.check()
            for point in [[.66, .3, .55], [.66, .5, .55]]:
                xy = project_point(page, point); page.mouse.click(xy['x'], xy['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            before = canvas.get_attribute('data-robot-joint-values')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            expect(panel).to_have_attribute('data-plan-executable', 'false')
            expect(panel.locator('[role=status]')).to_contain_text('到起点的移动')
            assert canvas.get_attribute('data-robot-joint-values') == before
            assert not errors, errors
            print('Maximum-protection UI: first row, fixed-only option, strict failure, partial plan and colors, real motion, pause/resume, fixed base, preserved full path, ZIP/reload, data-center autoplay and unreachable-start rejection passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('errors:', errors, flush=True)
            print('panel:', page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else 'closed', flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
