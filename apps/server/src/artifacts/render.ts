import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import {
  ARTIFACT_FILE_BYTES,
  ArtifactComputerUnavailable,
  ArtifactFile,
  ArtifactFileDigest,
  ArtifactFileRefused,
  ArtifactFileTooLarge,
  ArtifactPreview,
  ArtifactRenderFailed,
  ArtifactRenderUnsupported,
  ArtifactSource,
  ArtifactSourcePath,
  ArtifactWorkbookInspection,
  type ArtifactFileRole,
  type InspectArtifactFileRequest,
  type PersonId,
} from '@vivid/contracts'
import { Effect, Predicate, Schema } from 'effect'
import { ComputerStore } from '../computers/store.ts'
import { workbookInspection } from './xlsx.ts'

export const FileCapture = Schema.Struct({
  output: ArtifactFile,
  source: ArtifactSource,
  preview: ArtifactPreview,
  workbook: Schema.optionalKey(ArtifactWorkbookInspection),
})
export type FileCapture = typeof FileCapture.Type
export interface CapturedArtifact {
  readonly capture: FileCapture
  readonly output: Uint8Array
  readonly source: Uint8Array | null
  readonly preview: Uint8Array | null
}

const mimeTypes = new Map([
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pdf', 'application/pdf'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.png', 'image/png'],
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
])

/** Length and digest describe the captured bytes, never model-supplied measurements. */
export function capturedFile(path: string, bytes: Uint8Array): ArtifactFile {
  const extension = NodePath.posix.extname(path).toLowerCase()
  const mimeType = mimeTypes.get(extension)
  return ArtifactFile.make({
    name: NodePath.posix.basename(path),
    mimeType: mimeType === undefined ? 'application/octet-stream' : mimeType,
    byteLength: bytes.byteLength,
    sha256: ArtifactFileDigest.make(NodeCrypto.createHash('sha256').update(bytes).digest('hex')),
  })
}

/** SSH already bounds reads; checking again covers a file growing after stat or another transport. */
const capture = Effect.fn('Artifacts.capture')(function* (
  personId: PersonId,
  path: string,
  role: ArtifactFileRole,
) {
  const computer = yield* ComputerStore
  const bytes = yield* computer.read(personId, path).pipe(
    Effect.mapError((failure) => {
      if (Predicate.isTagged(failure, 'MachineFileRefused')) {
        if (failure.reason === 'large')
          return new ArtifactFileTooLarge({ role, limit: ARTIFACT_FILE_BYTES })
        const reason =
          failure.reason === 'missing' || failure.reason === 'directory'
            ? failure.reason
            : 'unreadable'
        return new ArtifactFileRefused({ role, reason })
      }
      return new ArtifactComputerUnavailable({
        message: 'The Computer is unavailable or held by the Person.',
      })
    }),
  )
  if (bytes.byteLength === 0) return yield* new ArtifactFileRefused({ role, reason: 'empty' })
  if (bytes.byteLength > ARTIFACT_FILE_BYTES)
    return yield* new ArtifactFileTooLarge({ role, limit: ARTIFACT_FILE_BYTES })
  return bytes
})

const decodeWorkbook = Schema.decodeUnknownEffect(Schema.fromJsonString(ArtifactWorkbookInspection))
const inspectionFailure = () =>
  new ArtifactRenderFailed({ message: 'Workbook inspection could not be read.' })

const placementFailure = () =>
  new ArtifactRenderFailed({ message: 'The captured copy could not be placed on the Computer.' })

/** The random workspace contains only captured bytes. No renderer ever opens the mutable input path.
 * DOCX is exported by the Computer's LibreOffice and the first PDF page becomes a bounded PNG.
 * XLSX also returns bounded cell read-back from the captured workbook. A PNG is its own render. */
