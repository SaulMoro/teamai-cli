# Advanced workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

Each section below builds on [Workflows](workflow.md) and stands on its own.

## Run ready steps in parallel

A driver can hold several leases at once. In each `next` call it lists, in `running`, the attempts of its open leases that it still runs. `next` then leases the next ready step instead of handing an open lease back.

```yaml
schemaVersion: v1alpha1
name: checks
description: Lint and test at the same time, then build.
steps:
  - id: lint
    command: npm run lint
  - id: test
    needs: []
    command: npm test
  - id: build
    needs: [lint, test]
    command: npm run build
```

Each call below sends `"driver":{"kind":"script","machine":"host","workspace":"/work"}` and the fields shown:

| `next` fields besides `driver` | Answer |
| --- | --- |
| none | `{"data":{"lease":{"run":"ra780d018","step":"lint","attempt":"af143e3a7","revision":1,"command":"npm run lint"},"cancelled":[]}}` |
| `"running":["af143e3a7"]` | `{"data":{"lease":{"run":"ra780d018","step":"test","attempt":"a0ce8107f","revision":1,"command":"npm test"},"cancelled":[]}}` |
| `"running":["af143e3a7","a0ce8107f"]` | `{"data":{"wait":{"reason":"lint is leased"},"cancelled":[]}}` |

Each call to `next` does this, in order:

1. It settles the run. If the run has ended, it answers `done`.
2. It hands back an open lease of this driver that `running` leaves out. A restarted driver sends `"running":[]` and gets its open leases back, one per call.
3. It leases the first ready step in file order. The steps of a sub-workflow take the place of the step that runs it.
4. When every ready step is leased, it answers `wait`, and `reason` names the first open lease.

A driver that sends no `running` gets its open lease back on every call, so it runs one step at a time. `--driver local` works this way.

`"canTakeLease":false` stops after step 2. The answer is `done`, an open lease that `running` leaves out, or `wait`. When nothing is leased, the `wait` reason is `canTakeLease is false`. Use it to learn about an end while the driver has no room for another step.

Every `data` answer of `next` has `cancelled`. It lists the attempts in `running` that are no longer open leases of this driver. Stop those processes. An `error` answer has no `cancelled`.

A wrong `running` or `canTakeLease` returns `invalid_json` with `running must be an array of attempt ids` or `canTakeLease must be a boolean`. While one driver holds a lease, another driver gets `wait`, and `reason` names that lease.

`report` checks each report against the revision of its own lease, not the run's latest revision. Above, `next` handed out both leases at revision 1. A report for `test` with `"revision":1` moves the run to revision 2. A report for `lint` with `"revision":1` is still accepted and moves it to 3. A report with another revision for an open lease returns `stale_revision`:

```text
{"error":{"code":"stale_revision","message":"Revision 2 is stale; attempt ae75cb049 was leased at 1"}}
```

## An end cancels the steps still open

When a workflow reaches an end, its steps that have not settled stop. A pending step is skipped. A leased step, and a step whose workflow is running, become `cancelled`. The same applies to the steps of its sub-workflows. An end inside a sub-workflow stops only that sub-workflow, and the parent goes on.

```yaml
schemaVersion: v1alpha1
name: fail-fast
description: Lint and test at the same time, and stop at the first failure.
ends: { broken: failed }
steps:
  - id: lint
    command: npm run lint
  - id: test
    needs: []
    command: npm test
  - id: stop
    needs: [lint]
    if: steps.lint.outcome == 'failed'
    end: broken
```

A driver runs `lint` and `test` together. `lint` fails, so `stop` reaches `broken`. The next `next` that lists `test` in `running` answers:

```text
{"data":{"done":{"run":"r2c7f2c70","outcome":"failed","end":"broken"},"cancelled":["acc763f50"]}}
```

`report` does not record a report for a cancelled attempt. It returns `lease_cancelled`, whatever driver sends it:

```text
{"error":{"code":"lease_cancelled","message":"Attempt acc763f50 was cancelled; its report is not recorded"}}
```

`steps.<id>.outcome` reads `cancelled` for a cancelled step. Nothing in a workflow runs after its end, so only the workflow's `outputs` can read it. Here the parent learns that `lint` failed before the tests finished:

```yaml
schemaVersion: v1alpha1
name: gate
description: Report which check stopped a gate.
steps:
  - id: checks
    workflow:
      ends: { broken: failed }
      outputs: { test: steps.test.outcome }
      steps:
        - id: lint
          command: npm run lint
        - id: test
          needs: []
          command: npm test
        - id: stop
          needs: [lint]
          if: steps.lint.outcome == 'failed'
          end: broken
  - id: notify
    needs: [checks]
    if: steps.checks.outputs.test == 'cancelled'
    command: echo "lint failed before the tests finished"
```

## The end reached first wins

Reports can reach two ends before the driver calls `next` again. `next` then applies the end that was reached first, whatever order the steps have in the file.

- A step that a driver reports reaches its end at the revision of that report.
- A step with only `id`, `needs`, `if`, and `end` reaches its end when the last step it needs or reads settled.
- On a tie, the step declared first wins.

```yaml
schemaVersion: v1alpha1
name: race
description: Try two fixes at once and keep the first that works.
ends: { patched: succeeded, rewritten: succeeded }
steps:
  - id: patch
    command: ./scripts/patch.sh
    end: patched
  - id: rewrite
    needs: []
    command: ./scripts/rewrite.sh
    end: rewritten
```

