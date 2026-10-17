import os
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
            expect(toolbar.get_by_role('button')).to_have_count(3)
            expect(toolbar.get_by_role('button')).to_have_text(['工程', '示教', '设备'])
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

            topbar_action(page, '加载机器人', exact=True).click()
            robots = page.get_by_role('dialog', name='robots 目录模型', exact=True)
            expect(robots).to_be_visible()
            expect(page.locator('.workbench-menu-panel:visible')).to_have_count(0)
            page.wait_for_function('''() => {
                const menu = document.querySelector('.robot-picker__menu').getBoundingClientRect();
                const trigger = document.querySelector('[data-workbench-menu-trigger="devices"]').getBoundingClientRect();
                return Math.abs(menu.top - trigger.bottom - 8) < 2;
            }''')
            page.keyboard.press('Escape')
            expect(robots).to_have_count(0)
            expect(toolbar.get_by_role('button', name='设备菜单')).to_be_focused()

            if mode == 'independent':
                topbar_action(page, 'iPad / Vision Pro', exact=True).click()
                mobile = page.get_by_role('menu', name='iPad / Vision Pro', exact=True)
                expect(mobile).to_be_visible()
                expect(page.locator('.workbench-menu-panel:visible')).to_have_count(0)
                page.keyboard.press('ArrowDown')
                expect(mobile.get_by_role('menuitem', name='示教来源')).to_be_focused()
                page.keyboard.press('ArrowRight')
                expect(page.get_by_role('menuitemradio', name='查看独立示教')).to_be_focused()
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')
                expect(mobile).to_have_count(0)
                expect(toolbar.get_by_role('button', name='设备菜单')).to_be_focused()

            for width in (1440, 1024, 680, 390):
                page.set_viewport_size({'width': width, 'height': 900})
                for label in ('工程', '示教', '设备'):
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
                    page.screenshot(path=f'/tmp/atlas-toolbar-{mode}-{width}-{label}.png', full_page=True)
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
