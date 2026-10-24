import { assert, effect, log } from "./load.mjs";
const { Deferred, Effect, Fiber, Scope } = effect;
const events = [];
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const ready = yield* Deferred.make();
  const worker = Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => events.push("resource-a")));
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => events.push("resource-b")));
    yield* Effect.andThen(Deferred.succeed(ready, true), Effect.never).pipe(Effect.onInterrupt(() => Effect.sync(() => events.push("onInterrupt"))), Effect.ensuring(Effect.sync(() => events.push("ensuring"))));
  })).pipe(Effect.onExit(() => Effect.sync(() => events.push("onExit"))));
  const fiber = yield* Effect.forkScoped(worker);
  yield* Deferred.await(ready);
  yield* Fiber.interrupt(fiber);
  events.push("interrupt-returned");
})));
assert.deepEqual(events, ["onInterrupt", "ensuring", "resource-b", "resource-a", "onExit", "interrupt-returned"]);
log("interruption.finalizers", events);
const closed = [];
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const scope = yield* Effect.scope;
  yield* Scope.addFinalizer(scope, Effect.sync(() => closed.push(1)));
  yield* Scope.addFinalizer(scope, Effect.sync(() => closed.push(2)));
  const started = yield* Deferred.make();
  yield* Effect.forkScoped(Effect.andThen(Deferred.succeed(started, true), Effect.never).pipe(Effect.ensuring(Effect.sync(() => closed.push("child")))));
  yield* Deferred.await(started);
})));
assert.deepEqual(closed, ["child", 2, 1]);
log("scope.defaultCloseOrder", closed);
const maskedEvents = [];
await Effect.runPromise(Effect.gen(function* () {
  const ready = yield* Deferred.make();
  const acquired = yield* Deferred.make();
  const fiber = yield* Effect.forkChild(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* Deferred.succeed(ready, true);
    yield* Deferred.await(acquired);
    maskedEvents.push("acquisition-complete");
    yield* restore(Effect.never);
  })).pipe(Effect.ensuring(Effect.sync(() => maskedEvents.push("finalizer")))));
  yield* Deferred.await(ready);
  const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
  assert.deepEqual(maskedEvents, []);
  yield* Deferred.succeed(acquired, true);
  yield* Fiber.join(interrupter);
  maskedEvents.push("interruption-complete");
}));
assert.deepEqual(maskedEvents, ["acquisition-complete", "finalizer", "interruption-complete"]);
log("uninterruptibleMask.restore", maskedEvents);
