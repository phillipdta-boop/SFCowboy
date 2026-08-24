// server/src/crypto/encryption.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "./encryption.js";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex key for tests
});

describe("encryption", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "refresh-token-abc123";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext each call", () => {
    const a = encrypt("same-value");
    const b = encrypt("same-value");
    expect(a).not.toBe(b);
  });
});
