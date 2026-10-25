"""Worker recovery, approach preview, fixed-base playback and drawing progress."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from polyline_base_ui_smoke import base_pose
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-approach'


def surface(saved_guide=False, blocked=False):
    # Drawing plane below the wrist, plus a wall crossing only the approach.
    vertices = [[.82, .2, .551], [1, .2, .551], [1, .45, .551], [.82, .45, .551], [0, 0, 0]]
    faces = [[0, 1, 2], [0, 2, 3]]
    boxes = [([.02, .3, .3], [.9 if blocked else .7, .3, .85])] if not saved_guide else [
        ([.5, .02, .4], [.55, .349, .85]), ([.5, .02, .4], [.55, .251, .85]),
        ([.5, .5, .02], [.55, .3, .899]), ([.5, .5, .02], [.55, .3, .801]),
    ]
    for size, center in boxes:
        start = len(vertices)
        low = [center[i] - size[i] / 2 for i in range(3)]
        high = [center[i] + size[i] / 2 for i in range(3)]
        vertices += [[x, y, z] for z in [low[2], high[2]] for y in [low[1], high[1]] for x in [low[0], high[0]]]
        for quad in [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]:
            faces += [[start + quad[i] for i in tri] for tri in [[0, 1, 2], [0, 2, 3]]]
    return (f'ply\nformat ascii 1.0\nelement vertex {len(vertices)}\nproperty float x\nproperty float y\nproperty float z\n'
            f'element face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n'
            + '\n'.join(' '.join(map(str, point)) for point in vertices) + '\n'
            + '\n'.join('3 ' + ' '.join(map(str, face)) for face in faces) + '\n')


def run(saved_guide=False, deep_search=False, failed_search=False):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                      format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        # Observe real worker progress in this isolated test page. Do not alter
        # messages, planning inputs, or the production worker's implementation.
        page.add_init_script('''
            window.approachProgress = [];
            const OriginalWorker = window.Worker;
            window.Worker = class extends OriginalWorker {
                constructor(...args) {
                    super(...args);
                    this.addEventListener('message', ({data}) => {
                        if (data.type === 'progress' && data.value?.phase === 'approach-search')
                            window.approachProgress.push(data.value);
                    });
                }
            };
        ''')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/__atlas/robots', lambda route: route.fulfill(json={'robots': [descriptor]}))
        page.route('**/__atlas/robot-files/polyline-test.urdf', lambda route: route.fulfill(content_type='application/xml', body=(ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            page.locator('input[type=file][accept=".ply"]').set_input_files({'name': 'approach-wall.ply', 'mimeType': 'application/octet-stream', 'buffer': surface(saved_guide or deep_search, blocked=failed_search).encode()})
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 polyline_test_robot', exact=True).click()
            canvas = page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            initial_base = base_pose(canvas)
            initial_joints = json.loads(canvas.get_attribute('data-robot-joint-values'))
            page.get_by_role('button', name='显示设置', exact=True).click()
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            help_button = panel.get_by_role('button', name='查看深入搜索失败说明', exact=True)
            expect(help_button).to_have_count(0)
            if saved_guide:
                for point in [[.9, .3, .551], [.98, .3, .551]]:
                    target = project_point(page, point); page.mouse.click(target['x'], target['y'])
                panel.get_by_role('textbox', name='折线名称', exact=True).fill('已保存通道折线')
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
                expect(panel).to_have_attribute('data-approach-mode', '')
                panel.get_by_role('button', name='保存', exact=True).click()
                expect(panel).to_contain_text('折线已保存')
                saved_id = panel.get_attribute('data-path-id')
                panel.get_by_role('button', name='新建', exact=True).click()
            vertices = [[.9, .35, .551], [.98, .35, .551]] if saved_guide or deep_search else [[.9, .27, .551], [.9, .35, .551]]
            for point in vertices:
                target = project_point(page, point)
                page.mouse.click(target['x'], target['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('button', name='检查路径', exact=True).click()
            if failed_search:
                expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
                expect(panel).to_have_attribute('data-approach-stage', 'deep')
                expect(help_button).to_be_visible()
                error_box = panel.locator('.polyline-teaching__message[data-error=true]')
                rect, icon = error_box.bounding_box(), help_button.bounding_box()
                assert 0 <= rect['x'] + rect['width'] - icon['x'] - icon['width'] < 12
                assert 0 <= icon['y'] - rect['y'] < 12, 'help icon belongs in the error box upper right'
                before = dict(count=panel.get_attribute('data-point-count'), path=panel.get_attribute('data-path-id'),
                              joints=canvas.get_attribute('data-robot-joint-values'), base=base_pose(canvas))
                help_button.click()
                explanation = page.get_by_role('dialog', name='路径检查结果说明', exact=True)
                expect(explanation).to_be_visible()
                expect(explanation).to_contain_text('划线尚未开始')
                expect(explanation).to_contain_text('有限搜索失败不代表全局不可达')
                expect(explanation).to_contain_text('初次直线接近的失败记录')
                expect(explanation).to_contain_text('预留区相交不等于真实外壳已经接触')
                expect(explanation.get_by_role('region', name='本次搜索统计')).to_contain_text('深入搜索')
                expect(explanation.get_by_role('heading', name='可以尝试的调整', exact=True)).to_be_visible()
                explanation.locator('summary').filter(has_text='本次规划约束').click()
                expect(explanation).to_contain_text('200.0 mm · 工具 −Z')
                page.screenshot(path=str(ARTIFACTS / 'failure-explanation.png'), full_page=True)
                page.keyboard.press('Escape')
                expect(explanation).to_have_count(0)
                expect(help_button).to_be_focused()
                expect(panel).to_have_attribute('data-status', 'failed')
                expect(panel).to_have_attribute('data-point-count', before['count'])
                expect(panel).to_have_attribute('data-path-id', before['path'])
                assert canvas.get_attribute('data-robot-joint-values') == before['joints']
                assert base_pose(canvas) == before['base']
                help_button.click()
                explanation.get_by_role('button', name='返回调整', exact=True).click()
                expect(explanation).to_have_count(0)
                help_button.click()
                explanation.get_by_role('button', name='关闭路径检查结果说明', exact=True).click()
                expect(explanation).to_have_count(0)
                panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True).fill('250')
                panel.get_by_role('spinbutton', name='折线速度 mm/s', exact=True).press('Tab')
                expect(panel).to_have_attribute('data-status', 'editing')
                expect(help_button).to_have_count(0)
                expect(panel).to_have_attribute('data-point-count', before['count'])
                panel.get_by_role('button', name='检查路径', exact=True).click()
                expect(panel).to_have_attribute('data-status', 'failed', timeout=60000)
                expect(help_button).to_be_visible()
                expect(explanation).to_have_count(0)
                page.set_viewport_size({'width': 1000, 'height': 720})
                help_button.click()
                expect(explanation.get_by_role('button', name='返回调整', exact=True)).to_be_visible()
                box = explanation.bounding_box()
                assert box['x'] >= 0 and box['y'] >= 0 and box['x'] + box['width'] <= 1000 and box['y'] + box['height'] <= 720
                assert explanation.evaluate('element => element.scrollWidth <= element.clientWidth')
                page.screenshot(path=str(ARTIFACTS / 'failure-explanation-compact.png'), full_page=True)
                explanation.get_by_role('button', name='返回调整', exact=True).click()
                assert not errors, errors
                print('Polyline failure explanation: real deep-search failure, contextual diagnosis/advice, icon placement, Escape/focus, nonmutating close and stale-result reset passed.')
                return
            expect(panel).to_have_attribute('data-status', 'ready', timeout=60000)
            expect(help_button).to_have_count(0)
            expect(panel).to_have_attribute('data-approach-mode', 'successful-path' if saved_guide else 'detour')
            expect(panel).to_have_attribute('data-approach-stage', 'deep' if deep_search else 'quick')
            expect(panel).to_have_attribute('data-approach-stop-reason', 'complete')
            expect(panel).to_contain_text('已参考最近成功轨迹「已保存通道折线」接近 P0' if saved_guide else '已规划绕行到 P0')
            expect(panel).to_contain_text('接近搜索：快速')
            if deep_search:
                expect(panel).to_contain_text('深入搜索找到接近路线')
                updates = page.evaluate('window.approachProgress')
                assert any(value['searchStage'] == 'quick' for value in updates)
                assert any(value['searchStage'] == 'deep' and value['candidate'] > 0 and value['deepBudgetMs'] == 15000 for value in updates)
            assert abs(float(panel.get_attribute('data-planned-distance')) - .08) < .001
            expect(canvas).to_have_attribute('data-polyline-approach-visible', 'true')
            assert json.loads(canvas.get_attribute('data-robot-joint-values')) == initial_joints
            assert base_pose(canvas) == initial_base
            preview = panel.get_by_role('checkbox', name='显示笔尖路径预览', exact=True)
            preview.uncheck()
            expect(canvas).to_have_attribute('data-polyline-approach-visible', 'false')
            preview.check()
            expect(canvas).to_have_attribute('data-polyline-approach-visible', 'true')
            page.screenshot(path=str(ARTIFACTS / ('deep-search-preview.png' if deep_search else 'saved-path-preview.png' if saved_guide else 'detour-preview.png')), full_page=True)
            page.get_by_role('button', name='显示设置', exact=True).click()
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            panel.get_by_role('button', name='执行划线', exact=True).click()
            page.wait_for_function('Number(document.querySelector(".polyline-teaching").dataset.toolTravelMm) > 10')
            assert float(canvas.get_attribute('data-polyline-completed-mm')) == 0, 'detour cannot count as drawn distance'
            expect(panel).to_have_attribute('data-status', 'completed', timeout=60000)
            assert abs(float(canvas.get_attribute('data-polyline-completed-mm')) - .08 * 1000) < 1
            assert base_pose(canvas) == initial_base
            assert json.loads(canvas.get_attribute('data-robot-joint-values'))['right_J1'] == initial_joints['right_J1']
            if saved_guide:
                with page.expect_download() as download:
                    start_project_download(page)
                project = read_exported_project(download.value)
                saved = [path for task in project['virtualTeaching']['tasks'] for path in task.get('polylines', [])]
                assert len(saved) == 1 and saved[0]['id'] == saved_id
                assert all(abs(point['position'][1] - .3) < .001 for point in saved[0]['points']), 'reference path must not be overwritten by the new stroke'
            page.get_by_role('button', name='图谱控制台', exact=True).click()
            assert canvas.get_attribute('data-polyline-approach-visible') is None
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
            print(page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else errors)
            raise
        finally:
            browser.close()
    print(f'Polyline approach UI ({"deep search" if deep_search else "saved path" if saved_guide else "generic detour"}): worker planning/progress, preview toggle/close, original stroke, fixed-base playback, preserved saved record and transit excluded from drawing passed.')


if __name__ == '__main__':
    run()
    run(saved_guide=True)
    run(deep_search=True)
    run(failed_search=True)
