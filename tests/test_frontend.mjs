import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Helper class for mock form
class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName;
    this.dataset = {};
    this.style = {};
    this.disabled = false;
    this.textContent = '';
    this.action = '/api/contact';
    this.listeners = {};
    this.checked = false;
    this.value = '';
    this.name = { value: '山田 太郎' };
    this.email = { value: 'test@example.com' };
    this.tel = { value: '090-1234-5678' };
    this.category = { value: '見学について' };
    this.message = { value: '見学希望' };
    this.consent = { checked: true };
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  async dispatchEvent(eventObj) {
    if (this.listeners[eventObj.type]) {
      for (const h of this.listeners[eventObj.type]) {
        await h(eventObj);
      }
    }
  }

  reset() {
    this.dataset = {};
    this.value = '';
    this.dispatchEvent({ type: 'reset' });
  }

  focus() {}
}

class MockFormData {
  constructor(form) {
    this.data = {
      name: '山田 太郎',
      email: 'test@example.com',
      tel: '090-1234-5678',
      category: '見学について',
      message: '見学希望',
      consent: 'on',
      'cf-turnstile-response': globalThis._turnstileToken || 'token-123'
    };
  }
  get(key) {
    return this.data[key];
  }
}

function setupFrontendEnvironment() {
  const form = new MockElement('contact-form', 'form');
  const submitBtn = new MockElement('submitBtn', 'button');
  const errorMsg = new MockElement('form-error-message', 'div');
  const successMsg = new MockElement('form-success-message', 'div');

  const elements = {
    'contact-form': form,
    'submitBtn': submitBtn,
    'form-error-message': errorMsg,
    'form-success-message': successMsg
  };

  const docListeners = {};
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: (selector) => [],
    addEventListener: (event, handler) => {
      if (!docListeners[event]) docListeners[event] = [];
      docListeners[event].push(handler);
    },
    body: {
      style: {}
    }
  };

  globalThis.FormData = MockFormData;

  let turnstileResetCount = 0;
  globalThis._turnstileToken = 'token-1';
  globalThis.turnstile = {
    reset: () => {
      turnstileResetCount++;
      globalThis._turnstileToken = 'token-' + (turnstileResetCount + 1);
    },
    getResetCount: () => turnstileResetCount
  };

  let capturedFetchBody = null;
  let fetchOutcome = { ok: true, json: async () => ({ ok: true }) };
  let fetchThrow = false;
  let fetchCount = 0;

  globalThis.fetch = async (url, options) => {
    fetchCount++;
    capturedFetchBody = JSON.parse(options.body);
    if (fetchThrow) throw new Error('Network error');
    return {
      ok: fetchOutcome.ok,
      json: fetchOutcome.json
    };
  };

  // Load and execute main.js
  const mainJs = fs.readFileSync('public/js/main.js', 'utf8');
  const fn = new Function(mainJs);
  fn();

  // Trigger DOMContentLoaded
  if (docListeners['DOMContentLoaded']) {
    for (const h of docListeners['DOMContentLoaded']) {
      h();
    }
  }

  return {
    form,
    submitBtn,
    errorMsg,
    successMsg,
    setFetchOutcome: (outcome) => { fetchOutcome = outcome; },
    setFetchThrow: (val) => { fetchThrow = val; },
    getCapturedBody: () => capturedFetchBody,
    getFetchCount: () => fetchCount,
    getTurnstileResetCount: () => turnstileResetCount
  };
}

