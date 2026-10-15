import assert from "node:assert/strict";
import test from "node:test";

import {
  getInstaWorldConfig,
  requireInstaWorldConfig,
} from "../app/lib/instaworld.server.ts";

const ENV_KEYS = [
  "INSTAWORLD_TEST_SHOPS",
  "INSTAWORLD_TEST_API_KEY",
  "INSTAWORLD_TEST_LOCATION_ID",
  "INSTAWORLD_API_KEY",
  "INSTAWORLD_LOCATION_ID",
] as const;

function withEnv(values: Record<string, string | undefined>, callback: () => void) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      if (key in values) {
        if (values[key] === undefined) delete process.env[key];
        else process.env[key] = values[key];
      }
    }
    callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("selects test InstaWorld credentials for the configured development shop", () => {
  withEnv(
    {
      INSTAWORLD_TEST_SHOPS: "talwar-instaworld.myshopify.com",
      INSTAWORLD_TEST_API_KEY: "test-key",
      INSTAWORLD_TEST_LOCATION_ID: "9876",
      INSTAWORLD_API_KEY: "live-key",
      INSTAWORLD_LOCATION_ID: "1234",
    },
    () => {
      const config = requireInstaWorldConfig("talwar-instaworld.myshopify.com");
      assert.equal(config.account, "test");
      assert.equal(config.apiKey, "test-key");
      assert.equal(config.locationId, 9876);
    },
  );
});

test("keeps the live account for shops not listed as test shops", () => {
  withEnv(
    {
      INSTAWORLD_TEST_SHOPS: "talwar-instaworld.myshopify.com",
      INSTAWORLD_TEST_API_KEY: "test-key",
      INSTAWORLD_TEST_LOCATION_ID: "9876",
      INSTAWORLD_API_KEY: "live-key",
      INSTAWORLD_LOCATION_ID: "1234",
    },
    () => {
      const config = requireInstaWorldConfig("talwarstore.myshopify.com");
      assert.equal(config.account, "live");
      assert.equal(config.apiKey, "live-key");
      assert.equal(config.locationId, 1234);
    },
  );
});

test("never falls back to live credentials when the test account is incomplete", () => {
  withEnv(
    {
      INSTAWORLD_TEST_SHOPS: "talwar-instaworld.myshopify.com",
      INSTAWORLD_TEST_API_KEY: undefined,
      INSTAWORLD_TEST_LOCATION_ID: undefined,
      INSTAWORLD_API_KEY: "live-key",
      INSTAWORLD_LOCATION_ID: "1234",
    },
    () => {
      assert.throws(
        () => requireInstaWorldConfig("talwar-instaworld.myshopify.com"),
        /INSTAWORLD_TEST_API_KEY/,
      );
      assert.equal(getInstaWorldConfig("talwar-instaworld.myshopify.com").account, "test");
    },
  );
});
