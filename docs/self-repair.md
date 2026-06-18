# Irene Self-Repair

Irene has an owner-only `self_repair` tool for small code fixes.

It is disabled by default. To allow patch application on a trusted local host:

```env
SELF_REPAIR_ENABLED=1
SELF_REPAIR_ALLOW_RESTART=1
```

Guardrails:

- Only the configured bot owner can use it.
- It accepts unified diffs only.
- It rejects `.env`, key, secret, `.git`, `.gcloud-config`, `.tools`, `node_modules`, build output, and paths outside source/docs/test allowlists.
- It runs `git apply --check` before applying.
- It only runs allowlisted check commands such as `npm run lint`, workspace builds/tests, `node --check`, and `git diff --check`.
- If no checks are provided, it chooses lint/build/test commands based on the touched package paths.
- If a check fails, it reverses its own patch.
- It notifies the owner while applying, after failures, and after a successful apply.
- Restart is optional, delayed until checks pass, and requires `SELF_REPAIR_ALLOW_RESTART=1`.

Recommended flow:

1. Owner describes the bug and asks Irene to diagnose herself.
2. Irene calls `self_repair` with `mode: "auto"`.
3. Irene uses the returned logs/source context to create a focused unified diff.
4. Irene calls `self_repair` with `mode: "apply"`, focused tests, and `restart: true`.
5. The tool validates, applies, tests, notifies the owner, and schedules restart only after checks pass.
6. Irene reports what broke, what changed, which checks passed, and whether restart was scheduled.
