import fs from 'node:fs'
import path from 'node:path'
import {
  DMMF,
  GeneratorOptions,
  generatorHandler,
} from '@prisma/generator-helper'
import { logger } from '@prisma/internals'
import { GENERATOR_NAME } from './constants'

const { version } = require('../package.json')

interface Edit {
  start: number
  end: number
  replacement: string
}

function findBlockEnd(content: string, openBraceIndex: number): number {
  let braceCount = 1
  for (let i = openBraceIndex + 1; i < content.length; i++) {
    if (content[i] === '{') braceCount++
    else if (content[i] === '}') {
      braceCount--
      if (braceCount === 0) return i
    }
  }
  return content.length
}

/**
 * Apply non-overlapping edits in a single pass. Edits are sorted by start; any
 * edit overlapping an earlier one is dropped (first-wins).
 */
function applyEdits(content: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start)

  const chunks: string[] = []
  let pos = 0
  for (const edit of edits) {
    if (edit.start < pos) continue
    if (edit.start > pos) chunks.push(content.slice(pos, edit.start))
    chunks.push(edit.replacement)
    pos = edit.end
  }
  if (pos < content.length) chunks.push(content.slice(pos))
  return chunks.join('')
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace every key of `patterns` in `content` with its mapped value, choosing
 * the longest match at each position.
 */
function replaceWithMap(
  content: string,
  patterns: Map<string, string>,
): string {
  if (patterns.size === 0) return content
  const keys = [...patterns.keys()].sort((a, b) => b.length - a.length)
  const regex = new RegExp(keys.map(escapeRegex).join('|'), 'g')
  return content.replace(regex, (match) => patterns.get(match) ?? match)
}

type ModelWithId = {
  modelName: string
  idField: DMMF.Field
  model: DMMF.Model
}

function collectModelsWithId(dmmf: GeneratorOptions['dmmf']): {
  modelIdTypes: Map<string, string>
  modelsWithId: ModelWithId[]
} {
  const modelIdTypes = new Map<string, string>()
  const modelsWithId: ModelWithId[] = []
  for (const model of dmmf.datamodel.models) {
    const idField = model.fields.find(({ name, isId }) => name === 'id' && isId)
    if (idField) {
      modelIdTypes.set(model.name, `${model.name}Id`)
      modelsWithId.push({ modelName: model.name, idField, model })
    }
  }
  return { modelIdTypes, modelsWithId }
}

/**
 * Yield every `(fk, relatedIdType)` pair this model owns via
 * `@relation(fields: [...])`.
 */
function* relationFkPairs(
  model: DMMF.Model,
  modelIdTypes: Map<string, string>,
): Generator<{ fk: string; relatedIdType: string }> {
  for (const field of model.fields) {
    if (field.kind !== 'object' || !field.relationFromFields) continue
    const relatedIdType = modelIdTypes.get(field.type)
    if (!relatedIdType) continue
    for (const fk of field.relationFromFields) {
      yield { fk, relatedIdType }
    }
  }
}

function buildIdTypeHeader(strictFlavours: boolean): string {
  const brand = strictFlavours ? '_type: FlavorT' : '_type?: FlavorT'
  return `
    export interface Flavoring<FlavorT> {
      ${brand}
    }
    export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>
    `
}

/**
 * One map covering both the global naming-convention replacements
 * (`<modelLowercase>Id: string` -> `<Model>Id`) and per-model
 * `export type Foo = ` -> `<typeDef>export type Foo = ` insertions. The
 * insertion entry includes the matched marker in its value so a single
 * regex replace handles both kinds.
 */
