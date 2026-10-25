"""Real worker budgets, parameter editing/persistence and nonmutating help."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_approach_ui_smoke import surface
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-parameters'
DEFAULTS = {'位置容差 mm': '1', '朝向容差 °': '0.5', '采样间距 mm': '4', '末端加速度 mm/s²': '200',
            '深入搜索时限 s': '15', '深入候选上限 个': '128', '姿态重试上限 次': '12', '重试采样预算 次': '96'}
MODIFIED = dict(zip(DEFAULTS, ['1.5', '0.7', '3', '250', '30', '64', '20', '160']))


def setup(page, blocked=False):
    descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                      format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
    page.add_init_script('''
        window.polylineRequests = []; window.polylineResults = [];
        const OriginalWorker = window.Worker;
        window.Worker = class extends OriginalWorker {
            constructor(...args) {
                super(...args);
                this.addEventListener('message', ({data}) => {
                    if (data.type === 'complete' && data.value?.approachSearch) window.polylineResults.push(data.value.approachSearch);
                });
            }
            postMessage(data, ...rest) {
                if (data?.path?.settings) window.polylineRequests.push(structuredClone(data.path.settings));
                return super.postMessage(data, ...rest);
            }
        };
    ''')
    page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
    page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
    page.goto(BASE + '/workbench', wait_until='networkidle')
    page.locator('[data-session-state=ready]').wait_for()
    if blocked:
        page.locator('input[type=file][accept=".ply"]').set_input_files({'name': 'blocked-start.ply', 'mimeType': 'application/octet-stream', 'buffer': surface(blocked=blocked).encode()})
    else:
        page.locator('input[type=file][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/polyline-surface.ply'))
    page.locator('.loading-curtain').wait_for(state='hidden')
    topbar_action(page, name='加载机器人', exact=True).click()
    page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
    canvas = page.locator('.three-canvas')
    expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
    page.get_by_role('button', name='显示设置', exact=True).click()
    display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
    display.get_by_role('switch', name='显示机器人模型', exact=True).click()
    display.get_by_role('button', name='关闭显示设置', exact=True).click()
    page.get_by_role('button', name='表面折线示教', exact=True).click()
    return page.get_by_role('region', name='表面折线示教', exact=True), canvas


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            panel, canvas = setup(page)
            advanced = panel.locator('.polyline-teaching__algorithm')
            help_button = panel.get_by_role('button', name='查看算法约束说明', exact=True)
            constraints = panel.get_by_role('group', name='算法约束', exact=True)
            field = lambda label: panel.get_by_role('spinbutton', name=label, exact=True)
            expect(advanced).not_to_have_attribute('open', '')
            expect(constraints.locator('p.polyline-teaching__hint')).to_have_count(0)
            rect, icon = constraints.bounding_box(), help_button.bounding_box()
            assert 0 <= rect['x'] + rect['width'] - icon['x'] - icon['width'] < 15
            assert 0 <= icon['y'] - rect['y'] < 15
            page.screenshot(path=str(ARTIFACTS / 'collapsed.png'), full_page=True)
            advanced.locator('summary').click()
            for label, value in DEFAULTS.items():
                expect(field(label)).to_have_value(value)
            # Empty edits and Escape do not commit zero or invalidate the state.
            count = panel.get_attribute('data-undo-count')
            field('深入搜索时限 s').fill(''); field('深入搜索时限 s').press('Enter')
            expect(field('深入搜索时限 s')).to_have_value('15')
            assert panel.get_attribute('data-undo-count') == count
            field('深入搜索时限 s').fill('50'); field('深入搜索时限 s').press('Escape')
            expect(field('深入搜索时限 s')).to_have_value('15')
            expect(panel).to_be_visible()
            field('深入搜索时限 s').fill('99'); field('深入搜索时限 s').press('Enter')
            expect(field('深入搜索时限 s')).to_have_value('60')
            field('姿态重试上限 次').fill('12.6'); field('姿态重试上限 次').press('Enter')
            expect(field('姿态重试上限 次')).to_have_value('13')
            field('深入搜索时限 s').fill('0'); field('深入搜索时限 s').press('Enter')
            expect(field('深入候选上限 个')).to_be_disabled()
            field('姿态重试上限 次').fill('0'); field('姿态重试上限 次').press('Enter')
            expect(field('重试采样预算 次')).to_be_disabled()
            panel.get_by_role('button', name='恢复高级参数默认值', exact=True).click()
            for label, value in MODIFIED.items():
                field(label).fill(''); field(label).press_sequentially(value)
                expect(field(label)).to_have_value(value)
                field(label).press('Enter')
            expect(advanced.locator('summary')).to_contain_text('8 项已调整')
            constraints.get_by_role('checkbox', name='移动', exact=True).check()
            for label in list(DEFAULTS)[4:]:
                expect(field(label)).to_be_disabled()
            expect(field('位置容差 mm')).to_be_enabled()
            expect(panel.get_by_role('spinbutton', name='底盘水平范围 m', exact=True)).to_have_value('2')
            constraints.get_by_role('checkbox', name='静止', exact=True).check()
            for label, value in MODIFIED.items():
                expect(field(label)).to_be_enabled(); expect(field(label)).to_have_value(value)
            panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True).fill('80')
            panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True).press('Enter')
            for vertex in [[.4, .3, .55], [.6, .3, .55], [.6, .5, .55]]:
                point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            sent = page.evaluate('window.polylineRequests.at(-1)')
            expected = dict(tolerance=.0015, rotationTolerance=.7, step=.003, acceleration=.25,
                            deepSearchSeconds=30, deepSearchCandidates=64, postureRetries=20, postureSamples=160)
            for key, value in expected.items():
                assert sent[key] == value, (key, sent)
            expect(panel.get_by_label('匀速划线结果', exact=True)).to_contain_text('圆角偏移 ≤ 0.75 mm')
            before = dict(points=panel.get_attribute('data-point-count'), undo=panel.get_attribute('data-undo-count'),
                          joints=canvas.get_attribute('data-robot-joint-values'), status=panel.get_attribute('data-status'))
            help_button.click()
            help_dialog = page.get_by_role('dialog', name='算法约束与参数说明', exact=True)
            expect(help_dialog).to_be_visible()
            expect(help_dialog).to_contain_text('与移动、自搜索互斥')
            expect(help_dialog).to_contain_text('另一臂保持关节角并随腰部移动')
            page.screenshot(path=str(ARTIFACTS / 'help-options.png'), full_page=True)
            help_dialog.locator('summary').filter(has_text='接近搜索与姿态重试').click()
            expect(help_dialog).to_contain_text('当前 30 s')
            expect(help_dialog).to_contain_text('默认 15 s · 范围 0–60 s')
            expect(help_dialog).to_contain_text('当前 64 个')
            page.keyboard.press('Escape')
            expect(help_dialog).to_have_count(0)
            expect(help_button).to_be_focused()
            assert before == dict(points=panel.get_attribute('data-point-count'), undo=panel.get_attribute('data-undo-count'),
                                  joints=canvas.get_attribute('data-robot-joint-values'), status=panel.get_attribute('data-status'))
            # Cosmetic expansion/collapse must not invalidate the checked plan.
            advanced.locator('summary').click(); advanced.locator('summary').click()
            expect(panel.get_by_role('button', name='执行划线', exact=True)).to_be_enabled()
            advanced.scroll_into_view_if_needed()
            page.screenshot(path=str(ARTIFACTS / 'expanded.png'), full_page=True)
            panel.get_by_role('button', name='执行划线', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'playing')
            expect(field('深入搜索时限 s')).to_be_disabled()
            expect(help_button).to_be_enabled()
            help_button.click(); expect(help_dialog).to_be_visible()
            help_dialog.get_by_role('button', name='返回示教', exact=True).click()
            panel.get_by_role('button', name='停止折线任务', exact=True).click()
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('算法参数回归')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_contain_text('已保存至当前示教任务')
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)
            saved = [path for task in exported['virtualTeaching']['tasks'] for path in task.get('polylines', [])]
            assert len(saved) == 1
            for key, value in expected.items():
                assert saved[0]['settings'][key] == value, key
            panel.get_by_role('button', name='恢复高级参数默认值', exact=True).click()
            for label, value in DEFAULTS.items():
                expect(field(label)).to_have_value(value)
            expect(panel).to_have_attribute('data-point-count', '3')
            expect(panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True)).to_have_value('80')
            panel.get_by_role('button', name='撤销', exact=True).click()
            for label, value in MODIFIED.items():
                expect(field(label)).to_have_value(value)
            page.set_viewport_size({'width': 1000, 'height': 720})
            assert panel.evaluate('el => el.scrollWidth <= el.clientWidth')
            help_button.click()
            help_dialog.locator('summary').filter(has_text='精度与运动').click()
            help_dialog.locator('.polyline-algorithm-help__parameters dt').filter(has_text='位置容差').scroll_into_view_if_needed()
            assert help_dialog.evaluate('el => el.scrollWidth <= el.clientWidth')
            box = help_dialog.bounding_box()
            assert box['x'] >= 0 and box['y'] >= 0 and box['x'] + box['width'] <= 1000 and box['y'] + box['height'] <= 720
            page.screenshot(path=str(ARTIFACTS / 'help-compact.png'), full_page=True)
            help_dialog.get_by_role('button', name='关闭算法约束说明', exact=True).click()
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(panel).to_have_attribute('data-point-count', '0')
            for label, value in MODIFIED.items():
                expect(field(label)).to_have_value(value)
            page.reload(wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            advanced.locator('summary').click()
            for label, value in MODIFIED.items():
                expect(field(label)).to_have_value(value)
            expect(panel).to_have_attribute('data-point-count', '0')
            panel.get_by_role('button', name='恢复高级参数默认值', exact=True).click()
            panel.locator('.polyline-teaching__library summary').click()
            panel.locator('.polyline-teaching__library button').filter(has_text='算法参数回归').click()
            for label, value in MODIFIED.items():
                expect(field(label)).to_have_value(value)
            expect(panel).to_have_attribute('data-point-count', '3')
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print(page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else errors)
            raise
        finally:
            page.close()
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            panel, canvas = setup(page, blocked='approach')
            # View the drawing patch from its side of the wall. Otherwise a
            # real raycast would select the wall in front of the intended P0.
            panel.get_by_role('button', name='仅调整视角', exact=True).click()
            rect = canvas.bounding_box()
            for _ in range(4):
                if float(canvas.get_attribute('data-camera-x')) > .8:
                    break
                previous = canvas.get_attribute('data-camera-x')
                x, y = rect['x'] + rect['width'] * .3, rect['y'] + rect['height'] * .3
                page.mouse.move(x, y); page.mouse.down()
                page.mouse.move(x + rect['width'] * .4, y, steps=15); page.mouse.up()
                expect(canvas).not_to_have_attribute('data-camera-x', previous)
            assert float(canvas.get_attribute('data-camera-x')) > .8
            panel.get_by_role('button', name='返回表面点选', exact=True).click()
            panel.locator('.polyline-teaching__algorithm summary').click()
            limit = panel.get_by_role('spinbutton', name='深入候选上限 个', exact=True)
            limit.fill('2'); limit.press('Enter')
            for vertex in [[.9, .27, .551], [.9, .35, .551]]:
                point = project_point(page, vertex); page.mouse.click(point['x'], point['y'])
            expect(panel.get_by_role('button', name='选择折线点 P0', exact=True)).to_contain_text('0.900 / 0.270 / 0.551')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            expect(panel).to_have_attribute('data-approach-stop-reason', 'candidate-limit')
            result = page.evaluate('window.polylineResults.at(-1)')
            assert result['deepCandidateLimit'] == 2 and result['deepAttempts'] == 2
            panel.get_by_role('button', name='查看深入搜索失败说明', exact=True).click()
            failure = page.get_by_role('dialog', name='路径检查结果说明', exact=True)
            expect(failure).to_contain_text('2 个候选方案数量上限')
            page.keyboard.press('Escape')
            seconds = panel.get_by_role('spinbutton', name='深入搜索时限 s', exact=True)
            seconds.fill('0'); seconds.press('Enter')
            expect(panel).to_have_attribute('data-status', 'editing')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
            expect(panel).to_have_attribute('data-approach-stop-reason', 'disabled')
            assert page.evaluate('window.polylineResults.at(-1).deepAttempts') == 0
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'budget-failure.png'), full_page=True)
            raise
        finally:
            browser.close()
    print('Algorithm parameters UI: collapsed layout/help, current/default values, limits, zero-free drafts, scopes, worker settings and budgets, playback locks, reset/undo, export/reopen and refresh memory passed.')


if __name__ == '__main__':
    run()
