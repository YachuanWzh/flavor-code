---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Save plans to:** `<state-root>/superharness/plans/YYYY-MM-DD-<feature-name>.md` (create the folder if missing). `<state-root>` follows the host: `.claude` under Claude Code, `.flavor` under flavor-code.
- (User preferences for plan location override this default)

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Execute this plan task-by-task under the superharness:go workflow, Phase 2 (strict TDD per task). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review → Analysis Findings (mandatory)

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch. It produces a named **Analysis Findings** block appended to the plan document — go Phase 2 does not start until that block exists.

**1. Spec coverage:** Skim each section/requirement in the spec (or the goal + your Phase 0 assumptions when there is no spec file). Build a **coverage matrix**: one row per requirement, one column pointing at the task number that implements it. Any requirement with no task is a gap — add the task.

**2. Contradiction check:** Does any task contradict the spec, another task, the project's stack guidance (STACK.md), or an existing architectural decision in the code? List each **contradiction** with both sides quoted; resolve them (fix the plan or ask your human partner) before proceeding.

**3. Ambiguity scan:** Which steps could two competent engineers implement differently? List each **ambiguity** and remove it by making the plan concrete (exact file, exact signature, exact command) — not by asking, when the codebase already answers.

**4. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**5. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

Fix issues inline. Then append this block to the end of the saved plan file:

```markdown
---
## Analysis Findings

**Coverage:** <N> requirements checked, <M> gaps found and closed (Task X, Task Y added)
**Contradictions:** <none | list with resolutions>
**Ambiguities:** <none | list with how each was made concrete>
**Verdict:** READY — plan covers the spec, no open contradictions or ambiguities
```

If you cannot reach READY, note what is open and raise it with your human partner before execution.

## Execution Handoff

After saving the plan, announce: "Plan complete and saved to `<state-root>/superharness/plans/<filename>.md`."

Then continue with the superharness:go workflow, Phase 2: execute the plan task-by-task
in this session, one TodoWrite/Task item per plan task, strict TDD on every task, and
review checkpoints per Phase 4.
