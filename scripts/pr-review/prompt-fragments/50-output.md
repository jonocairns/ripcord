Output:
- Post ONE final summary comment even when there are no inline findings.
- Inline comments only when warranted by the rules above.
- Summary comments may include non-blocking watch-outs or checks to verify; inline comments may not.
- Summary sections should cite the main materials used (for example which skills ran, which files were the highest-risk reads, and any Sentry issue IDs if relevant).
- If the review ran in scoped mode because the PR exceeded the changed-file limit, say so explicitly in the final summary and name the highest-risk areas/files you focused on.
- Before posting any inline comment, verify:
  1. Is this a real bug or a theoretical edge case? (only post if real)
  2. Have I already commented on this same root cause elsewhere? (only post once per issue)
  3. Am I certain this is wrong, or am I asking a question? (questions go in summary, not inline)
  4. Can I explain the realistic failure path and severity clearly? (only post if yes)
- Post ONE final summary comment with:
  1. `## Summary`
     - Start with 1 short paragraph explaining what the PR does overall.
     - Then add 2-4 bullets covering the main change areas.
     - Name the key files or subsystems for each area.
     - For docs-only or low-risk PRs, keep this concise, but still explain the PR shape rather than only saying "Looks good."
  2. `## Confidence`
     - `Confidence: X/5`
     - Add 1 short sentence explaining the confidence level in production-readiness terms.
  3. `## Important files changed`
     - Include a markdown table with columns `File` and `Overview`.
     - Include the 3-10 most important files only.
     - For each file, explain its role in the PR, not just its name.
  4. `## Findings`
     - If there are material issues, list them with severity and concrete failure mode.
     - If there are no material issues, say `No material findings.`
  5. `## Watch-outs`
     - Include only when non-empty.
     - Use this for uncertain or non-blocking observations that do not justify inline comments.
  6. (Optional) `## Test suggestion`
     - Only include when it meets the strict criteria above.
- Use a non-interactive command, e.g.:
  `gh pr comment {{PR_NUMBER}} --body "<final summary>"`
- Stick to informational comments. Do not approve or request changes.
