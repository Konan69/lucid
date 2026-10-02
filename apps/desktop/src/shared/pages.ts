import * as Schema from 'effect/Schema'

/** Main mints opaque handles; no WebContents identifiers cross the bridge. */
export const Tab = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('DesktopTab'))
export type Tab = typeof Tab.Type

/**
 * Electron drops prototypes and symbols across contextBridge. Plain tagged options retain their
 * own discriminant; full Effect Option instances keep it on a prototype and cannot cross safely.
 */
function pageOption<S extends Schema.Constraint>(value: S) {
  return Schema.TaggedUnion({ None: {}, Some: { value } })
}

/** Clone-safe optional data on the renderer bridge, with the usual None/Some vocabulary. */
export type PageOption<A> = ReturnType<typeof pageOption<Schema.declare<A>>>['Type']

/** No selection and a selected opaque handle are exhaustive bridge states. */
export const ShowingTab = pageOption(Tab)
/** Navigation failure is absent until Chromium reports its description. */
export const PageLoadFailure = pageOption(Schema.String)

/** Address bar input is interpreted by main, never treated as an executable URL. */
export const PageInput = Schema.Struct({
  address: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8192)),
})
export type PageInput = typeof PageInput.Type

const Coordinate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const Dimension = Coordinate.check(Schema.isGreaterThan(0))

/** The viewport rectangle uses CSS pixels relative to the app's content origin. */
export const PageRectangle = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Dimension,
  height: Dimension,
})
export type PageRectangle = typeof PageRectangle.Type

/** Hidden detaches the guest so app overlays and closed panels cannot be covered by it. */
export const PagePlacement = Schema.Union([PageRectangle, Schema.Literal('hidden')])
export type PagePlacement = typeof PagePlacement.Type

/** A title may genuinely be empty before the document supplies one. */
export const Page = Schema.Struct({
  tab: Tab,
  address: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  failed: PageLoadFailure,
})
export type Page = typeof Page.Type

/** A monotonic revision lets preload discard stale subscription snapshots. */
export const BrowserState = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tabs: Schema.Array(Page),
  showing: ShowingTab,
})
export type BrowserState = typeof BrowserState.Type

/** Refusals are distinct from Chromium navigation failures shown on an existing tab. */
export const AddressRefusal = Schema.Literals([
  'empty',
  'scheme',
  'localhost',
  'credentials',
  'malformed',
])
export type AddressRefusal = typeof AddressRefusal.Type

/** Only this closed set of page operations can reach main-process guest authority. */
export const PagesRequest = Schema.TaggedUnion({
  Open: PageInput.fields,
  Show: { tab: Tab },
  Close: { tab: Tab },
  Go: { tab: Tab, address: PageInput.fields.address },
  Back: { tab: Tab },
  Forward: { tab: Tab },
  Reload: { tab: Tab },
  Stop: { tab: Tab },
  Place: { placement: PagePlacement },
  Get: {},
  Reset: {},
  Forget: {},
})
export type PagesRequest = typeof PagesRequest.Type

/** Expected page failures reject calls with a typed error instead of pretending to succeed. */
export class PageMissing extends Schema.TaggedError<PageMissing>()(
  'PageMissing',
  { tab: Tab },
  { title: 'Page is no longer open' },
) {}
/** Unsafe or malformed typed input never reaches Chromium. */
export class PageAddressRefused extends Schema.TaggedError<PageAddressRefused>()(
  'PageAddressRefused',
  { reason: AddressRefusal },
  { title: 'Page address was refused' },
) {}
/** Creating or driving a native guest failed, independently of a site failing to load. */
export class PageUnavailable extends Schema.TaggedError<PageUnavailable>()(
  'PageUnavailable',
  {},
  { title: 'Page view is unavailable' },
) {}
/** Cookies or site storage could not be cleared in the pages partition. */
export class PageStorageClearFailed extends Schema.TaggedError<PageStorageClearFailed>()(
  'PageStorageClearFailed',
  {},
  { title: 'Page storage could not be cleared' },
) {}
/** HTTP cache could not be cleared in the pages partition. */
export class PageCacheClearFailed extends Schema.TaggedError<PageCacheClearFailed>()(
  'PageCacheClearFailed',
  {},
  { title: 'Page cache could not be cleared' },
) {}

/** Failures remain closed and schema-owned across IPC. */
export const PagesFailure = Schema.Union([
  PageMissing,
  PageAddressRefused,
  PageUnavailable,
  PageStorageClearFailed,
  PageCacheClearFailed,
])
export type PagesFailure = typeof PagesFailure.Type

/** Each response distinguishes a new handle, snapshot, completed action, or precise failure. */
export const PagesResponse = Schema.TaggedUnion({
  Opened: { tab: Tab },
  State: { value: BrowserState },
  Done: {},
  Rejected: { reason: PagesFailure },
})
export type PagesResponse = typeof PagesResponse.Type

/** Downloads are canceled before Electron writes any bytes to disk. */
export const PageDownloadRefused = Schema.Struct({
  tab: Tab,
  address: Schema.String,
  filename: Schema.String,
})
export type PageDownloadRefused = typeof PageDownloadRefused.Type

/** Renderer-facing page capability; watch hydrates or replays current state and returns cleanup. */
export interface VividPagesBridge {
  readonly open: (input: PageInput) => Promise<Tab>
  readonly show: (tab: Tab) => Promise<void>
  readonly close: (tab: Tab) => Promise<void>
  readonly go: (input: { readonly tab: Tab; readonly address: string }) => Promise<void>
  readonly back: (tab: Tab) => Promise<void>
  readonly forward: (tab: Tab) => Promise<void>
  readonly reload: (tab: Tab) => Promise<void>
  readonly stop: (tab: Tab) => Promise<void>
  readonly place: (placement: PagePlacement) => Promise<void>
  readonly watch: (listener: (state: BrowserState) => void) => () => void
  readonly watchDownloads: (listener: (event: PageDownloadRefused) => void) => () => void
  /** Close all pages on sign-out without deleting browsing data. */
  readonly reset: () => Promise<void>
  /** Close all pages, then clear cookies, site storage, and cache in the pages partition only. */
  readonly forget: () => Promise<void>
}