test('Frontend: Initial submit generates UUID v4 and sends submissionId', async () => {
  const env = setupFrontendEnvironment();
  
  let prevented = false;
  await env.form.dispatchEvent({
    type: 'submit',
    preventDefault: () => { prevented = true; }
  });

  assert.strictEqual(prevented, true);
  assert.strictEqual(env.getFetchCount(), 1);
  const body = env.getCapturedBody();
  assert.ok(body.submissionId);
  assert.match(body.submissionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('Frontend: Communication/Server failure keeps submissionId and resets Turnstile', async () => {
  const env = setupFrontendEnvironment();
  
  // 1. Fail with network error
  env.setFetchThrow(true);
  await env.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  
  const firstId = env.form.dataset.submissionId;
  assert.ok(firstId);
  assert.strictEqual(env.errorMsg.style.display, 'block');
  assert.strictEqual(env.submitBtn.disabled, false);
  assert.strictEqual(env.getTurnstileResetCount(), 1);

  // 2. Retry submission
  env.setFetchThrow(false);
  env.setFetchOutcome({ ok: false, json: async () => ({ ok: false, code: 'VALIDATION_FAILED' }) });
  await env.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

  const secondId = env.getCapturedBody().submissionId;
  assert.strictEqual(secondId, firstId); // Same submissionId reused!
  assert.strictEqual(env.getTurnstileResetCount(), 2);
  assert.strictEqual(env.getCapturedBody()['cf-turnstile-response'], 'token-2'); // New turnstile token used!
});

test('Frontend: Success deletes submissionId, resets form & Turnstile', async () => {
  const env = setupFrontendEnvironment();
  
  env.setFetchOutcome({ ok: true, json: async () => ({ ok: true }) });
  await env.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

  assert.strictEqual(env.form.dataset.submissionId, undefined);
  assert.strictEqual(env.successMsg.style.display, 'block');
  assert.strictEqual(env.form.style.display, 'none');
  assert.ok(env.getTurnstileResetCount() >= 1);
});

test('Frontend: Explicit user reset deletes submissionId', async () => {
  const env = setupFrontendEnvironment();
  
  // Set submissionId artificially
  env.form.dataset.submissionId = '123e4567-e89b-42d3-a456-426614174000';
  
  // Reset form
  env.form.reset();
  
  assert.strictEqual(env.form.dataset.submissionId, undefined);
});

test('Frontend: Subsequent submit after reset generates NEW UUID v4', async () => {
  const env = setupFrontendEnvironment();
  
  // First submit (success)
  env.setFetchOutcome({ ok: true, json: async () => ({ ok: true }) });
  await env.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  const firstId = env.getCapturedBody().submissionId;

  // New submit
  await env.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  const secondId = env.getCapturedBody().submissionId;

  assert.notStrictEqual(firstId, secondId);
  assert.match(secondId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('Frontend: Missing Crypto API displays error, restores button state, prevents fetch', async () => {
  const originalCrypto = globalThis.crypto;
  delete globalThis.crypto;

  try {
    const env = setupFrontendEnvironment();
    await env.form.dispatchEvent({ type: 'submit', preventDefault: () => {} });

    assert.strictEqual(env.getFetchCount(), 0); // fetch NOT called
    assert.strictEqual(env.submitBtn.disabled, false); // button restored
    assert.strictEqual(env.submitBtn.textContent, '送信する');
    assert.strictEqual(env.errorMsg.style.display, 'block');
    assert.ok(env.errorMsg.textContent.includes('暗号論的擬似乱数生成器'));
    assert.strictEqual(env.form.dataset.submissionId, undefined);
  } finally {
    globalThis.crypto = originalCrypto;
  }
});

test('Frontend: contact.html UTF-8 encoding, Japanese integrity, and mojibake prevention', () => {
  const contactHtmlPath = 'public/contact.html';
  assert.ok(fs.existsSync(contactHtmlPath), 'public/contact.html must exist');

  const content = fs.readFileSync(contactHtmlPath, 'utf8');

  // 1. U+FFFD check
  assert.strictEqual(content.includes('\uFFFD'), false, 'public/contact.html must not contain U+FFFD');

  // 2. Required Japanese strings
  const requiredStrings = [
    'お問い合わせ',
    '本文へスキップ',
    '希望の家について',
    'サービス内容',
    '施設のご案内',
    'ご利用案内',
    '活動の様子',
    'よくある質問',
    'アクセス',
    '見学・お問い合わせ',
    'お電話でのお問い合わせ',
    'お問い合わせフォーム',
    'お名前',
    'メールアドレス',
    '電話番号',
    'お問い合わせ種別',
    'お問い合わせ内容',
    '必須',
    '個人情報保護方針',
    '送信する'
  ];

  for (const str of requiredStrings) {
    assert.ok(content.includes(str), `public/contact.html must include '${str}'`);
  }

  // 3. Title & description
  assert.ok(content.includes('<title>見学・お問い合わせ | 生活介護 希望の家 | 社会福祉法人SHIP</title>'));
  assert.ok(content.includes('<meta name="description" content="生活介護 希望の家への見学予約、ご相談、各種お問い合わせはこちらから承ります。">'));
  assert.ok(content.includes('<meta charset="UTF-8">'));
  assert.ok(content.includes('<html lang="ja">'));

  // 4. Typical mojibake patterns
  const mojibakePatterns = [
    /縺[^\s<>]{2,}/,
    /繧[^\s<>]{2,}/,
    /繝[^\s<>]{2,}/,
    /・[a-zA-Z0-9]{2,}/
  ];
  for (const pat of mojibakePatterns) {
    assert.strictEqual(pat.test(content), false, `public/contact.html must not match mojibake pattern ${pat}`);
  }

  // 5. Check all public/*.html files for U+FFFD
  const htmlFiles = fs.readdirSync('public').filter(f => f.endsWith('.html'));
  for (const file of htmlFiles) {
    const p = `public/${file}`;
    const fileContent = fs.readFileSync(p, 'utf8');
    assert.strictEqual(fileContent.includes('\uFFFD'), false, `${p} must not contain U+FFFD`);
  }
});

test('Frontend: contact.html DOM structure, form elements, and main.js contract', () => {
  const content = fs.readFileSync('public/contact.html', 'utf8');

  // Turnstile script
  assert.ok(content.includes('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'));

  // Form attributes
  assert.ok(content.includes('id="contact-form"'));
  assert.ok(content.includes('action="/api/contact"'));
  assert.ok(content.includes('method="POST"'));

  // Form controls & attributes
  assert.ok(content.includes('id="name"'));
  assert.ok(content.includes('name="name"'));
  assert.ok(content.includes('maxlength="100"'));
  assert.ok(content.includes('autocomplete="name"'));

  assert.ok(content.includes('id="email"'));
  assert.ok(content.includes('name="email"'));
  assert.ok(content.includes('maxlength="254"'));
  assert.ok(content.includes('autocomplete="email"'));

  assert.ok(content.includes('id="tel"'));
  assert.ok(content.includes('name="tel"'));
  assert.ok(content.includes('maxlength="30"'));
  assert.ok(content.includes('autocomplete="tel"'));

  assert.ok(content.includes('id="category"'));
  assert.ok(content.includes('name="category"'));
  assert.ok(content.includes('required'));
  assert.ok(content.includes('value="見学について"'));
  assert.ok(content.includes('value="利用に関するご相談"'));
  assert.ok(content.includes('value="採用について"'));
  assert.ok(content.includes('value="その他"'));

  assert.ok(content.includes('id="message"'));
  assert.ok(content.includes('name="message"'));
  assert.ok(content.includes('maxlength="2000"'));

  // Consent & Privacy policy link
  assert.ok(content.includes('id="consent"'));
  assert.ok(content.includes('name="consent"'));
  assert.ok(content.includes('<a href="/privacy" target="_blank" rel="noopener noreferrer">個人情報保護方針</a>'));

  // Turnstile widget
  assert.ok(content.includes('class="cf-turnstile"'));

  // Production Turnstile Site Key: must be the actual production key
  assert.ok(content.includes('data-sitekey="0x4AAAAAAEVpC137nrp1x62K"'), 'Production Site Key must be present');

  // data-sitekey must not be empty
  assert.strictEqual(content.includes('data-sitekey=""'), false, 'data-sitekey must not be empty');

  // data-action must be strictly 'contact' and not empty
  assert.ok(content.includes('data-action="contact"'), 'data-action="contact" must be present');
  assert.strictEqual(content.includes('data-action=""'), false, 'data-action must not be empty');
  const actionMatch = content.match(/data-action="([^"]*)"/);
  assert.ok(actionMatch, 'data-action attribute must exist');
  assert.strictEqual(actionMatch[1], 'contact', 'data-action must be strictly "contact"');

  // Cloudflare official test/dummy Site Keys must not appear in production HTML
  const testSiteKeys = [
    '1x00000000000000000000AA',
    '2x00000000000000000000AB',
    '1x00000000000000000000BB',
    '2x00000000000000000000BB',
    '3x00000000000000000000FF',
  ];
  for (const testKey of testSiteKeys) {
    assert.strictEqual(content.includes(testKey), false, `Test Site Key ${testKey} must not be in production HTML`);
  }

  // Placeholder patterns must not appear
  const placeholders = ['YOUR_SITE_KEY', 'TURNSTILE_SITE_KEY', '{SITE_KEY}', '<SITE_KEY>'];
  for (const ph of placeholders) {
    assert.strictEqual(content.includes(ph), false, `Placeholder '${ph}' must not be in production HTML`);
  }

  // data-sitekey value must not contain angle brackets
  const sitekeyMatch = content.match(/data-sitekey="([^"]*)"/);
  assert.ok(sitekeyMatch, 'data-sitekey attribute must exist');
  assert.strictEqual(sitekeyMatch[1].includes('<'), false, 'Site Key must not contain <');
  assert.strictEqual(sitekeyMatch[1].includes('>'), false, 'Site Key must not contain >');

  // Buttons & Messages
  assert.ok(content.includes('id="submitBtn"'));
  assert.ok(content.includes('id="form-error-message"'));
  assert.ok(content.includes('role="alert"'), 'form-error-message must have role="alert"');
  assert.ok(content.includes('id="form-success-message"'));
  assert.ok(content.includes('role="status"'), 'form-success-message must have role="status"');
  assert.ok(content.includes('tabindex="-1"'), 'form-success-message must have tabindex="-1"');

  // Labels matching controls
  assert.ok(content.includes('for="name"'));
  assert.ok(content.includes('for="email"'));
  assert.ok(content.includes('for="tel"'));
  assert.ok(content.includes('for="category"'));
  assert.ok(content.includes('for="message"'));
  assert.ok(content.includes('for="consent"'));
});

test('Frontend: Validation contract alignment between Frontend, Worker, and GAS', () => {
  const contactHtml = fs.readFileSync('public/contact.html', 'utf8');
  const workerSrc = fs.readFileSync('src/index.js', 'utf8');
  const gasSrc = fs.readFileSync('google-apps-script/Code.gs', 'utf8');

  // 1. category: required in HTML, has 必須 label, and allowed options match Worker & GAS
  assert.match(contactHtml, /<label\s+for="category"[^>]*>[\s\S]*?お問い合わせ種別[\s\S]*?<span\s+class="required">必須<\/span>[\s\S]*?<\/label>/);
  assert.match(contactHtml, /<select\s+id="category"\s+name="category"\s+required>/);

  const expectedCategories = ['見学について', '利用に関するご相談', '採用について', 'その他'];
  for (const cat of expectedCategories) {
    assert.ok(contactHtml.includes(`value="${cat}"`), `HTML must contain option value '${cat}'`);
    assert.ok(workerSrc.includes(`'${cat}'`), `Worker must contain allowed category '${cat}'`);
    assert.ok(gasSrc.includes(`'${cat}'`), `GAS must contain allowed category '${cat}'`);
  }

  // 2. message: required, maxlength=2000 in HTML, Worker rejects > 2000, GAS rejects > 2000
  assert.match(contactHtml, /<textarea\s+id="message"\s+name="message"[^>]*maxlength="2000"[^>]*required>/);
  assert.ok(workerSrc.includes('message.length > 2000'), 'Worker must reject message > 2000');
  assert.ok(gasSrc.includes('message.length > 2000'), 'GAS must reject message > 2000');

  // 3. name, email, tel length limits alignment
  assert.match(contactHtml, /<input\s+type="text"\s+id="name"\s+name="name"[^>]*maxlength="100"[^>]*required>/);
  assert.ok(workerSrc.includes('name.length > 100'), 'Worker must enforce name length <= 100');
  assert.ok(gasSrc.includes('name.length > 100'), 'GAS must enforce name length <= 100');

  assert.match(contactHtml, /<input\s+type="email"\s+id="email"\s+name="email"[^>]*maxlength="254"[^>]*required>/);
  assert.ok(workerSrc.includes('email.length > 254'), 'Worker must enforce email length <= 254');
  assert.ok(gasSrc.includes('email.length > 254'), 'GAS must enforce email length <= 254');

  assert.match(contactHtml, /<input\s+type="tel"\s+id="tel"\s+name="tel"[^>]*maxlength="30"/);
  assert.ok(workerSrc.includes('tel.length > 30'), 'Worker must enforce tel length <= 30');
  assert.ok(gasSrc.includes('tel.length > 30'), 'GAS must enforce tel length <= 30');

  // 4. consent required in HTML, Worker, GAS
  assert.match(contactHtml, /<input\s+type="checkbox"\s+id="consent"\s+name="consent"\s+required>/);
  assert.ok(workerSrc.includes('!consent'), 'Worker must require consent === true');
  assert.ok(gasSrc.includes('consent !== true'), 'GAS must require consent === true');

  // 5. Turnstile action contract: HTML specifies data-action="contact", Worker requires turnstileOutcome.action !== 'contact'
  assert.match(contactHtml, /class="cf-turnstile"[^>]*data-action="contact"/);
  assert.ok(workerSrc.includes("turnstileOutcome.action !== 'contact'"), 'Worker must strictly require action === contact');
});

test('Frontend: Canonical self-referencing tags across all 10 HTML pages', () => {
  const expectedCanonicalMap = {
    'index.html': 'https://kibounoie-akiruno.org/',
    'about.html': 'https://kibounoie-akiruno.org/about',
    'service.html': 'https://kibounoie-akiruno.org/service',
    'facility.html': 'https://kibounoie-akiruno.org/facility',
    'guide.html': 'https://kibounoie-akiruno.org/guide',
    'activities.html': 'https://kibounoie-akiruno.org/activities',
    'faq.html': 'https://kibounoie-akiruno.org/faq',
    'access.html': 'https://kibounoie-akiruno.org/access',
    'contact.html': 'https://kibounoie-akiruno.org/contact',
    'privacy.html': 'https://kibounoie-akiruno.org/privacy'
  };

  for (const [filename, expectedUrl] of Object.entries(expectedCanonicalMap)) {
    const filePath = path.join('public', filename);
    assert.ok(fs.existsSync(filePath), `${filePath} must exist`);
    const content = fs.readFileSync(filePath, 'utf8');

    const canonicalMatch = content.match(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/?>/);
    assert.ok(canonicalMatch, `${filename} must contain a canonical link tag`);
    assert.strictEqual(canonicalMatch[1], expectedUrl, `${filename} canonical href must be ${expectedUrl}`);
    assert.strictEqual(canonicalMatch[1].includes('www.'), false, `${filename} canonical must be non-www`);
    assert.ok(canonicalMatch[1].startsWith('https://'), `${filename} canonical must be https`);
  }
});

test('Frontend: sitemap.xml structure and published page URL integrity', () => {
  const sitemapPath = 'public/sitemap.xml';
  assert.ok(fs.existsSync(sitemapPath), 'public/sitemap.xml must exist');
  const content = fs.readFileSync(sitemapPath, 'utf8');

  assert.ok(content.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'sitemap.xml must have XML declaration');
  assert.ok(content.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), 'sitemap.xml must have standard urlset xmlns');

  const locMatches = [...content.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  assert.strictEqual(locMatches.length, 10, 'sitemap.xml must contain exactly 10 canonical page URLs');

  const expectedUrls = [
    'https://kibounoie-akiruno.org/',
    'https://kibounoie-akiruno.org/about',
    'https://kibounoie-akiruno.org/service',
    'https://kibounoie-akiruno.org/facility',
    'https://kibounoie-akiruno.org/guide',
    'https://kibounoie-akiruno.org/activities',
    'https://kibounoie-akiruno.org/faq',
    'https://kibounoie-akiruno.org/access',
    'https://kibounoie-akiruno.org/contact',
    'https://kibounoie-akiruno.org/privacy'
  ];

  for (const url of expectedUrls) {
    assert.ok(locMatches.includes(url), `sitemap.xml must include ${url}`);
  }
});

test('Frontend: robots.txt structure and crawl configuration', () => {
  const robotsPath = 'public/robots.txt';
  assert.ok(fs.existsSync(robotsPath), 'public/robots.txt must exist');
  const content = fs.readFileSync(robotsPath, 'utf8');

  assert.ok(content.includes('User-agent: *'), 'robots.txt must define User-agent: *');
  assert.ok(content.includes('Allow: /'), 'robots.txt must allow root /');
  assert.ok(content.includes('Disallow: /api/'), 'robots.txt must disallow /api/');
  assert.ok(content.includes('Sitemap: https://kibounoie-akiruno.org/sitemap.xml'), 'robots.txt must specify Sitemap URL');
});

test('Frontend: Internal page links are root-relative and extensionless across all HTML files', () => {
  const htmlFiles = fs.readdirSync('public').filter(f => f.endsWith('.html'));
  assert.strictEqual(htmlFiles.length, 10, 'Must have 10 HTML files in public/');

  for (const filename of htmlFiles) {
    const filePath = path.join('public', filename);
    const content = fs.readFileSync(filePath, 'utf8');

    // Ensure no old relative .html links remain in href attributes
    const oldHtmlLinkMatches = content.match(/href="[a-zA-Z0-9_-]+\.html(#.*?)?"/g);
    assert.strictEqual(oldHtmlLinkMatches, null, `${filename} must not contain any relative .html links, found: ${oldHtmlLinkMatches}`);
  }
});

test('Frontend: FAQ accordion HTML semantics and ARIA relationships', () => {
  const faqPath = 'public/faq.html';
  assert.ok(fs.existsSync(faqPath), 'public/faq.html must exist');
  const html = fs.readFileSync(faqPath, 'utf8');

  // Verify 4 accordion items
  const itemMatches = [...html.matchAll(/<div\s+class="accordion-item">([\s\S]*?)<\/div>\s*<\/div>/gi)];
  assert.strictEqual(itemMatches.length, 4, 'public/faq.html must contain exactly 4 accordion-item elements');

  // Verify headings
  const headingMatches = [...html.matchAll(/<div\s+role="heading"\s+aria-level="2">([\s\S]*?)<\/div>/gi)];
  assert.strictEqual(headingMatches.length, 4, 'public/faq.html must contain exactly 4 div[role="heading"][aria-level="2"] elements');

  // Verify each heading wraps only the button
  for (let i = 0; i < 4; i++) {
    const headingInner = headingMatches[i][1].trim();
    assert.ok(headingInner.startsWith('<button') && headingInner.endsWith('</button>'), `Heading ${i + 1} must directly and solely wrap the accordion button`);
  }

  // Verify headers and panels
  const buttonMatches = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/gi)].filter(m => m[1].includes('accordion-header'));
  const panelMatches = [...html.matchAll(/<div([^>]*)>([\s\S]*?)<\/div>/gi)].filter(m => m[1].includes('accordion-content'));

  assert.strictEqual(buttonMatches.length, 4, 'Must have exactly 4 accordion-header buttons');
  assert.strictEqual(panelMatches.length, 4, 'Must have exactly 4 accordion-content panels');

  const buttonIds = new Set();
  const panelIds = new Set();

  for (let i = 0; i < 4; i++) {
    const btnAttrs = buttonMatches[i][1];
    const panelAttrs = panelMatches[i][1];

    // Check button attributes
    assert.ok(btnAttrs.includes('type="button"'), `FAQ button ${i + 1} must have type="button"`);

    const btnIdMatch = btnAttrs.match(/id="([^"]+)"/);
    assert.ok(btnIdMatch, `FAQ button ${i + 1} must have an id`);
    const btnId = btnIdMatch[1];
    assert.strictEqual(buttonIds.has(btnId), false, `FAQ button ID ${btnId} must be unique`);
    buttonIds.add(btnId);

    const ariaExpandedMatch = btnAttrs.match(/aria-expanded="([^"]+)"/);
    assert.ok(ariaExpandedMatch, `FAQ button ${i + 1} must have aria-expanded`);
    assert.strictEqual(ariaExpandedMatch[1], 'false', `FAQ button ${i + 1} must initially have aria-expanded="false"`);

    const ariaControlsMatch = btnAttrs.match(/aria-controls="([^"]+)"/);
    assert.ok(ariaControlsMatch, `FAQ button ${i + 1} must have aria-controls`);
    const controlsId = ariaControlsMatch[1];

    // Check panel attributes
    const panelIdMatch = panelAttrs.match(/id="([^"]+)"/);
    assert.ok(panelIdMatch, `FAQ panel ${i + 1} must have an id`);
    const panelId = panelIdMatch[1];
    assert.strictEqual(panelIds.has(panelId), false, `FAQ panel ID ${panelId} must be unique`);
    panelIds.add(panelId);

    assert.ok(panelAttrs.includes('role="region"'), `FAQ panel ${i + 1} must have role="region"`);

    const ariaLabelledbyMatch = panelAttrs.match(/aria-labelledby="([^"]+)"/);
    assert.ok(ariaLabelledbyMatch, `FAQ panel ${i + 1} must have aria-labelledby`);
    const labelledbyId = ariaLabelledbyMatch[1];

    const ariaHiddenMatch = panelAttrs.match(/aria-hidden="([^"]+)"/);
    assert.ok(ariaHiddenMatch, `FAQ panel ${i + 1} must have aria-hidden`);
    assert.strictEqual(ariaHiddenMatch[1], 'true', `FAQ panel ${i + 1} must initially have aria-hidden="true"`);

    // Cross reference 1-to-1 integrity
    assert.strictEqual(controlsId, panelId, `Button aria-controls (${controlsId}) must match panel id (${panelId})`);
    assert.strictEqual(labelledbyId, btnId, `Panel aria-labelledby (${labelledbyId}) must match button id (${btnId})`);
  }
});