function buildReplacementMap(
  modelsWithId: ModelWithId[],
  modelIdTypes: Map<string, string>,
): Map<string, string> {
  const patterns = new Map<string, string>()

  for (const { modelName, model } of modelsWithId) {
    const idTypeName = modelIdTypes.get(modelName)
    if (!idTypeName) continue

    // Per-model insertion of the `<Model>Id` alias before its `export type Foo = ` line.
    const marker = `export type ${modelName} = `
    const typeDef = `\nexport type ${idTypeName} = Flavor<string, '__${modelName}Id'>\n`
    patterns.set(marker, typeDef + marker)

    // <modelLowercase>Id: string -> <modelLowercase>Id: <Model>Id (and variants)
    const stronglyTyped =
      idTypeName.charAt(0).toLowerCase() + idTypeName.slice(1)
    patterns.set(`${stronglyTyped}: string`, `${stronglyTyped}: ${idTypeName}`)
    patterns.set(
      `${stronglyTyped}?: string`,
      `${stronglyTyped}?: ${idTypeName}`,
    )

    // Explicit @relation FK fields.
    for (const { fk, relatedIdType } of relationFkPairs(model, modelIdTypes)) {
      patterns.set(`${fk}: string | null`, `${fk}: ${relatedIdType} | null`)
      patterns.set(`${fk}?: string | null`, `${fk}?: ${relatedIdType} | null`)
      patterns.set(`${fk}: string`, `${fk}: ${relatedIdType}`)
      patterns.set(`${fk}?: string`, `${fk}?: ${relatedIdType}`)
    }
  }

  return patterns
}

/**
 * Push edits replacing `${prefix}${idField}: string` / `${prefix}${idField}?: string`
 * within `[blockStart, blockEnd)` of `content`.
 */
function pushIdFieldEdits(
  edits: Edit[],
  content: string,
  blockStart: number,
  blockEnd: number,
  idFieldName: string,
  idTypeName: string,
  prefix = '',
): void {
  for (const optional of [false, true]) {
    const search = `${prefix}${idFieldName}${optional ? '?' : ''}: string`
    const replacement = `${prefix}${idFieldName}${optional ? '?' : ''}: ${idTypeName}`
    let idx = blockStart
    while ((idx = content.indexOf(search, idx)) !== -1 && idx < blockEnd) {
      edits.push({ start: idx, end: idx + search.length, replacement })
      idx += search.length
    }
  }
}

const NON_ID_TYPES =
  /^(Date|DateTime|Int|Float|Decimal|BigInt|Boolean|Bytes)\s*$/

/**
 * Block-scoped edits for one model's structures (`$<Model>Payload`,
 * `<Model>(Unchecked)?(Create|Update)(ManyMutation|ManyUnchecked)?Input`,
 * `<Model>WhereInput`, `<Model>WhereUniqueInput`) within `content`.
 */
