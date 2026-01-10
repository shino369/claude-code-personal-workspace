---
description: Translate text between English, Japanese, and Chinese (Traditional) using a multi-stage professional translation workflow
argument-hint: [--lang <en|ja|cn>] [--tone <casual|formal>] [--url <URL>] <text or file reference>
model: inherit
---

# Professional Trilingual Translation

You will now translate content using the **trilingual-translator** subagent with a multi-stage professional translation workflow.

## Parse Arguments

The command accepts the following arguments:

- `--lang <en|ja|cn>`: Target language (English, Japanese, or Chinese Traditional)
  - `en`: English
  - `ja`: Japanese (日本語)
  - `cn`: Chinese Traditional (繁體中文)

- `--tone <casual|formal>`: Writing style (optional, defaults to agent's judgment)
  - `casual`: Conversational, informal tone
  - `formal`: Professional, academic tone

- `--url <URL>`: Fetch content from a URL to translate (alternative to inline text or file references)

- Remaining text: The content to translate (can be inline text, file references using @, or omitted when using --url)

## Command Arguments Provided

Command line arguments: `$ARGUMENTS`

## Your Task

1. **Parse the arguments** from `$ARGUMENTS`:
   - Extract the `--lang` value if provided
   - Extract the `--tone` value if provided (optional)
   - Extract the `--url` value if provided
   - Extract the text/file content to translate (if not using --url)
   - Determine input type:
     - URL (when --url is provided)
     - File reference (starts with @)
     - Inline text
     - Direct URL (if argument looks like a URL even without --url flag)

2. **If `--lang` is not specified**, ask the user to specify the target language:
   - Use the AskUserQuestion tool to present language options:
     - English (en)
     - Japanese - 日本語 (ja)
     - Chinese Traditional - 繁體中文 (cn)

3. **Determine the source language**:
   - Analyze the provided text to identify whether it's in English, Japanese, or Chinese
   - If unclear, ask the user to confirm the source language

4. **Set up working directory** (for file translations and URL fetching):
   - Create task directory: `output/tasks/YYYYMMDD_translate_[brief_description]/`
   - Create subdirectories:
     - `original/` - Original fetched/source content
     - `tmp/` - Stage 1, 2, 3 intermediate files
     - `translated/` - Final deliverable
   - Example: `output/tasks/20260110_translate_readme/`
     - `original/` - fetched_content.md (for URLs) or source files
     - `tmp/` - stage1_initial.md, stage1_notes.md, stage2_feedback.md, stage3_final.md, stage3_summary.md
     - `translated/` - article_cn.md (final output)
   - Use current date in YYYYMMDD format
   - Use brief description based on content, filename, or URL domain/title

5. **Fetch URL content** (if --url is provided):

   **IMPORTANT**: Use the `web-content-fetcher` agent skill for tiered approach.

   **Download images** (if fetched content contains media URLs)
   - Parse `### Media` section for image URLs
   - Keep track of which image corresponds to which description

6. **Execute Multi-Agent Three-Stage Workflow**:

   You will orchestrate THREE sequential subagent invocations using the same trilingual-translator subagent, but with different roles:

   ### Stage 1: Initial Translation (Translator A)

   **For inline text**, invoke trilingual-translator with:

   ```
   You are assigned the role of INITIAL TRANSLATOR (Translator A) in a three-stage workflow.

   **Your Task**: Create the first draft translation.

   **Source Language**: [detected language]
   **Target Language**: [English/Japanese/Chinese Traditional]
   **Tone**: [casual/formal/your professional judgment]

   **Content to Translate**:
   [the actual content]

   **Output Format**:
   ## Initial Translation Analysis
   - Text type: [technical/essay/business/etc.]
   - Key challenges: [list main challenges]
   - Terminology glossary (if needed): [source term → target term]

   ## Initial Translation
   [Your complete translation]

   ## Notes for Proofreader
   [Areas that may need review, uncertainties, alternatives considered]
   ```

   **For URL translations**, invoke trilingual-translator with:

   ```
   You are assigned the role of INITIAL TRANSLATOR (Translator A) in a three-stage workflow.

   **Your Task**: Create the first draft translation from pre-fetched URL content.

   **Source URL**: [the original URL]
   **Source Language**: [detected language]
   **Target Language**: [English/Japanese/Chinese Traditional]
   **Tone**: [casual/formal/your professional judgment]
   **Task Directory**: output/tasks/YYYYMMDD_translate_[description]/
   **Original Directory**: {task_dir}/original/
   **Temp Directory**: {task_dir}/tmp/

   **Fetched Content**:
   [paste the entire fetched content here]

   **Instructions**:
   1. Read and analyze the fetched content provided above
   2. If content has images, check `{task_dir}/original/` for actual file extensions
   3. Create the initial translation to the target language
   4. Write initial translation to: {temp_dir}/stage1_initial.md
   5. Write analysis and notes to: {temp_dir}/stage1_notes.md
   6. **When referencing images**: Use actual file extensions (`.webp`, `.jpg`, `.png`, etc.)

   **stage1_notes.md format**:
   ## Source Information
   - URL: [original URL]
   - Fetch date: [current date]
   - Content type: [article/blog/documentation/etc.]

   ## Initial Translation Analysis
   - Text type, key challenges, terminology glossary

   ## Notes for Proofreader
   - Areas needing review, uncertainties, alternatives
   ```

   **For file translations**, invoke trilingual-translator with:

   ```
   You are assigned the role of INITIAL TRANSLATOR (Translator A) in a three-stage workflow.

   **Your Task**: Create the first draft translation from a file.

   **Source Language**: [detected language]
   **Target Language**: [English/Japanese/Chinese Traditional]
   **Tone**: [casual/formal/your professional judgment]
   **Source File**: [path to source file, e.g., @README.md]
   **Task Directory**: output/tasks/YYYYMMDD_translate_[description]/
   **Temp Directory**: {task_dir}/tmp/

   **Instructions**:
   1. Read the source file using the Read tool
   2. If content has images, check `{task_dir}/original/` for actual file extensions
   3. Analyze and translate the content
   4. Write initial translation to: {temp_dir}/stage1_initial.md
   5. Write analysis and notes to: {temp_dir}/stage1_notes.md
   6. **When referencing images**: Use actual file extensions (`.webp`, `.jpg`, `.png`, etc.)

   **stage1_notes.md format**:
   ## Initial Translation Analysis
   - Text type, key challenges, terminology glossary

   ## Notes for Proofreader
   - Areas needing review, uncertainties, alternatives
   ```

   ### Stage 2: Proofreading (Translator B)

   **For inline text**, invoke with:

   ```
   PROOFREADER (Translator B) - Review initial translation

   Source Text: [original]
   Initial Translation: [from Stage 1]

   Output: Accuracy issues, naturalness issues, language-specific issues,
   terminology consistency, cultural adaptation, summary for refiner
   ```

   **For file translations and URL translations**, invoke with:

   ```
   PROOFREADER (Translator B) - Review from files

   Source File: [path] OR Fetched Content: {task_dir}/original/fetched_content.md
   Initial Translation: {temp_dir}/stage1_initial.md
   Notes: {temp_dir}/stage1_notes.md

   Instructions: Read files, review, write feedback to {temp_dir}/stage2_feedback.md
   ```

   ### Stage 3: Refinement (Translator C)

   **For inline text**, invoke with:

   ```
   REFINER (Translator C) - Create final translation

   Source: [original]
   Initial Translation: [from Stage 1]
   Proofreader Feedback: [from Stage 2]

   Output: Final translation, refinement summary, quality assurance, translator's notes
   ```

   **For file translations and URL translations**, invoke with:

   ````
   REFINER (Translator C) - Create final from files

   Source File: [path] OR Fetched Content: {task_dir}/original/fetched_content.md
   Initial Translation: {temp_dir}/stage1_initial.md
   Proofreader Feedback: {temp_dir}/stage2_feedback.md
   Target Language: [en/ja/cn]

   Instructions:
   1. Read all files
   2. Create final polished translation
   3. Write to {temp_dir}/stage3_final.md
   4. Write summary to {temp_dir}/stage3_summary.md
   5. Write final deliverable to {task_dir}/translated/[basename]_[lang].md
      - For URLs, use descriptive name like: article_[lang].md or [site-name]_article_[lang].md
   6. **For content with images**:
      - **IMPORTANT**: Check actual files in `{task_dir}/original/` to get correct extensions (`.jpg`, `.webp`, `.png`, etc.)
      - Use the actual file extension found: `image_1.webp`, `image_2.jpg`, etc.
      - Include images using markdown syntax with relative paths: `![description](../original/image_N.ext)`
      - Translate the image descriptions/alt text to the target language
      - Preserve the original layout and structure (headers, sections, formatting)
      - Example format:
        ```markdown

        Main content...

        ### Media Content

        ![translated description](../original/image_1.webp)

        **Image Description:** [translated detailed description]
        ```
      - For multi-panel images: Break down each panel/section
      - For infographics: Translate visible text and explain visual info

   Output file naming:
   - English: [basename]_en.md
   - Japanese: [basename]_ja.md
   - Chinese Traditional: [basename]_cn.md
   ````

7. **Present results**:
   - Inline: Show all outputs in conversation
   - Files/URLs: Report locations:
     - Original content (for URLs): {task_dir}/original/fetched_content.md
     - Final translation: {task_dir}/translated/[filename]
     - Intermediate files: {task_dir}/tmp/

## Examples

**Example 1: With all arguments**

```
/translate --lang ja --tone formal "Hello, how are you today?"
```

→ Translate "Hello, how are you today?" to Japanese in formal tone

**Example 2: With file reference**

```
/translate --lang en --tone casual @README.md
```

→ Translate README.md content to English in casual tone

**Example 3: Without language specified**

```
/translate --tone formal "これは素晴らしい製品です"
```

→ Ask user for target language, then translate the Japanese text

**Example 4: Minimal arguments**

```
/translate "This is a great product"
```

→ Ask user for target language and let agent decide tone

**Example 5: Translate from URL**

```
/translate --lang en --url https://automaton-media.com/articles/newsjp/20260109-401932/
```

→ Fetch Japanese article from URL, translate to English

**Example 6: URL with tone specification**

```
/translate --lang ja --tone formal --url https://example.com/blog/post
```

→ Fetch content from URL, translate to Japanese in formal tone

**Example 7: Direct URL without --url flag**

```
/translate --lang cn https://example.com/article
```

→ Detect URL, fetch and translate to Traditional Chinese

**Example 8: Threads post with image**

```
/translate --lang cn --url https://www.threads.com/@user/post/ABC123
```

→ Fetch Threads post with images, download images, translate to Traditional Chinese with embedded images

## Important Notes

- This command uses a **true multi-agent workflow** with THREE sequential subagent invocations:
  1. **Translator A** (Initial Translator): Creates first draft
  2. **Translator B** (Proofreader): Reviews and provides feedback
  3. **Translator C** (Refiner): Produces final polished translation

- All three agents are the same trilingual-translator subagent, but invoked with different roles/instructions

- Each subagent has access to specialized skills:
  - **engineering-terminology**: For technical/engineering content
  - **translation-expertise**: For professional translation methodology
  - **document-writing**: For language-specific writing conventions
  - **web-content-fetcher**: For URL fetching with universal image extraction

- **Universal image extraction**: Works for ALL websites (Twitter/X, Threads, blogs, news, etc.)
  - Images are automatically extracted from main content area
  - Small images (< 100x100px) like icons/logos are filtered out
  - Final translation includes embedded images with translated descriptions

- You should ALWAYS use the Task tool THREE times sequentially to orchestrate the workflow
- Do NOT attempt to translate yourself - delegate to the specialized subagent
- Pass the output from each stage to the next stage

## Multi-Agent Approach

This command uses a true collaborative multi-agent approach:

1. **Main Agent (you)**: Parse arguments, fetch URL content (if --url provided), save to original/ directory, orchestrate the three-stage workflow
2. **Translator A**: Create initial translation draft from provided content
3. **Translator B**: Review Translator A's work and provide feedback
4. **Translator C**: Refine based on Translator B's feedback to produce final version
5. **Skills**: Each translator has access to specialized knowledge

**URL Fetching Strategy**:

- The main orchestrator agent handles URL fetching using the web-content-fetcher skill's tiered approach
- Try WebFetch first (fast for small content), fall back to curl + extraction for larger content
- For JavaScript-rendered sites (Twitter/X, Threads), use Playwright-based fetch_js_content.js
- Always use centralized scripts from `.claude/skills/web-content-fetcher/scripts/`
- Fetched content is saved to `{task_dir}/original/fetched_content.md`
- **Universal image extraction**: All images from main content are automatically extracted with URLs
- Images are downloaded to `{task_dir}/original/` and included in translation
- Content is then passed directly to translation subagents in their prompts
- This ensures reliable content fetching and keeps subagents focused on translation

This separation ensures:

- Multiple perspectives on the translation (initial, review, refinement)
- Systematic quality improvement through staged review
- Professional translation quality through specialized expertise
- Collaborative approach mirrors professional translation workflows
