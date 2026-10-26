"""Verify real-model endpoint animation, isolated editing, live bounds and project persistence."""
import json
import math
import os
from pathlib import Path
from xml.etree import ElementTree as ET

from playwright.sync_api import expect, sync_playwright
from archive_helpers import start_project_download, read_exported_project
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21994').rstrip('/')
OUTPUT = ROOT / 'test-artifacts/joint-limit-details'
WAIST = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J']
HARD = {node.get('name'): [math.degrees(float(node.find('limit').get(key))) for key in ['lower', 'upper']]
        for node in ET.parse(ROOT / 'robots/botx_abx_zivid_m70/urdf/botx_abx_zivid_m70.urdf').findall('joint')
        if node.get('name').startswith(('left_J', 'right_J')) or node.get('name') in WAIST}


def run():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
                                   or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        page = browser.new_page(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        canvas = page.locator('.three-canvas')
        dialog = page.get_by_role('dialog', name='关节软限位详细设置', exact=True)
        preview = page.locator('.joint-limit-preview__canvas')

        def live_values():
            return json.loads(canvas.get_attribute('data-robot-joint-values'))

        def open_settings():
            topbar_action(page, name='关节软限位详细设置', exact=True).click()
            expect(dialog).to_be_visible()
            expect(page.get_by_role('region', name='关节软限位动画预览')).to_have_attribute('data-status', 'ready', timeout=90000)
            expect(preview).to_have_attribute('data-ghost-count', '2')

        def set_number(label, value, commit=True):
            field = dialog.get_by_role('spinbutton', name=label, exact=True)
            field.fill(str(value))
            if commit:
                field.press('Enter')

        def number(label):
            return float(dialog.get_by_role('spinbutton', name=label, exact=True).input_value())

        def expect_number(label, value, tolerance=.002):
            page.wait_for_function('''([label, value, tolerance]) => {
                const input = [...document.querySelectorAll('.joint-limit-dialog input[type="number"]')].find(el => el.getAttribute('aria-label') === label);
                return input && Math.abs(Number(input.value) - value) < tolerance;
            }''', arg=[label, value, tolerance])

        def endpoint(key, angle):
            page.wait_for_function('''([key, value]) => Math.abs(Number(document.querySelector('.joint-limit-preview__canvas')?.dataset[key]) - value) < .002''', arg=[key, angle])

        def hard_angle(name, fraction):
            lower, upper = HARD[name]
            return lower + (upper - lower) * fraction

        def drag_thumb(label, target):
            slider = dialog.get_by_role('slider', name=label, exact=True)
            box = slider.bounding_box()
            fraction = float(slider.input_value()) / 100
            start = box['x'] + 8.5 + (box['width'] - 17) * fraction
            end = box['x'] + 8.5 + (box['width'] - 17) * target
            page.mouse.move(start, box['y'] + box['height'] / 2)
            page.mouse.down(); page.mouse.move(end, box['y'] + box['height'] / 2, steps=12); page.mouse.up()

        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            topbar_action(page, name='加载机器人', exact=True).click()
            page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=90000)
            before = live_values()
            open_settings()
            expect(dialog).to_contain_text('18 个可配置关节')
            assert dialog.locator('[data-joint-group="waist"] button').count() == 4
            for name in WAIST:
                dialog.get_by_role('button', name=f'设置 {name} 软限位', exact=True).click()
                expect(preview).to_have_attribute('data-joint', name)
                endpoint('lower', HARD[name][0]); endpoint('upper', HARD[name][1])
                expect_number('下限百分比', 0); expect_number('上限百分比', 100)
                expect(dialog).to_contain_text('默认 100%')
            dialog.get_by_role('button', name='设置 left_J1 软限位', exact=True).click()
            expect(preview).to_have_attribute('data-joint', 'left_J1')
            endpoint('lower', hard_angle('left_J1', .025)); endpoint('upper', hard_angle('left_J1', .975))
            page.wait_for_function('Number(document.querySelector(".joint-limit-preview__canvas").dataset.phase) > .4')
            page.screenshot(path=str(OUTPUT / 'animated-range.png'), full_page=True)
            dialog.get_by_role('button', name='暂停软限位预览').click()
            expect(preview).to_have_attribute('data-playing', 'false')
            angle = float(preview.get_attribute('data-angle'))
            page.wait_for_timeout(400)
            assert float(preview.get_attribute('data-angle')) == angle
            dialog.get_by_role('button', name='播放软限位预览').click()
            page.wait_for_function('(angle) => Math.abs(Number(document.querySelector(".joint-limit-preview__canvas").dataset.angle) - angle) > 5', arg=angle)
            assert live_values() == before, 'animation must never move the workbench robot'

            set_number('下限角度', '', commit=False)
            assert dialog.get_by_role('spinbutton', name='下限角度').input_value() == ''
            set_number('下限角度', -60.5)
            endpoint('lower', -60.5)
            expect_number('下限百分比', (-60.5 - HARD['left_J1'][0]) / (HARD['left_J1'][1] - HARD['left_J1'][0]) * 100)
            set_number('上限百分比', 75)
            endpoint('upper', hard_angle('left_J1', .75))
            upper_slider = dialog.get_by_role('slider', name='软限位上限滑块', exact=True)
            lower_slider = dialog.get_by_role('slider', name='软限位下限滑块', exact=True)
            upper_slider.focus(); upper_slider.press('Home')
            expect_number('上限百分比', number('下限百分比') + 1)
            upper_slider.press('End'); lower_slider.focus(); lower_slider.press('End')
            expect_number('下限百分比', 99)
            lower_slider.press('Home')
            drag_thumb('软限位下限滑块', .2)
            drag_thumb('软限位上限滑块', .8)
            expect_number('下限百分比', 20, .3)
            expect_number('上限百分比', 80, .3)
            dialog.get_by_role('button', name='设置 right_J2 软限位').click()
            endpoint('lower', hard_angle('right_J2', .025))
            set_number('下限百分比', 20); set_number('上限百分比', 80)
            endpoint('lower', hard_angle('right_J2', .2)); endpoint('upper', hard_angle('right_J2', .8))
            set_number('统一软限位百分比', 80)
            endpoint('lower', hard_angle('right_J2', .2))
            for name in WAIST:
                dialog.get_by_role('button', name=f'设置 {name} 软限位', exact=True).click()
                endpoint('lower', HARD[name][0]); endpoint('upper', HARD[name][1])
            dialog.get_by_role('button', name='设置 left_J3 软限位').click()
            endpoint('lower', hard_angle('left_J3', .1)); endpoint('upper', hard_angle('left_J3', .9))
            assert live_values() == before, 'draft edits must stay in the preview'
            dialog.get_by_role('button', name='取消', exact=True).click()
            expect(dialog).to_be_hidden(); assert live_values() == before

            open_settings()
            assert number('统一软限位百分比') == 95
            set_number('下限角度', 30); set_number('上限百分比', 80)
            dialog.get_by_role('button', name='设置 right_J2 软限位').click()
            set_number('下限百分比', 20); set_number('上限百分比', 80)
            for name in WAIST:
                dialog.get_by_role('button', name=f'设置 {name} 软限位', exact=True).click()
                set_number('下限百分比', 10); set_number('上限百分比', 80)
                endpoint('lower', hard_angle(name, .1)); endpoint('upper', hard_angle(name, .8))
            page.wait_for_function('Number(document.querySelector(".joint-limit-preview__canvas").dataset.phase) > .15')
            page.screenshot(path=str(OUTPUT / 'waist-range.png'), full_page=True)
            set_number('统一软限位百分比', 80, commit=False)
            dialog.get_by_role('button', name='应用设置', exact=True).click()
            expect(dialog).to_be_hidden()
            page.wait_for_function('''() => {
                const v = JSON.parse(document.querySelector('.three-canvas').dataset.robotJointValues);
                return Math.abs(v.left_J1 - 30) < .002 && Math.abs(v.right_J2 - 28.8) < .002;
            }''')
            after = live_values()
            for name in WAIST:
                assert hard_angle(name, .1) - .001 <= after[name] <= hard_angle(name, .8) + .001
            page.get_by_role('tab', name='示教', exact=True).click()
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            for name, expected in [('left_J1', 30), ('right_J2', hard_angle('right_J2', .2)), ('left_J3', hard_angle('left_J3', .1))] + [(name, hard_angle(name, .1)) for name in WAIST]:
                slider = page.get_by_role('slider', name=name + ' 关节滑块', exact=True)
                assert abs(float(slider.get_attribute('min')) - expected) < .002
            with page.expect_download() as download:
                start_project_download(page)
            project = read_exported_project(download.value)
            assert project['robot']['armSoftLimitRatio'] == .8
            saved = project['robot']['armSoftLimitOverrides']
            assert set(saved) == {'left_J1', 'right_J2', *WAIST}
            for name in WAIST:
                assert saved[name] == {'lower': .1, 'upper': .8}
            assert saved['right_J2'] == {'lower': .2, 'upper': .8}
            assert abs(saved['left_J1']['lower'] - (30 - HARD['left_J1'][0]) / (HARD['left_J1'][1] - HARD['left_J1'][0])) < 1e-8

            page.reload(wait_until='networkidle')
            expect(canvas).to_have_attribute('data-robot-model-state', 'loaded', timeout=90000)
            open_settings()
            assert number('统一软限位百分比') == 80
            endpoint('lower', 30)
            expect(dialog).to_contain_text('6 个关节已单独设置')
            dialog.get_by_role('button', name='设置 left_J3 软限位').click()
            dialog.get_by_role('spinbutton', name='下限角度').focus()
            dialog.get_by_role('spinbutton', name='上限角度').focus()
            expect(dialog).to_contain_text('6 个关节已单独设置')
            dialog.get_by_role('button', name='设置 left_J1 软限位').click()
            dialog.get_by_role('button', name='此关节恢复统一比例').click()
            endpoint('lower', hard_angle('left_J1', .1))
            expect(dialog).to_contain_text('5 个关节已单独设置')
            for name in WAIST:
                dialog.get_by_role('button', name=f'设置 {name} 软限位', exact=True).click()
                endpoint('lower', hard_angle(name, .1)); endpoint('upper', hard_angle(name, .8))
                dialog.get_by_role('button', name='此关节恢复 100%', exact=True).click()
                endpoint('lower', HARD[name][0]); endpoint('upper', HARD[name][1])
            expect(dialog).to_contain_text('1 个关节已单独设置')
            dialog.get_by_role('button', name='取消', exact=True).click()
            for name, value in after.items():
                assert abs(live_values()[name] - value) < 1e-6

            open_settings()
            page.set_viewport_size({'width': 780, 'height': 1024})
            dialog.get_by_role('button', name='设置 right_J2 软限位').click()
            page.screenshot(path=str(OUTPUT / 'tablet-settings.png'), full_page=True)
            assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            page.set_viewport_size({'width': 390, 'height': 844})
            dialog.get_by_role('spinbutton', name='下限角度').scroll_into_view_if_needed()
            assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            page.screenshot(path=str(OUTPUT / 'narrow-settings.png'), full_page=True)
            page.set_viewport_size({'width': 1500, 'height': 1000})
            dialog.get_by_role('button', name='全部恢复默认').click()
            expect(dialog).to_contain_text('所有关节使用默认范围')
            expect_number('统一软限位百分比', 95)
            dialog.get_by_role('button', name='应用设置', exact=True).click()
            expect(dialog).to_be_hidden()
            open_settings()
            assert number('下限百分比') == 2.5
            for name in WAIST:
                dialog.get_by_role('button', name=f'设置 {name} 软限位', exact=True).click()
                endpoint('lower', HARD[name][0]); endpoint('upper', HARD[name][1])
            preview.focus(); page.keyboard.press('Escape')
            expect(dialog).to_be_hidden()
            expect(page.locator('[data-workbench-menu-trigger="robot"]')).to_be_focused()
            page.locator('[data-workbench-menu-trigger="robot"]').click()
            percent = page.get_by_role('spinbutton', name='关节软限位百分比', exact=True)
            percent.fill('80.25'); percent.press('Enter')
            expect(percent).to_have_value('80.25')
            percent.focus(); page.get_by_role('slider', name='关节软限位比例滑块', exact=True).focus()
            expect(percent).to_have_value('80.25')
            page.get_by_role('button', name='关节软限位详细设置', exact=True).click()
            expect(dialog).to_be_visible()
            expect_number('统一软限位百分比', 80.25)
            dialog.get_by_role('button', name='取消', exact=True).click()
            assert not errors, errors
            print('PASS soft-limit details: 18 arm/waist joints, legacy defaults, actual robot/red-blue ghosts, loop/pause, numeric/dual sliders, cancellation isolation, live bounds, ZIP/reload, resets, keyboard and responsive layout')
        except Exception:
            page.screenshot(path=str(OUTPUT / 'failure.png'), full_page=True)
            print('Page errors:', errors)
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    run()
