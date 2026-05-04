import type { EncryptionEnvelopeV2 } from "./encryption-envelope-v2";

export const encryptionEnvelopeV2Fixture = {
  schema_version: 1,
  warning: "Test vector only. Values are public deterministic crypto fixtures, not production secrets.",
  local_only: {
    user_root_key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    recovery_key: "yf-rec-QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
    data_encryption_key: "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8",
    plaintext: "Private Korea itinerary"
  },
  server_persisted: {
    user_keyring: {
      id: "uk_fixture_v1",
      user_id: "fixture-user-1",
      key_scope: "user",
      key_version: 1,
      wrapping_method: "recovery_key_aes_gcm_v1",
      state: "active",
      nonce: "oKGio6Slpqeoqaqr",
      aad: {
        purpose: "yoofloe.user_root_key.wrap",
        user_id: "fixture-user-1",
        key_id: "uk_fixture_v1",
        key_version: 1,
        wrapping_method: "recovery_key_aes_gcm_v1"
      },
      wrapped_key: "144EPObumipxZkv1hbE--f8G59T4epM6-sX0gfXfYOdA5BqZwpggZlbuaICb6eTE"
    },
    encrypted_record_key: {
      id: "erk_fixture_event_1",
      user_id: "fixture-user-1",
      table_name: "schedule_events",
      row_id: "fixture-event-1",
      field_name: null,
      scope: "personal",
      shared_group_id: null,
      dek_id: "dek_fixture_event_1",
      wrapping_key_id: "uk_fixture_v1",
      wrapping_key_version: 1,
      nonce: "sLGys7S1tre4ubq7",
      aad: {
        purpose: "yoofloe.record_dek.wrap",
        table: "schedule_events",
        row_id: "fixture-event-1",
        scope: "personal",
        user_id: "fixture-user-1",
        dek_id: "dek_fixture_event_1",
        key_version: 1
      },
      wrapped_dek: "GdTYKGhIPdjPcR0pQdAGTRSt20GBuxmixlcYasAfbIk6uyPcmZOLdhhu55OQwiiq"
    },
    encrypted_field: {
      v: 2,
      app: "yoofloe",
      alg: "AES-GCM-256",
      key_scope: "user",
      kid: "uk_fixture_v1",
      dek_id: "dek_fixture_event_1",
      nonce: "wMHCw8TFxsfIycrL",
      aad: {
        table: "schedule_events",
        row_id: "fixture-event-1",
        field: "title",
        user_id: "fixture-user-1",
        scope: "personal",
        schema_version: 2
      },
      ct: "NE7p9N3ZhuNJQEUqI4FZRECvbzODcou8Mf5DnZ2VuH9zMM6V6ZJj"
    } satisfies EncryptionEnvelopeV2
  }
};
