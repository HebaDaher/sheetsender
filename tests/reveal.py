"""Do what a person does before using something on a page: if it sits in another part of the
page (sub-menu: People / Upload files / ...), click that sub-menu item; if it sits inside a closed
Preview or Help, open it. Then the normal Playwright action runs."""
JS = """el => {
  const part = el.closest('[data-part]');
  if (part && part.classList.contains('hidden')) {
    const b = document.querySelector('.subnav [data-sub="' + part.getAttribute('data-part') + '"]');
    if (b) b.click();
  }
  const sum = el.closest('summary');  // clicking a summary itself opens/closes it: leave that one alone
  const from = sum ? sum.parentElement.parentElement : el.parentElement;
  let d = from && from.closest('details');
  while (d) { if (!d.open) d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
}"""
NAMES = ['click', 'fill', 'select_option', 'wait_for_selector', 'inner_text', 'input_value', 'get_attribute', 'eval_on_selector', 'check', 'set_input_files']

def patch(page):
    orig = {n: getattr(page, n) for n in NAMES}
    def make(n):
        def f(sel, *a, **k):
            if not (n == 'wait_for_selector' and k.get('state') in ('detached', 'hidden')):
                try:
                    orig['wait_for_selector'](sel, state='attached', timeout=k.get('timeout', 30000))
                    page.locator(sel).first.evaluate(JS)
                except Exception:
                    pass
            return orig[n](sel, *a, **k)
        return f
    for n in NAMES:
        setattr(page, n, make(n))
    return page
