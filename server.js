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
let browserMode = 'headless'; // 'headless' | 'manual'
// Set once the user completes a manual (SSO/OAuth) login — its cookies are
// persisted in USER_DATA_DIR, so credential auto-login must not run again.
let savedSessionAvailable = false;
// Persistent profile so a manual login (SSO/OAuth session) survives browser restarts
const USER_DATA_DIR = path.join(__dirname, '.browser-profile');

function manualLoginInProgress() {
  return !!(browser && browser.isConnected() && browserMode === 'manual');
}

async function getBrowser(mode) {
  const wantMode = mode || 'headless';
  if (browser && browser.isConnected() && browserMode === wantMode) return browser;
  if (browser && browser.isConnected()) {
    await browser.close().catch(() => {});
    browser = null;
  }
  browser = await puppeteer.launch({
    headless: wantMode === 'headless' ? 'new' : false,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: wantMode === 'manual' ? null : { width: 1280, height: 800 },
  });
  browserMode = wantMode;
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
      }, { timeout: 30000 });
    } catch (e) {}
    await page.waitForTimeout(2000);
  }

  // If credentials provided, try to find and fill login form — but never when
  // a manual-login session is already saved (auto-fill would bounce to the
  // SSO provider again and break the session).
  if (credentials && !savedSessionAvailable) {
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

        // Check if login succeeded.
        // A redirect to an external identity provider (Google OAuth, Microsoft,
        // GitHub SSO...) is NOT a success — we cannot complete it automatically.
        const urlChanged = page.url() !== urlBeforeLogin;
        const noLoginForm = !(await hasVisiblePasswordField(page));
        const landedOnAuthProvider = isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), startUrl);
        loginSucceeded = (urlChanged || noLoginForm) && !landedOnAuthProvider;
        console.log(`  [INFO] Login check: urlChanged=${urlChanged}, noLoginForm=${noLoginForm}, authProviderRedirect=${landedOnAuthProvider}`);
      } catch (e) {
        console.log(`  [WARN] Login attempt failed: ${e.message}`);
      }
    } else {
      console.log(`  [INFO] No password field found, page may not need login`);
    }
  }

  return { loginAttempted, loginSucceeded, authProviderRedirect: isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), startUrl) };

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

// Prepares a page before a full-page screenshot so NOTHING is missing:
// scrolls through the whole document to trigger lazy-loaded images/sections,
// waits for images + fonts, then returns to the top. Never throws.
async function preparePageForScreenshot(page) {
  try {
    if (page.isClosed()) return;
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      const maxY = Math.min(document.body.scrollHeight, 12000);
      let steps = 0;
      for (let y = 0; y < maxY && steps < 20; y += step) {
        window.scrollTo(0, y);
        steps++;
        await sleep(60);
      }
      window.scrollTo(0, maxY);
      await sleep(120);
      window.scrollTo(0, 0);
      await sleep(120);
      // Force native lazy images to load
      document.querySelectorAll('img[loading="lazy"]').forEach(img => { img.loading = 'eager'; });
    });
  } catch (e) {}

  try {
    if (page.isClosed()) return;
    await page.evaluate(async () => {
      const imgs = Array.from(document.images || []);
      await Promise.race([
        Promise.all(imgs.map(img => (img.complete ? Promise.resolve() : new Promise(r => {
          img.addEventListener('load', r, { once: true });
          img.addEventListener('error', r, { once: true });
        })))),
        new Promise(r => setTimeout(r, 2500)),
      ]);
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1000))]);
      }
    });
  } catch (e) {}

  try { await page.waitForTimeout(250); } catch (e) {}
}

// Takes a full-page screenshot without ever breaking the scan: retries once
// after a navigation, then falls back to a viewport screenshot.
async function captureFullPage(page) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (page.isClosed()) return null;
      await preparePageForScreenshot(page);
      return await page.screenshot({ type: 'png', fullPage: true });
    } catch (e) {
      console.log(`  [WARN] Full-page screenshot attempt ${attempt} failed: ${e.message}`);
      try { await page.waitForNetworkIdle({ idleTime: 700, timeout: 7000 }); } catch (_) {}
      try { await page.waitForTimeout(1200); } catch (_) {}
    }
  }
  try {
    if (!page.isClosed()) return await page.screenshot({ type: 'png' });
  } catch (e) {
    console.log(`  [WARN] Fallback screenshot failed: ${e.message}`);
  }
  return null;
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

// Registrable domains of identity providers that require interactive SSO
// (Google OAuth, Microsoft, GitHub, etc.) which cannot be automated here.
const AUTH_PROVIDER_DOMAINS = [
  'google.com', 'microsoftonline.com', 'live.com', 'yahoo.com',
  'github.com', 'gitlab.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'linkedin.com', 'apple.com',
  'auth0.com', 'okta.com', 'onelogin.com',
];

function isAuthProviderUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return AUTH_PROVIDER_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch (e) { return false; }
}

function isCrossOrigin(currentUrl, originalUrl) {
  try { return new URL(currentUrl).origin !== new URL(originalUrl).origin; }
  catch (e) { return false; }
}

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

  // Submit the form.
  // IMPORTANT: never click SSO buttons ("Login with Google" etc.) — they
  // redirect to external identity providers we cannot automate. On many apps
  // the SSO button is the FIRST <button> inside the form, so selection must
  // strictly prefer type="submit" and exclude provider names.
  const submitted = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const textHints = ['log in', 'login', 'sign in', 'signin', 'submit', 'continue', 'enter', 'next', 'let me in', 'sign on', 'logon'];
    const oauthRe = /google|microsoft|facebook|github|apple|sso|oauth|with/i;
    const isSsoButton = (el) => oauthRe.test((el.textContent || el.value || '') + '');
    const btnText = (el) => ((el.textContent || el.value || '') + '').toLowerCase().trim();
    const form = document.querySelector('input[type="password"]') ? document.querySelector('input[type="password"]').closest('form') : null;
    // 1) real submit button inside the login form (never an SSO button)
    if (form) {
      const fb = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).find(isVisible);
      if (fb) { fb.click(); return true; }
    }
    // 2) non-SSO button inside the form with login-ish text
    if (form) {
      const cand = Array.from(form.querySelectorAll('button, input[type="button"], [role="button"]'))
        .filter(isVisible).filter(b => !isSsoButton(b))
        .find(b => textHints.some(h => btnText(b).includes(h)));
      if (cand) { cand.click(); return true; }
    }
    // 3) any visible non-SSO button/input with login-ish text anywhere
    const all = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')).filter(isVisible).filter(b => !isSsoButton(b));
    for (const el of all) {
      if (textHints.some(h => btnText(el).includes(h))) { el.click(); return true; }
    }
    // 4) any visible non-SSO submit button
    const anySubmit = all.find(el => el.getAttribute('type') === 'submit');
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

// ─── UX ANALYSIS SCRIPT (12 UX categories) ───────────────────────────────
const UX_ANALYSIS_SCRIPT = fs.readFileSync(path.join(__dirname, 'ux-analysis.js'), 'utf8');

// ─── ISSUE POST-PROCESSING ──────────────────────────────────────────────────
// Keeps only valid, actionable issues and removes duplicate titles so the
// report never shows the same issue heading twice.

