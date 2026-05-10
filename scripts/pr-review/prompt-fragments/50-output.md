Output:
- If you find no material issues, post a single summary comment saying "Looks good" with a 1-line rationale and a confidence score.
- Inline comments only when warranted by the rules above.
- Summary comments may include non-blocking watch-outs or checks to verify; inline comments may not.
- Summary bullets should cite the main materials used (for example which skills ran, which files were the highest-risk reads, and any Sentry issue IDs if relevant).
- Before posting any inline comment, verify:
  1. Is this a real bug or a theoretical edge case? (only post if real)
  2. Have I already commented on this same root cause elsewhere? (only post once per issue)
  3. Am I certain this is wrong, or am I asking a question? (questions go in summary, not inline)
  4. Can I explain the realistic failure path and severity clearly? (only post if yes)
- Post ONE final summary comment with:
  1. Summary: 2-3 bullets including which skills were run and what they found
  2. Watch-outs (only if non-empty) — uncertain observations
  3. Confidence score (0-5) with one-sentence rationale focused on production readiness
  4. (Optional) Test suggestion only when it meets the strict criteria above
- Use a non-interactive command, e.g.:
  `gh pr comment {{PR_NUMBER}} --body "<final summary>"`
- Stick to informational comments. Do not approve or request changes.
