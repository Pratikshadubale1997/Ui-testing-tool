const express = require('express');
const cors = require('cors');
const path = require('path');

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
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

  // Wait for SPA redirects/auth checks to settle (up to 15s)
  let lastUrl = '';
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const curUrl = page.url();
    if (curUrl === lastUrl) break;
    lastUrl = curUrl;
  }

  // If redirected to login and credentials provided, attempt login
  if (page.url().includes('/login') && credentials) {
    console.log(`  [INFO] On login page, attempting login...`);
    try {
      // Find username/email field
      const usernameSel = await page.evaluate(() => {
        const selectors = [
          'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
          'input[name="user"]', 'input[name="login"]', 'input[id*="email" i]',
          'input[id*="user" i]', 'input[placeholder*="email" i]',
          'input[placeholder*="user" i]', 'input[placeholder*="login" i]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return sel;
        }
        return null;
      });

      // Find password field
      const passwordSel = await page.evaluate(() => {
        const el = document.querySelector('input[type="password"]');
        return el ? 'input[type="password"]' : null;
      });

      if (usernameSel && passwordSel) {
        await page.type(usernameSel, credentials.username, { delay: 50 });
        await page.type(passwordSel, credentials.password, { delay: 50 });

        // Find and click submit button
        await page.evaluate(() => {
          const btnSelectors = [
            'button[type="submit"]', 'input[type="submit"]',
            'button:not([type="button"])', '.btn-primary', '.login-btn',
            'button.login', 'button[type="submit"]'
          ];
          for (const sel of btnSelectors) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return; }
          }
          // Fallback: find button with login/sign-in text
          document.querySelectorAll('button').forEach(b => {
            const text = b.textContent.toLowerCase();
            if (text.includes('login') || text.includes('sign in') || text.includes('log in')) {
              b.click();
            }
          });
        });

        // Wait for redirect after login
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(1000);
          if (!page.url().includes('/login')) {
            console.log(`  [INFO] Login successful, redirected to: ${page.url()}`);
            break;
          }
        }

        // Wait for network to settle after login
        try {
          await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
        } catch (e) {}
      } else {
        console.log(`  [WARN] Could not find login form fields on page`);
      }
    } catch (e) {
      console.log(`  [WARN] Login attempt failed: ${e.message}`);
    }
  }

  // Try to wait for network to settle (non-fatal if it fails)
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
  } catch (e) {}

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

    await navigateToPage(page, url, 30000, credentials);

    // Take screenshot
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

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
          visible: rect.width > 0 && rect.height > 0
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

    // If credentials provided, login once before navigating to pages
    if (credentials) {
      console.log(`  [LOGIN] Logging in as ${credentials.username}...`);
      const baseUrl = urls[0].split('#')[0];
      await page.goto(baseUrl + '#/login', { waitUntil: 'domcontentloaded' });
      // Wait for Vue form to render
      try { await page.waitForSelector('#email', { timeout: 25000 }); } catch(e) {}
      const hasForm = await page.evaluate(() => !!document.getElementById('email'));
      if (hasForm) {
        await page.evaluate((c) => {
          const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          ns.call(document.getElementById('email'), c.username);
          document.getElementById('email').dispatchEvent(new Event('input', { bubbles: true }));
          ns.call(document.getElementById('password'), c.password);
          document.getElementById('password').dispatchEvent(new Event('input', { bubbles: true }));
        }, credentials);
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Login');
          if (btn) btn.click();
        });
        // Wait for login to complete
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (!page.url().includes('/login')) break;
        }
        console.log(`  [LOGIN] Login complete. URL: ${page.url()}`);
      }
    }

    // Navigate to each URL (session already established)
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
    await navigateToPage(page, url, 30000, credentials);
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
        await navigateToPage(ssPage, pd.url);
        const ss = await ssPage.screenshot({ type: 'png', fullPage: false });
        screenshots.push({ url: pd.url, data: ss.toString('base64') });
        await ssPage.close().catch(() => {});
      } catch (e) {
        screenshots.push({ url: pd.url, data: null });
      }
    }

    // ─── GENERATE SUGGESTIONS ──────────────────────────────────────────────
    const suggestions = generateSuggestions(pageData, comparisons);
    res.json({ pages: pageData, comparisons, screenshots, suggestions });
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
app.post('/compare-screenshots', upload.fields([
  { name: 'screenshot1', maxCount: 1 },
  { name: 'screenshot2', maxCount: 1 }
]), async (req, res) => {
  try {
    const buf1 = req.files.screenshot1[0].buffer;
    const buf2 = req.files.screenshot2[0].buffer;

    // Use built-in child_process to get image dimensions (Windows certutil base64 fallback)
    const { spawn } = require('child_process');

    // Get dimensions by reading PNG headers directly (no sharp needed)
    function getPNGDimensions(buf) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        return { width: w, height: h };
      }
      // JPEG
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

    const d1 = getPNGDimensions(buf1);
    const d2 = getPNGDimensions(buf2);
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

    res.json({
      img1: buf1.toString('base64'),
      img2: buf2.toString('base64'),
      dimensions1: dimStr(d1),
      dimensions2: dimStr(d2),
      dimensionsMatch: d1.width === d2.width && d1.height === d2.height,
      suggestions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVE FRONTEND ────────────────────────────────────────────────────────

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
    await navigateToPage(page, url, 30000, credentials);

    // Wait for SPA to fully load
    try { await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }); } catch (e) {}
    await page.waitForTimeout(3000);

    if (page.url().includes('/login') && credentials) {
      console.log(`  [SCAN] Still on login, waiting more...`);
      await page.waitForTimeout(5000);
    }

    console.log(`  [SCAN] Logged in. Current URL: ${page.url()}`);

    // Step 1b: Analyze the home/landing page first
    const initialUrl = page.url();
    const initialScreenshot = await page.screenshot({ type: 'png', fullPage: false });
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
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const href = a.getAttribute('href');
          if (!href || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
          out.push(new URL(href, location.href).href);
        } catch (e) {}
      });
      return out;
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

        const screenshot = await page.screenshot({ type: 'png', fullPage: false });
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
    if (pageResults.length >= 2) {
      const pageStyleData = [];

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

    console.log(`  [SCAN] Done. ${pageResults.length} pages scanned, ${crossPageComparisons.length} cross-page comparisons`);

    res.json({
      totalPages: pageResults.length,
      pages: pageResults,
      crossPageComparisons,
    });
  } catch (err) {
    console.error(`  [SCAN] Fatal error: ${err.message}`);
    res.status(500).json({ error: err.message });
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
  console.log(`\n  UI Testing Agent running at:`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Open in browser and enter any URL to analyze.\n`);
});