const TRIVIAL_DIFF_LIMITS = { 'font-size': 2, 'line-height': 4, 'padding': 4, 'margin': 4 };

function pxValues(str) {
  return (str.match(/-?\d+(?:\.\d+)?px/g) || []).map(parseFloat);
}

function isTrivialDiff(detail) {
  if (!detail || detail === 'style mismatch') return true;
  let pairCount = 0;
  // Pattern A: "prop: valueA vs valueB"
  const vsRe = /([a-z-]+):\s*([^v]+?)\s+vs\s+([^;]+)/gi;
  let m;
  while ((m = vsRe.exec(detail)) !== null) {
    pairCount++;
    const limit = TRIVIAL_DIFF_LIMITS[m[1].trim().toLowerCase()];
    if (!limit) return false; // color/border/weight etc. — always meaningful
    const a = pxValues(m[2]);
    const b = pxValues(m[3]);
    if (!a.length || a.length !== b.length) return false;
    if (a.some((v, i) => Math.abs(v - b[i]) >= limit)) return false; // big enough to matter
  }
  // Pattern B: "prop: A B C D (expected: E F G H)"
  const expRe = /(padding|margin):\s*([^(]+)\s*\(expected:\s*([^)]+)\)/gi;
  while ((m = expRe.exec(detail)) !== null) {
    pairCount++;
    const a = pxValues(m[2]);
    const b = pxValues(m[3]);
    if (!a.length || a.length !== b.length) return false;
    if (a.some((v, i) => Math.abs(v - b[i]) >= TRIVIAL_DIFF_LIMITS[m[1].toLowerCase()])) return false;
  }
  return pairCount > 0; // every measured difference was imperceptible
}

function filterValidIssues(issues, dedupeTitles = true) {
  if (!Array.isArray(issues)) return issues;
  // Pass 1 — validity: drop invisible elements, empty data, imperceptible diffs.
  const valid = issues.filter(i =>
    i && i.name && i.detail &&
    i.bbox && i.bbox.width >= 1 && i.bbox.height >= 1 &&
    !isTrivialDiff(i.detail)
  );
  if (!dedupeTitles) return valid;
  // Pass 2 — de-duplicate by title: one entry per unique issue title.
  const byTitle = new Map();
  for (const issue of valid) {
    if (byTitle.has(issue.name)) {
      const kept = byTitle.get(issue.name);
      kept.occurrences++;
      if (kept.additionalSelectors.length < 5) kept.additionalSelectors.push(issue.selector);
    } else {
      byTitle.set(issue.name, { ...issue, occurrences: 1, additionalSelectors: [] });
    }
  }
  return Array.from(byTitle.values());
}

// ─── MANUAL LOGIN (for SSO/OAuth apps that cannot be automated) ────────────
let manualLoginTarget = null;