function buildModelBlockEdits(
  content: string,
  modelInfo: ModelWithId,
  modelIdTypes: Map<string, string>,
): Edit[] {
  const { modelName, idField, model } = modelInfo
  const idTypeName = `${modelName}Id`
  const stronglyTyped = idTypeName.charAt(0).toLowerCase() + idTypeName.slice(1)
  const edits: Edit[] = []

  const findBlockBounds = (
    markerIdx: number,
  ): { start: number; end: number } => {
    const start = content.indexOf('{', markerIdx) + 1
    return { start, end: findBlockEnd(content, start - 1) }
  }

  // $Payload scalars block
  const payloadIdx = content.indexOf(`type $${modelName}Payload<`)
  if (payloadIdx !== -1) {
    const scalarsIdx = content.indexOf('scalars:', payloadIdx)
    if (scalarsIdx !== -1) {
      const { start, end } = findBlockBounds(scalarsIdx)
      pushIdFieldEdits(
        edits,
        content,
        start,
        end,
        idField.name,
        idTypeName,
        '  ',
      )
    }
  }

  // Input types
  const inputTypes = [
    `${modelName}CreateInput`,
    `${modelName}UncheckedCreateInput`,
    `${modelName}UpdateInput`,
    `${modelName}UncheckedUpdateInput`,
    `${modelName}UpdateManyMutationInput`,
    `${modelName}UncheckedUpdateManyInput`,
  ]
  for (const inputType of inputTypes) {
    const idx = content.indexOf(`export type ${inputType} = {`)
    if (idx === -1) continue
    const { start, end } = findBlockBounds(idx)
    pushIdFieldEdits(edits, content, start, end, idField.name, idTypeName)
  }

  // WithoutInput types — discovered by regex since the suffix varies per relation.
  const withoutRegex = new RegExp(
    `export type ${modelName}(?:Unchecked)?(?:Create|Update)Without\\w+Input = \\{`,
    'g',
  )
  let match: RegExpExecArray | null
  while ((match = withoutRegex.exec(content)) !== null) {
    const { start, end } = findBlockBounds(match.index)
    pushIdFieldEdits(edits, content, start, end, idField.name, idTypeName)
  }

  // WhereInput — id field appears in a StringFilter union, not a plain string.
  const whereInputIdx = content.indexOf(
    `export type ${modelName}WhereInput = {`,
  )
  if (whereInputIdx !== -1) {
    const { start, end } = findBlockBounds(whereInputIdx)
    for (const optional of [false, true]) {
      const search = `${idField.name}${optional ? '?' : ''}: StringFilter<"${modelName}"> | string`
      const replacement = `${idField.name}${optional ? '?' : ''}: StringFilter<"${modelName}"> | ${idTypeName}`
      const idx = content.indexOf(search, start)
      if (idx !== -1 && idx < end) {
        edits.push({ start: idx, end: idx + search.length, replacement })
      }
    }
  }

  // WhereUniqueInput uses the indented form because the block also contains
  // `<otherUnique>?: string` lines we mustn't touch.
  const whereUniqueIdx = content.indexOf(
    `export type ${modelName}WhereUniqueInput = Prisma.AtLeast<{`,
  )
  if (whereUniqueIdx !== -1) {
    const { start, end } = findBlockBounds(whereUniqueIdx)
    pushIdFieldEdits(edits, content, start, end, idField.name, idTypeName, '  ')
  }

  // replaceType patterns: `<field>?: SomeType | string` for the model's own id
  // (`stronglyTyped`) and every explicit FK it owns.
  const pushReplaceTypeEdits = (
    fieldName: string,
    targetType: string,
  ): void => {
    const re = new RegExp(
      `\\b${escapeRegex(fieldName)}\\s*\\?:\\s*([^|]+)\\s*\\|\\s*string`,
      'g',
    )
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      if (NON_ID_TYPES.test(m[1].trim())) continue
      edits.push({
        start: m.index,
        end: m.index + m[0].length,
        replacement: `${fieldName}?: ${m[1]} | ${targetType}`,
      })
    }
  }

  pushReplaceTypeEdits(stronglyTyped, idTypeName)
  for (const { fk, relatedIdType } of relationFkPairs(model, modelIdTypes)) {
    pushReplaceTypeEdits(fk, relatedIdType)
  }

  return edits
}

/**
 * Single-file output (Prisma 6 `prisma-client-js`): one `.ts` file holds
 * everything.
 */
function processSingleFile(args: {
  output: string
  idTypeHeader: string
  patterns: Map<string, string>
  modelsWithId: ModelWithId[]
  modelIdTypes: Map<string, string>
}): void {
  const fileContent = fs.readFileSync(args.output, 'utf8')
  let result = replaceWithMap(args.idTypeHeader + fileContent, args.patterns)

  const edits: Edit[] = []
  for (const modelInfo of args.modelsWithId) {
    edits.push(...buildModelBlockEdits(result, modelInfo, args.modelIdTypes))
  }
  if (edits.length > 0) result = applyEdits(result, edits)

  fs.writeFileSync(args.output, result)
}

const PRISMA_NAMESPACE_IMPORT =
  'import type * as Prisma from "../internal/prismaNamespace.js"'
const TS_NOCHECK_MARKER = '// @ts-nocheck'

function injectClientImport(content: string, idsToImport: Set<string>): string {
  if (idsToImport.size === 0) return content
  const importLine = `import type { ${[...idsToImport].sort().join(', ')} } from '../client.js'`

  for (const marker of [PRISMA_NAMESPACE_IMPORT, TS_NOCHECK_MARKER]) {
    const idx = content.indexOf(marker)
    if (idx === -1) continue
    const lineEnd = content.indexOf('\n', idx)
    return `${content.slice(0, lineEnd + 1)}${importLine}\n${content.slice(lineEnd + 1)}`
  }
  return `${importLine}\n${content}`
}

