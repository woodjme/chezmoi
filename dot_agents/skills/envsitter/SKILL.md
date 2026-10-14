---
name: envsitter
description: Use whenever a task involves a .env or dotenv file (.env, .env.local, .env.production, *.env, environment variables, secrets, API keys, credentials config) - listing keys, checking whether a variable is set or has the right shape, comparing a value, adding, setting, renaming, copying, deleting or validating entries. Inspects and edits .env files with the envsitter CLI without ever reading or printing secret values. Load it BEFORE reading, grepping, cat-ing or editing any .env file.
---

# envsitter: work with .env files without seeing secrets

`.env` files hold live secrets.
Anything you read ends up in the transcript, logs and shared sessions, so never look at their values.
Use the `envsitter` CLI instead: it returns keys, booleans, fingerprints and line numbers, never values.

## Hard rules

- Never `read`, `grep`, `cat`, `head`, `tail`, `less`, `source`, `printenv`/`env` dump, or open a sensitive env file in any other way.
  This covers `.env`, `.env.*` and `*.env` files, except the example and template files below.
- Never use `edit`, `write` or `patch` on a sensitive env file. Change it with envsitter only.
- Never print, echo, log or repeat a secret value, including values the user gives you.
- Never read `.envsitter/pepper`.
- Example and template files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.default`) contain no secrets.
  Read and edit them normally.
- If a task cannot be done without seeing a value, stop and ask the user to do that step themselves.

## Running it

Always invoke the pinned version through npx:

```bash
npx -y envsitter@0.0.4 <command> --file <path> --json
```

- Run it from the directory that holds the env file, or pass a path relative to the working directory.
- Add `--json` for structured output.
- Commands that change files are dry runs unless `--write` is passed.
  Run once without `--write` to check the plan, then again with `--write`.
- Pass values and candidates on stdin (`--value-stdin`, `--candidate-stdin`) with `printf '%s'`, never as flags.
  This keeps them out of shell history and process listings.
- `match` exits `0` for a match, `1` for no match and `2` for an error.
  An exit code of `1` from `match` is an answer, not a failure.

## Pepper file

`fingerprint` and the default `is_equal` match create a local HMAC key at `.envsitter/pepper`.
This file is not gitignored automatically.
Before your first such call in a repository, make sure `.envsitter/` is in `.gitignore`, and add it if it is missing.

## Reading

| Goal | Command |
| --- | --- |
| List keys | `keys --file .env --json` (optional `--filter-regex "/(KEY\|TOKEN)/i"`) |
| Does a key exist? | `match --file .env --key NAME --op exists --json` |
| Is it empty? | `match --file .env --key NAME --op is_empty --json` |
| Type check | `match --file .env --key NAME --op is_number` (or `is_boolean`, `is_string`) `--json` |
| Check value shapes | `scan --file .env --detect jwt,url,base64 --json` (`base64` flags short plain values too, so treat it as a hint) |
| Validate syntax | `validate --file .env --json` |
| Compare across files or environments | `fingerprint --file <f> --key NAME` for each file, then compare the fingerprints |

## Matching a value without revealing it

```bash
# Exact match
printf '%s' 'candidate' | npx -y envsitter@0.0.4 match --file .env --key NAME --candidate-stdin --json

# Prefix, suffix or regex
printf '%s' 'sk-' | npx -y envsitter@0.0.4 match --file .env --key NAME --op partial_match_prefix --candidate-stdin --json
printf '%s' '/^https:\/\//' | npx -y envsitter@0.0.4 match --file .env --key NAME --op partial_match_regex --candidate-stdin --json

# One candidate against several keys, or all keys
printf '%s' 'candidate' | npx -y envsitter@0.0.4 match --file .env --keys A,B --candidate-stdin --json
printf '%s' 'candidate' | npx -y envsitter@0.0.4 match --file .env --all-keys --candidate-stdin --json

# Several candidates by key (pipe the JSON on stdin)
printf '%s' '{"A":"x","B":"y"}' | npx -y envsitter@0.0.4 match-by-key --file .env --candidates-stdin --json
```

Ops are `exists`, `is_empty`, `is_equal` (the default), `partial_match_prefix`, `partial_match_suffix`, `partial_match_regex`, `is_number`, `is_boolean` and `is_string`.

## Changing files

Run each command without `--write` first, then again with `--write`.

```bash
# Add a key (fails if it already exists)
printf '%s' 'value' | npx -y envsitter@0.0.4 add --file .env --key NAME --value-stdin --json

# Create or update a key
printf '%s' 'value' | npx -y envsitter@0.0.4 set --file .env --key NAME --value-stdin --json

# Empty a value but keep the key
npx -y envsitter@0.0.4 unset --file .env --key NAME --json

# Remove keys
npx -y envsitter@0.0.4 delete --file .env --keys A,B --json

# Copy keys between files (optionally renaming, with --on-conflict error|skip|overwrite)
npx -y envsitter@0.0.4 copy --from .env.production --to .env.staging --keys A,B --rename A=A2 --on-conflict skip --json

# Add a comment next to a key
npx -y envsitter@0.0.4 annotate --file .env --key NAME --comment "text" --json

# Sort and group keys
npx -y envsitter@0.0.4 format --file .env --mode sections --sort alpha --json
```

- If a value has to come from the user, ask them for it, pass it on stdin, and do not repeat it in your reply.
- To create a value the user doesn't need to see, such as a random secret, generate it inside the pipe without displaying it: `openssl rand -hex 32 | tr -d '\n' | npx -y envsitter@0.0.4 set ... --value-stdin --write`.
- After a change, confirm it with `keys` or `match --op exists`, not by reading the file.

## Reporting back

Report keys, booleans, line numbers and fingerprints only.
Describe a value by its properties, such as "set", "empty", "starts with `sk-`" or "a URL", never by its content.