If `rewrite` reports success and then `patch` reports success, the next `next` answers `{"data":{"done":{"run":"ra0ca39d4","outcome":"succeeded","end":"rewritten"},"cancelled":[]}}`. The time at which the driver calls `next` does not change the winner.

## Expression reference

An `if` is an expression. The rules for which steps it can read, and for what counts as true, are in [Workflows](workflow.md).

```yaml
schemaVersion: v1alpha1
name: review-files
description: Review the changed files, then fix the ones with findings.
steps:
  - id: review
    prompt: List each changed file and how many findings it has.
    output:
      files: [{ path: string, findings: number }]
  - id: fix
    needs: [review]
    if: any(steps.review.outputs.files, .findings > 0)
    prompt: "Fix the findings in {{ steps.review.outputs.files[0].path }} first."
  - id: label
    needs: [review]
    if: length(filter(steps.review.outputs.files, .findings >= 10)) > 2
    command: gh pr edit --add-label large-change
```

### Values

| Value | Example |
| --- | --- |
| An input | `inputs.issue`, `inputs.issue.labels` |
| A step's outcome, end, or output | `steps.check.outcome`, `steps.check.end`, `steps.review.outputs.files` |
| A string | `'failed'`. Use single quotes. Write a quote inside a string twice: `'it''s'`. |
| A number | `3`, `-1`, `1.5`. Write a digit before the decimal point: `0.5`, not `.5`. |
| A boolean or null | `true`, `false`, `null` |
| An empty array | `[]`. It is the only array literal. |

A missing value reads as `null`. A step that has not settled reads as `null` too.

### Indexes

`[n]` reads element `n` of an array, counting from 0: `steps.review.outputs.files[0].path`, `inputs.tags[1]`, or `steps.grid.outputs.rows[1][0]`. An index past the end, or an index into a value that is not an array, reads `null`.

An index is a whole number from 0. `[-1]`, `[01]`, and `[inputs.n]` do not parse. An index reads an array inside `inputs` or `outputs`. It cannot follow a step id, `outcome`, or `end`, so `steps.build[2].outcome` does not parse.

### Operators and precedence

From the loosest binding to the tightest:

| Operators | Result |
| --- | --- |
| `\|\|` | `true` when either side is true |
| `&&` | `true` when both sides are true |
| `!` | `true` when its operand is false |
| `==`, `!=` | whether both sides are the same value, compared strictly |
| `<`, `<=`, `>`, `>=` | the comparison of two numbers |
| a value, a function call, or `( … )` | the value |

`!` binds looser than `==`. `!steps.check.outcome == 'success'` means `!(steps.check.outcome == 'success')`.

`==`, `!=`, and the comparisons do not chain. `1 < 2 < 3` and `1 == 1 == true` do not parse. Add parentheses, as in `(1 == 1) == true`.

A comparison is true only when both sides are numbers. With any other value, such as a string or `null`, it is false.

### Functions

| Call | Result |
| --- | --- |
| `length(list)` | the number of elements |
| `any(list, predicate)` | `true` when the predicate is true for at least one element. `false` for an empty list. |
| `all(list, predicate)` | `true` when the predicate is true for every element. `true` for an empty list. |
| `filter(list, predicate)` | an array of the elements for which the predicate is true |

When `list` is not an array at run time, each function returns `null`.

A predicate reads the current element with a path that starts with `.`, as in jq:

- `.` is the element itself.
- `.findings` is a field of the element.
- `.files[0]` and `.[0]` read by index.

Inside a nested call, `.` is the element of the innermost call. A predicate can also read `inputs` and `steps`. A path that starts with `.` does not parse outside a predicate.

Any other function name does not parse: `"contains" is not a function; the functions are length, any, all and filter`. A call with the wrong number of arguments does not parse either: `any is called as any(list, predicate)`.

### Type checks at pull

`teamai pull` checks the types in each `if`. It knows the type of a literal, of each operator and function result, and of every path the workflow declares in `inputs` or `output`. Each of these makes the file invalid:

- A comparison with a side that is not a number. Such a side is a string, a boolean, `null`, a condition, an `any`, `all`, or `filter` call, or a path whose declared type is not `number`.
- A `list` argument that is not an array. Such an argument is a literal other than `[]`, a condition, a `length`, `any`, or `all` call, or a path whose declared type is not an array.
- A predicate that reads a field the declared item type does not have.

For example, if `review` above also declared `title: string`, this `fix` step would make the file invalid:

```yaml
  - id: fix
    needs: [review]
    if: steps.review.outputs.title > 3 || any(steps.review.outputs.files, .finding > 0) || all(steps.review.outputs.title, .done)
    prompt: Fix the findings.
```

`teamai pull` reports:

```text
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if compares steps.review.outputs.title with >, but it is not a number
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if reads .finding, which is not in an item of steps.review.outputs.files
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if passes steps.review.outputs.title to all as its list, but it is not an array
```

The outputs of a step that runs a workflow have no declared type, so pull does not check them. At run time, a comparison with a value that is not a number is false, and a function whose `list` is not an array returns `null`.

### Templates

A template reads one path, indexes included, such as `{{ steps.review.outputs.files[0].path }}` or `{{ with.refs[1] }}`. Operators and functions work only in an `if`.
