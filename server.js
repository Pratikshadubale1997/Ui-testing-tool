const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.error('Puppeteer not installed. Run: npm install');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname), { index: false }));

let browser;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

// ─── ANALYSIS RULES (run inside page context) ──────────────────────────────

// ─── HELPER: Navigate to SPA page reliably ────────────────────────────
async function navigateToPage(page, url, timeout = 30000, credentials = null) {
  const startUrl = url;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

  // Wait for SPA redirects/auth checks to settle (up to 15s)
  let lastUrl = '';
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const curUrl = page.url();
    if (curUrl === lastUrl) break;
    lastUrl = curUrl;
  }

  // Wait for network to settle
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
  } catch (e) {}

  // Generic SPA content wait: many Vue/React/Angular SPAs render content
  // AFTER network idle, via JavaScript. Wait for actual DOM content to appear.
  try {
    await page.waitForFunction(() => {
      const text = (document.body?.innerText || '').trim();
      // Page has meaningful content if body text > 50 chars or has rendered elements
      return text.length > 50 ||
             document.querySelectorAll('h1, h2, h3, h4, a, button, nav, main, section, article, [class*="card"], [class*="app"]').length > 5;
    }, { timeout: 15000 });
  } catch (e) {
    console.log(`  [WARN] SPA content did not render within 15s, proceeding anyway`);
  }

  // Extra wait for SPAs that lazy-load after initial render
  await page.waitForTimeout(2000);

  // If the page still looks blank, try waiting longer (some SPAs are slow)
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim());
  if (bodyText.length < 30) {
    console.log(`  [INFO] Page body has minimal content (${bodyText.length} chars), waiting extra 5s...`);
    await page.waitForTimeout(5000);
  }

  let loginAttempted = false;
  let loginSucceeded = false;

  // Wait for SPA to render (some SPAs render login form on root URL, not /login)
  if (credentials) {
    try {
      await page.waitForFunction(() => {
        return document.querySelector('input[type="password"]') !== null ||
               document.querySelectorAll('h1, h2, h3, a, button, table').length > 5;
      }, { timeout: 15000 });
    } catch (e) {}
    await page.waitForTimeout(2000);
  }

  // If credentials provided, always try to find and fill login form
  if (credentials) {
    const hasPasswordField = await hasVisiblePasswordField(page);
    if (hasPasswordField) {
      loginAttempted = true;
      console.log(`  [INFO] Password field found, attempting login...`);
      const urlBeforeLogin = page.url();
      try {
        const loggedIn = await attemptLogin(page, credentials);
        if (loggedIn) console.log(`  [INFO] Login successful. Current URL: ${page.url()}`);
        else console.log(`  [WARN] Login form filled but may not have succeeded`);

        // Wait for SPA to redirect after login (up to 15s)
        if (loggedIn) {
          const loginUrl = page.url();
          for (let i = 0; i < 15; i++) {
            await page.waitForTimeout(1000);
            if (page.url() !== loginUrl) {
              console.log(`  [INFO] Redirected to: ${page.url()}`);
              break;
            }
          }
          // Wait for content to render after redirect
          try {
            await page.waitForFunction(() => {
              const text = document.body?.innerText || '';
              return text.length > 50 || document.querySelectorAll('h1, h2, a, button, table').length > 5;
            }, { timeout: 15000 });
          } catch (e) {}
          await page.waitForTimeout(2000);
        }

        // Check if login succeeded
        const urlChanged = page.url() !== urlBeforeLogin;
        const noLoginForm = !(await hasVisiblePasswordField(page));
        loginSucceeded = urlChanged || noLoginForm;
        console.log(`  [INFO] Login check: urlChanged=${urlChanged}, noLoginForm=${noLoginForm}`);
      } catch (e) {
        console.log(`  [WARN] Login attempt failed: ${e.message}`);
      }
    } else {
      console.log(`  [INFO] No password field found, page may not need login`);
    }
  }

  return { loginAttempted, loginSucceeded };

  // Wait for actual page content to render (for SPAs that lazy-load)
  if (!page.url().includes('/login')) {
    try {
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return text.length > 50 || document.querySelectorAll('h1, h2, a, button, table').length > 5;
      }, { timeout: 15000 });
    } catch (e) {}
  }

  await page.waitForTimeout(2000);
}

// Detects whether the current page is a login/authentication page.
// Uses multiple heuristics: URL path, nearby heading text, and form structure.
async function isLoginPage(page) {
  const result = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    // 0) Detect known external OAuth / identity providers that we cannot handle
    const hostname = (location.hostname || '').toLowerCase();
    const href = (location.href || '').toLowerCase();
    const externalAuthHosts = [
      'accounts.google.com', 'login.microsoftonline.com', 'login.yahoo.com',
      'github.com/login', 'gitlab.com/users/sign_in', 'id.apple.com',
      'facebook.com/login', 'twitter.com/login', 'x.com/login',
      'linkedin.com/login', 'auth0.com', 'okta.com', 'onelogin.com',
      'cognito-idp', 'keycloak', 'identityprovider'
    ];
    for (const h of externalAuthHosts) {
      if (hostname.includes(h) || href.includes(h)) {
        return { match: true, reason: 'External OAuth provider detected: ' + hostname + ' (' + h + ')' };
      }
    }

    const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (!pw) return { match: false, reason: 'no visible password field' };

    // 1) URL pathname strongly suggests login
    const urlPath = (location.pathname || '').toLowerCase();
    if (/(\/login|\/log-in|\/signin|\/sign-in|\/auth)/.test(urlPath)) {
      return { match: true, reason: 'URL path contains login keyword: ' + urlPath };
    }

    // 2) Check the nearest form-like container
    const form = pw.closest('form') || pw.closest('[role="form"]') || pw.parentElement?.parentElement;
    if (!form) return { match: false, reason: 'password field has no parent container' };

    // Count visible inputs in this form — login forms are small (1-3 fields)
    const formInputs = Array.from(form.querySelectorAll('input, textarea, select')).filter(isVisible);
    const nonHidden = formInputs.filter(el => el.type !== 'hidden' && el.type !== 'submit');
    const formText = (form.innerText || '').toLowerCase();

    // 3) Form text explicitly says sign in / log in
    if (/\b(sign\s*in|log\s*in|login|authenticate|welcome\s*back|enter\s*your)\b/.test(formText)) {
      return { match: true, reason: 'form contains login text' };
    }

    // 4) Form has a submit button with login text
    const btns = Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]')).filter(isVisible);
    const loginBtnTexts = ['log in', 'login', 'sign in', 'signin', 'let me in', 'sign on', 'logon'];
    for (const b of btns) {
      const t = ((b.textContent || b.value || '') + '').toLowerCase().trim();
      if (loginBtnTexts.some(h => t === h || t.includes(h))) {
        return { match: true, reason: 'form has login button: "' + t + '"' };
      }
    }

    // 5) Small form (≤3 inputs) with password field and a submit-like button — likely login
    if (nonHidden.length <= 3 && btns.length > 0) {
      // Extra check: no textarea/select (search forms may have these)
      if (form.querySelectorAll('textarea, select').length === 0) {
        // Check if heading nearby says something auth-related
        const heading = form.querySelector('h1, h2, h3, h4, h5, h6, legend, [class*="title"], [class*="heading"]');
        const headingText = heading ? (heading.textContent || '').toLowerCase() : '';
        if (/\b(sign|log|in|auth|welcome|password|account|access)\b/.test(headingText)) {
          return { match: true, reason: 'small form with auth-related heading: "' + headingText.trim() + '"' };
        }
        // Even without heading, small form with password + button in a SPA is likely login
        return { match: true, reason: 'small form (' + nonHidden.length + ' fields) with password + button — likely login' };
      }
    }

    return { match: false, reason: 'password field found but no login indicators (inputs=' + nonHidden.length + ', btns=' + btns.length + ')' };
  });

  console.log(`  [isLoginPage] URL: ${page.url().split('?')[0]} → ${result.match ? 'LOGIN' : 'NOT login'} (${result.reason})`);
  return result.match;
}

// Whether a visible password field is currently present (i.e. a login form is shown).
async function hasVisiblePasswordField(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="password"]')).some(el => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
  });
}

// Fills the login form with the given credentials and submits it.
// Returns true only if the login form disappears (login succeeded).
async function attemptLogin(page, credentials) {
  const found = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const mkSel = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name.replace(/"/g, '\\"') + '"]';
      return null;
    };
    const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    const allInputs = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);
    const nonPw = allInputs.filter(el => el.type !== 'password');
    const hintRe = /(email|user|login|account|name|phone|mobile|id)/i;
    const user = nonPw.find(el => hintRe.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '')))
      || nonPw.find(el => el.type === 'text' || el.type === 'email' || !el.type)
      || nonPw[0];
    if (!pw || !user) return null;
    return {
      userSel: mkSel(user) || user.tagName.toLowerCase(),
      pwSel: mkSel(pw) || 'input[type="password"]',
    };
  });

  if (!found) {
    console.log(`  [WARN] Could not find login form fields on page`);
    return false;
  }

  try {
    await page.click(found.userSel, { clickCount: 3 });
    await page.type(found.userSel, credentials.username, { delay: 30 });
  } catch (e) {
    try { await page.type(found.userSel, credentials.username, { delay: 30 }); } catch (e2) { return false; }
  }
  try {
    await page.type(found.pwSel, credentials.password, { delay: 30 });
  } catch (e) {
    return false;
  }

  // Submit the form
  const submitted = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const textHints = ['log in', 'login', 'sign in', 'signin', 'submit', 'continue', 'enter', 'next', 'let me in', 'sign on', 'logon'];
    const form = document.querySelector('input[type="password"]') ? document.querySelector('input[type="password"]').closest('form') : null;
    // 1) submit button inside the login form
    if (form) {
      const fb = form.querySelector('button[type="submit"], input[type="submit"], button');
      if (fb && isVisible(fb)) { fb.click(); return true; }
    }
    // 2) any visible button/input with login-ish text
    const all = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')).filter(isVisible);
    for (const el of all) {
      const t = ((el.textContent || el.value || '') + '').toLowerCase().trim();
      if (textHints.some(h => t.includes(h))) { el.click(); return true; }
    }
    // 3) any visible submit button
    const anySubmit = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]')).find(isVisible);
    if (anySubmit) { anySubmit.click(); return true; }
    return false;
  });

  if (!submitted) {
    // Fallback: press Enter inside the password field (native form submission)
    try { await page.keyboard.press('Enter'); } catch (e) {}
  }

  // Wait until the login form disappears (up to ~20s)
  let loggedIn = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    try {
      if (!(await hasVisiblePasswordField(page))) { loggedIn = true; break; }
      // SPA logins often change the URL; short-circuit if we left the login page
      const url = page.url().toLowerCase();
      if (!/(login|log-in|signin|sign-in)/.test(url)) {
        await page.waitForTimeout(1000);
        if (!(await hasVisiblePasswordField(page))) { loggedIn = true; break; }
      }
    } catch (e) {
      // Page might be navigating (context destroyed) - wait for it to settle
      try { await page.waitForTimeout(3000); } catch (e2) {}
      try {
        if (!(await hasVisiblePasswordField(page))) { loggedIn = true; break; }
      } catch (e3) { continue; }
    }
  }

  try {
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 });
  } catch (e) {}
  return loggedIn;
}

