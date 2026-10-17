from playwright.sync_api import expect


def open_ipad_menu(page, section):
    trigger = page.get_by_role('button', name='iPad / Vision Pro', exact=True)
    if trigger.get_attribute('aria-expanded') != 'true':
        trigger.click()
    page.get_by_role('menuitem', name=section, exact=True).click()
    menu = page.get_by_role('menu', name=section, exact=True)
    expect(menu).to_be_visible()
    return menu


def open_ipad_dialog(page, action='扫码配对'):
    open_ipad_menu(page, '同步与接收').get_by_role('menuitem', name=action, exact=True).click()
    dialog = page.get_by_role('dialog', name='移动到 iPad 或 Vision Pro 上运行')
    expect(dialog).to_be_visible()
    return dialog


def select_teaching_source(page, label):
    open_ipad_menu(page, '示教来源').get_by_role('menuitemradio', name=label, exact=True).click()
