"""Interactive IK: soft limits, reference lifecycle and real pointer solve time."""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from end_effector_control_smoke import double_click_tool, load_robot, number_attr
from robot_drag_undo_smoke import assert_restored, drag, state
from viewer_tools_helpers import viewer_tool

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')


def set_target(page, canvas, axis, value):
    field = page.get_by_role('spinbutton', name=f'末端 {axis.upper()} (m)', exact=True)
    field.fill(f'{value:.8f}')
    field.press('Enter')
    try:
        page.wait_for_function('''([axis, value]) => Math.abs(Number(
            document.querySelector('.three-canvas').dataset['endEffectorTarget' + axis.toUpperCase()]) - value) < 2e-6''',
            arg=[axis, value])
    except Exception:
        print(json.dumps({'axis': axis, 'requested': value, 'field': field.input_value(),
            'state': canvas.evaluate('n => Object.fromEntries(Object.entries(n.dataset).filter(([k]) => /endEffector|robotJointApply/.test(k)))')}), flush=True)
        raise


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True,
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
            args=['--use-angle=metal', '--enable-gpu'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(30000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(BASE + '/workbench', wait_until='networkidle')
            page.locator('[data-session-state="ready"]').wait_for()
            page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/rotation-map.ply'))
            page.locator('.loading-curtain').wait_for(state='hidden')
            load_robot(page)
            canvas = page.locator('.three-canvas')
            viewer_tool(page, name='定位机器人模型').click()
            page.wait_for_timeout(400)

            # Numeric changes use the same live solve as pointer dragging. The
            # reference must survive React pose reports throughout the session.
            for percent, allowed_drift in [(95, 1), (80, 6)]:
                if percent != 95:
                    menu = page.locator('[data-workbench-menu-trigger="robot"]')
                    menu.click()
                    field = page.get_by_role('spinbutton', name='关节软限位百分比', exact=True)
                    field.fill(str(percent)); field.press('Enter')
                    menu.click()
                before = state(canvas)
                double_click_tool(page, canvas, 'left')
                expect(canvas).to_have_attribute('data-end-effector-control-state', 'active')
                origin = number_attr(canvas, 'end-effector-target-y')
                for i in list(range(1, 41)) + list(range(39, -1, -1)):
                    set_target(page, canvas, 'y', origin - 0.2 * i / 40)
                after = state(canvas)
                drift = max(abs(after['joints'][name] - value) for name, value in before['joints'].items())
                assert drift < allowed_drift, (percent, drift)
                assert number_attr(canvas, 'end-effector-position-error') < 0.0005
                print(f'{percent}% soft limits: live out-and-back joint drift {drift:.3f} degrees', flush=True)
                page.keyboard.press('Escape')
                assert_restored(canvas, before)

            double_click_tool(page, canvas, 'left')
            # Observe actual TransformControls events, including render work;
            # solve time is measured inside the solver, without timer polling.
            page.evaluate('''() => {
                window.ikSamples = [];
                window.ikObserver = new MutationObserver(records => {
                    if (!records.some(r => r.attributeName === 'data-end-effector-solve-count')) return;
                    const d = document.querySelector('.three-canvas').dataset;
                    window.ikSamples.push({ ms: Number(d.endEffectorIkSolveMs), iterations: Number(d.endEffectorIkIterations) });
                });
                window.ikObserver.observe(document.querySelector('.three-canvas'), { attributes: true });
            }''')
            initial = state(canvas)
            drag(page, canvas, dx=14, dy=-8)
            first = state(canvas)
            assert first['joints'] != initial['joints']
            page.keyboard.press('Control+z')
            assert_restored(canvas, initial, target=True)
            drag(page, canvas, dx=14, dy=-8)
            second = state(canvas)
            assert max(abs(second['joints'][key] - first['joints'][key]) for key in first['joints']) < 1e-5, 'undo must restore the posture reference as well as joint angles'
            samples = page.evaluate('''() => { window.ikObserver.disconnect(); return window.ikSamples; }''')
            assert len(samples) >= 16
            times = sorted(sample['ms'] for sample in samples)
            print(json.dumps({'pointer_solves': len(times), 'solve_p95_ms': times[int(len(times) * 0.95)], 'solve_max_ms': max(times)}), flush=True)
            page.screenshot(path='/tmp/atlas-interactive-ik.png', full_page=True)
            page.keyboard.press('Escape')

            # An explicit joint edit establishes a new reference and updates
            # the open gizmo. It must not pull the tool back to the old target.
            double_click_tool(page, canvas, 'left')
            page.get_by_role('button', name='打开全关节浮动窗口').click()
            joint = page.get_by_role('spinbutton', name='left_J3 关节值', exact=True)
            joint.fill('25'); joint.press('Enter')
            page.wait_for_function('''() => Math.abs(JSON.parse(
                document.querySelector('.three-canvas').dataset.robotJointValues).left_J3 - 25) < 1e-6''')
            edited = state(canvas)
            for axis in ['x', 'y', 'z']:
                assert abs(number_attr(canvas, f'end-effector-target-{axis}') - number_attr(canvas, f'robot-left-tool-world-{axis}')) < 2e-6
            origin = number_attr(canvas, 'end-effector-target-x')
            set_target(page, canvas, 'x', origin - 0.015)
            set_target(page, canvas, 'x', origin)
            assert abs(state(canvas)['joints']['left_J3'] - edited['joints']['left_J3']) < 2
            assert not errors, errors
            print('PASS: live references, configured limits, pointer replay after undo, manual-edit rebasing and Escape', flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    run()