const ANALYSIS_SCRIPT = `
(() => {
  const issues = [];
  let issueId = 0;

  function getUniqueSelector(el) {
    if (!el) return 'unknown';
    if (el.id) return '#' + el.id;
    let path = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { path.unshift('#' + cur.id); break; }
      if (cur.className && typeof cur.className === 'string') {
        const classes = cur.className.trim().split(/\\s+/).filter(c => !c.startsWith('issue-')).slice(0, 2);
        if (classes.length) sel += '.' + classes.join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          sel += ':nth-child(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      path.unshift(sel);
      cur = cur.parentElement;
      if (path.length > 3) break;
    }
    return path.join(' > ');
  }

  function getCardName(el) {
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/)[0];
      if (cls) return cls;
    }
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 30);
    const txt = el.textContent.trim();
    if (txt && txt.length < 30) return txt;
    return el.tagName.toLowerCase();
  }

  function getStyles(el) {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      fontFamily: s.fontFamily,
      color: s.color,
      backgroundColor: s.backgroundColor,
      padding: s.padding,
      paddingTop: s.paddingTop,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
      paddingRight: s.paddingRight,
      margin: s.margin,
      marginTop: s.marginTop,
      marginRight: s.marginRight,
      marginBottom: s.marginBottom,
      marginLeft: s.marginLeft,
      border: s.border,
      borderRadius: s.borderRadius,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      textTransform: s.textTransform,
      width: s.width,
      height: s.height,
      minHeight: s.minHeight,
      display: s.display,
    };
  }

  function addIssue(ruleId, name, severity, category, el, detail, suggestion, fixCss, context) {
    let bbox = null;
    try {
      // Page-relative coords so the box lines up with the full-page screenshot.
      // If the element itself has no size (hidden/not rendered), fall back to the
      // nearest visible ancestor so the issue can still be located in the screenshot.
      let node = el;
      let r = node.getBoundingClientRect();
      while (node && node.nodeType === 1 && (r.width < 1 || r.height < 1)) {
        node = node.parentElement;
        r = node ? node.getBoundingClientRect() : r;
      }
      if (r.width >= 1 && r.height >= 1) {
        bbox = {
          x: r.x + window.scrollX,
          y: r.y + window.scrollY,
          width: r.width,
          height: r.height,
        };
      }
    } catch (e) {}
    let elText = '';
    try { elText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60); } catch (e2) {}
    issues.push({
      id: 'issue-' + (issueId++),
      ruleId,
      name,
      severity,
      category,
      selector: getUniqueSelector(el),
      detail,
      recommendation: suggestion,
      fixCss,
      context,
      elText,
      bbox,
    });
  }

  function compareGroup(elements, groupName, ruleId, checkFn) {
    if (elements.length < 2) return;

    const signatures = {};
    elements.forEach(el => {
      const key = checkFn(el);
      if (!signatures[key]) signatures[key] = [];
      signatures[key].push(el);
    });

    const keys = Object.keys(signatures);
    if (keys.length <= 1) return;

    const largest = keys.reduce((a, b) => signatures[a].length >= signatures[b].length ? a : b);
    keys.forEach(key => {
      if (key === largest) return;
      signatures[key].forEach(el => {
        const mainEl = signatures[largest][0];
        const diff = getStyleDiff(groupName, mainEl, el);
        addIssue(
          ruleId,
          'Inconsistent ' + groupName,
          groupName.includes('input') || groupName.includes('button') ? 'medium' : 'low',
          'ui-consistency',
          el,
          diff,
          'Make this element consistent with other ' + groupName + ' elements on the page.'
        );
      });
    });
  }

  function getStyleDiff(groupName, main, other) {
    const ms = getStyles(main);
    const os = getStyles(other);
    const diffs = [];
    if (ms.fontSize !== os.fontSize) diffs.push('font-size: ' + ms.fontSize + ' vs ' + os.fontSize);
    if (ms.fontWeight !== os.fontWeight) diffs.push('font-weight: ' + ms.fontWeight + ' vs ' + os.fontWeight);
    if (ms.fontFamily !== os.fontFamily) diffs.push('font-family differs');
    if (ms.color !== os.color) diffs.push('color: ' + ms.color + ' vs ' + os.color);
    if (ms.backgroundColor !== os.backgroundColor) diffs.push('background: ' + ms.backgroundColor + ' vs ' + os.backgroundColor);
    if (ms.padding !== os.padding) diffs.push('padding: ' + ms.padding + ' vs ' + os.padding);
    if (ms.borderRadius !== os.borderRadius) diffs.push('border-radius: ' + ms.borderRadius + ' vs ' + os.borderRadius);
    if (ms.border !== os.border) diffs.push('border: ' + ms.border + ' vs ' + os.border);
    if (ms.lineHeight !== os.lineHeight) diffs.push('line-height: ' + ms.lineHeight + ' vs ' + os.lineHeight);
    if (ms.minHeight !== os.minHeight) diffs.push('min-height: ' + ms.minHeight + ' vs ' + os.minHeight);
    return diffs.join('; ') || 'style mismatch';
  }

  // ─── 1. INCONSISTENT TEXT SIZES ──────────────────────────────────────
  // Group headings by level
  ['h1','h2','h3','h4','h5','h6'].forEach(tag => {
    const els = Array.from(document.querySelectorAll(tag)).filter(el => el.isConnected && el.textContent.trim().length > 0);
    compareGroup(els, tag.toUpperCase() + ' text size', 'inconsistent-font-size', el => {
      const s = getComputedStyle(el);
      return s.fontSize + '|' + s.fontWeight;
    });
  });

  // Group paragraphs
  const paras = Array.from(document.querySelectorAll('p')).filter(el => el.isConnected && el.textContent.trim().length > 3);
  compareGroup(paras, 'paragraph text size', 'inconsistent-font-size', el => {
    const s = getComputedStyle(el);
    return s.fontSize + '|' + s.fontWeight + '|' + s.color;
  });

  // ─── 2. INCONSISTENT FONT WEIGHTS ───────────────────────────────────
  ['h1','h2','h3','h4','h5','h6','p','span','a','button','label','div'].forEach(tag => {
    const els = Array.from(document.querySelectorAll(tag)).filter(el => {
      if (!el.isConnected) return false;
      const text = el.textContent.trim();
      if (text.length < 2 || text.length > 200) return false;
      return true;
    });
    compareGroup(els, tag.toUpperCase() + ' bold weight', 'inconsistent-font-weight', el => {
      const s = getComputedStyle(el);
      return s.fontSize + '|' + s.fontWeight;
    });
  });

  // ─── 3. INCONSISTENT INPUT STYLING ──────────────────────────────────
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"])')).filter(el => el.isConnected && el.offsetParent !== null);
  compareGroup(inputs, 'input fields', 'inconsistent-input-style', el => {
    const s = getComputedStyle(el);
    return s.fontSize + '|' + s.padding + '|' + s.borderRadius + '|' + s.border;
  });

  const textareas = Array.from(document.querySelectorAll('textarea')).filter(el => el.isConnected && el.offsetParent !== null);
  if (textareas.length > 0) {
    compareGroup(textareas, 'textarea fields', 'inconsistent-input-style', el => {
      const s = getComputedStyle(el);
      return s.fontSize + '|' + s.padding + '|' + s.borderRadius + '|' + s.border;
    });
  }

  const selects = Array.from(document.querySelectorAll('select')).filter(el => el.isConnected && el.offsetParent !== null);
  if (selects.length > 0 && inputs.length > 0) {
    compareGroup([...inputs, ...selects], 'form field sizing', 'inconsistent-input-style', el => {
      const s = getComputedStyle(el);
      return s.height + '|' + s.fontSize;
    });
  }

  // ─── 4. INCONSISTENT BUTTON STYLING ─────────────────────────────────
  const buttons = Array.from(document.querySelectorAll('button, a.btn, [role="button"], input[type="submit"], input[type="button"]')).filter(el => el.isConnected && el.offsetParent !== null);
  compareGroup(buttons, 'button styles', 'inconsistent-button-style', el => {
    const s = getComputedStyle(el);
    return s.fontSize + '|' + s.padding + '|' + s.borderRadius + '|' + s.fontWeight + '|' + s.height;
  });

  // ─── 5. INCONSISTENT SECTION PADDING ────────────────────────────────
  const sections = Array.from(document.querySelectorAll('section, [class*="section"], .container > div, main > div')).filter(el => {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    return (s.paddingTop !== '0px' || s.paddingBottom !== '0px') && el.children.length > 0;
  });
  if (sections.length >= 2) {
    const paddingMap = {};
    sections.forEach(el => {
      const s = getComputedStyle(el);
      const key = s.paddingTop + '|' + s.paddingBottom + '|' + s.paddingLeft + '|' + s.paddingRight;
      if (!paddingMap[key]) paddingMap[key] = [];
      paddingMap[key].push(el);
    });
    const keys = Object.keys(paddingMap);
    if (keys.length > 1) {
      const largest = keys.reduce((a, b) => paddingMap[a].length >= paddingMap[b].length ? a : b);
      keys.forEach(key => {
        if (key === largest) return;
        paddingMap[key].forEach(el => {
          const mainEl = paddingMap[largest][0];
          const ms = getStyles(mainEl);
          const os = getStyles(el);
          addIssue(
            'inconsistent-section-padding',
            'Inconsistent Section Padding',
            'low',
            'layout',
            el,
            'padding: ' + os.paddingTop + ' ' + os.paddingRight + ' ' + os.paddingBottom + ' ' + os.paddingLeft + ' (expected: ' + ms.paddingTop + ' ' + ms.paddingRight + ' ' + ms.paddingBottom + ' ' + ms.paddingLeft + ')',
            'Make this section padding consistent with other sections on the page.',
            'padding: ' + ms.paddingTop + ' ' + ms.paddingRight + ' ' + ms.paddingBottom + ' ' + ms.paddingLeft + ' !important'
          );
        });
      });
    }
  }

  // ─── 5b. INCONSISTENT HEADER/FOOTER PADDING ─────────────────────────
  const headerCandidates = Array.from(document.querySelectorAll('header, nav, [class*="header"], [class*="navbar"], [class*="topbar"], [class*="nav-bar"], [id*="header"]')).filter(el => {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    return el.offsetParent !== null && (s.paddingTop !== '0px' || s.paddingBottom !== '0px' || s.paddingLeft !== '0px' || s.paddingRight !== '0px');
  });
  if (headerCandidates.length >= 2) {
    const headerPadding = {};
    headerCandidates.forEach(el => {
      const s = getComputedStyle(el);
      const key = s.paddingTop + '|' + s.paddingBottom + '|' + s.paddingLeft + '|' + s.paddingRight;
      if (!headerPadding[key]) headerPadding[key] = [];
      headerPadding[key].push(el);
    });
    const keys = Object.keys(headerPadding);
    if (keys.length > 1) {
      const largest = keys.reduce((a, b) => headerPadding[a].length >= headerPadding[b].length ? a : b);
      keys.forEach(key => {
        if (key === largest) return;
        headerPadding[key].forEach(el => {
          const mainEl = headerPadding[largest][0];
          const ms = getStyles(mainEl);
          const os = getStyles(el);
          addIssue(
            'inconsistent-header-padding',
            'Inconsistent Header Padding',
            'medium',
            'layout',
            el,
            'padding: ' + os.paddingTop + ' ' + os.paddingRight + ' ' + os.paddingBottom + ' ' + os.paddingLeft + ' (expected: ' + ms.paddingTop + ' ' + ms.paddingRight + ' ' + ms.paddingBottom + ' ' + ms.paddingLeft + ')',
            'Make header padding consistent across the page.',
            'padding: ' + ms.paddingTop + ' ' + ms.paddingRight + ' ' + ms.paddingBottom + ' ' + ms.paddingLeft + ' !important'
          );
        });
      });
    }
  }

  const footerCandidates = Array.from(document.querySelectorAll('footer, [class*="footer"], [class*="bottom-bar"], [id*="footer"]')).filter(el => {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    return el.offsetParent !== null && (s.paddingTop !== '0px' || s.paddingBottom !== '0px' || s.paddingLeft !== '0px' || s.paddingRight !== '0px');
  });
  if (footerCandidates.length >= 2) {
    const footerPadding = {};
    footerCandidates.forEach(el => {
      const s = getComputedStyle(el);
      const key = s.paddingTop + '|' + s.paddingBottom + '|' + s.paddingLeft + '|' + s.paddingRight;
      if (!footerPadding[key]) footerPadding[key] = [];
      footerPadding[key].push(el);
    });
    const keys = Object.keys(footerPadding);
    if (keys.length > 1) {
      const largest = keys.reduce((a, b) => footerPadding[a].length >= footerPadding[b].length ? a : b);
      keys.forEach(key => {
        if (key === largest) return;
        footerPadding[key].forEach(el => {
          const mainEl = footerPadding[largest][0];
          const ms = getStyles(mainEl);
          const os = getStyles(el);
          addIssue(
            'inconsistent-footer-padding',
            'Inconsistent Footer Padding',
            'medium',
            'layout',
            el,
            'padding: ' + os.paddingTop + ' ' + os.paddingRight + ' ' + os.paddingBottom + ' ' + os.paddingLeft + ' (expected: ' + ms.paddingTop + ' ' + ms.paddingRight + ' ' + ms.paddingBottom + ' ' + ms.paddingLeft + ')',
            'Make footer padding consistent across the page.',
            'padding: ' + ms.paddingTop + ' ' + ms.paddingRight + ' ' + ms.paddingBottom + ' ' + ms.paddingLeft + ' !important'
          );
        });
      });
    }
  }

  // ─── 6. INCONSISTENT MARGINS BETWEEN SIMILAR ELEMENTS ───────────────
  const cards = Array.from(document.querySelectorAll('[class*="card"], [class*="item"], [class*="tile"], article')).filter(el => el.isConnected && el.offsetParent !== null);
  if (cards.length >= 2) {
    const marginMap = {};
    cards.forEach(el => {
      const s = getComputedStyle(el);
      const key = s.marginTop + '|' + s.marginBottom + '|' + s.marginLeft + '|' + s.marginRight;
      if (!marginMap[key]) marginMap[key] = [];
      marginMap[key].push(el);
    });
    const keys = Object.keys(marginMap);
    if (keys.length > 1) {
      const largest = keys.reduce((a, b) => marginMap[a].length >= marginMap[b].length ? a : b);
      keys.forEach(key => {
        if (key === largest) return;
        marginMap[key].forEach(el => {
          const mainEl = marginMap[largest][0];
          const ms = getStyles(mainEl);
          const os = getStyles(el);
          addIssue(
            'inconsistent-card-margin',
            'Inconsistent Card Margin',
            'low',
            'layout',
            el,
            'Card "' + getCardName(el) + '" has margin: ' + os.marginTop + ' ' + os.marginRight + ' ' + os.marginBottom + ' ' + os.marginLeft + ' (expected: ' + ms.marginTop + ' ' + ms.marginRight + ' ' + ms.marginBottom + ' ' + ms.marginLeft + ')',
            'Make this card margin consistent with other cards.',
            'margin: ' + ms.marginTop + ' ' + ms.marginRight + ' ' + ms.marginBottom + ' ' + ms.marginLeft + ' !important',
            getCardName(el)
          );
        });
      });
    }
  }

  // ─── 7. MISSING CURRENCY SIGN ON AMOUNTS ────────────────────────────
  const priceRegex = /\\b\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?\\b/;
  const currencySymbols = ['$', '€', '£', '¥', '₹', 'R$'];
  document.querySelectorAll('span, div, p, td, h1, h2, h3, h4, h5, h6, a, button, label, strong, b, em').forEach(el => {
    if (!el.isConnected) return;
    const text = el.textContent.trim();
    if (text.length < 1 || text.length > 50) return;
    if (el.children.length > 1) return;

    const hasNumber = priceRegex.test(text);
    if (!hasNumber) return;

    const cleanText = text.replace(/[^\\d.,]/g, '');
    const numbers = cleanText.match(/\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?/g);
    if (!numbers) return;

    const largestNum = numbers.reduce((a, b) => {
      const aVal = parseFloat(a.replace(/,/g, ''));
      const bVal = parseFloat(b.replace(/,/g, ''));
      return aVal >= bVal ? a : b;
    });

    const numVal = parseFloat(largestNum.replace(/,/g, ''));
    if (numVal < 10) return;

    const hasCurrency = currencySymbols.some(sym => text.includes(sym));
    const hasPercent = text.includes('%');
    const hasPerMonth = /\\/\\s*mo|per\\s*month|\\/mo/i.test(text);
    const hasUnit = /\\b(px|rem|em|%|vh|vw|pt|cm|mm|in|sqft|sq\\s*ft|sqm|m²|ft²)\\b/i.test(text);

    if (!hasCurrency && !hasPercent && !hasUnit && numVal >= 100) {
      const context = el.closest('[class*="price"], [class*="cost"], [class*="amount"], [class*="fee"], [class*="rate"], [class*="total"]');
      if (context || /price|cost|amount|fee|rate|total|budget|salary|wage|revenue|income|payment/i.test(text + ' ' + (el.className || ''))) {
        addIssue(
          'missing-currency',
          'Missing Currency Sign',
          'medium',
          'ui-consistency',
          el,
          'Amount "' + text + '" is missing a currency symbol ($, €, £, etc.)',
          'Add the appropriate currency symbol before the amount.'
        );
      }
    }
  });

  // ─── 8. INCONSISTENT LINE HEIGHT ────────────────────────────────────
  const textGroups = [
    { selector: 'p', name: 'paragraph' },
    { selector: 'span', name: 'span' },
    { selector: 'a', name: 'link' },
  ];
  textGroups.forEach(({ selector, name }) => {
    const els = Array.from(document.querySelectorAll(selector)).filter(el => {
      if (!el.isConnected) return false;
      const text = el.textContent.trim();
      return text.length > 10 && text.length < 300;
    });
    compareGroup(els, name + ' line-height', 'inconsistent-line-height', el => {
      const s = getComputedStyle(el);
      return s.lineHeight + '|' + s.fontSize;
    });
  });

  // ─── 9. INCONSISTENT TEXT ALIGN ─────────────────────────────────────
  ['h1','h2','h3','h4','h5','h6','p'].forEach(tag => {
    const els = Array.from(document.querySelectorAll(tag)).filter(el => el.isConnected && el.textContent.trim().length > 3);
    compareGroup(els, tag.toUpperCase() + ' text align', 'inconsistent-text-align', el => {
      const s = getComputedStyle(el);
      return s.textAlign;
    });
  });

  // ─── 10. INCONSISTENT COLOR SCHEME ──────────────────────────────────
  const links = Array.from(document.querySelectorAll('a')).filter(el => el.isConnected && el.textContent.trim().length > 0 && el.offsetParent !== null);
  if (links.length >= 2) {
    const colorMap = {};
    links.forEach(el => {
      const s = getComputedStyle(el);
      const key = s.color + '|' + s.textDecorationColor;
      if (!colorMap[key]) colorMap[key] = [];
      colorMap[key].push(el);
    });
    const keys = Object.keys(colorMap);
    if (keys.length > 1) {
      const largest = keys.reduce((a, b) => colorMap[a].length >= colorMap[b].length ? a : b);
      keys.forEach(key => {
        if (key === largest) return;
        colorMap[key].forEach(el => {
          const mainEl = colorMap[largest][0];
          const ms = getStyles(mainEl);
          const os = getStyles(el);
          addIssue(
            'inconsistent-link-color',
            'Inconsistent Link Color',
            'medium',
            'ui-consistency',
            el,
            'Link color: ' + os.color + ' (expected: ' + ms.color + ')',
            'Make link color consistent across the page.',
            'color: ' + ms.color + ' !important'
          );
        });
      });
    }
  }

  // De-duplicate by ruleId + selector
  const seen = new Set();
  return issues.filter(i => {
    const key = i.ruleId + '|' + i.selector;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})();
`;