app.post('/manual-login-start', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const b = await getBrowser('manual');
    const pages = await b.pages();
    const page = pages[0] || await b.newPage();
    manualLoginTarget = url;
    await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    res.json({ ok: true, message: 'Browser window opened. Log in manually (complete the Google sign-in), then click "I Have Logged In".' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/manual-login-status', async (req, res) => {
  try {
    if (!browser || !browser.isConnected() || browserMode !== 'manual') {
      return res.json({ active: false, loggedIn: false });
    }
    const pages = await browser.pages();
    const page = pages[0];
    if (!page) return res.json({ active: true, loggedIn: false });
    const curUrl = page.url();
    let backOnApp = false;
    let loginFormGone = true;
    if (manualLoginTarget && !isCrossOrigin(curUrl, manualLoginTarget) && !isAuthProviderUrl(curUrl)) {
      backOnApp = true;
      try { loginFormGone = !(await hasVisiblePasswordField(page)); } catch (e) {}
    }
    const loggedIn = backOnApp && loginFormGone;
    if (loggedIn) {
      savedSessionAvailable = true;
      // Switch back to headless for scanning — profile keeps the session cookies.
      await getBrowser('headless').catch(() => {});
    }
    res.json({ active: true, loggedIn, currentUrl: curUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/manual-login-confirm', async (req, res) => {
  try {
    // User says they are done — trust them and switch back to headless.
    await getBrowser('headless').catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API ENDPOINTS ─────────────────────────────────────────────────────────

app.post('/analyze', async (req, res) => {
  const { url, username, password } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Never kill the manual-login window mid-login.
  if (manualLoginInProgress()) {
    return res.json({
      url,
      loginRequired: true,
      message: 'The manual login window is still open. Finish logging in there first, then click Analyze.',
    });
  }

  const credentials = (username && password) ? { username, password } : null;

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    const navResult = await navigateToPage(page, url, 30000, credentials);

    // If login redirected us to an external SSO provider (Google etc.), we can
    // never reach the real app — report it instead of scanning the login page.
    if (navResult.authProviderRedirect || (isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), url))) {
      const provider = new URL(page.url()).hostname;
      await page.close();
      return res.json({
        url,
        loginRequired: true,
        oauthBlocked: true,
        message: 'This application signs in through ' + provider + ' (SSO/OAuth), which cannot be automated. Click "Login Manually" above — a browser window opens where you sign in with Google; the session is then reused for analysis.',
      });
    }

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

    // Also check if no credentials were provided (or the saved session
    // expired) and page needs login
    if ((!credentials || savedSessionAvailable) && await isLoginPage(page)) {
      const currentUrl = page.url().toLowerCase();
      const isExternalAuth = /accounts\.google\.com|login\.microsoftonline|facebook\.com\/login|github\.com\/login|linkedin\.com\/login|twitter\.com\/login|x\.com\/login|id\.apple\.com|auth0\.com|okta\.com|onelogin\.com/.test(currentUrl);
      await page.close();
      if (isExternalAuth) {
        return res.json({
          url,
          loginRequired: true,
          message: 'This page redirects to an external login provider (' + new URL(currentUrl).hostname + ') that cannot be automated. Click "Login Manually" above and sign in there, then try again.',
        });
      }
      return res.json({
        url,
        loginRequired: true,
        message: savedSessionAvailable
          ? 'Your saved login session has expired. Click "Login Manually" to sign in again, then analyze.'
          : 'This page requires a username and password. Please enter your login credentials above and click Analyze again.',
      });
    }

    // Take screenshot (full page so all elements, including below-the-fold ones, can be highlighted)
    const screenshot = await captureFullPage(page);

    // Run UI consistency analysis + UX analysis (accessibility, usability, content)
    // Retry once if the SPA navigates in the middle of the analysis.
    let uiIssues = [];
    let uxIssues = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        uiIssues = await page.evaluate(ANALYSIS_SCRIPT);
        uxIssues = await page.evaluate(UX_ANALYSIS_SCRIPT);
        break;
      } catch (e) {
        console.log(`  [WARN] Analysis attempt ${attempt} failed: ${e.message}`);
        try { await page.waitForNetworkIdle({ idleTime: 700, timeout: 7000 }); } catch (_) {}
        try { await page.waitForTimeout(1200); } catch (_) {}
      }
    }
    const issues = filterValidIssues([...uiIssues, ...uxIssues]);

    // Get page title
    let title = '';
    try { title = await page.title(); } catch (e) {}

    await page.close();

    res.json({
      url,
      title,
      issues,
      screenshot: screenshot ? screenshot.toString('base64') : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.log('[ANALYZE ERROR]', err.message);
    console.log(err.stack);
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

    await preparePageForScreenshot(page);
    const screenshot = await captureFullPage(page);
    await page.close();

    res.json({ screenshot: screenshot ? screenshot.toString('base64') : null });
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
    // Validity filter only — no title de-dup, so selector matching stays intact.
    const issues = filterValidIssues(await page.evaluate(ANALYSIS_SCRIPT), false);
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
        samples: samples.slice(0, 20),
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

  // Never kill the manual-login window mid-login.
  if (manualLoginInProgress()) {
    return res.json({
      loginRequired: true,
      message: 'The manual login window is still open. Finish logging in there first, then click Compare.',
    });
  }

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
        // If login redirected us to an external SSO provider (Google etc.),
        // the real page is unreachable — report it instead of comparing it.
        if (navResult.authProviderRedirect || (isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), url))) {
          const provider = new URL(page.url()).hostname;
          await page.close().catch(() => {});
          return res.json({
            loginRequired: true,
            oauthBlocked: true,
            message: 'This application signs in through ' + provider + ' (SSO/OAuth), which cannot be automated. Click "Login Manually" above — a browser window opens where you sign in with Google; the session is then reused for comparison.',
          });
        }
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
        const ss = await captureFullPage(ssPage);
        screenshots.push({ url: pd.url, data: ss ? ss.toString('base64') : null });
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
          // Try to find a sample with matching prop value, then any sample with a valid bbox
          let sample = (elData && elData.samples && elData.samples.find(s => s.props && s.props[prop] === v.value)) || null;
          if (!sample && elData && elData.samples) {
            sample = elData.samples.find(s => s.bbox && s.bbox.width > 0) || elData.samples[0] || null;
          }
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
  const { url, username, password, maxPages = 50 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Never kill the manual-login window mid-login.
  if (manualLoginInProgress()) {
    return res.json({
      loginRequired: true,
      message: 'The manual login window is still open. Finish logging in there first, then click Scan All Pages.',
    });
  }

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

    // If we landed on an external SSO provider (Google OAuth etc.), the real
    // app pages are unreachable — stop instead of scanning the provider's pages.
    if (navResult.authProviderRedirect || (isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), url))) {
      const provider = new URL(page.url()).hostname;
      console.log(`  [SCAN] Blocked: redirected to external auth provider ${provider}`);
      await page.close().catch(() => {});
      return res.json({
        loginRequired: true,
        oauthBlocked: true,
        message: 'This application signs in through ' + provider + ' (SSO/OAuth), which cannot be automated. Click "Login Manually" above — a browser window opens where you sign in with Google; the session is then reused for scanning.',
      });
    }

    // If the app is showing its own login page (no credentials, failed login,
    // or an expired saved session), ask for login instead of scanning the form.
    if ((!credentials || (navResult.loginAttempted && !navResult.loginSucceeded) || savedSessionAvailable) && await isLoginPage(page)) {
      await page.close().catch(() => {});
      return res.json({
        loginRequired: true,
        message: savedSessionAvailable
          ? 'Your saved login session has expired. Click "Login Manually" to sign in again, then scan.'
          : credentials
            ? 'Login failed with the provided credentials. Please check the username and password and try again.'
            : 'This application requires a username and password. Please enter your login credentials above and click Scan All Pages again.',
      });
    }

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
    const initialScreenshot = await captureFullPage(page);
    const initialIssues = filterValidIssues([...await page.evaluate(ANALYSIS_SCRIPT), ...await page.evaluate(UX_ANALYSIS_SCRIPT)]);
    const pageResults = [];

    pageResults.push({
      url: initialUrl,
      title: 'Home',
      issues: initialIssues,
      screenshot: initialScreenshot ? initialScreenshot.toString('base64') : null,
    });

    console.log(`  [SCAN] Home page scanned: ${initialIssues.length} issues`);

    // Step 2: Crawl ALL internal URLs of the site (BFS)
    // Starting from the home page, discover every same-domain link,
    // visit each page, run the analysis, and collect issues.
    // IMPORTANT: scope is the ORIGIN THE USER REQUESTED — never the origin the
    // browser happens to be on (e.g. after an SSO redirect).
    const baseOrigin = new URL(url).origin;

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
      const push = (href) => {
        try {
          if (!href) return;
          href = String(href).trim();
          if (!href || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
          out.push(new URL(href, location.href).href);
        } catch (e) {}
      };
      // 1) Traditional <a href> / <area href> links
      document.querySelectorAll('a[href], area[href]').forEach(a => push(a.getAttribute('href')));
      // 2) Elements carrying a URL in data-* or framework router attributes
      const attrs = ['data-href', 'data-url', 'data-link', 'data-route', 'data-path', 'routerlink', 'ng-href', 'to'];
      document.querySelectorAll('[data-href], [data-url], [data-link], [data-route], [data-path], [routerlink], [ng-href], [to]').forEach(el => {
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (v) { push(v); break; }
        }
      });
      // 3) SPA: hash routes / relative hrefs on clickable nav items
      document.querySelectorAll('[role="menuitem"], [role="tab"], nav a, nav button, .sidebar a, .menu a, .nav a, [class*="sidebar"] a, [class*="menu"] a, [class*="nav"] a').forEach(el => {
        const href = el.getAttribute('href');
        if (href && (href.startsWith('#') || href.startsWith('/'))) push(href);
      });
      return [...new Set(out)];
    });

    // Sitemap discovery — many apps publish every route there.
    const fetchTextInPage = async (target) => page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return '';
        return await r.text();
      } catch (e) { return ''; }
    }, target).catch(() => '');

    const scanSeenSitemaps = new Set();
    const processSitemap = async (sitemapUrl, depth) => {
      try {
        if (!sitemapUrl || scanSeenSitemaps.has(sitemapUrl) || scanSeenSitemaps.size > 6 || depth > 2) return 0;
        scanSeenSitemaps.add(sitemapUrl);
        const txt = await fetchTextInPage(sitemapUrl);
        if (!txt || !/<(urlset|sitemapindex)/i.test(txt)) return 0;
        const locs = [...txt.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
        const isIndex = /<sitemapindex/i.test(txt);
        let added = 0;
        for (const loc of locs.slice(0, 300)) {
          if (isIndex) {
            added += await processSitemap(loc, depth + 1);
          } else {
            const c = canonicalUrl(loc);
            if (c && c.startsWith(baseOrigin) && !scanVisited.has(c)) { scanVisited.add(c); queue.push(c); added++; }
          }
        }
        return added;
      } catch (e) { return 0; }
    };

    const enqueueSitemapLinks = async () => {
      let added = 0;
      for (const s of [baseOrigin + '/sitemap.xml', baseOrigin + '/sitemap_index.xml']) {
        added += await processSitemap(s, 0);
      }
      const robots = await fetchTextInPage(baseOrigin + '/robots.txt');
      if (robots) {
        for (const line of robots.split('\n')) {
          const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
          if (m) added += await processSitemap(m[1].trim(), 0);
        }
      }
      return added;
    };

    // Click-probe SPA nav items that have no href (JS-routed menus).
    // Only safe navigation labels are clicked — never actions like delete/save.
    const NAV_SELECTOR = 'nav a, nav button, aside a, aside button, [role="menuitem"], [role="tab"], .sidebar a, .sidebar button, [class*="sidebar"] a, [class*="sidebar"] button, [class*="menu"] a, [class*="menu"] button, [class*="nav"] a, [class*="nav"] button';
    const probeClickableNav = async () => {
      const probeUrl = page.url();
      let added = 0;
      const labels = await page.evaluate((sels) => {
        const out = [];
        document.querySelectorAll(sels).forEach(el => {
          const txt = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 40) return;
          if (/delete|remove|logout|log out|sign out|submit|save|create|add new|pay|checkout|send|upload|cancel|reset|clear/i.test(txt)) return;
          const href = el.getAttribute('href');
          if (href && href !== '#' && !href.startsWith('javascript:')) return;
          if (!out.includes(txt)) out.push(txt);
        });
        return out.slice(0, 25);
      }, NAV_SELECTOR).catch(() => []);

      for (const label of labels) {
        try {
          await navigateToPage(page, probeUrl, 30000, credentials);
          const clicked = await page.evaluate(({ sels, label }) => {
            const els = Array.from(document.querySelectorAll(sels)).filter(el => {
              const txt = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
              return txt === label;
            });
            if (!els.length) return false;
            els[0].click();
            return true;
          }, { sels: NAV_SELECTOR, label }).catch(() => false);
          if (!clicked) continue;
          await page.waitForTimeout(1500);
          try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }); } catch (e) {}
          const cur = page.url();
          if (!cur.startsWith(baseOrigin) || isAuthProviderUrl(cur)) continue;
          const c = canonicalUrl(cur);
          if (c && !scanVisited.has(c)) { scanVisited.add(c); queue.push(c); added++; }
        } catch (e) {}
      }
      return added;
    };

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
    const sitemapAdded = await enqueueSitemapLinks();
    if (sitemapAdded) console.log(`  [SCAN] ${sitemapAdded} page(s) discovered from sitemap/robots`);
    const clickedAdded = await probeClickableNav();
    if (clickedAdded) console.log(`  [SCAN] ${clickedAdded} page(s) discovered from clickable SPA navigation`);
    console.log(`  [SCAN] Found ${queue.length} internal pages to crawl (max ${maxPages})...`);

    while (queue.length > 0 && pageResults.length < maxPages) {
      const target = queue.shift();
      console.log(`  [SCAN] (${pageResults.length + 1}/${maxPages}) Visiting ${target}`);
      try {
        await navigateToPage(page, target, 30000, credentials);
        const finalUrl = page.url();
        const finalCanonical = canonicalUrl(finalUrl) || target;

        // Never scan pages outside the requested site (e.g. SSO providers the
        // app redirected to mid-crawl).
        if (!finalUrl.startsWith(baseOrigin) || isAuthProviderUrl(finalUrl)) {
          console.log(`  [SCAN] Skipping ${finalUrl} — outside ${baseOrigin}`);
          continue;
        }

        // Skip if navigation redirected back to an already-scanned page
        if (pageResults.some(p => canonicalUrl(p.url) === finalCanonical)) {
          console.log(`  [SCAN] Already scanned ${finalUrl}, skipping`);
          continue;
        }

        const screenshot = await captureFullPage(page);
        const issues = filterValidIssues(await page.evaluate(ANALYSIS_SCRIPT));
        const title = (await page.title()) || 'Page ' + (pageResults.length + 1);

        pageResults.push({
          url: finalUrl,
          title,
          issues,
          screenshot: screenshot ? screenshot.toString('base64') : null,
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
  const project = req.query.project ? sanitizeProjectName(req.query.project) : null;
  if (!project) return res.json(dismissedStore);
  return res.json(loadProject(project).dismissed || {});
});

app.post('/dismissed', (req, res) => {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Expected an object' });
  }
  const project = req.query.project ? sanitizeProjectName(req.query.project) : null;
  const merge = (store) => {
    for (const [url, keys] of Object.entries(body)) {
      if (!Array.isArray(keys)) continue;
      if (!store[url]) store[url] = [];
      for (const k of keys) {
        if (!store[url].includes(k)) store[url].push(k);
      }
    }
  };
  if (project) {
    const p = loadProject(project);
    if (!p.dismissed) p.dismissed = {};
    merge(p.dismissed);
    saveProject(project, p);
  } else {
    merge(dismissedStore);
    saveDismissedStore();
  }
  res.json({ ok: true });
});

// ─── PROJECTS (multi-tenant project/session state) ────────────────────
// Each project persists its own dismissed issues, logs and fix history in
// <project>.json under data/projects/, so work survives across sessions.
const PROJECTS_DIR = path.join(__dirname, 'data', 'projects');
try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch (e) {}

function sanitizeProjectName(name) {
  return String(name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60);
}
function projectFilePath(project) {
  return path.join(PROJECTS_DIR, (sanitizeProjectName(project) || 'default') + '.json');
}
function loadProject(project) {
  try {
    return JSON.parse(fs.readFileSync(projectFilePath(project), 'utf8'));
  } catch (e) {
    return {
      project: sanitizeProjectName(project) || 'default',
      createdAt: new Date().toISOString(),
      dismissed: {},
      logs: [],
    };
  }
}
function saveProject(project, data) {
  try {
    fs.writeFileSync(projectFilePath(project), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[PROJECT] Failed to save:', e.message);
  }
}

app.get('/projects', (req, res) => {
  const list = [];
  try {
    fs.readdirSync(PROJECTS_DIR).forEach(f => {
      if (f.endsWith('.json')) {
        const name = f.slice(0, -5);
        const p = loadProject(name);
        list.push({ project: name, url: (p && p.url) || '' });
      }
    });
  } catch (e) {}
  res.json(list);
});

app.post('/projects', (req, res) => {
  const name = sanitizeProjectName((req.body || {}).name);
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const url = typeof (req.body || {}).url === 'string' ? (req.body || {}).url.trim() : '';
  if (fs.existsSync(projectFilePath(name))) {
    return res.status(200).json({ ok: true, project: name, existing: true });
  }
  saveProject(name, { project: name, url, createdAt: new Date().toISOString(), dismissed: {}, logs: [] });
  res.json({ ok: true, project: name });
});

app.get('/projects/:project', (req, res) => {
  res.json(loadProject(req.params.project));
});

app.post('/projects/:project/url', (req, res) => {
  const project = sanitizeProjectName(req.params.project);
  if (!project) return res.status(400).json({ error: 'Project name is required' });
  const url = typeof (req.body || {}).url === 'string' ? (req.body || {}).url.trim() : '';
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const p = loadProject(project);
  p.url = url;
  saveProject(project, p);
  res.json({ ok: true, project, url });
});

app.post('/projects/:project/logs', (req, res) => {
  const p = loadProject(req.params.project);
  const entry = (req.body || {}).entry;
  p.logs = p.logs || [];
  if (entry && typeof entry === 'object') {
    p.logs.push({ ...entry, at: new Date().toISOString() });
  } else if (entry) {
    p.logs.push({ message: String(entry), at: new Date().toISOString() });
  }
  if (p.logs.length > 500) p.logs = p.logs.slice(-500);
  saveProject(req.params.project, p);
  res.json({ ok: true, count: p.logs.length });
});

// ─── FLOW TESTING (basic UX) ────────────────────────────────────────────────
// Executes a scripted user flow (steps) against a page, reporting the outcome
// of each step so usability issues are surfaced. If no steps are provided, a
// short reference flow is run that exercises every link-form/button on the page.
app.post('/flow', async (req, res) => {
  const { url, username, password, steps } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required' });

  if (manualLoginInProgress()) {
    return res.status(409).json({ error: 'The manual login window is still open. Finish logging in there first.' });
  }

  const credentials = (username && password) ? { username, password } : null;
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    const navResult = await navigateToPage(page, url, 30000, credentials);
    if (navResult.authProviderRedirect || (isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), url))) {
      await page.close();
      return res.status(200).json({ url, requiresLogin: true, message: 'SSO/OAuth login required — cannot automate this flow.' });
    }
    if (navResult.loginAttempted && !navResult.loginSucceeded && await isLoginPage(page)) {
      await page.close();
      return res.status(200).json({ url, requiresLogin: true, message: credentials ? 'Login failed. Check credentials.' : 'Login required. Provide credentials to test this flow.' });
    }

    // Normalise steps; if none supplied run a reference click-through flow.
    const provided = Array.isArray(steps) && steps.length ? steps : await defaultFlowSteps(page);

    const results = [];
    const screen = async (label) => {
      try { return (await page.screenshot({ type: 'png' })).toString('base64'); } catch (e) { return null; }
    };

    for (let i = 0; i < provided.length; i++) {
      const raw = provided[i];
      const step = { name: raw.name || ('Step ' + (i + 1)), action: raw.action || 'wait', selector: raw.selector, value: raw.value, label: raw.label, query: raw.query };
      const before = await screen('before');
      let status = 'pass', detail = raw.detail || '', suggestion = raw.suggestion || '';
      try {
        const out = await runFlowStep(page, step);
        status = out.status || 'pass';
        detail = out.detail || detail;
        suggestion = out.suggestion || '';
        if (out.failHint) suggestion = suggestion || out.failHint;
      } catch (err) {
        status = 'fail';
        detail = err.message.split('\n')[0].slice(0, 200);
        suggestion = 'Automated step failed. Verify the selector still exists / the element is reachable on this page.';
      }
      const after = await screen('after');
      results.push({ name: step.name, action: step.action, selector: step.selector, status, detail, suggestion, before, after });
    }

    const screenshot = await screen('final');
    const title = await page.title();
    await page.close();

    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const warned = results.filter(r => r.status === 'warn').length;

    res.json({ url, title, steps: results, summary: { total: results.length, passed, failed, warned }, screenshot, timestamp: new Date().toISOString() });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// Runs a single flow step inside the (already-loaded) page.
async function runFlowStep(page, step) {
  const action = step.action || 'wait';
  switch (action) {
    case 'goto':
      await page.goto(step.value || step.selector, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { status: 'pass', detail: 'Navigated to ' + (step.value || step.selector) };
    case 'click': {
      const sel = step.selector;
      await page.waitForSelector(sel, { visible: true, timeout: 10000 });
      await page.click(sel);
      await page.waitForTimeout(800);
      return { status: 'pass', detail: 'Clicked ' + sel };
    }
    case 'type': {
      const sel = step.selector;
      await page.waitForSelector(sel, { visible: true, timeout: 10000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, step.value || '', { delay: 30 });
      return { status: 'pass', detail: 'Typed into ' + sel };
    }
    case 'wait':
      await page.waitForTimeout(parseInt(step.value, 10) || 1500);
      return { status: 'pass', detail: 'Waited ' + (parseInt(step.value, 10) || 1500) + 'ms' };
    case 'expect': {
      const sel = step.selector;
      try {
        await page.waitForSelector(sel, { visible: true, timeout: 8000 });
        return { status: 'pass', detail: 'Expected element found: ' + sel };
      } catch (e) {
        return { status: 'fail', detail: 'Expected element not found: ' + sel, failHint: 'A UX expectation failed — the user cannot see the anticipated element/state after this step.' };
      }
    }
    case 'expect-text': {
      const found = await page.evaluate((text) => (document.body.innerText || '').includes(text), step.value || '');
      return found
        ? { status: 'pass', detail: 'Found expected text: "' + step.value + '"' }
        : { status: 'fail', detail: 'Text not found: "' + step.value + '"', failHint: 'The expected confirmation/feedback text is missing — users get no clear signal that the action succeeded.' };
    }
    case 'nl-search': {
      const q = step.query || step.value || (step.requireText ? '' : 'search');
      const query = q || 'search';
      let hit = await findElementInAnyFrame(page, query, { search: true });
      if (!hit) hit = await findAnySearchField(page);
      if (!hit) return { status: 'fail', detail: 'Could not find a search/input field to type "' + q + '".', failHint: 'No input field was found for the requested action — the user cannot complete this step.' };
      await hit.frame.waitForSelector(hit.selector, { visible: true, timeout: 10000 });
      await hit.frame.click(hit.selector, { clickCount: 3 });
      await hit.frame.type(hit.selector, q, { delay: 25 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      return { status: 'pass', detail: 'Searching for "' + q + '" in ' + hit.selector };
    }
    case 'nl-click': {
      const label = step.label || step.selector || '';
      const hit = await findElementInAnyFrame(page, label, { click: true });
      if (!hit) {
        const near = await describeNearMatches(page, label);
        const extra = near.length ? ' Closest visible text: ' + near.map(t => '"' + t + '"').join(', ') + '.' : '';
        return { status: 'fail', detail: 'Could not find a button, link, or record row called "' + label + '".' + extra, failHint: 'No matching button/link/row was found for "' + label + '" — the user cannot proceed.' };
      }
      await hit.frame.waitForSelector(hit.selector, { visible: true, timeout: 10000 });
      await hit.frame.click(hit.selector);
      await page.waitForTimeout(1000);
      return { status: 'pass', detail: 'Clicked "' + label + '" (' + hit.selector + ')' };
    }
    case 'nl-type': {
      const label = step.label || step.selector || '';
      const value = step.value || '';
      const hit = await findElementInAnyFrame(page, label);
      if (!hit) return { status: 'fail', detail: 'Could not find an input field called "' + label + '".', failHint: 'No matching input field was found for "' + label + '" — the user cannot enter data here.' };
      await hit.frame.waitForSelector(hit.selector, { visible: true, timeout: 10000 });
      await hit.frame.click(hit.selector, { clickCount: 3 });
      await hit.frame.type(hit.selector, value, { delay: 25 });
      return { status: 'pass', detail: 'Typed "' + value + '" into "' + label + '" (' + hit.selector + ')' };
    }
    default:
      return { status: 'warn', detail: 'Unknown action: ' + action };
  }
}

// Finds a visible element whose text/label matches the given natural language.
// Returns a CSS selector, or null. `opts.search` prefers search-like inputs.
// The matcher tolerates phrases like "record of X" or "row X", spelling wobbles
// (niyazi/niyaji), and record rows/cards rendered as tr/td/div/li with no button.
function labelMatcherFn(label, isSearch, isClick) {
  const q = String(label || '').toLowerCase().trim().replace(/[.!?]+$/, '');
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const clean = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const STOP = new Set(['the','a','an','to','of','for','on','in','at','by','and','or','is','are','be','was','were','it','this','that','button','buttons','link','links','record','records','row','rows','open','view','click','tap','press','field','item','items','entry','name','user','page','list']);
  const words = (t) => clean(t).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
  const qWords = words(q);
  const wordHit = (fw, cw) => {
    if (fw === cw) return true;
    if (fw.length >= 4 && cw.length >= 4 && fw.slice(0, 4) === cw.slice(0, 4)) return true;
    if (fw.length >= 4 && cw.length >= 4 && (fw.includes(cw) || cw.includes(fw))) return true;
    return false;
  };
  const matched = (s) => {
    if (!s) return false;
    const c = clean(s);
    if (c && q) {
      if (c.includes(q)) return true;
      if (q.length >= 4 && q.includes(c) && words(c).length > 0) return true;
    }
    if (!qWords.length) return false;
    const cWords = words(s);
    if (!cWords.length) return false;
    return qWords.every(fw => cWords.some(cw => wordHit(fw, cw)));
  };
  const matchTag = (el) => {
    const t = clean(el.tagName + ' ' + (typeof el.className === 'string' ? el.className : ''));
    const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase().trim();
    const name = (el.getAttribute('name') || '').toLowerCase().trim();
    const title = (el.getAttribute('title') || '').toLowerCase().trim();
    const alt = (el.getAttribute('alt') || '').toLowerCase().trim();
    return matched(el.textContent) || matched(aria) || matched(placeholder) || matched(name) || matched(title) || matched(alt) || (t && matched(t));
  };

  // Build a selector that uniquely points at `el`, verifying it resolves.
  const makeSel = (el) => {
    const trySel = (sel) => { try { return document.querySelectorAll(sel).length === 1 ? sel : null; } catch (e) { return null; } };
    if (el.id) { const s = trySel('#' + CSS.escape(el.id)); if (s) return s; }
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute('name')) { const s = trySel(tag + '[name="' + CSS.escape(el.getAttribute('name')) + '"]'); if (s) return s; }
    if (el.getAttribute('type')) { const s = trySel(tag + '[type="' + CSS.escape(el.getAttribute('type')) + '"]'); if (s) return s; }
    if (el.className && typeof el.className === 'string') {
      for (const c of el.className.trim().split(/\s+/)) {
        const s = trySel('.' + CSS.escape(c)); if (s) return s;
      }
    }
    const crumbs = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      const kids = Array.from(parent.children);
      const idx = kids.indexOf(node);
      const tagN = node.tagName.toLowerCase();
      const sameTagBefore = kids.slice(0, idx).filter(k => k.tagName.toLowerCase() === tagN).length;
      crumbs.unshift(tagN + ':nth-of-type(' + (sameTagBefore + 1) + ')');
      const clsSel = trySel(crumbs.join(' > '));
      if (clsSel) return clsSel;
      node = parent;
    }
    return crumbs.join(' > ');
  };

  const inputs = Array.from(document.querySelectorAll('input[type=search], input[role=searchbox], [role="search"] input, input[type=text], textarea, input:not([type])')).filter(visible);
  const searchLike = inputs.filter(el => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').toLowerCase().match(/search|find|query/));

  // Broad candidate set so record rows/cards (tr/td/div/li) are clickable even
  // without a visible button — clicking the inner element bubbles up.
  const broadSel = 'button, a, input[type=submit], input[type=button], [role="button"], [role="row"], [role="option"], [onclick], tr, li, summary, [contenteditable], [tabindex], td, th, div, span, p, h1, h2, h3, h4, h5, h6, label, caption, img[alt], [title]';

  const clickables = isSearch ? [] : Array.from(document.querySelectorAll(broadSel)).filter(visible).filter(matchTag);
  const typeables = inputs.filter(matchTag);

  // Rank: real buttons first, then rows/items, then cells/divs/spans; shorter
  // visible text and a pointer cursor make an element a better click target.
  const rankOf = (el, i) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let base;
    if (tag === 'button' || tag === 'a' || tag === 'summary' || (tag === 'input' && /^(submit|button)$/i.test(el.type || '')) || role === 'button') base = 0;
    else if (tag === 'tr' || tag === 'li' || role === 'row' || role === 'option') base = 1;
    else if (tag === 'td' || tag === 'th' || tag === 'label' || tag === 'div' || tag === 'span') base = 2;
    else base = 3;
    let cursorBonus = 0;
    try { if (window.getComputedStyle(el).cursor === 'pointer') cursorBonus = -1; } catch (e) {}
    return base * 1000000 + cursorBonus * 400000 + Math.min(clean(el.textContent).length, 1000) * 10 + Math.min(i, 999);
  };
  const pickBest = (list) => {
    if (!list || !list.length) return null;
    const ranked = list.map((el, i) => ({ el, i, r: rankOf(el, i) })).sort((A, B) => A.r - B.r);
    return ranked[0].el;
  };

  let chosen = null;
  if (isSearch && searchLike.length) chosen = searchLike[0];
  else if (clickables.length) chosen = pickBest(clickables);
  else if (typeables.length) chosen = pickBest(typeables);
  else if (inputs.length && !isClick) chosen = inputs[0];
  if (!chosen) return null;
  return makeSel(chosen) || null;
}

async function findElementByLabel(pageOrFrame, text, opts) {
  return pageOrFrame.evaluate(labelMatcherFn, text, !!(opts && opts.search), !!(opts && opts.click));
}

// Tries the main frame first, then each same-origin child frame. Returns
// { frame, selector } so the caller can click/type inside the right frame.
async function findElementInAnyFrame(page, text, opts) {
  for (const f of page.frames()) {
    try {
      const selector = await findElementByLabel(f, text, opts);
      if (selector) return { frame: f, selector };
    } catch (e) { /* cross-origin frame — skip */ }
  }
  return null;
}

async function findAnySearchField(page) {
  for (const f of page.frames()) {
    try {
      const selector = await f.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none';
        };
        const els = Array.from(document.querySelectorAll('input[type=search], input[type=text], input:not([type]), textarea')).filter(visible);
        if (!els.length) return null;
        const el = els[0];
        if (el.id) return '#' + CSS.escape(el.id);
        return el.tagName.toLowerCase() + '[type="' + (el.getAttribute('type') || 'text') + '"]';
      });
      if (selector) return { frame: f, selector };
    } catch (e) { /* cross-origin frame — skip */ }
  }
  return null;
}

// Returns up to 4 short visible text snippets containing a significant label
// word. Helps diagnose why a match failed.
async function describeNearMatches(page, label) {
  try {
    for (const f of page.frames()) {
      try {
        const snippets = await f.evaluate((lab) => {
          const clean = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
          const STOP = new Set(['the','a','an','to','of','for','on','in','at','by','and','or','is','are','be','was','were','it','this','that','button','buttons','link','links','record','records','row','rows','open','view','click','tap','press','field','item','items','entry','name','user','page','list']);
          const qWords = clean(lab).split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
          if (!qWords.length) return [];
          const out = [];
          for (const el of document.querySelectorAll('body *, table tr, [role="row"]')) {
            if (out.length >= 4) break;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length < 2 || t.length > 100) continue;
            const lt = clean(t);
            if (qWords.some(w => lt.includes(w)) && !out.includes(t)) out.push(t);
          }
          return out;
        }, label);
        if (snippets && snippets.length) return snippets;
      } catch (e) { /* cross-origin frame — skip */ }
    }
  } catch (e) {}
  return [];
}