test('Frontend: FAQ accordion JavaScript state and ARIA synchronization', () => {
  const origDocument = globalThis.document;
  const origFormData = globalThis.FormData;
  const origFetch = globalThis.fetch;
  const origIntersectionObserver = globalThis.IntersectionObserver;

  try {
    class MockClassList {
      constructor(initialClasses = []) {
        this.classes = new Set(initialClasses);
      }
      add(c) { this.classes.add(c); }
      remove(c) { this.classes.delete(c); }
      contains(c) { return this.classes.has(c); }
      toggle(c, force) {
        if (typeof force === 'boolean') {
          if (force) this.classes.add(c);
          else this.classes.delete(c);
          return force;
        }
        if (this.classes.has(c)) {
          this.classes.delete(c);
          return false;
        }
        this.classes.add(c);
        return true;
      }
    }

    class MockAccordionHeader {
      constructor(ariaControls = null) {
        this.classList = new MockClassList();
        this.attributes = new Map();
        if (ariaControls) {
          this.attributes.set('aria-controls', ariaControls);
        }
        this.listeners = {};
      }
      setAttribute(name, val) { this.attributes.set(name, String(val)); }
      getAttribute(name) { return this.attributes.get(name) || null; }
      addEventListener(event, handler) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(handler);
      }
      click() {
        if (this.listeners['click']) {
          for (const h of this.listeners['click']) {
            h();
          }
        }
      }
    }

    class MockAccordionContent {
      constructor(initialClasses = []) {
        this.classList = new MockClassList(initialClasses);
        this.attributes = new Map();
      }
      setAttribute(name, val) { this.attributes.set(name, String(val)); }
      getAttribute(name) { return this.attributes.get(name) || null; }
    }

    // Mock Elements
    // Case 1 & 2 & 3: Standard initially-closed FAQ item
    const content1 = new MockAccordionContent();
    const header1 = new MockAccordionHeader('faq-panel-1');

    // Case 4: Initially-open FAQ item
    const content2 = new MockAccordionContent(['is-open']);
    const header2 = new MockAccordionHeader('faq-panel-2');

    // Case 5: Missing aria-controls attribute
    const header3_no_attr = new MockAccordionHeader(null);

    // Case 6: aria-controls referencing non-existent panel
    const header4_missing_target = new MockAccordionHeader('non-existent-panel');

    // Case 7: Independent item for multi-open test
    const content5 = new MockAccordionContent();
    const header5_indep = new MockAccordionHeader('faq-panel-5');

    const panelElements = {
      'faq-panel-1': content1,
      'faq-panel-2': content2,
      'faq-panel-5': content5
    };

    const docListeners = {};
    globalThis.document = {
      getElementById: (id) => panelElements[id] || null,
      querySelectorAll: (selector) => {
        if (selector === '.accordion-header') {
          return [header1, header2, header3_no_attr, header4_missing_target, header5_indep];
        }
        return [];
      },
      addEventListener: (event, handler) => {
        if (!docListeners[event]) docListeners[event] = [];
        docListeners[event].push(handler);
      },
      body: {
        style: {}
      }
    };

    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    // Load and execute ACTUAL public/js/main.js
    const mainJs = fs.readFileSync('public/js/main.js', 'utf8');
    const fn = new Function(mainJs);
    fn();

    // Trigger DOMContentLoaded in case anything is registered inside it
    if (docListeners['DOMContentLoaded']) {
      for (const h of docListeners['DOMContentLoaded']) {
        h();
      }
    }

    // --- Verification 1: Standard closed FAQ initial state ---
    assert.strictEqual(header1.getAttribute('aria-expanded'), 'false', 'Initial aria-expanded must be "false"');
    assert.strictEqual(content1.getAttribute('aria-hidden'), 'true', 'Initial aria-hidden must be "true"');
    assert.strictEqual(header1.classList.contains('is-active'), false, 'Initial header must not have is-active');
    assert.strictEqual(content1.classList.contains('is-open'), false, 'Initial content must not have is-open');

    // --- Verification 2: First click -> Open ---
    header1.click();
    assert.strictEqual(header1.getAttribute('aria-expanded'), 'true', 'First click must set aria-expanded to "true"');
    assert.strictEqual(content1.getAttribute('aria-hidden'), 'false', 'First click must set aria-hidden to "false"');
    assert.strictEqual(header1.classList.contains('is-active'), true, 'First click must add is-active to header');
    assert.strictEqual(content1.classList.contains('is-open'), true, 'First click must add is-open to content');

    // --- Verification 3: Second click -> Close ---
    header1.click();
    assert.strictEqual(header1.getAttribute('aria-expanded'), 'false', 'Second click must set aria-expanded to "false"');
    assert.strictEqual(content1.getAttribute('aria-hidden'), 'true', 'Second click must set aria-hidden to "true"');
    assert.strictEqual(header1.classList.contains('is-active'), false, 'Second click must remove is-active from header');
    assert.strictEqual(content1.classList.contains('is-open'), false, 'Second click must remove is-open from content');

    // --- Verification 4: Initially open FAQ ---
    assert.strictEqual(header2.getAttribute('aria-expanded'), 'true', 'Pre-opened item must initialize aria-expanded to "true"');
    assert.strictEqual(content2.getAttribute('aria-hidden'), 'false', 'Pre-opened item must initialize aria-hidden to "false"');
    assert.strictEqual(header2.classList.contains('is-active'), true, 'Pre-opened item must initialize with is-active');
    assert.strictEqual(content2.classList.contains('is-open'), true, 'Pre-opened item content must have is-open');

    // Click to close pre-opened item
    header2.click();
    assert.strictEqual(header2.getAttribute('aria-expanded'), 'false', 'Clicking pre-opened item must set aria-expanded to "false"');
    assert.strictEqual(content2.getAttribute('aria-hidden'), 'true', 'Clicking pre-opened item must set aria-hidden to "true"');
    assert.strictEqual(header2.classList.contains('is-active'), false, 'Clicking pre-opened item must remove is-active');
    assert.strictEqual(content2.classList.contains('is-open'), false, 'Clicking pre-opened item must remove is-open');

    // --- Verification 5: Missing aria-controls attribute safety ---
    assert.doesNotThrow(() => {
      header3_no_attr.click();
    }, 'Header without aria-controls attribute must not throw');

    // --- Verification 6: Missing panel in DOM safety ---
    assert.doesNotThrow(() => {
      header4_missing_target.click();
    }, 'Header with non-existent panel target must not throw');

    // --- Verification 7: Multiple independent items state preservation ---
    // Re-open header1
    header1.click();
    assert.strictEqual(header1.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(content1.getAttribute('aria-hidden'), 'false');
    // Verify header5_indep is still closed
    assert.strictEqual(header5_indep.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(content5.getAttribute('aria-hidden'), 'true');
    // Open header5_indep
    header5_indep.click();
    assert.strictEqual(header5_indep.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(content5.getAttribute('aria-hidden'), 'false');
    // Both header1 and header5_indep remain open simultaneously
    assert.strictEqual(header1.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(content1.getAttribute('aria-hidden'), 'false');

  } finally {
    globalThis.document = origDocument;
    globalThis.FormData = origFormData;
    globalThis.fetch = origFetch;
    globalThis.IntersectionObserver = origIntersectionObserver;
  }
});

test('Activities: daily gallery remains primary after annual events removal', () => {
  const filePath = path.join('public', 'activities.html');
  assert.ok(fs.existsSync(filePath), 'public/activities.html must exist');
  const html = fs.readFileSync(filePath, 'utf8');

  // A. Deletion verification
  assert.strictEqual(html.includes('年間行事（一例）'), false, 'Must not contain "年間行事（一例）"');
  assert.strictEqual(html.includes('お花見、新入生歓迎会、散策'), false, 'Must not contain spring events');
  assert.strictEqual(html.includes('七夕、夏祭り、かき氷作り'), false, 'Must not contain summer events');
  assert.strictEqual(html.includes('ハロウィン、運動会、紅葉狩り'), false, 'Must not contain autumn events');
  assert.strictEqual(html.includes('クリスマス会、初詣、節分、ひな祭り'), false, 'Must not contain winter events');
  assert.strictEqual(html.includes('毎月のお誕生日会'), false, 'Must not contain birthday party note');
  assert.strictEqual(html.includes('event-list'), false, 'Must not contain event-list class');

  // B. Maintenance verification
  assert.match(html, /<h1 class="page-title">活動の様子<\/h1>/, 'Must contain page title "活動の様子"');
  assert.match(html, /<h2 class="section-title">日々の様子<\/h2>/, 'Must contain section title "日々の様子"');

  const dailyHeadings = html.match(/<h2 class="section-title">日々の様子<\/h2>/g) || [];
  assert.strictEqual(dailyHeadings.length, 1, 'Must contain exactly 1 "日々の様子" section title');

  assert.ok(html.includes('class="gallery-grid"'), 'Must contain gallery-grid');

  const galleryItems = html.match(/class="gallery-item lightbox-trigger"/g) || [];
  assert.strictEqual(galleryItems.length, 8, 'Must contain exactly 8 gallery items with lightbox trigger');

  const ariaLabels = html.match(/aria-label="活動写真を拡大表示"/g) || [];
  assert.strictEqual(ariaLabels.length, 8, 'Must contain exactly 8 aria-label="活動写真を拡大表示"');

  const avifSources = html.match(/<source\s+srcset="images\/photo-[^"]+\.avif"\s+type="image\/avif">/g) || [];
  assert.strictEqual(avifSources.length, 8, 'Must contain exactly 8 AVIF gallery sources');

  const webpSources = html.match(/<source\s+srcset="images\/photo-[^"]+\.webp"\s+type="image\/webp">/g) || [];
  assert.strictEqual(webpSources.length, 8, 'Must contain exactly 8 WebP gallery sources');

  const jpegImgs = html.match(/<img\s+decoding="async"\s+src="images\/photo-[^"]+\.jpg"/g) || [];
  assert.strictEqual(jpegImgs.length, 8, 'Must contain exactly 8 JPEG fallback images');

  // C. Primary structure verification
  const activitiesSectionMatch = html.match(/<section class="section activities[^"]*">([\s\S]*?)<\/section>/);
  assert.ok(activitiesSectionMatch, 'Must contain activities section');
  const sectionInner = activitiesSectionMatch[1];

  const firstH2Match = sectionInner.match(/<h2 class="section-title">([\s\S]*?)<\/h2>/);
  assert.ok(firstH2Match, 'Activities section must contain an h2');
  assert.strictEqual(firstH2Match[1], '日々の様子', 'First h2 in activities section must be "日々の様子"');

  assert.strictEqual(sectionInner.includes('content-box'), false, 'Activities section must not contain empty or residual content-box');

  // D. SEO description verification
  const newDesc = '生活介護 希望の家での日々の活動や創作活動、音楽、運動などの様子をご紹介します。';
  const oldDesc = '生活介護 希望の家での日々の活動やイベント、創作活動の様子をご紹介します。';

  assert.strictEqual(html.includes(oldDesc), false, 'Must not contain old description');

  const descMetaMatch = html.match(new RegExp(`<meta\\s+name="description"\\s+content="${newDesc}">`));
  assert.ok(descMetaMatch, 'Must contain new meta description');

  const ogDescMatch = html.match(new RegExp(`<meta\\s+property="og:description"\\s+content="${newDesc}">`));
  assert.ok(ogDescMatch, 'Must contain new og:description');

  const twDescMatch = html.match(new RegExp(`<meta\\s+name="twitter:description"\\s+content="${newDesc}">`));
  assert.ok(twDescMatch, 'Must contain new twitter:description');
});

test('Service: creative activity heading uses approved support wording', () => {
  const serviceHtmlPath = path.resolve('public/service.html');
  assert.ok(fs.existsSync(serviceHtmlPath), 'public/service.html must exist');

  const html = fs.readFileSync(serviceHtmlPath, 'utf8');

  // 1. Heading verification
  const newHeadingMatches = html.match(/<h3>創作活動支援<\/h3>/g) || [];
  assert.strictEqual(newHeadingMatches.length, 1, 'Must contain exactly 1 <h3>創作活動支援</h3>');

  const oldHeadingMatches = html.match(/<h3>創作的活動<\/h3>/g) || [];
  assert.strictEqual(oldHeadingMatches.length, 0, 'Must not contain <h3>創作的活動</h3>');

  // 2. Info text preservation
  assert.ok(
    html.includes('創作的活動や生産活動の機会を提供する障害福祉サービスです。'),
    'Must maintain "創作的活動" in the "生活介護とは" service description text'
  );

  // 3. Existing headings preservation
  assert.match(html, /<h3>日常生活支援<\/h3>/, 'Must maintain <h3>日常生活支援</h3>');
  assert.match(html, /<h3>生産活動<\/h3>/, 'Must maintain <h3>生産活動</h3>');
  assert.match(html, /<h3>集団・余暇活動<\/h3>/, 'Must maintain <h3>集団・余暇活動</h3>');

  // 4. Description text under creative activity support heading
  assert.ok(
    html.includes('絵画、手芸、工作など、季節に合わせた様々なアート活動を行います。表現する楽しさを味わい、豊かな感性を育みます。'),
    'Must maintain existing description text under 創作活動支援'
  );
});