// ─── API ENDPOINTS ─────────────────────────────────────────────────────────

app.post('/analyze', async (req, res) => {
  const { url, username, password } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const credentials = (username && password) ? { username, password } : null;

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    const navResult = await navigateToPage(page, url, 30000, credentials);

    // If login was attempted but failed AND page still looks like a login page, ask for credentials.
    // If login succeeded (URL changed away from login), skip this check — the SPA may still
    // have password fields or "login" text elsewhere in the DOM (settings, nav, etc.)
    if (navResult.loginAttempted && !navResult.loginSucceeded && await isLoginPage(page)) {
      await page.close();
      if (credentials) {
        return res.json({
          url,
          loginRequired: true,
          message: 'Login failed with the provided credentials. Please check the username and password and try again.',
        });
      }
      return res.json({
        url,
        loginRequired: true,
        message: 'This page requires a username and password. Please enter your login credentials above and click Analyze again.',
      });
    }

    // Also check if no credentials were provided and page needs login
    if (!credentials && await isLoginPage(page)) {
      const currentUrl = page.url().toLowerCase();
      const isExternalAuth = /accounts\.google\.com|login\.microsoftonline|facebook\.com\/login|github\.com\/login|linkedin\.com\/login|twitter\.com\/login|x\.com\/login|id\.apple\.com|auth0\.com|okta\.com|onelogin\.com/.test(currentUrl);
      await page.close();
      if (isExternalAuth) {
        return res.json({
          url,
          loginRequired: true,
          message: 'This page redirects to an external login provider (' + new URL(currentUrl).hostname + ') that cannot be automated. Please log into the site manually in your browser first, then try again.',
        });
      }
      return res.json({
        url,
        loginRequired: true,
        message: 'This page requires a username and password. Please enter your login credentials above and click Analyze again.',
      });
    }

    // Take screenshot (full page so all elements, including below-the-fold ones, can be highlighted)
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });

    // Run analysis
    const issues = await page.evaluate(ANALYSIS_SCRIPT);

    // Get page title
    const title = await page.title();

    await page.close();

    res.json({
      url,
      title,
      issues,
      screenshot: screenshot.toString('base64'),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── SCREENSHOT PREVIEW ─────────────────────────────────────────────────────
app.post('/screenshot', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(30000);

    await navigateToPage(page, url);

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    await page.close();

    res.json({ screenshot: screenshot.toString('base64') });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Group selectors used by the analysis rules. A fix is applied to the whole
// group so the page becomes fully consistent for that rule.
const RULE_GROUP_SELECTORS = {
  'inconsistent-card-margin': '[class*="card"], [class*="item"], [class*="tile"], article',
  'inconsistent-section-padding': 'section, [class*="section"], .container > div, main > div',
  'inconsistent-header-padding': 'header, nav, [class*="header"], [class*="navbar"], [class*="topbar"], [class*="nav-bar"], [id*="header"]',
  'inconsistent-footer-padding': 'footer, [class*="footer"], [class*="bottom-bar"], [id*="footer"]',
  'inconsistent-link-color': 'a',
};

app.post('/recheck', async (req, res) => {
  const { url, selectors, fixes, username, password } = req.body;
  if (!url || (!selectors && !fixes)) return res.status(400).json({ error: 'URL and selectors/fixes required' });

  const credentials = (username && password) ? { username, password } : null;

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    // Refresh the link fresh and re-analyse
    await navigateToPage(page, url, 30000, credentials);

    // Apply the actual CSS fixes (injected overrides) so resolved issues are gone.
    // For style-consistency rules the fix is applied to the whole element group,
    // otherwise to the individual selector.
    if (Array.isArray(fixes) && fixes.length > 0) {
      const css = [];
      for (const f of fixes) {
        if (!f || !f.fixCss) continue;
        const targetSel = (f.ruleId && RULE_GROUP_SELECTORS[f.ruleId]) || (f.selector ? f.selector : null);
        if (targetSel) css.push(targetSel + ' { ' + f.fixCss + ' }');
      }
      if (css.length > 0) {
        await page.addStyleTag({ content: css.join('\n') });
        await page.waitForTimeout(500);
      }
    }

    // Re-run analysis to check if issues persist.
    // When fixes are provided, match by (ruleId + selector) so only the fixed
    // rule matters - the same element may be flagged by other rules.
    const issues = await page.evaluate(ANALYSIS_SCRIPT);
    let stillPresent, fixed;
    if (Array.isArray(fixes) && fixes.length > 0) {
      stillPresent = fixes.filter(f => issues.some(i => i.ruleId === f.ruleId && i.selector === f.selector)).map(f => f.selector);
      fixed = fixes.filter(f => !issues.some(i => i.ruleId === f.ruleId && i.selector === f.selector)).map(f => f.selector);
    } else {
      const selList = Array.isArray(selectors) ? selectors : [];
      stillPresent = selList.filter(sel => issues.some(i => i.selector === sel));
      fixed = selList.filter(sel => !issues.some(i => i.selector === sel));
    }

    await page.close();
    res.json({ stillPresent, fixed });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── MONITOR (capture runtime errors & network issues) ─────────────────

app.post('/monitor', async (req, res) => {
  const { url, username, password } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const credentials = (username && password) ? { username, password } : null;
  let page;

  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    const consoleIssues = [];
    const networkIssues = [];
    const runtimeErrors = [];

    // Capture console messages
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const text = msg.text();
        const args = msg.args().map(a => a.toString().slice(0, 200));
        consoleIssues.push({
          type,
          text: text.slice(0, 500),
          args,
          timestamp: Date.now(),
        });
      }
    });

    // Capture network failures (4xx, 5xx)
    page.on('response', response => {
      const status = response.status();
      const reqUrl = response.url();
      if (status >= 400) {
        const resourceType = response.request().resourceType();
        // Determine if frontend or backend issue
        const isApi = /\/api\/|\/rest\/|\/graphql|\/v\d+\/|\.json$|\.xml$/.test(reqUrl);
        const isStatic = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(reqUrl);
        let category;
        if (status >= 500) category = 'backend';
        else if (isApi) category = 'backend';
        else if (isStatic) category = 'frontend';
        else if (resourceType === 'document') category = 'frontend';
        else category = 'backend';

        networkIssues.push({
          url: reqUrl.slice(0, 300),
          status,
          resourceType,
          category,
          timestamp: Date.now(),
        });
      }
    });

    // Capture runtime JS errors
    page.on('pageerror', err => {
      runtimeErrors.push({
        message: err.message.slice(0, 500),
        stack: (err.stack || '').slice(0, 500),
        timestamp: Date.now(),
      });
    });

    page.on('requestfailed', request => {
      const failure = request.failure();
      networkIssues.push({
        url: request.url().slice(0, 300),
        status: 0,
        resourceType: request.resourceType(),
        category: 'frontend',
        errorText: failure ? (failure.errorText || 'Failed').slice(0, 200) : 'Unknown',
        timestamp: Date.now(),
      });
    });

    // Navigate to page
    await navigateToPage(page, url);

    // Wait a bit to capture late-loading issues
    await page.waitForTimeout(5000);

    await page.close();

    // Deduplicate
    const seenConsole = new Set();
    const uniqueConsole = consoleIssues.filter(i => {
      const key = i.text;
      if (seenConsole.has(key)) return false;
      seenConsole.add(key);
      return true;
    });

    const seenNetwork = new Set();
    const uniqueNetwork = networkIssues.filter(i => {
      const key = i.url + '|' + i.status;
      if (seenNetwork.has(key)) return false;
      seenNetwork.add(key);
      return true;
    });

    // Merge runtime errors with console issues (categorize as frontend)
    runtimeErrors.forEach(err => {
      uniqueConsole.push({
        type: 'error',
        text: err.message,
        args: [err.stack],
        timestamp: err.timestamp,
        category: 'frontend',
      });
    });

    // Categorize console issues
    uniqueConsole.forEach(i => {
      if (!i.category) {
        const text = i.text.toLowerCase();
        if (text.includes('networkerror') || text.includes('failed to fetch') || text.includes('cors')) {
          i.category = 'frontend';
        } else if (text.includes('api') || text.includes('500') || text.includes('502') || text.includes('503')) {
          i.category = 'backend';
        } else {
          i.category = 'frontend';
        }
      }
    });

    // Sort: errors first, then warnings
    uniqueConsole.sort((a, b) => (a.type === 'error' ? -1 : 1) - (b.type === 'error' ? -1 : 1));
    uniqueNetwork.sort((a, b) => b.status - a.status);

    res.json({
      url,
      consoleIssues: uniqueConsole.slice(0, 50),
      networkIssues: uniqueNetwork.slice(0, 50),
      totalConsole: uniqueConsole.length,
      totalNetwork: uniqueNetwork.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── COMPARISON ENGINE ──────────────────────────────────────────────────────

const COMPARE_PROPS = [
  'color', 'background-color', 'font-size', 'font-family', 'font-weight',
  'border-radius', 'padding', 'border', 'box-shadow', 'line-height',
  'text-align', 'text-transform', 'letter-spacing', 'margin',
  'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'margin-top', 'margin-bottom',
  'width', 'height', 'min-height', 'max-width', 'min-width',
  'outline', 'opacity'
];

const COMPARE_SCRIPT = `
(() => {
  const isLoginPage = location.href.includes('/login') || location.href.includes('/auth') || !!document.querySelector('input[type="password"], form[action*="login"], .login-form, #login-form');
  const pageTitle = document.title || '';

  function getUniqueSelector(el) {
    if (!el) return 'unknown';
    if (el.id) return '#' + el.id;
    let path = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { path.unshift('#' + cur.id); break; }
      if (cur.className && typeof cur.className === 'string') {
        const classes = cur.className.trim().split(/\\s+/).filter(c => !c.startsWith('issue-')).slice(0, 2);
        if (classes.length) sel += '.' + classes.join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          sel += ':nth-child(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      path.unshift(sel);
      cur = cur.parentElement;
      if (path.length > 3) break;
    }
    return path.join(' > ');
  }

  function getBBox(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) {
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      }
    } catch (e) {}
    return null;
  }

  const ELEMENT_TYPES = {
    'button': ['button', 'a.btn', '[role="button"]', 'input[type="submit"]', 'input[type="button"]'],
    'heading1': ['h1'],
    'heading2': ['h2'],
    'heading3': ['h3'],
    'heading': ['h1, h2, h3, h4, h5, h6'],
    'link': ['a:not(.btn):not([role="button"])'],
    'input': ['input[type="text"], input[type="email"], input[type="password"], input[type="search"]'],
    'select': ['select'],
    'card': ['.card', '[class*="card"]', '.panel', '[class*="panel"]', '[class*="tile"]', '[class*="box"]', '[class*="widget"]'],
    'nav': ['nav', 'header nav', '.navbar', '[class*="nav-"]'],
    'header': ['header', '[class*="header"]', '[class*="topbar"]', '[id*="header"]'],
    'footer': ['footer', '[class*="footer"]', '[class*="bottom-bar"]', '[id*="footer"]'],
    'section': ['section', '[class*="section"]', 'main > div', '.container > div'],
    'list-item': ['li', '[class*="list-item"]', '[class*="item"]', '.product-item', '.post-item'],
  };

  const PROPS = ${JSON.stringify(COMPARE_PROPS)};

  const results = {};

  for (const [typeName, selectors] of Object.entries(ELEMENT_TYPES)) {
    const els = document.querySelectorAll(selectors.join(', '));
    if (els.length === 0) continue;

    const samples = [];
    const seen = new Set();

    els.forEach(el => {
      if (!el.isConnected) return;
      const style = getComputedStyle(el);
      const props = {};
      PROPS.forEach(p => {
        const val = style.getPropertyValue(p);
        if (val && val !== 'none' && !val.startsWith('rgba(0, 0, 0, 0)') && val !== 'auto') {
          props[p] = val;
        }
      });
      const key = JSON.stringify(props);
      if (!seen.has(key)) {
        seen.add(key);
        const rect = el.getBoundingClientRect();
        samples.push({
          props,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 60),
          visible: rect.width > 0 && rect.height > 0,
          selector: getUniqueSelector(el),
          bbox: getBBox(el)
        });
      }
    });

    if (samples.length > 0) {
      // Determine the dominant style (most common property set)
      const freq = {};
      samples.forEach(s => { const k = JSON.stringify(s.props); freq[k] = (freq[k] || 0) + 1; });
      const dominantKey = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];

      results[typeName] = {
        count: els.length,
        samples: samples.slice(0, 5),
        dominant: JSON.parse(dominantKey),
        variants: samples.filter(s => JSON.stringify(s.props) !== dominantKey).length
      };
    }
  }

  return { title: pageTitle, url: location.href, elements: results, isLoginPage };
})();
`;

// Also handle GET for easier debugging
app.get('/compare', (req, res) => {
  res.status(400).json({ error: 'Use POST with JSON body containing "urls" array' });
});

app.post('/compare', async (req, res) => {
  const { urls, username, password } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length < 2) {
    return res.status(400).json({ error: 'At least 2 URLs are required' });
  }

  // Use credentials from request, env vars, or fallback to defaults
  const credentials = (username && password) ? { username, password } : null;

  let browser;
  try {
    browser = await getBrowser();
    const pageData = [];

    // Use one page for all URLs to persist session/cookies
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    // Navigate to each URL (login handled generically by navigateToPage).
    // If a page requires login, ask for credentials instead of returning results.
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const navResult = await navigateToPage(page, url, 30000, credentials);
        // If login failed and page still looks like a login page
        if (navResult.loginAttempted && !navResult.loginSucceeded && await isLoginPage(page)) {
          await page.close().catch(() => {});
          if (credentials) {
            return res.json({
              loginRequired: true,
              message: 'Login failed with the provided credentials. Please check the username and password and try again.',
            });
          }
          return res.json({
            loginRequired: true,
            message: 'These pages require a username and password. Please enter your login credentials above and click Compare again.',
          });
        }
        // Also check if no credentials and page needs login
        if (!credentials && await isLoginPage(page)) {
          const curUrl = page.url().toLowerCase();
          const isExtAuth = /accounts\.google\.com|login\.microsoftonline|facebook\.com\/login|github\.com\/login|linkedin\.com\/login|twitter\.com\/login|x\.com\/login|id\.apple\.com|auth0\.com|okta\.com|onelogin\.com/.test(curUrl);
          await page.close().catch(() => {});
          if (isExtAuth) {
            return res.json({
              loginRequired: true,
              message: 'This page redirects to an external login provider (' + new URL(curUrl).hostname + ') that cannot be automated. Please log into the site manually in your browser first, then try again.',
            });
          }
          return res.json({
            loginRequired: true,
            message: 'These pages require a username and password. Please enter your login credentials above and click Compare again.',
          });
        }
        const data = await page.evaluate(COMPARE_SCRIPT);
        pageData.push(data);
      } catch (err) {
        pageData.push({ title: '', url, elements: {}, error: err.message });
      }
    }

    await page.close().catch(() => {});

    // ─── COMPARE ALL PAGES — SHOW ALL VALUES PER PROPERTY ─────────────────
    const allElemTypes = new Set();
    pageData.forEach(pd => Object.keys(pd.elements || {}).forEach(t => allElemTypes.add(t)));

    const comparisons = [];
    for (const elemType of allElemTypes) {
      const pagesWith = pageData.filter(pd => pd.elements && pd.elements[elemType]);
      if (pagesWith.length < 2) continue;

      // Collect all property values across all pages for this element type
      const propValues = {};
      for (const prop of COMPARE_PROPS) {
        const vals = [];
        for (const pw of pagesWith) {
          const elData = pw.elements[elemType];
          const val = (elData.dominant && elData.dominant[prop]) || null;
          vals.push({ url: pw.url, value: val });
        }
        // Only include if at least 2 pages have this property and values differ
        const defined = vals.filter(v => v.value !== null && v.value !== '');
        if (defined.length < 2) continue;

        const uniqueVals = new Set(defined.map(v => v.value));
        if (uniqueVals.size < 2) continue;

        // Find the most common value (dominant)
        const freq = {};
        defined.forEach(v => { freq[v.value] = (freq[v.value] || 0) + 1; });
        const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];

        propValues[prop] = {
          values: vals,
          dominant,
          inconsistent: true
        };
      }

      if (Object.keys(propValues).length > 0) {
        comparisons.push({
          elementType: elemType,
          sample: pagesWith[0].elements[elemType].samples[0] || null,
          totalPages: pagesWith.length,
          properties: propValues
        });
      }
    }

    // Take screenshots of each page (use same browser context for session)
    const screenshots = [];
    for (const pd of pageData) {
      try {
        const ssPage = await browser.newPage();
        await ssPage.setViewport({ width: 1280, height: 800 });
        await ssPage.setDefaultNavigationTimeout(60000);
        await navigateToPage(ssPage, pd.url, 30000, credentials);
        const ss = await ssPage.screenshot({ type: 'png', fullPage: true });
        screenshots.push({ url: pd.url, data: ss.toString('base64') });
        await ssPage.close().catch(() => {});
      } catch (e) {
        screenshots.push({ url: pd.url, data: null });
      }
    }

    // ─── GENERATE PER-PAGE ISSUES FROM COMPARISONS ─────────────────────────
    // Each issue carries the url of the offending page plus the element's
    // selector/bbox so the UI can highlight it on that page's screenshot and
    // apply/ignore the fix.
    const issues = [];
    let issueSeq = 0;
    for (const comp of comparisons) {
      const typeLabel = comp.elementType.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase());
      for (const [prop, info] of Object.entries(comp.properties)) {
        const propLabel = prop.replace(/-/g, ' ').replace(/\b\w/g, s => s.toUpperCase());
        for (const v of info.values) {
          if (!v.value || v.value === info.dominant) continue;
          const pd = pageData.find(x => x.url === v.url);
          const elData = pd && pd.elements && pd.elements[comp.elementType];
          const sample = (elData && elData.samples && elData.samples.find(s => s.props && s.props[prop] === v.value)) || (elData && elData.samples && elData.samples[0]) || null;
          const isColor = /^#([0-9a-f]{3,8}|[0-9a-f]{6})$/i.test(v.value) || /^rgb/.test(v.value) || /^hsl/.test(v.value);
          issues.push({
            id: 'cmp-issue-' + (issueSeq++),
            ruleId: 'compare-consistency',
            name: typeLabel + ' ' + propLabel + ' inconsistent',
            severity: (isColor || prop === 'font-size' || prop === 'font-family' || prop === 'padding') ? 'high' : 'medium',
            category: 'cross-page',
            url: v.url,
            detail: propLabel + ' is "' + v.value + '" but the dominant value across the app is "' + info.dominant + '".',
            recommendation: 'Apply the dominant value (' + info.dominant + ') to match the rest of the app.',
            selector: sample ? sample.selector : null,
            bbox: sample ? sample.bbox : null,
            fixCss: (sample && sample.selector) ? (prop + ': ' + info.dominant + ';') : '',
            context: comp.elementType,
            property: prop,
            value: v.value,
            dominant: info.dominant
          });
        }
      }
    }

    // ─── GENERATE SUGGESTIONS ──────────────────────────────────────────────
    const suggestions = generateSuggestions(pageData, comparisons);
    res.json({ pages: pageData, comparisons, screenshots, suggestions, issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SUGGESTIONS ENGINE ──────────────────────────────────────────────────
function generateSuggestions(pageData, comparisons) {
  const suggestions = [];

  comparisons.forEach(comp => {
    const typeLabel = comp.elementType.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase());

    for (const [prop, info] of Object.entries(comp.properties)) {
      const propLabel = prop.replace(/-/g, ' ').replace(/\b\w/g, s => s.toUpperCase());
      const defined = info.values.filter(v => v.value !== null);
      const uniqueVals = [...new Set(defined.map(v => v.value))];
      if (uniqueVals.length < 2) continue;

      // List all unique values and which pages have them
      const valPages = {};
      defined.forEach(v => {
        if (!valPages[v.value]) valPages[v.value] = [];
        valPages[v.value].push(v.url);
      });

      const parts = Object.entries(valPages).map(([val, urls]) => `${val} (${urls.length} page${urls.length > 1 ? 's' : ''}: ${urls.join(', ')})`).join(' vs ');
      const allUrls = defined.map(v => v.url);

      let suggestion;
      if (prop === 'font-size') {
        suggestion = `"${typeLabel}" font-size differs across pages: ${parts}. Pick one size for consistent text hierarchy.`;
      } else if (prop === 'color' || prop === 'background-color') {
        suggestion = `"${typeLabel}" ${propLabel} differs: ${parts}. Use the same brand color across all pages.`;
      } else if (prop === 'font-family') {
        suggestion = `"${typeLabel}" uses different fonts: ${parts}. Stick to one font family.`;
      } else if (prop === 'font-weight') {
        suggestion = `"${typeLabel}" font-weight varies: ${parts}. Use the same weight.`;
      } else if (prop === 'border-radius') {
        suggestion = `"${typeLabel}" border-radius differs: ${parts}. Match corner roundness.`;
      } else if (prop === 'padding' || prop.startsWith('padding-')) {
        suggestion = `"${typeLabel}" ${propLabel} differs: ${parts}. Uniform padding creates predictable spacing.`;
      } else if (prop === 'margin' || prop.startsWith('margin-')) {
        suggestion = `"${typeLabel}" ${propLabel} differs: ${parts}. Consistent margins improve layout rhythm.`;
      } else if (prop === 'border') {
        suggestion = `"${typeLabel}" border style differs: ${parts}. Align border styles across pages.`;
      } else if (prop === 'box-shadow') {
        suggestion = `"${typeLabel}" shadow differs: ${parts}. Consistent shadows build cohesive depth.`;
      } else if (prop === 'line-height') {
        suggestion = `"${typeLabel}" line-height differs: ${parts}. Keep line-height consistent.`;
      } else if (prop === 'text-align') {
        suggestion = `"${typeLabel}" text-align differs: ${parts}. Pick one alignment.`;
      } else if (prop === 'text-transform') {
        suggestion = `"${typeLabel}" text-transform differs: ${parts}. Apply consistently.`;
      } else if (prop === 'letter-spacing') {
        suggestion = `"${typeLabel}" letter-spacing differs: ${parts}. Consistent spacing improves readability.`;
      } else if (prop === 'width' || prop === 'height' || prop === 'min-height' || prop === 'max-width') {
        suggestion = `"${typeLabel}" ${propLabel} differs: ${parts}. Use consistent sizing across pages.`;
      } else {
        suggestion = `"${typeLabel}" ${propLabel} is not consistent: ${parts}. Review and align values.`;
      }

      suggestions.push({
        type: 'inconsistency',
        elementType: comp.elementType,
        property: prop,
        severity: 'medium',
        suggestion
      });
    }
  });

  const allElements = {};
  pageData.forEach(pd => {
    if (pd.elements) {
      for (const [type, info] of Object.entries(pd.elements)) {
        if (!allElements[type]) allElements[type] = [];
        allElements[type].push({ url: pd.url, info });
      }
    }
  });

  for (const [type, pages] of Object.entries(allElements)) {
    const typeLabel = type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase());
    pages.forEach(p => {
      if (p.info.variants > 2) {
        suggestions.push({
          type: 'consistency',
          elementType: type,
          severity: p.info.variants > 5 ? 'high' : 'low',
          suggestion: `${typeLabel} on ${p.url} has ${p.info.variants} different styles across ${p.info.count} elements. Reduce to 1-2 styles for a cleaner design.`
        });
      }
    });
  }

  let totalButtons = 0, totalLinks = 0;
  pageData.forEach(pd => {
    if (pd.elements) {
      totalButtons += pd.elements.button?.count || 0;
      totalLinks += pd.elements.link?.count || 0;
    }
  });

  if (totalButtons > 0 && totalButtons / pageData.length > 5) {
    suggestions.push({
      type: 'clutter',
      severity: 'low',
      suggestion: `${Math.round(totalButtons / pageData.length)} buttons per page on average. Group related actions into dropdowns or menus to reduce visual noise.`
    });
  }

  if (totalLinks > 0 && totalLinks / pageData.length > 20) {
    suggestions.push({
      type: 'clutter',
      severity: 'low',
      suggestion: `${Math.round(totalLinks / pageData.length)} links per page. Consider using a navigation menu or consolidating link sections.`
    });
  }

  return suggestions;
}

// ─── MULTER (file upload) ──────────────────────────────────────────────
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ─── COMPARE SCREENSHOTS (file upload) ─────────────────────────────────
// Detects visual difference regions between two uploaded screenshots by
// decoding them in the headless browser (canvas) and scanning for changed
// pixel blocks (no native deps needed).
async function diffImagesInBrowser(buf1, buf2) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    return await page.evaluate(async ({ b1, b2 }) => {
      const mime1 = b1.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
      const mime2 = b2.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';

      function loadImage(b64, mime) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Could not decode image'));
          img.src = 'data:' + mime + ';base64,' + b64;
        });
      }

      const img1 = await loadImage(b1, mime1);
      const img2 = await loadImage(b2, mime2);

      // Compare the overlapping (top-left) region even when the two
      // screenshots have different sizes, so full-page captures of pages
      // with different heights still produce meaningful diff regions.
      const dimsMatch = img1.naturalWidth === img2.naturalWidth && img1.naturalHeight === img2.naturalHeight;
      const w = Math.min(img1.naturalWidth, img2.naturalWidth);
      const h = Math.min(img1.naturalHeight, img2.naturalHeight);
      const c1 = document.createElement('canvas'); c1.width = w; c1.height = h;
      const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
      const ctx1 = c1.getContext('2d'); ctx1.drawImage(img1, 0, 0);
      const ctx2 = c2.getContext('2d'); ctx2.drawImage(img2, 0, 0);
      const d1 = ctx1.getImageData(0, 0, w, h).data;
      const d2 = ctx2.getImageData(0, 0, w, h).data;

      const BLOCK = 16;
      const cols = Math.ceil(w / BLOCK), rows = Math.ceil(h / BLOCK);
      const changed = new Uint8Array(cols * rows);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const dr = Math.abs(d1[i] - d2[i]);
          const dg = Math.abs(d1[i + 1] - d2[i + 1]);
          const db = Math.abs(d1[i + 2] - d2[i + 2]);
          if (dr + dg + db > 40) changed[Math.floor(y / BLOCK) * cols + Math.floor(x / BLOCK)] = 1;
        }
      }

      const seen = new Uint8Array(cols * rows);
      const regions = [];
      for (let i = 0; i < cols * rows; i++) {
        if (!changed[i] || seen[i]) continue;
        const stack = [i];
        seen[i] = 1;
        let minC = i % cols, maxC = i % cols, minR = Math.floor(i / cols), maxR = Math.floor(i / cols), count = 0;
        while (stack.length) {
          const cur = stack.pop();
          const cc = cur % cols, rr = Math.floor(cur / cols);
          if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
          if (rr < minR) minR = rr; if (rr > maxR) maxR = rr;
          count++;
          const nb = [cur - 1, cur + 1, cur - cols, cur + cols, cur - cols - 1, cur - cols + 1, cur + cols - 1, cur + cols + 1];
          for (const n of nb) {
            if (n < 0 || n >= cols * rows) continue;
            if (changed[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
        const pad = 1;
        const x0 = Math.max(0, minC * BLOCK - pad);
        const y0 = Math.max(0, minR * BLOCK - pad);
        const x1 = Math.min(w, (maxC + 1) * BLOCK + pad);
        const y1 = Math.min(h, (maxR + 1) * BLOCK + pad);
        regions.push({
          x: x0, y: y0,
          width: x1 - x0, height: y1 - y0,
          blockCount: count,
          area: count * BLOCK * BLOCK
        });
      }

      const minArea = Math.max(64, (w * h) * 0.0005);
      const filtered = regions.filter(r => r.area >= minArea).sort((a, b) => b.area - a.area).slice(0, 40);

      // Per-region stats so each issue can describe WHAT actually differs
      // (background/color vs text/content) with the before/after colours.
      for (const r of filtered) {
        const x0 = r.x, y0 = r.y;
        const x1 = Math.min(w, r.x + r.width), y1 = Math.min(h, r.y + r.height);
        let sr1 = 0, sg1 = 0, sb1 = 0, sr2 = 0, sg2 = 0, sb2 = 0, cnt = 0, changedCnt = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            const dd = Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
            if (dd > 40) {
              changedCnt++;
              sr1 += d1[i]; sg1 += d1[i + 1]; sb1 += d1[i + 2];
              sr2 += d2[i]; sg2 += d2[i + 1]; sb2 += d2[i + 2];
            }
            cnt++;
          }
        }
        if (changedCnt > 0) {
          r.avg1 = [Math.round(sr1 / changedCnt), Math.round(sg1 / changedCnt), Math.round(sb1 / changedCnt)];
          r.avg2 = [Math.round(sr2 / changedCnt), Math.round(sg2 / changedCnt), Math.round(sb2 / changedCnt)];
        }
        r.changeRatio = changedCnt / Math.max(1, cnt);
      }

      return { ok: true, dimsMatch, width: w, height: h, regions: filtered };
    }, { b1: buf1.toString('base64'), b2: buf2.toString('base64') });
  } finally {
    await page.close().catch(() => {});
  }
}

