import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "./oauth-provider.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const root = mkdtempSync(join(tmpdir(), "devspace-oauth-provider-test-"));
const resourceServerUrl = new URL("https://devspace.example.com/mcp");
const config: OAuthConfig = {
  ownerToken: "owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["localhost"],
};

try {
  const firstProvider = new SingleUserOAuthProvider(config, resourceServerUrl, root);
  const client = firstProvider.clientsStore.registerClient({
    client_name: "test client",
    redirect_uris: ["http://localhost/callback"],
    scope: "devspace",
  });
  const issueTokens = firstProvider["issueTokens"] as (
    clientId: string,
    scopes: string[],
    resource?: URL,
  ) => OAuthTokens;
  const firstTokens = issueTokens.call(firstProvider, client.client_id, ["devspace"], resourceServerUrl);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(config, resourceServerUrl, root);
  const persistedClient = secondProvider.clientsStore.getClient(client.client_id);
  assert.equal(persistedClient?.client_id, client.client_id);

  const verified = await secondProvider.verifyAccessToken(firstTokens.access_token);
  assert.equal(verified.clientId, client.client_id);

  const secondTokens = await secondProvider.exchangeRefreshToken(
    client,
    assertString(firstTokens.refresh_token),
    undefined,
    resourceServerUrl,
  );
  assert.equal(Boolean(secondTokens.refresh_token), true);
  assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);
  await assert.rejects(
    () => secondProvider.exchangeRefreshToken(client, assertString(firstTokens.refresh_token), undefined, resourceServerUrl),
    InvalidGrantError,
  );
  secondProvider.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assertString(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Expected string value");
  }
  return value;
}
