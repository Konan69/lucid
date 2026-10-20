/**
 * React Native's installed hermes-compiler 250829098.0.17 uses hermes-v0.17.0.
 * Its lib/VM/JSLib/Array.cpp registers findLast and findLastIndex beyond ES2022.
 * Keep this extension narrow; raising lib would also admit APIs missing on the phone.
 * https://github.com/facebook/hermes/blob/hermes-v0.17.0/lib/VM/JSLib/Array.cpp
 */
interface Array<T> {
  findLast: Array<T>['find']
  findLastIndex: Array<T>['findIndex']
}

interface ReadonlyArray<T> {
  findLast: ReadonlyArray<T>['find']
  findLastIndex: ReadonlyArray<T>['findIndex']
}
