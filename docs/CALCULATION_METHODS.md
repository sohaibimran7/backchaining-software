# Calculation and aggregation methods

Both are replaceable. The user interface contains no method-specific code: it renders whatever a method declares.

## Calculation methods

A method implements `CalculationMethod` from `shared/calc/types.ts` and is added to the array in `shared/calc/registry.ts`.

```ts
export const myMethod: CalculationMethod<MySettings> = {
  id: 'my-method',
  version: '1.0.0',              // bump when results for the same inputs could change
  name: 'A name that says what it does',
  summary: '…',
  requiresAcknowledgement: true, // true if it produces numbers resting on strong assumptions
  assumptions: ['…'],            // shown in the picker, beside results, stored with every run
  limits: ['…'],
  requiredInputs: ['…'],         // plain language, shown before anything is run
  example: { caption, nodes, arrows, outcome }, // the small diagram in the picker
  settingsSchema,                // zod; settings are validated on the server
  defaultSettings,
  settingsFields: [/* select | number | boolean descriptions */],
  consumes: ['link.stance', 'my.role'],  // roles of answers it reads
  elicitation: [/* question templates it needs */],
  prepare(model, settings) { … },
};
```

### What a method receives

`prepare(model, settings)` gets one `ParticipantModel`: the items, and each arrow with this person's position on it (`yes`, `conditional`, `no`, `unsure`, `unstated`) and their answers by role. Each answer is `answered`, `unsure` or `unanswered`, with flags for answers given before a definition changed. It never sees other people, the database or the UI. The same function is used for a combined model, whose inputs are pooled.

### What a method returns

```ts
interface PreparedCalculation {
  program: FormulaProgram | null;                    // Squiggle code plus a map from generated names to arrows/questions
  finish(result: EngineResult | null): MethodOutput; // turn the engine's numbers into results
}
```

All judgement belongs in `prepare`: which actions can be estimated, which are incomplete, which must be withheld. Then compile only what passed into formulas. `finish` receives the engine's named numbers, or a failure, and must report affected results as withheld, never as zero.

Rules the built-in methods follow, and new ones should:

- Missing and "not sure" are never zero and never "no".
- Never bypass a requirement or a conditional arrow silently. If the method cannot represent it, withhold and say why.
- Generate identifiers yourself. Never put user text into formulas.
- Do not turn a person's low/high range into a probability distribution without declaring that as an assumption and bumping the version.
- Do not clip an impossible result into a plausible-looking one.

### Questions a method needs

Templates in `elicitation` carry a `role`. While the method is selected for the workshop, a draft question is generated for every arrow or item the template matches, and the map shows one "?" marker per arrow with unanswered required questions. A workshop configuration can reword a method's template by defining one with the same id. A starting-chance question (`node.baseline_probability`) is generated only if a selected method lists that role in `consumes`.

Roles the app itself understands are in `ROLES` in `shared/config.ts`. Methods may define their own.

### The engine boundary

`FormulaEngine` has one method, `evaluate(program)`, returning named numbers. The shipped engine is Squiggle 0.10 running in a worker thread that is terminated on overrun. A different engine can be passed to `WorkshopService`.

## The shipped ranking method

For each arrow X → Y a person gives one number: the change in the chance of Y, in percentage points, if X happens (or, for an action, if people in the room do it), compared with the same expected course of events without it. The reference is the same for every answer: the future the person expects anyway, including what others are likely to do, changed in one respect only.

Under its assumptions (stable direct changes that add up; no interactions off the map), the change at the goal from an action is the sum over routes of the product of changes along each route, each route counted once. Ranges are carried by interval arithmetic. Actions whose ranges overlap share a tier.

Example: A1 → S1 = +50, A2 → S2 = +30, S1 → S2 = +15, S1 → G = +20, S2 → G = +15 gives A1 = 0.50 × (0.20 + 0.15 × 0.15) = +11.125 points and A2 = 0.30 × 0.15 = +4.5 points.

It withholds a number when: the arrows on the way form a loop; something on the route is marked as required (configurable to "only where routes combine there"); an arrow on the route holds only under some conditions; or added-up changes exceed 100 points. It marks a result incomplete when an arrow on the route lacks an answer.

It does not claim that pairwise differences determine interactions, and it reports an arrow that sits beside a longer route between the same two items as a double-counting risk.

## Aggregation methods

How several people's answers to the same question are pooled for a combined model. Implement `AggregationMethod` from `shared/aggregate/types.ts` and add it to `shared/aggregate/registry.ts`.

`aggregate(input, settings)` receives each contributor's state (`answered`, `unsure`, `unanswered`, `needs-review`) and number, plus `conditionsDiffer`, which is true when the people answering had different arrows into the target in their own maps or the combined map differs from theirs. It returns an optional pooled value, who was used, who was unsure or missing, the spread, and whether the value should be re-asked.

The input also carries `unit`: whether the numbers are chances or changes in a chance. A method that only makes sense for one must decline the other.

Shipped:

- **Do not pool estimates** (the default).
- **Simple average (each person counts equally).** Pulled by outliers; a guess and a well-evidenced answer count the same.
- **Middle estimate (median).** One extreme answer cannot move it; a real minority view has no pull.
- **Average weighted by how narrow each person's range is.** Lets people signal how sure they are through the range they already give. Each person's share is shown. Overconfident people gain influence, and a floor on range width stops anyone dominating by claiming certainty.
- **Average of the odds (for chances only).** The geometric mean of odds. An answer near 0% or 100% pulls harder than in a plain average. It refuses to pool a change in a chance, so it is used with the two-chances method. It reflects evidence about how likely the next thing is, not about how big the gap between the two chances is.

All of them leave out unsure, missing and out-of-date answers, show the spread, and by default do not pool answers given under different conditions. These shared safeguards live in one helper (`pool` in `shared/aggregate/methods.ts`), so a new method only supplies how to combine the usable estimates.

## The two-chances variant

`local-additive-two-chances` reuses the ranking method's checks, formulas and safeguards and changes only how an arrow's change is read: from two chances (the next item if this happens, and if it does not) instead of one stated change. With ranges, the widest change consistent with both ranges is used. A method variant is made by passing a different `ReadEffect` to `prepareLocalAdditive`.

Pooling inputs is not averaging results. Calculation results are never averaged across people; a combined model's result is computed from its pooled inputs.