function collectUsedIdTypes(
  content: string,
  modelIdTypes: Map<string, string>,
): Set<string> {
  const used = new Set<string>()
  for (const idType of modelIdTypes.values()) {
    if (new RegExp(`\\b${escapeRegex(idType)}\\b`).test(content)) {
      used.add(idType)
    }
  }
  return used
}

/**
 * Multi-file output (Prisma 7 `prisma-client`): the `<Model>Id` aliases live
 * in `client.ts` (via insertions, which only match there); each model file
 * receives global replacements + its own block-scoped edits + an import line.
 */
function processMultiFile(args: {
  clientFile: string
  modelsDir: string
  idTypeHeader: string
  patterns: Map<string, string>
  modelsWithId: ModelWithId[]
  modelIdTypes: Map<string, string>
}): void {
  if (fs.existsSync(args.clientFile)) {
    const original = fs.readFileSync(args.clientFile, 'utf8')
    const patched = replaceWithMap(args.idTypeHeader + original, args.patterns)
    fs.writeFileSync(args.clientFile, patched)
  }

  if (!fs.existsSync(args.modelsDir)) return

  const modelInfoByName = new Map(
    args.modelsWithId.map((m) => [m.modelName, m]),
  )

  for (const file of fs.readdirSync(args.modelsDir)) {
    if (!file.endsWith('.ts')) continue
    const filePath = path.join(args.modelsDir, file)
    let content = fs.readFileSync(filePath, 'utf8')

    content = replaceWithMap(content, args.patterns)

    const modelInfo = modelInfoByName.get(path.basename(file, '.ts'))
    if (modelInfo) {
      const edits = buildModelBlockEdits(content, modelInfo, args.modelIdTypes)
      if (edits.length > 0) content = applyEdits(content, edits)
    }

    content = injectClientImport(
      content,
      collectUsedIdTypes(content, args.modelIdTypes),
    )
    fs.writeFileSync(filePath, content)
  }
}

/**
 * Two output layouts supported:
 *
 *   - **single-file** (Prisma 6 `prisma-client-js`): `output` points at one
 *     `.ts` file, no sibling `models/` directory.
 *   - **multi-file** (Prisma 7 `prisma-client`): `output` is the generated
 *     directory or `<dir>/client.ts`, with a sibling `<dir>/models/`.
 */
function resolveOutputLayout(
  output: string,
):
  | { mode: 'single-file'; output: string }
  | { mode: 'multi-file'; clientFile: string; modelsDir: string } {
  const isDir = fs.statSync(output).isDirectory()
  const baseDir = isDir ? output : path.dirname(output)
  const modelsDir = path.join(baseDir, 'models')

  if (isDir || fs.existsSync(modelsDir)) {
    return {
      mode: 'multi-file',
      clientFile: isDir ? path.join(baseDir, 'client.ts') : output,
      modelsDir,
    }
  }
  return { mode: 'single-file', output }
}

generatorHandler({
  onManifest() {
    logger.info(`${GENERATOR_NAME}:Registered`)
    return {
      version,
      defaultOutput: '../generated',
      prettyName: GENERATOR_NAME,
    }
  },
  onGenerate: async (options: GeneratorOptions) => {
    const output = options.generator.output?.value
    if (!output) return

    const strictFlavours = options.generator.config.strictFlavours === 'true'
    const { modelIdTypes, modelsWithId } = collectModelsWithId(options.dmmf)
    const patterns = buildReplacementMap(modelsWithId, modelIdTypes)
    const idTypeHeader = buildIdTypeHeader(strictFlavours)
    const shared = { idTypeHeader, patterns, modelsWithId, modelIdTypes }

    const layout = resolveOutputLayout(output)
    if (layout.mode === 'single-file') {
      processSingleFile({ output: layout.output, ...shared })
    } else {
      processMultiFile({
        clientFile: layout.clientFile,
        modelsDir: layout.modelsDir,
        ...shared,
      })
    }
  },
})
