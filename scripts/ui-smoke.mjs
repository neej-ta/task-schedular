// Headless-browser smoke test: loads the dashboard, logs in, visits every page,
// exercises the recurrence builder, and fails on any uncaught JS error.
import { chromium } from 'playwright';

const BASE = process.env.DASH_URL ?? 'http://localhost:5174';
const pageErrors = [];
const consoleErrors = [];
const steps = [];
let failed = false;

function ok(name) { steps.push(`  ✓ ${name}`); }
function bad(name, e) { steps.push(`  ✗ ${name} — ${e}`); failed = true; }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Login (fields are prefilled with the seeded admin creds).
  await page.locator('input[type=email]').fill('admin@conductor.local');
  await page.locator('input[type=password]').fill('admin123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Schedules' }).waitFor({ timeout: 10000 });
  ok('login → dashboard shell renders');

  // Tasks (default).
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.getByRole('heading', { name: 'Tasks' }).waitFor({ timeout: 5000 });
  ok('Tasks page renders');

  // Schedules + recurrence builder.
  await page.getByRole('button', { name: 'Schedules' }).click();
  await page.getByRole('button', { name: 'New schedule' }).click();
  const freq = page.locator('select').filter({ has: page.locator('option', { hasText: 'Every few minutes' }) }).first();
  await freq.waitFor({ timeout: 5000 });
  ok('Schedules: recurrence builder opens (friendly frequency picker)');
  await freq.selectOption({ label: 'Every week' });
  await page.getByRole('button', { name: 'Mon', exact: true }).waitFor({ timeout: 5000 });
  ok('Schedules: weekly shows day-of-week buttons');
  await freq.selectOption({ label: 'Every month' });
  await page.getByText('Day of month').waitFor({ timeout: 5000 });
  ok('Schedules: monthly shows day-of-month input');
  await page.getByText(/Monthly on day/).first().waitFor({ timeout: 5000 });
  ok('Schedules: plain-English schedule summary renders');

  // Connections (was Projects).
  await page.getByRole('button', { name: 'Connections' }).click();
  await page.getByText('Demo (demo-target)').waitFor({ timeout: 8000 });
  ok('Connections page renders seeded connection');

  // Activity.
  await page.getByRole('button', { name: 'Activity' }).click();
  await page.getByRole('heading', { name: 'Activity' }).waitFor({ timeout: 5000 });
  ok('Activity page renders');

  // System (was Workers).
  await page.getByRole('button', { name: 'System' }).click();
  await page.getByText('Engines', { exact: true }).waitFor({ timeout: 8000 });
  await page.getByText('Work waiting in line', { exact: true }).waitFor({ timeout: 8000 });
  ok('System page renders engines + queues');

  // Insights (was Metrics) — recharts SVG should render.
  await page.getByRole('button', { name: 'Insights' }).click();
  await page.locator('svg.recharts-surface').first().waitFor({ timeout: 8000 });
  ok('Insights page renders charts (recharts SVG)');
} catch (e) {
  bad('navigation', e.message);
}

await browser.close();

if (pageErrors.length) { failed = true; steps.push(`  ✗ ${pageErrors.length} uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}`); }
// Console errors are reported but only fail the run if they look like real app errors.
const realConsole = consoleErrors.filter((t) => !/favicon|EventSource|net::ERR|Failed to load resource/i.test(t));
if (realConsole.length) { failed = true; steps.push(`  ✗ ${realConsole.length} console error(s): ${realConsole.slice(0, 3).join(' | ')}`); }
else if (consoleErrors.length) steps.push(`  (ℹ ${consoleErrors.length} benign console msgs ignored: favicon/SSE/network)`);

console.log('\n=== UI SMOKE ===');
console.log(steps.join('\n'));
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