const render = Effect.fn('Artifacts.render')(function* (
  personId: PersonId,
  output: Uint8Array,
  extension: string,
) {
  if (extension === '.png') return { preview: null }
  const computer = yield* ComputerStore
  const directory = `/tmp/vivid-artifact-${NodeCrypto.randomUUID()}`
  const execute = (command: string) =>
    computer.run(personId, { command, directory: '.', timeoutSeconds: 120 }).pipe(
      Effect.mapError(
        () =>
          new ArtifactRenderFailed({ message: 'The Computer could not render the captured file.' }),
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0 && !result.timedOut
          ? Effect.void
          : Effect.fail(
              new ArtifactRenderFailed({
                message:
                  'The captured file could not be rendered. Check the format and Computer tools.',
              }),
            ),
      ),
    )
  return yield* Effect.acquireUseRelease(
    execute(`mkdir -m 700 ${directory}`),
    () =>
      Effect.gen(function* () {
        yield* computer
          .put(personId, { path: `${directory}/input${extension}`, content: output })
          .pipe(Effect.mapError(placementFailure))
        if (extension === '.docx' || extension === '.xlsx')
          yield* execute(
            `libreoffice -env:UserInstallation=file://${directory}/profile --headless --convert-to pdf --outdir ${directory} ${directory}/input${extension}`,
          )
        yield* execute(
          `pdftoppm -f 1 -singlefile -scale-to 1600 -png ${directory}/input.pdf ${directory}/preview`,
        )
        const preview = yield* capture(personId, `${directory}/preview.png`, 'preview')
        if (extension !== '.xlsx') return { preview }
        yield* execute(workbookInspection(directory))
        const bytes = yield* capture(personId, `${directory}/inspection.json`, 'preview')
        const workbook = yield* decodeWorkbook(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(inspectionFailure),
        )
        return { preview, workbook }
      }),
    () =>
      execute(`rm -rf ${directory}`).pipe(
        Effect.catch(() => Effect.logWarning('Artifact render workspace cleanup failed')),
      ),
  )
})

/** Capture output and editable source before rendering; publication receives only this immutable bundle. */
export const captureArtifact = Effect.fn('Artifacts.captureArtifact')(function* (
  personId: PersonId,
  request: InspectArtifactFileRequest,
) {
  const extension = NodePath.posix.extname(request.path).toLowerCase()
  if (!['.docx', '.pdf', '.png', '.xlsx'].includes(extension))
    return yield* new ArtifactRenderUnsupported({
      message: 'Inspection supports DOCX, PDF, PNG and XLSX files.',
    })
  if (extension === '.pdf' && ArtifactSourcePath.guards.Output(request.source))
    return yield* new ArtifactRenderUnsupported({
      message: 'A PDF export needs its separate editable source.',
    })
  const output = yield* capture(personId, request.path, 'output')
  const source = yield* ArtifactSourcePath.match<
    Effect.Effect<
      { metadata: ArtifactSource; bytes: Uint8Array | null },
      ArtifactComputerUnavailable | ArtifactFileRefused | ArtifactFileTooLarge,
      ComputerStore
    >
  >(request.source, {
    Output: () => Effect.succeed({ metadata: ArtifactSource.cases.Output.make({}), bytes: null }),
    Separate: ({ path }) =>
      Effect.gen(function* () {
        const bytes = yield* capture(personId, path, 'source')
        return {
          metadata: ArtifactSource.cases.Separate.make({ file: capturedFile(path, bytes) }),
          bytes,
        }
      }),
  })
  const rendered = yield* render(personId, output, extension)
  const preview = rendered.preview
  const previewMetadata =
    preview === null
      ? ArtifactPreview.cases.Output.make({})
      : ArtifactPreview.cases.Separate.make({ file: capturedFile('preview.png', preview) })
  const metadata = FileCapture.make({
    output: capturedFile(request.path, output),
    source: source.metadata,
    preview: previewMetadata,
  })
  const fileCapture =
    'workbook' in rendered
      ? FileCapture.make({ ...metadata, workbook: rendered.workbook })
      : metadata
  return {
    capture: fileCapture,
    output,
    source: source.bytes,
    preview,
  } satisfies CapturedArtifact
})
