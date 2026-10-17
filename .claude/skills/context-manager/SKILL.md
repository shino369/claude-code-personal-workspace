---
name: context-manager
description: Proactive context window management to maintain high-quality outputs. Use when context usage approaches 20-40%, when explanations are being repeated, or when output quality degrades.
---

# Context Management for Optimal Performance

Context quality degrades at 20-40% usage, so manage it before the window fills. The actual window depends on the model (1M tokens by default in this workspace); set `CLAUDE_CONTEXT_WINDOW` if you run a different window size.

A `UserPromptSubmit` hook (`.claude/hooks/context_monitor.js`) measures real usage from the transcript and injects `[Context Monitor]` warnings at 20%, 40%, and 60%. Use this skill when one of those warnings appears.

## Why Context Management Matters

**The degradation pattern**:

- 0-20%: Optimal performance
- 20-40%: Quality starts to chip away (subtle but present)
- 40-60%: Noticeable degradation begins
- 60%+: Significant quality loss, even after compaction

**Compaction doesn't restore quality** - It only buys a bit more space. If quality was already degraded before compaction, it stays degraded after.

## Symptoms of Context Degradation

Watch for these signs:

1. **Repetition** - Explaining the same thing 3+ times without progress
2. **Loops** - Trying same solution repeatedly, failing each time
3. **Confusion** - Mixing up different parts of codebase
4. **Missed context** - Forgetting information from earlier in conversation
5. **Overengineering** - Adding unnecessary abstractions unprompted
6. **Off-target** - Implementations that miss the actual requirements

**If you notice any of these, context is likely degraded. Time to intervene.**

## Prevention Strategies

### 1. Scope Conversations Per Feature

**Do**: One conversation per task/feature

```
✅ Conversation 1: Build authentication system
✅ Conversation 2: Refactor database queries
✅ Conversation 3: Add user profile page
```

**Don't**: Mix unrelated tasks in same conversation

```
❌ Conversation 1: Build auth + refactor DB + add profile + fix bug in checkout
```

**Why**: Contexts bleed together. Claude gets confused about which patterns apply where.

### 2. Use External Memory Files

Write plans and progress to files that persist across sessions:

- **tasks/<task-name-yymmdd>/plan.md** - Implementation plan and design decisions
- **tasks/<task-name-yymmdd>/NOTES.md** - Progress, findings, and handoff notes

**Workflow**:

```
1. Work on task, write findings to tasks/<task-name-yymmdd>/NOTES.md
2. When context approaches 30%, write a summary to the same file
3. Run /compact to summarize conversation
4. Run /clear to wipe context completely
5. Read NOTES.md and plan.md to resume with fresh context
```

**This gives you**: A fresh context window + preserved knowledge from previous work.

### 3. Delegate to Subagents

Each subagent gets **its own context window**. Use them for:

- **Complex research** - Explore agent investigates codebase, returns summary
- **Implementation subtasks** - Custom implementer agent handles scope, returns result
- **Testing** - Test-runner agent executes tests, returns findings

**Key**: Main conversation only holds summaries, not full execution history. This prevents context pollution.

**Pattern for large refactoring**:

```
1. Main agent identifies 10 files needing changes
2. Spin up 3 subagents, each handling 3-4 files
3. Each subagent returns summary of changes made
4. Main agent synthesizes summaries, never holding all file contents
```

### 4. The Copy-Paste Reset

When context is bloated but you need to preserve specific information:

```
1. Copy important details from terminal (file paths, error messages, decisions made)
2. Run /compact to get conversation summary
3. Run /clear to wipe context completely
4. Paste back only what matters for next steps
5. Continue with a fresh context window
```

**When to use**: Mid-task when quality degrades but you're not finished.

### 5. Know When to Just Clear

If any of these are true, `/clear` and start fresh:

- Explaining same thing 3+ times without progress
- Claude looping on failed solution
- Context includes multiple failed approaches that didn't work
- Conversation went off-rails into unrelated tangents
- You merged multiple unrelated topics (auth + DB + UI all discussed)

**You won't lose progress** - You still have:

- Your CLAUDE.md (project context)
- Task files (`tasks/<task-name-yymmdd>/plan.md`, `NOTES.md`)
- Git history (code changes)
- Audit logs (logs/<YYYYMMDD>/logging.json)

**Fresh context > struggling through degraded context** - 9 times out of 10.

## Recovery Strategies

### When Already Degraded

If you notice degradation symptoms:

**Option 1: Simplify and Reset**

```
1. Write current progress to tasks/<task-name-yymmdd>/NOTES.md
2. /clear the conversation
3. Read NOTES.md and plan.md
4. Continue with simplified approach
```

**Option 2: Break Down the Task**

```
1. Identify subtasks
2. /clear conversation
3. Tackle each subtask in fresh conversation
4. Combine results
```

**Option 3: Show Instead of Tell**

```
1. Write minimal example of what you want
2. "Here's what success looks like. Apply this pattern to the rest."
```

Claude is excellent at pattern-matching examples.

### When Stuck in Loops

**Don't**: Keep explaining same thing hoping for different result

**Do**: Change the approach entirely

```
1. /clear conversation
2. Reframe the problem differently
   - Instead of: "Handle these transitions"
   - Try: "Implement this as a state machine"
3. Provide concrete example
4. Or delegate to subagent with fresh context
```

## Plan in a File for Complex Tasks

**Before starting complex work**, write the approach to `tasks/<task-name-yymmdd>/plan.md`:

**Why**: A written plan survives `/clear` and keeps implementation focused even when the conversation starts fresh.

**Process**:

```
1. Use the Explore agent to understand the codebase
2. Design the architecture, considering tradeoffs
3. Write the plan to the task's plan.md
4. Get user approval when the approach needs one
5. Implement with fresh context, referencing the plan
```

**This separates**: Research/planning notes from implementation context. Prevents bleeding.

## Model Selection

Use the model configured for the session. This workspace inherits the main session's model for subagents (`model: inherit`); don't switch models mid-task just to manage context. If you need a different model, start a new session with it.

## Monitoring Context Usage

The `context_monitor` hook reads the newest assistant usage entry from the session transcript and injects a warning at 20/40/60% of the configured window. Trust the injected percentage over guesswork from message counts.

The hook is fail-open: if the transcript is unavailable or unparsable, it stays silent. `CLAUDE_CONTEXT_WINDOW` overrides the default 1M window.

## Best Practices Summary

1. **Scope per feature** - One conversation per task
2. **Use external memory** - Write to the task's plan.md and NOTES.md
3. **Delegate to subagents** - Offload complex subtasks to fresh contexts
4. **Copy-paste reset** - Preserve essentials, clear the rest
5. **Clear without hesitation** - Fresh context > degraded context
6. **Plan in a file** - Write complex plans to the task's `plan.md`
7. **Trust the monitor** - Act on the injected percentage, not message-count guesses

## The Meta-Skill

**Recognize degradation early** - The earlier you intervene, the less time wasted fighting through confusion.

**Pattern**: Quality dip → Write to file → Clear context → Resume fresh

**This compounds**: Good context management means more quality work in less time.