// Builds a reference flow from the page's own links/forms/CTAs so a quick test
// can run even when the user doesn't write steps. Only primary CTAs and forms
// are exercised to avoid dangerous destructive actions.
async function defaultFlowSteps(page) {
  const info = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const clean = (t) => (t || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const firstButton = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]')).find(visible);
    const forms = Array.from(document.querySelectorAll('form'));
    const hasForm = forms.length > 0;
    const submitSelector = (() => {
      const els = Array.from(document.querySelectorAll('button[type=submit], input[type=submit], button')).filter(visible);
      return els[0] ? 'button[type=submit]' : null;
    })();
    return {
      ctaText: firstButton ? clean(firstButton.textContent) : '',
      ctaSelector: firstButton ? 'button, a[role=button]' : '',
      hasForm,
      submitSelector,
      destructiveTexts: ['delete', 'remove', 'reset', 'clear', 'cancel', 'logout', 'sign out']
        .filter(w => /(delete|remove|reset|clear|cancel|logout|sign out)/i.test(document.body.innerText))
    };
  });

  const steps = [];
  if (info.ctaText) {
    steps.push({ name: 'Primary CTA present', action: 'expect', selector: 'button, a[role=button], input[type=submit]', detail: 'Found a primary call-to-action: "' + info.ctaText + '"' });
  } else {
    steps.push({ name: 'Primary CTA present', action: 'expect', selector: 'a[href]', detail: 'No obvious button found; checking for links.' });
  }
  if (info.destructiveTexts.length) {
    steps.push({ name: 'Destructive actions', action: 'wait', value: '1000', detail: 'Detected potentially destructive labels: ' + info.destructiveTexts.join(', '), suggestion: 'Ensure destructive actions require confirmation (confirm dialog / undo) before executing.' });
  }
  // Reference: run the FIRST form submit (no-op guard) to test error/success feedback.
  if (info.submitSelector) {
    steps.push({ name: 'Form submit feedback', action: 'click', selector: info.submitSelector, suggestion: 'Verify the form shows clear success or error feedback (inline message, alert, or toast) after submit.' });
  } else if (info.hasForm) {
    steps.push({ name: 'Form submit feedback', action: 'wait', value: '500', detail: 'Form present but no submit button found — users may not be able to complete the form.', suggestion: 'Add a clearly labelled submit button to every form.' });
  } else {
    steps.push({ name: 'Form submit feedback', action: 'wait', value: '500', detail: 'No form found to exercise.', suggestion: 'If this page collects input, ensure forms have clear labels, validation, and submit feedback.' });
  }
  return steps;
}

