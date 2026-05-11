Output:
- Post inline comments only when warranted by the rules above.
- Return the main review summary as the structured output field `summary_comment`.
- Do not post the main summary comment directly with `gh pr comment` or other GitHub CLI comment commands; the workflow will upsert that single summary comment after the run.
- Summary comments may include non-blocking watch-outs or checks to verify; inline comments may not.
- Summary sections should cite the main materials used (for example which skills ran, which files were the highest-risk reads, and any Sentry issue IDs if relevant).
- If the review ran in scoped mode because the PR exceeded the changed-file limit, say so explicitly in the final summary and name the highest-risk areas/files you focused on.
- Before posting any inline comment, verify:
  1. Is this a real bug or a theoretical edge case? (only post if real)
  2. Have I already commented on this same root cause elsewhere? (only post once per issue)
  3. Am I certain this is wrong, or am I asking a question? (questions go in summary, not inline)
  4. Can I explain the realistic failure path and severity clearly? (only post if yes)
- Build the markdown body for `summary_comment` with:
  1. `## Summary`
     - Start with 1 short paragraph explaining what the PR does overall.
     - Then add 2-4 bullets covering the main change areas.
     - Name the key files or subsystems for each area.
     - For docs-only or low-risk PRs, keep this concise, but still explain the PR shape rather than only saying "Looks good."
  2. `## Confidence Score: X/5`
     - Put the numeric score in the heading itself.
     - Write 1 short paragraph summarizing the overall production risk of the PR.
     - Then write an optional second short paragraph explaining the main reasons for that score.
     - Prefer concrete repo-aware reasoning: change scope, analyzer coverage, blast radius, affected files, and any non-blocking concerns.
     - When concerns influenced the score, name the exact files or symbols involved.
     - Avoid generic reassurance without explanation.
  3. `## Important files changed`
     - Include a markdown table with columns `File` and `Overview`.
     - Include the 3-10 most important files only.
     - For each file, explain its role in the PR, not just its name.
  4. `## Findings`
     - If there are material issues, list them with severity and concrete failure mode.
     - If there are no material issues, say `No material findings.`
  5. `## Comments outside diff`
     - Include only when non-empty.
     - Use this for concrete review observations that are worth surfacing but do not justify an inline comment.
     - Each item must include:
       - file or subsystem,
       - short issue title,
       - severity (`P2` or lower only),
       - 1-3 sentence explanation of the concern,
       - and why it stayed out of inline comments.
     - Do not include theoretical edge cases, style notes, or generic "consider improving" advice.
  6. `## Watch-outs`
     - Include only when non-empty.
     - Use this for uncertain or non-blocking observations that do not justify inline comments.
  7. (Optional) `## Test suggestion`
     - Only include when it meets the strict criteria above.
- Return only the markdown body content for `summary_comment`, not a JSON object wrapper or surrounding explanation.
- Stick to informational comments. Do not approve or request changes.
