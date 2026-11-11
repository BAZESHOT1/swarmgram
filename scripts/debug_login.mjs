// Debug: state of login page, док-навигация
const fs = require('fs');
const script = `
(async () => {
  const out = [];
  try {
    const inputs = [...document.querySelectorAll('input')];
    out.push('inputs=' + inputs.length);
    const setV = (el, v) => { if (!el) { out.push('no-el'); return; } const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    setV(inputs[0], 'browseralice@example.com');
    setV(inputs[1], 'Browser12345!');
    await new Promise(r => setTimeout(r, 300));
    const btn = [...document.querySelectorAll('[role="button"]')].find(b => b.textContent.trim() === 'Войти');
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 3000));
    out.push('path=' + location.pathname);
    out.push('sessionin=' + Boolean(localStorage.getItem('sg:session')));
    const tabs = [...document.querySelectorAll('[role="tab"]')].map(e => e.getAttribute('aria-label'));
    out.push('tabs=' + JSON.stringify(tabs));
    const chatsTab = [...document.querySelectorAll('[role="tab"]')].find(e => e.getAttribute('aria-label') === 'Чаты');
    if (chatsTab) {
      chatsTab.click();
      await new Promise(r => setTimeout(r, 2000));
      out.push('after-click=' + location.pathname);
    }
    return JSON.stringify(out);
  } catch (e) {
    return 'EXC:' + e.message;
  }
})()
`;
const r = await tools.browser.evaluate({ tabID: process.argv[2] ?? "tab_82bfa704-6343-4ff3-8166-c5f05ebf93fb", script });
return r;