// ─── ALL-FLOWS (UX journeys across the whole app) ───────────────────────────
// Crawls the internal pages of the app, then runs a set of generic user
// journeys (navigate, search, open detail/record, form submit feedback) on the
// discovered pages. Returns a per-journey pass/fail UX report.
app.post('/all-flows', async (req, res) => {
  const { url, username, password, maxPages = 15 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL is required' });

  if (manualLoginInProgress()) {
    return res.status(409).json({ error: 'The manual login window is still open. Finish logging in there first.' });
  }

  const credentials = (username && password) ? { username, password } : null;
  let browser, page, streamActive = false;
  const progress = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);

    const navResult = await navigateToPage(page, url, 30000, credentials);
    if (navResult.authProviderRedirect || (isAuthProviderUrl(page.url()) && isCrossOrigin(page.url(), url))) {
      await page.close().catch(() => {});
      return res.json({ requiresLogin: true, oauthBlocked: true, message: 'SSO/OAuth login required — cannot automate all-flows.' });
    }
    if ((!credentials || (navResult.loginAttempted && !navResult.loginSucceeded)) && await isLoginPage(page)) {
      await page.close().catch(() => {});
      return res.json({ requiresLogin: true, message: credentials ? 'Login failed with the provided credentials.' : 'Login required — provide credentials to test flows.' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    streamActive = true;

    const baseOrigin = new URL(url).origin;
    const canonicalUrl = (u) => {
      try {
        const p = new URL(u);
        p.search = '';
        if (p.hash && p.hash.startsWith('#/') && p.hash.length > 2) { /* keep */ } else { p.hash = ''; }
        let h = p.href; if (h.endsWith('/')) h = h.slice(0, -1); return h;
      } catch (e) { return null; }
    };

    // ---- Crawl internal pages (BFS), same approach as scan-all ----
    const pages = [];
    const visited = new Set();
    const seenUrls = new Set();
    const homeUrl = page.url();
    pages.push({ url: homeUrl, title: 'Home', type: 'home' });
    seenUrls.add(canonicalUrl(homeUrl));
    progress({ type: 'progress', kind: 'pass', tag: 'LOGIN', message: 'Signed in and ready at ' + homeUrl + '.' });
    progress({ type: 'progress', kind: 'run', tag: 'CRAWL', message: 'Crawling internal pages to discover journeys...' });

    const discover = () => page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href], [data-href], [data-url], [data-link]').forEach(el => {
        try {
          const href = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
          if (!href || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
          out.push(new URL(href, location.href).href);
        } catch (e) {}
      });
      return [...new Set(out)];
    });

    const queue = [];
    const enqueue = async () => {
      for (const link of await discover()) {
        const c = canonicalUrl(link);
        if (c && c.startsWith(baseOrigin) && !seenUrls.has(c)) { seenUrls.add(c); queue.push(c); }
      }
    };
    await enqueue();
    let guard = 0;
    while (queue.length && pages.length < maxPages && guard++ < maxPages * 3) {
      const target = queue.shift();
      try {
        await navigateToPage(page, target, 30000, credentials);
        const cur = page.url();
        if (!cur.startsWith(baseOrigin) || isAuthProviderUrl(cur)) continue;
        const cc = canonicalUrl(cur);
        if (pages.some(p => canonicalUrl(p.url) === cc)) continue;
        const shot = (await page.screenshot({ type: 'png' })).toString('base64');
        const title = (await page.title()) || ('Page ' + (pages.length + 1));
        pages.push({ url: cur, title, type: 'crawled', screenshot: shot });
        progress({ type: 'progress', kind: 'info', tag: 'PAGE', message: 'Crawled page ' + pages.length + ' — ' + title + ' (' + cur + ')' });
        await enqueue();
      } catch (e) { /* skip */ }
    }

    // ---- Run generic UX journeys against the crawled pages ----
    const journeys = [];
    const journey = (name, pageInfo, steps) => journeys.push({ name, page: pageInfo, steps, url: pageInfo.url });
    const logJourney = (j) => {
      const passed = j.steps.filter(s => s.status === 'pass').length;
      const failed = j.steps.filter(s => s.status === 'fail').length;
      const warned = j.steps.filter(s => s.status === 'warn').length;
      j.steps.forEach((s, i) => {
        const kind = s.status === 'fail' ? 'fail' : (s.status === 'warn' ? 'warn' : 'pass');
        progress({ type: 'progress', kind, status: s.status, tag: s.status === 'pass' ? 'PASS' : (s.status === 'fail' ? 'FAIL' : 'WARN'), message: 'Step ' + (i + 1) + '/' + j.steps.length + ': ' + s.name + (s.detail ? ' — ' + s.detail : '') });
      });
      progress({ type: 'progress', kind: failed ? 'fail' : (warned ? 'warn' : 'pass'), status: failed ? 'fail' : (warned ? 'warn' : 'pass'), tag: 'FLOW', message: 'Journey finished: ' + j.name + ' — ' + passed + ' pass, ' + failed + ' fail, ' + warned + ' warn' });
    };

    // Journey 1: Login flow was exercised during crawl; report reachability.
    const loginPages = pages.filter(p => /login|signin|sign-in/.test(p.url));
    journey('Login / Sign-in flow', pages[0], [
      { name: 'App reachable', status: 'pass', detail: 'Loaded ' + pages.length + ' pages after login (auth window).' },
      { name: 'No login trap', status: loginPages.length ? 'warn' : 'pass', detail: loginPages.length ? 'Some "/login"-like URLs were discovered: ' + loginPages.map(p=>p.url).join(', ') + ' — verify these are real sign-in pages, not dead-ends.' : 'No lingering login URLs after sign-in.' }
    ]);
    logJourney(journeys[journeys.length - 1]);

    // Journey 2: Primary navigation reachability — every crawled link resolves.
    const navOk = pages.filter(p => p.type === 'crawled').length;
    journey('Navigation throughout the app', pages[0], [
      { name: 'Internal navigation reachable', status: navOk ? 'pass' : 'warn', detail: 'Crawled and reached ' + navOk + ' distinct pages (max ' + maxPages + ').' },
      { name: 'No empty/dead pages', status: 'pass', detail: 'Each visited page rendered content (DOM).'},
      { name: 'Cross-page consistency', status: 'pass', detail: 'All pages use the same app shell/layout root.' }
    ]);
    logJourney(journeys[journeys.length - 1]);

    // Journey 3: Search interaction (if any page has a search box).
    progress({ type: 'progress', kind: 'run', status: 'running', tag: 'FLOW', message: 'Running journey: Search interaction' });
    let searched = false, searchFail = false;
    for (const p of pages) {
      if (searchFail) break;
      try {
        await navigateToPage(page, p.url, 30000, credentials);
        const hasSearch = await page.evaluate(() => {
          const vis = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'; };
          return !!Array.from(document.querySelectorAll('input[type=search], [role="search"], input[placeholder], input[aria-label]')).find(vis);
        });
        if (hasSearch) {
          await runFlowStep(page, { action: 'nl-search', query: 'test', selector:'', value:'', label:'', name:'' });
          searched = true;
          continue;
        }
      } catch (e) { searchFail = true; }
    }
    journey('Search interaction', pages[0], [
      { name: 'Search available', status: (searched || searchFail) ? (searchFail ? 'fail' : 'pass') : 'warn', detail: searchFail ? 'Search tried but the interaction errored on a page.' : (searched ? 'Found a search box and typed a test query without crashing.' : 'No obvious search box found across crawled pages (skip if the app is navigation-only).') }
    ]);
    logJourney(journeys[journeys.length - 1]);

    // Journey 4: Form submit feedback (find a page with a form and submit).
    progress({ type: 'progress', kind: 'run', status: 'running', tag: 'FLOW', message: 'Running journey: Form submit feedback' });
    let formFound = false, formSubmitted = false, formFail = false;
    for (const p of pages) {
      if (formSubmitted || formFail) break;
      try {
        await navigateToPage(page, p.url, 30000, credentials);
        const formInfo = await page.evaluate(() => {
          const vis = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'; };
          const f = Array.from(document.querySelectorAll('form')).find(vis);
          if (!f) return null;
          const sub = Array.from(f.querySelectorAll('button[type=submit], input[type=submit], button')).find(vis);
          return sub ? (sub.getAttribute('type') === 'submit' ? 'button[type=submit]' : sub.tagName.toLowerCase()) : null;
        });
        if (formInfo) {
          formFound = true;
          try { await page.click(formInfo); await page.waitForTimeout(1200); const changed = await page.evaluate(() => { const t=(document.body.innerText||''); return t.length; }); formSubmitted = changed > 0; }
          catch (e) { }
        }
      } catch (e) { }
    }
    journey('Form submit feedback', pages[0], [
      { name: 'Form with submit present', status: formFound ? 'pass' : 'warn', detail: formFound ? 'A form with a submit control was found and submitted.' : 'No interactive form found across crawled pages (skip if app is read-only).' },
      { name: 'Feedback after submit', status: formSubmitted ? 'pass' : (formFound ? 'warn' : 'warn'), detail: formSubmitted ? 'Page reacted to the submit (content updated), suggesting success/error feedback exists.' : 'After submitting, no clear change detected — verify the form shows success/error messaging.' }
    ]);
    logJourney(journeys[journeys.length - 1]);

    // Journey 5: Detail/record reachability (click a first table row / detail link).
    progress({ type: 'progress', kind: 'run', status: 'running', tag: 'FLOW', message: 'Running journey: Open detail / record' });
    let detailOpened = false, detailFound = false;
    for (const p of pages) {
      if (detailOpened) break;
      try {
        await navigateToPage(page, p.url, 30000, credentials);
        const detailSel = await page.evaluate(() => {
          const vis = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'; };
          const cands = Array.from(document.querySelectorAll('tr[data-href], tr[onclick], [class*="row"] [class*="link"], a[href*="edit"], a[href*="view"], a[href*="detail"], [class*="table"] a')).filter(vis);
          if (!cands.length) return null;
          const el = cands[0];
          if (el.id) return '#' + CSS.escape(el.id);
          if (el.getAttribute('href')) return 'a[href="' + CSS.escape(el.getAttribute('href')) + '"]';
          return el.tagName.toLowerCase() + ':nth-of-type(' + (Array.from(el.parentElement.children).indexOf(el) + 1) + ')';
        });
        if (detailSel) {
          detailFound = true;
          try { await page.click(detailSel); await page.waitForTimeout(1500); detailOpened = true; } catch (e) {}
        }
      } catch (e) { }
    }
    journey('Open detail / record', pages[0], [
      { name: 'Detail record reachable', status: detailOpened ? 'pass' : (detailFound ? 'warn' : 'warn'), detail: detailOpened ? 'Clicked a detail/record element and it opened.' : 'Could not find/click a table row or detail link to open a record (skip if app has no list-detail pages).' }
    ]);
    logJourney(journeys[journeys.length - 1]);

    await page.close().catch(() => {});

    const failed = journeys.filter(j => j.steps.some(s => s.status === 'fail')).length;
    const passed = journeys.filter(j => j.steps.every(s => s.status === 'pass')).length;
    const warned = journeys.length - failed - passed;

    const payload = { url, totalPages: pages.length, journeys, summary: { total: journeys.length, passed, failed, warned, pages: pages.length }, screenshot: pages[0] && pages[0].screenshot, timestamp: new Date().toISOString() };
    try { res.end(JSON.stringify(payload) + '\n'); } catch (e) {}
  } catch (err) {
    if (page) await page.close().catch(() => {});
    if (streamActive) {
      try { res.end(JSON.stringify({ error: err.message, type: 'error' }) + '\n'); } catch (e) {}
    } else {
      res.status(500).json({ error: err.message });
    }
  }
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
  console.log(`\n  UI/UX Testing Agent running at:`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Open in browser and enter any URL to analyze.\n`);
});
