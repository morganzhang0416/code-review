import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categorize,
  commandLabel,
  GIT_COMMIT_RE,
  GIT_PUSH_RE,
  isDocOrScratch,
  isValidationCommand,
  validationLabel,
} from '../src/collect/common.mjs';
import { redact, snippet, titleFrom } from '../src/redact.mjs';

test('redact masks credentials, emails and long numbers but keeps useful identifiers', () => {
  const input = [
    'password=hunter2 token: abc123 api_key="s3cr3t"',
    'Authorization: Bearer abcdefghijklmnop.qrstuvwx',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'mail jane.doe@example.com',
    'account 12-3456-0123456-00 and customer 123456789',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'keep ISSUE-12345, APP-6448, 6fa6d2ac-50e7-425f-bd69-d56ea481a3df and C:/Work/demo/copilot-session-review/analyze.mjs',
  ].join('\n');
  const out = redact(input);
  assert.doesNotMatch(out, /hunter2|abc123|s3cr3t|abcdefghijklmnop|ghp_ABC|jane\.doe|0123456-00|123456789|eyJhbGci/);
  assert.match(out, /password=\[secret\]/);
  assert.match(out, /\[email\]/);
  assert.match(out, /\[account\]/);
  assert.match(out, /ISSUE-12345/);
  assert.match(out, /APP-6448/);
  assert.match(out, /6fa6d2ac-50e7-425f-bd69-d56ea481a3df/);
  assert.match(out, /copilot-session-review/);
});

test('snippet and titleFrom flatten, redact and truncate', () => {
  assert.equal(snippet('a\n\n  b   c', 50), 'a b c');
  assert.equal(snippet('x'.repeat(30), 10), `${'x'.repeat(9)}…`);
  assert.equal(titleFrom('\n\n  First line here\nsecond'), 'First line here');
  assert.equal(titleFrom('ping me at a@b.co'), 'ping me at [email]');
});

test('validationLabel recognises real test/build/lint runs and returns the matching command', () => {
  const cases = [
    ['Set-Location C:\\x; npm test 2>&1 | Select-Object -Last 5', 'npm test'],
    ['$out = npm test -- --test-reporter=tap 2>&1; $out', 'npm test -- --test-reporter=tap'],
    ['npm run lint', 'npm run lint'],
    ['npm run test:offline', 'npm run test:offline'],
    ['node --import tsx --test src/a.test.ts', 'node --import tsx --test src/a.test.ts'],
    ['node scripts/parity/load.test.cjs', 'node scripts/parity/load.test.cjs'],
    ['npx --no-install tsc --noEmit -p tsconfig.json 2>&1', 'npx --no-install tsc --noEmit -p tsconfig.json'],
    ["$env:ENV = 'syst' npx playwright test -c playwright.config.ts", 'npx playwright test -c playwright.config.ts'],
    ['mvn -q test', 'mvn -q test'],
    ['python -m pytest tests', 'python -m pytest tests'],
    ['"--- npm test (as written)"; npm test 2>&1', 'npm test'],
  ];
  for (const [command, label] of cases) assert.equal(validationLabel(command), label, command);
});

test('validationLabel ignores installs, listings, versions and look-alikes', () => {
  for (const command of [
    'npm ci --no-audit',
    'npx playwright test --list -c playwright.config.ts',
    'npx -p typescript@5.4 tsc --version',
    'Get-Content eslint.config.js',
    'git log --grep test',
    'Select-String -Pattern "(?:vitest|jest|mocha)"',
    'cargo-test-helper --flag',
  ]) {
    assert.equal(isValidationCommand(command), false, command);
  }
});

test('commandLabel skips navigation, assignments and banners', () => {
  assert.equal(commandLabel('Set-Location C:\\Dev\\x; $a = 1; "--- run ---"; node probe.cjs --flag'), 'node probe.cjs --flag');
  assert.equal(commandLabel('cd /tmp && make all'), 'make all');
});

test('git commit/push detection tolerates -C and --no-pager', () => {
  assert.ok(GIT_COMMIT_RE.test('git -C "C:\\Dev\\x y" commit -m "msg"'));
  assert.ok(GIT_COMMIT_RE.test('git --no-pager commit --amend --no-edit'));
  assert.ok(!GIT_COMMIT_RE.test('git --no-pager log --grep commit'));
  assert.ok(GIT_PUSH_RE.test('git push origin main'));
  assert.ok(!GIT_PUSH_RE.test('git status; echo push'));
});

test('categorize maps runtime and VS Code tool names', () => {
  const expected = {
    powershell: 'shell',
    read_powershell: 'shell',
    copilot_runInTerminal: 'shell',
    view: 'read',
    copilot_readFile: 'read',
    grep: 'search',
    copilot_findTextInFiles: 'search',
    edit: 'edit',
    create: 'edit',
    copilot_replaceString: 'edit',
    task: 'delegate',
    runSubagent: 'delegate',
    web_search: 'web',
    openBrowserPage: 'web',
    skill: 'skill',
    ask_user: 'ask',
    task_complete: 'meta',
    sql: 'meta',
    'github-mcp-server-list_issues': 'integration',
  };
  for (const [name, category] of Object.entries(expected)) assert.equal(categorize(name), category, name);
});

test('isDocOrScratch separates docs/scratch from code', () => {
  assert.ok(isDocOrScratch('C:\\x\\README.md'));
  assert.ok(isDocOrScratch('C:\\x\\db-query\\scratch\\probe.cjs'));
  assert.ok(!isDocOrScratch('C:\\x\\src\\api.ts'));
});
