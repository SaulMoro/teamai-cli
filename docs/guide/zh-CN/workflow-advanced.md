# 高级工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

下面每一节都建立在 [工作流](workflow.md) 之上，各节相互独立。

## 并行运行就绪的步骤

一个驱动可以同时持有多个租约。每次调用 `next` 时，它在 `running` 里列出自己仍在运行的未结租约的 attempt。这样 `next` 会租出下一个就绪的步骤，而不是把未结租约交还给它。

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

下面每次调用都发送 `"driver":{"kind":"script","machine":"host","workspace":"/work"}` 和表中的字段：

| `driver` 之外的 `next` 字段 | 返回 |
| --- | --- |
| 无 | `{"data":{"lease":{"run":"ra780d018","step":"lint","attempt":"af143e3a7","revision":1,"command":"npm run lint"},"cancelled":[]}}` |
| `"running":["af143e3a7"]` | `{"data":{"lease":{"run":"ra780d018","step":"test","attempt":"a0ce8107f","revision":1,"command":"npm test"},"cancelled":[]}}` |
| `"running":["af143e3a7","a0ce8107f"]` | `{"data":{"wait":{"reason":"lint is leased"},"cancelled":[]}}` |

每次调用 `next` 都按顺序执行以下几步：

1. 结算运行。如果运行已经结束，返回 `done`。
2. 把本驱动的、`running` 里没有列出的未结租约交还给它。重启后的驱动发送 `"running":[]`，每次调用拿回一个未结租约。
3. 按文件顺序租出第一个就绪的步骤。子工作流的步骤位于运行它的那个步骤的位置。
4. 每个就绪的步骤都已租出时，返回 `wait`，`reason` 指出第一个未结租约。

不发送 `running` 的驱动每次调用都会拿回自己的未结租约，因此一次只运行一个步骤。`--driver local` 就是这样工作的。

`"canTakeLease":false` 执行到第 2 步就停止。返回的是 `done`、一个 `running` 没有列出的未结租约，或 `wait`。没有任何租约时，`wait` 的 reason 是 `canTakeLease is false`。驱动没有空位运行新步骤时，可以用它来得知是否已到达结局。

`next` 的每个 `data` 返回都带 `cancelled`。它列出 `running` 中已经不再是本驱动未结租约的 attempt。请停止这些进程。`error` 返回不带 `cancelled`。

`running` 或 `canTakeLease` 格式不对时，返回 `invalid_json`，消息为 `running must be an array of attempt ids` 或 `canTakeLease must be a boolean`。一个驱动持有租约时，其他驱动会收到 `wait`，`reason` 指出那个租约。

`report` 按每次上报自己租约的 revision 检查，而不是按运行最新的 revision。上例中 `next` 在 revision 1 租出了两个租约。`test` 以 `"revision":1` 上报后，运行变为 revision 2。`lint` 以 `"revision":1` 上报仍会被接受，运行变为 revision 3。未结租约以其他 revision 上报时返回 `stale_revision`：

```text
{"error":{"code":"stale_revision","message":"Revision 2 is stale; attempt ae75cb049 was leased at 1"}}
```

## 到达结局时取消仍未结束的步骤

工作流到达结局时，它尚未完成的步骤都会停止。pending 的步骤被跳过。已租出的步骤，以及其工作流正在运行的步骤，变为 `cancelled`。它的子工作流中的步骤也一样。子工作流里的结局只停止该子工作流，父工作流继续运行。

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

驱动同时运行 `lint` 和 `test`。`lint` 失败，于是 `stop` 到达 `broken`。之后在 `running` 中列出 `test` 的那次 `next` 返回：

```text
{"data":{"done":{"run":"r2c7f2c70","outcome":"failed","end":"broken"},"cancelled":["acc763f50"]}}
```

`report` 不记录已取消 attempt 的上报。无论哪个驱动上报，都返回 `lease_cancelled`：

```text
{"error":{"code":"lease_cancelled","message":"Attempt acc763f50 was cancelled; its report is not recorded"}}
```

被取消的步骤，`steps.<id>.outcome` 读作 `cancelled`。工作流到达结局后不再运行任何步骤，所以只有该工作流的 `outputs` 能读到它。下例中，父工作流得知 `lint` 在测试完成前就失败了：

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

## 先到达的结局生效

驱动再次调用 `next` 之前，多个上报可能到达两个结局。此时 `next` 采用先到达的那个结局，与步骤在文件中的顺序无关。

- 驱动上报的步骤，在该次上报产生的 revision 到达它的结局。
- 只有 `id`、`needs`、`if` 和 `end` 的步骤，在它依赖或读取的最后一个步骤完成时到达它的结局。
- 同时到达时，先声明的步骤生效。

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

如果 `rewrite` 先上报成功，`patch` 随后上报成功，下一次 `next` 返回 `{"data":{"done":{"run":"ra0ca39d4","outcome":"succeeded","end":"rewritten"},"cancelled":[]}}`。驱动何时调用 `next` 不会改变生效的结局。

