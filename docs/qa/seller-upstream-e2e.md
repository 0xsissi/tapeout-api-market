# Seller upstream E2E QA

## Scenario A: Claude on a fresh machine

1. Clear `~/.clawmarket`.
2. Run `clawmarket`, complete onboarding with `role=seller` and `upstream=claude`.
3. Complete the Anthropic OAuth login opened by the seller login step.
4. Confirm the seller model step shows real `claude-*` model ids discovered from CLIProxyAPI, not only preset guesses.
5. Start seller.
6. Run:

   ```bash
   curl http://127.0.0.1:8787/v1/seller/status | jq .backend.models
   ```

   Expected: models are non-empty and match the seller model selection.
7. From a buyer machine, send a chat request to one of those models.

## Scenario B: Switch from Codex to Claude in Console

1. Start with a running Codex seller.
2. Open the Seller view and choose `登录 Claude / 卖 Claude`.
3. Confirm the modal, complete OAuth, and wait for the Console to reopen.
4. Confirm the terminal reports model discovery and writes `N` sellable models.
5. Confirm the Seller view shows the Claude upstream and model list after refresh.
6. Confirm a backup directory like `~/.clawmarket/embedded-cliproxy-local-seller/auths.bak-codex-<timestamp>` exists.

## Scenario C: Failed login rolls back

1. Start with existing Codex auth.
2. Choose `换 Codex 账号`, then interrupt the OAuth flow with `Ctrl-C`.
3. Confirm the CLI reports login failure and restores the previous auth files.
4. Compare the restored `auths` directory with the original contents.
5. Restart seller and confirm it starts with the original account.

## Scenario D: Gemini

Repeat Scenario A with `upstream=gemini`.
