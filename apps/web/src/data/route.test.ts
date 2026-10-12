import { createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { readSearch } from './route'

/**
 * A root route that reads its query the way the app's does (`routes/root.tsx`:
 * `validateSearch: readSearch`) and has nothing else. The app's own root cannot be loaded here:
 * it imports `data/warm`, which reaches `data/runtime`, and that reads `location` and opens the
 * socket as it is evaluated.
 */
const root = createRootRoute({ validateSearch: readSearch })

/**
 * What the router holds for an address: the query every screen is handed (`useSearch` reads a
 * match's `search`), and whether reading it was an error. A real router is made on the address,
 * with the parser the app's router uses (it sets no other, `src/router.ts`), and asked for its
 * matches (`matchRoutes`, the step the router itself takes for every address; installed
 * `@tanstack/router-core` 1.171.34 `src/router.ts` `matchRoutesInternal`). Nothing of the
 * router's is repeated here: how the reader's answer and the address's own words are put
 * together is the router's doing.
 */
const held = (address: string) => {
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [address] }),
  })
  return router
    .matchRoutes(router.latestLocation)
    .map((match) => ({ search: match.search, failed: match.searchError !== undefined }))
}

describe('the query the app reads', () => {
  it('opens the Settings section each link from the phone names', () => {
    // The phone writes these three addresses and nothing else of the query
    // (`apps/mobile/src/data/server.ts`: Integrations, Rules, Record). The words are written out
    // here, not read from the web's list of sections: a section renamed on the web leaves the
    // phone's link opening nothing, and this is the case that fails.
    expect(held('/?settings=connections')).toStrictEqual([
      { search: { settings: 'connections' }, failed: false },
    ])
    expect(held('/?settings=rules')).toStrictEqual([
      { search: { settings: 'rules' }, failed: false },
    ])
    expect(held('/?settings=record')).toStrictEqual([
      { search: { settings: 'record' }, failed: false },
    ])
  })

  it('holds a query without the word as Settings shut, and keeps what else it carries', () => {
    expect(held('/')).toStrictEqual([{ search: {}, failed: false }])
    // A sign-in's mark is somebody else's word: it does not open Settings, and it is still
    // there for whoever reads it, beside a section or without one.
    expect(held('/?joined=google')).toStrictEqual([{ search: { joined: 'google' }, failed: false }])
    expect(held('/?joined=google&settings=general')).toStrictEqual([
      { search: { joined: 'google', settings: 'general' }, failed: false },
    ])
  })

  it('holds a section this build does not know as Settings shut, not as that section', () => {
    for (const query of [
      // A section from a newer build.
      'settings=billing',
      // A known section in another case, and one named twice (the parser hands over a list).
      'settings=Memory',
      'settings=memory&settings=rules',
      // No word after the sign, and a number where a word belongs.
      'settings=',
      'settings=1',
    ]) {
      // `settings` is there and says nothing: a reader that left the key out would leave the
      // address's own word in what the router holds, and Settings would open on it. It is not
      // an error either: the app opens, with Settings shut.
      expect(held(`/?${query}`), query).toStrictEqual([
        { search: { settings: undefined }, failed: false },
      ])
    }
    // Beside somebody else's word, only Vivid's own word is put right.
    expect(held('/?joined=google&settings=billing')).toStrictEqual([
      { search: { joined: 'google', settings: undefined }, failed: false },
    ])
  })
})