## 表达式参考

`if` 是一个表达式。它能读取哪些步骤、哪些值为真，见 [工作流](workflow.md)。

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

### 值

| 值 | 示例 |
| --- | --- |
| 输入 | `inputs.issue`、`inputs.issue.labels` |
| 步骤的 outcome、结局或输出 | `steps.check.outcome`、`steps.check.end`、`steps.review.outputs.files` |
| 字符串 | `'failed'`。使用单引号。字符串里的单引号写两次：`'it''s'`。 |
| 数字 | `3`、`-1`、`1.5`。小数点前要有数字：写 `0.5`，不写 `.5`。 |
| 布尔值或 null | `true`、`false`、`null` |
| 空数组 | `[]`。这是唯一的数组字面量。 |

不存在的值读作 `null`。尚未完成的步骤也读作 `null`。

### 下标

`[n]` 读取数组的第 `n` 个元素，从 0 开始计数：`steps.review.outputs.files[0].path`、`inputs.tags[1]` 或 `steps.grid.outputs.rows[1][0]`。超出末尾的下标，或对非数组值使用的下标，读作 `null`。

下标是从 0 开始的整数。`[-1]`、`[01]` 和 `[inputs.n]` 无法解析。下标读取 `inputs` 或 `outputs` 里的数组。它不能跟在步骤 id、`outcome` 或 `end` 后面，所以 `steps.build[2].outcome` 无法解析。

### 运算符和优先级

从结合最松到最紧：

| 运算符 | 结果 |
| --- | --- |
| `\|\|` | 任一侧为真时为 `true` |
| `&&` | 两侧都为真时为 `true` |
| `!` | 操作数为假时为 `true` |
| `==`、`!=` | 两侧是否为同一个值，严格比较 |
| `<`、`<=`、`>`、`>=` | 比较两个数字 |
| 值、函数调用或 `( … )` | 该值 |

`!` 的结合比 `==` 松。`!steps.check.outcome == 'success'` 表示 `!(steps.check.outcome == 'success')`。

`==`、`!=` 和比较运算符不能连写。`1 < 2 < 3` 和 `1 == 1 == true` 无法解析。请加括号，例如 `(1 == 1) == true`。

只有两侧都是数字时，比较才可能为真。任一侧是其他值，例如字符串或 `null`，结果都为假。

### 函数

| 调用 | 结果 |
| --- | --- |
| `length(list)` | 元素个数 |
| `any(list, predicate)` | 至少一个元素使 predicate 为真时为 `true`。空数组为 `false`。 |
| `all(list, predicate)` | 每个元素都使 predicate 为真时为 `true`。空数组为 `true`。 |
| `filter(list, predicate)` | 使 predicate 为真的元素组成的数组 |

运行时 `list` 不是数组时，每个函数都返回 `null`。

predicate 用以 `.` 开头的路径读取当前元素，和 jq 一样：

- `.` 是元素本身。
- `.findings` 是元素的一个字段。
- `.files[0]` 和 `.[0]` 按下标读取。

在嵌套调用里，`.` 是最内层调用的元素。predicate 也可以读取 `inputs` 和 `steps`。以 `.` 开头的路径在 predicate 之外无法解析。

其他函数名无法解析：`"contains" is not a function; the functions are length, any, all and filter`。参数个数不对的调用也无法解析：`any is called as any(list, predicate)`。

### pull 时的类型检查

`teamai pull` 检查每个 `if` 中的类型。它知道字面量、每个运算符和函数结果的类型，以及工作流在 `inputs` 或 `output` 中声明的每个路径的类型。以下任一情况都会让文件无效：

- 比较的某一侧不是数字。这样的一侧可以是字符串、布尔值、`null`、条件、`any`、`all` 或 `filter` 调用，或声明类型不是 `number` 的路径。
- `list` 参数不是数组。这样的参数可以是 `[]` 以外的字面量、条件、`length`、`any` 或 `all` 调用，或声明类型不是数组的路径。
- predicate 读取了声明的元素类型中没有的字段。

例如，如果上面的 `review` 还声明了 `title: string`，下面这个 `fix` 步骤会让文件无效：

```yaml
  - id: fix
    needs: [review]
    if: steps.review.outputs.title > 3 || any(steps.review.outputs.files, .finding > 0) || all(steps.review.outputs.title, .done)
    prompt: Fix the findings.
```

`teamai pull` 报告：

```text
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if compares steps.review.outputs.title with >, but it is not a number
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if reads .finding, which is not in an item of steps.review.outputs.files
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if passes steps.review.outputs.title to all as its list, but it is not an array
```

运行工作流的步骤，其输出没有声明类型，因此 pull 不检查它们。运行时，与非数字值的比较为假，`list` 不是数组的函数返回 `null`。

### 模板

模板读取一个路径，可以带下标，例如 `{{ steps.review.outputs.files[0].path }}` 或 `{{ with.refs[1] }}`。运算符和函数只能用在 `if` 里。
