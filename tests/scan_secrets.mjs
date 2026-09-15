import fs from 'node:fs';
import path from 'node:path';

// Exact match allowlist for known benign test tokens, hashes, and dummy IDs
export const ALLOWLIST_STRINGS = new Set([
  'test-secret-signing-key-32bytes!',
  'test-turnstile-secret',
  'valid-turnstile-secret-key-123',
  'AKfycbxyz',
  'MAX_TIMESTAMP_RECEIVED_AT_DIFF_MS',
  '12345678901234567890123456789012',
  '1234567890123456789012345678901212345678901234567890123456789012',
  '123e4567-e89b-42d3-a456-426614174000',
  '123e4567-e89b-12d3-a456-426614174000',
  '8255fb79c6e0db6b437b4125be5542f1461f41f649270f013532dae26dc9b205',
  'e09baf7891b70b0e98cfb45b8ef51b40359ae36148b91cf9a82a3f1f4babb2a5',
  '1111111111111111111111111111111111111111111111111111111111111111',
  '00000000000000000000000000000000',
  '1x00000000000000000000AA', // Dummy Cloudflare Turnstile SiteKey
  '9'.repeat(100), // Test string for 100+ digit Content-Length
  'X-Permitted-Cross-Domain-Policies',
  'x-permitted-cross-domain-policies',
  'sha256-/sEhTg6MOarI5GLSBqSnNXhPnk/TPYQoSQS23QPPxaQ=',
  'sha256-QtXWJ5QiWz1r4gLi+qesGDhqm8FQ6M2jyTYSJ7jgfm4='
]);

function mask(str) {
  if (!str || str.length <= 8) return '****';
  return str.slice(0, 4) + '...' + str.slice(-4);
}

const EXCLUDE_DIRS = new Set([
  '.git',
  'kibounoie-hp.git',
  'node_modules',
  '.wrangler',
  '.temp_scan_fixture'
]);

const BINARY_EXTS = new Set(['.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.pdf', '.zip']);

