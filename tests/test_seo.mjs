import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HTML_FILES = [
  'index.html',
  'about.html',
  'service.html',
  'facility.html',
  'guide.html',
  'activities.html',
  'faq.html',
  'access.html',
  'contact.html',
  'privacy.html'
];

function getJpegDimensions(buffer) {
  let i = 0;
  if (buffer.readUInt16BE(0) !== 0xFFD8) return null; // Not JPEG
  i += 2;
  while (i < buffer.length) {
    const marker = buffer.readUInt16BE(i);
    i += 2;
    if (marker >= 0xFFC0 && marker <= 0xFFC3) {
      const height = buffer.readUInt16BE(i + 3);
      const width = buffer.readUInt16BE(i + 5);
      return { width, height };
    } else {
      const len = buffer.readUInt16BE(i);
      i += len;
    }
  }
  return null;
}

test('SEO: Exact 10 HTML pages exist in public/', () => {
  const files = fs.readdirSync('public').filter(f => f.endsWith('.html'));
  assert.strictEqual(files.length, 10, 'public/ must contain exactly 10 HTML files');
  assert.deepStrictEqual(files.sort(), HTML_FILES.slice().sort());
});

test('SEO: OGP & Twitter Card metadata matches actual image dimensions and production domain', () => {
  const ogpImagesFound = new Set();

  for (const filename of HTML_FILES) {
    const filePath = path.join('public', filename);
    const html = fs.readFileSync(filePath, 'utf8');

    // Ensure no duplicate/stale GitHub Pages domain is present in public HTML
    assert.strictEqual(
      html.includes('utility-s.github.io'),
      false,
      `${filename} must not contain stale GitHub Pages domain utility-s.github.io`
    );

    // Canonical check
    const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
    assert.ok(canonicalMatch, `${filename} must have a canonical tag`);
    const canonicalUrl = canonicalMatch[1];
    assert.ok(canonicalUrl.startsWith('https://kibounoie-akiruno.org'), `${filename} canonical must be HTTPS non-www`);

    // OGP properties
    const ogLocale = html.match(/<meta\s+property="og:locale"\s+content="([^"]+)"/);
    assert.ok(ogLocale, `${filename} must have og:locale`);
    assert.strictEqual(ogLocale[1], 'ja_JP');

    const ogType = html.match(/<meta\s+property="og:type"\s+content="([^"]+)"/);
    assert.ok(ogType, `${filename} must have og:type`);
    assert.strictEqual(ogType[1], 'website');

    const ogSiteName = html.match(/<meta\s+property="og:site_name"\s+content="([^"]+)"/);
    assert.ok(ogSiteName, `${filename} must have og:site_name`);
    assert.strictEqual(ogSiteName[1], '希望の家');

    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    assert.ok(ogTitle, `${filename} must have og:title`);
    assert.ok(ogTitle[1].length > 0);

    const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
    assert.ok(ogDesc, `${filename} must have og:description`);
    assert.ok(ogDesc[1].length > 0);

    const ogUrl = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/);
    assert.ok(ogUrl, `${filename} must have og:url`);
    assert.strictEqual(ogUrl[1], canonicalUrl, `${filename} og:url must match canonical URL`);

    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
    assert.ok(ogImage, `${filename} must have og:image`);
    assert.ok(ogImage[1].startsWith('https://kibounoie-akiruno.org/images/'), `${filename} og:image must be absolute HTTPS on production domain`);
    assert.ok(ogImage[1].endsWith('.jpg') || ogImage[1].endsWith('.png'), `${filename} og:image must use crawlable JPEG/PNG fallback, not AVIF`);

    // Verify local referenced file exists and get real dimensions
    const relImagePath = ogImage[1].replace('https://kibounoie-akiruno.org/', 'public/');
    assert.ok(fs.existsSync(relImagePath), `Referenced OGP image ${relImagePath} must exist`);
    ogpImagesFound.add(relImagePath);

    const imageBuf = fs.readFileSync(relImagePath);
    const actualDimensions = getJpegDimensions(imageBuf);
    assert.ok(actualDimensions, `Unable to parse JPEG dimensions for ${relImagePath}`);

    const ogWidth = html.match(/<meta\s+property="og:image:width"\s+content="([^"]+)"/);
    assert.ok(ogWidth, `${filename} must have og:image:width`);
    assert.strictEqual(
      parseInt(ogWidth[1], 10),
      actualDimensions.width,
      `${filename} og:image:width (${ogWidth[1]}) must match actual image width (${actualDimensions.width})`
    );

    const ogHeight = html.match(/<meta\s+property="og:image:height"\s+content="([^"]+)"/);
    assert.ok(ogHeight, `${filename} must have og:image:height`);
    assert.strictEqual(
      parseInt(ogHeight[1], 10),
      actualDimensions.height,
      `${filename} og:image:height (${ogHeight[1]}) must match actual image height (${actualDimensions.height})`
    );

    const ogAlt = html.match(/<meta\s+property="og:image:alt"\s+content="([^"]+)"/);
    assert.ok(ogAlt, `${filename} must have og:image:alt`);

    // Twitter card properties
    const twCard = html.match(/<meta\s+name="twitter:card"\s+content="([^"]+)"/);
    assert.ok(twCard, `${filename} must have twitter:card`);
    assert.strictEqual(twCard[1], 'summary_large_image');

    const twTitle = html.match(/<meta\s+name="twitter:title"\s+content="([^"]+)"/);
    assert.ok(twTitle, `${filename} must have twitter:title`);
    assert.strictEqual(twTitle[1], ogTitle[1]);

    const twDesc = html.match(/<meta\s+name="twitter:description"\s+content="([^"]+)"/);
    assert.ok(twDesc, `${filename} must have twitter:description`);
    assert.strictEqual(twDesc[1], ogDesc[1]);

    const twImage = html.match(/<meta\s+name="twitter:image"\s+content="([^"]+)"/);
    assert.ok(twImage, `${filename} must have twitter:image`);
    assert.strictEqual(twImage[1], ogImage[1]);
    assert.ok(twImage[1].endsWith('.jpg') || twImage[1].endsWith('.png'), `${filename} twitter:image must use crawlable JPEG/PNG fallback`);

    const twAlt = html.match(/<meta\s+name="twitter:image:alt"\s+content="([^"]+)"/);
    assert.ok(twAlt, `${filename} must have twitter:image:alt`);
    assert.strictEqual(twAlt[1], ogAlt[1]);
  }

  assert.ok(ogpImagesFound.size > 0, 'Must have found verified OGP images');
});

