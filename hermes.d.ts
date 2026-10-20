/**
 * React Native 0.86.3 enables Hermes V1, pinned in sdks/.hermesv1version to hermes-v250829098.0.17.
 * Its lib/VM/JSLib/Array.cpp registers findLast and findLastIndex beyond ES2022.
 * Keep this extension narrow; raising lib would also admit APIs missing on the phone.
 * https://github.com/facebook/hermes/blob/hermes-v250829098.0.17/lib/VM/JSLib/Array.cpp
 */
interface Array<T> {
  findLast: Array<T>['find']
  findLastIndex: Array<T>['findIndex']
}

interface ReadonlyArray<T> {
  findLast: ReadonlyArray<T>['find']
  findLastIndex: ReadonlyArray<T>['findIndex']
}