function isIgnoredNonSecret(token, content, matchIndex) {
  if (/^[-_=/]+$/.test(token)) return true;
  if (token.startsWith('http://') || token.startsWith('https://')) return true;
  if (content && typeof matchIndex === 'number') {
    const preceding = content.slice(Math.max(0, matchIndex - 50), matchIndex);
    if (/https?:\/\/[^\s"'`<>]*$/i.test(preceding)) {
      return true;
    }
    const following = content.slice(matchIndex + token.length, matchIndex + token.length + 10);
    if (/^\.(?:jpg|jpeg|png|gif|webp|avif|svg|ico|html|css|js|mjs|json|jsonc|woff2?|ttf)\b/i.test(following)) {
      return true;
    }
  }
  return false;
}

export function scanContent(content, filePath, allowlist = ALLOWLIST_STRINGS) {
  const fileFindings = [];

  const PATTERNS = [
    { name: 'PEM Private Key', regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/g },
    { name: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/g },
    { name: 'GAS Deployment ID', regex: /AKfy[A-Za-z0-9_-]{30,}/g },
    { name: 'Stripe Secret Key', regex: /sk_(?:live|test)_[0-9a-zA-Z]{24,}/g },
    { name: 'GitHub Token', regex: /(?:ghp_[0-9a-zA-Z]{36,}|github_pat_[0-9a-zA-Z_]{22,})/g },
    { name: 'Bearer Token', regex: /Bearer\s+[a-zA-Z0-9_\-\.\=]{30,}/gi },
    { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
    { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'Test Secret Candidate', regex: /test-secret-[^\s"';,]+/g },
    { name: 'Test Turnstile Candidate', regex: /test-turnstile-[^\s"';,]+/g }
  ];

  // 1. Specific Pattern Scanning
  for (const { name, regex } of PATTERNS) {
    const matches = content.match(regex) || [];
    for (const m of matches) {
      const isAllowlisted = allowlist.has(m);
      fileFindings.push({
        file: filePath,
        type: name,
        masked: mask(m),
        allowlisted: isAllowlisted,
        raw: m
      });
    }
  }

  // 2. High-Entropy Base64, Base64URL & Hex Candidate Scanning (32+ chars)
  const tokenRegex = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
  let match;
  while ((match = tokenRegex.exec(content)) !== null) {
    const token = match[0];
    if (isIgnoredNonSecret(token, content, match.index)) continue;

    // Check exact allowlist match
    const isAllowlisted = allowlist.has(token);

    // Don't add duplicate if pattern matcher already recorded it
    if (fileFindings.some(f => f.raw === token)) continue;

    fileFindings.push({
      file: filePath,
      type: '32+ High-Entropy Token (Hex/Base64/Base64URL)',
      masked: mask(token),
      allowlisted: isAllowlisted,
      raw: token
    });
  }

  return fileFindings;
}

// -------------------------------------------------------------
// Workspace Scanning & Fail-Closed Evaluation Engine
// -------------------------------------------------------------
export function getAllFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) {
        results.push(...getAllFiles(fullPath));
      }
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export function runScan(workspaceRoot, options = {}) {
  const readFileFn = options.readFileFn || fs.readFileSync;
  const allowlist = options.allowlist || ALLOWLIST_STRINGS;
  
  const allDiscoveredFiles = getAllFiles(workspaceRoot).map(f => path.relative(workspaceRoot, f).replace(/\\/g, '/')).sort();

  const skippedSelfFiles = [];
  const skippedBinaryFiles = [];
  const scannedTextFiles = [];
  const readErrorFiles = [];
  const allFindings = [];

  for (const file of allDiscoveredFiles) {
    if (file === 'tests/scan_secrets.mjs') {
      skippedSelfFiles.push(file);
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    if (BINARY_EXTS.has(ext)) {
      skippedBinaryFiles.push(file);
      continue;
    }

    try {
      const content = readFileFn(path.join(workspaceRoot, file), 'utf8');
      scannedTextFiles.push(file);
      const fileFindings = scanContent(content, file, allowlist);
      allFindings.push(...fileFindings);
    } catch (err) {
      readErrorFiles.push({ file, error: 'Read/Decoding failed' });
    }
  }

  const cleanedFindings = allFindings.map(({ raw, ...rest }) => rest);
  const unallowedFindings = cleanedFindings.filter(f => !f.allowlisted);

  const summary = {
    discovered_files_count: allDiscoveredFiles.length,
    scanned_text_files_count: scannedTextFiles.length,
    skipped_self_files_count: skippedSelfFiles.length,
    skipped_self_files: skippedSelfFiles,
    skipped_binary_files_count: skippedBinaryFiles.length,
    skipped_binary_files: skippedBinaryFiles,
    read_error_files_count: readErrorFiles.length,
    read_error_files: readErrorFiles,
    total_findings_count: cleanedFindings.length,
    allowlisted_findings_count: cleanedFindings.filter(f => f.allowlisted).length,
    unallowed_findings_count: unallowedFindings.length,
    findings: cleanedFindings
  };

  const isFailed = unallowedFindings.length > 0 || readErrorFiles.length > 0;
  const exitCode = isFailed ? 1 : 0;

  return { summary, unallowedFindings, readErrorFiles, isFailed, exitCode };
}

// -------------------------------------------------------------
// 1. Self-Regression Test Suite (19 Automated Tests)
// -------------------------------------------------------------
export function runRegressionTests() {
  const fixtureDir = path.resolve('tests/.temp_scan_fixture');
  if (fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });

  const stripePrefix = ['sk', 'live'].join('_');
  const stripeCandidate = `${stripePrefix}_${'1234567890'.repeat(3)}`;

  const testCases = [
    { name: '.env', content: 'SECRET_API_KEY=AIzaSyD_UnallowedGoogleApiKey1234567890\n', expectFail: true, desc: 'Google API Key in .env' },
    { name: '.dev.vars', content: 'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\n', expectFail: true, desc: 'AWS Key in .dev.vars' },
    { name: 'base64_slash.txt', content: 'token = "dGVzdC9zZWNyZXQva2V5LzEyMzQ1Njc4OTAxMjM0NTY=";', expectFail: true, desc: 'Base64 with slash /' },
    { name: 'base64_plus.txt', content: 'token = "dGVzdCtzZWNyZXQra2V5KzEyMzQ1Njc4OTAxMjM0NTY=";', expectFail: true, desc: 'Base64 with plus +' },
    { name: 'base64url.txt', content: 'token = "dGVzdC1zZWNyZXQfa2V5XzEyMzQ1Njc4OTAxMjM0NTY";', expectFail: true, desc: 'Base64URL with - and _' },
    { name: 'unregistered_test_secret.txt', content: 'const sec = "test-secret-REAL_UNKNOWN_SECRET_VALUE!";', expectFail: true, desc: 'Unregistered test-secret-*' },
    { name: 'unregistered_turnstile_secret.txt', content: 'const sec = "test-turnstile-UNREGISTERED_VALUE";', expectFail: true, desc: 'Unregistered test-turnstile-*' },
    { name: 'pem_key.txt', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...', expectFail: true, desc: 'PEM private key header' },
    { name: 'github_pat.txt', content: 'const pat = "ghp_1234567890abcdef1234567890abcdef1234";', expectFail: true, desc: 'GitHub Token' },
    { name: 'stripe_key.txt', content: `const stripe = "${stripeCandidate}";\n`, expectFail: true, desc: 'Stripe Secret Key' },
    { name: 'exact_allowed.txt', content: 'const valid = "test-secret-signing-key-32bytes!";', expectFail: false, desc: 'Exact allowlisted token' },
    { name: 'prefix_allowed_tampered.txt', content: 'const bad = "prefix_test-secret-signing-key-32bytes!";', expectFail: true, desc: 'Allowlisted token with prefix' },
    { name: 'suffix_allowed_tampered.txt', content: 'const bad = "test-secret-signing-key-32bytes!_suffix";', expectFail: true, desc: 'Allowlisted token with suffix' },
    { name: 'make_secret_fixture.txt', content: 'dummy = "UNREGISTERED_MAKE_SECRET_VALUE_123456789";', expectFail: true, desc: 'make_* filename with unallowed candidate' },
    { name: 'upper_snake_case.txt', content: 'const K = "UNREGISTERED_UPPER_SNAKE_CASE_SECRET_32B";', expectFail: true, desc: '32+ UPPER_SNAKE_CASE unallowed string' },
    { name: 'macros_secret.txt', content: 'token = "macros/s/UNREGISTERED_SECRET_KEY_1234567890123456";', expectFail: true, desc: '32+ token containing macros/s/' },
    { name: 'images_secret.txt', content: 'token = "images/UNREGISTERED_SECRET_KEY_1234567890123456";', expectFail: true, desc: '32+ token containing images/' },
    { name: 'public_images_secret.txt', content: 'token = "public/images/UNREGISTERED_SECRET_KEY_1234567890123456";', expectFail: true, desc: '32+ token containing public/images/' }
  ];

  let passedTests = 0;

  try {
    for (const tc of testCases) {
      const p = path.join(fixtureDir, tc.name);
      fs.writeFileSync(p, tc.content, 'utf8');
      const findings = scanContent(tc.content, p);

      if (!tc.expectFail) {
        if (findings.length === 0 || !findings.every(f => f.allowlisted)) {
          throw new Error(`Regression Test Failed: [${tc.desc}] (${tc.name}) was not accepted.`);
        }
      } else {
        const unallowed = findings.filter(f => !f.allowlisted);
        if (unallowed.length === 0) {
          throw new Error(`Regression Test Failed: [${tc.desc}] (${tc.name}) was NOT detected by scanner!`);
        }
      }
      passedTests++;
    }

    // 19. Deterministic Injected Read Error Test using Real runScan() and Failure Evaluation Engine
    const mockReadFile = (filePath, enc) => {
      if (filePath.includes('exact_allowed.txt')) {
        throw new Error('EACCES: permission denied, read mock error');
      }
      return fs.readFileSync(filePath, enc);
    };

    const injectedResult = runScan(fixtureDir, { readFileFn: mockReadFile });
    if (injectedResult.summary.read_error_files_count !== 1) {
      throw new Error(`Regression Test Failed: Expected 1 read error, got ${injectedResult.summary.read_error_files_count}`);
    }
    if (!injectedResult.isFailed || injectedResult.exitCode !== 1) {
      throw new Error('Regression Test Failed: Scanner did not evaluate failure (exit code 1) on read error');
    }
    if (JSON.stringify(injectedResult.summary.read_error_files).includes('test-secret-signing-key-32bytes!')) {
      throw new Error('Regression Test Failed: Secret content leaked into read error log');
    }
    passedTests++;

    console.log(`Secret Scanner Self-Regression Tests: ${passedTests}/${passedTests} passed successfully.`);
  } finally {
    if (fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
}

// -------------------------------------------------------------
// 2. Production Execution
// -------------------------------------------------------------
runRegressionTests();

const workspaceRoot = path.resolve('.');
const { summary, unallowedFindings, readErrorFiles, isFailed, exitCode } = runScan(workspaceRoot);

console.log(JSON.stringify(summary, null, 2));

if (isFailed) {
  if (unallowedFindings.length > 0) {
    console.error(`Secret Scan FAILED: Found ${unallowedFindings.length} unallowlisted secret candidates:`, unallowedFindings);
  }
  if (readErrorFiles.length > 0) {
    console.error(`Secret Scan FAILED: Encountered ${readErrorFiles.length} file read errors:`, readErrorFiles);
  }
  process.exit(exitCode);
} else {
  console.log(`Secret Scan PASSED: 0 unallowlisted secrets and 0 read errors across ${summary.scanned_text_files_count} scanned text files (Total discovered: ${summary.discovered_files_count}).`);
  process.exit(0);
}
