// UX Analysis Script - runs inside page context via page.evaluate()
// Covers: Navigation, User Flow, Button/CTA, Form Usability, Search,
// Error Handling, Loading & Status, Consistency, Responsive UX,
// Keyboard Navigation, Accessibility, Task Completion
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
        const classes = cur.className.trim().split(/\s+/).filter(c => !c.startsWith('issue-')).slice(0, 2);
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
      let node = el;
      let r = node.getBoundingClientRect();
      while (node && node.nodeType === 1 && (r.width < 1 || r.height < 1)) {
        node = node.parentElement;
        r = node ? node.getBoundingClientRect() : r;
      }
      if (r.width >= 1 && r.height >= 1) {
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      }
    } catch (e) {}
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  function addIssue(ruleId, name, severity, category, el, detail, suggestion, fixCss) {
    let bbox = getBBox(el);
    let elText = '';
    try { elText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60); } catch (e) {}
    issues.push({
      id: 'ux-issue-' + (issueId++),
      ruleId, name, severity, category,
      selector: getUniqueSelector(el),
      detail, recommendation: suggestion,
      fixCss: fixCss || '', elText, bbox,
    });
  }

  // =====================================================================
  // 1. NAVIGATION
  // =====================================================================
  (() => {
    const nav = document.querySelector('nav, [role="navigation"], [class*="nav"], [class*="sidebar"], [class*="menu"]');
    if (!nav) {
      const links = document.querySelectorAll('a[href]');
      if (links.length > 5) {
        addIssue('ux-no-nav-region', 'No Navigation Landmark',
          'medium', 'navigation', document.body,
          'This page has ' + links.length + ' links but no <nav> or role="navigation" landmark. Screen readers use landmarks for quick navigation.',
          'Wrap the main navigation links in a <nav> element.');
      }
    }
    if (nav) {
      let depth = 0;
      let cur = nav;
      while (cur) {
        const sub = cur.querySelector('nav, [role="navigation"], ul ul');
        if (sub && sub !== cur) { depth++; cur = sub; } else break;
      }
      if (depth > 3) {
        addIssue('ux-deep-nav', 'Deeply Nested Navigation',
          'medium', 'navigation', nav,
          'Navigation is nested ' + depth + ' levels deep. Deep navigation makes it harder for users to find content.',
          'Flatten the navigation to 2-3 levels max. Consider using mega menus or breadcrumbs for deeper content.');
      }
    }
    const urlPath = location.pathname;
    const pathDepth = urlPath.split('/').filter(Boolean).length;
    if (pathDepth >= 3 && !document.querySelector('[aria-label*="breadcrumb"], [class*="breadcrumb"], ol.breadcrumb')) {
      const firstLink = document.querySelector('a[href]');
      if (firstLink) {
        addIssue('ux-no-breadcrumbs', 'Missing Breadcrumbs on Deep Page',
          'low', 'navigation', firstLink,
          'This page is ' + pathDepth + ' levels deep but has no breadcrumb navigation.',
          'Add a breadcrumb trail showing the page hierarchy (e.g., Home > Category > Page).');
      }
    }
    document.querySelectorAll('a[href]').forEach(a => {
      if (!isVisible(a)) return;
      const href = a.getAttribute('href') || '';
      if (href.startsWith('http') && !href.includes(location.hostname)) {
        const hasIndicator = a.querySelector('[class*="external"], [class*="icon"]') || a.getAttribute('target') === '_blank';
        if (!hasIndicator && (a.textContent || '').trim().length > 0) {
          addIssue('ux-no-external-indicator', 'External Link Without Indicator',
            'low', 'navigation', a,
            'This link goes to an external site but has no visual indicator.',
            'Add an external link icon or "(opens in new tab)" text for external links.');
        }
      }
    });
  })();

  // =====================================================================
  // 2. USER FLOW
  // =====================================================================
  (() => {
    const internalLinks = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#') || href.startsWith('/')) return true;
      try { return new URL(href, location.href).hostname === location.hostname; } catch (e) { return false; }
    });
    const ctaButtons = document.querySelectorAll('button, [role="button"], a.btn, [class*="btn"], [class*="button"]');
    if (internalLinks.length === 0 && ctaButtons.length === 0) {
      const mainContent = document.querySelector('main, [role="main"], .content, .container');
      if (mainContent) {
        addIssue('ux-dead-end', 'Dead-End Page (No Exit Links)',
          'medium', 'flow', mainContent,
          'This page has no internal links or call-to-action buttons. Users have no way to navigate forward.',
          'Add navigation links, related content, or a call-to-action to guide users to the next step.');
      }
    }
    const hasSteps = document.querySelectorAll('[class*="step"], [class*="wizard"], [class*="progress"], [role="progressbar"]').length > 0;
    const formCount = document.querySelectorAll('form').length;
    if (formCount >= 2 && !hasSteps) {
      const firstForm = document.querySelector('form');
      if (firstForm) {
        addIssue('ux-no-progress', 'No Progress Indicator on Multi-Step Form',
          'medium', 'flow', firstForm,
          'This page has ' + formCount + ' forms but no visible step/progress indicator.',
          'Add a step indicator (e.g., "Step 2 of 4") or progress bar for multi-step flows.');
      }
    }
    document.querySelectorAll('form').forEach(form => {
      if (!isVisible(form)) return;
      const hasBack = form.querySelector('[class*="back"], [class*="cancel"], a[href]');
      const hasSubmit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (hasSubmit && !hasBack) {
        addIssue('ux-no-back-option', 'No Back/Cancel on Form',
          'low', 'flow', form,
          'This form has a submit button but no back or cancel option.',
          'Add a "Back" link or "Cancel" button to let users exit the form.');
      }
    });
  })();

  // =====================================================================
  // 3. BUTTON / CTA
  // =====================================================================
  (() => {
    const buttons = document.querySelectorAll('button, [role="button"], a.btn, [class*="btn"], [class*="button"]');
    const visibleBtns = Array.from(buttons).filter(isVisible);
    if (visibleBtns.length === 0) {
      const forms = document.querySelectorAll('form');
      if (forms.length > 0) {
        addIssue('ux-no-cta', 'No Visible Call-to-Action Button',
          'medium', 'cta', forms[0],
          'This page has forms but no visible button or CTA.',
          'Add a clearly labeled button (e.g., "Submit", "Save", "Continue") to each form.');
      }
    }
    const primaryBtns = visibleBtns.filter(b => {
      const s = getComputedStyle(b);
      const bg = s.backgroundColor;
      return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    });
    if (primaryBtns.length > 3) {
      addIssue('ux-many-ctas', 'Too Many Competing CTAs',
        'medium', 'cta', primaryBtns[3],
        'This page has ' + primaryBtns.length + ' visually prominent buttons competing for attention.',
        'Limit to 1-2 primary CTAs per screen. Use secondary styling for less important actions.');
    }
    visibleBtns.forEach(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      if (['click here', 'submit', 'ok', 'yes', 'no', 'button', 'press'].includes(text)) {
        addIssue('ux-vague-cta', 'Vague Button Label',
          'medium', 'cta', b,
          'Button text "' + (b.textContent || '').trim() + '" is vague.',
          'Use action-oriented labels like "Save Changes", "Delete Account", or "Start Free Trial".');
      }
    });
    visibleBtns.forEach(b => {
      if (b.disabled && !b.getAttribute('aria-describedby') && !b.getAttribute('title')) {
        const tooltip = b.closest('[title], [data-tooltip]');
        if (!tooltip) {
          addIssue('ux-disabled-no-reason', 'Disabled Button Without Explanation',
            'low', 'cta', b,
            'This button is disabled but gives no explanation why.',
            'Add a tooltip or helper text explaining why the button is disabled.');
        }
      }
    });
  })();

  // =====================================================================
  // 4. FORM USABILITY
  // =====================================================================
  (() => {
    document.querySelectorAll('form').forEach(form => {
      if (!isVisible(form)) return;
      const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), textarea, select');
      const visibleInputs = Array.from(inputs).filter(isVisible);
      if (visibleInputs.length === 0) return;
      const radioGroups = form.querySelectorAll('input[type="radio"]');
      if (radioGroups.length > 1) {
        const names = new Set(Array.from(radioGroups).map(r => r.name));
        if (names.size > 0 && !form.querySelector('fieldset')) {
          addIssue('ux-no-fieldset', 'Radio Buttons Without Fieldset',
            'medium', 'form-usability', radioGroups[0],
            'This form has ' + radioGroups.length + ' radio buttons without a <fieldset> and <legend>.',
            'Wrap related radio buttons in <fieldset><legend>Choose an option</legend>...</fieldset>.');
        }
      }
      const noHint = visibleInputs.filter(i => {
        const hasPlaceholder = i.getAttribute('placeholder');
        const hasHint = i.getAttribute('aria-describedby') || i.getAttribute('aria-hint');
        const label = i.id ? document.querySelector('label[for="' + CSS.escape(i.id) + '"]') : null;
        const hasLabelHint = label && label.textContent.includes('(');
        return !hasPlaceholder && !hasHint && !hasLabelHint;
      });
      if (noHint.length > 0 && visibleInputs.length >= 3) {
        addIssue('ux-no-input-hints', 'Missing Input Hints or Placeholders',
          'low', 'form-usability', noHint[0],
          'Several form fields lack placeholder text or hints for expected format.',
          'Add placeholder text or aria-describedby hints showing expected format (e.g., "MM/DD/YYYY").');
      }
      const pwFields = form.querySelectorAll('input[type="password"]');
      if (pwFields.length > 0) {
        pwFields.forEach(pw => {
          const hasToggle = pw.parentElement && pw.parentElement.querySelector('button, [role="button"], [class*="toggle"], [class*="show"]');
          if (!hasToggle) {
            addIssue('ux-no-pw-toggle', 'Password Field Without Show/Hide Toggle',
              'low', 'form-usability', pw,
              'This password field has no show/hide toggle.',
              'Add a toggle button to show/hide the password.');
          }
        });
      }
      const autoFillFields = form.querySelectorAll('input[name*="email"], input[name*="name"], input[name*="phone"], input[name*="address"], input[type="email"]');
      autoFillFields.forEach(f => {
        if (!f.getAttribute('autocomplete') && f.type !== 'hidden') {
          addIssue('ux-no-autocomplete', 'Missing Autocomplete Attribute',
            'low', 'form-usability', f,
            'This input (' + (f.name || f.type) + ') has no autocomplete attribute.',
            'Add autocomplete="email", autocomplete="name", etc. to help browsers auto-fill.');
        }
      });
    });
  })();

  // =====================================================================
  // 5. SEARCH
  // =====================================================================
  (() => {
    const searchInputs = document.querySelectorAll('input[type="search"], input[name*="search"], input[name*="query"], input[placeholder*="search" i], input[aria-label*="search" i], input[id*="search"]');
    const hasSearch = searchInputs.length > 0;
    const siteLinks = document.querySelectorAll('a[href]');
    if (!hasSearch && siteLinks.length > 20) {
      const nav = document.querySelector('nav, header, [class*="header"]');
      if (nav) {
        addIssue('ux-no-search', 'Missing Search on Content-Heavy Site',
          'low', 'search', nav,
          'This page has ' + siteLinks.length + ' links but no search functionality.',
          'Add a search input to the header or navigation area.');
      }
    }
    searchInputs.forEach(input => {
      if (!isVisible(input)) return;
      const form = input.closest('form');
      if (form) {
        const hasSubmit = form.querySelector('button[type="submit"], input[type="submit"]');
        if (!hasSubmit) {
          addIssue('ux-search-no-submit', 'Search Input Without Submit Button',
            'low', 'search', input,
            'This search input has no submit button.',
            'Add a search button or magnifying glass icon next to the input.');
        }
      }
      if (!input.getAttribute('role') && !input.getAttribute('aria-label') && !input.getAttribute('placeholder')) {
        addIssue('ux-search-no-label', 'Search Input Without Clear Label',
          'low', 'search', input,
          'This search input has no placeholder, aria-label, or role="search".',
          'Add placeholder="Search..." or aria-label="Search" to the input.');
      }
    });
  })();

  // =====================================================================
  // 6. ERROR HANDLING
  // =====================================================================
  (() => {
    document.querySelectorAll('img').forEach(img => {
      if (!isVisible(img)) return;
      if (img.complete && img.naturalWidth === 0 && img.src && !img.src.startsWith('data:')) {
        addIssue('ux-broken-image', 'Broken Image',
          'high', 'error-handling', img,
          'This image failed to load (broken URL or 404).',
          'Fix the image URL or remove the broken image element.');
      }
    });
    document.querySelectorAll('a[href]').forEach(a => {
      if (!isVisible(a)) return;
      const href = (a.getAttribute('href') || '').toLowerCase();
      if (href.includes('404') || href.includes('error') || href === '#' || href === 'javascript:void(0)') {
        addIssue('ux-broken-link', 'Dead or Placeholder Link',
          'medium', 'error-handling', a,
          'This link points to "' + a.getAttribute('href') + '" which appears to be a placeholder or error page.',
          'Update the link to the correct destination, or remove it.');
      }
    });
    document.querySelectorAll('form').forEach(form => {
      if (!isVisible(form)) return;
      if (!form.getAttribute('action') && !form.getAttribute('data-action')) {
        const hasAjax = form.hasAttribute('onsubmit') || form.querySelector('[data-ajax]');
        if (!hasAjax) {
          addIssue('ux-form-no-action', 'Form Without Action URL',
            'low', 'error-handling', form,
            'This form has no action attribute.',
            'Add an action attribute or handle submission via JavaScript with proper error handling.');
        }
      }
    });
  })();

  // =====================================================================
  // 7. LOADING & STATUS
  // =====================================================================
  (() => {
    const belowFold = [];
    document.querySelectorAll('img').forEach(img => {
      if (!isVisible(img)) return;
      const r = img.getBoundingClientRect();
      if (r.top > window.innerHeight && !img.hasAttribute('loading')) {
        belowFold.push(img);
      }
    });
    if (belowFold.length > 3) {
      addIssue('ux-no-lazy-load', 'Images Below Fold Not Lazy-Loaded',
        'medium', 'loading', belowFold[0],
        belowFold.length + ' images below the fold are not lazy-loaded.',
        'Add loading="lazy" to below-the-fold images to improve page load performance.');
    }
    const liveRegions = document.querySelectorAll('[aria-live], [role="alert"], [role="status"], [role="progressbar"]');
    const dynamicContent = document.querySelectorAll('[class*="notification"], [class*="alert"], [class*="toast"], [class*="snackbar"], [class*="loader"], [class*="spinner"]');
    if (dynamicContent.length > 0 && liveRegions.length === 0) {
      addIssue('ux-no-live-region', 'Dynamic Content Without Live Region',
        'medium', 'loading', dynamicContent[0],
        'Dynamic elements exist but no aria-live regions. Screen readers won\'t announce updates.',
        'Add aria-live="polite" to containers with dynamic content.');
    }
    const mainContent = document.querySelector('main, [role="main"], .content, .container');
    if (mainContent) {
      if (mainContent.children.length < 2) {
        addIssue('ux-no-empty-state', 'No Empty/Loading State Shown',
          'low', 'loading', mainContent,
          'Main content area appears empty with no loading skeleton or spinner.',
          'Add a loading skeleton or spinner while content is being fetched.');
      }
    }
  })();

  // =====================================================================
  // 8. CONSISTENCY (UX-level)
  // =====================================================================
  (() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
    if (buttons.length >= 3) {
      const casing = {};
      buttons.forEach(b => {
        const text = (b.textContent || '').trim();
        if (text.length < 2 || text.length > 50) return;
        let style = 'normal';
        if (text === text.toUpperCase() && text.length > 2) style = 'uppercase';
        else if (text === text.toLowerCase()) style = 'lowercase';
        else if (/^[A-Z]/.test(text) && !/[a-z]/.test(text.slice(1))) style = 'titlecase';
        if (!casing[style]) casing[style] = [];
        casing[style].push(b);
      });
      const styles = Object.keys(casing);
      if (styles.length > 1) {
        const minority = styles.reduce((a, b) => casing[a].length <= casing[b].length ? a : b);
        addIssue('ux-inconsistent-casing', 'Inconsistent Button Text Casing',
          'medium', 'consistency', casing[minority][0],
          'Button text casing is mixed: ' + styles.map(s => s + ' (' + casing[s].length + ')').join(', ') + '.',
          'Standardize button text casing across the page.');
      }
    }
    const iconContainers = document.querySelectorAll('button svg, button img, button i[class*="fa"], button i[class*="icon"]');
    if (iconContainers.length > 2) {
      const types = new Set();
      iconContainers.forEach(el => {
        if (el.tagName === 'svg') types.add('svg');
        else if (el.tagName === 'IMG') types.add('image');
        else types.add('icon-font');
      });
      if (types.size > 1) {
        addIssue('ux-mixed-icon-styles', 'Mixed Icon Styles',
          'low', 'consistency', iconContainers[0],
          'This page uses ' + Array.from(types).join(', ') + ' for icons.',
          'Use a single icon system for consistency.');
      }
    }
  })();

  // =====================================================================
  // 9. RESPONSIVE UX
  // =====================================================================
  (() => {
    if (!document.querySelector('meta[name="viewport"]')) {
      addIssue('ux-no-viewport', 'Missing Viewport Meta Tag',
        'high', 'responsive', document.head || document.documentElement,
        'This page is missing the viewport meta tag.',
        'Add <meta name="viewport" content="width=device-width, initial-scale=1"> in the <head>.');
    }
    document.querySelectorAll('div, table, section').forEach(el => {
      if (!isVisible(el)) return;
      const s = getComputedStyle(el);
      const w = parseFloat(s.width);
      if (w > 1200 && s.maxWidth === 'none') {
        addIssue('ux-fixed-width', 'Fixed-Width Element May Break on Mobile',
          'medium', 'responsive', el,
          'This element has a fixed width of ' + Math.round(w) + 'px with no max-width.',
          'Use max-width instead of width, or use responsive units (%, vw, rem).');
      }
    });
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 20) {
      addIssue('ux-horizontal-scroll', 'Page Causes Horizontal Scrolling',
        'high', 'responsive', document.body,
        'The page content is wider than the viewport.',
        'Check for elements wider than 100vw and use responsive sizing.');
    }
  })();

  // =====================================================================
  // 10. KEYBOARD NAVIGATION
  // =====================================================================
  (() => {
    document.querySelectorAll('[tabindex]').forEach(el => {
      const val = parseInt(el.getAttribute('tabindex'));
      if (val > 0) {
        addIssue('ux-positive-tabindex', 'Positive Tabindex Disrupts Tab Order',
          'medium', 'keyboard', el,
          'This element has tabindex="' + val + '" which forces it earlier in the tab order.',
          'Use tabindex="0" to add to natural order, or tabindex="-1" for programmatic focus only.');
      }
    });
    document.querySelectorAll('a[href], button').forEach(el => {
      if (el.getAttribute('tabindex') === '-1' && isVisible(el)) {
        addIssue('ux-negative-tabindex', 'Focusable Element Hidden From Keyboard',
          'medium', 'keyboard', el,
          'This ' + el.tagName.toLowerCase() + ' is interactive but has tabindex="-1".',
          'Remove tabindex="-1" so keyboard users can access this element.');
      }
    });
    const body = document.body;
    const html = document.documentElement;
    if (getComputedStyle(body).outlineStyle === 'none' && getComputedStyle(html).outlineStyle === 'none') {
      addIssue('ux-global-outline-none', 'Global Focus Outline Suppressed',
        'high', 'keyboard', body,
        'Focus outlines appear to be globally suppressed.',
        'Remove global outline:none rules, or add :focus-visible styles for keyboard users.');
    }
    document.querySelectorAll('[onclick], [role="button"]').forEach(el => {
      if (!isVisible(el)) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'a' && tag !== 'button' && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
        if (el.getAttribute('tabindex') === null) {
          addIssue('ux-clickable-not-focusable', 'Clickable Element Not in Tab Order',
            'medium', 'keyboard', el,
            'This element is clickable but has no tabindex.',
            'Add tabindex="0" and handle Enter/Space key events, or use a <button> instead.');
        }
      }
    });
    const allLinks = document.querySelectorAll('a[href]');
    const firstLink = allLinks[0];
    if (firstLink) {
      const hasSkipNav = Array.from(allLinks).slice(0, 5).some(a => {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').toLowerCase();
        return href.includes('#main') || href.includes('#content') || text.includes('skip');
      });
      const pageHeight = document.documentElement.scrollHeight;
      if (!hasSkipNav && pageHeight > 2000) {
        addIssue('ux-no-skip-nav', 'Missing Skip Navigation Link',
          'low', 'keyboard', firstLink,
          'This page is tall but has no skip navigation link.',
          'Add a visually hidden "Skip to main content" link at the top of the page.');
      }
    }
  })();

  // =====================================================================
  // 11. ACCESSIBILITY
  // =====================================================================
  (() => {
    document.querySelectorAll('img').forEach(img => {
      if (!isVisible(img)) return;
      if (!img.hasAttribute('alt')) {
        addIssue('ux-missing-alt', 'Missing Image Alt Text',
          'high', 'accessibility', img,
          'This image has no alt attribute. Screen readers cannot describe it.',
          'Add an alt attribute with a description. For decorative images, use alt="".');
      } else if (img.alt === '' && img.closest('a, button')) {
        addIssue('ux-empty-alt-link', 'Empty Alt Text on Linked Image',
          'medium', 'accessibility', img,
          'This linked image has alt="" which makes the link inaccessible.',
          'Add a descriptive alt text so screen reader users know the link destination.');
      }
    });
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), textarea, select').forEach(input => {
      if (!isVisible(input)) return;
      const id = input.id;
      const hasLabel = id && document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (!hasLabel && !input.getAttribute('aria-label') && !input.getAttribute('aria-labelledby') && !input.closest('label') && !input.getAttribute('title')) {
        addIssue('ux-missing-label', 'Missing Form Label',
          'high', 'accessibility', input,
          'This form field has no associated label.',
          'Add a <label> element with for="...", or use aria-label="Description".');
      }
    });
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      if (!isVisible(btn)) return;
      const text = (btn.textContent || '').trim();
      const hasIcon = btn.querySelector('svg, img, i[class*="fa"], i[class*="icon"], span[class*="icon"], span[class*="fa"]');
      if (text.length === 0 && !btn.getAttribute('aria-label') && !btn.getAttribute('aria-labelledby') && !btn.getAttribute('title') && !hasIcon) {
        addIssue('ux-missing-aria', 'Icon-Button Without Label',
          'high', 'accessibility', btn,
          'This button has no visible text, ARIA label, or icon.',
          'Add aria-label="Action description" or include visible text.');
      }
    });
    if (!document.documentElement.getAttribute('lang')) {
      addIssue('ux-missing-lang', 'Missing Page Language',
        'high', 'accessibility', document.documentElement,
        'The <html> element has no lang attribute.',
        'Add lang="en" (or the appropriate language code) to the <html> element.');
    }
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(isVisible);
    if (headings.length > 0) {
      let prevLevel = 0;
      headings.forEach(h => {
        const level = parseInt(h.tagName[1]);
        if (prevLevel > 0 && level > prevLevel + 1) {
          addIssue('ux-heading-skip', 'Skipped Heading Level',
            'medium', 'accessibility', h,
            'Heading jumps from <h' + prevLevel + '> to <h' + level + '>.',
            'Change this to <h' + (prevLevel + 1) + '> or restructure headings sequentially.');
        }
        prevLevel = level;
      });
    }
    if (headings.length > 0 && document.querySelectorAll('h1').length === 0) {
      addIssue('ux-missing-h1', 'Missing H1 Heading',
        'medium', 'accessibility', headings[0] || document.body,
        'This page has headings but no <h1>.',
        'Add an <h1> heading that describes the primary content of this page.');
    }
    if (document.querySelectorAll('h1').length > 1) {
      const h1s = document.querySelectorAll('h1');
      addIssue('ux-multiple-h1', 'Multiple H1 Headings',
        'low', 'accessibility', h1s[1],
        'This page has ' + h1s.length + ' <h1> elements.',
        'Use only one <h1> for the main page title.');
    }
    document.querySelectorAll('a[href]').forEach(a => {
      if (!isVisible(a)) return;
      const text = (a.textContent || '').trim().toLowerCase();
      if (a.getAttribute('aria-label') || a.getAttribute('title')) return;
      if (text.length === 0 && !a.querySelector('img[alt]')) {
        addIssue('ux-empty-link', 'Link Without Text',
          'high', 'accessibility', a,
          'This link has no visible text or alt text.',
          'Add descriptive text content, an aria-label, or alt text on a child image.');
      } else if (['click here', 'here', 'read more', 'more', 'learn more', 'link', 'more info'].indexOf(text) !== -1) {
        addIssue('ux-vague-link', 'Vague Link Text',
          'medium', 'accessibility', a,
          'Link text "' + text + '" is vague and not descriptive.',
          'Use descriptive text like "Read our pricing guide" instead.');
      }
    });
    if (headings.length > 10 && !document.querySelector('main, [role="main"]')) {
      addIssue('ux-no-main-region', 'Missing Main Content Region',
        'low', 'accessibility', document.body,
        'This page has substantial content but no <main> element.',
        'Wrap the primary content in a <main> element.');
    }
    function luminance(r, g, b) {
      const a = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }
    function contrastRatio(l1, l2) {
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }
    function parseColor(str) {
      if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
      const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      return null;
    }
    function getEffectiveBg(el) {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const bg = parseColor(getComputedStyle(cur).backgroundColor);
        if (bg) return bg;
        cur = cur.parentElement;
      }
      return [255, 255, 255];
    }
    document.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6, label, button, td, th, li').forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.textContent || '').trim();
      if (text.length < 2) return;
      const fg = parseColor(getComputedStyle(el).color);
      if (!fg) return;
      const bg = getEffectiveBg(el);
      const fgL = luminance(fg[0], fg[1], fg[2]);
      const bgL = luminance(bg[0], bg[1], bg[2]);
      const ratio = contrastRatio(fgL, bgL);
      const fontSize = parseFloat(getComputedStyle(el).fontSize);
      const fontWeight = parseInt(getComputedStyle(el).fontWeight) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const threshold = isLarge ? 3.0 : 4.5;
      if (ratio < threshold && ratio > 0) {
        addIssue('ux-low-contrast', 'Insufficient Colour Contrast',
          ratio < 3 ? 'high' : 'medium', 'accessibility', el,
          'Text contrast ratio is ' + ratio.toFixed(1) + ':1 (minimum is ' + threshold + ':1).',
          'Increase contrast by darkening the text or lightening the background.');
      }
    });
  })();

  // =====================================================================
  // 12. TASK COMPLETION
  // =====================================================================
  (() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
    const dangerWords = ['delete', 'remove', 'destroy', 'cancel', 'close'];
    const positiveWords = ['save', 'submit', 'confirm', 'continue', 'next', 'apply'];
    const dangerBtns = buttons.filter(b => dangerWords.some(w => (b.textContent || '').toLowerCase().includes(w)));
    const positiveBtns = buttons.filter(b => positiveWords.some(w => (b.textContent || '').toLowerCase().includes(w)));
    if (dangerBtns.length > 0 && positiveBtns.length > 0) {
      dangerBtns.forEach(dBtn => {
        const ds = getComputedStyle(dBtn);
        positiveBtns.forEach(pBtn => {
          const ps = getComputedStyle(pBtn);
          if (ds.backgroundColor === ps.backgroundColor && ds.color === ps.color) {
            addIssue('ux-conflicting-actions', 'Danger and Positive Actions Look Identical',
              'high', 'task-completion', dBtn,
              'The "' + (dBtn.textContent || '').trim() + '" button looks the same as "' + (pBtn.textContent || '').trim() + '".',
              'Style destructive actions differently: use red/outlined for delete and green/filled for positive.');
          }
        });
      });
    }
    dangerBtns.forEach(b => {
      const text = (b.textContent || '').trim().toLowerCase();
      if (text.includes('delete') || text.includes('remove') || text.includes('destroy')) {
        const hasConfirm = b.getAttribute('data-confirm') || (b.getAttribute('onclick') || '').includes('confirm') ||
          (b.getAttribute('onclick') || '').includes('alert') || b.closest('[data-confirm]');
        if (!hasConfirm) {
          addIssue('ux-no-delete-confirm', 'Destructive Action Without Confirmation',
            'medium', 'task-completion', b,
            'The "' + (b.textContent || '').trim() + '" button triggers an irreversible action without confirmation.',
            'Add a confirmation dialog before executing destructive actions.');
        }
      }
    });
    const hasSuccessArea = document.querySelector('[class*="success"], [class*="toast"], [class*="notification"], [role="alert"], [role="status"]');
    if (document.querySelectorAll('form').length > 0 && !hasSuccessArea) {
      addIssue('ux-no-success-feedback', 'No Success Feedback Area',
        'low', 'task-completion', document.body,
        'This page has forms but no visible success feedback area.',
        'Add a toast notification or success banner to confirm successful actions.');
    }
    document.querySelectorAll('form').forEach(form => {
      if (!isVisible(form)) return;
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (submitBtn) {
        const text = (submitBtn.textContent || submitBtn.value || '').trim().toLowerCase();
        if (text.length === 0 || text === 'submit' || text === 'button') {
          addIssue('ux-unclear-submit', 'Unclear Submit Button Text',
            'medium', 'task-completion', submitBtn,
            'The submit button text "' + (submitBtn.textContent || submitBtn.value || '').trim() + '" does not tell users what will happen.',
            'Use action-oriented text like "Create Account", "Send Message", or "Place Order".');
        }
      }
    });
  })();

  return issues;
})();
