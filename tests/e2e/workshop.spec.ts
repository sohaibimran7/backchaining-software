/**
 * End-to-end: one organizer and two participants in three separate browser
 * sessions, against the real server and database.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

async function phone(browser: Browser, code: string, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`/join/${code}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByText('Waiting for the next question')).toBeVisible();
  return page;
}

/** In tap-to-connect mode: tap the cause, then what it affects. */
async function drawArrow(page: Page, from: string, to: string) {
  await page.locator('.rf-node', { hasText: from }).click();
  await expect(page.getByText(`From “${from}”`)).toBeVisible();
  await page.locator('.rf-node', { hasText: to }).click();
}

test('a live workshop: questions reach both phones, answers stay separate, arrows are personal, loops are refused', async ({ browser }) => {
  // — organizer creates an empty workshop —
  const organizerContext = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const organizer = await organizerContext.newPage();
  await organizer.goto('/');
  await organizer.getByLabel('Workshop name').fill('E2E workshop');
  await organizer.getByRole('button', { name: 'Create workshop' }).click();
  await expect(organizer.getByText('Nobody has joined yet')).toBeVisible();
  await expect(organizer.getByRole('img', { name: 'QR code for the join link' })).toBeVisible();
  const code = (await organizer.getByLabel('Workshop code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  // — two participants join in their own sessions —
  const alex = await phone(browser, code, 'Alex');
  const sam = await phone(browser, code, 'Sam');
  await expect(organizer.getByText('Alex', { exact: true })).toBeVisible();
  await expect(organizer.getByText('Sam', { exact: true })).toBeVisible();

  // — the organizer asks the first question; both phones receive it without reloading —
  await organizer.locator('.q-row', { hasText: 'What goal should this group work backwards from?' }).getByRole('button', { name: 'Ask now' }).click();
  for (const p of [alex, sam]) await expect(p.getByRole('heading', { name: 'What goal should this group work backwards from?' })).toBeVisible();

  await alex.getByLabel('Your suggestion').fill('Safer streets');
  await alex.getByRole('button', { name: 'Add', exact: true }).click();
  await sam.getByLabel('Your suggestion').fill('Cleaner air');
  await sam.getByRole('button', { name: 'Add', exact: true }).click();
  // No anchoring: Sam does not see Alex's suggestion.
  await expect(alex.getByText('Safer streets')).toBeVisible();
  await expect(sam.getByText('Safer streets')).toHaveCount(0);
  await expect(organizer.getByText('2 of 2 responded')).toBeVisible();

  // — the organizer sorts suggestions and records the goal —
  await organizer.locator('.sugg', { has: organizer.locator('input[value="Safer streets"]') }).getByRole('button', { name: 'Add to the map' }).click();
  await organizer.locator('.sugg', { has: organizer.locator('input[value="Cleaner air"]') }).getByRole('button', { name: 'Set aside' }).click();
  await organizer.getByRole('radio', { name: /Safer streets/ }).click();
  await organizer.getByLabel('What counts as success').fill('No serious injuries');
  await organizer.getByLabel('By when').fill('2030');
  await organizer.getByRole('button', { name: 'Record this as the goal' }).click();

  // — working backwards: a new question appears by itself for the chosen goal —
  await organizer.getByRole('tab', { name: /Work backwards/ }).click();
  await organizer.locator('.q-row', { hasText: 'What would make “Safer streets” more likely?' }).getByRole('button', { name: 'Ask now' }).click();
  for (const p of [alex, sam]) await expect(p.getByRole('heading', { name: 'What would make “Safer streets” more likely?' })).toBeVisible();
  await alex.getByLabel('Your suggestion').fill('Slower traffic');
  await alex.getByRole('button', { name: 'Add', exact: true }).click();
  await sam.getByLabel('Your suggestion').fill('Better lighting');
  await sam.getByRole('button', { name: 'Add', exact: true }).click();
  for (const label of ['Slower traffic', 'Better lighting']) {
    await organizer.locator('.sugg', { has: organizer.locator(`input[value="${label}"]`) }).getByRole('button', { name: 'Add to the map' }).click();
  }
  // …and the accepted state has its own follow-up question waiting: the workshop recurses.
  await expect(organizer.locator('.q-row', { hasText: 'What would make “Slower traffic” more likely?' })).toBeVisible();

  // — connections: the organizer opens arrow drawing; each person draws on their own phone —
  await organizer.getByLabel(/Connections: People can draw their own arrows/).click();
  await expect(organizer.getByLabel(/Connections: People can draw their own arrows/)).toBeChecked();
  await organizer.getByRole('button', { name: 'Close question' }).click();
  await alex.getByRole('link', { name: /Draw your connections/ }).click();
  await expect(alex.locator('.rf-node', { hasText: 'Slower traffic' })).toBeVisible();
  await expect(alex.locator('.react-flow__edge')).toHaveCount(0); // the map starts with no arrows
  await drawArrow(alex, 'Slower traffic', 'Safer streets');
  await expect(alex.locator('.react-flow__edge')).toHaveCount(1);
  await drawArrow(alex, 'Better lighting', 'Slower traffic');
  await expect(alex.locator('.react-flow__edge')).toHaveCount(2);

  // A loop is refused in plain language and the map is left as it was.
  await drawArrow(alex, 'Slower traffic', 'Better lighting');
  await expect(alex.getByText(/would make a loop in your map: “Slower traffic” → “Better lighting” → “Slower traffic”/)).toBeVisible();
  await expect(alex.locator('.react-flow__edge')).toHaveCount(2);

  // Sam's map is Sam's own: none of Alex's arrows are in it, and Sam can draw the opposite arrow.
  await sam.getByRole('link', { name: /Draw your connections/ }).click();
  await expect(sam.locator('.rf-node', { hasText: 'Better lighting' })).toBeVisible();
  await expect(sam.locator('.react-flow__edge')).toHaveCount(0);
  await drawArrow(sam, 'Slower traffic', 'Better lighting');
  await expect(sam.locator('.react-flow__edge')).toHaveCount(1);
  await expect(alex.locator('.react-flow__edge')).toHaveCount(2);

  // — a live question with distinct, editable answers —
  await alex.goBack();
  await sam.goBack();
  await organizer.getByRole('tab', { name: /Choose one goal/ }).click();
  await organizer.locator('.q-row', { hasText: 'How would we know that “Safer streets” has been achieved?' }).getByRole('button', { name: 'Ask now' }).click();
  const prompt = 'How would we know that “Safer streets” has been achieved?';
  for (const p of [alex, sam]) await expect(p.getByRole('heading', { name: prompt })).toBeVisible();
  await alex.getByLabel(prompt).fill('Injury numbers fall');
  await alex.getByRole('button', { name: 'Save answer' }).click();
  await sam.getByLabel(prompt).fill('Parents let kids walk to school');
  await sam.getByRole('button', { name: 'Save answer' }).click();
  await expect(organizer.getByText('Injury numbers fall')).toBeVisible();
  await expect(organizer.getByText('Parents let kids walk to school')).toBeVisible();
  await expect(sam.getByText('Injury numbers fall')).toHaveCount(0);

  // Alex edits; Sam's answer is untouched; the organizer sees the change live.
  await alex.getByLabel(prompt).fill('Injury numbers fall by half');
  await alex.getByRole('button', { name: 'Save change' }).click();
  await expect(organizer.getByText('Injury numbers fall by half')).toBeVisible();
  await expect(organizer.getByText('Parents let kids walk to school')).toBeVisible();

  // Revealing shows others' answers only when the organizer chooses to.
  await organizer.getByLabel('Show participants each other’s answers').click();
  await expect(sam.getByText('Injury numbers fall by half')).toBeVisible();

  // — identity survives a reload; answers persist and can be revised after the question closes —
  await organizer.getByRole('button', { name: 'Close question' }).click();
  await alex.reload();
  await expect(alex.getByText('Waiting for the next question')).toBeVisible();
  await alex.getByRole('button', { name: /My answers/ }).click();
  await expect(alex.getByText('Injury numbers fall by half')).toBeVisible();
  await expect(alex.getByText('version 2')).toBeVisible();

  // — the organizer's explorer shows each person's separate map —
  await organizer.getByRole('link', { name: 'Open the map' }).click();
  // Alex's map: two arrows Alex holds; Sam's opposite arrow shows only as "proposed by someone, not reviewed".
  await expect(organizer.locator('.react-flow__edge.arrow-yes')).toHaveCount(2);
  await expect(organizer.locator('.react-flow__edge.arrow-unstated')).toHaveCount(1);
  await organizer.getByLabel('Whose map').selectOption({ label: 'Sam' });
  await expect(organizer.locator('.react-flow__edge.arrow-yes')).toHaveCount(1);
  await expect(organizer.locator('.react-flow__edge.arrow-unstated')).toHaveCount(2);
  await organizer.getByRole('tab', { name: 'Combine' }).click();
  await organizer.getByRole('button', { name: 'Start a combined map' }).click();
  await expect(organizer.getByText(/Simply putting everyone’s arrows together would make a loop/)).toBeVisible();
  // Every way of pooling shows what it assumes and where it falls short, the moment it is chosen.
  for (const [name, limitation] of [
    ['Simple average (each person counts equally)', /A well-evidenced answer and a guess count the same/],
    ['Middle estimate (median)', /a real minority view has no pull/],
    ['Average weighted by how narrow each person’s range is', /Overconfident people gain influence/],
    ['Average of the odds (for chances only)', /cannot pool a change in a chance/],
  ] as const) {
    await organizer.getByLabel('How to pool estimates').selectOption({ label: name });
    await expect(organizer.getByRole('heading', { name: 'This assumes' })).toBeVisible();
    await expect(organizer.getByRole('heading', { name: 'Limitations' })).toBeVisible();
    await expect(organizer.getByText(limitation)).toBeVisible();
  }

  await organizerContext.close();
  await alex.context().close();
  await sam.context().close();
});

test('solo mode: one person builds, connects and gets a result without anyone else', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start my own model' }).click();
  await expect(page.getByText('Building your model')).toBeVisible();

  const add = async (kind: string, label: string) => {
    await page.getByRole('group', { name: 'Kind of item' }).getByRole('button', { name: kind, exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(label);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.rf-node', { hasText: label })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
  };
  await add('Goal', 'Ship the thing');
  await page.locator('.rf-node', { hasText: 'Ship the thing' }).click();
  await page.getByLabel('By when').fill('June');
  await page.getByRole('button', { name: 'Choose this goal' }).click();
  await expect(page.getByText('the chosen goal')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await add('State', 'Design agreed');
  await add('Action', 'Run a design review');

  await page.getByLabel('Tap to connect').check();
  await drawArrow(page, 'Design agreed', 'Ship the thing');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await drawArrow(page, 'Run a design review', 'Design agreed');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Run on every model' }).click();
  await expect(page.getByText('1 of 1 action connect to the goal in this person’s model. No ranking is given.')).toBeVisible();

  // Switch to the ranking method: each arrow now shows one "?" marker for what the method still needs.
  await page.getByLabel('Calculation method').selectOption({ label: 'Rank actions by added-up probability changes (local additive approximation)' });
  await expect(page.getByText('What it needs from people')).toBeVisible();
  // Assumptions and limitations are shown in full as soon as a method is selected.
  await expect(page.getByRole('heading', { name: 'This assumes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Limitations' })).toBeVisible();
  await expect(page.getByText('It does not give the chance of the goal, only estimated changes to it.')).toBeVisible();
  await page.getByLabel('Calculation method').selectOption({ label: 'Rank actions from two chances per arrow (local additive approximation)' });
  await expect(page.getByText(/Two chances per arrow still do not say how several causes/)).toBeVisible();
  await page.getByLabel('Calculation method').selectOption({ label: 'Rank actions by added-up probability changes (local additive approximation)' });
  await expect(page.getByRole('img', { name: /Example: Changes in percentage points/ })).toBeVisible();
  await page.getByRole('button', { name: 'Use this method for the workshop' }).click();
  await page.getByRole('tab', { name: 'Map' }).click();
  await expect(page.locator('.edge-ask')).toHaveCount(2);
  await page.getByRole('button', { name: /Missing information for the arrow from “Run a design review” to “Design agreed”/ }).click();
  await expect(page.getByRole('heading', { name: 'If people in this room do “Run a design review”, how much more or less likely is “Design agreed” by June, compared with not doing it?' })).toBeVisible();
  await page.getByRole('button', { name: '+40', exact: true }).click();
  await page.getByRole('button', { name: 'Save answer' }).click();
  // It moves straight on to the other arrow that still needs an answer.
  await expect(page.getByRole('heading', { name: 'If “Design agreed” happens, how much more or less likely is “Ship the thing” by June, compared with “Design agreed” not happening?' })).toBeVisible();
  await page.getByRole('button', { name: '+20', exact: true }).click();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.locator('.edge-ask')).toHaveCount(0);

  // The ranking is worked out by the formula engine from those two changes: 0.40 × 0.20 = +8 points.
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByLabel('Calculation method').selectOption({ label: 'Rank actions by added-up probability changes (local additive approximation)' });
  await page.getByText('I understand these numbers hold only under the assumptions listed').click();
  await page.getByRole('button', { name: 'Run on every model' }).click();
  await expect(page.getByText(/arithmetic by squiggle 0\.10\.0 · exact, no sampling/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ranking' })).toBeVisible();
  await expect(page.getByText('+8', { exact: true })).toBeVisible();
  await expect(page.getByText(/chance of the goal is/i)).toHaveCount(0); // changes only, never an absolute chance

  // Reopen from the start page: the work is still there.
  await page.goto('/');
  await page.getByRole('link', { name: 'Explore' }).first().click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
});

test('the 52-item demo loads unconnected and can be searched', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try drawing arrows on a 52-item demo' }).click();
  await expect(page.getByText('52 items · 0 arrows')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.getByLabel('Find an item').fill('Demo state 2.3.1');
  await expect(page.locator('.rf-node.hit')).toHaveCount(1);
});
