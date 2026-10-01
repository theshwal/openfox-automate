# Delivery Policy v1

`.github/delivery-policy.yml` is the machine-readable delivery contract for a repository.

## Precedence

1. Actual GitHub rulesets / branch protection and the target repository's constraints.
2. `.github/delivery-policy.yml`.
3. `AGENTS.md`, `CONTRIBUTING.md`, and human documentation.

A policy may be more restrictive than GitHub, never less.

## Common contract

```yaml
version: 1
repository:
  kind: product|plugin|tool|experiment
  default_base: main

pr:
  contract: v1
  issue_link: refs
  title: conventional
  template: .github/pull_request_template.md

quality:
  source: repo
  require_verified_criteria: true
  require_clean_review: true
  revalidate_after_repair: true

publish:
  target: origin
  draft: false

merge:
  owner: automate|mergify|github|upstream
  mode: auto|external|manual
  method: squash|merge|rebase

conflicts:
  strategy: repair-revalidate

post_merge:
  verify: true

human:
  default: false
  required_for: []
```

## Working forks

A working fork may define `repository.kind: working-fork`, `delivery.require_explicit_mode: true`, and a `modes` map. Each mode is a complete delivery strategy (for example `upstream`, `local`, or `stack`).

The delivery mode must be fixed before publication. The publisher must not guess the target at the end of the workflow.

## Invariants

- Publish must not edit product code after build/verification is complete.
- Repository-specific quality requirements are resolved before PR creation.
- A repair or rebase that changes the reviewed HEAD requires revalidation.
- Merge authority belongs to the owner declared by the policy.
- Human validation is exceptional and policy-driven, not a default final click.
- PR prose is not a state machine; automation consumes structured workflow state and this policy.
