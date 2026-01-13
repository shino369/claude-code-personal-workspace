---
name: commit-messages
description: Generate commit messages following conventional commits standard. Use when creating commits or when the user asks for help with commit messages.
---

# Commit Message Standards

All commits in this workspace follow the **Conventional Commits** specification for clear, scannable history and automated changelog generation.

## Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

## Type

**Required**. Must be one of:

- `feat`: New feature for the user
- `fix`: Bug fix for the user
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `docs`: Documentation only changes
- `test`: Adding or updating tests
- `chore`: Changes to build process, tooling, or dependencies
- `style`: Formatting, missing semi-colons, etc. (not CSS)
- `perf`: Performance improvements
- `ci`: CI/CD configuration changes
- `build`: Changes to build system or external dependencies

## Scope

**Optional**. The area of codebase affected:

- `auth`: Authentication/authorization
- `api`: API routes or endpoints
- `db`: Database operations
- `ui`: User interface components
- `hooks`: Claude Code hooks
- `skills`: Claude Code skills
- `tests`: Test files
- `deps`: Dependencies

Examples: `feat(auth)`, `fix(api)`, `refactor(db)`

## Description

**Required**. Short summary in present tense, lowercase, no period at end.

- Max 50 characters
- Start with verb: "add", "update", "remove", "fix", "refactor"
- Focus on **what** changed, not **why** (why goes in body)

**Good**:

- `feat(auth): add password reset flow`
- `fix(api): handle null user in GET /profile`
- `refactor(db): extract query helpers to utils`

**Bad**:

- `feat(auth): Added password reset flow.` (past tense, capitalized, period)
- `fix: fixed a bug` (not specific)
- `Update stuff` (vague, capitalized)

## Body

**Optional**. Provides context about **why** the change was made.

- Separate from description with blank line
- Wrap at 72 characters
- Explain motivation and contrast with previous behavior

Example:

```
feat(auth): add password reset flow

Users frequently forgot passwords and had no way to recover accounts.
This adds email-based reset with time-limited tokens stored in Redis.
Tokens expire after 1 hour for security.
```

## Footer

**Optional**. References issues or describes breaking changes.

```
Closes #123
Refs #456

BREAKING CHANGE: API endpoint /auth/login now requires email instead of username
```

## Complete Example

```
feat(api): add rate limiting to auth endpoints

Prevent brute force attacks on login and password reset endpoints.
Implements sliding window rate limiter using Redis with 5 attempts
per 15 minutes. Returns 429 status with Retry-After header.

Closes #234

🤖 Generated with Claude Code

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## Attribution

All commits include attribution footer (automatically added by `.claude/settings.json`):

```
🤖 Generated with Claude Code

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## When Creating Commits

1. **Analyze changes** - Run `git status` and `git diff` to understand what changed
2. **Determine type** - Is it feat, fix, refactor, etc?
3. **Choose scope** - What area is affected?
4. **Write description** - Present tense, lowercase, under 50 chars
5. **Add body if needed** - Explain why, not what
6. **Reference issues** - Link to relevant tickets

## Pattern for Multiple Changes

If changes touch multiple areas, either:

1. **Split into multiple commits** - Each with clear scope
2. **Use broader scope** - Like `refactor(api)` instead of specific endpoints
3. **Omit scope** - If change is truly global: `chore: update dependencies`

## Anti-patterns to Avoid

- `git commit -m "WIP"` - Not descriptive
- `git commit -m "fix bug"` - Which bug?
- `git commit -m "Update files"` - Which files? Why?
- Past tense: "Added feature" → Use "add feature"
- Capitalized: "Add feature" → Use "add feature"
- Period at end: "add feature." → Use "add feature"

## Why These Standards

- **Scannability** - Type prefix makes history easy to scan
- **Automation** - Tools can generate changelogs from conventional commits
- **Context** - Future developers understand why changes were made
- **Consistency** - Team follows same patterns for easier collaboration
