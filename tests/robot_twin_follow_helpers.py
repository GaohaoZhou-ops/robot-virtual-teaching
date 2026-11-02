def select_follow_mode(page, mode='BEV'):
    page.get_by_role('button', name='跟随视角', exact=True).click()
    page.get_by_role('dialog', name='选择跟随形态', exact=True).get_by_role('button', name=mode, exact=True).click()
