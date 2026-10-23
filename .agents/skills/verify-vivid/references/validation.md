# Validation requirements

A behaviour proof runs Launch, Doctor, the touched feature HTTP and browser recipes, then Cleanup on the same commit and unchanged tree. A dirty run is labelled dirty; it does not prove a clean commit. A rehearsal run proves plumbing only. Blocked features remain unverified and unblocking their recipe becomes the next task.

Keep state, launch/build logs, doctor, public request/response/stream/history, SQL, browser commands, snapshots, screenshots and cleanup audits under the run's evidence directory. Record host and model alongside the feature file and head in the PR. The parent owns the exact-head Opus review.

Round 1 used a private server composition and hard-wired rehearsal. Its retained evidence does not establish real-runtime behaviour coverage. Round 2 deletes that composition and boots the product entry. Do not cite the round-1 proof as a substitute.

The eight lifecycle tests use temporary directories. Formatting, lint and syntax checks do not replace real-runtime feature proof. Native clients, external authorities and Artifact opening remain separate claims with their own prerequisites.
