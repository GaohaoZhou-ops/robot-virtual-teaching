"""Saved polyline tree entries preview and replay independently of parking points."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project, start_project_download
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-sidebar'


def exported_project(page):
    with page.expect_download() as download:
        start_project_download(page)
    return read_exported_project(download.value)


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                          format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
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
            tree = page.get_by_role('tree', name='虚拟示教任务停车点层级', exact=True)
            capture = page.locator('.virtual-teaching.is-capture-view')
            ids = {}
            for index, (name, points) in enumerate([
                ('折线 A', [[.4, .3, .55], [.51, .3, .55], [.51, .43, .55]]),
                ('折线 B', [[.42, .3, .55], [.47, .4, .55]]),
                ('不可达折线', [[.4, .3, .55], [.51, .3, .55]]),
            ]):
                if index:
                    panel.get_by_role('button', name='新建', exact=True).click()
                panel.get_by_role('textbox', name='折线名称', exact=True).fill(name)
                for point in points:
                    xy = project_point(page, point)
                    page.mouse.click(xy['x'], xy['y'])
                expect(panel).to_have_attribute('data-point-count', str(len(points)))
                if name == '不可达折线':
                    panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
                    offset = panel.get_by_role('spinbutton', name='笔尖偏移 Z mm', exact=True)
                    offset.fill('1000'); offset.press('Enter')
                panel.get_by_role('button', name='保存', exact=True).click()
                expect(panel).to_contain_text('已保存至当前示教任务')
                ids[name] = panel.get_attribute('data-path-id')
                page.get_by_role('button', name='图谱控制台', exact=True).click()
                expect(tree.get_by_role('button', name=f'查看折线 {name}', exact=True)).to_be_visible()
                page.get_by_role('button', name='表面折线示教', exact=True).click()
                expect(panel).to_have_attribute('data-path-id', ids[name])
                expect(panel).to_have_attribute('data-point-count', str(len(points)))
            expect(capture).to_have_attribute('data-parking-point-count', '0')
            expect(tree.get_by_text('暂无停车点，可记录机器人当前位置', exact=True)).to_have_count(0)
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            before = exported_project(page)['virtualTeaching']['tasks']
            assert len(before) == 1 and before[0]['parkingPoints'] == []
            assert len(before[0]['polylines']) == 3
            # Existing persisted records appear directly after reload; no resave/migration.
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            expect(tree.locator('[data-polyline-id]')).to_have_count(3)
            initial = json.loads(canvas.get_attribute('data-robot-joint-values'))
            page.get_by_role('button', name='显示设置', exact=True).click()
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            tree.get_by_role('button', name='查看折线 折线 A', exact=True).click()
            expect(panel).to_have_attribute('data-path-id', ids['折线 A'])
            expect(panel).to_have_attribute('data-point-count', '3')
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '2')
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'true')
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == initial
            expect(capture).to_be_hidden()
            page.screenshot(path=str(ARTIFACTS / 'preview.png'), full_page=True)
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            expect(capture.get_by_role('button', name='删除折线', exact=True)).to_be_enabled()
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            tree.get_by_role('button', name='回放折线 折线 A', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing', timeout=60000)
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            expect(capture).to_be_hidden()
            expect(capture.locator('[aria-label="回放折线 折线 B"]')).to_be_disabled()
            expect(capture.locator('[aria-label="删除折线"]')).to_be_disabled()
            page.wait_for_function('initial => JSON.stringify(JSON.parse(document.querySelector(".three-canvas").dataset.robotJointValues)) !== JSON.stringify(initial)', arg=initial)
            panel.get_by_role('button', name='暂停', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'paused')
            paused = canvas.get_attribute('data-robot-joint-values')
            page.wait_for_timeout(250)
            assert canvas.get_attribute('data-robot-joint-values') == paused
            panel.get_by_role('button', name='继续', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            actual = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert abs(actual['left_J1'] - .11) < .002 and abs(actual['left_J2'] - .13) < .002
            assert actual['right_J1'] == initial['right_J1']
            assert float(panel.get_attribute('data-tool-travel-mm')) > 200
            page.screenshot(path=str(ARTIFACTS / 'completed.png'), full_page=True)
            # Repeat playback replans from the endpoint and remains cancellable.
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            capture.get_by_role('button', name='回放当前折线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing', timeout=60000)
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            expect(panel).to_be_hidden()
            stopped = canvas.get_attribute('data-robot-joint-values')
            page.wait_for_timeout(350)
            assert canvas.get_attribute('data-robot-joint-values') == stopped
            expect(canvas).to_have_attribute('data-polyline-preview-visible', 'false')
            tree.get_by_role('button', name='回放折线 不可达折线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            assert canvas.get_attribute('data-robot-joint-values') == stopped
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_disabled()
            expect(panel.locator('[role=status]')).not_to_be_empty()
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()

            # The data center must use the same standalone replay engine, even
            # with zero parking poses. Navigating back must retain the request.
            archive = page.get_by_role('region', name='示教数据管理', exact=True)
            task_play = archive.get_by_role('button', name='播放示教任务 折线示教', exact=True)
            choice = archive.get_by_role('combobox', name='任务回放内容', exact=True)
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            expect(archive).to_have_attribute('data-parking-point-count', '0')
            expect(archive).to_have_attribute('data-polyline-count', '3')
            expect(archive.locator('[data-polyline-id]')).to_have_count(3)
            expect(archive.get_by_text('暂无停车点', exact=True)).to_have_count(0)
            expect(task_play).to_be_enabled()
            expect(choice).to_have_value('polyline:' + ids['折线 A'])
            archive.get_by_role('button', name='查看折线 折线 B', exact=True).click()
            expect(page).to_have_url(BASE + '/workbench')
            expect(panel).to_have_attribute('data-path-id', ids['折线 B'])
            expect(canvas).to_have_attribute('data-polyline-preview-segments', '1')
            assert canvas.get_attribute('data-robot-joint-values') == stopped
            expect(canvas).to_have_attribute('data-robot-layer-visible', 'false')
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            expect(task_play).to_be_enabled()
            # Robot visibility is a per-page setting; reload restores its
            # default. Playback must preserve the setting of this new page.
            visible_before_play = canvas.get_attribute('data-robot-layer-visible')
            choice.select_option('polyline:' + ids['折线 B'])
            page.screenshot(path=str(ARTIFACTS / 'data-center.png'), full_page=True)
            task_play.click()
            expect(page).to_have_url(BASE + '/workbench')
            expect(panel).to_have_attribute('data-path-id', ids['折线 B'])
            expect(panel).to_have_attribute('data-status', 'playing', timeout=60000)
            expect(page.get_by_label('示教任务轨迹播放控制', exact=True)).to_have_count(0)
            expect(canvas).to_have_attribute('data-robot-layer-visible', visible_before_play)
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            actual = json.loads(canvas.get_attribute('data-robot-joint-values'))
            assert abs(actual['left_J1'] - .07) < .002 and abs(actual['left_J2'] - .1) < .002
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            stopped = canvas.get_attribute('data-robot-joint-values')
            archive.get_by_role('button', name='回放折线 不可达折线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            assert canvas.get_attribute('data-robot-joint-values') == stopped
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            assert exported_project(page)['virtualTeaching']['tasks'] == before, 'viewing/replaying must not change authored records'
            # A parking point can coexist without owning or gating the polylines.
            capture.get_by_role('button', name='新增停车点', exact=True).click()
            expect(capture).to_have_attribute('data-parking-point-count', '1')
            capture.get_by_role('button', name='记录当前姿态', exact=True).click()
            expect(capture).to_have_attribute('data-teaching-point-count', '1')
            mixed = exported_project(page)['virtualTeaching']['tasks'][0]
            # Parking poses and polylines remain separate playback choices.
            topbar_action(page, name='打开示教数据管理页', exact=True).click()
            archive.get_by_role('button', name='选择示教任务 折线示教', exact=True).click()
            expect(choice).to_have_value('poses')
            expect(task_play).to_be_enabled()
            task_play.click()
            dock = page.get_by_label('示教任务轨迹播放控制', exact=True)
            expect(dock).to_be_visible()
            expect(panel).to_be_hidden()
            dock.get_by_role('button', name='停止示教轨迹播放', exact=True).click()
            tree.get_by_role('button', name='回放折线 折线 B', exact=True).click()
            expect(panel).to_have_attribute('data-path-id', ids['折线 B'])
            expect(panel).to_have_attribute('data-point-count', '2')
            expect(panel).to_have_attribute('data-status', 'playing', timeout=60000)
            panel.get_by_role('button', name='停止折线任务', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'editing')
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            assert exported_project(page)['virtualTeaching']['tasks'][0]['parkingPoints'] == mixed['parkingPoints']
            tree.get_by_role('button', name='查看折线 不可达折线', exact=True).click()
            panel.get_by_role('button', name='关闭折线示教', exact=True).click()
            page.once('dialog', lambda dialog: dialog.accept())
            capture.get_by_role('button', name='删除折线', exact=True).click()
            expect(tree.locator('[data-polyline-id]')).to_have_count(2)
            expect(capture).to_have_attribute('data-parking-point-count', '1')
            expect(capture).to_have_attribute('data-teaching-task-count', '1')
            assert not errors, errors
            print('Polyline sidebar/data center: standalone records, reload, preview, preserved visibility, selected task playback, cross-page automatic preflight/playback, real motion, pause/resume, repeated playback, stop/close, failed-check isolation, separate mixed-task pose playback and scoped deletion passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print('errors:', errors, flush=True)
            editor = page.locator('.polyline-teaching')
            print('panel:', editor.inner_text() if editor.count() else 'closed', flush=True)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
