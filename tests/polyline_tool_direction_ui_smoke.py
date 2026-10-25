"""Immediate tool-axis configuration with camera/probe models and saved offsets."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from polyline_teaching_ui_smoke import BASE, project_point
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts/polyline-tool-direction'


def run(mount):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    urdf = (ROOT / 'tests/fixtures/polyline-robot.urdf').read_text()
    if mount == 'camera':
        attachments = ''.join(f'''<link name="zivid_{side}_optical_frame"/>
          <joint name="zivid_{side}_optical_joint" type="fixed"><parent link="tool_{side}"/>
          <child link="zivid_{side}_optical_frame"/><origin rpy="{angle} 0 0"/></joint>'''
          for side, angle in [('left', '3.141592653589793'), ('right', '0')])
    else:
        attachments = ''.join(f'''<link name="probe_{side}"><visual><origin xyz="0 0 0.15"/>
          <geometry><cylinder radius="0.005" length="0.3"/></geometry></visual></link>
          <joint name="probe_{side}_mount" type="fixed"><parent link="tool_{side}"/>
          <child link="probe_{side}"/></joint>''' for side in ['left', 'right'])
    urdf = urdf.replace('</robot>', attachments + '</robot>')
    descriptor = dict(id='polyline-test.urdf', relativePath='polyline-test.urdf', name='polyline_test_robot', fileName='polyline-test.urdf',
                      format='urdf', url='/__atlas/robot-files/polyline-test.urdf', packageName='', packagePath='', packageBaseUrl='/__atlas/robot-files/', manifestUrl=None)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1680, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
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
            page.get_by_role('button', name='显示设置', exact=True).click()
            display = page.get_by_role('dialog', name='3D 显示设置', exact=True)
            display.get_by_role('switch', name='显示机器人模型', exact=True).click()
            display.get_by_role('button', name='关闭显示设置', exact=True).click()
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel = page.get_by_role('region', name='表面折线示教', exact=True)
            side = panel.get_by_role('combobox', name='折线执行机械臂', exact=True)
            direction = panel.get_by_role('combobox', name='末端距线段方向', exact=True)
            distance = panel.get_by_role('spinbutton', name='末端距线段 mm', exact=True)
            expect(panel.get_by_role('button', name='采用相机朝向', exact=True)).to_have_count(0)
            expect(panel).not_to_contain_text('相机朝向')
            expect(direction).to_have_value('-1'); expect(distance).to_have_value('200')
            side.select_option('right')
            expect(direction).to_have_value('-1')
            distance.fill('150'); distance.press('Tab')
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            offset_z = panel.get_by_role('spinbutton', name='笔尖偏移 Z mm', exact=True)
            direction.select_option('1'); expect(offset_z).to_have_value('150')
            side.select_option('left'); side.select_option('right')
            expect(direction).to_have_value('1'); expect(distance).to_have_value('150')
            direction.select_option('-1'); expect(offset_z).to_have_value('-150')
            panel.get_by_role('button', name='撤销', exact=True).click()
            expect(direction).to_have_value('1'); expect(offset_z).to_have_value('150')
            for axis, value in [('X', '10'), ('Y', '-5'), ('Z', '-175')]:
                field = panel.get_by_role('spinbutton', name=f'笔尖偏移 {axis} mm', exact=True)
                field.fill(value); field.press('Tab')
            expect(direction).to_have_value('-1'); expect(distance).to_have_value('175')
            distance.fill('0'); distance.press('Tab')
            side.select_option('left'); side.select_option('right')
            expect(direction).to_have_value('-1')
            direction.select_option('1'); distance.fill('175'); distance.press('Tab')
            expect(panel.get_by_role('spinbutton', name='笔尖偏移 Z mm', exact=True)).to_have_value('175')
            direction.select_option('-1')
            for point in [[.4, .3, .55], [.6, .25, .55]]:
                target = project_point(page, point); page.mouse.click(target['x'], target['y'])
            expect(panel).to_have_attribute('data-point-count', '2')
            panel.get_by_role('textbox', name='折线名称', exact=True).fill('右臂自定偏移')
            panel.get_by_role('button', name='保存', exact=True).click()
            expect(panel).to_have_attribute('data-status', 'editing')
            with page.expect_download() as download:
                start_project_download(page)
            exported = read_exported_project(download.value)
            saved = [path for task in exported['virtualTeaching']['tasks'] for path in task.get('polylines', [])]
            assert len(saved) == 1 and saved[0]['toolAxisMode'] == 'manual'
            assert saved[0]['side'] == 'right' and saved[0]['tcpOffset'] == [.01, -.005, -.175]
            panel.get_by_role('button', name='新建', exact=True).click()
            expect(side).to_have_value('right'); expect(direction).to_have_value('-1'); expect(distance).to_have_value('175')
            for axis, value in [('X', '10'), ('Y', '-5'), ('Z', '-175')]:
                expect(panel.get_by_role('spinbutton', name=f'笔尖偏移 {axis} mm', exact=True)).to_have_value(value)
            expect(panel).to_have_attribute('data-path-id', ''); expect(panel).to_have_attribute('data-point-count', '0')
            page.reload(wait_until='networkidle')
            page.locator('[data-session-state=ready]').wait_for()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded')
            page.get_by_role('button', name='表面折线示教', exact=True).click()
            panel.locator('summary').filter(has_text='已保存折线').click()
            panel.locator('.polyline-teaching__library button').filter(has_text='右臂自定偏移').click()
            expect(side).to_have_value('right'); expect(direction).to_have_value('-1'); expect(distance).to_have_value('175')
            expect(panel).not_to_contain_text('相机朝向')
            direction.select_option('1'); expect(direction).to_have_value('1')
            panel.locator('summary').filter(has_text='虚拟笔尖偏移').click()
            expect(panel.get_by_role('spinbutton', name='笔尖偏移 Z mm', exact=True)).to_have_value('175')
            expect(panel.get_by_role('spinbutton', name='笔尖偏移 X mm', exact=True)).to_have_value('10')
            expect(panel.get_by_role('spinbutton', name='笔尖偏移 Y mm', exact=True)).to_have_value('-5')
            panel.get_by_role('button', name='撤销', exact=True).click(); expect(direction).to_have_value('-1')
            side.select_option('left'); side.select_option('right'); expect(direction).to_have_value('-1')
            page.screenshot(path=str(ARTIFACTS / f'{mount}-right-offset.png'), full_page=True)
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(ARTIFACTS / f'failure-{mount}.png'), full_page=True)
            print(page.locator('.polyline-teaching').inner_text() if page.locator('.polyline-teaching').count() else errors)
            raise
        finally:
            browser.close()
    print(f'Polyline tool direction UI ({mount}): immediate axis changes, preserved distance/XY, arm switching, advanced/zero offsets, undo, export and reload passed.')


if __name__ == '__main__':
    for mount in ['camera', 'probe']:
        run(mount)
