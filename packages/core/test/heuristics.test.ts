import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSignerSignatureField,
  isSignerDateField,
  isNonSignerParty,
  hasSignToken,
} from "../src/detect/field-heuristics";

test("hasSignToken matches whole tokens, not substrings", () => {
  assert.ok(hasSignToken("signer_signature"));
  assert.ok(hasSignToken("signed"));
  assert.ok(hasSignToken("date_signed"));
  assert.ok(!hasSignToken("assignment")); // not as·sign·ment
  assert.ok(!hasSignToken("designation"));
  assert.ok(!hasSignToken("consignee"));
});

test("isSignerSignatureField accepts signer, rejects date and non-signer", () => {
  assert.ok(isSignerSignatureField("applicant_signature"));
  assert.ok(isSignerSignatureField("signer_signature"));
  assert.ok(isSignerSignatureField("tenant_signature"));
  assert.ok(!isSignerSignatureField("signature_date")); // date precedence
  assert.ok(!isSignerSignatureField("witness_signature"));
  assert.ok(!isSignerSignatureField("representative_signature"));
  assert.ok(!isSignerSignatureField("full_name"));
});

test("isSignerDateField accepts the date-signed line only", () => {
  assert.ok(isSignerDateField("date_signed"));
  assert.ok(isSignerDateField("signature_date"));
  assert.ok(!isSignerDateField("date_of_birth"));
  assert.ok(!isSignerDateField("witness_date_signed"));
});

test("isNonSignerParty flags other parties", () => {
  assert.ok(isNonSignerParty("witness_signature"));
  assert.ok(isNonSignerParty("authorized_representative_signature"));
  assert.ok(isNonSignerParty("notary_public"));
  assert.ok(!isNonSignerParty("signer_signature"));
});
