---
name: context-manager
description: Proactive context window management to maintain high-quality outputs. Use when context usage approaches 20-40%, when explanations are being repeated, or when output quality degrades.
---

# Context Management for Optimal Performance

Claude Code Sonnet has a 200K token context window, but **quality degrades at 20-40% usage**. This skill provides strategies for maintaining high-quality outputs throughout long coding sessions.

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

- **SCRATCHPAD.md** - Temporary notes, findings, progress
- **plan.md** - Architecture decisions, implementation plans
- **output/tasks/<YYYYMMDD_task_name>/NOTES.md** - Task-specific notes

**Workflow**:

```
1. Work on task, write findings to SCRATCHPAD.md
2. When context approaches 30%, write summary to file
3. Run /compact to summarize conversation
4. Run /clear to wipe context completely
5. Read SCRATCHPAD.md to resume with fresh context
```

**This gives you**: Fresh 200K window + preserved knowledge from previous work.

### 3. Delegate to Subagents

Each subagent gets **its own 200K context window**. Use them for:

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
5. Continue with fresh 200K window
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
- External memory files (SCRATCHPAD.md, plan.md)
- Git history (code changes)
- Audit logs (/logs/<YYYYMMDD>/logging.json)

**Fresh context > struggling through degraded context** - 9 times out of 10.

## Recovery Strategies

### When Already Degraded

If you notice degradation symptoms:

**Option 1: Simplify and Reset**

```
1. Write current progress to SCRATCHPAD.md
2. /clear the conversation
3. Read SCRATCHPAD.md
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

## Plan Mode for Complex Tasks

**Before starting complex work**, enter plan mode (`Shift+Tab` twice):

**Why**: Planning with fresh context produces dramatically better results than iterating through confusion.

**Process**:

```
1. Press Shift+Tab twice to enter plan mode
2. Use Explore agent to understand codebase
3. Design architecture, considering tradeoffs
4. Write plan to plan.md
5. Get user approval
6. Exit plan mode with fresh context for implementation
```

**This separates**: Research/planning context from implementation context. Prevents bleeding.

## Model Selection Strategy

**Opus 4.5**: Complex reasoning, planning, architectural decisions

- Use for: Plan mode, architecture design, debugging complex issues
- Slower, more expensive, deeper thinking

**Sonnet 4.5**: Execution tasks with clear paths

- Use for: Implementation, refactoring, boilerplate, following established patterns
- Faster, cheaper, excellent execution

**Workflow**:

```
1. Start with Opus for planning (Shift+Tab to plan mode)
2. Write plan to plan.md
3. Switch to Sonnet for implementation (Shift+Tab to change model)
4. Reference plan.md during execution
5. Switch back to Opus if you hit architectural decisions
```

CLAUDE.md ensures both models operate under same constraints.

## Monitoring Context Usage

**No built-in meter exists**, so monitor indirectly:

**Signs you're at ~20-30% usage**:

- 30-50 messages in conversation
- Read 10+ files
- Generated significant code (1000+ lines)
- Multiple back-and-forth iterations

**Signs you're at ~40-50% usage**:

- 60+ messages in conversation
- Read 20+ files
- Quality starting to slip (Claude missing details)
- Needing to repeat information

**Action**: When you hit 30-40% estimated usage, proactively write to external memory and prepare for reset.

## Best Practices Summary

1. **Scope per feature** - One conversation per task
2. **Use external memory** - Write to SCRATCHPAD.md and plan.md
3. **Delegate to subagents** - Offload complex subtasks to fresh contexts
4. **Copy-paste reset** - Preserve essentials, clear the rest
5. **Clear without hesitation** - Fresh context > degraded context
6. **Plan before implementing** - Use plan mode for complex work
7. **Choose right model** - Opus for planning, Sonnet for execution
8. **Monitor indirectly** - Watch message count and quality signals

## The Meta-Skill

**Recognize degradation early** - The earlier you intervene, the less time wasted fighting through confusion.

**Pattern**: Quality dip → Write to file → Clear context → Resume fresh

**This compounds**: Good context management means more quality work in less time.

## External Memory File Management

**Recommendation**: Add external memory files to `.gitignore` to keep temporary session notes out of version control.

**Files to exclude**:

- `SCRATCHPAD.md` - Temporary session notes
- `plan.md` - Current implementation plans
- `logs/` - Audit logs generated by hooks
- Optionally: `output/tasks/*/NOTES.md` - Task-specific temporary notes

**Setup**: If you're using the claude-workspace plugin from a marketplace, a `.gitignore.recommended` file is included. Copy the relevant patterns to your project's `.gitignore`:

```bash
# Add to your project's .gitignore
cat .gitignore.recommended >> .gitignore
```

Or manually add:

```gitignore
# Claude Code External Memory
SCRATCHPAD.md
plan.md
logs/
```

**Why exclude these files**:

- They contain temporary session context
- They change frequently during development
- They're meant for your local workflow only
- Committing them creates noise in git history

**What to commit instead**:

- Final documentation in `docs/`
- Permanent architecture decisions
- Code and tests
- Project-specific setup files