test('SEO: JSON-LD structured data is valid, byte-for-byte identical, and matches CSP hash', () => {
  let firstJsonLdRaw = null;

  for (const filename of HTML_FILES) {
    const filePath = path.join('public', filename);
    const html = fs.readFileSync(filePath, 'utf8');

    const match = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(match, `${filename} must contain JSON-LD script tag`);
    const jsonLdRaw = match[1];

    if (firstJsonLdRaw === null) {
      firstJsonLdRaw = jsonLdRaw;
    } else {
      assert.strictEqual(jsonLdRaw, firstJsonLdRaw, `${filename} JSON-LD content must be byte-for-byte identical to index.html`);
    }

    // Verify JSON validity
    const data = JSON.parse(jsonLdRaw);
    assert.strictEqual(data['@context'], 'https://schema.org');
    assert.ok(Array.isArray(data['@graph']), '@graph must be an array');

    const org = data['@graph'].find(item => item['@type'] === 'Organization');
    assert.ok(org, 'Organization must be present in @graph');
    assert.strictEqual(org['name'], '社会福祉法人SHIP');
    assert.strictEqual(org['url'], 'https://www.swsc-ship.com/');
    assert.deepStrictEqual(org['sameAs'], ['https://x.com/swscship']);

    const business = data['@graph'].find(item => item['@type'] === 'LocalBusiness');
    assert.ok(business, 'LocalBusiness must be present in @graph');
    assert.strictEqual(business['name'], '生活介護 希望の家');
    assert.strictEqual(business['telephone'], '042-595-2324');
    assert.strictEqual(business['url'], 'https://kibounoie-akiruno.org/');
    assert.strictEqual(business['address']['postalCode'], '190-0164');
    assert.strictEqual(business['address']['addressRegion'], '東京都');
    assert.strictEqual(business['address']['addressLocality'], 'あきる野市');
    assert.strictEqual(business['address']['streetAddress'], '五日市374-5');
    assert.strictEqual(business['address']['addressCountry'], 'JP');

    assert.ok(Array.isArray(business['openingHoursSpecification']));
    const hours = business['openingHoursSpecification'][0];
    assert.strictEqual(hours['opens'], '10:00');
    assert.strictEqual(hours['closes'], '16:00');
  }

  // Calculate SHA-256 hash of JSON-LD content (normalized LF, trimmed)
  const normalizedJsonLd = firstJsonLdRaw.trim().replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(normalizedJsonLd, 'utf8').digest('base64');
  const expectedHashToken = `'sha256-${hash}'`;

  // Verify hash is configured in public/_headers
  const headersContent = fs.readFileSync('public/_headers', 'utf8');
  assert.ok(headersContent.includes(expectedHashToken), `public/_headers must contain CSP hash ${expectedHashToken}`);
});

