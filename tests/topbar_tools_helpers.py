def topbar_action(page, name, exact=False):
    """Open the category containing an action, or use a visible page action."""
    action = page.get_by_role('button', name=name, exact=exact)
    if action.count() and not action.first.evaluate('(el) => Boolean(el.closest(".workbench-menu-panel"))'):
        return action
    for panel in page.locator('.workbench-menu-panel').all():
        menu_action = panel.get_by_role('button', name=name, exact=exact, include_hidden=True)
        if menu_action.count():
            section = panel.get_attribute('data-workbench-menu')
            trigger = page.locator(f'[data-workbench-menu-trigger="{section}"]')
            if trigger.get_attribute('aria-expanded') != 'true':
                trigger.click()
            return menu_action
    return action
