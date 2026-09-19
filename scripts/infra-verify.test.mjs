import assert from "node:assert/strict"
import test from "node:test"
import {
  readTargetDocument,
  validateTargets,
  verifyInfrastructure
} from "./infra-verify.mjs"

void test("current infrastructure satisfies offline invariants", () => {
  assert.deepEqual(verifyInfrastructure(), {
    targets: 3,
    serverEnvironmentVariables: 7,
    result: "ok"
  })
})

void test("duplicate physical names are rejected", () => {
  const targets = structuredClone(readTargetDocument())
  targets.preview.stackName = targets.local.stackName
  assert.throws(() => validateTargets(targets), /stackName values must be unique/)
})

void test("production teardown cannot be enabled", () => {
  const targets = structuredClone(readTargetDocument())
  targets.production.destroyOnTeardown = true
  assert.throws(() => validateTargets(targets), /production teardown must be protected/)
})
