"""Check the menu, persistence and live IK in an isolated browser context."""
import json
import math
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from joint_lock_smoke import double_click_tool
from topbar_tools_helpers import topbar_action
from viewer_tools_helpers import viewer_tool

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21994').rstrip('/')
CHROME = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
OUTPUT = ROOT / 'build/robot-joint-coupling'


def run():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=['--use-angle=metal', '--enable-gpu'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(60000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        menu = page.locator('[data-workbench-menu-trigger="robot"]')
        toggle = page.get_by_role('switch', name='关节6–7角度耦合', exact=True)
        canvas = page.locator('.three-canvas')

        def open_menu():
            if menu.get_attribute('aria-expanded') != 'true':
                menu.click()

        def wait_saved(enabled):
            check = '''async enabled => {
              const db = await new Promise(resolve => {
                const request = indexedDB.open('atlas-route-studio', 1);
                request.onsuccess = () => resolve(request.result);
              });
              try { return await new Promise(resolve => {
                const transaction = db.transaction('workspace-session');
                const request = transaction.objectStore('workspace-session').get('workspace-config:map');
                transaction.oncomplete = () => resolve(request.result?.config?.project?.robot?.armJointCouplingEnabled === enabled);
              }); } finally { db.close(); }
            }'''
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if page.evaluate(check, enabled):
                    return
                page.wait_for_timeout(100)
            raise AssertionError('coupling setting did not finish saving')

        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            open_menu()
            expect(toggle).to_have_attribute('aria-checked', 'true')
            expect(toggle).to_be_disabled()
            toggle_box = toggle.bounding_box()
            limits_box = page.get_by_label('关节软限位设置', exact=True).bounding_box()
            assert toggle_box['y'] >= limits_box['y'] + limits_box['height']
            menu.press('Escape')
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            open_menu()
            expect(toggle).to_be_enabled()
            expect(toggle).to_have_attribute('aria-checked', 'true')
            expect(page.locator('.robot-joint-coupling-settings')).to_contain_text('|J6 + J7| < 1.8 rad')
            page.screenshot(path=str(OUTPUT / 'menu-enabled.png'))
            toggle.focus(); toggle.press('Space')
            expect(toggle).to_have_attribute('aria-checked', 'false')
            expect(menu).to_have_attribute('aria-expanded', 'true')
            wait_saved(False)
            page.reload(wait_until='networkidle')
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            open_menu(); expect(toggle).to_have_attribute('aria-checked', 'false')
            toggle.press('Escape')

            # A small Cartesian request from an out-of-coupling wrist state
            # preserves that reachable branch while disabled; enabling the
            # switch makes the very next solve obey the joint sum bound.
            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            for name, value in [('left_J6', 40), ('left_J7', 80)]:
                field = page.get_by_role('spinbutton', name=name + ' 关节值', exact=True)
                field.fill(str(value)); field.press('Enter')
            page.get_by_role('button', name='最小化全关节浮动窗口', exact=True).click()
            viewer_tool(page, name='定位机器人模型', exact=True).click()
            for enabled in [False, True]:
                if enabled:
                    open_menu(); toggle.click()
                    expect(toggle).to_have_attribute('aria-checked', 'true')
                    toggle.press('Escape')
                double_click_tool(page, canvas, 'left')
                field = page.get_by_role('spinbutton', name='末端 X (m)', exact=True)
                field.fill(str(float(field.input_value()) + 0.001)); field.press('Tab')
                page.wait_for_function("['limited', 'tracking'].includes(document.querySelector('.three-canvas')?.dataset.endEffectorIkStatus)")
                values = json.loads(canvas.get_attribute('data-robot-joint-values'))
                total = abs(math.radians(values['left_J6'] + values['left_J7']))
                assert total < 1.8 if enabled else total > 1.8, (enabled, total)
                page.get_by_role('button', name='退出机械臂末端控制', exact=True).click()
            wait_saved(True)
            page.reload(wait_until='networkidle')
            page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
            open_menu(); expect(toggle).to_have_attribute('aria-checked', 'true')
            page.screenshot(path=str(OUTPUT / 'menu-restored.png'))
            assert not errors, errors
            print('PASS UI: menu order/default, keyboard switch, persistence off/on and live IK obeying the selected constraint')
        except Exception:
            page.screenshot(path=str(OUTPUT / 'failure.png'))
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
