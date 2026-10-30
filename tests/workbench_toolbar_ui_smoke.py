import json
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from dual_teaching_workspace_smoke import BASE_URL, create_project, wait_for_home
from topbar_tools_helpers import topbar_action


def run():
    chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or (str(chrome) if chrome.exists() else None)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=executable)
        for mode in ('map', 'independent'):
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(BASE_URL, wait_until='networkidle')
            wait_for_home(page)
            create_project(page, mode)
            toolbar = page.get_by_role('navigation', name='工作台工具栏', exact=True)
            expect(toolbar.locator('[data-workbench-menu-trigger]')).to_have_count(4)
            expect(toolbar.locator('[data-workbench-menu-trigger]')).to_have_text(['工程', '示教', '机器人', '设备'])
            expect(page.locator('.map-identity small')).to_contain_text('独立示教' if mode == 'independent' else '地图示教')
            page.evaluate('window.__toolbarController = document.querySelector(".spacemouse-control")')

            project = toolbar.get_by_role('button', name='工程菜单')
            project.focus()
            page.keyboard.press('ArrowDown')
            project_menu = page.get_by_role('dialog', name='工程菜单', exact=True)
            expect(project_menu.get_by_role('button', name='查看地图与工程配置')).to_be_focused()
            page.keyboard.press('End')
            expect(project_menu.get_by_role('button', name='另存为工程')).to_be_focused()
            page.keyboard.press('ArrowRight')
            expect(project_menu).to_have_count(0)
            teaching_menu = page.get_by_role('dialog', name='示教菜单', exact=True)
            expect(teaching_menu).to_be_visible()
            page.keyboard.press('Escape')
            expect(toolbar.get_by_role('button', name='示教菜单')).to_be_focused()
            expect(page.locator('.workbench-menu-panel:visible')).to_have_count(0)

            topbar_action(page, '查看地图与工程配置').click()
            details = page.get_by_role('dialog', name='地图与工程配置', exact=True)
            expect(details).to_be_visible()
            expect(page.locator('.workbench-menu-panel:visible')).to_have_count(0)
            page.keyboard.press('Escape')
            expect(details).to_have_count(0)
            expect(project).to_be_focused()

            robot_trigger = topbar_action(page, '加载机器人', exact=True)
            robot_trigger.hover()
            robots = page.get_by_role('dialog', name='robots 目录模型', exact=True)
            robot_menu = page.get_by_role('dialog', name='机器人菜单', exact=True)
            expect(robots).to_be_visible()
            expect(robot_menu).to_be_visible()
            expect(robot_trigger).to_have_attribute('aria-expanded', 'true')
            page.wait_for_function('''() => {
                const menu = document.querySelector('.robot-picker__menu').getBoundingClientRect();
                const parent = document.querySelector('[data-workbench-menu="robot"]').getBoundingClientRect();
                return menu.right <= parent.left || menu.left >= parent.right;
            }''')
            # Crossing the gap and using controls must keep both menu levels open.
            robots.hover()
            robots.get_by_role('button', name='刷新机器人列表').click()
            expect(robots).to_be_visible()
            expect(robot_menu).to_be_visible()
            page.keyboard.press('Escape')
            expect(robots).to_have_count(0)
            expect(robot_trigger).to_be_focused()
            page.keyboard.press('ArrowRight')
            expect(robots.get_by_role('button', name='刷新机器人列表')).to_be_focused()
            page.keyboard.press('ArrowLeft')
            expect(robots).to_have_count(0)
            expect(robot_trigger).to_be_focused()
            robot_trigger.hover()
            robot_menu.get_by_role('button', name='新建预设姿态', exact=True).hover()
            expect(robots).to_have_count(0)
            robot_trigger.click()
            expect(robots).to_be_visible()
            page.locator('.brand-block').click()
            expect(robots).to_have_count(0)
            expect(robot_menu).to_have_count(0)
            topbar_action(page, '加载机器人', exact=True).hover()
            page.keyboard.press('Escape')
            expect(robots).to_have_count(0)
            expect(robot_trigger).to_be_focused()
            page.keyboard.press('Escape')
            expect(toolbar.get_by_role('button', name='机器人菜单')).to_be_focused()

            if mode == 'independent':
                for device in ('iPad / iPhone', 'Vision Pro'):
                    topbar_action(page, device, exact=True).click()
                    mobile = page.get_by_role('menu', name=device, exact=True)
                    expect(mobile).to_be_visible()
                    devices = page.get_by_role('dialog', name='设备菜单', exact=True)
                    expect(devices).to_be_visible()
                    expect(devices.get_by_role('button', name=device, exact=True)).to_have_attribute('aria-expanded', 'true')
                    page.keyboard.press('Home')
                    expect(mobile.get_by_role('menuitem', name='画面协作' if device == 'iPad / iPhone' else '完整工程空间查看')).to_be_focused()
                    page.keyboard.press('ArrowDown')
                    expect(mobile.get_by_role('menuitem', name='示教来源')).to_be_focused()
                    page.keyboard.press('ArrowRight')
                    expect(page.get_by_role('menuitemradio', name='查看独立示教')).to_be_focused()
                    expect(devices).to_be_visible()
                    parent_box, child_box = devices.bounding_box(), mobile.bounding_box()
                    assert child_box['x'] + child_box['width'] <= parent_box['x'] or child_box['x'] >= parent_box['x'] + parent_box['width']
                    page.keyboard.press('Escape')
                    page.keyboard.press('Escape')
                    expect(mobile).to_have_count(0)
                    expect(devices.get_by_role('button', name=device, exact=True)).to_be_focused()
                    page.keyboard.press('Escape')
                    expect(toolbar.get_by_role('button', name='设备菜单')).to_be_focused()

                # Pairing failures still retain the selected device and its recovery path.
                # Intercept LAN calls so this UI check cannot create a real transfer.
                page.route('**/__atlas/ipad/**', lambda route: route.fulfill(
                    status=503, content_type='application/json', body='{"error":"测试：局域网暂不可用"}'))
                for device, action, title, retry in (
                    ('Vision Pro', '配对 Vision Pro', 'Vision Pro 空间示教', '重试准备配对信息'),
                    ('iPad / iPhone', '扫码配对', 'iPad / iPhone 示教', '重试生成二维码'),
                ):
                    topbar_action(page, device, exact=True).click()
                    page.get_by_role('menuitem', name='同步与接收', exact=True).click()
                    sync_menu = page.get_by_role('menu', name='同步与接收', exact=True)
                    expect(sync_menu.get_by_role('menuitem', name='导入结果文件')).to_have_count(0 if device == 'Vision Pro' else 1)
                    sync_menu.get_by_role('menuitem', name=action, exact=True).click()
                    dialog = page.get_by_role('dialog', name=title, exact=True)
                    expect(dialog).to_be_visible()
                    expect(dialog.get_by_role('alert')).to_contain_text('局域网暂不可用')
                    expect(dialog.get_by_role('button', name=retry, exact=True)).to_be_enabled()
                    if device != 'Vision Pro':
                        dialog.get_by_role('tab', name='文件导入').click()
                    expect(dialog.get_by_role('button', name='导入结果文件')).to_have_count(0 if device == 'Vision Pro' else 1)
                    dialog.get_by_role('button', name='关闭设备示教窗口').click()
                    expect(toolbar.get_by_role('button', name='设备菜单')).to_be_focused()

                ticket, requests = {}, []

                def pairing_service(route):
                    path = route.request.url.split('/__atlas/ipad', 1)[1]
                    requests.append((route.request.method, path))
                    if path == '/info':
                        result = {'addresses': ['http://192.168.1.20:21990']}
                    elif path == '/sessions' and route.request.method == 'POST':
                        ticket.update(id='vision-ui-transfer', ownerToken='ui-only', status='preparing',
                                      manifest=route.request.post_data_json['manifest'],
                                      createdAt='2026-01-01T00:00:00Z', pairingCode='V123',
                                      pairingExpiresAt=int(time.time() * 1000) + 600000)
                        result = ticket
                    elif path.endswith('/model'):
                        ticket['status'] = 'ready'
                        result = ticket
                    elif path.endswith('/renew'):
                        ticket['pairingCode'] = 'V456'
                        result = ticket
                    elif path == '/sessions/vision-ui-transfer/vision-pairing' and route.request.method in ('POST', 'DELETE'):
                        result = {'published': route.request.method == 'POST'}
                    elif path == '/sessions/vision-ui-transfer':
                        result = ticket
                    else:
                        raise AssertionError(f'Unexpected pairing request: {path}')
                    route.fulfill(content_type='application/json', body=json.dumps(result))

                page.unroute('**/__atlas/ipad/**')
                page.route('**/__atlas/ipad/**', pairing_service)
                for opening in range(2):
                    topbar_action(page, 'Vision Pro', exact=True).click()
                    page.get_by_role('menuitem', name='同步与接收', exact=True).click()
                    page.get_by_role('menuitem', name='配对 Vision Pro', exact=True).click()
                    dialog = page.get_by_role('dialog', name='Vision Pro 空间示教', exact=True)
                    expect(dialog.locator('.ipad-code')).to_have_text('V123' if opening == 0 else 'V456')
                    expect(dialog).to_contain_text('自动检测局域网服务器')
                    expect(dialog.get_by_role('img', name='设备配对二维码')).to_have_count(0)
                    expect(dialog.get_by_role('button', name='导入结果文件')).to_have_count(0)
                    expect(dialog.get_by_role('alert')).to_have_count(0)
                    expect(dialog.locator('.ipad-history option')).to_have_count(2)
                    if opening == 0:
                        dialog.get_by_role('button', name='更新配对码', exact=True).click()
                        expect(dialog.locator('.ipad-code')).to_have_text('V456')
                        page.screenshot(path='/tmp/atlas-vision-pairing.png', full_page=True)
                    dialog.get_by_role('button', name='关闭设备示教窗口').click()
                    if opening == 0:
                        # A newer iPad transfer for the same model must neither be reused nor listed here.
                        page.evaluate('''() => {
                            const saved = JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'));
                            const ipad = {...saved[0], id: 'ipad-ui-transfer', targetDevice: 'ipad',
                                deviceName: 'iPad Pro', status: 'imported', createdAt: new Date().toISOString(),
                                manifest: {...saved[0].manifest, name: 'iPad 历史传输'}};
                            localStorage.setItem('atlas-ipad-handoffs-v1', JSON.stringify([ipad, ...saved]));
                        }''')
                assert requests.count(('POST', '/sessions')) == 1, 'reopening must reuse the existing transfer'
                assert not any(path.endswith('/pairing-qr') for _, path in requests), 'Vision Pro pairs without scanning'
                for device, transfer_id, excluded_id in (
                    ('Vision Pro', 'vision-ui-transfer', 'ipad-ui-transfer'),
                    ('iPad / iPhone', 'ipad-ui-transfer', 'vision-ui-transfer'),
                ):
                    topbar_action(page, device, exact=True).click()
                    page.get_by_role('menuitem', name='传输任务', exact=True).click()
                    history = page.get_by_role('menu', name='传输任务', exact=True)
                    expect(history.locator(f'[data-transfer-id="{transfer_id}"]')).to_be_visible()
                    expect(history.locator(f'[data-transfer-id="{excluded_id}"]')).to_have_count(0)
                    page.keyboard.press('Escape')
                    page.keyboard.press('Escape')

            for width in (1440, 1024, 680, 390):
                page.set_viewport_size({'width': width, 'height': 900})
                for label in ('工程', '示教', '机器人', '设备'):
                    trigger = toolbar.get_by_role('button', name=f'{label}菜单')
                    trigger.click()
                    panel = page.get_by_role('dialog', name=f'{label}菜单', exact=True)
                    expect(panel).to_be_visible()
                    expect(page.locator('.workbench-menu-panel:visible')).to_have_count(1)
                    assert panel.evaluate('''(el) => {
                        const r = el.getBoundingClientRect();
                        return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
                    }''')
                    assert trigger.evaluate('(el) => el.getBoundingClientRect().right <= innerWidth')
                    if label == '机器人':
                        panel.get_by_role('button', name='加载机器人', exact=True).hover()
                        expect(robots).to_be_visible()
                        robots.evaluate('el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})))')
                        assert robots.evaluate('''el => {
                            const r = el.getBoundingClientRect();
                            return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
                        }''')
                    page.screenshot(path=f'/tmp/atlas-toolbar-{mode}-{width}-{label}.png', full_page=True)
                    if label == '机器人':
                        page.keyboard.press('Escape')
                    page.keyboard.press('Escape')
            page.set_viewport_size({'width': 1440, 'height': 900})
            project.click()
            page.locator('.brand-block').click()
            expect(page.locator('.workbench-menu-panel:visible')).to_have_count(0)
            assert page.evaluate('window.__toolbarController === document.querySelector(".spacemouse-control")')
            topbar_action(page, '打开示教数据管理页').click()
            expect(page.locator('[data-app-page="teaching-data"]')).to_be_visible()
            expect(page.locator('.workbench-menu-panel:visible')).to_have_count(0)
            context.close()
            print(f'{mode}_toolbar_navigation_keyboard_responsive_and_devices=ok', flush=True)
        assert not errors, errors
        browser.close()


if __name__ == '__main__':
    run()
