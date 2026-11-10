import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodeCrypto from 'node:crypto'
import { ArtifactInspectionId, ArtifactWorkbookInspection } from '@vivid/contracts'
import { Schema } from 'effect'
import { Account, decodeText } from './receipts.mjs'
import { chat, history, settled, rpc, json } from './wire.mjs'
import { capture, computerFile } from './computers.mjs'

const Receipt = Schema.Struct({
  inspection: ArtifactInspectionId,
  workbook: ArtifactWorkbookInspection,
})

/** Fixed cells give an independent expected result; saved base64 proves exact Computer bytes. */
function prompt(id, revision) {
  const path = `/tmp/verify-${id}.xlsx`
  const action =
    revision === 1
      ? 'Create an XLSX workbook with sheets Budget and Notes. Budget A1=Item, B1=Amount, A2=Hosting, B2=12, B3 is the formula =SUM(B2:B2). Notes A1=Verification. Set its title to Workbook verification.'
      : `Edit the existing ${path}, changing Budget B2 to 19, keeping its other cells and sheets.`
  return `${action} Use the Computer's /opt/vivid/python/bin/python3 with openpyxl. Save to ${path}. Save base64 of the exact XLSX bytes to ${path}.v${revision}.b64 using Python base64.b64encode. Call inspect_file with path ${path} and source kind output. Check its image and sheet/cell coverage. Then publish_file titled Workbook verification. Include the inspected sheets, cell values, formula and inspection limits in your review. Do not use write_document. Do not stop until published.`
}

/** Cookie downloads must match both retained metadata and the workbook on the disposable Computer. */
async function downloads(state, detail, original, directory) {
  const { artifact, shown, content } = detail
  NodeAssert.equal(content._tag, 'File')
  NodeAssert.equal(content.source._tag, 'Output')
  NodeAssert.equal(content.preview._tag, 'Separate')
  NodeAssert.equal(
    content.output.mimeType,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const account = decodeText(
    Account,
    await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'),
  )
  for (const [role, metadata] of [
    ['output', content.output],
    ['source', content.output],
    ['preview', content.preview.file],
  ]) {
    const response = await fetch(
      `${state.web}/api/artifacts/${artifact.id}/versions/${shown.number}/files/${role}`,
      { headers: { cookie: account.cookie } },
    )
    NodeAssert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    NodeAssert.equal(NodeCrypto.createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
    NodeAssert.equal(bytes.length, metadata.byteLength)
    NodeAssert.equal(response.headers.get('content-type'), metadata.mimeType)
    if (role !== 'preview') NodeAssert.deepEqual(bytes, original)
    else NodeAssert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    await NodeFSP.writeFile(`${directory}/v${shown.number}-${role}`, bytes)
  }
}

/** The public tool history must show the inspected cells and image before the matching publication. */
async function published(state, id, revision, directory) {
  const detail = await settled(state, id, revision, 'Completed', directory)
  const page = await history(state, id, directory, `v${revision}-history`)
  const run = detail.runs[revision - 1]
  const steps = page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === run.submissionId)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.state === 'output-available')
  const publication = steps.find(
    (part) => part.toolName === 'publish_file' && part.output.kind === 'artifact',
  )
  NodeAssert.ok(publication, 'No successful file publication')
  const inspection = steps.find(
    (part) =>
      part.toolName === 'inspect_file' &&
      Array.isArray(part.output) &&
      part.output.some((block) => block.type === 'image'),
  )
  NodeAssert.ok(inspection, 'No native inspection image')
  NodeAssert.ok(steps.indexOf(inspection) < steps.indexOf(publication))
  const text = inspection.output.find((block) => block.type === 'text')
  NodeAssert.ok(text)
  const receipt = decodeText(Receipt, text.text)
  NodeAssert.equal(receipt.inspection, publication.input.inspection)
  NodeAssert.deepEqual(receipt.workbook.omittedSheets, [])
  NodeAssert.deepEqual(
    receipt.workbook.sheets.map((sheet) => sheet.name),
    ['Budget', 'Notes'],
  )
  const [budget, notes] = receipt.workbook.sheets
  NodeAssert.equal(budget.inspectedRange, 'A1:E5')
  NodeAssert.equal(
    budget.cells.find((cell) => cell.address === 'B2').value,
    revision === 1 ? '12' : '19',
  )
  NodeAssert.equal(budget.cells.find((cell) => cell.address === 'B3').formula, '=SUM(B2:B2)')
  NodeAssert.equal(notes.cells.find((cell) => cell.address === 'A1').value, 'Verification')
  const reference = publication.output.artifact
  const artifact = await rpc(state, 'GetArtifact', reference, directory, `v${revision}-artifact`)
  NodeAssert.deepEqual(artifact.content.workbook, receipt.workbook)
  NodeAssert.equal(artifact.content.review.toolCallId, inspection.toolCallId)
  NodeAssert.equal(artifact.content.review.outputDigest, artifact.content.output.sha256)
  return artifact
}

/** A real model creates and revises one workbook; the existing viewer opens its retained PNG and history. */
export async function files(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'File publication requires a real model')
  NodeAssert.equal(state.computer, 'disposable', 'File publication requires a disposable Computer')
  const versions = []
  const originals = []
  for (const revision of [1, 2]) {
    const phrase = prompt(id, revision)
    if (browser) {
      await browser.run(['find', 'label', 'Message Vivid', 'fill', phrase])
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    } else await chat(state, id, phrase, directory, `v${revision}-chat`)
    const detail = await published(state, id, revision, directory)
    await capture(state)
    const original = await computerFile(state, `/tmp/verify-${id}.xlsx.v${revision}.b64`)
    const bytes = Buffer.from(original.text, 'base64')
    await downloads(state, detail, bytes, directory)
    versions.push(detail)
    originals.push(bytes)
    if (browser) {
      await browser.run([
        'find',
        'nth',
        String(revision - 1),
        'button[aria-label="Open Workbook verification"]',
        'click',
      ])
      await browser.run(['wait', 'img[alt="First page of Workbook verification"]'])
      await browser.run([
        'wait',
        '--fn',
        'Array.from(document.images).some(image => image.alt === "First page of Workbook verification" && image.complete && image.naturalWidth > 0)',
      ])
      await browser.capture(`v${revision}-viewer`)
      await browser.run(['press', 'Escape'])
    }
  }
  NodeAssert.equal(versions[0].artifact.id, versions[1].artifact.id)
  NodeAssert.ok(versions[1].shown.number > versions[0].shown.number)
  NodeAssert.notDeepEqual(originals[0], originals[1])
  const old = await rpc(
    state,
    'GetArtifact',
    { id: versions[0].artifact.id, version: versions[0].shown.number },
    directory,
    'old-version',
  )
  await downloads(state, old, originals[0], directory)
  await json(directory + '/proof.json', {
    versions: versions.map((version) => ({
      id: version.artifact.id,
      version: version.shown.number,
      sha256: version.content.output.sha256,
    })),
    exactComputerBytes: true,
    oldVersionUnchanged: true,
    coverage: 'A1:E5 on Budget and Notes; first exported PDF page; no recalculation claim',
  })
  if (browser) {
    await browser.run(['reload'])
    await browser.run(['wait', '--text', 'Workbook verification'])
    await browser.capture('reloaded')
  }
}
