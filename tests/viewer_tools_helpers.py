def open_viewer_tools(page):
    trigger = page.get_by_role("button", name="视图工具", exact=True)
    if trigger.count() and trigger.get_attribute("aria-expanded") != "true":
        trigger.click()


def viewer_tool(page, name, exact=True):
    open_viewer_tools(page)
    return page.get_by_role("button", name=name, exact=exact)


def display_settings_section(page, section):
    trigger = page.get_by_role('button', name='显示设置', exact=True)
    if trigger.get_attribute('aria-expanded') != 'true':
        trigger.click()
    panel = page.get_by_role('dialog', name='3D 显示设置', exact=True)
    heading = panel.get_by_role('button', name=section, exact=True)
    if heading.get_attribute('aria-expanded') != 'true':
        heading.click()
    return panel