test('SEO Test 1: WebSite structured data exists in index.html and specifies preferred site name', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const matches = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(matches.length >= 2, 'index.html must have at least 2 JSON-LD scripts (Org/LocalBusiness and WebSite)');

  const websiteScripts = [];
  for (const match of matches) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch (e) {
      assert.fail(`JSON-LD failed to parse: ${e.message}`);
    }
    if (parsed['@type'] === 'WebSite') {
      websiteScripts.push(parsed);
    }
  }

  assert.strictEqual(websiteScripts.length, 1, 'index.html must contain exactly 1 WebSite structured data block');
  const site = websiteScripts[0];
  assert.strictEqual(site['@context'], 'https://schema.org');
  assert.strictEqual(site['@type'], 'WebSite');
  assert.strictEqual(site['@id'], 'https://kibounoie-akiruno.org/#website');
  assert.strictEqual(site['url'], 'https://kibounoie-akiruno.org/');
  assert.strictEqual(site['name'], '希望の家');
  assert.strictEqual(site['alternateName'], '生活介護 希望の家');
  assert.strictEqual(site['inLanguage'], 'ja-JP');
});

test('SEO Test 2: WebSite structured data exists ONLY in index.html and not on the other 9 pages', () => {
  const otherPages = HTML_FILES.filter(f => f !== 'index.html');
  for (const filename of otherPages) {
    const html = fs.readFileSync(path.join('public', filename), 'utf8');
    const matches = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    for (const match of matches) {
      const parsed = JSON.parse(match[1]);
      assert.notStrictEqual(
        parsed['@type'],
        'WebSite',
        `${filename} must NOT contain WebSite structured data; WebSite must only be on index.html`
      );
    }
  }
});

test('SEO Test 3: og:site_name is exactly "希望の家" on all 10 pages and old value is gone', () => {
  for (const filename of HTML_FILES) {
    const html = fs.readFileSync(path.join('public', filename), 'utf8');
    const matches = [...html.matchAll(/<meta\s+property="og:site_name"\s+content="([^"]*)"/g)];
    assert.strictEqual(matches.length, 1, `${filename} must have exactly 1 og:site_name meta tag`);
    assert.strictEqual(matches[0][1], '希望の家', `${filename} og:site_name must be exactly "希望の家"`);

    // Verify old value is not present anywhere as og:site_name
    assert.strictEqual(
      html.includes('property="og:site_name" content="生活介護 希望の家"'),
      false,
      `${filename} must not retain old og:site_name "生活介護 希望の家"`
    );
  }
});

test('SEO Test 4: Canonical tag integrity across all 10 pages', () => {
  const EXPECTED_CANONICALS = {
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

  for (const filename of HTML_FILES) {
    const html = fs.readFileSync(path.join('public', filename), 'utf8');
    const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
    assert.ok(canonicalMatch, `${filename} must contain canonical tag`);
    assert.strictEqual(canonicalMatch[1], EXPECTED_CANONICALS[filename], `${filename} canonical mismatch`);
  }
});

test('SEO Test 5: All application/ld+json script blocks match CSP hashes in public/_headers', () => {
  const headersContent = fs.readFileSync('public/_headers', 'utf8');
  const allHashesFound = new Set();

  for (const filename of HTML_FILES) {
    const filePath = path.join('public', filename);
    const html = fs.readFileSync(filePath, 'utf8');
    const matches = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(matches.length > 0, `${filename} must have at least 1 JSON-LD script`);

    for (const match of matches) {
      const scriptContent = match[1];
      const normalizedLF = scriptContent.trim().replace(/\r\n/g, '\n');
      const hash = crypto.createHash('sha256').update(normalizedLF, 'utf8').digest('base64');
      const hashToken = `'sha256-${hash}'`;
      assert.ok(
        headersContent.includes(hashToken),
        `public/_headers CSP must contain hash token ${hashToken} for JSON-LD in ${filename}`
      );
      allHashesFound.add(hashToken);
    }
  }

  // Must include both the existing organization/business hash and the new website hash
  assert.ok(allHashesFound.has("'sha256-/sEhTg6MOarI5GLSBqSnNXhPnk/TPYQoSQS23QPPxaQ='"));
  assert.ok(allHashesFound.has("'sha256-QtXWJ5QiWz1r4gLi+qesGDhqm8FQ6M2jyTYSJ7jgfm4='"));
  assert.strictEqual(allHashesFound.size, 2, 'There should be exactly 2 distinct JSON-LD hashes across the site');
});