app.post('/compare-screenshots', upload.fields([
  { name: 'screenshot1', maxCount: 1 },
  { name: 'screenshot2', maxCount: 1 }
]), async (req, res) => {
  try {
    const buf1 = req.files.screenshot1[0].buffer;
    const buf2 = req.files.screenshot2[0].buffer;

    // Get dimensions by reading image headers directly (no native deps needed)
    function getDimensions(buf) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        return { width: w, height: h };
      }
      let offset = 2;
      while (offset < buf.length) {
        if (buf[offset] === 0xFF && buf[offset + 1] === 0xC0) {
          const h = buf.readUInt16BE(offset + 5);
          const w = buf.readUInt16BE(offset + 7);
          return { width: w, height: h };
        }
        offset++;
      }
      return { width: 0, height: 0 };
    }

    const d1 = getDimensions(buf1);
    const d2 = getDimensions(buf2);
    const dimStr = w => `${w.width}x${w.height}`;

    // General UI suggestions
    const suggestions = [
      { type: 'best-practice', severity: 'info', suggestion: 'Ensure consistent spacing (padding/margins) across both pages for visual rhythm.' },
      { type: 'best-practice', severity: 'info', suggestion: 'Use a limited color palette (3-5 colors) applied consistently across all pages.' },
      { type: 'best-practice', severity: 'info', suggestion: 'Ensure font sizes follow a typographic scale (e.g., 14px body, 18px h3, 24px h2, 32px h1).' },
      { type: 'best-practice', severity: 'info', suggestion: 'Align navigation elements consistently - same position, same styling.' }
    ];

    if (d1.width !== d2.width || d1.height !== d2.height) {
      suggestions.push({
        type: 'inconsistency',
        severity: 'high',
        suggestion: `Screenshots have different dimensions (${dimStr(d1)} vs ${dimStr(d2)}). Take screenshots at the same browser size for accurate comparison.`
      });
    }

    // Detect visual difference regions. When the screenshots have different
    // sizes, the overlapping (top-left) region is still compared so pages with
    // different heights still produce useful issues.
    function toHex(r, g, b) {
      return '#' + [r, g, b].map(v => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('');
    }

    // Classify a diff region into a kind + human-readable description
    function classifyRegion(r) {
      const dR = Math.abs((r.avg1 && r.avg1[0]) - (r.avg2 && r.avg2[0]));
      const dG = Math.abs((r.avg1 && r.avg1[1]) - (r.avg2 && r.avg2[1]));
      const dB = Math.abs((r.avg1 && r.avg1[2]) - (r.avg2 && r.avg2[2]));
      const colorDelta = dR + dG + dB;
      const isBackground = r.changeRatio > 0.6;
      let kind, label, description, recommendation;
      const hex1 = (r.avg1 && r.avg2) ? toHex(r.avg1[0], r.avg1[1], r.avg1[2]) : '';
      const hex2 = (r.avg1 && r.avg2) ? toHex(r.avg2[0], r.avg2[1], r.avg2[2]) : '';
      const colorInfo = hex1 && hex2 ? ' (Screenshot 1: ' + hex1 + ', Screenshot 2: ' + hex2 + ')' : '';
      const sizeInfo = r.width + 'x' + r.height + 'px region at position (' + r.x + ', ' + r.y + ')';

      if (colorDelta > 150 && isBackground) {
        kind = 'background-colour';
        label = 'Background Colour Mismatch';
        description = 'The background colour of a ' + sizeInfo + ' is different between the two screenshots' + colorInfo + '. ' +
          'This creates a visual inconsistency that makes the pages feel like they belong to different designs. ' +
          'Both pages should share the same background colour to maintain a unified brand appearance.';
        recommendation = 'Match the background colour across both pages. Use the dominant background colour (' + hex1 + ') on both pages, ' +
          'or update the CSS variable / background property to a single consistent value.';
      } else if (colorDelta > 150) {
        kind = 'text-colour';
        label = 'Text / Element Colour Mismatch';
        description = 'The text or element colour of a ' + sizeInfo + ' differs between the two screenshots' + colorInfo + '. ' +
          'When similar text or UI elements use different colours on different pages, the design feels disjointed and unprofessional. ' +
          'Standardise the colour to keep the visual language consistent.';
        recommendation = 'Use the same text/element colour on both pages. Check your CSS variables (e.g., --primary, --text) ' +
          'and ensure they resolve to the same value on every page.';
      } else if (isBackground) {
        kind = 'background-layout';
        label = 'Background Layout / Spacing Inconsistency';
        description = 'The background layout or spacing of a ' + sizeInfo + ' differs between the two screenshots. ' +
          'This could be caused by different padding, margins, or section spacing. ' +
          'Inconsistent spacing disrupts the visual rhythm and makes the app feel unpolished.';
        recommendation = 'Align padding, margins, and section spacing between both pages. ' +
          'Use a consistent spacing scale (e.g., 8px, 16px, 24px, 32px) for all sections.';
      } else {
        kind = 'content';
        label = 'Content / Layout Inconsistency';
        description = 'The content or layout of a ' + sizeInfo + ' differs between the two screenshots. ' +
          'Elements such as text, buttons, images, or cards may have different sizes, positions, or content. ' +
          'Content inconsistencies confuse users who navigate between pages.';
        recommendation = 'Compare both screenshots at this region and unify the content, spacing, and layout. ' +
          'Ensure elements like headings, paragraphs, buttons, and images are consistently positioned and sized.';
      }
      return { kind, label, description, recommendation, colorInfo, hex1, hex2 };
    }

    const issues = [];
    let comparedRegion = null;
    try {
      const diff = await diffImagesInBrowser(buf1, buf2);
      if (diff && diff.ok) {
        comparedRegion = { width: diff.width, height: diff.height, dimensionsMatch: diff.dimsMatch };

        // First pass: classify every region
        const classified = diff.regions.map((r, i) => {
          const cls = classifyRegion(r);
          return { raw: r, index: i, ...cls };
        });

        // Group nearby regions of the same kind into one combined issue
        // Two regions are "nearby" if they overlap or are within 80px of each other
        const groups = [];
        const used = new Set();
        for (let i = 0; i < classified.length; i++) {
          if (used.has(i)) continue;
          const group = [classified[i]];
          used.add(i);
          for (let j = i + 1; j < classified.length; j++) {
            if (used.has(j)) continue;
            if (classified[i].kind === classified[j].kind) {
              const a = classified[i].raw, b = classified[j].raw;
              const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
                Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
              const dist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
              if (overlap > 0 || dist < 80) {
                group.push(classified[j]);
                used.add(j);
              }
            }
          }
          groups.push(group);
        }

        // Second pass: create one issue per group
        groups.forEach((group, gi) => {
          const first = group[0];
          const totalCount = group.length;
          const totalBlockCount = group.reduce((s, g) => s + g.raw.blockCount, 0);

          // Combined bounding box
          let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
          let totalArea = 0;
          group.forEach(g => {
            minX = Math.min(minX, g.raw.x);
            minY = Math.min(minY, g.raw.y);
            maxX = Math.max(maxX, g.raw.x + g.raw.width);
            maxY = Math.max(maxY, g.raw.y + g.raw.height);
            totalArea += g.raw.width * g.raw.height;
          });
          const combinedBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

          // Build a comprehensive title
          let title;
          if (totalCount === 1) {
            title = first.label;
          } else {
            // Summarise what kinds are in this group
            const kindCounts = {};
            group.forEach(g => { kindCounts[g.kind] = (kindCounts[g.kind] || 0) + 1; });
            const parts = Object.entries(kindCounts).map(([k, c]) => c + ' ' + k.replace(/-/g, ' '));
            title = first.label + ' (' + totalCount + ' affected regions: ' + parts.join(', ') + ')';
          }

          // Comprehensive description that covers ALL issues in the group
          let fullDesc = first.description;
          if (totalCount > 1) {
            // Add a summary of all affected regions
            const regionList = group.map(g =>
              '  - ' + g.raw.width + 'x' + g.raw.height + 'px at (' + g.raw.x + ', ' + g.raw.y + ')' + g.colorInfo
            ).join('\n');
            fullDesc += '\n\nAffected regions (' + totalCount + '):\n' + regionList;
            // Add extra context if group mixes kinds
            const otherKinds = [...new Set(group.map(g => g.kind))];
            if (otherKinds.length > 1) {
              fullDesc += '\n\nThis group includes multiple types of differences: ' + otherKinds.join(', ') + '. ' +
                'All regions should be reviewed together to ensure full visual consistency.';
            }
          }

          // Severity based on total impact
          let severity;
          if (totalBlockCount >= 10 || totalArea > 50000) severity = 'high';
          else if (totalBlockCount >= 4 || totalArea > 10000) severity = 'medium';
          else severity = 'low';

          issues.push({
            id: 'diff-issue-' + gi,
            ruleId: 'screenshot-diff',
            name: title,
            severity,
            category: 'visual-diff',
            detail: fullDesc,
            recommendation: first.recommendation,
            explanation: fullDesc + '\n\n' + first.recommendation,
            selector: '',
            fixCss: '',
            bbox: combinedBbox
          });
        });
      }
    } catch (e) {
      console.log(`  [SSDIFF] Region detection failed: ${e.message}`);
    }

    res.json({
      img1: buf1.toString('base64'),
      img2: buf2.toString('base64'),
      dimensions1: dimStr(d1),
      dimensions2: dimStr(d2),
      dimensionsMatch: d1.width === d2.width && d1.height === d2.height,
      comparedRegion,
      suggestions,
      issues
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVE FRONTEND ────────────────────────────────────────────────────────

// ─── SCAN-ALL ISSUE ENRICHMENT ────────────────────────────────────────────
// Gives every scan-all issue a specific heading (showing the actual difference)
// and a plain-language explanation so each issue is easy to understand.
// Only applied to the /scan-all endpoint; other tabs keep their current output.
const PROP_LABELS = {
  'font-size': 'font size',
  'font-weight': 'font weight (boldness)',
  'font-family': 'font family',
  'line-height': 'line height',
  'color': 'text colour',
  'background': 'background colour',
  'background-color': 'background colour',
  'padding': 'padding',
  'border': 'border',
  'border-radius': 'border radius',
  'min-height': 'minimum height'
};

function parseStyleDiffs(detail) {
  const diffs = [];
  String(detail || '').split(';').forEach(p => {
    const m = p.trim().match(/^([a-zA-Z-]+):\s*(.+?)\s+vs\s+(.+)$/);
    if (m) diffs.push({ prop: m[1], dominant: m[2].trim(), current: m[3].trim() });
  });
  return diffs;
}

function enrichScanAllIssue(issue) {
  const enriched = Object.assign({}, issue);
  const diffs = parseStyleDiffs(issue.detail);

  if (diffs.length > 0) {
    const d = diffs[0];
    const propLabel = PROP_LABELS[d.prop] || d.prop.replace(/-/g, ' ');

    // Real heading: include the actual difference instead of a generic title.
    enriched.name = issue.name + ' - ' + d.prop + ': ' + d.dominant + ' vs ' + d.current;

    // Plain-language explanation.
    const elText = issue.elText ? '"' + issue.elText + '"' : 'an element';
    const where = issue.context ? (' inside the "' + issue.context + '" card') : '';
    const like = issue.name.replace(/^Inconsistent\s+/, '').toLowerCase();
    let expl = 'This ' + (like || 'element') + ' element' + where + ' (' + elText + ') currently uses ' +
      d.prop + ' "' + d.current + '", but the other similar elements on this page use "' + d.dominant + '".';
    if (diffs.length > 1) {
      const rest = diffs.slice(1).map(x => x.prop + ' "' + x.current + '" instead of "' + x.dominant + '"').join(', ');
      expl += ' It also differs in ' + rest + '.';
    }
    expl += ' Elements that look alike should match, otherwise the design looks inconsistent. ' +
      'Click "Apply Fix" to set the ' + propLabel + ' to "' + d.dominant + '" and match the rest of the page.';
    enriched.explanation = expl;
  } else if (issue.recommendation) {
    enriched.explanation = 'This element does not match the other similar elements on this page. ' + issue.recommendation;
  }
  return enriched;
}

function enrichCrossPageIssue(issue) {
  const enriched = Object.assign({}, issue);
  const typeLabel = issue.context || 'element';
  enriched.explanation =
    'On the page ' + issue.url + ', the ' + typeLabel + ' element uses ' + issue.property +
    ' "' + issue.value + '", but the dominant value across the rest of the app is "' + issue.dominant + '". ' +
    'Pages in the same app should share the same look, so matching the dominant value keeps the design consistent. ' +
    'Click "Apply Fix" to set ' + issue.property + ' to "' + issue.dominant + '".';
  return enriched;
}

// ─── SCAN ALL PAGES OF ONE APPLICATION ─────────────────────────────────────
app.post('/scan-all', async (req, res) => {
  const { url, username, password, maxPages = 20 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const credentials = (username && password) ? { username, password } : null;

  let browser;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    // Step 1: Navigate to URL and login if needed
    console.log(`  [SCAN] Navigating to ${url}`);
    const navResult = await navigateToPage(page, url, 30000, credentials);

    // Wait for SPA to fully load
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (e) {}
    await page.waitForTimeout(3000);

    // If login was attempted but failed, try once more
    if (navResult.loginAttempted && !navResult.loginSucceeded && page.url().includes('/login') && credentials) {
      console.log(`  [SCAN] Still on login, waiting more...`);
      await page.waitForTimeout(5000);
      if (await isLoginPage(page)) {
        console.log(`  [SCAN] Attempting login after wait...`);
        try {
          const loggedIn = await attemptLogin(page, credentials);
          if (loggedIn) console.log(`  [SCAN] Login successful. URL: ${page.url()}`);
          else console.log(`  [SCAN] Login may have failed`);
        } catch (e) {
          console.log(`  [SCAN] Login retry failed: ${e.message}`);
        }
      }
      // If login succeeded but URL is still on /login, re-navigate to base URL
      if (!(await isLoginPage(page)) || !(await hasVisiblePasswordField(page))) {
        const curUrl = page.url();
        if (!curUrl.includes('#/') && !curUrl.includes('#!')) {
          const baseOrigin = new URL(url).origin;
          try {
            await page.goto(baseOrigin, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            console.log(`  [SCAN] Re-navigated to ${page.url()} after login`);
          } catch (e) {}
        }
      }
    }

    console.log(`  [SCAN] Logged in. Current URL: ${page.url()}`);

    // Step 1b: Analyze the home/landing page first
    const initialUrl = page.url();
    const initialScreenshot = await page.screenshot({ type: 'png', fullPage: true });
    const initialIssues = await page.evaluate(ANALYSIS_SCRIPT);
    const pageResults = [];

    pageResults.push({
      url: initialUrl,
      title: 'Home',
      issues: initialIssues,
      screenshot: initialScreenshot.toString('base64'),
    });

    console.log(`  [SCAN] Home page scanned: ${initialIssues.length} issues`);

    // Step 2: Crawl ALL internal URLs of the site (BFS)
    // Starting from the home page, discover every same-domain link,
    // visit each page, run the analysis, and collect issues.
    const baseOrigin = new URL(pageResults[0].url).origin;

    // Canonical URL form used for de-duplication.
    // Keeps hash-router routes (site.com/#/dashboard), strips query params.
    const canonicalUrl = (u) => {
      try {
        const p = new URL(u);
        p.search = '';
        if (p.hash && p.hash.startsWith('#/') && p.hash.length > 2) {
          // keep hash-router style route
        } else {
          p.hash = '';
        }
        let h = p.href;
        if (h.endsWith('/')) h = h.slice(0, -1);
        return h;
      } catch (e) { return null; }
    };

    const scanVisited = new Set();
    pageResults.forEach(p => { const c = canonicalUrl(p.url); if (c) scanVisited.add(c); });

    const discoverLinks = () => page.evaluate(() => {
      const out = [];
      // 1) Traditional <a href> links
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const href = a.getAttribute('href');
          if (!href || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
          out.push(new URL(href, location.href).href);
        } catch (e) {}
      });
      // 2) Buttons/elements with data-href, data-url, data-link attributes
      document.querySelectorAll('[data-href], [data-url], [data-link]').forEach(el => {
        try {
          const href = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
          if (href) out.push(new URL(href, location.href).href);
        } catch (e) {}
      });
      // 3) SPA: extract hash routes from clickable nav items (sidebar/menu items)
      document.querySelectorAll('[role="menuitem"], [role="tab"], nav a, nav button, .sidebar a, .menu a, .nav a, [class*="sidebar"] a, [class*="menu"] a, [class*="nav"] a').forEach(el => {
        try {
          const href = el.getAttribute('href');
          if (href && (href.startsWith('#') || href.startsWith('/'))) {
            out.push(new URL(href, location.href).href);
          }
        } catch (e) {}
      });
      return [...new Set(out)];
    });

    const queue = [];
    const enqueueLinks = async () => {
      const links = await discoverLinks();
      let added = 0;
      for (const link of links) {
        const c = canonicalUrl(link);
        if (c && c.startsWith(baseOrigin) && !scanVisited.has(c)) {
          scanVisited.add(c);
          queue.push(c);
          added++;
        }
      }
      return added;
    };

    await enqueueLinks();
    console.log(`  [SCAN] Found ${queue.length} internal links on the home page, crawling...`);

    while (queue.length > 0 && pageResults.length < maxPages) {
      const target = queue.shift();
      console.log(`  [SCAN] (${pageResults.length + 1}/${maxPages}) Visiting ${target}`);
      try {
        await navigateToPage(page, target, 30000, credentials);
        const finalUrl = page.url();
        const finalCanonical = canonicalUrl(finalUrl) || target;

        // Skip if navigation redirected back to an already-scanned page
        if (pageResults.some(p => canonicalUrl(p.url) === finalCanonical)) {
          console.log(`  [SCAN] Already scanned ${finalUrl}, skipping`);
          continue;
        }

        const screenshot = await page.screenshot({ type: 'png', fullPage: true });
        const issues = await page.evaluate(ANALYSIS_SCRIPT);
        const title = (await page.title()) || 'Page ' + (pageResults.length + 1);

        pageResults.push({
          url: finalUrl,
          title,
          issues,
          screenshot: screenshot.toString('base64'),
        });
        console.log(`  [SCAN] ${finalUrl} -> ${issues.length} issues`);

        // Discover more internal links on this page
        const newLinks = await enqueueLinks();
        console.log(`  [SCAN]   + ${newLinks} new internal links found`);
      } catch (err) {
        console.log(`  [SCAN] Error on ${target}: ${err.message}`);
        pageResults.push({
          url: target,
          title: 'Page ' + (pageResults.length + 1),
          issues: [],
          screenshot: null,
          error: err.message,
        });
      }
    }

    console.log(`  [SCAN] Crawl complete. ${pageResults.length} pages scanned.`);

    await page.close().catch(() => {});

    // Step 4: Cross-page comparison (all-values format)
    const crossPageComparisons = [];
    const pageStyleData = [];
    if (pageResults.length >= 2) {

      for (const pr of pageResults) {
        if (pr.error) continue;
        const pg = await browser.newPage();
        await pg.setViewport({ width: 1280, height: 800 });
        try {
          await navigateToPage(pg, pr.url, 30000, credentials);
          const data = await pg.evaluate(COMPARE_SCRIPT);
          pageStyleData.push(data);
        } catch (e) {
          pageStyleData.push({ url: pr.url, elements: {} });
        }
        await pg.close().catch(() => {});
      }

      const elemTypes = new Set();
      pageStyleData.forEach(pd => Object.keys(pd.elements || {}).forEach(t => elemTypes.add(t)));

      for (const elemType of elemTypes) {
        const pagesWith = pageStyleData.filter(pd => pd.elements && pd.elements[elemType]);
        if (pagesWith.length < 2) continue;

        // Collect all property values across pages (same format as /compare)
        const propValues = {};
        for (const prop of COMPARE_PROPS) {
          const vals = [];
          for (const pw of pagesWith) {
            const elData = pw.elements[elemType];
            const val = (elData.dominant && elData.dominant[prop]) || null;
            vals.push({ url: pw.url, value: val });
          }
          const defined = vals.filter(v => v.value !== null && v.value !== '');
          if (defined.length < 2) continue;
          const uniqueVals = new Set(defined.map(v => v.value));
          if (uniqueVals.size < 2) continue;
          const freq = {};
          defined.forEach(v => { freq[v.value] = (freq[v.value] || 0) + 1; });
          const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
          propValues[prop] = { values: vals, dominant, inconsistent: true };
        }

        if (Object.keys(propValues).length > 0) {
          crossPageComparisons.push({
            elementType: elemType,
            sample: pagesWith[0].elements[elemType].samples[0] || null,
            totalPages: pagesWith.length,
            properties: propValues
          });
        }
      }
    }

    // ─── GENERATE CROSS-PAGE ISSUES ───────────────────────────────────────
    // Each issue references the offending page (url) plus the element's
    // selector/bbox so the UI can highlight it on that page's screenshot and
    // apply/ignore the fix.
    const crossPageIssues = [];
    let xpSeq = 0;
    for (const comp of crossPageComparisons) {
      const typeLabel = comp.elementType.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase());
      for (const [prop, info] of Object.entries(comp.properties)) {
        const propLabel = prop.replace(/-/g, ' ').replace(/\b\w/g, s => s.toUpperCase());
        for (const v of info.values) {
          if (!v.value || v.value === info.dominant) continue;
          const pd = pageStyleData.find(x => x.url === v.url);
          const elData = pd && pd.elements && pd.elements[comp.elementType];
          const sample = (elData && elData.samples && elData.samples.find(s => s.props && s.props[prop] === v.value)) || (elData && elData.samples && elData.samples[0]) || null;
          const isColor = /^#([0-9a-f]{3,8}|[0-9a-f]{6})$/i.test(v.value) || /^rgb/.test(v.value) || /^hsl/.test(v.value);
          crossPageIssues.push({
            id: 'xp-issue-' + (xpSeq++),
            ruleId: 'scanall-consistency',
            name: typeLabel + ' ' + propLabel + ' inconsistent',
            severity: (isColor || prop === 'font-size' || prop === 'font-family' || prop === 'padding') ? 'high' : 'medium',
            category: 'cross-page',
            url: v.url,
            detail: propLabel + ' is "' + v.value + '" but the dominant value across the app is "' + info.dominant + '".',
            recommendation: 'Apply the dominant value (' + info.dominant + ') to match the rest of the app.',
            selector: sample ? sample.selector : null,
            bbox: sample ? sample.bbox : null,
            fixCss: (sample && sample.selector) ? (prop + ': ' + info.dominant + ';') : '',
            context: comp.elementType,
            property: prop,
            value: v.value,
            dominant: info.dominant
          });
        }
      }
    }

    console.log(`  [SCAN] Done. ${pageResults.length} pages scanned, ${crossPageComparisons.length} cross-page comparisons, ${crossPageIssues.length} cross-page issues`);

    // Enrich every issue with a specific heading and a plain-language explanation.
    pageResults.forEach(pr => {
      if (pr && Array.isArray(pr.issues)) pr.issues = pr.issues.map(enrichScanAllIssue);
    });
    const scanCrossIssues = crossPageIssues.map(enrichCrossPageIssue);

    res.json({
      totalPages: pageResults.length,
      pages: pageResults,
      crossPageComparisons,
      issues: scanCrossIssues,
    });
  } catch (err) {
    console.error(`  [SCAN] Fatal error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── DISMISSED ISSUES STORE (server-side JSON file) ────────────────────
// Persists ignored/resolved issues so they stay hidden across browsers and
// incognito windows. The file lives at <project>/dismissed-issues.json.
const DISMISSED_FILE = path.join(__dirname, 'dismissed-issues.json');
let dismissedStore = {};
try {
  dismissedStore = JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8'));
} catch (e) {
  dismissedStore = {};
}
function saveDismissedStore() {
  try {
    fs.writeFileSync(DISMISSED_FILE, JSON.stringify(dismissedStore, null, 2));
  } catch (e) {
    console.error('[DISMISSED] Failed to save store:', e.message);
  }
}

app.get('/dismissed', (req, res) => {
  res.json(dismissedStore);
});

app.post('/dismissed', (req, res) => {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object' });
  }
  for (const [url, keys] of Object.entries(body)) {
    if (!Array.isArray(keys)) continue;
    if (!dismissedStore[url]) dismissedStore[url] = [];
    for (const k of keys) {
      if (!dismissedStore[url].includes(k)) dismissedStore[url].push(k);
    }
  }
  saveDismissedStore();
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui-testing-agent.html'));
});
app.get('/ui-testing-agent.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui-testing-agent.html'));
});

// ─── GLOBAL ERROR HANDLER ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ─── START ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`\n  UI Testing Agent running at:`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Open in browser and enter any URL to analyze.\n`);
});
